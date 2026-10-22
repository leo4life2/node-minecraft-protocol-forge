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

const { deriveLoginAck, assessLoginChannel } = require('../src/client/loginAckDerivation')
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

// HF12: wrapped-mod-channel replies are deferred one event-loop turn by the
// reply boundary law (loginReplyBoundary.js) — drain before asserting.
const drainDeferredReplies = () => new Promise((resolve) => setImmediate(() => setImmediate(() => setImmediate(resolve))))

async function loginReply (channel, disc, options) {
  const client = makeClient()
  forgeHandshake3(client, options || {})
  client.emit('login_plugin_request', {
    messageId: 7,
    channel: 'fml:loginwrapper',
    data: wrap(channel, Buffer.concat([writeVarInt(disc), Buffer.from([0xde, 0xad])]))
  })
  await drainDeferredReplies()
  assert.strictEqual(client.written.length, 1)
  return client.written[0].params.data
}

describe('wrapped login resolution order (table > derivation > FML 99)', function () {
  it('jar-derived ack answers wrapped login messages on channels the table does not know', async () => {
    const dir = synthCounterMod({ ns: 'omicron' })
    assert.deepStrictEqual(
      await loginReply('omicron:handshake', 3, { modsPaths: [dir] }),
      wrap('omicron:handshake', Buffer.from([0x01]))
    )
  })

  it('table override wins over derivation for known channels', async () => {
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
      await loginReply('tacz:handshake', 2, { modsPaths: [dir] }),
      wrap('tacz:handshake', Buffer.from([0x01]))
    )
  })

  it('falls through to the FML acknowledge (99) when derivation abstains', async () => {
    const dir = synthCounterMod({ ns: 'rho' })
    assert.deepStrictEqual(
      await loginReply('unknown:channel', 2, { modsPaths: [dir] }),
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

// --- local-int-counter registrations (HF2 lane: the calio class) ------------
//
// Ground truth: calio-forge-1.20.1-1.11.0.5.jar, CalioNetwork#register —
// javac's straight-line `int index = 0; CHANNEL.messageBuilder(cls, index++,
// DIR)` idiom (iconst_0/istore_0 ... iload_0/iinc 0,1), the channel RL built
// through a helper (CalioAPI.resource) that lives OUTSIDE the hot class set.
// The Forge 1.20.1 receipt: the client's reply must be the mod's own
// C2SAcknowledgePacket — index byte 0 + empty body (IndexedMessageCodec
// writeByte / readUnsignedByte; login index never on the wire).

function synthLocalCounterMod ({ ns, seed = 0, ackFirst = true, branch = false, computed = false, packages }) {
  const scPkg = packages === 'fml2' ? 'net/minecraftforge/fml/network' : 'net/minecraftforge/network'
  const sc = `${scPkg}/simple/SimpleChannel`
  const mb = `${scPkg}/simple/SimpleChannel$MessageBuilder`
  const nd = `${scPkg}/NetworkDirection`
  const nr = `${scPkg}/NetworkRegistry`
  const owner = `synth/${ns}/Net`
  const api = `synth/${ns}/API`
  const ack = `synth/${ns}/Ack`
  const login = `synth/${ns}/LoginSync`

  const site = (a, cls, direction) => a
    .getstatic(owner, 'CHANNEL', `L${sc};`)
    .ldcCls(cls)
    .iload(0)
    .iinc(0, 1)
    .getstatic(nd, direction, `L${nd};`)
    .invokevirtual(sc, 'messageBuilder', `(Ljava/lang/Class;IL${nd};)L${mb};`)
    .invokevirtual(mb, 'loginIndex', `(Ljava/util/function/Function;Ljava/util/function/BiConsumer;)L${mb};`)
    .invokevirtual(mb, 'add', '()V')

  const apiClass = buildClass({
    name: api,
    methods: [{
      name: 'resource',
      desc: `(Ljava/lang/String;)L${RL};`,
      code: (a) => a
        .new_(RL).dup().ldcStr(ns).aload(0)
        .invokespecial(RL, '<init>', '(Ljava/lang/String;Ljava/lang/String;)V')
        .areturn()
    }]
  })

  const net = buildClass({
    name: owner,
    methods: [
      {
        name: '<clinit>',
        desc: '()V',
        flags: 0x0008,
        code: (a) => a
          .ldcStr('channel')
          .invokestatic(api, 'resource', `(Ljava/lang/String;)L${RL};`)
          .invokestatic(nr, 'newSimpleChannel', `(L${RL};)L${sc};`)
          .putstatic(owner, 'CHANNEL', `L${sc};`)
          .ret()
      },
      {
        name: 'register',
        desc: '()V',
        code: (a) => {
          a.iconst(seed).istore(0)
          // `index = index * 2;` — iload_0 iconst_2 imul istore_0: the imul
          // is invisible to the event stream, so the istore must NOT be
          // proven by the (non-adjacent) iconst_2 event before it
          if (computed) a.iload(0).iconst(2).imul().istore(0)
          if (branch) a.iconst(0).ifeq(4) // any branch poisons the simulation
          if (ackFirst) { site(a, ack, 'LOGIN_TO_SERVER'); site(a, login, 'LOGIN_TO_CLIENT') } else { site(a, login, 'LOGIN_TO_CLIENT'); site(a, ack, 'LOGIN_TO_SERVER') }
          return a.ret()
        }
      }
    ]
  })

  return writeJarDir(ns, [
    { name: `${api}.class`, data: apiClass },
    { name: `${owner}.class`, data: net },
    { name: `${ack}.class`, data: emptyEncoderClass(ack) },
    { name: `${login}.class`, data: busyEncoderClass(login) }
  ])
}

describe('loginAckDerivation - local-int-counter shape (calio class)', function () {
  it('calio-exact shape: helper-built RL + local counter, ack first -> index 0, single 0x00 byte', () => {
    const dir = synthLocalCounterMod({ ns: 'lcalio' })
    const r = deriveLoginAck('lcalio:channel', [dir])
    assert.ok(r, 'derivation must succeed')
    assert.strictEqual(r.index, 0)
    assert.deepStrictEqual(r.reply, Buffer.from([0x00]))
    assert.strictEqual(r.msgClass, 'synth/lcalio/Ack')
  })

  it('counts the local counter: ack registered second -> index 1', () => {
    const dir = synthLocalCounterMod({ ns: 'lsecond', ackFirst: false })
    const r = deriveLoginAck('lsecond:channel', [dir])
    assert.ok(r)
    assert.strictEqual(r.index, 1)
    assert.deepStrictEqual(r.reply, Buffer.from([0x01]))
  })

  it('honors a nonzero local seed', () => {
    const dir = synthLocalCounterMod({ ns: 'lseed', seed: 3 })
    const r = deriveLoginAck('lseed:channel', [dir])
    assert.ok(r)
    assert.strictEqual(r.index, 3)
  })

  it('abstains on a computed store: unmodeled arithmetic between push and istore (M1 pin)', () => {
    // `int index = 0; index = index * 2;` — before the adjacency poison the
    // event stream saw iconst_2 immediately before the istore and derived
    // index 2 (truth: 0), presenting a WRONG value as proven. The store
    // resolution must abstain whenever ANY instruction sits between the
    // value push and the store.
    const dir = synthLocalCounterMod({ ns: 'limul', computed: true })
    assert.strictEqual(deriveLoginAck('limul:channel', [dir]), null)
    // the channel IS known locally -> honest underivable, never the 99 guess
    assert.strictEqual(assessLoginChannel('limul:channel', [dir]).verdict, 'underivable')
  })

  it('abstains when the registration method branches (simulation no longer provable)', () => {
    const dir = synthLocalCounterMod({ ns: 'lbranch', branch: true })
    assert.strictEqual(deriveLoginAck('lbranch:channel', [dir]), null)
    // ...but the channel IS known locally, so the verdict is an honest
    // underivable, never the FML-99 guess
    assert.strictEqual(assessLoginChannel('lbranch:channel', [dir]).verdict, 'underivable')
  })

  it('derives the FML2-era package (net/minecraftforge/fml/network/simple) identically', () => {
    const dir = synthLocalCounterMod({ ns: 'loldpkg', packages: 'fml2' })
    const r = deriveLoginAck('loldpkg:channel', [dir])
    assert.ok(r, 'old-package derivation must succeed')
    assert.strictEqual(r.index, 0)
    assert.deepStrictEqual(r.reply, Buffer.from([0x00]))
  })
})

describe('assessLoginChannel verdicts', function () {
  it("'unknown' when no local jar creates the channel", () => {
    const dir = synthLocalCounterMod({ ns: 'lver' })
    assert.deepStrictEqual(assessLoginChannel('absent:channel', [dir]), { verdict: 'unknown' })
    assert.deepStrictEqual(assessLoginChannel('absent:channel', []), { verdict: 'unknown' })
  })

  it("'ack' carries the exact reply bytes", () => {
    const dir = synthLocalCounterMod({ ns: 'lack' })
    const a = assessLoginChannel('lack:channel', [dir])
    assert.strictEqual(a.verdict, 'ack')
    assert.deepStrictEqual(a.reply, Buffer.from([0x00]))
  })

  it("'unknown' when the RL exists locally but only as a NON-channel creation (registry key)", () => {
    // origins:origins in the real family pack: the id names a DYNAMIC
    // REGISTRY, not a network channel. Non-channel RL consumers must not
    // count as channel knowledge, or the honest-failure path would stop
    // joins the FML-99 convention may still carry.
    const owner = 'synth/lreg/Registries'
    const cls = buildClass({
      name: owner,
      methods: [{
        name: '<clinit>',
        desc: '()V',
        flags: 0x0008,
        code: (a) => a
          .new_(RL).dup().ldcStr('lreg').ldcStr('lreg')
          .invokespecial(RL, '<init>', '(Ljava/lang/String;Ljava/lang/String;)V')
          .invokestatic('net/minecraft/resources/ResourceKey', 'createRegistryKey', `(L${RL};)Lnet/minecraft/resources/ResourceKey;`)
          .putstatic(owner, 'KEY', 'Lnet/minecraft/resources/ResourceKey;')
          .ret()
      }]
    })
    const dir = writeJarDir('lreg', [{ name: `${owner}.class`, data: cls }])
    assert.deepStrictEqual(assessLoginChannel('lreg:lreg', [dir]), { verdict: 'unknown' })
  })

  it("'underivable' with reason substantive-reply when the only login C2S provably writes data", () => {
    // reuse the eps shape from above: busy encoder, login-marked
    const owner = 'synth/lsub/Net'
    const busy = 'synth/lsub/Busy'
    const net = buildClass({
      name: owner,
      methods: [
        { name: '<clinit>', desc: '()V', flags: 0x0008, code: clinitFor(owner, 'lsub', 'handshake', 1) },
        { name: 'init', desc: '()V', code: (a) => registerCounter(a, owner, busy).ret() }
      ]
    })
    const dir = writeJarDir('lsub', [
      { name: `${owner}.class`, data: net },
      { name: `${busy}.class`, data: busyEncoderClass(busy) }
    ])
    const a = assessLoginChannel('lsub:handshake', [dir])
    assert.strictEqual(a.verdict, 'underivable')
    assert.strictEqual(a.reason, 'substantive-reply')
    assert.strictEqual(a.msgClass, busy)
  })
})

// --- ground truth: the real shipped calio jar (env-gated) -------------------

const CALIO_MODS = process.env.MODS_SCAN_CALIO_MODS || '/private/tmp/mods-scan-rigs/calio/mods'

describe('loginAckDerivation - real calio jar (HF2 receipt ground truth)', function () {
  this.timeout(30000)

  it('calio-forge 1.20.1-1.11.0.5: derives C2SAcknowledgePacket at index 0 (reply 0x00)', function () {
    if (!fs.existsSync(path.join(CALIO_MODS, 'calio-forge-1.20.1-1.11.0.5.jar'))) return this.skip()
    const r = deriveLoginAck('calio:channel', [CALIO_MODS])
    assert.ok(r, 'must derive (the incumbent abstained here — the receipt failure)')
    assert.strictEqual(r.index, 0)
    assert.deepStrictEqual(r.reply, Buffer.from([0x00]))
    assert.strictEqual(r.msgClass, 'io/github/edwinmindcraft/calio/common/network/packet/C2SAcknowledgePacket')
  })
})

// HF93 m3/m4: THE PER-JAR DIGEST. A jar is read into its channel-independent
// digest once per content sha1 (nested jars inside their parent's), and every
// channel asks the digest; the raw walk stays for a needle the digest's
// alphabet cannot spell. The CONTROL: the digest path and the raw walk
// derive byte-identical verdicts over every committed fixture jar, and the
// whole set's sha is the one the base (c5fa1b7) derived.
describe('HF93 per-jar digest', function () {
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const crypto = require('crypto')
  const lad = require('../src/client/loginAckDerivation')
  const { buildClass, buildJar } = require('./helpers/synthJar')
  const { OWNER_FIXTURE, OWNER_CHANNEL } = require('./helpers/hf93Pack')
  const stats = () => lad._internal.jarDigestStats()
  const ser = (r) => JSON.stringify(r, (k, v) => (v && v.type === 'Buffer' && Array.isArray(v.data)) ? { $buffer: Buffer.from(v.data).toString('base64') } : v)
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
  const CHANNELS = ['calio:channel', 'tacz:handshake', 'framework:handshake', 'zeta:main', 'owo:handshake', 'origins:origins', 'biggerstacks:main', 'stacc:main', 'sophisticatedcore:channel', 'waystones:network', 'balm:network', 'securitycraft:network', 'glitchcore:network', 'immersive_portals:main', 'bettercombat:network', 'combat_roll:network', 'nobody:nothing']
  // the fixture set's verdicts, serialized as the embedder's store serializes them, at the base c5fa1b7 (the raw walk only);
  // HF105: the five hf105-*.trimmed.jar fixtures (tfmg, createdieselgenerators, create, moonlight, supplementaries) joined the set - the
  // digest-vs-raw byte identity below is the control, this sha is the set's listing (re-pinned over the grown set; 95d3c1db... before)
  // HF106: the two hf106-embeddium-*.jar fixtures (the trimmed real jar + its no-guard twin) joined the set (57fcd6a9... before)
  const BASE_FIXTURE_SET_SHA = 'e188a2ebbc8892fb023219f7e08972ac65888e58e3a51bd2cd4ecc5c62d1cdc3' // HF110: the set grew by the hf110-* fixtures (the trimmed owner + library pair and the no-call-site twin); every earlier pair derives what it derived (the lane's bV control, pair by pair)
  const quiet = (fn) => { const o = console.log; console.log = () => {}; try { return fn() } finally { console.log = o } }
  const packOf = (tag) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hf93-m3-${tag}-`))
    fs.copyFileSync(OWNER_FIXTURE, path.join(dir, 'a-origins-all.jar'))
    fs.writeFileSync(path.join(dir, 'b-plain.jar'), buildJar([{ name: 'META-INF/mods.toml', data: Buffer.from('modLoader="javafml"\n[[mods]]\nmodId="plain"\n') }, { name: 'plain/Main.class', data: buildClass({ name: 'plain/Main', methods: [] }) }]))
    fs.writeFileSync(path.join(dir, 'c-empty.jar'), buildJar([{ name: 'META-INF/mods.toml', data: Buffer.from('modLoader="javafml"\n[[mods]]\nmodId="empty"\n') }]))
    return dir
  }

  it('m3 a pack is digested once per jar across two channels and two joins (a second folder of the same bytes hits by sha1; a changed jar re-digests alone)', () => quiet(() => {
    lad._internal.__clearJarDigests()
    const dir = packOf('one')
    const r1 = lad.assessLoginChannel(OWNER_CHANNEL, [dir])
    assert.strictEqual(r1.verdict, 'ack')
    assert.deepStrictEqual({ built: stats().built, rawWalks: stats().rawWalks }, { built: 3, rawWalks: 0 }, 'three jars, one digest each, no raw walk')
    const r2 = lad.assessLoginChannel('plain:login', [dir]) // a second channel: the wide pass re-asks the digests
    assert.strictEqual(r2.verdict, 'unknown')
    assert.strictEqual(stats().built, 3, 'no jar digested twice for the second channel')
    // a second join: the same bytes under another path (the sha1 is the key, never the path)
    const again = packOf('two')
    lad.assessLoginChannel('other:thing', [again])
    assert.strictEqual(stats().built, 3, 'the second join digested nothing')
    assert.ok(stats().hits >= 3)
    // one jar changes: only it re-digests
    fs.writeFileSync(path.join(again, 'c-empty.jar'), buildJar([{ name: 'META-INF/mods.toml', data: Buffer.from('modLoader="javafml"\n[[mods]]\nmodId="empty"\nversion="2"\n') }]))
    lad.assessLoginChannel('fourth:channel', [again])
    assert.strictEqual(stats().built, 4)
    assert.strictEqual(stats().held, 4)
    // the LRU law: the embedder's slot count bounds the store, the oldest out first
    assert.deepStrictEqual(lad.configureJarDigestCache({ slots: 2 }), { slots: 2, held: 2 })
    lad.configureJarDigestCache({ slots: 1024 })
  }))

  it('m4 CONTROL: the digest path and the raw walk derive byte-identical verdicts over every fixture jar; the set\'s sha is the base\'s; a needle outside the digest alphabet takes the raw walk', () => quiet(() => {
    const fixtures = fs.readdirSync(path.join(__dirname, 'fixtures')).filter((f) => f.endsWith('.jar')).map((f) => path.join(__dirname, 'fixtures', f))
    const run = (raw, tag) => {
      lad._internal.__clearJarDigests()
      lad._internal.digestStore.rawWalk = raw
      const out = {}
      try {
        for (const jar of fixtures) {
          const copy = fs.mkdtempSync(path.join(os.tmpdir(), `hf93-m4-${tag}-`)) // a fresh key per run (the verdict cache is keyed on the path)
          fs.copyFileSync(jar, path.join(copy, path.basename(jar)))
          for (const ch of CHANNELS) { const r = lad.assessLoginChannel(ch, [path.join(copy, path.basename(jar))]); out[`${path.basename(jar)}::${ch}`] = { sha: sha(ser(r)), verdict: r.verdict, index: r.index } }
        }
      } finally { lad._internal.digestStore.rawWalk = false }
      return out
    }
    const viaDigest = run(false, 'd')
    assert.strictEqual(stats().rawWalks, 0, 'the digest answered every fixture')
    assert.ok(stats().built >= fixtures.length)
    const viaRaw = run(true, 'r')
    assert.strictEqual(stats().built, 0, 'the raw walk digested nothing')
    assert.ok(stats().rawWalks >= fixtures.length)
    assert.deepStrictEqual(viaDigest, viaRaw, 'byte-identical verdicts, pair by pair')
    assert.strictEqual(sha(JSON.stringify(viaDigest)), BASE_FIXTURE_SET_SHA, 'the whole fixture set derives what the base derived')
    assert.ok(Object.values(viaDigest).some((v) => v.verdict === 'ack'), 'the set holds a derived ack (calio)')
    // a needle the alphabet cannot spell: the raw walk, as before
    lad._internal.__clearJarDigests()
    const dir = packOf('alpha')
    assert.strictEqual(lad.assessLoginChannel('weird~ns:path', [dir]).verdict, 'unknown')
    assert.deepStrictEqual({ built: stats().built, rawWalks: stats().rawWalks }, { built: 0, rawWalks: 3 })
  }))
})

// ---------------------------------------------------------------------------
// HF110: THE CROSS-JAR BUILDER BINDING + THE MIRROR REPLY. The field (F44, a
// Forge 1.19.2 world of 302 mods): the login ended at one wrapped message on
// quark:main. The owner jar's QuarkNetwork never spells "main" - the channel
// is built by the LIBRARY (AutoRegLib's NetworkHandler("quark", 2) adds the
// ldc "main", builds the ResourceLocation and the SimpleChannel); the login
// check is a mirror (S2CLoginFlag at 98 = longArray + int + int, the client
// handler answers `new C2SLoginFlag()` at 99 = the same three members from
// its own configuration). Fixtures: the two REAL jars trimmed to the
// structural classes + mods.toml (test/fixtures/hf110-*.trimmed.jar); the
// twin = the owner jar with QuarkNetwork's constant-pool reference to the
// library class rewritten to a same-length name no jar holds (the call site
// no longer binds). The base tree derives 'unknown' on every one of these.
describe('HF110 cross-jar builder binding + mirror reply (real Quark 3.4-418 + AutoRegLib 1.8.2-55, trimmed)', function () {
  const FX = path.join(__dirname, 'fixtures')
  const OWNER = path.join(FX, 'hf110-Quark-3.4-418.trimmed.jar')
  const LIB = path.join(FX, 'hf110-AutoRegLib-1.8.2-55.trimmed.jar')
  const TWIN = path.join(FX, 'hf110-Quark-3.4-418.twin-nocallsite.jar')
  const lad = require('../src/client/loginAckDerivation')
  const quietly = (fn) => { const log = console.log; console.log = () => {}; try { return fn() } finally { console.log = log } }
  // the S2C body a real server sends behind index 98: writeLongArray (varint length 1 + one long) + int + int
  const S2C_BODY = Buffer.from('010000000000000005' + '0000000c' + '2a3b4c5d', 'hex')

  it('R1 + R2: the owner + library pair derives the echo verdict at the reply index 99, builtBy naming the library jar file and its mod id, no reply buffer at assess time', () => quietly(() => {
    lad._internal.__clearJarDigests()
    const r = lad.assessLoginChannel('quark:main', [OWNER, LIB])
    assert.strictEqual(r.verdict, 'echo')
    assert.strictEqual(r.index, 99)
    assert.strictEqual(r.msgClass, 'vazkii/quark/base/network/message/structural/C2SLoginFlag')
    assert.strictEqual(r.inboundClass, 'vazkii/quark/base/network/message/structural/S2CLoginFlag')
    assert.strictEqual(r.constructedAt, 'vazkii/quark/base/network/message/structural/S2CLoginFlag#consume')
    assert.deepStrictEqual(r.layout, ['m_178381_()[J', 'readInt()I', 'readInt()I'])
    assert.deepStrictEqual(r.builtBy, { jarName: 'hf110-AutoRegLib-1.8.2-55.trimmed.jar', modId: 'autoreglib', className: 'vazkii/arl/network/NetworkHandler', nestedChain: [] })
    assert.strictEqual(r.jarName, 'hf110-Quark-3.4-418.trimmed.jar')
    assert.strictEqual(r.corroboration, 'corroborated-by-local-jar')
    assert.deepStrictEqual(r.namespaceProof.chain, { kind: 'cross-jar-builder', className: 'vazkii/arl/network/NetworkHandler', method: '<init>', desc: '(Ljava/lang/String;I)V', ns: 'quark', path: 'main' })
    assert.strictEqual(r.namespaceProof.owner.by, 'mods-toml')
    assert.strictEqual(r.reply, undefined, 'no reply bytes at assess time: the body is the query\'s')
    assert.match(r.evidence, /explicit constant 99 at vazkii\/quark\/base\/network\/QuarkNetwork#setup \(through vazkii\/quark\/base\/network\/QuarkNetwork#loginIndexedBuilder\)/)
    // JSON-safe round trip: the verdict the embedder persists revives byte for byte
    const entry = lad.exportLoginAssessments().find((e) => e.key === lad.loginAssessmentKeyOf('quark:main', [OWNER, LIB]))
    assert.ok(entry && entry.result.verdict === 'echo')
    assert.strictEqual(JSON.stringify(JSON.parse(JSON.stringify(entry.result))), JSON.stringify(entry.result))
    // the order of the paths does not change the verdict (the library may sit before the owner in a census)
    assert.strictEqual(lad.assessLoginChannel('quark:main', [LIB, OWNER]).verdict, 'echo')
  }))

  it('the handshake reply for a synthesized S2C body = the reply index byte + the inbound body byte for byte; the corroboration row says jar-derived-echo and names the library', () => quietly(() => {
    const client = new EventEmitter()
    client.forgePingMods = [{ id: 'quark', version: '3.4-418' }]
    client.forgeModList = { mods: ['minecraft', 'forge', 'quark'], channels: [{ name: 'quark:main', marker: '2' }], registries: [] }
    const resolved = forgeHandshake3.resolveWrappedModLogin(client, 'quark:main', 98, S2C_BODY, { modsPaths: [OWNER, LIB] }, 3, false)
    assert.ok(resolved && Buffer.isBuffer(resolved.reply), 'a reply rides')
    assert.strictEqual(resolved.reply.toString('hex'), '63' + '010000000000000005' + '0000000c' + '2a3b4c5d')
    assert.deepStrictEqual(resolved.reply, Buffer.concat([Buffer.from([99]), S2C_BODY]))
    assert.strictEqual(resolved.via, 'jar-derived echo index 99 from hf110-Quark-3.4-418.trimmed.jar (built by hf110-AutoRegLib-1.8.2-55.trimmed.jar)')
    const row = client.forgeLoginCorroboration[0]
    assert.strictEqual(row.via, 'jar-derived-echo'); assert.strictEqual(row.index, 99); assert.strictEqual(row.ownerMod, 'quark'); assert.strictEqual(row.ownerVersion, '3.4-418')
    assert.deepStrictEqual(row.builtBy, { jarName: 'hf110-AutoRegLib-1.8.2-55.trimmed.jar', modId: 'autoreglib' })
    assert.strictEqual(client.forgeDeclinedLoginChannels, undefined, 'no decline')
    // a different body on a later query echoes THAT body: the bytes are the query's, never cached
    const other = Buffer.from('00' + 'ffffffff' + '00000000', 'hex')
    assert.strictEqual(forgeHandshake3.resolveWrappedModLogin(client, 'quark:main', 98, other, { modsPaths: [OWNER, LIB] }, 3, false).reply.toString('hex'), '63' + other.toString('hex'))
    // an empty body echoes the bare index (never a guessed byte)
    assert.strictEqual(forgeHandshake3.resolveWrappedModLogin(client, 'quark:main', 98, Buffer.alloc(0), { modsPaths: [OWNER, LIB] }, 3, false).reply.toString('hex'), '63')
  }))

  // Rider: HF110 - the replay body pin. The bytes a real Forge 1.19.2 server
  // (the verify rig, 302-mod mods folder) sent on quark:main behind its index
  // byte 98, and the reply the real child put on the wire (recorded through a
  // byte proxy); the handshake reply seat over the trimmed pair must equal that
  // reply byte for byte - the server's own body behind the reply index 99.
  it('the recorded S2C body from the Forge 1.19.2 rig replay echoes to the recorded reply byte for byte', () => quietly(() => {
    const recordedBody = Buffer.from('04fffffffffffffeffffdffff3ffffffffffffffffffffffff0000ffffffffffff00000109e99ea7ac', 'hex')
    const recordedReply = '6304fffffffffffffeffffdffff3ffffffffffffffffffffffff0000ffffffffffff00000109e99ea7ac'
    const client = new EventEmitter()
    client.forgePingMods = [{ id: 'quark', version: '3.4-418' }]
    client.forgeModList = { mods: ['minecraft', 'forge', 'quark'], channels: [{ name: 'quark:main', marker: '2' }], registries: [] }
    const resolved = forgeHandshake3.resolveWrappedModLogin(client, 'quark:main', 98, recordedBody, { modsPaths: [OWNER, LIB] }, 3, false)
    assert.ok(resolved && Buffer.isBuffer(resolved.reply), 'a reply rides')
    assert.strictEqual(resolved.reply.toString('hex'), recordedReply)
    assert.strictEqual(resolved.reply.length, 1 + recordedBody.length)
    assert.strictEqual(client.forgeLoginCorroboration[0].via, 'jar-derived-echo')
    assert.strictEqual(client.forgeDeclinedLoginChannels, undefined, 'no decline')
  }))

  it('the owner jar alone = unknown (no builder callee in the paths), the library alone = unknown, the no-call-site twin + library = unknown: never a library name in the serialized verdict', () => quietly(() => {
    lad._internal.__clearJarDigests()
    for (const paths of [[OWNER], [LIB], [TWIN, LIB], [TWIN]]) {
      const r = lad.assessLoginChannel('quark:main', paths)
      assert.strictEqual(r.verdict, 'unknown', paths.map((p) => path.basename(p)).join('+'))
      assert.strictEqual(r.builtBy, undefined)
      assert.ok(!JSON.stringify(r).includes('AutoRegLib') && !JSON.stringify(r).includes('autoreglib'), 'no library name on an unknown verdict')
    }
    // the base's bare unknown, byte for byte (the bV control: an owner jar with no creation serializes exactly as before)
    assert.strictEqual(JSON.stringify(lad.assessLoginChannel('quark:main', [OWNER])), JSON.stringify({ verdict: 'unknown' }))
  }))

  it('the mechanism, not the mod: the forwarded registration reads the caller\'s constant through the helper\'s parameter slot, the mirror reads the two layouts and the no-arg construction', () => quietly(() => {
    lad._internal.__clearJarDigests()
    lad.assessLoginChannel('quark:main', [OWNER, LIB])
    const { regSitesOn, mirrorEchoOf, bufferLayoutOf, newFacts, indexJar } = lad._internal
    const facts = newFacts(); const hot = []
    for (const jar of [OWNER, LIB]) indexJar(fs.readFileSync(jar), { jarPath: jar, chain: [], artifacts: [] }, facts, 0, Buffer.from('quark'), Buffer.from('main'), hot, false)
    for (const jar of [OWNER, LIB]) indexJar(fs.readFileSync(jar), { jarPath: jar, chain: [], artifacts: [] }, facts, 0, Buffer.from('quark'), Buffer.from('main'), hot, true)
    assert.deepStrictEqual(hot.map((h) => h.className), ['vazkii/quark/base/network/QuarkNetwork'], 'the owner class is admitted through its call into the library (the twin admits nothing)')
    assert.ok(facts.builderCallees.has('vazkii/arl/network/NetworkHandler'), 'the library class is a builder-callee candidate')
    const sites = regSitesOn(facts, hot)
    const forwarded = sites.filter((s) => s.forwardedFrom)
    assert.deepStrictEqual(forwarded.map((s) => [s.msgClass.split('/').pop(), s.index.const, s.direction, s.loginMarked, s.noResponse]), [['S2CLoginFlag', 98, 'LOGIN_TO_CLIENT', true, false], ['C2SLoginFlag', 99, 'LOGIN_TO_SERVER', true, true]])
    assert.ok(forwarded.every((s) => s.channelField === 'vazkii/arl/network/NetworkHandler.channel' && s.forwardedFrom === 'vazkii/quark/base/network/QuarkNetwork#loginIndexedBuilder'))
    const echo = mirrorEchoOf(facts, sites.filter((s) => s.channelField === 'vazkii/arl/network/NetworkHandler.channel'), hot)
    assert.strictEqual(echo.index, 99)
    const a = bufferLayoutOf(facts, 'vazkii/quark/base/network/message/structural/S2CLoginFlag')
    const b = bufferLayoutOf(facts, 'vazkii/quark/base/network/message/structural/C2SLoginFlag')
    assert.deepStrictEqual(a.reads, b.reads); assert.deepStrictEqual(a.writes, b.writes)
    assert.deepStrictEqual(a.writes, ['m_130091_([J)Lnet/minecraft/network/FriendlyByteBuf;', 'writeInt(I)Lio/netty/buffer/ByteBuf;', 'writeInt(I)Lio/netty/buffer/ByteBuf;'])
  }))
})
