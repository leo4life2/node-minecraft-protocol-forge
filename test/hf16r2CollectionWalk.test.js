/* eslint-env mocha */
// HF16-R2 round 2 — the DECIDED COLLECTION WALK, generically:
//   (1) every single-element mutator the producer detector accepts
//       materializes (offer / addFirst / addLast / push, Map.put + values()),
//       not only List.add — an ArrayDeque queue claims instead of abstaining;
//   (2) a decided iterator walk earns one loop visit per element it consumed
//       (charged to that walk), so a queue longer than the 64-per-pc bound is
//       walked whole while an UNDECIDED loop still stops at 64 — round 1's
//       pack-wide 256 exhausted the shared step budget on a 71-jar pack.
// Mechanism fixtures (no mod names): entry iterates a static collection on its
// own class, populated from a bridge with an invokedynamic lambda capturing the
// producer's parameter; the boot subclass calls `reg(new Packet())`.
const assert = require('assert')
const fs = require('fs'); const os = require('os'); const path = require('path')
const { buildClass, buildJar } = require('./helpers/synthJar')
const { deriveNeoForgeComponents } = require('../src/client/neoForgePayloadDerivation')
const EVENT = 'net/neoforged/neoforge/network/event/RegisterPayloadHandlersEvent'
const REG = 'net/neoforged/neoforge/network/registration/PayloadRegistrar'
const TYPE = 'net/minecraft/network/protocol/common/custom/CustomPacketPayload$Type'
const RL = 'net/minecraft/resources/ResourceLocation'
const CODEC = 'net/minecraft/network/codec/StreamCodec'
const HANDLER = 'net/neoforged/neoforge/network/handling/IPayloadHandler'
const REG_DESC = `(L${TYPE};L${CODEC};L${HANDLER};)L${REG};`
const F1 = 'kotlin/jvm/functions/Function1'; const KLAMBDA = 'kotlin/jvm/internal/Lambda'; const CONSUMER = 'java/util/function/Consumer'
const ITER = 'java/util/Iterator'
const objInit = (a, sup = 'java/lang/Object') => a.aload(0).invokespecial(sup, '<init>', '()V').ret()
function netClass (P, { fi, coll, map = false }) { // the entry: static queue on its OWN class, read directly, functional call per element
  const name = `${P}/Net`; const cd = `L${coll};`
  const loop = (a) => {
    a.aload(0).ldcStr('7').invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`).astore(1) // 0..6
    if (map) a.getstatic(name, 'pending', cd).invokevirtual(coll, 'values', '()Ljava/util/Collection;').invokeinterface('java/util/Collection', 'iterator', `()L${ITER};`, 1).astore(2)
    else a.getstatic(name, 'pending', cd).invokevirtual(coll, 'iterator', `()L${ITER};`).astore(2) // 7..13
    a.aload(2).invokeinterface(ITER, 'hasNext', '()Z', 1) // 14..19
    if (fi === 'consumer') {
      a.ifeq(23).aload(2).invokeinterface(ITER, 'next', '()Ljava/lang/Object;', 1).checkcast(CONSUMER).astore(3) // 20..32
      a.aload(3).aload(1).invokeinterface(CONSUMER, 'accept', '(Ljava/lang/Object;)V', 2).goto_(-26).ret() // 33..43
    } else {
      a.ifeq(24).aload(2).invokeinterface(ITER, 'next', '()Ljava/lang/Object;', 1).checkcast(F1).astore(3)
      a.aload(3).aload(1).invokeinterface(F1, 'invoke', '(Ljava/lang/Object;)Ljava/lang/Object;', 2).pop().goto_(-27).ret()
    }
    return a
  }
  return buildClass({
    name,
    fields: [{ name: 'pending', desc: cd, flags: 0x001a }],
    methods: [
      { name: '<init>', desc: '()V', flags: 0x0002, code: (a) => objInit(a) },
      { name: 'onRegister', desc: `(L${EVENT};)V`, flags: 0x0019, code: loop },
      { name: '<clinit>', desc: '()V', flags: 0x0008, code: (a) => a.new_(coll).dup().invokespecial(coll, '<init>', '()V').putstatic(name, 'pending', cd).ret() }
    ]
  })
}
function bridge (P, { idiom, coll, mut, map = false, noop = false, extraNoop = false, method = 'playToServer' }) {
  const name = `${P}/Bridge`; const net = `${P}/Net`; const base = `${P}/Base`; const lam = `${P}/Bridge$enqueue$1`; const cd = `L${coll};`
  const out = []
  const mutate = (a) => {
    if (map) return a.invokevirtual(coll, 'put', '(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;').pop() // key = the packet, value = the lambda
    if (mut === 'add' || mut === 'offer') return a.invokevirtual(coll, mut, '(Ljava/lang/Object;)Z').pop()
    return a.invokevirtual(coll, mut, '(Ljava/lang/Object;)V') // addFirst / addLast / push return void
  }
  const bodyReg = (a, regSlot, pktLoad) => { a.aload(regSlot); pktLoad(a); return a.invokevirtual(base, 'type', `()L${TYPE};`).aconstNull().aconstNull().invokevirtual(REG, method, REG_DESC).pop().aconstNull().areturn() }
  const bodyNoop = (a, pktLoad) => { pktLoad(a); return a.invokestatic('java/util/Objects', 'requireNonNull', '(Ljava/lang/Object;)Ljava/lang/Object;').pop().aconstNull().areturn() }
  const methods = [{ name: '<init>', desc: '()V', flags: 0x0001, code: (a) => objInit(a) }]
  const bsms = []
  if (idiom === 'indy') {
    bsms.push({ refKind: 6, owner: name, name: 'enqueue$lambda$0', desc: `(L${base};L${REG};)Ljava/lang/Object;` })
    methods.push({ name: 'enqueue', desc: `(L${base};)V`, flags: 0x0009, code: (a) => mutate((map ? a.getstatic(net, 'pending', cd).aload(0).aload(0) : a.getstatic(net, 'pending', cd).aload(0)).invokedynamic(0, 'accept', `(L${base};)L${CONSUMER};`)).ret() })
    methods.push({ name: 'enqueue$lambda$0', desc: `(L${base};L${REG};)Ljava/lang/Object;`, flags: 0x100a, code: (a) => noop ? bodyNoop(a, (b) => b.aload(0)) : bodyReg(a, 1, (b) => b.aload(0)) })
    if (extraNoop) {
      bsms.push({ refKind: 6, owner: name, name: 'observe$lambda$1', desc: `(L${base};L${REG};)Ljava/lang/Object;` })
      methods.push({ name: 'observe', desc: `(L${base};)V`, flags: 0x0009, code: (a) => mutate(a.getstatic(net, 'pending', cd).aload(0).invokedynamic(1, 'accept', `(L${base};)L${CONSUMER};`)).ret() })
      methods.push({ name: 'observe$lambda$1', desc: `(L${base};L${REG};)Ljava/lang/Object;`, flags: 0x100a, code: (a) => bodyNoop(a, (b) => b.aload(0)) })
    }
  } else {
    methods.push({ name: 'enqueue', desc: `(L${base};)V`, flags: 0x0009, code: (a) => mutate(a.getstatic(net, 'pending', cd).new_(lam).dup().aload(0).invokespecial(lam, '<init>', `(L${base};)V`)).ret() })
    out.push({
      name: `${lam}.class`,
      data: buildClass({
        name: lam,
        superName: KLAMBDA,
        interfaces: [F1],
        fields: [{ name: '$p', desc: `L${base};`, flags: 0x1012 }],
        methods: [
          { name: '<init>', desc: `(L${base};)V`, flags: 0x0000, code: (a) => a.aload(0).aload(1).putfield(lam, '$p', `L${base};`).aload(0).iconst(1).invokespecial(KLAMBDA, '<init>', '(I)V').ret() },
          { name: 'invoke', desc: `(L${REG};)Lkotlin/Unit;`, flags: 0x0011, code: (a) => noop ? bodyNoop(a, (b) => b.aload(0).getfield(lam, '$p', `L${base};`)) : bodyReg(a, 1, (b) => b.aload(0).getfield(lam, '$p', `L${base};`)) },
          { name: 'invoke', desc: '(Ljava/lang/Object;)Ljava/lang/Object;', flags: 0x1041, code: (a) => a.aload(0).aload(1).checkcast(REG).invokevirtual(lam, 'invoke', `(L${REG};)Lkotlin/Unit;`).areturn() }
        ]
      })
    })
  }
  out.push({ name: `${name}.class`, data: buildClass({ name, bootstrapMethods: bsms, methods }) })
  return out
}
function packets (P, ids) {
  const base = `${P}/Base`
  const out = [{
    name: `${base}.class`,
    data: buildClass({
      name: base,
      methods: [
        { name: '<init>', desc: '()V', flags: 0x0001, code: (a) => objInit(a) },
        { name: 'getId', desc: `()L${RL};`, flags: 0x0001, code: (a) => a.aconstNull().areturn() },
        { name: 'type', desc: `()L${TYPE};`, flags: 0x0001, code: (a) => a.new_(TYPE).dup().aload(0).invokevirtual(base, 'getId', `()L${RL};`).invokespecial(TYPE, '<init>', `(L${RL};)V`).areturn() }
      ]
    })
  }]
  for (const [cls, id] of ids) {
    out.push({
      name: `${cls}.class`,
      data: buildClass({
        name: cls,
        superName: base,
        fields: [{ name: 'id', desc: `L${RL};`, flags: 0x0012 }],
        methods: [
          { name: '<init>', desc: '()V', flags: 0x0001, code: (a) => a.aload(0).invokespecial(base, '<init>', '()V').aload(0).ldcStr('synthv').ldcStr(id).invokestatic(RL, 'fromNamespaceAndPath', `(Ljava/lang/String;Ljava/lang/String;)L${RL};`).putfield(cls, 'id', `L${RL};`).ret() },
          { name: 'getId', desc: `()L${RL};`, flags: 0x0001, code: (a) => a.aload(0).getfield(cls, 'id', `L${RL};`).areturn() }
        ]
      })
    })
  }
  return out
}
function boot (P, pk, { hops = 0, viaObserve = false } = {}) { // Core.reg(P) -> [hops static pass-throughs] -> Bridge.enqueue; Boot extends Core calls this.reg(new P()) (owner = Boot)
  const core = `${P}/Core`; const bt = `${P}/Boot`; const base = `${P}/Base`; const bridge = `${P}/Bridge`
  const out = []
  let nextOwner = bridge; let nextName = 'enqueue'
  for (let i = hops; i >= 1; i--) {
    const h = `${P}/Hop${i}`; const o = nextOwner; const n = nextName
    out.push({ name: `${h}.class`, data: buildClass({ name: h, methods: [{ name: 'h', desc: `(L${base};)V`, flags: 0x0009, code: (a) => a.aload(0).invokestatic(o, n, `(L${base};)V`).ret() }] }) })
    nextOwner = h; nextName = 'h'
  }
  const o = nextOwner; const n = nextName
  out.push({
    name: `${core}.class`,
    data: buildClass({
      name: core,
      methods: [
        { name: '<init>', desc: '()V', flags: 0x0001, code: (a) => objInit(a) },
        { name: 'reg', desc: `(L${base};)L${base};`, flags: 0x0014, code: (a) => a.aload(1).invokestatic(o, n, `(L${base};)V`).aload(1).areturn() }
      ]
    })
  })
  out.push({
    name: `${bt}.class`,
    data: buildClass({
      name: bt,
      superName: core,
      fields: [{ name: 'INSTANCE', desc: `L${bt};`, flags: 0x0019 }],
      methods: [
        { name: '<init>', desc: '()V', flags: 0x0002, code: (a) => { a.aload(0).invokespecial(core, '<init>', '()V'); for (const c of pk) a.aload(0).new_(c).dup().invokespecial(c, '<init>', '()V').invokevirtual(bt, 'reg', `(L${base};)L${base};`).pop(); if (viaObserve) a.new_(pk[0]).dup().invokespecial(pk[0], '<init>', '()V').invokestatic(bridge, 'observe', `(L${base};)V`); return a.ret() } },
        { name: '<clinit>', desc: '()V', flags: 0x0008, code: (a) => a.new_(bt).dup().invokespecial(bt, '<init>', '()V').putstatic(bt, 'INSTANCE', `L${bt};`).ret() }
      ]
    })
  })
  return out
}
function jar (P, o) {
  const ids = o.n ? Array.from({ length: o.n }, (_, i) => [`${P}/P${i}`, `p${i}`]) : [[`${P}/OnePacket`, 'one'], [`${P}/TwoPacket`, 'two']]
  const entries = [{ name: 'META-INF/neoforge.mods.toml', data: Buffer.from('[[mods]]\nmodId="synthv"\nversion="1.0.0"\n') },
    { name: `${P}/Net.class`, data: netClass(P, o) }, ...bridge(P, o), ...packets(P, ids), ...boot(P, ids.map(([c]) => c), o)]
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'p3-')); const j = path.join(dir, 'v.jar'); fs.writeFileSync(j, buildJar(entries)); return j
}

const run = (P, o) => {
  const r = deriveNeoForgeComponents([jar(P, o)])
  return { ids: r.components.play.map((c) => c.id).sort(), vers: r.components.play.map((c) => c.version), abst: r.diagnostics.abstains, err: r.diagnostics.errors }
}
const two = ['synthv:one', 'synthv:two']

describe('HF16-R2 round 2: decided collection walk — mutator set + per-walk loop allowance', function () {
  this.timeout(60000)
  it('ArrayDeque.offer queue claims (was: abstain — only List.add materialized)', () => {
    const r = run('synthv/offer', { fi: 'consumer', idiom: 'indy', coll: 'java/util/ArrayDeque', mut: 'offer' })
    assert.deepStrictEqual(r.ids, two); assert.deepStrictEqual(r.err, []); assert.ok(r.vers.every((v) => v === '7'), JSON.stringify(r.vers))
  })
  it('ArrayDeque.addFirst / addLast / push (void mutators) materialize', () => {
    for (const mut of ['addFirst', 'addLast', 'push']) {
      const r = run(`synthv/${mut.toLowerCase()}`, { fi: 'consumer', idiom: 'indy', coll: 'java/util/ArrayDeque', mut })
      assert.deepStrictEqual(r.ids, two, mut); assert.deepStrictEqual(r.err, [], mut)
    }
  })
  it('HashMap.put keyed by the packet, walked through values(), claims', () => {
    const r = run('synthv/mapput', { fi: 'consumer', idiom: 'indy', coll: 'java/util/HashMap', mut: 'put', map: true })
    assert.deepStrictEqual(r.ids, two); assert.deepStrictEqual(r.err, [])
  })
  it('a 100-element queue is walked whole under the 64-per-pc loop bound (decided advances earn visits per walk)', () => {
    const r = run('synthv/long', { fi: 'consumer', idiom: 'indy', coll: 'java/util/ArrayList', mut: 'add', n: 100 })
    assert.strictEqual(r.ids.length, 100, `claimed ${r.ids.length}: ${r.abst.slice(0, 2).join(' | ')}`)
    assert.ok(r.ids.includes('synthv:p99'))
    assert.deepStrictEqual(r.err, [])
  })
  it('the Function1 (kotlin.jvm.internal.Lambda) idiom over a Deque still follows into the typed invoke body', () => {
    const r = run('synthv/f1deque', { fi: 'f1', idiom: 'lambda', coll: 'java/util/ArrayDeque', mut: 'addLast' })
    assert.deepStrictEqual(r.ids, two); assert.deepStrictEqual(r.err, [])
  })
})
