/* eslint-env mocha */
// HF35 rider (verify-r2 MED-1): the owo:handshake reply is the THREE writeHashes
// calls of OwoHandshake#syncClient (owo-lib 0.11.2 javap ~:75-109):
// REQUIRED_CHANNELS, REGISTERED_CONTROLLERS, then the client's OWN
// OPTIONAL_CHANNELS. The request payload (the server's optional map) is never
// echoed - the reply bytes are a pure function of our fingerprints.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildReply, encodeIdHashMap, RAW_LOGIN_PROTOCOLS, assess } = require('../src/client/owoHandshake')

// hand-pinned layout: [01 06 'a:main' 01] [01 03 'a:p' fbffffff0f] [01 05 'a:opt' <varint -123456789>]
const PINNED = '0106613a6d61696e010103613a70fbffffff0f0105613a6f7074ebe590c50f'
const FP = { channels: { 'a:main': 1 }, controllers: { 'a:p': -5 }, optional: { 'a:opt': -123456789 } }
const SERVER_REQUEST = encodeIdHashMap({ 'srv:opt': 7, 'srv:other': -1 })

describe('owo:handshake reply layout (javap-derived, syncClient)', function () {
  it('buildReply = required map + controller map + OUR optional map, byte-for-byte', () => {
    assert.strictEqual(buildReply(FP).toString('hex'), PINNED)
    assert.strictEqual(PINNED.slice(0, 2), '01')
    assert.ok(Buffer.from(PINNED, 'hex').includes(Buffer.from('a:opt')), 'our optional id is on the wire')
  })
  it('the server request bytes never reach the reply (no echo, whatever the second argument)', () => {
    assert.strictEqual(buildReply(FP, SERVER_REQUEST).toString('hex'), PINNED)
    assert.ok(!buildReply(FP, SERVER_REQUEST).includes(Buffer.from('srv:opt')))
  })
  it('the Forge-lane builder and assess produce the same bytes for a mods folder with no owo mods (three empty maps), ignoring the request', () => {
    const dir = fs.mkdtempSync(path.join(process.env.MINEPAL_USER_DATA_DIR || os.tmpdir(), 'hf35-owo-empty-'))
    try {
      const opts = { modsPaths: [dir] }
      assert.strictEqual(RAW_LOGIN_PROTOCOLS['owo:handshake'](SERVER_REQUEST, opts).toString('hex'), '000000')
      const a = assess(SERVER_REQUEST, opts)
      assert.strictEqual(a.data.toString('hex'), '000000')
      assert.strictEqual(assess(Buffer.from([0]), opts).data.toString('hex'), '000000')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

// --- HF72: the identifier shape at a <clinit> that reaches OwoNetChannel.create
// through an INTERMEDIARY (javap of the field jar, net/arcana/friendsforlife/Net
// 1.2.0 and 1.3.1, byte for byte the same <clinit>):
//   new CompatResourceLocation; dup; ldc "friendsforlife"; ldc "main";
//   invokespecial CompatResourceLocation.<init>:(String,String)V;
//   invokevirtual CompatResourceLocation.unwrap:()Lnet/minecraft/class_2960;
//   invokestatic OwoNetChannel.create:(Lclass_2960;)LOwoNetChannel;
// The same family: a two-string static factory returning the Identifier
// (Identifier.of(ns, path) on 1.21+, MyMod.id(ns, path)) and the identifier
// class's own one-string factory. The base skipped the channel ("unresolvable
// identifier") and sent a PARTIAL map the server rejected by name.
describe('HF72 — the identifier shape through an intermediary, the under-derived receipt, the scan off the loop', function () {
  this.timeout(20000)
  const { buildClass, buildJar } = require('./helpers/synthJar')
  const { javaStringHash } = require('../src/client/jarAnalysis')
  const owo = require('../src/client/owoHandshake')
  // the process boundary the embedding app injects (MinePal src/utils/owoScanJob.js forks the same runner)
  const { fork } = require('child_process')
  const scanJob = (paths) => new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, '..', 'src', 'client', 'owoScanRunner.js'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    child.once('message', (m) => { child.kill(); m && m.ok ? resolve(m.fingerprints) : reject(new Error(m && m.error)) })
    child.once('error', reject)
    child.send({ paths })
  })
  const ID = 'net/minecraft/class_2960'
  const CH = 'io/wispforest/owo/network/OwoNetChannel'
  const HANDLER = 'Lio/wispforest/owo/network/OwoNetChannel$ChannelHandler;'
  const idHash = (ns, p) => (Math.imul(31, javaStringHash(ns)) + javaStringHash(p)) | 0
  // one serverbound record zz/m/net/Hello, one clientbound zz/m/net/World
  const expected = (ns, p) => (Math.imul(31, idHash(ns, p)) +
    ((Math.imul(1, 31) + javaStringHash('zz.m.net.Hello')) | 0) +
    ((Math.imul(-1, 31) + javaStringHash('zz.m.net.World')) | 0)) | 0

  function netClass (NET, emitIdentifier) {
    return buildClass({
      name: NET,
      fields: [{ name: 'CHANNEL', desc: `L${CH};` }],
      methods: [{
        name: '<clinit>',
        desc: '()V',
        flags: 0x0008,
        code: (a) => {
          emitIdentifier(a)
          a.invokestatic(CH, 'create', `(L${ID};)L${CH};`).putstatic(NET, 'CHANNEL', `L${CH};`)
          a.getstatic(NET, 'CHANNEL', `L${CH};`).ldcCls('zz/m/net/Hello').aconstNull().invokevirtual(CH, 'registerServerbound', `(Ljava/lang/Class;${HANDLER})V`)
          a.getstatic(NET, 'CHANNEL', `L${CH};`).ldcCls('zz/m/net/World').aconstNull().invokevirtual(CH, 'registerClientbound', `(Ljava/lang/Class;${HANDLER})V`)
          a.ret()
        }
      }]
    })
  }
  const jarOf = (ns, net, NET) => buildJar([
    { name: 'fabric.mod.json', data: Buffer.from(JSON.stringify({ schemaVersion: 1, id: ns, version: '1.0.0' })) },
    { name: `${NET}.class`, data: net }
  ])
  let n = 0
  const root = fs.mkdtempSync(path.join(process.env.MINEPAL_USER_DATA_DIR || os.tmpdir(), 'hf72-owo-'))
  after(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })
  const dirWith = (files) => { const d = path.join(root, `mods-${n++}`); fs.mkdirSync(d); for (const [f, b] of Object.entries(files)) fs.writeFileSync(path.join(d, f), b); return d }

  it('C1. the wrapper shape (new Wrapper("ns","path") ... .unwrap():()LIdentifier;) resolves — the channel is derived, nothing skipped', () => {
    const W = 'zz/m/util/CompatResourceLocation'
    const net = netClass('zz/m/Net', (a) => a.new_(W).dup().ldcStr('wrapmod').ldcStr('main')
      .invokespecial(W, '<init>', '(Ljava/lang/String;Ljava/lang/String;)V').invokevirtual(W, 'unwrap', `()L${ID};`))
    const fp = owo.scanOwoFingerprints([dirWith({ 'wrapmod-1.0.0.jar': jarOf('wrapmod', net, 'zz/m/Net') })])
    assert.deepStrictEqual(Object.keys(fp.channels), ['wrapmod:main'])
    assert.strictEqual(fp.channels['wrapmod:main'], expected('wrapmod', 'main'))
    assert.deepStrictEqual(fp.skipped, [])
  })

  it('C1b. the one-string wrapper (new Wrapper("ns:path").get():()LIdentifier;) and an INTERFACE conversion resolve the same way', () => {
    const W = 'zz/m/util/ResLoc'
    const net = netClass('zz/m/Net', (a) => a.new_(W).dup().ldcStr('onemod:main')
      .invokespecial(W, '<init>', '(Ljava/lang/String;)V').invokeinterface(W, 'get', `()L${ID};`, 1))
    const fp = owo.scanOwoFingerprints([dirWith({ 'onemod-1.0.0.jar': jarOf('onemod', net, 'zz/m/Net') })])
    assert.strictEqual(fp.channels['onemod:main'], expected('onemod', 'main'))
    assert.deepStrictEqual(fp.skipped, [])
  })

  it('C2. the two-string static factory (Identifier.of(ns, path) / MyMod.id(ns, path)) and the identifier class\'s own one-string factory resolve', () => {
    const net2 = netClass('zz/m/Net', (a) => a.ldcStr('facmod').ldcStr('main').invokestatic(ID, 'method_60655', `(Ljava/lang/String;Ljava/lang/String;)L${ID};`))
    const fp2 = owo.scanOwoFingerprints([dirWith({ 'facmod-1.0.0.jar': jarOf('facmod', net2, 'zz/m/Net') })])
    assert.strictEqual(fp2.channels['facmod:main'], expected('facmod', 'main'))
    const net1 = netClass('zz/m/Net', (a) => a.ldcStr('onefac:main').invokestatic(ID, 'method_60654', `(Ljava/lang/String;)L${ID};`))
    const fp1 = owo.scanOwoFingerprints([dirWith({ 'onefac-1.0.0.jar': jarOf('onefac', net1, 'zz/m/Net') })])
    assert.strictEqual(fp1.channels['onefac:main'], expected('onefac', 'main'))
    assert.deepStrictEqual(fp1.skipped.concat(fp2.skipped), [])
  })

  it('C3 CONTROL. the literal shape (new Identifier("ns","path")) is byte-for-byte what it was; a wrapper built from NON-constant strings is not guessed', () => {
    const lit = netClass('zz/m/Net', (a) => a.new_(ID).dup().ldcStr('litmod').ldcStr('main').invokespecial(ID, '<init>', '(Ljava/lang/String;Ljava/lang/String;)V'))
    const fp = owo.scanOwoFingerprints([dirWith({ 'litmod-1.0.0.jar': jarOf('litmod', lit, 'zz/m/Net') })])
    assert.strictEqual(fp.channels['litmod:main'], expected('litmod', 'main'))
    // no string constants reach the wrapper: nothing to derive — skipped, said
    const W = 'zz/m/util/Dyn'
    const dyn = netClass('zz/m/Net', (a) => a.new_(W).dup().aconstNull().aconstNull()
      .invokespecial(W, '<init>', '(Ljava/lang/String;Ljava/lang/String;)V').invokevirtual(W, 'unwrap', `()L${ID};`))
    const fpd = owo.scanOwoFingerprints([dirWith({ 'dynmod-1.0.0.jar': jarOf('dynmod', dyn, 'zz/m/Net') })])
    assert.deepStrictEqual(fpd.channels, {})
    assert.strictEqual(fpd.skipped.length, 1)
    assert.strictEqual(fpd.skipped[0].kind, 'channel')
    assert.strictEqual(fpd.skipped[0].site, 'zz/m/Net#<clinit>')
    assert.strictEqual(fpd.skipped[0].reason, 'unresolvable-identifier')
    assert.match(fpd.skipped[0].shape, /no identifier constant reached the creation call/)
  })

  it('B1. assess stamps derived.skipped[] (site + reason + shape) — the UNDER-DERIVED receipt; a fully derived reply carries []', () => {
    const W = 'zz/m/util/Dyn'
    const dyn = netClass('zz/m/Net', (a) => a.new_(W).dup().aconstNull().aconstNull()
      .invokespecial(W, '<init>', '(Ljava/lang/String;Ljava/lang/String;)V').invokevirtual(W, 'unwrap', `()L${ID};`))
    const r = owo.assess(Buffer.from([0]), { modsPaths: [dirWith({ 'dynmod-1.0.0.jar': jarOf('dynmod', dyn, 'zz/m/Net') })] })
    assert.ok(Buffer.isBuffer(r.data), 'a PARTIAL map is still sent (the server names what it misses)')
    assert.deepStrictEqual(r.derived.skipped, [{ kind: 'channel', site: 'zz/m/Net#<clinit>', reason: 'unresolvable-identifier', shape: r.derived.skipped[0].shape }])
    const lit = netClass('zz/m/Net', (a) => a.new_(ID).dup().ldcStr('litmod').ldcStr('main').invokespecial(ID, '<init>', '(Ljava/lang/String;Ljava/lang/String;)V'))
    const ok = owo.assess(Buffer.from([0]), { modsPaths: [dirWith({ 'litmod-1.0.0.jar': jarOf('litmod', lit, 'zz/m/Net') })] })
    assert.deepStrictEqual(ok.derived.skipped, [])
    assert.deepStrictEqual(ok.derived.channelIds, ['litmod:main'])
  })

  it('D1. assessAsync resolves to the bytes assess returns, the scan ran in a child (the loop stayed responsive), and the cache is shared', async () => {
    // a jar heavy enough that the synchronous scan measurably freezes the loop
    const W = 'zz/h/util/CRL'
    const classes = []
    let count = 200
    let dir = null
    let syncMs = 0
    for (let round = 0; round < 6; round++) {
      classes.length = 0
      for (let i = 0; i < count; i++) {
        const NET = `zz/h/Net${i}`
        // a wide constant pool + a long <clinit> per class: the bytecode walk is the cost
        classes.push({ name: `${NET}.class`, data: netClass(NET, (a) => { for (let k = 0; k < 1500; k++) a.ldcStr(`pad-${i}-${k}`); return a.new_(W).dup().ldcStr('heavy').ldcStr(`ch${i}`).invokespecial(W, '<init>', '(Ljava/lang/String;Ljava/lang/String;)V').invokevirtual(W, 'unwrap', `()L${ID};`) }) })
      }
      dir = dirWith({ 'heavy-1.0.0.jar': buildJar([{ name: 'fabric.mod.json', data: Buffer.from('{"schemaVersion":1,"id":"heavy","version":"1"}') }].concat(classes)) })
      const t0 = Date.now(); owo.scanOwoFingerprints([dir]); syncMs = Date.now() - t0
      if (syncMs >= 80) break
      count *= 2
    }
    assert.ok(syncMs >= 80, `the heavy jar scans in ${syncMs} ms (needs >= 80 ms to measure a freeze)`)
    let maxGap = 0; let last = Date.now()
    const iv = setInterval(() => { const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now }, 2)
    const t1 = Date.now()
    const r = await owo.assessAsync(Buffer.from([0]), { modsPaths: [dir], scanJob })
    const asyncMs = Date.now() - t1
    clearInterval(iv)
    const sync = owo.assess(Buffer.from([0]), { modsPaths: [dir] })
    assert.strictEqual(r.data.toString('hex'), sync.data.toString('hex'))
    assert.strictEqual(r.derived.channels, count)
    assert.ok(maxGap < syncMs / 2, `the loop's longest gap during the off-loop scan was ${maxGap} ms (the sync scan freezes it ${syncMs} ms; the child took ${asyncMs} ms)`)
    // the second call reads the shared cache synchronously (no child)
    let jobs = 0
    const t2 = Date.now(); const again = await owo.assessAsync(Buffer.from([0]), { modsPaths: [dir], scanJob: () => { jobs++; return scanJob([dir]) } }); assert.ok(Date.now() - t2 < syncMs, 'cached')
    assert.strictEqual(jobs, 0, 'no second child for a cached folder')
    assert.strictEqual(again.data.toString('hex'), sync.data.toString('hex'))
    console.log(`      [hf72 D1] sync scan ${syncMs} ms, off-loop ${asyncMs} ms, loop max gap ${maxGap} ms (${count} classes)`)
  })

  it('D2. assessAsync with no mods folder is the same honest abstain as assess (a promise of it); a job that fails or returns nothing falls back to the synchronous scan', async () => {
    const r = await owo.assessAsync(Buffer.from([0]), { modsPaths: [], scanJob })
    assert.deepStrictEqual(r, owo.assess(Buffer.from([0]), { modsPaths: [] }))
    assert.strictEqual(r.abstain.reason, 'no-mods-folder')
    const lit = netClass('zz/m/Net', (a) => a.new_(ID).dup().ldcStr('fbmod').ldcStr('main').invokespecial(ID, '<init>', '(Ljava/lang/String;Ljava/lang/String;)V'))
    const dir = dirWith({ 'fbmod-1.0.0.jar': jarOf('fbmod', lit, 'zz/m/Net') })
    const failed = await owo.assessAsync(Buffer.from([0]), { modsPaths: [dir], scanJob: () => Promise.reject(new Error('no child')) })
    assert.deepStrictEqual(failed.derived.channelIds, ['fbmod:main'])
    const dir2 = dirWith({ 'fbmod-1.0.1.jar': jarOf('fbmod', lit, 'zz/m/Net') })
    const empty = await owo.assessAsync(Buffer.from([0]), { modsPaths: [dir2], scanJob: () => Promise.resolve(null) })
    assert.deepStrictEqual(empty.derived.channelIds, ['fbmod:main'])
    const dir3 = dirWith({ 'fbmod-1.0.2.jar': jarOf('fbmod', lit, 'zz/m/Net') })
    const none = await owo.assessAsync(Buffer.from([0]), { modsPaths: [dir3] })
    assert.deepStrictEqual(none.derived.channelIds, ['fbmod:main'], 'no job injected = the synchronous scan')
  })

  it('R2 PROBE (ground truth, env-gated): the real field jar derives its channel through the wrapper, nothing skipped', function () {
    const real = process.env.HF72_REAL_JARS
    if (!real || !fs.existsSync(real)) { this.skip(); return }
    const fp = owo.scanOwoFingerprints([real])
    assert.ok(Object.keys(fp.channels).includes('friendsforlife:main'), `channels: ${Object.keys(fp.channels)}`)
    assert.deepStrictEqual(fp.skipped, [])
  })
})
