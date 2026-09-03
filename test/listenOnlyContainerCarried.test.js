/* eslint-env mocha */
// HF15-R rider — listen-only tier (d), the CONTAINER-CARRIED TYPE shape:
// the parameter-slot law of the construction census, pinned against
// synthetic jars built with this lib's own class-file writer.
//
//   1. NEAR-MISS (verifier case 6, was a MEDIUM): a container constructed as
//      (ResourceLocation nonChannel, Type channel, Object) carries its
//      channel in the TYPE parameter; the leading ResourceLocation is some
//      other id (a texture key here). Pre-fix the census took the FIRST
//      Type-or-ResourceLocation parameter, declared `textures/icon` as a
//      listen-only channel and MISSED the real one. Law now: Type-typed
//      parameters win whenever any exist, every one of them walks; a ctor
//      with no Type parameter keeps the first-ResourceLocation behavior.
//   2. TOLERANCE (verifier case 7, documented, unchanged): detection is
//      method-level — a method that holds a clientbound-capable constant
//      registration AND reads a container Type into a SERVERBOUND-only
//      registration makes the container a carrier, so its serverbound-only
//      ids ride listen-only. Listen-only is tolerance (a declared channel
//      the server never sends costs nothing); a send-guard miss is fatal.
//   3. TOLERANCE (verifier case 4, documented, unchanged): invocation owners
//      include every in-index ancestor DECLARING the entry (interfaces), so
//      an id passed to a SIBLING implementer through the interface rides
//      along; a call bound directly to the sibling class does NOT.
//
// Assertions are mechanism-level — no mod names.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { deriveNeoForgeComponents } = require('../src/client/neoForgePayloadDerivation')
const { buildClass, buildJar } = require('./helpers/synthJar')

const EVENT = 'net/neoforged/neoforge/network/event/RegisterPayloadHandlersEvent'
const REG = 'net/neoforged/neoforge/network/registration/PayloadRegistrar'
const TYPE = 'net/minecraft/network/protocol/common/custom/CustomPacketPayload$Type'
const RL = 'net/minecraft/resources/ResourceLocation'
const MAP = 'java/util/Map'
const P = 'synth/cc'
const MODS_TOML = { name: 'META-INF/neoforge.mods.toml', data: Buffer.from('modId="synthcc"\nversion="1.0.0"\n') }
const LMF = { refKind: 6, owner: 'java/lang/invoke/LambdaMetafactory', name: 'metafactory', desc: '(Ljava/lang/invoke/MethodHandles$Lookup;Ljava/lang/String;Ljava/lang/invoke/MethodType;Ljava/lang/invoke/MethodType;Ljava/lang/invoke/MethodHandle;Ljava/lang/invoke/MethodType;)Ljava/lang/invoke/CallSite;' }

function writeJar (entries, label) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hf15r-cc-')), label)
  fs.writeFileSync(p, buildJar(entries))
  return p
}

// payload class: static RL CHANNEL from the two-string factory + static
// channelType() = new Type(CHANNEL)
function payloadWithFactory (name, ns, pathId) {
  return buildClass({
    name,
    fields: [{ name: 'CHANNEL', desc: `L${RL};` }],
    methods: [
      { name: '<clinit>', desc: '()V', flags: 0x0008, code: (a) => a.ldcStr(ns).ldcStr(pathId).invokestatic(RL, 'fromNamespaceAndPath', `(Ljava/lang/String;Ljava/lang/String;)L${RL};`).putstatic(name, 'CHANNEL', `L${RL};`).ret() },
      { name: 'channelType', desc: `()L${TYPE};`, flags: 0x0009, code: (a) => a.new_(TYPE).dup().getstatic(name, 'CHANNEL', `L${RL};`).invokespecial(TYPE, '<init>', `(L${RL};)V`).areturn() }
    ]
  })
}

// container record: ctor of the given descriptor storing the Type at
// parameter slot `typeSlot`, plus the getType() accessor
function containerClass (name, ctorDesc = `(L${TYPE};Ljava/lang/Object;)V`, typeSlot = 1) {
  return buildClass({
    name,
    fields: [{ name: 'type', desc: `L${TYPE};`, flags: 0x0012 }],
    methods: [
      { name: '<init>', desc: ctorDesc, flags: 0x0001, code: (a) => a.aload(0).invokespecial('java/lang/Object', '<init>', '()V').aload(0).aload(typeSlot).putfield(name, 'type', `L${TYPE};`).ret() },
      { name: 'getType', desc: `()L${TYPE};`, flags: 0x0001, code: (a) => a.aload(0).getfield(name, 'type', `L${TYPE};`).areturn() }
    ]
  })
}

// registrar-forwarding handler: register(event) iterates PACKET_MAP via a
// BiConsumer lambda that reads the Type off the container. With
// `extraConstReg` the lambda ALSO holds a constant-typed playToClient and
// feeds the container read into a playToServer (case 7's method-level shape).
function handlerClass (name, container, { flow = 'playBidirectional', extraConstReg = null } = {}) {
  return buildClass({
    name,
    fields: [{ name: 'PACKET_MAP', desc: `L${MAP};`, flags: 0x0010 }],
    bootstrapMethods: [{ ...LMF, owner: name, name: 'lambda$register$0', desc: `(L${EVENT};Ljava/lang/Class;L${container};)V`, refKind: 7 }],
    methods: [
      { name: 'register', desc: `(L${EVENT};)V`, flags: 0x0001, code: (a) => a.aload(0).getfield(name, 'PACKET_MAP', `L${MAP};`).aload(0).aload(1).invokedynamic(0, 'accept', `(L${name};L${EVENT};)Ljava/util/function/BiConsumer;`).invokeinterface(MAP, 'forEach', '(Ljava/util/function/BiConsumer;)V', 2).ret() },
      {
        name: 'lambda$register$0',
        desc: `(L${EVENT};Ljava/lang/Class;L${container};)V`,
        flags: 0x0002,
        code: (a) => {
          a.aload(1).aload(3).invokevirtual(container, 'getType', `()L${TYPE};`).invokevirtual(TYPE, 'id', `()L${RL};`).invokevirtual(RL, 'getNamespace', '()Ljava/lang/String;')
            .invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`).invokevirtual(REG, 'optional', `()L${REG};`)
          if (extraConstReg) {
            a.dup().invokestatic(extraConstReg, 'channelType', `()L${TYPE};`).aconstNull().aconstNull().invokevirtual(REG, 'playToClient', `(L${TYPE};Ljava/lang/Object;Ljava/lang/Object;)L${REG};`).pop()
            a.aload(3).invokevirtual(container, 'getType', `()L${TYPE};`).aconstNull().aconstNull().invokevirtual(REG, 'playToServer', `(L${TYPE};Ljava/lang/Object;Ljava/lang/Object;)L${REG};`).pop().ret()
            return
          }
          a.aload(3).invokevirtual(container, 'getType', `()L${TYPE};`).aconstNull().aconstNull().invokevirtual(REG, flow, `(L${TYPE};Ljava/lang/Object;Ljava/lang/Object;)L${REG};`).pop().ret()
        }
      }
    ]
  })
}

// static entry point: Api.registerPacket(<ctorArgs>) -> QUEUED.put(new Container(<ctorArgs>))
function apiClass (name, container, ctorDesc, argSlots) {
  return buildClass({
    name,
    fields: [{ name: 'QUEUED', desc: `L${MAP};` }],
    methods: [
      { name: '<clinit>', desc: '()V', flags: 0x0008, code: (a) => a.new_('java/util/HashMap').dup().invokespecial('java/util/HashMap', '<init>', '()V').putstatic(name, 'QUEUED', `L${MAP};`).ret() },
      {
        name: 'registerPacket',
        desc: ctorDesc,
        flags: 0x0009,
        code: (a) => {
          a.getstatic(name, 'QUEUED', `L${MAP};`).aload(argSlots[argSlots.length - 1]).new_(container).dup()
          for (const s of argSlots) a.aload(s)
          return a.invokespecial(container, '<init>', ctorDesc).invokeinterface(MAP, 'put', '(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;', argSlots.length + 1).pop().ret()
        }
      }
    ]
  })
}

const derive = (entries, label) => deriveNeoForgeComponents([writeJar([MODS_TOML, ...entries], label)])

describe('HF15-R rider: container-carried Type — construction-census parameter-slot law', function () {
  it('near-miss: (ResourceLocation nonChannel, Type channel, Object) ctor declares the TYPE parameter, never the leading ResourceLocation', function () {
    const desc = `(L${RL};L${TYPE};Ljava/lang/Object;)V`
    const init = buildClass({ name: `${P}/Init`, methods: [{ name: 'init', desc: '()V', flags: 0x0009, code: (a) => a.ldcStr('synthcc').ldcStr('textures/icon').invokestatic(RL, 'fromNamespaceAndPath', `(Ljava/lang/String;Ljava/lang/String;)L${RL};`).invokestatic(`${P}/PingA`, 'channelType', `()L${TYPE};`).aconstNull().invokestatic(`${P}/Api`, 'registerPacket', desc).ret() }] })
    const r = derive([
      { name: `${P}/Container.class`, data: containerClass(`${P}/Container`, desc, 2) },
      { name: `${P}/Api.class`, data: apiClass(`${P}/Api`, `${P}/Container`, desc, [0, 1, 2]) },
      { name: `${P}/Handler.class`, data: handlerClass(`${P}/Handler`, `${P}/Container`) },
      { name: `${P}/PingA.class`, data: payloadWithFactory(`${P}/PingA`, 'synthcc', 'real_ping') },
      { name: `${P}/Init.class`, data: init }
    ], 'synthcc-nearmiss-1.0.jar')
    assert.deepStrictEqual(r.listenOnly, ['synthcc:real_ping'], 'the channel rides; the texture key does not')
    assert.strictEqual(r.components.play.length + r.components.configuration.length, 0, 'nothing is claimed')
    assert.deepStrictEqual(r.diagnostics.errors, [])
    assert.ok((r.diagnostics.listenOnlyNotes || []).some((n) => /container-carried Type synth\/cc\/Container \(playBidirectional\): 1 id\(s\) resolved/.test(n)), JSON.stringify(r.diagnostics.listenOnlyNotes))
  })

  it('several Type parameters: every one walks (never a single guessed slot)', function () {
    const desc = `(L${TYPE};L${TYPE};Ljava/lang/Object;)V`
    const init = buildClass({ name: `${P}/Init`, methods: [{ name: 'init', desc: '()V', flags: 0x0009, code: (a) => a.invokestatic(`${P}/PingA`, 'channelType', `()L${TYPE};`).invokestatic(`${P}/PingB`, 'channelType', `()L${TYPE};`).aconstNull().invokestatic(`${P}/Api`, 'registerPacket', desc).ret() }] })
    const r = derive([
      { name: `${P}/Container.class`, data: containerClass(`${P}/Container`, desc, 1) },
      { name: `${P}/Api.class`, data: apiClass(`${P}/Api`, `${P}/Container`, desc, [0, 1, 2]) },
      { name: `${P}/Handler.class`, data: handlerClass(`${P}/Handler`, `${P}/Container`) },
      { name: `${P}/PingA.class`, data: payloadWithFactory(`${P}/PingA`, 'synthcc', 'first_type') },
      { name: `${P}/PingB.class`, data: payloadWithFactory(`${P}/PingB`, 'synthcc', 'second_type') },
      { name: `${P}/Init.class`, data: init }
    ], 'synthcc-twotypes-1.0.jar')
    assert.deepStrictEqual(r.listenOnly, ['synthcc:first_type', 'synthcc:second_type'])
    assert.deepStrictEqual(r.diagnostics.errors, [])
  })

  it('no Type parameter: the first ResourceLocation parameter keeps carrying (the (RL, …) ctor idiom)', function () {
    const desc = `(L${RL};Ljava/lang/Object;)V`
    // container builds `new Type(rl)` from its RL parameter
    const cont = buildClass({
      name: `${P}/Container`,
      fields: [{ name: 'type', desc: `L${TYPE};`, flags: 0x0012 }],
      methods: [
        { name: '<init>', desc, flags: 0x0001, code: (a) => a.aload(0).invokespecial('java/lang/Object', '<init>', '()V').aload(0).new_(TYPE).dup().aload(1).invokespecial(TYPE, '<init>', `(L${RL};)V`).putfield(`${P}/Container`, 'type', `L${TYPE};`).ret() },
        { name: 'getType', desc: `()L${TYPE};`, flags: 0x0001, code: (a) => a.aload(0).getfield(`${P}/Container`, 'type', `L${TYPE};`).areturn() }
      ]
    })
    const init = buildClass({ name: `${P}/Init`, methods: [{ name: 'init', desc: '()V', flags: 0x0009, code: (a) => a.getstatic(`${P}/PingA`, 'CHANNEL', `L${RL};`).aconstNull().invokestatic(`${P}/Api`, 'registerPacket', desc).ret() }] })
    const r = derive([
      { name: `${P}/Container.class`, data: cont },
      { name: `${P}/Api.class`, data: apiClass(`${P}/Api`, `${P}/Container`, desc, [0, 1]) },
      { name: `${P}/Handler.class`, data: handlerClass(`${P}/Handler`, `${P}/Container`) },
      { name: `${P}/PingA.class`, data: payloadWithFactory(`${P}/PingA`, 'synthcc', 'rl_carried') },
      { name: `${P}/Init.class`, data: init }
    ], 'synthcc-rlonly-1.0.jar')
    assert.deepStrictEqual(r.listenOnly, ['synthcc:rl_carried'])
    assert.deepStrictEqual(r.diagnostics.errors, [])
  })

  it('tolerance (documented): method-level detection lets a serverbound-only container id ride listen-only beside a constant clientbound registration', function () {
    const desc = `(L${TYPE};Ljava/lang/Object;)V`
    const init = buildClass({ name: `${P}/Init`, methods: [{ name: 'init', desc: '()V', flags: 0x0009, code: (a) => a.invokestatic(`${P}/PingS`, 'channelType', `()L${TYPE};`).aconstNull().invokestatic(`${P}/Api`, 'registerPacket', desc).ret() }] })
    const r = derive([
      { name: `${P}/Container.class`, data: containerClass(`${P}/Container`) },
      { name: `${P}/Api.class`, data: apiClass(`${P}/Api`, `${P}/Container`, desc, [0, 1]) },
      { name: `${P}/Handler.class`, data: handlerClass(`${P}/Handler`, `${P}/Container`, { extraConstReg: `${P}/PingC` }) },
      { name: `${P}/PingC.class`, data: payloadWithFactory(`${P}/PingC`, 'synthcc', 'const_clientbound') },
      { name: `${P}/PingS.class`, data: payloadWithFactory(`${P}/PingS`, 'synthcc', 'serverbound_only') },
      { name: `${P}/Init.class`, data: init }
    ], 'synthcc-s2c-1.0.jar')
    // the constant clientbound id: unclaimed (no version) → named abstain → listen-only (tier a)
    assert.ok(r.listenOnly.includes('synthcc:const_clientbound'))
    // the tolerance: the serverbound-only container id rides too — over-inclusion, never a miss
    assert.ok(r.listenOnly.includes('synthcc:serverbound_only'), JSON.stringify(r.listenOnly))
    assert.strictEqual(r.components.play.length, 0, 'nothing claimed')
    assert.deepStrictEqual(r.diagnostics.errors, [])
  })

  it('tolerance (documented): an interface-declared entry over-includes a sibling implementer\'s id when called THROUGH the interface, never when bound directly to the sibling', function () {
    const IF = `${P}/Registrar`
    const regDesc = `(L${TYPE};)V`
    const apiDesc = `(L${TYPE};Ljava/lang/Object;)V`
    const iface = buildClass({ name: IF, methods: [{ name: 'reg', desc: regDesc, flags: 0x0401, code: (a) => a.ret() }] })
    const delayed = buildClass({ name: `${P}/Delayed`, interfaces: [IF], fields: [{ name: 'I', desc: `L${P}/Delayed;` }], methods: [{ name: 'reg', desc: regDesc, flags: 0x0001, code: (a) => a.aload(1).aconstNull().invokestatic(`${P}/Api`, 'registerPacket', apiDesc).ret() }] })
    const other = buildClass({ name: `${P}/Other`, interfaces: [IF], fields: [{ name: 'I', desc: `L${P}/Other;` }], methods: [{ name: 'reg', desc: regDesc, flags: 0x0001, code: (a) => a.ret() }] })
    const initCode = (a) => a
      .getstatic(`${P}/Delayed`, 'I', `L${P}/Delayed;`).invokestatic(`${P}/PingA`, 'channelType', `()L${TYPE};`).invokevirtual(`${P}/Delayed`, 'reg', regDesc)
      .getstatic(`${P}/Other`, 'I', `L${P}/Other;`).invokestatic(`${P}/PingX`, 'channelType', `()L${TYPE};`).invokeinterface(IF, 'reg', regDesc, 2)
      .getstatic(`${P}/Other`, 'I', `L${P}/Other;`).invokestatic(`${P}/PingY`, 'channelType', `()L${TYPE};`).invokevirtual(`${P}/Other`, 'reg', regDesc).ret()
    const init = buildClass({ name: `${P}/Init`, methods: [{ name: 'init', desc: '()V', flags: 0x0009, code: initCode }] })
    const r = derive([
      { name: `${P}/Container.class`, data: containerClass(`${P}/Container`) },
      { name: `${P}/Api.class`, data: apiClass(`${P}/Api`, `${P}/Container`, apiDesc, [0, 1]) },
      { name: `${P}/Handler.class`, data: handlerClass(`${P}/Handler`, `${P}/Container`) },
      { name: `${IF}.class`, data: iface },
      { name: `${P}/Delayed.class`, data: delayed },
      { name: `${P}/Other.class`, data: other },
      { name: `${P}/PingA.class`, data: payloadWithFactory(`${P}/PingA`, 'synthcc', 'real_ping') },
      { name: `${P}/PingX.class`, data: payloadWithFactory(`${P}/PingX`, 'synthcc', 'sibling_via_iface') },
      { name: `${P}/PingY.class`, data: payloadWithFactory(`${P}/PingY`, 'synthcc', 'sibling_direct') },
      { name: `${P}/Init.class`, data: init }
    ], 'synthcc-iface-1.0.jar')
    assert.deepStrictEqual(r.listenOnly, ['synthcc:real_ping', 'synthcc:sibling_via_iface'], 'the real id + the interface-routed sibling id; the directly-bound sibling id stays out')
    assert.deepStrictEqual(r.diagnostics.errors, [])
  })
})
