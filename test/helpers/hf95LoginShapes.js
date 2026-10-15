// HF95 - the three user shapes of the F29 family as SYNTHETIC jars (real jar
// file names and mod ids only; no real pack, no player, no host):
//   S1  every login message is server-to-client, .markAsLoginPacket()
//       .noResponse(), registered through a static helper whose Class is a
//       PARAMETER (registerLoginS2C(Class)) and whose index is a counter -
//       no client-to-server login site at all (the KubeJS-TFC bridge and the
//       TaCZ tweaks mod of the F29 pack)
//   S2  generic helpers registerClientLoginPacket(Class) (LOGIN_TO_SERVER,
//       loginIndex) and registerServerLoginReplyPacket(Class) (LOGIN_TO_CLIENT,
//       loginIndex, markAsLoginPacket) - the reply is mod-semantic, the Class
//       is a parameter at both sites (the additional-placements mod)
//   S3  a library-mediated handshake: the mod calls a builder
//       (createNetworkBuilder(RL).registerHandshakeMessage(Class).build())
//       and the SimpleChannel calls live in the library's OWN jar
//       (the backpacked family of two other users) - the control
// The builders reuse the hf69a namespace shape: a Mod class with the MOD_ID
// constant and the id(String) helper returning an RL subclass.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildClass, buildJar } = require('./synthJar')

const RL = 'net/minecraft/resources/ResourceLocation'
const SC = 'net/minecraftforge/network/simple/SimpleChannel'
const MB = 'net/minecraftforge/network/simple/SimpleChannel$MessageBuilder'
const NR = 'net/minecraftforge/network/NetworkRegistry'
const ND = 'net/minecraftforge/network/NetworkDirection'
const FBB = 'net/minecraft/network/FriendlyByteBuf'
const AI = 'java/util/concurrent/atomic/AtomicInteger'
const STR = 'Ljava/lang/String;'
const CLS = 'Ljava/lang/Class;'
const BICONS = 'Ljava/util/function/BiConsumer;'
const FN = 'Ljava/util/function/Function;'

function modsToml (modId) {
  return { name: 'META-INF/mods.toml', data: Buffer.from(`modLoader="javafml"\nloaderVersion="[47,)"\n[[mods]]\n    modId="${modId}"\n    version="1.0"\n`, 'utf8') }
}

// Mod: MOD_ID constant + `static ModRL id(String)`; ModRL extends RL with the (String) ctor = new RL(MOD_ID, path)
function modClasses (pkg, ns) {
  const MOD = `${pkg}/Mod`
  const MODRL = `${pkg}/ModRL`
  const mod = buildClass({
    name: MOD,
    fields: [{ name: 'MOD_ID', desc: STR, flags: 0x0019, constValue: ns }],
    methods: [{ name: 'id', desc: `(${STR})L${MODRL};`, flags: 0x0009, code: (a) => a.new_(MODRL).dup().aload(0).invokespecial(MODRL, '<init>', `(${STR})V`).areturn() }]
  })
  // ModRL(String s) { super("<ns>:" + s) } - the concat recipe the deriver reads the namespace from (hf69a)
  const modRl = buildClass({
    name: MODRL,
    superName: RL,
    bootstrapMethods: [{ refKind: 6, owner: 'java/lang/invoke/StringConcatFactory', name: 'makeConcatWithConstants', desc: '(Ljava/lang/invoke/MethodHandles$Lookup;Ljava/lang/String;Ljava/lang/invoke/MethodType;Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/invoke/CallSite;', strArgs: [`${ns}:${String.fromCharCode(1)}`] }],
    methods: [
      { name: '<init>', desc: `(${STR})V`, code: (a) => a.aload(0).aload(1).invokestatic(MODRL, 'addNs', `(${STR})${STR}`).invokespecial(RL, '<init>', `(${STR})V`).ret() },
      { name: 'addNs', desc: `(${STR})${STR}`, flags: 0x000a, code: (a) => a.aload(0).invokedynamic(0, 'makeConcatWithConstants', `(${STR})${STR}`).areturn() }
    ]
  })
  return { MOD, MODRL, entries: [{ name: `${MOD}.class`, data: mod }, { name: `${MODRL}.class`, data: modRl }] }
}

function writeJar (dir, fileName, entries) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, fileName), buildJar(entries))
  return path.join(dir, fileName)
}

// the channel creation: CHANNEL = NetworkRegistry.newSimpleChannel(Mod.id(path)); ID = new AtomicInteger(0)
function createChannel (a, { NET, MOD, MODRL, pathPart }) {
  return a.ldcStr(pathPart).invokestatic(MOD, 'id', `(${STR})L${MODRL};`)
    .invokestatic(NR, 'newSimpleChannel', `(L${RL};)L${SC};`).putstatic(NET, 'CHANNEL', `L${SC};`)
    .new_(AI).dup().iconst(0).invokespecial(AI, '<init>', '(I)V').putstatic(NET, 'ID', `L${AI};`)
}

// CHANNEL.messageBuilder(<Class param 0>, ID.getAndIncrement(), <direction>) ...
function helperChain (a, NET, { direction, loginIndex = true, markAsLoginPacket = false, noResponse = false, encoderBsm = null }) {
  a.getstatic(NET, 'CHANNEL', `L${SC};`).aload(0)
    .getstatic(NET, 'ID', `L${AI};`).invokevirtual(AI, 'getAndIncrement', '()I')
    .getstatic(ND, direction, `L${ND};`)
    .invokevirtual(SC, 'messageBuilder', `(${CLS}IL${ND};)L${MB};`)
  if (loginIndex) a.invokedynamic(0, 'apply', `()${FN}`).invokedynamic(1, 'accept', `()${BICONS}`).invokevirtual(MB, 'loginIndex', `(${FN}${BICONS})L${MB};`)
  if (encoderBsm != null) a.invokedynamic(encoderBsm, 'accept', `()${BICONS}`).invokevirtual(MB, 'encoder', `(${BICONS})L${MB};`)
  if (markAsLoginPacket) a.invokevirtual(MB, 'markAsLoginPacket', `()L${MB};`)
  if (noResponse) a.invokevirtual(MB, 'noResponse', `()L${MB};`)
  return a.invokevirtual(MB, 'add', '()V').ret()
}

const LAMBDAS = (NET) => [
  { refKind: 6, owner: NET, name: 'lambda$idx', desc: '(Ljava/lang/Object;)Ljava/lang/Integer;' },
  { refKind: 6, owner: NET, name: 'lambda$setIdx', desc: '(Ljava/lang/Object;Ljava/lang/Integer;)V' },
  { refKind: 6, owner: NET, name: 'lambda$enc', desc: `(Ljava/lang/Object;L${FBB};)V` }
]
const lambdaMethods = (NET) => [
  { name: 'lambda$idx', desc: '(Ljava/lang/Object;)Ljava/lang/Integer;', flags: 0x100a, code: (a) => a.aconstNull().areturn() },
  { name: 'lambda$setIdx', desc: '(Ljava/lang/Object;Ljava/lang/Integer;)V', flags: 0x100a, code: (a) => a.ret() },
  // the generic encoder delegates to the message: (msg, buf) -> msg.write(buf) - writes bytes the jar cannot prove empty
  { name: 'lambda$enc', desc: `(Ljava/lang/Object;L${FBB};)V`, flags: 0x100a, code: (a) => a.aload(1).iconst(1).invokevirtual(FBB, 'writeByte', '(I)Lio/netty/buffer/ByteBuf;').pop().ret() }
]

/**
 * S1: registerLoginS2C(Class) = messageBuilder(cls, ID++, LOGIN_TO_CLIENT).loginIndex(..).encoder(..).markAsLoginPacket().noResponse().add();
 * <clinit> creates the channel and registers `messages` classes through it.
 * `withC2S` adds registerLoginC2S(Class) = messageBuilder(cls, ID++, LOGIN_TO_SERVER).loginIndex(..).encoder(..).add() and one call to it
 * (the reply-needed control: the same channel with ONE client-to-server login site).
 */
function s1Jar (dir, { ns = 'kubejs_tfc', pathPart = 'network', fileName = `${ns}-1.0.jar`, messages = 2, withC2S = false } = {}) {
  const pkg = `synth/${ns}`
  const { MOD, MODRL, entries } = modClasses(pkg, ns)
  const NET = `${pkg}/Network`
  const MSG = (i) => `${pkg}/LoginMessage${i}`
  const net = buildClass({
    name: NET,
    fields: [{ name: 'CHANNEL', desc: `L${SC};`, flags: 0x0019 }, { name: 'ID', desc: `L${AI};`, flags: 0x0019 }],
    bootstrapMethods: LAMBDAS(NET),
    methods: [
      {
        name: '<clinit>',
        desc: '()V',
        flags: 0x0008,
        code: (a) => {
          createChannel(a, { NET, MOD, MODRL, pathPart })
          for (let i = 0; i < messages; i++) a.ldcCls(MSG(i)).invokestatic(NET, 'registerLoginS2C', `(${CLS})V`)
          if (withC2S) a.ldcCls(`${pkg}/LoginReply`).invokestatic(NET, 'registerLoginC2S', `(${CLS})V`)
          return a.ret()
        }
      },
      { name: 'registerLoginS2C', desc: `(${CLS})V`, flags: 0x0009, code: (a) => helperChain(a, NET, { direction: 'LOGIN_TO_CLIENT', markAsLoginPacket: true, noResponse: true, encoderBsm: 2 }) },
      ...(withC2S ? [{ name: 'registerLoginC2S', desc: `(${CLS})V`, flags: 0x0009, code: (a) => helperChain(a, NET, { direction: 'LOGIN_TO_SERVER', encoderBsm: 2 }) }] : []),
      ...lambdaMethods(NET)
    ]
  })
  const msgs = []
  for (let i = 0; i < messages; i++) msgs.push({ name: `${MSG(i)}.class`, data: buildClass({ name: MSG(i), methods: [{ name: '<init>', desc: '()V', code: (a) => a.ret() }] }) })
  if (withC2S) msgs.push({ name: `${pkg}/LoginReply.class`, data: buildClass({ name: `${pkg}/LoginReply`, methods: [{ name: '<init>', desc: '()V', code: (a) => a.ret() }] }) })
  return writeJar(dir, fileName, [...entries, { name: `${NET}.class`, data: net }, ...msgs, modsToml(ns)])
}

/** S2: registerClientLoginPacket(Class) (LOGIN_TO_SERVER, loginIndex, encoder) + registerServerLoginReplyPacket(Class) (LOGIN_TO_CLIENT, loginIndex, markAsLoginPacket); one call each. */
function s2Jar (dir, { ns = 'additionalplacements', pathPart = 'network', fileName = `${ns}-1.0.jar` } = {}) {
  const pkg = `synth/${ns}`
  const { MOD, MODRL, entries } = modClasses(pkg, ns)
  const NET = `${pkg}/APNetworkImpl`
  const CHECK = `${pkg}/CheckDataServerPacket`
  const REQ = `${pkg}/CheckDataRequestPacket`
  const net = buildClass({
    name: NET,
    fields: [{ name: 'CHANNEL', desc: `L${SC};`, flags: 0x0019 }, { name: 'ID', desc: `L${AI};`, flags: 0x0019 }],
    bootstrapMethods: LAMBDAS(NET),
    methods: [
      {
        name: '<clinit>',
        desc: '()V',
        flags: 0x0008,
        code: (a) => createChannel(a, { NET, MOD, MODRL, pathPart })
          .ldcCls(REQ).invokestatic(NET, 'registerServerLoginReplyPacket', `(${CLS})V`)
          .ldcCls(CHECK).invokestatic(NET, 'registerClientLoginPacket', `(${CLS})V`)
          .ret()
      },
      { name: 'registerClientLoginPacket', desc: `(${CLS})V`, flags: 0x0009, code: (a) => helperChain(a, NET, { direction: 'LOGIN_TO_SERVER', encoderBsm: 2 }) },
      { name: 'registerServerLoginReplyPacket', desc: `(${CLS})V`, flags: 0x0009, code: (a) => helperChain(a, NET, { direction: 'LOGIN_TO_CLIENT', markAsLoginPacket: true, encoderBsm: 2 }) },
      ...lambdaMethods(NET)
    ]
  })
  const plain = (n) => ({ name: `${n}.class`, data: buildClass({ name: n, methods: [{ name: '<init>', desc: '()V', code: (a) => a.ret() }] }) })
  return writeJar(dir, fileName, [...entries, { name: `${NET}.class`, data: net }, plain(CHECK), plain(REQ), modsToml(ns)])
}

/**
 * S3: the mod's Network.<clinit>: NETWORK = FrameworkAPI.createNetworkBuilder(Mod.id("play")).registerHandshakeMessage(Handshake.class).build();
 * the library jar (a SEPARATE jar in the same folder) holds the builder with the SimpleChannel calls.
 */
function s3Jars (dir, { ns = 'backpacked', pathPart = 'play', fileName = `${ns}-forge-1.20.1-2.1.8.jar`, libFileName = 'framework-forge-1.20.1-0.6.27.jar' } = {}) {
  const pkg = `synth/${ns}`
  const LIB = 'synth/framework'
  const API = `${LIB}/FrameworkAPI`
  const BUILDER = `${LIB}/NetworkBuilder`
  const NETWORK = `${LIB}/FrameworkNetwork`
  const { MOD, MODRL, entries } = modClasses(pkg, ns)
  const NET = `${pkg}/Network`
  const HS = `${pkg}/C2SHandshake`
  const net = buildClass({
    name: NET,
    fields: [{ name: 'NETWORK', desc: `L${NETWORK};`, flags: 0x0019 }],
    methods: [{
      name: '<clinit>',
      desc: '()V',
      flags: 0x0008,
      code: (a) => a.ldcStr(pathPart).invokestatic(MOD, 'id', `(${STR})L${MODRL};`)
        .invokestatic(API, 'createNetworkBuilder', `(L${RL};)L${BUILDER};`)
        .ldcCls(HS).invokevirtual(BUILDER, 'registerHandshakeMessage', `(${CLS})L${BUILDER};`)
        .invokevirtual(BUILDER, 'build', `()L${NETWORK};`)
        .putstatic(NET, 'NETWORK', `L${NETWORK};`).ret()
    }]
  })
  const hs = buildClass({ name: HS, methods: [{ name: '<init>', desc: '()V', code: (a) => a.ret() }] })
  const modJar = writeJar(dir, fileName, [...entries, { name: `${NET}.class`, data: net }, { name: `${HS}.class`, data: hs }, modsToml(ns)])
  // the library: the builder keeps the RL and registers the handshake on a SimpleChannel it creates in build()
  const builder = buildClass({
    name: BUILDER,
    fields: [{ name: 'channel', desc: `L${SC};` }, { name: 'ID', desc: `L${AI};`, flags: 0x0019 }],
    bootstrapMethods: LAMBDAS(BUILDER),
    methods: [
      { name: '<init>', desc: `(L${RL};)V`, code: (a) => a.aload(0).aload(1).invokestatic(NR, 'newSimpleChannel', `(L${RL};)L${SC};`).putfield(BUILDER, 'channel', `L${SC};`).ret() },
      {
        name: 'registerHandshakeMessage',
        desc: `(${CLS})L${BUILDER};`,
        code: (a) => a.aload(0).getfield(BUILDER, 'channel', `L${SC};`).aload(1)
          .getstatic(BUILDER, 'ID', `L${AI};`).invokevirtual(AI, 'getAndIncrement', '()I')
          .getstatic(ND, 'LOGIN_TO_SERVER', `L${ND};`)
          .invokevirtual(SC, 'messageBuilder', `(${CLS}IL${ND};)L${MB};`)
          .invokedynamic(0, 'apply', `()${FN}`).invokedynamic(1, 'accept', `()${BICONS}`).invokevirtual(MB, 'loginIndex', `(${FN}${BICONS})L${MB};`)
          .invokedynamic(2, 'accept', `()${BICONS}`).invokevirtual(MB, 'encoder', `(${BICONS})L${MB};`)
          .invokevirtual(MB, 'add', '()V').aload(0).areturn()
      },
      { name: 'build', desc: `()L${NETWORK};`, code: (a) => a.aconstNull().areturn() },
      ...lambdaMethods(BUILDER)
    ]
  })
  const api = buildClass({ name: API, methods: [{ name: 'createNetworkBuilder', desc: `(L${RL};)L${BUILDER};`, flags: 0x0009, code: (a) => a.new_(BUILDER).dup().aload(0).invokespecial(BUILDER, '<init>', `(L${RL};)V`).areturn() }] })
  const network = buildClass({ name: NETWORK, methods: [{ name: '<init>', desc: '()V', code: (a) => a.ret() }] })
  const libJar = writeJar(dir, libFileName, [{ name: `${API}.class`, data: api }, { name: `${BUILDER}.class`, data: builder }, { name: `${NETWORK}.class`, data: network }, modsToml('framework')])
  return { modJar, libJar }
}

/** The F29 pack in FIELD ORDER: S1a (the TaCZ tweaks mod), S1b (the KubeJS-TFC bridge), S2 (additional placements); returns the folder + the channels in the order the wire asked them. */
function f29Pack (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf95-f29-'))) {
  s1Jar(dir, { ns: 'tacztweaks', pathPart: 'handshake', fileName: 'tacztweaks-2.14.2.jar', messages: 1 })
  s1Jar(dir, { ns: 'kubejs_tfc', pathPart: 'network', fileName: 'kubejs_tfc-1.20.1-1.6.2.jar', messages: 2 })
  s2Jar(dir, { ns: 'additionalplacements', pathPart: 'network', fileName: 'additionalplacements-1.20.1-5.0.1.jar' })
  return { dir, channels: ['tacztweaks:handshake', 'kubejs_tfc:network', 'additionalplacements:network'] }
}

module.exports = { s1Jar, s2Jar, s3Jars, f29Pack, modsToml }
