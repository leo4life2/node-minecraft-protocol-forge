/* eslint-env mocha */
// Byte-level table test for the WRAPPED_LOGIN_PROTOCOLS mod login
// sub-protocols in the FML3 handshake responder. Drives the installed
// login_plugin_request handler through a stub client and asserts the exact
// login_plugin_response bytes, so any change to an existing entry (tacz,
// zeta, framework) or to the FML ack-99 fall-through is a test failure.
const assert = require('assert')
const { EventEmitter } = require('events')

// Required by path on purpose: the module under test must be THIS checkout,
// not whatever the package name resolves to through parent node_modules.
const forgeHandshake3 = require('../src/client/forgeHandshake3')
const { writeVarInt, writeString } = forgeHandshake3

// fml:loginwrapper framing (same as the server's LoginWrapper): inner
// channel string + varint-length-prefixed payload.
function wrap (channel, payload) {
  return Buffer.concat([writeString(channel), writeVarInt(payload.length), payload])
}

// Minimal stand-in for a connecting nmp client: an EventEmitter that
// captures everything written back to the server.
function makeClient () {
  const client = new EventEmitter()
  client.written = []
  client.write = (name, params) => client.written.push({ name, params })
  return client
}

// HF12: wrapped-mod-channel replies are deferred one event-loop turn by the
// reply boundary law (loginReplyBoundary.js) — drain before asserting.
const drainDeferredReplies = () => new Promise((resolve) => setImmediate(() => setImmediate(() => setImmediate(resolve))))

// Delivers one wrapped mod login message (inner channel + discriminator +
// body) and returns the raw login_plugin_response payload.
async function loginReply (channel, disc, body = Buffer.alloc(0)) {
  const client = makeClient()
  forgeHandshake3(client, {})
  client.emit('login_plugin_request', {
    messageId: 42,
    channel: 'fml:loginwrapper',
    data: wrap(channel, Buffer.concat([writeVarInt(disc), body]))
  })
  await drainDeferredReplies()
  assert.strictEqual(client.written.length, 1, 'exactly one reply per request')
  const { name, params } = client.written[0]
  assert.strictEqual(name, 'login_plugin_response')
  assert.strictEqual(params.messageId, 42, 'reply mirrors the request messageId')
  return params.data
}

describe('WRAPPED_LOGIN_PROTOCOLS', function () {
  it('framework:handshake: replies Acknowledge = index 1, empty body, to every S2C login message', async () => {
    // ForgeNetworkBuilder#build resets idCount to 1 and registers Acknowledge
    // first (S2CLoginData=2, S2CLoginConfigData=3), so the reply is always the
    // single byte 0x01 on the same inner channel.
    for (const disc of [2, 3]) {
      assert.deepStrictEqual(
        await loginReply('framework:handshake', disc, Buffer.from([0xaa, 0xbb, 0xcc])),
        wrap('framework:handshake', Buffer.from([0x01]))
      )
    }
  })

  it('tacz:handshake: unchanged — single 0x01 ack byte regardless of message', async () => {
    assert.deepStrictEqual(
      await loginReply('tacz:handshake', 2, Buffer.from([1, 2, 3])),
      wrap('tacz:handshake', Buffer.from([0x01]))
    )
  })

  it('zeta:main: unchanged — S2CLoginFlag(98) body echoed back as C2SLoginFlag(99)', async () => {
    const body = Buffer.from([9, 8, 7, 6, 5])
    assert.deepStrictEqual(
      await loginReply('zeta:main', 98, body),
      wrap('zeta:main', Buffer.concat([writeVarInt(99), body]))
    )
    // any other zeta message falls through to the FML ack
    assert.deepStrictEqual(
      await loginReply('zeta:main', 1, body),
      wrap('zeta:main', writeVarInt(99))
    )
  })

  it('unknown wrapped channels: unchanged — FML C2SAcknowledge (99) fall-through', async () => {
    assert.deepStrictEqual(
      await loginReply('somemod:handshake', 3, Buffer.from([1])),
      wrap('somemod:handshake', writeVarInt(99))
    )
  })
})

// HF13 — the corroboration gate between the jars' 'unknown' verdict and the
// FML-99 floor (live receipt 2026-08-31: a half-matching local instance sent
// ack-99 on tacztweaks:handshake, a channel the server itself had announced;
// the server found no message at index 99, logged "Unexpected custom data
// from client" and kicked with unexpected_query_response, 6/6 deterministic).
describe('HF13 announced-reality corroboration', function () {
  async function replyWithAnnouncement (channel, stampAnnouncement) {
    const client = makeClient()
    stampAnnouncement(client)
    forgeHandshake3(client, {})
    client.emit('login_plugin_request', {
      messageId: 42,
      channel: 'fml:loginwrapper',
      data: wrap(channel, Buffer.concat([writeVarInt(0), Buffer.from([1])]))
    })
    await drainDeferredReplies()
    assert.strictEqual(client.written.length, 1, 'exactly one reply per request')
    const { name, params } = client.written[0]
    assert.strictEqual(name, 'login_plugin_response')
    assert.strictEqual(params.messageId, 42)
    return { client, data: params.data }
  }

  it('a server-announced channel with no local jar gets the vanilla not-understood DECLINE, not ack-99, with a receipt naming the announced owner', async () => {
    const { client, data } = await replyWithAnnouncement('tweaksmod:handshake', (c) => {
      c.forgeModList = {
        mods: ['tweaksmod'],
        channels: [{ name: 'tweaksmod:handshake', marker: '2.14.2' }],
        registries: []
      }
      c.forgePingMods = [{ id: 'tweaksmod', version: '2.14.2' }]
    })
    assert.strictEqual(data, undefined, 'messageId with NO data = successful=false, the reference client\'s decline')
    assert.strictEqual(client.forgeDeclinedLoginChannels.length, 1)
    const receipt = client.forgeDeclinedLoginChannels[0]
    assert.strictEqual(receipt.reason, 'uncorroborated-by-local-jars')
    assert.strictEqual(receipt.ownerMod, 'tweaksmod')
    assert.strictEqual(receipt.ownerVersion, '2.14.2')
  })

  it('announcement via ping mod list alone (no ModList yet) also corroborates', async () => {
    const client = makeClient()
    client.forgePingMods = [{ id: 'earlymod', version: '1.0' }]
    forgeHandshake3(client, {})
    client.emit('login_plugin_request', {
      messageId: 7,
      channel: 'fml:loginwrapper',
      data: wrap('earlymod:gate', Buffer.concat([writeVarInt(0), Buffer.from([1])]))
    })
    await drainDeferredReplies()
    assert.strictEqual(client.written[0].params.data, undefined, 'declined on ping evidence alone')
  })

  it('infra namespaces (fml/forge/minecraft) never convert — announced or not', async () => {
    const { data } = await replyWithAnnouncement('forge:gate', (c) => {
      c.forgeModList = { mods: ['forge'], channels: [{ name: 'forge:gate', marker: '1' }], registries: [] }
    })
    assert.deepStrictEqual(data, wrap('forge:gate', writeVarInt(99)), 'loader-infra lanes keep the legacy floor')
  })

  it('unannounced channels keep the FML-99 floor byte-for-byte (the frozen legacy default)', async () => {
    const { data } = await replyWithAnnouncement('nobodyknows:gate', () => {})
    assert.deepStrictEqual(data, wrap('nobodyknows:gate', writeVarInt(99)))
  })
})

// FML2 responder (forgeHandshake2) — the same default case, guarded shapes.
describe('FML2 responder default case', function () {
  const forgeHandshake2 = require('../src/client/forgeHandshake2')

  // FML2 install removes nmp's own onLoginPluginRequest listener and calls
  // client.registerChannel, so the stub needs both present.
  function makeFml2Client () {
    const client = makeClient()
    client.registerChannel = () => {}
    client.on('login_plugin_request', function onLoginPluginRequest () {})
    return client
  }

  it('empty wrapped payload: length-guarded FML convention ack, never a readVarInt throw (L2 pin)', async () => {
    // An empty inner payload has no discriminator to read. The guard must
    // answer it as its own honest shape (convention ack on the originating
    // channel) instead of reaching readVarInt and replying from a catch.
    const client = makeFml2Client()
    forgeHandshake2(client, {})
    client.emit('login_plugin_request', {
      messageId: 7,
      channel: 'fml:loginwrapper',
      data: wrap('somemod:channel', Buffer.alloc(0))
    })
    await drainDeferredReplies() // HF12
    assert.strictEqual(client.written.length, 1, 'exactly one reply')
    const { name, params } = client.written[0]
    assert.strictEqual(name, 'login_plugin_response')
    assert.strictEqual(params.messageId, 7)
    assert.deepStrictEqual(params.data, wrap('somemod:channel', writeVarInt(99)))
  })
})

// HF23 — the announced-mod acquisition rung (design §4p): an 'unknown +
// announced' channel with a REAL announced version defers its answer behind
// an embedder-injected accessor; the SAME derivation runs over the obtained
// jar and the SAME three dispatch shapes ride the wire. Scripted accessors
// only — this lib never does network I/O.
describe('HF23 announced-mod acquisition rung', function () {
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const { buildClass, buildJar } = require('./helpers/synthJar')
  const RL = 'net/minecraft/resources/ResourceLocation'
  const SC = 'net/minecraftforge/network/simple/SimpleChannel'
  const MB = 'net/minecraftforge/network/simple/SimpleChannel$MessageBuilder'
  const AI = 'java/util/concurrent/atomic/AtomicInteger'
  const NR = 'net/minecraftforge/network/NetworkRegistry'
  const FBB = 'net/minecraft/network/FriendlyByteBuf'
  // the tacz shape: counter-seeded channel, empty-encoder Acknowledge first → index 1
  function derivableJarDir (ns) {
    const owner = `synth/${ns}/Net`
    const ack = `synth/${ns}/Ack`
    const reg = (a, cls) => a
      .getstatic(owner, 'CHANNEL', `L${SC};`).ldcCls(cls).getstatic(owner, 'COUNT', `L${AI};`)
      .invokevirtual(AI, 'getAndIncrement', '()I').invokevirtual(SC, 'messageBuilder', `(Ljava/lang/Class;I)L${MB};`)
      .invokevirtual(MB, 'loginIndex', `(Ljava/util/function/Function;Ljava/util/function/BiConsumer;)L${MB};`).invokevirtual(MB, 'add', '()V')
    const net = buildClass({
      name: owner,
      methods: [
        { name: '<clinit>', desc: '()V', flags: 0x0008, code: (a) => a.new_(RL).dup().ldcStr(ns).ldcStr('handshake').invokespecial(RL, '<init>', '(Ljava/lang/String;Ljava/lang/String;)V').invokestatic(NR, 'newSimpleChannel', `(L${RL};)L${SC};`).putstatic(owner, 'CHANNEL', `L${SC};`).new_(AI).dup().iconst(1).invokespecial(AI, '<init>', '(I)V').putstatic(owner, 'COUNT', `L${AI};`).ret() },
        { name: 'init', desc: '()V', code: (a) => reg(a, ack).ret() }
      ]
    })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hf23-${ns}-`))
    fs.writeFileSync(path.join(dir, `${ns}.jar`), buildJar([
      { name: `${owner}.class`, data: net },
      { name: `${ack}.class`, data: buildClass({ name: ack, methods: [{ name: 'encode', desc: `(L${ack};L${FBB};)V`, code: (a) => a.ret() }] }) }
    ]))
    return dir
  }
  function stub () {
    const client = makeClient()
    client.state = 'login'
    client.version = '1.20.1'
    client.endedReasons = []
    client.end = (reason) => { client.endedReasons.push(reason); client.ended = true }
    return client
  }
  function announce (client, id, version) {
    client.forgeModList = { mods: [id], channels: [{ name: `${id}:handshake`, marker: version }], registries: [] }
    client.forgePingMods = [{ id, version }]
  }
  function query (client, channel) {
    client.emit('login_plugin_request', { messageId: 42, channel: 'fml:loginwrapper', data: wrap(channel, Buffer.concat([writeVarInt(0), Buffer.from([1])])) })
  }
  const until = async (pred) => { const d = Date.now() + 3000; while (!pred()) { if (Date.now() > d) throw new Error('timeout'); await new Promise((resolve) => setTimeout(resolve, 5)) } }

  it('fail-open: with the accessor injected, unannounced channels keep the FML-99 floor byte-for-byte and an ANY-version owner keeps the HF13 decline; the accessor is never called', async () => {
    let calls = 0
    const acq = { acquire: async () => { calls++; return { ok: false, outcome: 'registry-miss' } } }
    const a = stub()
    forgeHandshake3(a, { announcedModAcquisition: acq })
    query(a, 'nobodyknows:gate')
    await drainDeferredReplies()
    assert.deepStrictEqual(a.written[0].params.data, wrap('nobodyknows:gate', writeVarInt(99)))
    const b = stub()
    announce(b, 'anymod', 'ANY')
    forgeHandshake3(b, { announcedModAcquisition: acq })
    query(b, 'anymod:handshake')
    await drainDeferredReplies()
    assert.strictEqual(b.written.length, 1)
    assert.strictEqual(b.written[0].params.data, undefined, 'the HF13 decline, synchronously')
    assert.strictEqual(calls, 0)
    assert.strictEqual(forgeHandshake3.isAcquirableVersion('SERVER_ONLY'), false)
  })

  it('acquired → the SAME derivation over the obtained jar answers the mod\'s own ack (index 1) as a deferred "wrapped reply (acquired)"', async () => {
    const dir = derivableJarDir('acqmod')
    const client = stub()
    announce(client, 'acqmod', '1.1.8-hotfix')
    const seen = []
    forgeHandshake3(client, { announcedModAcquisition: { budgetMs: 1000, acquire: async (req) => { seen.push(req); await new Promise((resolve) => setTimeout(resolve, 20)); return { ok: true, outcome: 'downloaded-verified', jarPaths: [path.join(dir, 'acqmod.jar')], receipt: { registry: 'modrinth' } } } } })
    query(client, 'acqmod:handshake')
    await drainDeferredReplies()
    assert.strictEqual(client.written.length, 0, 'nothing written while the acquisition is in flight')
    await until(() => client.written.length === 1)
    assert.deepStrictEqual(client.written[0].params.data, wrap('acqmod:handshake', Buffer.from([0x01])))
    assert.deepStrictEqual(seen.map((r) => [r.modId, r.version, r.channel, r.loader, r.mcVersion]), [['acqmod', '1.1.8-hotfix', 'acqmod:handshake', 'forge', '1.20.1']])
    assert.strictEqual(client.forgeLoginCorroboration[0].via, 'jar-derived-ack (acquired)')
  })

  it('miss → the HF13 decline with the acquisition outcome on the receipt (the copy names mod@version); accessor throw → decline; exactly one reply each', async () => {
    const a = stub()
    announce(a, 'missmod', '4.5.6')
    forgeHandshake3(a, { announcedModAcquisition: { acquire: async () => ({ ok: false, outcome: 'version-miss', receipt: { registry: 'modrinth' } }) } })
    query(a, 'missmod:handshake')
    await until(() => a.written.length === 1)
    assert.strictEqual(a.written[0].params.data, undefined)
    assert.strictEqual(a.forgeDeclinedLoginChannels[0].acquisition.outcome, 'version-miss')
    assert.strictEqual(a.forgeDeclinedLoginChannels[0].ownerVersion, '4.5.6')
    assert.ok(/no file for exactly that version/.test(forgeHandshake3.acquisitionOutcomeWords('version-miss')))
    const b = stub()
    announce(b, 'boom', '1.0')
    forgeHandshake3(b, { announcedModAcquisition: { acquire: async () => { throw new Error('kaboom') } } })
    query(b, 'boom:handshake')
    await until(() => b.written.length === 1)
    await drainDeferredReplies()
    assert.strictEqual(b.written.length, 1)
    assert.strictEqual(b.forgeDeclinedLoginChannels[0].acquisition.outcome, 'acquisition-error')
  })

  it('deadline law: an in-progress result ends the connection OURSELVES with the typed fact — no login_plugin_response is written', async () => {
    const client = stub()
    announce(client, 'bigmod', '9.0')
    forgeHandshake3(client, { announcedModAcquisition: { acquire: async () => ({ ok: false, outcome: 'in-progress', progress: { bytesDone: 10, bytesTotal: 100, etaMs: 5000 }, background: Promise.resolve({ ok: true }), receipt: {} }) } })
    query(client, 'bigmod:handshake')
    await until(() => client.endedReasons.length === 1)
    await drainDeferredReplies()
    assert.deepStrictEqual(client.endedReasons, ['announced mod acquisition in progress'])
    assert.strictEqual(client.written.length, 0)
    assert.strictEqual(client.minepalAnnouncedModAcquisition.verdict, 'acquisition-in-progress')
    assert.strictEqual(client.minepalAnnouncedModAcquisition.modId, 'bigmod')
    assert.ok(client.minepalAnnouncedModAcquisitionBackground.promise instanceof Promise)
  })
})
