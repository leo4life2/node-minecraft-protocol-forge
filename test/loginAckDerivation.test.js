/* eslint-env mocha */
// Battery for the SimpleChannel login-ack derivation (loginAckDerivation.js).
//
// Deterministic part: synthetic jars built by test/helpers/synthJar.js emit
// the exact bytecode idioms javac produces for the covered registration
// shapes, so the derivation mechanics (creation discovery, counter seeds,
// prior-use counting, empty-encoder proof, abstain rules) run on every
// `npm test` without shipping third-party mod jars.
//
// Ground-truth part (env-gated): when the local E2E rigs are present, the
// derivation must reproduce the HAND-VERIFIED table replies byte-for-byte
// on the real shipped jars (framework 0.7.15 -> 0x01, tacz 1.1.7 -> 0x01)
// and abstain on zeta (echo protocol). Skipped cleanly when absent.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')

const { deriveLoginAck } = require('../src/client/loginAckDerivation')
const forgeHandshake3 = require('../src/client/forgeHandshake3')
const { writeVarInt, writeString } = forgeHandshake3
const { buildClass, buildJar } = require('./helpers/synthJar')

const RL = 'net/minecraft/resources/ResourceLocation'
const SC = 'net/minecraftforge/network/simple/SimpleChannel'
const MB = 'net/minecraftforge/network/simple/SimpleChannel$MessageBuilder'
const AI = 'java/util/concurrent/atomic/AtomicInteger'
const NR = 'net/minecraftforge/network/NetworkRegistry'
const FBB = 'net/minecraft/network/FriendlyByteBuf'

// --- synthetic mod builders -------------------------------------------------

// <clinit>: CHANNEL = NetworkRegistry.newSimpleChannel(new RL(ns, path));
//           COUNT = new AtomicInteger(seed)
function clinitFor (owner, ns, pathPart, seed) {
  return (a) => a
    .new_(RL).dup().ldcStr(ns).ldcStr(pathPart)
    .invokespecial(RL, '<init>', '(Ljava/lang/String;Ljava/lang/String;)V')
    .invokestatic(NR, 'newSimpleChannel', `(L${RL};)L${SC};`)
    .putstatic(owner, 'CHANNEL', `L${SC};`)
    .new_(AI).dup().iconst(seed).invokespecial(AI, '<init>', '(I)V')
    .putstatic(owner, 'COUNT', `L${AI};`)
    .ret()
}

// CHANNEL.messageBuilder(cls, COUNT.getAndIncrement()).loginIndex(..).add()
function registerCounter (a, owner, cls) {
  return a
    .getstatic(owner, 'CHANNEL', `L${SC};`)
    .ldcCls(cls)
    .getstatic(owner, 'COUNT', `L${AI};`)
    .invokevirtual(AI, 'getAndIncrement', '()I')
    .invokevirtual(SC, 'messageBuilder', `(Ljava/lang/Class;I)L${MB};`)
    .invokevirtual(MB, 'loginIndex', `(Ljava/util/function/Function;Ljava/util/function/BiConsumer;)L${MB};`)
    .invokevirtual(MB, 'add', '()V')
}

function emptyEncoderClass (name) {
  return buildClass({
    name,
    methods: [{ name: 'encode', desc: `(L${name};L${FBB};)V`, code: (a) => a.ret() }]
  })
}

function busyEncoderClass (name) {
  return buildClass({
    name,
    methods: [{ name: 'encode', desc: `(L${name};L${FBB};)V`, code: (a) => a.aload(0).pop().ret() }]
  })
}

function writeJarDir (name, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `synthjar-${name}-`))
  fs.writeFileSync(path.join(dir, `${name}.jar`), buildJar(entries))
  return dir
}

// One self-contained synthetic mod: net class registering ack/other on a
// counter-indexed channel. `order` controls which registration comes first.
function synthCounterMod ({ ns, order = 'ack-first', seed = 1 }) {
  const owner = `synth/${ns}/Net`
  const ack = `synth/${ns}/Ack`
  const other = `synth/${ns}/Other`
  const net = buildClass({
    name: owner,
    methods: [
      { name: '<clinit>', desc: '()V', flags: 0x0008, code: clinitFor(owner, ns, 'handshake', seed) },
      {
        name: 'init',
        desc: '()V',
        code: (a) => {
          if (order === 'ack-first') { registerCounter(a, owner, ack); registerCounter(a, owner, other) } else { registerCounter(a, owner, other); registerCounter(a, owner, ack) }
          return a.ret()
        }
      }
    ]
  })
  return writeJarDir(ns, [
    { name: `synth/${ns}/Net.class`, data: net },
    { name: `synth/${ns}/Ack.class`, data: emptyEncoderClass(ack) },
    { name: `synth/${ns}/Other.class`, data: busyEncoderClass(other) }
  ])
}

describe('loginAckDerivation - synthetic jars (deterministic)', function () {
  it('derives the ack index from a counter-seeded channel, ack registered first', () => {
    const dir = synthCounterMod({ ns: 'alpha' })
    const r = deriveLoginAck('alpha:handshake', [dir])
    assert.ok(r, 'derivation must succeed')
    assert.strictEqual(r.index, 1)
    assert.deepStrictEqual(r.reply, Buffer.from([0x01]))
    assert.strictEqual(r.msgClass, 'synth/alpha/Ack')
  })

  it('counts prior counter uses: ack registered second gets index seed+1', () => {
    const dir = synthCounterMod({ ns: 'beta', order: 'other-first' })
    const r = deriveLoginAck('beta:handshake', [dir])
    assert.ok(r)
    assert.strictEqual(r.index, 2)
    assert.deepStrictEqual(r.reply, Buffer.from([0x02]))
  })

  it('honors the counter SEED, not an assumed 1', () => {
    const dir = synthCounterMod({ ns: 'gamma', seed: 5 })
    const r = deriveLoginAck('gamma:handshake', [dir])
    assert.ok(r)
    assert.strictEqual(r.index, 5)
  })

  it('derives explicit-constant indices', () => {
    const owner = 'synth/delta/Net'
    const ack = 'synth/delta/Ack'
    const net = buildClass({
      name: owner,
      methods: [
        { name: '<clinit>', desc: '()V', flags: 0x0008, code: clinitFor(owner, 'delta', 'handshake', 1) },
        {
          name: 'init',
          desc: '()V',
          code: (a) => a
            .getstatic(owner, 'CHANNEL', `L${SC};`)
            .ldcCls(ack).iconst(7)
            .invokevirtual(SC, 'messageBuilder', `(Ljava/lang/Class;I)L${MB};`)
            .invokevirtual(MB, 'loginIndex', `(Ljava/util/function/Function;Ljava/util/function/BiConsumer;)L${MB};`)
            .invokevirtual(MB, 'add', '()V')
            .ret()
        }
      ]
    })
    const dir = writeJarDir('delta', [
      { name: `${owner}.class`, data: net },
      { name: `${ack}.class`, data: emptyEncoderClass(ack) }
    ])
    const r = deriveLoginAck('delta:handshake', [dir])
    assert.ok(r)
    assert.strictEqual(r.index, 7)
    assert.deepStrictEqual(r.reply, writeVarInt(7))
  })

  it('abstains when no registered login message has an empty encoder', () => {
    const owner = 'synth/eps/Net'
    const busy = 'synth/eps/Busy'
    const net = buildClass({
      name: owner,
      methods: [
        { name: '<clinit>', desc: '()V', flags: 0x0008, code: clinitFor(owner, 'eps', 'handshake', 1) },
        { name: 'init', desc: '()V', code: (a) => registerCounter(a, owner, busy).ret() }
      ]
    })
    const dir = writeJarDir('eps', [
      { name: `${owner}.class`, data: net },
      { name: `${busy}.class`, data: busyEncoderClass(busy) }
    ])
    assert.strictEqual(deriveLoginAck('eps:handshake', [dir]), null)
  })

  it('abstains on registrations without login markers', () => {
    const owner = 'synth/zetaX/Net'
    const ack = 'synth/zetaX/Ack'
    const net = buildClass({
      name: owner,
      methods: [
        { name: '<clinit>', desc: '()V', flags: 0x0008, code: clinitFor(owner, 'zetaX', 'handshake', 1) },
        {
          name: 'init',
          desc: '()V',
          code: (a) => a
            .getstatic(owner, 'CHANNEL', `L${SC};`)
            .ldcCls(ack)
            .getstatic(owner, 'COUNT', `L${AI};`)
            .invokevirtual(AI, 'getAndIncrement', '()I')
            .invokevirtual(SC, 'messageBuilder', `(Ljava/lang/Class;I)L${MB};`)
            .invokevirtual(MB, 'add', '()V') // no loginIndex/markAsLoginPacket
            .ret()
        }
      ]
    })
    const dir = writeJarDir('zetaX', [
      { name: `${owner}.class`, data: net },
      { name: `${ack}.class`, data: emptyEncoderClass(ack) }
    ])
    assert.strictEqual(deriveLoginAck('zetaX:handshake', [dir]), null)
  })

  it('returns null without mods paths and on unreadable/unmatched sources', () => {
    assert.strictEqual(deriveLoginAck('anything:goes', []), null)
    assert.strictEqual(deriveLoginAck('anything:goes', ['/no/such/dir']), null)
    const dir = synthCounterMod({ ns: 'omega' })
    assert.strictEqual(deriveLoginAck('unrelated:channel', [dir]), null)
  })
})

// --- handler integration: override-first, derivation-second, ack-99 last ---

function wrap (channel, payload) {
  return Buffer.concat([writeString(channel), writeVarInt(payload.length), payload])
}

function makeClient () {
  const client = new EventEmitter()
  client.written = []
  client.write = (name, params) => client.written.push({ name, params })
  return client
}

function loginReply (channel, disc, options) {
  const client = makeClient()
  forgeHandshake3(client, options || {})
  client.emit('login_plugin_request', {
    messageId: 7,
    channel: 'fml:loginwrapper',
    data: wrap(channel, Buffer.concat([writeVarInt(disc), Buffer.from([0xde, 0xad])]))
  })
  assert.strictEqual(client.written.length, 1)
  return client.written[0].params.data
}

describe('wrapped login resolution order (table > derivation > FML 99)', function () {
  it('jar-derived ack answers wrapped login messages on channels the table does not know', () => {
    const dir = synthCounterMod({ ns: 'omicron' })
    assert.deepStrictEqual(
      loginReply('omicron:handshake', 3, { modsPaths: [dir] }),
      wrap('omicron:handshake', Buffer.from([0x01]))
    )
  })

  it('table override wins over derivation for known channels', () => {
    // tacz:handshake is in the table; hand it mods that would derive a
    // DIFFERENT (wrong-on-purpose) index and assert the table still answers
    const owner = 'synth/tz/Net'
    const ack = 'synth/tz/Ack'
    const net = buildClass({
      name: owner,
      methods: [
        { name: '<clinit>', desc: '()V', flags: 0x0008, code: clinitFor(owner, 'tacz', 'handshake', 9) },
        { name: 'init', desc: '()V', code: (a) => registerCounter(a, owner, ack).ret() }
      ]
    })
    const dir = writeJarDir('tz', [
      { name: `${owner}.class`, data: net },
      { name: `${ack}.class`, data: emptyEncoderClass(ack) }
    ])
    assert.deepStrictEqual(
      loginReply('tacz:handshake', 2, { modsPaths: [dir] }),
      wrap('tacz:handshake', Buffer.from([0x01]))
    )
  })

  it('falls through to the FML acknowledge (99) when derivation abstains', () => {
    const dir = synthCounterMod({ ns: 'rho' })
    assert.deepStrictEqual(
      loginReply('unknown:channel', 2, { modsPaths: [dir] }),
      wrap('unknown:channel', writeVarInt(99))
    )
  })
})

// --- ground truth on real shipped jars (env-gated, skip when rigs absent) ---

const LIMINAL_MODS = process.env.MODS_SCAN_LIMINAL_MODS || '/private/tmp/mods-scan-rigs/liminal/mods'
const ZOMBIE_MODS = process.env.MODS_SCAN_ZOMBIE_MODS || '/private/tmp/mods-scan-rigs/zombie/mods'

describe('loginAckDerivation - real shipped jars (ground truth)', function () {
  this.timeout(60000) // full modpack scans (146 jars) take a few seconds

  it('framework 0.7.15: derives 0x01, byte-identical to the hand-verified table entry', function () {
    if (!fs.existsSync(path.join(LIMINAL_MODS, 'framework-forge-1.20.1-0.7.15.jar'))) return this.skip()
    const r = deriveLoginAck('framework:handshake', [LIMINAL_MODS])
    assert.ok(r, 'must derive')
    assert.strictEqual(r.index, 1)
    const tableReply = forgeHandshake3.WRAPPED_LOGIN_PROTOCOLS['framework:handshake'](2, Buffer.alloc(0))
    assert.deepStrictEqual(r.reply, tableReply)
  })

  it('tacz 1.1.7: derives 0x01, byte-identical to the hand-verified table entry', function () {
    if (!fs.existsSync(path.join(ZOMBIE_MODS, 'tacz-1.20.1-1.1.7-release.jar'))) return this.skip()
    const r = deriveLoginAck('tacz:handshake', [ZOMBIE_MODS])
    assert.ok(r, 'must derive')
    assert.strictEqual(r.index, 1)
    const tableReply = forgeHandshake3.WRAPPED_LOGIN_PROTOCOLS['tacz:handshake'](2, Buffer.alloc(0))
    assert.deepStrictEqual(r.reply, tableReply)
  })

  it('zeta: abstains (echo protocol, not an empty ack - the table must keep owning it)', function () {
    if (!fs.existsSync(ZOMBIE_MODS)) return this.skip()
    assert.strictEqual(deriveLoginAck('zeta:main', [ZOMBIE_MODS]), null)
  })
})
