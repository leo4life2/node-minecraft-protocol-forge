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

// HF23-R1 — the hidden-ping wire (receipt 7b63c3ed: a front/proxy strips
// forgeData from the status ping, so no announced versions exist before the
// connection). Forge's own S2CModData (fml:handshake disc 5, registered before
// S2CModList) carries modid -> version on the login wire; the responder reads
// it (never replies — the reference client stores it and sends nothing) and
// the HF13/HF23 attribution learns the announced version from it, so the
// acquisition rung fires exactly as it does on a ping that carried the list.
describe('HF23-R1 S2CModData as the announced-version source on hidden-ping wires', function () {
  const { parseModData, announcedChannelAttribution } = forgeHandshake3
  function modData (entries) {
    return Buffer.concat([writeVarInt(entries.length)].concat(entries.flatMap(([id, name, version]) => [writeString(id), writeString(name), writeString(version)])))
  }
  it('parseModData reads the FriendlyByteBuf map (modid -> displayName, version) byte-exactly', function () {
    const parsed = parseModData(modData([['tacz', 'TACZ', '1.1.8-hotfix'], ['uteamcore', 'U Team Core', '5.1.4.382']]), 0)
    assert.deepStrictEqual(parsed, { count: 2, mods: { tacz: { displayName: 'TACZ', version: '1.1.8-hotfix' }, uteamcore: { displayName: 'U Team Core', version: '5.1.4.382' } } })
    assert.throws(() => parseModData(modData([['x', 'X', '1']]).subarray(0, 4), 0), /buffer ended/)
  })
  it('disc 5 on fml:handshake is READ (client.forgeModData + forgeModData event) and still gets NO reply, matching the reference client', async function () {
    const client = makeClient()
    const events = []
    client.on('forgeModData', (d) => events.push(d))
    forgeHandshake3(client, {})
    client.emit('login_plugin_request', { messageId: 7, channel: 'fml:loginwrapper', data: wrap('fml:handshake', Buffer.concat([writeVarInt(5), modData([['tacz', 'TACZ', '1.1.8-hotfix']])])) })
    await drainDeferredReplies()
    assert.strictEqual(client.written.length, 0, 'the reference client sends nothing back for S2CModData')
    assert.deepStrictEqual(client.forgeModData.mods.tacz, { displayName: 'TACZ', version: '1.1.8-hotfix' })
    assert.strictEqual(events.length, 1)
    // a truncated body is tolerated: still no reply, nothing stamped
    const bad = makeClient()
    forgeHandshake3(bad, {})
    bad.emit('login_plugin_request', { messageId: 8, channel: 'fml:loginwrapper', data: wrap('fml:handshake', Buffer.concat([writeVarInt(5), Buffer.from([0x02, 0x01, 0x61])])) })
    await drainDeferredReplies()
    assert.strictEqual(bad.written.length, 0)
    assert.strictEqual(bad.forgeModData, undefined)
  })
  it('attribution: with NO ping versions, the announced owner version comes from S2CModData; the ping keeps precedence when both exist; ModList ids alone stay version-less', function () {
    const hidden = makeClient()
    hidden.forgeModList = { mods: ['tacz'], channels: [{ name: 'tacz:handshake', marker: '1' }], registries: [] }
    hidden.forgeModData = { count: 1, mods: { tacz: { displayName: 'TACZ', version: '1.1.8-hotfix' } } }
    assert.deepStrictEqual(announcedChannelAttribution(hidden, {}, 'tacz:handshake'), { channel: 'tacz:handshake', announcedChannel: true, ownerMod: 'tacz', ownerVersion: '1.1.8-hotfix' })
    const both = makeClient()
    both.forgeModList = hidden.forgeModList
    both.forgeModData = { count: 1, mods: { tacz: { displayName: 'TACZ', version: '9.9.9' } } }
    assert.strictEqual(announcedChannelAttribution(both, { pingModVersions: { tacz: '1.1.7' } }, 'tacz:handshake').ownerVersion, '1.1.7')
    const listOnly = makeClient()
    listOnly.forgeModList = hidden.forgeModList
    assert.strictEqual(announcedChannelAttribution(listOnly, {}, 'tacz:handshake').ownerVersion, null)
  })
  it('the ModList forgeMods event carries ModData versions when the ping had none', async function () {
    const client = makeClient()
    const seen = []
    client.on('forgeMods', (m) => seen.push(m))
    forgeHandshake3(client, {})
    client.emit('login_plugin_request', { messageId: 1, channel: 'fml:loginwrapper', data: wrap('fml:handshake', Buffer.concat([writeVarInt(5), modData([['tacz', 'TACZ', '1.1.8-hotfix']])])) })
    const modList = Buffer.concat([writeVarInt(1), writeString('tacz'), writeVarInt(0), writeVarInt(0), writeVarInt(0)])
    client.emit('login_plugin_request', { messageId: 2, channel: 'fml:loginwrapper', data: wrap('fml:handshake', Buffer.concat([writeVarInt(1), modList])) })
    await drainDeferredReplies()
    assert.deepStrictEqual(seen, [[{ modid: 'tacz', version: '1.1.8-hotfix' }]])
    assert.strictEqual(client.written.length, 1, 'exactly the ModListReply was written')
  })
})

// HF93: THE WRAPPED-LOGIN ASSESSMENT LEAVES THE MAIN LOOP. The field (f27,
// a 428-mod Forge pack): the jar walk for one wrapped channel ran
// synchronously inside the login_plugin_request handler for 32 s while the
// login-lane worker was computing the same verdict; the 18 s budget timer
// could only fire after the hold, and its stop then refused the derived
// reply as a duplicate. Pins: m1 a cache miss with a live worker verdict in
// flight walks NOTHING on the calling thread and answers when the verdict
// lands; m5 the budget stop fires at its TRUE time while a verdict is
// pending, and a reply decided before the stop is never refused by it.
describe('HF93 wrapped-login assessment off the loop', function () {
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const { Worker } = require('worker_threads')
  const lad = require('../src/client/loginAckDerivation')
  const loginWindow = require('../src/client/loginWindow')
  const { OWNER_FIXTURE, OWNER_CHANNEL } = require('./helpers/hf93Pack')
  const packDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hf93-m1-')); fs.copyFileSync(OWNER_FIXTURE, path.join(d, 'origins-all.jar')); return d }
  const query = (client, messageId = 116) => client.emit('login_plugin_request', { messageId, channel: 'fml:loginwrapper', data: wrap(OWNER_CHANNEL, Buffer.concat([writeVarInt(0), Buffer.from([0x01])])) })
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  // the product's login-lane worker shape: assess in ANOTHER thread, hand back the export entries of that one key
  const workerVerdict = (channel, paths) => new Promise((resolve, reject) => {
    const w = new Worker(`const { parentPort, workerData } = require('worker_threads'); const lad = require(${JSON.stringify(require.resolve('../src/client/loginAckDerivation'))});
      const r = lad.assessLoginChannel(workerData.channel, workerData.paths); const key = lad.loginAssessmentKeyOf(workerData.channel, workerData.paths)
      parentPort.postMessage({ verdict: r.verdict, entries: lad.exportLoginAssessments().filter((e) => e.key === key), digest: lad._internal.jarDigestStats() })`, { eval: true, workerData: { channel, paths } })
    w.once('message', (m) => { resolve(m); w.terminate() })
    w.once('error', reject)
  })
  const fml3Client = () => {
    const client = makeClient()
    client.state = 'login'
    client.endedReasons = []
    client.end = (reason) => { client.endedReasons.push(reason); client.emit('end', reason) }
    client.forgeModList = { mods: ['minecraft', 'forge', 'origins', 'calio'], channels: [{ name: OWNER_CHANNEL, marker: '1.2' }], registries: [] }
    client.forgePingMods = [{ id: 'origins', version: '1.20.1-1.10.0.9' }, { id: 'calio', version: '1.20.1-1.11.0.5' }]
    return client
  }
  const quiet = (fn) => { const o = { log: console.log, warn: console.warn, error: console.error }; console.log = () => {}; console.warn = () => {}; console.error = () => {}; return Promise.resolve().then(fn).finally(() => Object.assign(console, o)) }

  it('m1 a cache miss with the worker verdict in flight: nothing is indexed on the calling thread, the query waits on the worker, the reply is written the moment the verdict lands with the receipt naming the worker', async () => quiet(async () => {
    const dir = packDir()
    lad._internal.__clearJarDigests()
    const client = fml3Client()
    let land = null
    const inFlight = new Promise((resolve) => { land = resolve })
    client.forgeLoginAssessmentsInFlight = new Map([[OWNER_CHANNEL, inFlight]])
    forgeHandshake3(client, { modsPaths: [dir] })
    const before = lad._internal.jarDigestStats()
    const key = lad.loginAssessmentKeyOf(OWNER_CHANNEL, [dir])
    assert.strictEqual(lad.isLoginAssessmentCached(key), false, 'a cache miss (fresh key)')
    query(client)
    await drainDeferredReplies()
    assert.strictEqual(client.written.length, 0, 'nothing written while the verdict is in flight')
    const stats = lad._internal.jarDigestStats()
    assert.strictEqual(stats.built, before.built, 'no jar was digested on the calling thread')
    assert.strictEqual(stats.rawWalks, before.rawWalks, 'no raw walk on the calling thread')
    const q = loginWindow.loginWindowSummary(client).queries[0]
    assert.strictEqual(q.outcome, null, 'the query is open')
    assert.strictEqual(q.derivation.done, false)
    assert.strictEqual(q.derivation.name, `wrapped login verdict for ${OWNER_CHANNEL} from the login-lane worker`)
    // the worker's verdict lands: imported, the in-flight promise resolves, the ladder re-enters on a cache hit
    const m = await workerVerdict(OWNER_CHANNEL, [dir])
    assert.strictEqual(m.verdict, 'ack')
    assert.ok(m.digest.built >= 1, 'the WORKER digested the jar')
    assert.strictEqual(lad.importLoginAssessments(m.entries, 'login-lane worker'), 1)
    client.forgeLoginAssessmentsInFlight.delete(OWNER_CHANNEL)
    land()
    await sleep(5)
    await drainDeferredReplies()
    assert.strictEqual(client.written.length, 1, 'exactly one reply once the verdict landed')
    assert.deepStrictEqual(client.written[0].params.data, wrap(OWNER_CHANNEL, Buffer.from([0x00])), 'the derived ack (index 0) in the channel\'s own index space')
    assert.strictEqual(lad._internal.jarDigestStats().built, before.built, 'still nothing indexed on the calling thread')
    assert.strictEqual(lad.loginAssessmentSource(key), 'login-lane worker')
    const rec = client.forgeLoginCorroboration.find((r) => r.channel === OWNER_CHANNEL)
    assert.strictEqual(rec.verdictSource, 'login-lane worker', 'the receipt says where the verdict came from')
    const after = loginWindow.loginWindowSummary(client).queries[0]
    assert.strictEqual(after.outcome, 'answered')
    assert.strictEqual(after.derivation.done, true)
    assert.strictEqual(client.endedReasons.length, 0)
  }))

  it('m1b the worker gone (its promise resolves with nothing cached): the ladder re-enters on the inline walk - the fallback of a client with no worker, said so by the stats', async () => quiet(async () => {
    const dir = packDir()
    lad._internal.__clearJarDigests()
    const client = fml3Client()
    const inFlight = Promise.resolve(0)
    client.forgeLoginAssessmentsInFlight = new Map([[OWNER_CHANNEL, inFlight]])
    forgeHandshake3(client, { modsPaths: [dir] })
    const before = lad._internal.jarDigestStats().built
    query(client)
    await sleep(5)
    await drainDeferredReplies()
    assert.strictEqual(client.written.length, 1)
    assert.deepStrictEqual(client.written[0].params.data, wrap(OWNER_CHANNEL, Buffer.from([0x00])))
    assert.strictEqual(lad._internal.jarDigestStats().built, before + 1, 'the inline walk digested the jar on this thread (the fallback)')
    assert.strictEqual(lad.loginAssessmentSource(lad.loginAssessmentKeyOf(OWNER_CHANNEL, [dir])), 'assessed')
  }))

  it('m1c a worker verdict that knows nothing of the channel takes the FML convention acknowledge (99) the synchronous ladder falls through to - never a decline', async () => quiet(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf93-m1c-'))
    const client = fml3Client()
    client.forgeModList = { mods: ['minecraft', 'forge'], channels: [], registries: [] }
    client.forgePingMods = []
    let land = null
    const inFlight = new Promise((resolve) => { land = resolve })
    const channel = 'stranger:login'
    client.forgeLoginAssessmentsInFlight = new Map([[channel, inFlight]])
    forgeHandshake3(client, { modsPaths: [dir] })
    client.emit('login_plugin_request', { messageId: 7, channel: 'fml:loginwrapper', data: wrap(channel, Buffer.concat([writeVarInt(0), Buffer.from([0x01])])) })
    await drainDeferredReplies()
    assert.strictEqual(client.written.length, 0)
    lad.importLoginAssessments([{ key: lad.loginAssessmentKeyOf(channel, [dir]), result: { verdict: 'unknown' } }], 'login-lane worker')
    client.forgeLoginAssessmentsInFlight.delete(channel)
    land()
    await sleep(5)
    await drainDeferredReplies()
    assert.strictEqual(client.written.length, 1)
    assert.deepStrictEqual(client.written[0].params.data, wrap(channel, Buffer.from([99])), 'the convention acknowledge on the originating channel')
    assert.strictEqual(loginWindow.loginWindowSummary(client).queries[0].kind, 'convention ack (after the login-lane worker)')
  }))

  it('m5 the timing law: the budget stop fires at its TRUE time while the verdict is pending (the copy says what it waited for), and a reply decided before a stop is never refused by it', async () => quiet(async () => {
    const dir = packDir()
    // (a) pending past the budget: the stop at the budget's own time, the derivation named
    const a = fml3Client()
    let landLate = null
    a.forgeLoginAssessmentsInFlight = new Map([[OWNER_CHANNEL, new Promise((resolve) => { landLate = resolve })]])
    forgeHandshake3(a, { modsPaths: [dir], loginQueryBudgetMs: 300 })
    const t0 = Date.now()
    query(a)
    await sleep(450)
    const stop = a.forgeLoginWindowBudget
    assert.ok(stop, 'the budget stop fired')
    assert.ok(stop.waitedMs >= 290 && stop.waitedMs < 420, `true time: waited ${stop.waitedMs} of ${stop.budgetMs}`)
    assert.strictEqual(stop.derivation.done, false)
    assert.strictEqual(stop.derivation.name, `wrapped login verdict for ${OWNER_CHANNEL} from the login-lane worker`)
    assert.ok(/wrapped login verdict for calio:channel from the login-lane worker still running after \d+ ms/.test(a.endedReasons[0]), a.endedReasons[0])
    assert.ok(Date.now() - t0 < 1000)
    assert.strictEqual(a.written.length, 0)
    // the verdict lands AFTER our own stop: receipted LATE (what ended the query first), never a duplicate of an answer
    a.forgeLoginAssessmentsInFlight.delete(OWNER_CHANNEL)
    landLate()
    await sleep(5)
    await drainDeferredReplies()
    assert.strictEqual(a.written.length, 0, 'nothing written after the stop')
    const refusedLate = loginWindow.loginWindowSummary(a).refused
    assert.strictEqual(refusedLate.length, 1)
    assert.ok(/^late-reply: the budget stop closed the query first \(budget-ended/.test(refusedLate[0].why), refusedLate[0].why)
    // (b) decided before the stop: the field order (decision, a loop hold past the budget, the timer, the deferred write)
    const b = fml3Client()
    forgeHandshake3(b, { modsPaths: [dir], loginQueryBudgetMs: 300 })
    b.on('login_plugin_request', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)) // runs AFTER the handler decided, before its deferred write
    query(b)
    await sleep(50)
    await drainDeferredReplies()
    const q = loginWindow.loginWindowSummary(b)
    assert.strictEqual(b.written.length, 1, 'the decided reply reached the wire')
    assert.deepStrictEqual(b.written[0].params.data, wrap(OWNER_CHANNEL, Buffer.from([0x00])))
    assert.strictEqual(q.queries[0].outcome, 'answered')
    assert.deepStrictEqual(q.refused, [], 'never refused as a duplicate of a stop')
    assert.strictEqual(q.budgetStops.length, 0, 'no stop was written')
    assert.ok(q.queries[0].stopWaived && q.queries[0].stopWaived.waitedMs >= 300, `the late timer found the reply decided: ${JSON.stringify(q.queries[0].stopWaived)}`)
    assert.ok(q.queries[0].decidedMs != null && q.queries[0].decidedMs < 300, `decided inside the budget (${q.queries[0].decidedMs} ms)`)
    assert.strictEqual(b.endedReasons.length, 0)
  }))
})

// HF93 m2: the pre-login derivation imports each channel's verdict the
// moment it lands (never after the whole queue), and files the in-flight
// promise per channel for the login path.
describe('HF93 per-channel pre-login import', function () {
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const lad = require('../src/client/loginAckDerivation')
  const autoVersionForge = require('../src/client/autoVersionForge')
  const { OWNER_FIXTURE, OWNER_CHANNEL } = require('./helpers/hf93Pack')
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  it('m2 a verdict imported before the queue finishes; the in-flight map holds the rest; the batch warm untouched', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf93-m2-')); fs.copyFileSync(OWNER_FIXTURE, path.join(dir, 'origins-all.jar'))
    const client = makeClient()
    const o = console.log; console.log = () => {}
    try {
      const resolvers = new Map()
      const requested = []
      autoVersionForge(client, {
        modsPaths: [dir],
        loginAssessmentRequest: (channel, paths) => {
          requested.push(channel)
          return new Promise((resolve) => {
            resolvers.set(channel, () => {
              const key = lad.loginAssessmentKeyOf(channel, paths)
              resolve(lad.exportLoginAssessments().filter((e) => e.key === key).map((e) => ({ key: e.key.replace(dir, dir + '-m2'), result: e.result })))
            })
          })
        }
      })
      const response = { version: { name: '1.20.1', protocol: 763 }, forgeData: { fmlNetworkVersion: 3, truncated: false, channels: [{ res: OWNER_CHANNEL, version: '1.2', required: true }, { res: 'other:thing', version: '1', required: true }], mods: [{ modId: 'origins', modmarker: '1' }] } }
      for (const hook of client.autoVersionHooks) hook(response)
      await sleep(5)
      assert.deepStrictEqual(requested, [OWNER_CHANNEL, 'other:thing'], 'one request per channel')
      assert.deepStrictEqual([...client.forgeLoginAssessmentsInFlight.keys()], [OWNER_CHANNEL, 'other:thing'])
      // the "worker" computes the first verdict (here: this thread, keyed for a sibling path so the import is observable)
      lad.assessLoginChannel(OWNER_CHANNEL, [dir])
      resolvers.get(OWNER_CHANNEL)()
      await sleep(5)
      assert.strictEqual(lad.isLoginAssessmentCached(lad.loginAssessmentKeyOf(OWNER_CHANNEL, [dir + '-m2'])), true, 'imported before the queue finished')
      assert.strictEqual(lad.loginAssessmentSource(lad.loginAssessmentKeyOf(OWNER_CHANNEL, [dir + '-m2'])), 'login-lane worker')
      assert.deepStrictEqual([...client.forgeLoginAssessmentsInFlight.keys()], ['other:thing'], 'the landed channel left the in-flight map; the other is still held')
      assert.strictEqual(client.forgePreloginDerivation.assessed, 1)
      assert.strictEqual(client.forgePreloginDerivation.finishedAt, null, 'the queue is not finished')
      lad.assessLoginChannel('other:thing', [dir])
      resolvers.get('other:thing')()
      await sleep(5)
      assert.strictEqual(client.forgeLoginAssessmentsInFlight.size, 0)
      assert.strictEqual(client.forgePreloginDerivation.assessed, 2)
      assert.ok(client.forgePreloginDerivation.finishedAt != null)
      assert.strictEqual(client.forgePreloginDerivation.perChannel, true)
    } finally { console.log = o }
  })
})
