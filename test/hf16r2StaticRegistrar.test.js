/* eslint-env mocha */
// HF16-R2 rider — the STATIC-REGISTRAR shape (javap-verified on geckolib
// 4.9.2 NeoForge, rig 2026-09-06): the payload-handlers listener is a lambda
// registered from a plain `init(IEventBus)` (`bus.addListener(X::onRegister)`)
// — so the class has NO entry method that encloses it — and it does nothing
// but store `event.registrar("x").optional()` in a STATIC FIELD and call a
// static interface initializer, which registers every packet through the
// service implementation reading that field. Before this rider the class
// derived ZERO channels with ZERO abstains (the lambda entry was skipped as
// "its enclosing entry reports for it"), the client claimed nothing, and the
// SERVER crashed the moment it broadcast the mod's unguarded optional payload
// to the unclaimed client (`Payload x:y may not be sent to the client!` —
// a ticking-entity crash, NetworkRegistry.checkPacket).
// A second mechanism pinned here: an invokestatic against an interface that
// has a services file (a static interface method) must NOT dispatch to the
// service implementation as if it had a receiver — doing so shifted every
// argument by one slot (the Type became the service object).
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
const BUS = 'net/neoforged/bus/api/IEventBus'
const REG_DESC = `(L${TYPE};L${CODEC};L${HANDLER};)L${REG};`
const P = 'synth/sr'
const NET = `${P}/Networking` // the service interface (static init + static registerPacket)
const IMPL = `${P}/NetworkingNeoForge` // the service implementation holding the static registrar
const SERVICES = `${P}/Services` // holds the ServiceLoader-resolved instance
const PKT_A = `${P}/AnimPacket`
const PKT_B = `${P}/SyncPacket`
const IDS = `${P}/Ids`

function packet (cls, id) {
  return buildClass({
    name: cls,
    fields: [{ name: 'TYPE', desc: `L${TYPE};`, flags: 0x0019 }, { name: 'CODEC', desc: `L${CODEC};`, flags: 0x0019 }],
    methods: [{
      name: '<clinit>',
      desc: '()V',
      flags: 0x0008,
      code: (a) => a.new_(TYPE).dup().ldcStr(id).invokestatic(IDS, 'id', `(Ljava/lang/String;)L${RL};`).invokespecial(TYPE, '<init>', `(L${RL};)V`).putstatic(cls, 'TYPE', `L${TYPE};`)
        .aconstNull().putstatic(cls, 'CODEC', `L${CODEC};`).ret()
    }]
  })
}

function staticRegistrarJar ({ clientBound = true } = {}) {
  const ids = buildClass({
    name: IDS,
    methods: [{ name: 'id', desc: `(Ljava/lang/String;)L${RL};`, flags: 0x0009, code: (a) => a.ldcStr('synthsr').aload(0).invokestatic(RL, 'fromNamespaceAndPath', `(Ljava/lang/String;Ljava/lang/String;)L${RL};`).areturn() }]
  })
  // the interface: static init() registers each packet's static TYPE/CODEC via
  // the static registerPacket(Type, codec, boolean) which dispatches to the
  // service instance's registerPacketInternal.
  const net = buildClass({
    name: NET,
    flags: 0x0601,
    methods: [
      {
        name: 'init',
        desc: '()V',
        flags: 0x0009,
        code: (a) => a
          .getstatic(PKT_A, 'TYPE', `L${TYPE};`).getstatic(PKT_A, 'CODEC', `L${CODEC};`).iconst(clientBound ? 1 : 0).invokestaticItf(NET, 'registerPacket', `(L${TYPE};L${CODEC};Z)V`)
          .getstatic(PKT_B, 'TYPE', `L${TYPE};`).getstatic(PKT_B, 'CODEC', `L${CODEC};`).iconst(clientBound ? 1 : 0).invokestaticItf(NET, 'registerPacket', `(L${TYPE};L${CODEC};Z)V`)
          .ret()
      },
      {
        name: 'registerPacket',
        desc: `(L${TYPE};L${CODEC};Z)V`,
        flags: 0x0009,
        code: (a) => a.getstatic(SERVICES, 'NETWORK', `L${NET};`).aload(0).aload(1).iload(2).invokeinterface(NET, 'registerPacketInternal', `(L${TYPE};L${CODEC};Z)V`, 4).ret()
      }
    ]
  })
  const services = buildClass({ name: SERVICES, fields: [{ name: 'NETWORK', desc: `L${NET};`, flags: 0x0019 }], methods: [] })
  const impl = buildClass({
    name: IMPL,
    interfaces: [NET],
    fields: [{ name: 'registrar', desc: `L${REG};`, flags: 0x000a }],
    bootstrapMethods: [{ refKind: 6, owner: IMPL, name: 'lambda$init$0', desc: `(L${EVENT};)V` }],
    methods: [
      { name: '<init>', desc: '()V', flags: 0x0001, code: (a) => a.aload(0).invokespecial('java/lang/Object', '<init>', '()V').ret() },
      // init(IEventBus): NOT an entry (no event in its descriptor) — it only registers the lambda listener
      { name: 'init', desc: `(L${BUS};)V`, flags: 0x0009, code: (a) => a.aload(0).invokedynamic(0, 'accept', '()Ljava/util/function/Consumer;').invokeinterface(BUS, 'addListener', '(Ljava/util/function/Consumer;)V', 2).ret() },
      {
        name: 'registerPacketInternal',
        desc: `(L${TYPE};L${CODEC};Z)V`,
        flags: 0x0001,
        code: (a) => a
          .iload(3).ifeq(14) // 0..3 -> 15
          .getstatic(IMPL, 'registrar', `L${REG};`).aload(1).aload(2).aconstNull().invokevirtual(REG, 'playToClient', REG_DESC).pop().ret() // 4..14
          .getstatic(IMPL, 'registrar', `L${REG};`).aload(1).aload(2).aconstNull().invokevirtual(REG, 'playToServer', REG_DESC).pop().ret() // 15..25
      },
      {
        name: 'lambda$init$0',
        desc: `(L${EVENT};)V`,
        flags: 0x100a,
        code: (a) => a
          .aload(0).ldcStr('synthsr').invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`).invokevirtual(REG, 'optional', `()L${REG};`).putstatic(IMPL, 'registrar', `L${REG};`)
          .invokestaticItf(NET, 'init', '()V')
          .ret()
      }
    ]
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthjar-hf16r2-sr-'))
  const jar = path.join(dir, 'sr.jar')
  fs.writeFileSync(jar, buildJar([
    { name: 'META-INF/neoforge.mods.toml', data: Buffer.from('[[mods]]\nmodId="synthsr"\nversion="4.9.2"\n') },
    { name: `META-INF/services/${NET.replace(/\//g, '.')}`, data: Buffer.from(`${IMPL.replace(/\//g, '.')}\n`) },
    { name: `${IDS}.class`, data: ids },
    { name: `${NET}.class`, data: net },
    { name: `${SERVICES}.class`, data: services },
    { name: `${IMPL}.class`, data: impl },
    { name: `${PKT_A}.class`, data: packet(PKT_A, 'anim') },
    { name: `${PKT_B}.class`, data: packet(PKT_B, 'sync') }
  ]))
  return jar
}

const claims = (r) => r.components.play.map((c) => [c.id, c.version, c.flow, c.optional]).sort()

describe('HF16-R2 rider: static-registrar shape', function () {
  it('a lambda listener with no enclosing entry stores the optional registrar in a static field; the static interface initializer registers every packet through the service implementation — claimed with the entry\'s own version, optional', () => {
    const r = deriveNeoForgeComponents([staticRegistrarJar()])
    assert.deepStrictEqual(claims(r), [['synthsr:anim', 'synthsr', 'clientbound', true], ['synthsr:sync', 'synthsr', 'clientbound', true]])
    assert.deepStrictEqual(r.diagnostics.abstains, [])
    assert.deepStrictEqual(r.diagnostics.errors, [])
  })

  it('the boolean flow switch decides on the call-site constant (serverbound arm)', () => {
    const r = deriveNeoForgeComponents([staticRegistrarJar({ clientBound: false })])
    assert.deepStrictEqual(claims(r), [['synthsr:anim', 'synthsr', 'serverbound', true], ['synthsr:sync', 'synthsr', 'serverbound', true]])
    assert.deepStrictEqual(r.diagnostics.abstains, [])
  })
})
