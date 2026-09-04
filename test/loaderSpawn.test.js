/* eslint-env mocha */
// D3 — loader custom-spawn codec derivation + decoder battery.
//
// Deterministic part: SYNTHETIC loader jars (test/helpers/synthJar.js emit
// the exact bytecode idioms javac produces) exercise the derivation
// mechanics — spawn-class discovery through the buffer-reading method,
// role mapping through the canonical ctor's putfields, channel resolution
// through a static ResourceLocation field, explicit vs sequential message
// index, discriminator width through the codec's map lookup, the companion
// shape, and every abstain rule — with NO mod names anywhere.
// Decoder part: wire round-trip against a derived spec, vanilla-shaped
// synthesis on a fake client, double-spawn idempotence, sanity refusal, and
// the abstain path (no jar → no synthesis, payloads counted).
//
// Ground-truth part (env-gated, MINEPAL_D3_JARS=<dir of loader universal
// jars>): the derivation must reproduce the javap-verified table on the real
// shipped loader jars; skipped cleanly when the dir is absent.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')

const { deriveLoaderSpawnCodec, _internal: D } = require('../src/client/loaderSpawnDerivation')
const { installLoaderSpawnDecoder, decodeLoaderSpawn, vanillaSpawnPacket, snapshot } = require('../src/client/loaderSpawnDecoder')
const { pickForgeLoaderJars } = require('../src/client/neoForgeLoaderLocator')
const { buildClass, buildJar } = require('./helpers/synthJar')

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
function spawnClass ({ name = SPAWN, opaqueTail = true, mojangVarint = 'm_130242_' } = {}) {
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
      { name: 'readTail', desc: `(L${FBB};)L${FBB};`, flags: 0x000a, code: (a) => a.aload(0).invokevirtual(FBB, 'm_130242_', '()I').pop().aload(0).areturn() }
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

let tmp
function writeJar (buf, rel = 'synth-universal.jar') {
  const p = path.join(tmp, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, buf)
  return p
}
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd3-loader-spawn-')) })
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })
beforeEach(() => D._cache.clear())

const ROLES = ['type', 'entityId', 'uuid', 'x', 'y', 'z', 'pitch', 'yaw', 'headYaw', 'velX', 'velY', 'velZ', 'custom']
const KINDS = ['varint', 'i32', 'uuid', 'f64', 'f64', 'f64', 'i8', 'i8', 'i8', 'i16', 'i16', 'i16', 'opaque']

describe('D3 loader spawn codec derivation (synthetic jar, no mod names)', () => {
  it('derives channel / explicit index / u8 width / the full role sequence from the bytecode', () => {
    const spec = deriveLoaderSpawnCodec(writeJar(synthJar()))
    assert.strictEqual(spec.ok, true)
    assert.strictEqual(spec.kind, 'spawn')
    assert.strictEqual(spec.className, SPAWN)
    assert.strictEqual(spec.channel, 'synth:play')
    assert.strictEqual(spec.index, 0)
    assert.strictEqual(spec.indexDerivation, 'explicit')
    assert.strictEqual(spec.indexWidth, 'u8')
    assert.deepStrictEqual(spec.fields.map((f) => f.role), ROLES)
    assert.deepStrictEqual(spec.fields.map((f) => f.kind), KINDS)
  })

  it('explicit index is read from the registration site, not assumed 0', () => {
    const spec = deriveLoaderSpawnCodec(writeJar(synthJar({ init: { spawnIndex: 3 } }), 'idx3.jar'))
    assert.strictEqual(spec.ok, true)
    assert.strictEqual(spec.index, 3)
  })

  it('implicit index = position on the same channel receiver (sequential counter), varint width from the codec lookup', () => {
    const spec = deriveLoaderSpawnCodec(writeJar(synthJar({ init: { explicit: false, otherFirst: true }, channel: { width: 'varint' } }), 'seq.jar'))
    assert.strictEqual(spec.ok, true)
    assert.strictEqual(spec.index, 1, 'one earlier registration on the same channel chain')
    assert.strictEqual(spec.indexDerivation, 'sequential')
    assert.strictEqual(spec.indexWidth, 'varint')
  })

  it('a Mojang-named varint reader (official mappings) classifies the same as the SRG one', () => {
    const spec = deriveLoaderSpawnCodec(writeJar(synthJar({ spawn: { mojangVarint: 'readVarInt' } }), 'official.jar'))
    assert.strictEqual(spec.ok, true)
    assert.strictEqual(spec.fields[0].kind, 'varint')
  })

  it('the buffer itself handed over as the trailing ctor parameter is an opaque tail (older builds)', () => {
    const spec = deriveLoaderSpawnCodec(writeJar(synthJar({ spawn: { opaqueTail: false } }), 'buftail.jar'))
    assert.strictEqual(spec.ok, true)
    assert.strictEqual(spec.fields[12].kind, 'opaque')
    assert.strictEqual(spec.fields[12].role, 'custom')
  })

  it('companion shape (entityId + custom bytes, no type/position) is reported, with its own payload id, and never a spawn', () => {
    const spec = deriveLoaderSpawnCodec(writeJar(companionJar(), 'companion.jar'))
    assert.strictEqual(spec.ok, true)
    assert.strictEqual(spec.kind, 'companion')
    assert.strictEqual(spec.channel, 'synth:advanced_add_entity')
    assert.deepStrictEqual(spec.fields.map((f) => `${f.role}:${f.kind}`), ['entityId:varint', 'custom:bytes'])
  })

  describe('abstain rules (a fact that cannot be read is never guessed)', () => {
    it('spawn class present but never registered', () => {
      const spec = deriveLoaderSpawnCodec(writeJar(synthJar({ init: { register: false } }), 'noreg.jar'))
      assert.strictEqual(spec.ok, false)
      assert.match(spec.reason, /never registered/)
    })
    it('discriminator width ambiguous (u8 and varint lookups both present)', () => {
      const spec = deriveLoaderSpawnCodec(writeJar(synthJar({ channel: { ambiguous: true } }), 'ambig.jar'))
      assert.strictEqual(spec.ok, false)
      assert.match(spec.reason, /index width.*ambiguous/)
    })
    it('discriminator read absent from the codec classes', () => {
      const spec = deriveLoaderSpawnCodec(writeJar(synthJar({ channel: { noRead: true } }), 'noread.jar'))
      assert.strictEqual(spec.ok, false)
      assert.match(spec.reason, /index width.*not found/)
    })
    it('no network classes at all', () => {
      const spec = deriveLoaderSpawnCodec(writeJar(buildJar([{ name: 'a/b/C.class', data: Buffer.from([0xca, 0xfe]) }]), 'empty.jar'))
      assert.strictEqual(spec.ok, false)
      assert.match(spec.reason, /no network classes/)
    })
    it('unreadable path', () => {
      const spec = deriveLoaderSpawnCodec(path.join(tmp, 'missing.jar'))
      assert.strictEqual(spec.ok, false)
      assert.match(spec.reason, /unreadable/)
    })
  })
})

// --- decoder -----------------------------------------------------------------------

function encodeSpawn (spec, { index = spec.index, typeId = 7, entityId = 4242, x = 32.5, y = 66, z = 32.5, pitch = 0, yaw = 64, headYaw = 64, tail = Buffer.from([0]) } = {}) {
  const parts = []
  if (spec.indexWidth === 'u8') parts.push(Buffer.from([index]))
  else parts.push(Buffer.from([index]))
  const varint = (v) => { const out = []; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b) } while (v); return Buffer.from(out) }
  parts.push(varint(typeId))
  const i32 = Buffer.alloc(4); i32.writeInt32BE(entityId); parts.push(i32)
  const uuid = Buffer.alloc(16); uuid.writeBigInt64BE(0x1122334455667788n, 0); uuid.writeBigInt64BE(-0x0102030405060708n, 8); parts.push(uuid)
  for (const v of [x, y, z]) { const b = Buffer.alloc(8); b.writeDoubleBE(v); parts.push(b) }
  parts.push(Buffer.from([pitch & 0xff, yaw & 0xff, headYaw & 0xff]))
  for (const v of [10, -20, 30]) { const b = Buffer.alloc(2); b.writeInt16BE(v); parts.push(b) }
  parts.push(tail)
  return Buffer.concat(parts)
}

describe('D3 loader spawn decoder', () => {
  let spec
  before(() => { D._cache.clear(); spec = deriveLoaderSpawnCodec(writeJar(synthJar(), 'dec.jar')); assert.strictEqual(spec.ok, true) })

  it('round-trips the wire into roles and the vanilla spawn_entity shape', () => {
    const d = decodeLoaderSpawn(spec, encodeSpawn(spec))
    assert.strictEqual(d.index, 0)
    assert.strictEqual(d.roles.type, 7)
    assert.strictEqual(d.roles.entityId, 4242)
    assert.strictEqual(d.roles.uuid, '11223344-5566-7788-fefd-fcfbfaf9f8f8')
    assert.strictEqual(d.roles.x, 32.5)
    assert.strictEqual(d.roles.velY, -20)
    const pkt = vanillaSpawnPacket(d.roles)
    assert.deepStrictEqual(Object.keys(pkt).sort(), ['entityId', 'headPitch', 'objectData', 'objectUUID', 'pitch', 'type', 'velocityX', 'velocityY', 'velocityZ', 'x', 'y', 'yaw', 'z'])
    assert.strictEqual(pkt.headPitch, 64)
  })

  it('another message index on the same channel is skipped, not mis-decoded', () => {
    const d = decodeLoaderSpawn(spec, encodeSpawn(spec, { index: 1 }))
    assert.strictEqual(d.skip, 'other-index')
  })

  it('a truncated body throws (counted as a parse error by the hook, never a spawn)', () => {
    assert.throws(() => decodeLoaderSpawn(spec, encodeSpawn(spec).slice(0, 20)), /past end/)
  })

  // a fake client with the synthetic jar planted in a launcher-shaped tree
  function fakeClient ({ withJar = true, registry = new Map([[7, 'synth:thing']]) } = {}) {
    const client = new EventEmitter()
    client.version = '1.20.1'
    client.forgeRegistries = { entity_type: registry }
    client.forgeModData = { mods: { forge: { version: '1.0' } } }
    const inst = path.join(tmp, `inst-${withJar ? 'jar' : 'nojar'}`)
    const mods = path.join(inst, 'mods')
    fs.mkdirSync(mods, { recursive: true })
    if (withJar) {
      const dir = path.join(inst, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-1.0')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'forge-1.20.1-1.0-universal.jar'), synthJar())
    }
    const spawns = []
    const loader = []
    const announced = []
    client.on('spawn_entity', (p, meta) => spawns.push({ p, meta }))
    client.on('loaderSpawnEntity', (e) => loader.push(e))
    client.on('loaderSpawnDecoder', (s) => announced.push(s))
    installLoaderSpawnDecoder(client, { modsPaths: [mods] }, { family: 'forge' })
    const play = (name, packet) => client.emit('packet', packet, { name, state: 'play' })
    return { client, spawns, loader, announced, play }
  }

  it('derives on PLAY entry (server-announced build honored) and synthesizes vanilla spawn_entity from the loader payload', () => {
    const { client, spawns, loader, announced, play } = fakeClient()
    play('login', { entityId: 1 })
    const st = client.loaderSpawn
    assert.strictEqual(st.status, 'derived')
    assert.strictEqual(st.channel, 'synth:play')
    assert.strictEqual(st.matchedPreferred, true, 'the FML-announced forge build selected the jar')
    assert.strictEqual(announced.length, 1)
    play('custom_payload', { channel: 'synth:play', data: encodeSpawn(st.spec) })
    assert.strictEqual(spawns.length, 1)
    assert.strictEqual(spawns[0].p.entityId, 4242)
    assert.strictEqual(spawns[0].p.type, 7)
    assert.strictEqual(spawns[0].p.x, 32.5)
    assert.strictEqual(spawns[0].meta.synthesizedFrom, 'synth:play')
    assert.strictEqual(loader.length, 1)
    assert.strictEqual(loader[0].name, 'synth:thing', 'the registry sync names the decoded type id')
    assert.strictEqual(st.decoded, 1)
    assert.strictEqual(st.synthesized, 1)
    // a foreign channel is not ours
    play('custom_payload', { channel: 'other:thing', data: Buffer.from([0, 1, 2]) })
    assert.strictEqual(st.payloadsSeen, 1)
    // other index on our channel: skipped
    play('custom_payload', { channel: 'synth:play', data: encodeSpawn(st.spec, { index: 1 }) })
    assert.strictEqual(st.otherIndex, 1)
    assert.strictEqual(spawns.length, 1)
  })

  it('is idempotent on entityId: a live id is never re-spawned; entity_destroy releases it; a vanilla spawn first makes the loader copy a duplicate', () => {
    const { client, spawns, play } = fakeClient()
    play('login', {})
    const st = client.loaderSpawn
    const body = encodeSpawn(st.spec)
    play('custom_payload', { channel: 'synth:play', data: body })
    play('custom_payload', { channel: 'synth:play', data: body })
    assert.strictEqual(spawns.length, 1)
    assert.strictEqual(st.duplicates, 1)
    client.emit('entity_destroy', { entityIds: [4242] })
    play('custom_payload', { channel: 'synth:play', data: body })
    assert.strictEqual(spawns.length, 2, 'released id spawns again')
    // vanilla spawn_entity first (the server used the vanilla packet for this id)
    client.emit('spawn_entity', { entityId: 9001, type: 7, x: 0, y: 0, z: 0 })
    play('custom_payload', { channel: 'synth:play', data: encodeSpawn(st.spec, { entityId: 9001 }) })
    assert.strictEqual(spawns.length, 3, 'the vanilla emit is counted by the listener, the loader copy is not re-emitted')
    assert.strictEqual(st.duplicates, 2)
    client.emit('respawn', {})
    play('custom_payload', { channel: 'synth:play', data: encodeSpawn(st.spec, { entityId: 9001 }) })
    assert.strictEqual(spawns.length, 4, 'world reset releases every id')
  })

  it('refuses an implausible decode (type id outside the synced registry) instead of minting a bogus entity', () => {
    const { client, spawns, play } = fakeClient()
    play('login', {})
    play('custom_payload', { channel: 'synth:play', data: encodeSpawn(client.loaderSpawn.spec, { typeId: 999 }) })
    assert.strictEqual(spawns.length, 0)
    assert.strictEqual(client.loaderSpawn.refused, 1)
    assert.match(client.loaderSpawn.lastError, /outside the synced entity_type registry/)
    // and a truncated body is a parse error, not a spawn
    play('custom_payload', { channel: 'synth:play', data: encodeSpawn(client.loaderSpawn.spec).slice(0, 10) })
    assert.strictEqual(client.loaderSpawn.parseErrors, 1)
    assert.strictEqual(spawns.length, 0)
  })

  it('ABSTAINS without a local loader jar: announced once, loader-spawn payloads counted, nothing synthesized', () => {
    const { client, spawns, announced, play } = fakeClient({ withJar: false })
    play('login', {})
    const st = client.loaderSpawn
    assert.strictEqual(st.status, 'abstained')
    assert.match(st.reason, /no forge universal jar/)
    assert.strictEqual(announced.length, 1)
    play('custom_payload', { channel: 'fml:play', data: Buffer.from([0, 1, 2, 3]) })
    play('custom_payload', { channel: 'fml:play', data: Buffer.from([0, 1, 2, 3]) })
    assert.strictEqual(spawns.length, 0)
    assert.strictEqual(st.abstainedPayloads, 2)
    const snap = snapshot(st)
    assert.strictEqual(snap.live, undefined)
    assert.strictEqual(snap.spec, undefined)
    assert.strictEqual(snap.status, 'abstained')
  })

  it('installs once per connection', () => {
    const { client } = fakeClient()
    const again = installLoaderSpawnDecoder(client, {}, { family: 'forge' })
    assert.strictEqual(again, client.loaderSpawn)
  })
})

describe('Forge loader jar locator', () => {
  it('prefers the announced build, else the newest for the SAME Minecraft version, never a foreign line', () => {
    const inst = path.join(tmp, 'locator')
    const mods = path.join(inst, 'mods')
    fs.mkdirSync(mods, { recursive: true })
    for (const v of ['1.20.1-47.2.0', '1.20.1-47.3.0', '1.20.1-47.10.0', '1.20.4-49.1.0']) {
      const d = path.join(inst, 'libraries', 'net', 'minecraftforge', 'forge', v)
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, `forge-${v}-universal.jar`), 'x')
    }
    assert.strictEqual(pickForgeLoaderJars([mods], { mcVersion: '1.20.1', preferredVersion: '1.20.1-47.2.0' }).version, '1.20.1-47.2.0')
    const newest = pickForgeLoaderJars([mods], { mcVersion: '1.20.1', preferredVersion: '1.20.1-47.99.0' })
    assert.strictEqual(newest.version, '1.20.1-47.10.0', 'numeric, not lexicographic')
    assert.strictEqual(newest.matchedPreferred, false)
    const foreign = pickForgeLoaderJars([mods], { mcVersion: '1.19.2' })
    assert.deepStrictEqual(foreign.jars, [])
    assert.ok(foreign.foreignBuilds.length === 4)
  })
})

// --- ground truth over the real loader jars (env-gated) ------------------------------

describe('D3 ground truth on shipped loader jars (MINEPAL_D3_JARS)', function () {
  const dir = process.env.MINEPAL_D3_JARS
  const jars = dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jar')) : []
  const EXPECT = [
    // javap-verified (scratchpad/d3-rig/javap*): Forge ≤1.20.1 + NeoForge 20.2 = fml:play#0 u8;
    // Forge 1.20.2–1.20.4 = forge:handshake#7 varint (the PLAY channel is built with HANDSHAKE_NAME;
    // indices 0–6 are the config-phase handshake messages forgeHandshakeConfig.js already speaks);
    // NeoForge 20.4+ = companion; Forge 1.21.1 (SimpleFlow.addMain, no attributable receiver) = abstain.
    [/^forge-1\.16\.5-/, { kind: 'spawn', channel: 'fml:play', index: 0, indexWidth: 'u8' }],
    [/^forge-1\.18\.2-/, { kind: 'spawn', channel: 'fml:play', index: 0, indexWidth: 'u8' }],
    [/^forge-1\.19\.2-/, { kind: 'spawn', channel: 'fml:play', index: 0, indexWidth: 'u8' }],
    [/^forge-1\.20\.1-/, { kind: 'spawn', channel: 'fml:play', index: 0, indexWidth: 'u8' }],
    [/^forge-1\.20\.2-/, { kind: 'spawn', channel: 'forge:handshake', index: 7, indexWidth: 'varint' }],
    [/^forge-1\.20\.4-/, { kind: 'spawn', channel: 'forge:handshake', index: 7, indexWidth: 'varint' }],
    [/^forge-1\.21\.1-/, { ok: false }],
    [/^neoforge-20\.2\./, { kind: 'spawn', channel: 'fml:play', index: 0, indexWidth: 'u8' }],
    [/^neoforge-20\.4\./, { kind: 'companion', channel: 'neoforge:advanced_add_entity' }],
    [/^neoforge-21\./, { kind: 'companion', channel: 'neoforge:advanced_add_entity' }]
  ]
  if (jars.length === 0) it.skip('no MINEPAL_D3_JARS dir — ground-truth table skipped', () => {})
  for (const jar of jars) {
    const row = EXPECT.find(([re]) => re.test(jar))
    if (!row) continue
    it(`${jar} → ${JSON.stringify(row[1])}`, () => {
      const spec = deriveLoaderSpawnCodec(path.join(dir, jar))
      for (const [k, v] of Object.entries(row[1])) assert.strictEqual(spec[k], v, `${k}: ${JSON.stringify(spec)}`)
      if (spec.kind === 'spawn') assert.deepStrictEqual(spec.fields.map((f) => f.role), ROLES)
    })
  }
})
