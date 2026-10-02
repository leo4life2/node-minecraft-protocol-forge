// HF73b r2 THE ABSENCE FIXTURE (the verify r1 HIGH): a library whose handler
// registers, at the event, every payload Type queued in its container map,
// and a MOD that populates that map through the library's API. The library's
// listen-only derivation resolves the population sites PACK-WIDE - with no
// such mod in the pack it finds none (an empty answer that is true), and the
// mod ADDED later changes the library's answer without touching the library.
const fs = require('fs')
const path = require('path')
const { buildClass, buildJar } = require('./synthJar')

const EVENT = 'net/neoforged/neoforge/network/event/RegisterPayloadHandlersEvent'
const REG = 'net/neoforged/neoforge/network/registration/PayloadRegistrar'
const TYPE = 'net/minecraft/network/protocol/common/custom/CustomPacketPayload$Type'
const RL = 'net/minecraft/resources/ResourceLocation'
const MAP = 'java/util/Map'
const LMF = { refKind: 6, owner: 'java/lang/invoke/LambdaMetafactory', name: 'metafactory', desc: '(Ljava/lang/invoke/MethodHandles$Lookup;Ljava/lang/String;Ljava/lang/invoke/MethodType;Ljava/lang/invoke/MethodType;Ljava/lang/invoke/MethodHandle;Ljava/lang/invoke/MethodType;)Ljava/lang/invoke/CallSite;' }
const BOX = 'synth/box'
const CC = 'synth/cc'
const CTOR_DESC = `(L${TYPE};Ljava/lang/Object;)V`

// the library: Container(type, handler) records; Api.registerPacket queues a Container; Handler.register(event) walks the queue and registers each Type
function containerLibJar (dir) {
  const container = buildClass({
    name: `${BOX}/Container`,
    fields: [{ name: 'type', desc: `L${TYPE};`, flags: 0x0012 }],
    methods: [
      { name: '<init>', desc: CTOR_DESC, flags: 0x0001, code: (a) => a.aload(0).invokespecial('java/lang/Object', '<init>', '()V').aload(0).aload(1).putfield(`${BOX}/Container`, 'type', `L${TYPE};`).ret() },
      { name: 'getType', desc: `()L${TYPE};`, flags: 0x0001, code: (a) => a.aload(0).getfield(`${BOX}/Container`, 'type', `L${TYPE};`).areturn() }
    ]
  })
  const api = buildClass({
    name: `${BOX}/Api`,
    fields: [{ name: 'QUEUED', desc: `L${MAP};` }],
    methods: [
      { name: '<clinit>', desc: '()V', flags: 0x0008, code: (a) => a.new_('java/util/HashMap').dup().invokespecial('java/util/HashMap', '<init>', '()V').putstatic(`${BOX}/Api`, 'QUEUED', `L${MAP};`).ret() },
      { name: 'registerPacket', desc: CTOR_DESC, flags: 0x0009, code: (a) => a.getstatic(`${BOX}/Api`, 'QUEUED', `L${MAP};`).aload(1).new_(`${BOX}/Container`).dup().aload(0).aload(1).invokespecial(`${BOX}/Container`, '<init>', CTOR_DESC).invokeinterface(MAP, 'put', '(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;', 3).pop().ret() }
    ]
  })
  const handler = buildClass({
    name: `${BOX}/Handler`,
    fields: [{ name: 'PACKET_MAP', desc: `L${MAP};`, flags: 0x0010 }],
    bootstrapMethods: [{ ...LMF, owner: `${BOX}/Handler`, name: 'lambda$register$0', desc: `(L${EVENT};Ljava/lang/Class;L${BOX}/Container;)V`, refKind: 7 }],
    methods: [
      { name: 'register', desc: `(L${EVENT};)V`, flags: 0x0001, code: (a) => a.aload(0).getfield(`${BOX}/Handler`, 'PACKET_MAP', `L${MAP};`).aload(0).aload(1).invokedynamic(0, 'accept', `(L${BOX}/Handler;L${EVENT};)Ljava/util/function/BiConsumer;`).invokeinterface(MAP, 'forEach', '(Ljava/util/function/BiConsumer;)V', 2).ret() },
      { name: 'lambda$register$0', desc: `(L${EVENT};Ljava/lang/Class;L${BOX}/Container;)V`, flags: 0x0002, code: (a) => a.aload(1).aload(3).invokevirtual(`${BOX}/Container`, 'getType', `()L${TYPE};`).invokevirtual(TYPE, 'id', `()L${RL};`).invokevirtual(RL, 'getNamespace', '()Ljava/lang/String;').invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`).invokevirtual(REG, 'optional', `()L${REG};`).aload(3).invokevirtual(`${BOX}/Container`, 'getType', `()L${TYPE};`).aconstNull().aconstNull().invokevirtual(REG, 'playBidirectional', `(L${TYPE};Ljava/lang/Object;Ljava/lang/Object;)L${REG};`).pop().ret() }
    ]
  })
  const jar = path.join(dir, 'box.jar')
  fs.writeFileSync(jar, buildJar([
    { name: 'META-INF/neoforge.mods.toml', data: Buffer.from('[[mods]]\nmodId="synthbox"\nversion="1.0.0"\n') },
    { name: `${BOX}/Container.class`, data: container },
    { name: `${BOX}/Api.class`, data: api },
    { name: `${BOX}/Handler.class`, data: handler }
  ]))
  return jar
}

// the mod: PingA.CHANNEL = synthcc:real_ping; Init.init queues it through the library's Api
function populatorJar (dir) {
  const ping = buildClass({
    name: `${CC}/PingA`,
    fields: [{ name: 'CHANNEL', desc: `L${RL};` }],
    methods: [
      { name: '<clinit>', desc: '()V', flags: 0x0008, code: (a) => a.ldcStr('synthcc').ldcStr('real_ping').invokestatic(RL, 'fromNamespaceAndPath', `(Ljava/lang/String;Ljava/lang/String;)L${RL};`).putstatic(`${CC}/PingA`, 'CHANNEL', `L${RL};`).ret() },
      { name: 'channelType', desc: `()L${TYPE};`, flags: 0x0009, code: (a) => a.new_(TYPE).dup().getstatic(`${CC}/PingA`, 'CHANNEL', `L${RL};`).invokespecial(TYPE, '<init>', `(L${RL};)V`).areturn() }
    ]
  })
  const init = buildClass({
    name: `${CC}/Init`,
    methods: [{ name: 'init', desc: '()V', flags: 0x0009, code: (a) => a.invokestatic(`${CC}/PingA`, 'channelType', `()L${TYPE};`).aconstNull().invokestatic(`${BOX}/Api`, 'registerPacket', CTOR_DESC).ret() }]
  })
  const jar = path.join(dir, 'cc.jar')
  fs.writeFileSync(jar, buildJar([
    { name: 'META-INF/neoforge.mods.toml', data: Buffer.from('[[mods]]\nmodId="synthcc"\nversion="1.0.0"\n') },
    { name: `${CC}/PingA.class`, data: ping },
    { name: `${CC}/Init.class`, data: init }
  ]))
  return jar
}

module.exports = { containerLibJar, populatorJar, BOX, CC }
