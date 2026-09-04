// D3 — the SYNTHETIC loader jar: test/helpers/synthJar.js emits the exact
// bytecode idioms javac produces for a loader's SpawnEntity message, its
// registrar, channel + codec classes — with NO mod names anywhere. Shared by
// the lib battery (test/loaderSpawn.test.js) and the superproject rider pins.
'use strict'
const { buildClass, buildJar } = require('./synthJar')

const FBB = 'net/minecraft/network/FriendlyByteBuf'
const RL = 'net/minecraft/resources/ResourceLocation'
const UUID = 'java/util/UUID'
const CH = 'synth/network/simple/Channel'
const MB = 'synth/network/simple/Channel$MessageBuilder'
const CODEC = 'synth/network/simple/Codec'
const BUILDER = 'synth/network/Builder'
const CONST = 'synth/network/Constants'
const SPAWN = 'synth/network/Messages$Spawn'
const OTHER = 'synth/network/Messages$Other'
const INIT = 'synth/network/Init'
const S2O = 'it/unimi/dsi/fastutil/shorts/Short2ObjectMap'
const I2O = 'it/unimi/dsi/fastutil/ints/Int2ObjectMap'

// wide local loads (slots > 3) the assembler lacks
const xload = (a, kind, n) => a.raw([{ i: 0x15, l: 0x16, f: 0x17, d: 0x18, a: 0x19 }[kind], n])

// --- synthetic loader jar --------------------------------------------------------

// the spawn message: fields in Forge's role vocabulary, static decode(FBB)
// reading varint/int/uuid/3 doubles/3 bytes/3 shorts/opaque tail feeding
// the canonical ctor, which putfields each parameter
// tailShape: 'length-prefixed' = the real Forge readSpawnDataPacket idiom
// (varint length, then a copy bounded by exactly that many bytes);
// 'unknown' = a helper that reads the varint but copies unbounded (no byte
// accounting possible → the derivation must abstain)
function spawnClass ({ name = SPAWN, opaqueTail = true, tailShape = 'length-prefixed', mojangVarint = 'm_130242_' } = {}) {
  const fields = [['typeId', 'I'], ['entityId', 'I'], ['uuid', `L${UUID};`], ['posX', 'D'], ['posY', 'D'], ['posZ', 'D'], ['pitch', 'B'], ['yaw', 'B'], ['headYaw', 'B'], ['velX', 'I'], ['velY', 'I'], ['velZ', 'I'], ['buf', `L${FBB};`]]
  const ctorDesc = `(IIL${UUID};DDDBBBIIIL${FBB};)V`
  return buildClass({
    name,
    fields: fields.map(([n, d]) => ({ name: n, desc: d, flags: 0x0012 })),
    methods: [
      {
        name: '<init>',
        desc: ctorDesc,
        flags: 0x0002,
        code: (a) => {
          a.aload(0).invokespecial('java/lang/Object', '<init>', '()V')
          let slot = 1
          for (const [n, d] of fields) {
            a.aload(0)
            xload(a, d === 'D' ? 'd' : d.startsWith('L') ? 'a' : 'i', slot)
            a.putfield(name, n, d)
            slot += d === 'D' ? 2 : 1
          }
          a.ret()
        }
      },
      {
        name: 'decode',
        desc: `(L${FBB};)L${name};`,
        flags: 0x0009,
        code: (a) => {
          a.new_(name).dup()
          a.aload(0).invokevirtual(FBB, mojangVarint, '()I')
          a.aload(0).invokevirtual(FBB, 'readInt', '()I')
          a.new_(UUID).dup().aload(0).invokevirtual(FBB, 'readLong', '()J').aload(0).invokevirtual(FBB, 'readLong', '()J').invokespecial(UUID, '<init>', '(JJ)V')
          for (let i = 0; i < 3; i++) a.aload(0).invokevirtual(FBB, 'readDouble', '()D')
          for (let i = 0; i < 3; i++) a.aload(0).invokevirtual(FBB, 'readByte', '()B')
          for (let i = 0; i < 3; i++) a.aload(0).invokevirtual(FBB, 'readShort', '()S')
          if (opaqueTail) a.aload(0).invokestatic(name, 'readTail', `(L${FBB};)L${FBB};`)
          else a.aload(0)
          a.invokespecial(name, '<init>', ctorDesc).areturn()
        }
      },
      {
        name: 'readTail',
        desc: `(L${FBB};)L${FBB};`,
        flags: 0x000a,
        code: (a) => {
          if (tailShape === 'unknown') return a.aload(0).invokevirtual(FBB, 'm_130242_', '()I').pop().aload(0).areturn()
          // int n = buf.readVarInt(); FBB out = new FBB(Unpooled.buffer()); out.writeBytes(buf, n); return out;
          a.aload(0).invokevirtual(FBB, 'm_130242_', '()I').istore(1)
          a.new_(FBB).dup().invokestatic('io/netty/buffer/Unpooled', 'buffer', '()Lio/netty/buffer/ByteBuf;').invokespecial(FBB, '<init>', '(Lio/netty/buffer/ByteBuf;)V').astore(2)
          a.aload(2).aload(0).iload(1).invokevirtual(FBB, 'writeBytes', '(Lio/netty/buffer/ByteBuf;I)Lio/netty/buffer/ByteBuf;').pop()
          a.aload(2).areturn()
        }
      }
    ]
  })
}

// a second, non-spawn message on the same channel
function otherClass () {
  return buildClass({
    name: OTHER,
    fields: [{ name: 'windowId', desc: 'I', flags: 0x0012 }],
    methods: [
      { name: '<init>', desc: '(I)V', flags: 0x0002, code: (a) => a.aload(0).invokespecial('java/lang/Object', '<init>', '()V').aload(0).iload(1).putfield(OTHER, 'windowId', 'I').ret() },
      { name: 'decode', desc: `(L${FBB};)L${OTHER};`, flags: 0x0009, code: (a) => a.new_(OTHER).dup().aload(0).invokevirtual(FBB, 'm_130242_', '()I').invokespecial(OTHER, '<init>', '(I)V').areturn() }
    ]
  })
}

// Constants.<clinit>: PLAY_RL = new ResourceLocation("synth:play")
function constantsClass (id = 'synth:play') {
  return buildClass({
    name: CONST,
    fields: [{ name: 'PLAY_RL', desc: `L${RL};` }],
    methods: [{ name: '<clinit>', desc: '()V', flags: 0x0008, code: (a) => a.new_(RL).dup().ldcStr(id).invokespecial(RL, '<init>', '(Ljava/lang/String;)V').putstatic(CONST, 'PLAY_RL', `L${RL};`).ret() }]
  })
}

// Init.play(): Builder.named(PLAY_RL).simpleChannel().messageBuilder(Spawn.class, <idx>).add() [; ...Other]
function initClass ({ explicit = true, spawnIndex = 0, otherFirst = false, register = true } = {}) {
  return buildClass({
    name: INIT,
    fields: [{ name: 'PLAY', desc: `L${CH};`, flags: 0x0009 }],
    methods: [{
      name: 'play',
      desc: '()V',
      flags: 0x0009,
      code: (a) => {
        a.getstatic(CONST, 'PLAY_RL', `L${RL};`).invokestatic(BUILDER, 'named', `(L${RL};)L${BUILDER};`).invokevirtual(BUILDER, 'simpleChannel', `()L${CH};`)
        const reg = (cls, idx) => {
          a.ldcCls(cls)
          if (explicit) a.iconst(idx).invokevirtual(CH, 'messageBuilder', `(Ljava/lang/Class;I)L${MB};`)
          else a.invokevirtual(CH, 'messageBuilder', `(Ljava/lang/Class;)L${MB};`)
          a.invokevirtual(MB, 'add', `()L${CH};`)
        }
        if (register) {
          if (otherFirst) reg(OTHER, 0)
          reg(SPAWN, spawnIndex)
          if (!otherFirst) reg(OTHER, spawnIndex + 1)
        }
        a.putstatic(INIT, 'PLAY', `L${CH};`).ret()
      }
    }]
  })
}

// Channel (owner of messageBuilder) referencing Codec; Codec.consume reads the
// discriminator (u8 or varint) and looks the handler up in a map
function channelClasses ({ width = 'u8', ambiguous = false, noRead = false } = {}) {
  const ch = buildClass({
    name: CH,
    fields: [{ name: 'codec', desc: `L${CODEC};`, flags: 0x0002 }],
    methods: [
      { name: 'messageBuilder', desc: `(Ljava/lang/Class;I)L${MB};`, flags: 0x0001, code: (a) => a.aconstNull().areturn() },
      { name: 'messageBuilder', desc: `(Ljava/lang/Class;)L${MB};`, flags: 0x0001, code: (a) => a.aconstNull().areturn() },
      { name: 'dispatch', desc: `(L${FBB};)V`, flags: 0x0001, code: (a) => a.aload(0).getfield(CH, 'codec', `L${CODEC};`).aload(1).invokevirtual(CODEC, 'consume', `(L${FBB};)V`).ret() }
    ]
  })
  const read = (a, w) => (w === 'u8'
    ? a.aload(1).invokevirtual(FBB, 'readUnsignedByte', '()S').invokeinterface(S2O, 'get', '(S)Ljava/lang/Object;', 2).pop()
    : a.aload(1).invokevirtual(FBB, 'm_130242_', '()I').invokeinterface(I2O, 'get', '(I)Ljava/lang/Object;', 2).pop())
  const codec = buildClass({
    name: CODEC,
    methods: [{
      name: 'consume',
      desc: `(L${FBB};)V`,
      flags: 0x0001,
      code: (a) => {
        if (!noRead) read(a, width)
        if (ambiguous) read(a, width === 'u8' ? 'varint' : 'u8')
        a.ret()
      }
    }]
  })
  const mb = buildClass({ name: MB, methods: [{ name: 'add', desc: `()L${CH};`, flags: 0x0001, code: (a) => a.aconstNull().areturn() }] })
  const builder = buildClass({ name: BUILDER, methods: [{ name: 'named', desc: `(L${RL};)L${BUILDER};`, flags: 0x0009, code: (a) => a.aconstNull().areturn() }, { name: 'simpleChannel', desc: `()L${CH};`, flags: 0x0001, code: (a) => a.aconstNull().areturn() }] })
  return [ch, codec, mb, builder]
}

function synthJar ({ spawn = {}, init = {}, channel = {}, id } = {}) {
  const [ch, codec, mb, builder] = channelClasses(channel)
  return buildJar([
    { name: `${SPAWN}.class`, data: spawnClass(spawn) },
    { name: `${OTHER}.class`, data: otherClass() },
    { name: `${CONST}.class`, data: constantsClass(id) },
    { name: `${INIT}.class`, data: initClass(init) },
    { name: `${CH}.class`, data: ch },
    { name: `${CODEC}.class`, data: codec },
    { name: `${MB}.class`, data: mb },
    { name: `${BUILDER}.class`, data: builder }
  ])
}

// companion-shaped payload: ctor(FBB) { this.entityId = buf.readVarInt(); this.customPayload = buf.readByteArray(); }
function companionJar () {
  const P = 'synth/network/payload/Companion'
  const cls = buildClass({
    name: P,
    fields: [{ name: 'entityId', desc: 'I', flags: 0x0012 }, { name: 'customPayload', desc: '[B', flags: 0x0012 }, { name: 'ID', desc: `L${RL};` }],
    methods: [
      {
        name: '<init>',
        desc: `(L${FBB};)V`,
        flags: 0x0001,
        code: (a) => a.aload(0).invokespecial('java/lang/Object', '<init>', '()V')
          .aload(0).aload(1).invokevirtual(FBB, 'readVarInt', '()I').putfield(P, 'entityId', 'I')
          .aload(0).aload(1).invokevirtual(FBB, 'readByteArray', '()[B').putfield(P, 'customPayload', '[B')
          .ret()
      },
      { name: '<clinit>', desc: '()V', flags: 0x0008, code: (a) => a.new_(RL).dup().ldcStr('synth').ldcStr('advanced_add_entity').invokespecial(RL, '<init>', '(Ljava/lang/String;Ljava/lang/String;)V').putstatic(P, 'ID', `L${RL};`).ret() }
    ]
  })
  return buildJar([{ name: `${P}.class`, data: cls }])
}

/** The default synthetic loader jar's entries (for callers that build the jar themselves). */
function files ({ spawn = {}, init = {}, channel = {}, id } = {}) {
  const [ch, codec, mb, builder] = channelClasses(channel)
  return [
    { name: `${SPAWN}.class`, data: spawnClass(spawn) },
    { name: `${OTHER}.class`, data: otherClass() },
    { name: `${CONST}.class`, data: constantsClass(id) },
    { name: `${INIT}.class`, data: initClass(init) },
    { name: `${CH}.class`, data: ch },
    { name: `${CODEC}.class`, data: codec },
    { name: `${MB}.class`, data: mb },
    { name: `${BUILDER}.class`, data: builder }
  ]
}

module.exports = { synthJar, companionJar, files, spawnClass, otherClass, constantsClass, initClass, channelClasses, FBB, RL, UUID, CH, MB, CODEC, BUILDER, CONST, SPAWN, OTHER, INIT }
