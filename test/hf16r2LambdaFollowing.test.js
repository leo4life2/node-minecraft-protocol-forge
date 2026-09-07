/* eslint-env mocha */
// HF16-R2 — the QUEUE-DEFERRED registration idiom (javap-verified on a Kotlin
// pack, NeoForge 21.1.227; 58 required play channels derived as ZERO):
//   the entry iterates a static collection on its OWN class
//     (`object Events { val queue = ArrayList<(PayloadRegistrar) -> Unit>() }`)
//   populated from ANOTHER class through the object's getter with a lambda
//   VALUE — an invokedynamic (Kotlin 2.x / javac) or a `kotlin.jvm.internal.Lambda`
//   subclass (Kotlin < 2.0) — that captures the producer's PARAMETER; the
//   producer is reached through a base-class helper the packet initializer's
//   SUBCLASS calls with `new Packet()` (`invokevirtual Packets.register`, the
//   owner being the subclass, JVMS §5.4.3.3); the id lives on the packet
//   (`new Type(getId())`, the field set in <init> from a namespace helper).
// Mechanism-level fixtures (no mod names): the deriver must follow the lambda
// value from the queue into its body with the registrar bound, populate the
// queue from the producer under its resolved caller contexts, and — when no
// caller binds the packet — abstain loudly naming the site, never claim.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildClass, buildJar } = require('./helpers/synthJar')
const { deriveNeoForgeComponents } = require('../src/client/neoForgePayloadDerivation')

const EVENT = 'net/neoforged/neoforge/network/event/RegisterPayloadHandlersEvent'
const REG = 'net/neoforged/neoforge/network/registration/PayloadRegistrar'
const TYPE = 'net/minecraft/network/protocol/common/custom/CustomPacketPayload$Type'
const RL = 'net/minecraft/resources/ResourceLocation'
const CODEC = 'net/minecraft/network/codec/StreamCodec'
const HANDLER = 'net/neoforged/neoforge/network/handling/IPayloadHandler'
const F1 = 'kotlin/jvm/functions/Function1'
const KLAMBDA = 'kotlin/jvm/internal/Lambda'
const REG_DESC = `(L${TYPE};L${CODEC};L${HANDLER};)L${REG};`
const LIST = 'java/util/List'
const ITER = 'java/util/Iterator'

// the entry class: a Kotlin-object shape — INSTANCE + a private static queue
// built in <clinit>, a straight-line getter, and the event listener that
// walks the queue invoking each Function1 with the registrar.
function eventsClass (P) {
  const name = `${P}/Events`
  return buildClass({
    name,
    fields: [
      { name: 'INSTANCE', desc: `L${name};`, flags: 0x0019 },
      { name: 'queue', desc: `L${LIST};`, flags: 0x001a }
    ],
    methods: [
      { name: '<init>', desc: '()V', flags: 0x0002, code: (a) => a.aload(0).invokespecial('java/lang/Object', '<init>', '()V').ret() },
      { name: 'getQueue', desc: `()L${LIST};`, flags: 0x0011, code: (a) => a.getstatic(name, 'queue', `L${LIST};`).areturn() },
      {
        name: 'register',
        desc: `(L${EVENT};)V`,
        flags: 0x0019,
        code: (a) => a
          .aload(0).ldcStr('1').invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`).astore(1) // 0..6
          .getstatic(name, 'INSTANCE', `L${name};`).pop() // 7..10
          .getstatic(name, 'queue', `L${LIST};`).invokeinterface(LIST, 'iterator', `()L${ITER};`, 1).astore(2) // 11..19
          .aload(2).invokeinterface(ITER, 'hasNext', '()Z', 1).ifeq(24) // 20..28 -> 50
          .aload(2).invokeinterface(ITER, 'next', '()Ljava/lang/Object;', 1).checkcast(F1).astore(3) // 29..38
          .aload(3).aload(1).invokeinterface(F1, 'invoke', '(Ljava/lang/Object;)Ljava/lang/Object;', 2).pop() // 39..46
          .goto_(-27) // 47 -> 20
          .ret() // 50
      },
      {
        name: '<clinit>',
        desc: '()V',
        flags: 0x0008,
        code: (a) => a
          .new_(name).dup().invokespecial(name, '<init>', '()V').putstatic(name, 'INSTANCE', `L${name};`)
          .new_('java/util/ArrayList').dup().invokespecial('java/util/ArrayList', '<init>', '()V').checkcast(LIST).putstatic(name, 'queue', `L${LIST};`)
          .ret()
      }
    ]
  })
}

// the producer: registerPacket(P) queues a lambda capturing (P, this) whose
// body registers P.type() on the registrar it receives. `indy` = Kotlin 2.x
// invokedynamic; otherwise a kotlin.jvm.internal.Lambda subclass instance.
function implClasses (P, { indy = true } = {}) {
  const name = `${P}/Impl`
  const events = `${P}/Events`
  const base = `${P}/BasePacket`
  const lam = `${P}/Impl$registerPacket$1`
  const out = []
  if (indy) {
    out.push({
      name: `${name}.class`,
      data: buildClass({
        name,
        bootstrapMethods: [{ refKind: 6, owner: name, name: 'registerPacket$lambda$0', desc: `(L${base};L${name};L${REG};)Ljava/lang/Object;` }],
        methods: [
          { name: '<init>', desc: '()V', flags: 0x0001, code: (a) => a.aload(0).invokespecial('java/lang/Object', '<init>', '()V').ret() },
          { name: 'get', desc: `()L${name};`, flags: 0x0009, code: (a) => a.new_(name).dup().invokespecial(name, '<init>', '()V').areturn() },
          {
            name: 'registerPacket',
            desc: `(L${base};)L${base};`,
            flags: 0x0001,
            code: (a) => a
              .getstatic(events, 'INSTANCE', `L${events};`).invokevirtual(events, 'getQueue', `()L${LIST};`)
              .aload(1).aload(0).invokedynamic(0, 'invoke', `(L${base};L${name};)L${F1};`)
              .invokeinterface(LIST, 'add', '(Ljava/lang/Object;)Z', 2).pop()
              .aload(1).areturn()
          },
          {
            name: 'registerPacket$lambda$0',
            desc: `(L${base};L${name};L${REG};)Ljava/lang/Object;`,
            flags: 0x100a,
            code: (a) => a
              .aload(2).aload(0).invokevirtual(base, 'type', `()L${TYPE};`).aconstNull().aconstNull()
              .invokevirtual(REG, 'playBidirectional', REG_DESC).pop()
              .aconstNull().areturn()
          }
        ]
      })
    })
  } else {
    out.push({
      name: `${name}.class`,
      data: buildClass({
        name,
        methods: [
          { name: '<init>', desc: '()V', flags: 0x0001, code: (a) => a.aload(0).invokespecial('java/lang/Object', '<init>', '()V').ret() },
          { name: 'get', desc: `()L${name};`, flags: 0x0009, code: (a) => a.new_(name).dup().invokespecial(name, '<init>', '()V').areturn() },
          {
            name: 'registerPacket',
            desc: `(L${base};)L${base};`,
            flags: 0x0001,
            code: (a) => a
              .getstatic(events, 'INSTANCE', `L${events};`).invokevirtual(events, 'getQueue', `()L${LIST};`)
              .new_(lam).dup().aload(1).invokespecial(lam, '<init>', `(L${base};)V`)
              .invokeinterface(LIST, 'add', '(Ljava/lang/Object;)Z', 2).pop()
              .aload(1).areturn()
          }
        ]
      })
    })
    out.push({
      name: `${lam}.class`,
      data: buildClass({
        name: lam,
        superName: KLAMBDA,
        interfaces: [F1],
        fields: [{ name: '$packet', desc: `L${base};`, flags: 0x1012 }],
        methods: [
          { name: '<init>', desc: `(L${base};)V`, flags: 0x0000, code: (a) => a.aload(0).aload(1).putfield(lam, '$packet', `L${base};`).aload(0).iconst(1).invokespecial(KLAMBDA, '<init>', '(I)V').ret() },
          {
            name: 'invoke',
            desc: `(L${REG};)Lkotlin/Unit;`,
            flags: 0x0011,
            code: (a) => a
              .aload(1).aload(0).getfield(lam, '$packet', `L${base};`).invokevirtual(base, 'type', `()L${TYPE};`).aconstNull().aconstNull()
              .invokevirtual(REG, 'playToClient', REG_DESC).pop()
              .aconstNull().areturn()
          },
          { name: 'invoke', desc: '(Ljava/lang/Object;)Ljava/lang/Object;', flags: 0x1041, code: (a) => a.aload(0).aload(1).checkcast(REG).invokevirtual(lam, 'invoke', `(L${REG};)Lkotlin/Unit;`).areturn() }
        ]
      })
    })
  }
  return out
}

// packets: an abstract base building its Type from the subclass id; two
// concrete packets whose id is set in <init> from a (String)->RL helper.
function packetClasses (P, ids) {
  const base = `${P}/BasePacket`
  const helper = `${P}/Ids`
  const out = [
    {
      name: `${base}.class`,
      data: buildClass({
        name: base,
        methods: [
          { name: '<init>', desc: '()V', flags: 0x0001, code: (a) => a.aload(0).invokespecial('java/lang/Object', '<init>', '()V').ret() },
          { name: 'getId', desc: `()L${RL};`, flags: 0x0001, code: (a) => a.aconstNull().areturn() }, // overridden by every packet
          { name: 'getPacketType', desc: `()L${TYPE};`, flags: 0x0014, code: (a) => a.new_(TYPE).dup().aload(0).invokevirtual(base, 'getId', `()L${RL};`).invokespecial(TYPE, '<init>', `(L${RL};)V`).areturn() },
          { name: 'type', desc: `()L${TYPE};`, flags: 0x0001, code: (a) => a.aload(0).invokevirtual(base, 'getPacketType', `()L${TYPE};`).areturn() }
        ]
      })
    },
    {
      name: `${helper}.class`,
      data: buildClass({
        name: helper,
        methods: [{ name: 'id', desc: `(Ljava/lang/String;)L${RL};`, flags: 0x0009, code: (a) => a.ldcStr('synthq').aload(0).invokestatic(RL, 'fromNamespaceAndPath', `(Ljava/lang/String;Ljava/lang/String;)L${RL};`).areturn() }]
      })
    }
  ]
  for (const [cls, id] of ids) {
    out.push({
      name: `${cls}.class`,
      data: buildClass({
        name: cls,
        superName: base,
        fields: [{ name: 'id', desc: `L${RL};`, flags: 0x0012 }],
        methods: [
          { name: '<init>', desc: '()V', flags: 0x0001, code: (a) => a.aload(0).invokespecial(base, '<init>', '()V').aload(0).ldcStr(id).invokestatic(helper, 'id', `(Ljava/lang/String;)L${RL};`).putfield(cls, 'id', `L${RL};`).ret() },
          { name: 'getId', desc: `()L${RL};`, flags: 0x0001, code: (a) => a.aload(0).getfield(cls, 'id', `L${RL};`).areturn() }
        ]
      })
    })
  }
  return out
}

// the initializer chain: a base helper register(P) -> Impl.get().registerPacket(P)
// and a SUBCLASS whose <init> does `new Packet(); this.register(p)` with the
// invokevirtual owner being the subclass itself.
function initClasses (P, packets) {
  const init = `${P}/Init`
  const packetsCls = `${P}/Packets`
  const base = `${P}/BasePacket`
  const impl = `${P}/Impl`
  return [
    {
      name: `${init}.class`,
      data: buildClass({
        name: init,
        methods: [
          { name: '<init>', desc: '()V', flags: 0x0001, code: (a) => a.aload(0).invokespecial('java/lang/Object', '<init>', '()V').ret() },
          { name: 'register', desc: `(L${base};)L${base};`, flags: 0x0014, code: (a) => a.invokestatic(impl, 'get', `()L${impl};`).aload(1).invokevirtual(impl, 'registerPacket', `(L${base};)L${base};`).areturn() }
        ]
      })
    },
    {
      name: `${packetsCls}.class`,
      data: buildClass({
        name: packetsCls,
        superName: init,
        fields: [{ name: 'INSTANCE', desc: `L${packetsCls};`, flags: 0x0019 }],
        methods: [
          {
            name: '<init>',
            desc: '()V',
            flags: 0x0002,
            code: (a) => {
              a.aload(0).invokespecial(init, '<init>', '()V')
              for (const cls of packets) a.aload(0).new_(cls).dup().invokespecial(cls, '<init>', '()V').invokevirtual(packetsCls, 'register', `(L${base};)L${base};`).pop()
              return a.ret()
            }
          },
          { name: '<clinit>', desc: '()V', flags: 0x0008, code: (a) => a.new_(packetsCls).dup().invokespecial(packetsCls, '<init>', '()V').putstatic(packetsCls, 'INSTANCE', `L${packetsCls};`).ret() }
        ]
      })
    }
  ]
}

function queueJar (P, { indy = true, withInitializer = true, extraProducers = 0 } = {}) {
  const ids = [[`${P}/AlphaPacket`, 'alpha'], [`${P}/BetaPacket`, 'beta']]
  const entries = [
    { name: 'META-INF/neoforge.mods.toml', data: Buffer.from('[[mods]]\nmodId="synthq"\nversion="9.9.9"\n') },
    { name: `${P}/Events.class`, data: eventsClass(P) },
    ...implClasses(P, { indy }),
    ...packetClasses(P, ids)
  ]
  if (withInitializer) entries.push(...initClasses(P, ids.map(([c]) => c)))
  for (let i = 0; i < extraProducers; i++) {
    const name = `${P}/Prod${i}`
    entries.push({
      name: `${name}.class`,
      data: buildClass({
        name,
        methods: [{ name: 'p', desc: '()V', flags: 0x0009, code: (a) => a.getstatic(`${P}/Events`, 'queue', `L${LIST};`).aconstNull().invokeinterface(LIST, 'add', '(Ljava/lang/Object;)Z', 2).pop().ret() }]
      })
    })
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthjar-hf16r2-'))
  const jar = path.join(dir, 'queue.jar')
  fs.writeFileSync(jar, buildJar(entries))
  return jar
}

const claims = (r) => r.components.play.map((c) => [c.id, c.version, c.flow, c.optional]).sort()

describe('HF16-R2 lambda following (queue-deferred registration)', function () {
  it('invokedynamic idiom: a queued Kotlin-2.x lambda capturing the producer parameter registers every packet the subclass initializer constructs, with the entry\'s constant version', () => {
    const r = deriveNeoForgeComponents([queueJar('synth/qi')])
    assert.deepStrictEqual(claims(r), [['synthq:alpha', '1', null, false], ['synthq:beta', '1', null, false]])
    assert.deepStrictEqual(r.diagnostics.abstains, [], 'no override-bound / unresolved-id abstain against channels that are claimed')
    assert.deepStrictEqual(r.diagnostics.errors, [])
  })

  it('Function1 idiom: a queued kotlin.jvm.internal.Lambda subclass (Kotlin < 2.0) is followed through its bridge into the typed invoke body', () => {
    const r = deriveNeoForgeComponents([queueJar('synth/ql', { indy: false })])
    assert.deepStrictEqual(claims(r), [['synthq:alpha', '1', 'clientbound', false], ['synthq:beta', '1', 'clientbound', false]])
    assert.deepStrictEqual(r.diagnostics.abstains, [])
    assert.deepStrictEqual(r.diagnostics.errors, [])
  })

  it('honest stop: a producer no caller binds queues an unresolvable packet — the site is named, nothing is claimed', () => {
    const r = deriveNeoForgeComponents([queueJar('synth/qn', { withInitializer: false })])
    assert.deepStrictEqual(claims(r), [])
    assert.ok(r.diagnostics.abstains.some((a) => a.startsWith('synth/qn/Impl') && a.includes('playBidirectional with unresolved payload type id')), r.diagnostics.abstains.join(' | '))
  })

  it('bound: more than 64 population sites for one registry abstain loudly and the walked producers still claim', () => {
    const r = deriveNeoForgeComponents([queueJar('synth/qb', { extraProducers: 70 })])
    assert.ok(r.diagnostics.abstains.some((a) => a.includes('more than 64 population sites')), r.diagnostics.abstains.join(' | '))
  })
})
