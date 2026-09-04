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
const { buildJar } = require('./helpers/synthJar')

const { synthJar, companionJar, SPAWN } = require('./helpers/synthLoaderJar')

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

// a v4 / RFC-variant uuid by default (the shape every entity uuid on the wire has)
const UUID_MSB = 0x1122334455664788n
const UUID_LSB = BigInt.asIntN(64, 0x8efdfcfbfaf9f8f8n)
function encodeSpawn (spec, { index = spec.index, typeId = 7, entityId = 4242, x = 32.5, y = 66, z = 32.5, pitch = 0, yaw = 64, headYaw = 64, vel = [10, -20, 30], msb = UUID_MSB, lsb = UUID_LSB, tail = Buffer.from([0]) } = {}) {
  const parts = []
  if (spec.indexWidth === 'u8') parts.push(Buffer.from([index]))
  else parts.push(Buffer.from([index]))
  const varint = (v) => { const out = []; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b) } while (v); return Buffer.from(out) }
  parts.push(varint(typeId))
  const i32 = Buffer.alloc(4); i32.writeInt32BE(entityId); parts.push(i32)
  const uuid = Buffer.alloc(16); uuid.writeBigInt64BE(msb, 0); uuid.writeBigInt64BE(lsb, 8); parts.push(uuid)
  for (const v of [x, y, z]) { const b = Buffer.alloc(8); b.writeDoubleBE(v); parts.push(b) }
  parts.push(Buffer.from([pitch & 0xff, yaw & 0xff, headYaw & 0xff]))
  for (const v of vel) { const b = Buffer.alloc(2); b.writeInt16BE(v); parts.push(b) }
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
    assert.strictEqual(d.roles.uuid, '11223344-5566-4788-8efd-fcfbfaf9f8f8')
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
    assert.match(client.loaderSpawn.lastError, /synced entity_type registry/)
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

// --- D3 rider: the plausibility gate law, wire-proved loader family, truthful receipt ---

const { installWorldBounds, worldBoundsOf } = require('../src/client/worldBounds')
const { _internal: DEC } = require('../src/client/loaderSpawnDecoder')

// 1.20.1-shaped login dimensionCodec (prismarine-nbt JSON) with two dimension types
function dimensionCodecNbt (types = [['minecraft:overworld', -64, 384], ['minecraft:the_nether', 0, 256]]) {
  return {
    type: 'compound',
    name: '',
    value: {
      'minecraft:dimension_type': {
        type: 'compound',
        value: {
          type: { type: 'string', value: 'minecraft:dimension_type' },
          value: {
            type: 'list',
            value: {
              type: 'compound',
              value: types.map(([name, minY, height], id) => ({
                name: { type: 'string', value: name },
                id: { type: 'int', value: id },
                element: { type: 'compound', value: { min_y: { type: 'int', value: minY }, height: { type: 'int', value: height }, logical_height: { type: 'int', value: height } } }
              }))
            }
          }
        }
      }
    }
  }
}

describe('D3 rider — world bounds from the wire (worldBounds.js)', () => {
  const wire = (client, name, packet, state = 'play') => client.emit('packet', packet, { name, state })
  it('1.19–1.20.1: login dimensionCodec + worldType name; respawn switches by name', () => {
    const c = new EventEmitter(); installWorldBounds(c)
    assert.strictEqual(worldBoundsOf(c), null, 'unknown until the wire says')
    wire(c, 'login', { dimensionCodec: dimensionCodecNbt(), worldType: 'minecraft:overworld', worldName: 'minecraft:overworld' })
    assert.deepStrictEqual(worldBoundsOf(c), { minY: -64, height: 384, dimension: 'overworld' })
    wire(c, 'respawn', { dimension: 'minecraft:the_nether', worldName: 'minecraft:the_nether' })
    assert.deepStrictEqual(worldBoundsOf(c), { minY: 0, height: 256, dimension: 'the_nether' })
    wire(c, 'respawn', { dimension: 'modded:sky', worldName: 'modded:sky' })
    assert.strictEqual(worldBoundsOf(c), null, 'a dimension the codec never described leaves the bounds unknown (never guessed)')
  })
  it('1.16.2–1.18.2: the dimension type NBT rides in login/respawn itself (no min_y = 0..256)', () => {
    const c = new EventEmitter(); installWorldBounds(c)
    wire(c, 'login', { dimension: { type: 'compound', name: '', value: { min_y: { type: 'int', value: -64 }, height: { type: 'int', value: 384 } } }, worldName: 'minecraft:overworld' })
    assert.deepStrictEqual(worldBoundsOf(c), { minY: -64, height: 384, dimension: 'overworld' })
    wire(c, 'respawn', { dimension: { type: 'compound', name: '', value: { logical_height: { type: 'int', value: 256 } } }, worldName: 'minecraft:the_end' })
    assert.deepStrictEqual(worldBoundsOf(c), { minY: 0, height: 256, dimension: 'the_end' })
  })
  it('1.20.2–1.20.4: configuration registry_data.codec + login worldType', () => {
    const c = new EventEmitter(); installWorldBounds(c)
    wire(c, 'registry_data', { codec: dimensionCodecNbt() }, 'configuration')
    wire(c, 'login', { worldType: 'minecraft:overworld', worldName: 'minecraft:overworld' })
    assert.deepStrictEqual(worldBoundsOf(c), { minY: -64, height: 384, dimension: 'overworld' })
  })
  it('1.20.5+: segmented registry_data entries + worldState.dimension INDEX; a value-less entry stays unknown', () => {
    const c = new EventEmitter(); installWorldBounds(c)
    wire(c, 'registry_data', { id: 'minecraft:dimension_type', entries: [{ key: 'minecraft:overworld', value: { type: 'compound', name: '', value: { min_y: { type: 'int', value: -64 }, height: { type: 'int', value: 384 } } } }, { key: 'minecraft:the_nether' }] }, 'configuration')
    wire(c, 'registry_data', { id: 'minecraft:biome', entries: [{ key: 'minecraft:plains' }] }, 'configuration')
    wire(c, 'login', { worldState: { dimension: 0, name: 'minecraft:overworld' } })
    assert.deepStrictEqual(worldBoundsOf(c), { minY: -64, height: 384, dimension: 'overworld' })
    wire(c, 'respawn', { worldState: { dimension: 1, name: 'minecraft:the_nether' } })
    assert.strictEqual(worldBoundsOf(c), null, 'the server sent no value for this entry (known pack) — bounds unknown, gate uses the legal world')
  })
  it('installs once per client', () => {
    const c = new EventEmitter(); const a = installWorldBounds(c); assert.strictEqual(installWorldBounds(c), a)
  })
})

describe('D3 rider — plausibility gate law (a synthesized entity never comes from garbage)', () => {
  let spec
  before(() => { D._cache.clear(); spec = deriveLoaderSpawnCodec(writeJar(synthJar(), 'gate.jar')); assert.strictEqual(spec.ok, true) })
  const registry = new Map([...Array(10).keys()].map((i) => [i, `synth:e${i}`]))
  const overworld = { minY: -64, height: 384 }
  const pkt = (over = {}) => vanillaSpawnPacket(decodeLoaderSpawn(spec, encodeSpawn(spec, { typeId: 7, ...over })).roles)

  it('the fuzz-sample garbage class (in-registry type, zero uuid, y = 2.5e7, saturated velocity, trailing bytes) — the OLD gate let it through, this one never does', () => {
    const body = encodeSpawn(spec, { typeId: 3, entityId: 5, x: 1e6, y: 2.5e7, z: -3e6, vel: [32767, 32767, -32768], msb: 0n, lsb: 0n, tail: Buffer.from([0, 9, 9, 9, 9, 9, 9, 9]) })
    assert.throws(() => decodeLoaderSpawn(spec, body), /7 trailing byte\(s\) beyond the derived layout/)
    const noTrail = encodeSpawn(spec, { typeId: 3, entityId: 5, x: 1e6, y: 2.5e7, z: -3e6, vel: [32767, 32767, -32768], msb: 0n, lsb: 0n })
    const p = vanillaSpawnPacket(decodeLoaderSpawn(spec, noTrail).roles)
    assert.match(DEC.plausible(p, registry, null), /y 25000000 above the legal world ceiling \(2032\)/)
    assert.match(DEC.plausible({ ...p, y: 70 }, registry, null), /uuid is zero/)
    assert.match(DEC.plausible({ ...p, y: 70, objectUUID: '11223344-5566-4788-8efd-fcfbfaf9f8f8' }, registry, null), /velocityX 32767 beyond the loader's ±3.9 blocks\/tick clamp \(±31200\)/)
  })
  it('y is bound to the CURRENT DIMENSION when the wire stated it (floor = void-death line minY−64)', () => {
    assert.strictEqual(DEC.plausible(pkt({ y: 319 }), registry, overworld), null)
    assert.strictEqual(DEC.plausible(pkt({ y: -100 }), registry, overworld), null, 'below the floor but above the void-death line: an entity can be there')
    assert.match(DEC.plausible(pkt({ y: -129 }), registry, overworld), /y -129 below the dimension floor \(-128\)/)
    assert.match(DEC.plausible(pkt({ y: 5000 }), registry, overworld), /y 5000 above the dimension ceiling \(320\)/)
    assert.match(DEC.plausible(pkt({ y: 321 }), registry, overworld), /above the dimension ceiling/)
  })
  it('unknown dimension → the widest LEGAL world (−2032..2032), never 3.2e7', () => {
    assert.strictEqual(DEC.plausible(pkt({ y: -2096 }), registry, null), null)
    assert.match(DEC.plausible(pkt({ y: -2097 }), registry, null), /below the legal world floor \(-2096\)/)
    assert.strictEqual(DEC.plausible(pkt({ y: 2032 }), registry, null), null)
    assert.match(DEC.plausible(pkt({ y: 2033 }), registry, null), /above the legal world ceiling \(2032\)/)
    assert.match(DEC.plausible(pkt({ x: 29999985 }), registry, null), /x beyond the world border limit/)
    assert.match(DEC.plausible(pkt({ z: -29999985 }), registry, null), /z beyond the world border limit/)
    assert.strictEqual(DEC.plausible(pkt({ x: 29999984 }), registry, null), null)
  })
  it('uuid must be non-zero with an RFC-4122 version nibble and variant', () => {
    assert.match(DEC.plausible(pkt({ msb: 0n, lsb: 0n }), registry, overworld), /uuid is zero/)
    assert.match(DEC.plausible(pkt({ msb: 0x1122334455667788n }), registry, overworld), /uuid not RFC-4122/) // version nibble 7
    assert.match(DEC.plausible(pkt({ lsb: -0x0102030405060708n }), registry, overworld), /uuid not RFC-4122/) // variant f
    assert.strictEqual(DEC.plausible(pkt({ msb: 0x1122334455663788n }), registry, overworld), null, 'v3 (name-based, offline-mode style) is a legal RFC-4122 uuid')
  })
  it('type id >= the synced registry size (and any id the registry lacks) is refused when the map is held; no map = no type bound', () => {
    assert.match(DEC.plausible(pkt({ typeId: 10 }), registry, overworld), /type id 10 >= synced entity_type registry size \(10 ids\)/)
    const sparse = new Map([[0, 'a'], [5, 'b'], [9, 'c']])
    assert.match(DEC.plausible(pkt({ typeId: 1 }), sparse, overworld), /type id 1 outside the synced entity_type registry \(3 ids\)/)
    assert.strictEqual(DEC.plausible(pkt({ typeId: 5 }), sparse, overworld), null)
    assert.strictEqual(DEC.plausible(pkt({ typeId: 4000 }), null, overworld), null)
  })
  it('NaN / Infinity / subnormal coordinates and absurd velocities are refused', () => {
    assert.match(DEC.plausible(pkt({ y: NaN }), registry, overworld), /y not a finite number/)
    assert.match(DEC.plausible(pkt({ x: Infinity }), registry, overworld), /x not a finite number/)
    assert.match(DEC.plausible(pkt({ z: 5e-324 }), registry, overworld), /z subnormal/)
    assert.strictEqual(DEC.plausible(pkt({ z: 0 }), registry, overworld), null)
    assert.match(DEC.plausible(pkt({ vel: [0, 31201, 0] }), registry, overworld), /velocityY 31201 beyond the loader's/)
    assert.strictEqual(DEC.plausible(pkt({ vel: [31200, -31200, 0] }), registry, overworld), null)
  })
  it('exact byte accounting: a length-prefixed tail must end the body; trailing garbage is a parse error, never a spawn', () => {
    const d = decodeLoaderSpawn(spec, encodeSpawn(spec, { tail: Buffer.from([3, 0xaa, 0xbb, 0xcc]) }))
    assert.strictEqual(d.roles.custom.length, 3)
    assert.throws(() => decodeLoaderSpawn(spec, encodeSpawn(spec, { tail: Buffer.from([3, 0xaa, 0xbb, 0xcc, 0xdd]) })), /1 trailing byte\(s\)/)
    assert.throws(() => decodeLoaderSpawn(spec, encodeSpawn(spec, { tail: Buffer.from([9, 0xaa]) })), /custom-data length 9 past end/)
    assert.throws(() => decodeLoaderSpawn(spec, Buffer.concat([encodeSpawn(spec), Buffer.from([1])])), /trailing/)
  })
  it('a remainder tail (older builds hand the buffer itself over) consumes the rest — nothing to account', () => {
    const rem = deriveLoaderSpawnCodec(writeJar(synthJar({ spawn: { opaqueTail: false } }), 'gate-rem.jar'))
    assert.strictEqual(rem.fields[12].tail, 'remainder')
    const d = decodeLoaderSpawn(rem, encodeSpawn(rem, { tail: Buffer.from([1, 2, 3, 4, 5]) }))
    assert.strictEqual(d.roles.custom.length, 5)
  })
  it('a helper whose tail shape cannot be read makes the derivation ABSTAIN (no accounting possible)', () => {
    const spec = deriveLoaderSpawnCodec(writeJar(synthJar({ spawn: { tailShape: 'unknown' } }), 'gate-unk.jar'))
    assert.strictEqual(spec.ok, false)
    assert.match(spec.reason, /opaque tail shape underivable/)
  })
  it('the D3 rig\'s real spawn bodies (red_merchant 131 @ 29.5,67,36.5 / hat_stand 130 @ 35.5,67,36.5, javap layout) still decode and synthesize through the hook, dimension-bound', () => {
    const rig = new Map([[130, 'supplementaries:hat_stand'], [131, 'supplementaries:red_merchant'], [7, 'synth:thing']])
    const c = new EventEmitter(); c.version = '1.20.1'; c.forgeRegistries = { entity_type: rig }; c.forgeModData = { mods: { forge: { version: '1.0' } } }
    const inst = path.join(tmp, 'inst-rig'); const mods = path.join(inst, 'mods'); const dir = path.join(inst, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-1.0')
    fs.mkdirSync(mods, { recursive: true }); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'forge-1.20.1-1.0-universal.jar'), synthJar())
    const spawns = []; c.on('spawn_entity', (p) => spawns.push(p))
    installLoaderSpawnDecoder(c, { modsPaths: [mods] }, { family: 'forge' })
    c.emit('packet', { dimensionCodec: dimensionCodecNbt(), worldType: 'minecraft:overworld', worldName: 'minecraft:overworld' }, { name: 'login', state: 'play' })
    assert.deepStrictEqual(worldBoundsOf(c), { minY: -64, height: 384, dimension: 'overworld' })
    const st = c.loaderSpawn
    c.emit('packet', { channel: 'synth:play', data: encodeSpawn(st.spec, { typeId: 131, entityId: 145, x: 29.5, y: 67, z: 36.5, vel: [0, 0, 0] }) }, { name: 'custom_payload', state: 'play' })
    c.emit('packet', { channel: 'synth:play', data: encodeSpawn(st.spec, { typeId: 130, entityId: 146, x: 35.5, y: 67, z: 36.5, vel: [0, 0, 0], msb: 0x0123456789ab4defn, lsb: BigInt.asIntN(64, 0xa123456789abcdefn) }) }, { name: 'custom_payload', state: 'play' })
    assert.strictEqual(spawns.length, 2)
    assert.deepStrictEqual(spawns.map((p) => [p.entityId, p.type, p.x, p.y, p.z]), [[145, 131, 29.5, 67, 36.5], [146, 130, 35.5, 67, 36.5]])
    assert.strictEqual(st.refused, 0); assert.strictEqual(st.parseErrors, 0); assert.strictEqual(st.loaderPayloads, 0, 'synth namespace is not a loader namespace')
    // and the same red_merchant body at y = 5000 in the overworld is refused, counted, named
    c.emit('packet', { channel: 'synth:play', data: encodeSpawn(st.spec, { typeId: 131, entityId: 147, x: 29.5, y: 5000, z: 36.5, vel: [0, 0, 0] }) }, { name: 'custom_payload', state: 'play' })
    assert.strictEqual(spawns.length, 2); assert.strictEqual(st.refused, 1); assert.match(st.lastRefusal, /above the dimension ceiling \(320\)/)
  })
})

describe('D3 rider — wire-proved loader family outranks the install family; loader payloads counted truthfully', () => {
  // a launcher-shaped instance with the given loader jars, a client whose wire said what the caller claims
  function rigClient ({ mc = '1.20.2', forgeJars = [], neoJars = [], modList = null, modData = null, installFamily = 'forge', tag = null, name = 'rig' } = {}) {
    const inst = path.join(tmp, `wire-${name}`)
    const mods = path.join(inst, 'mods'); fs.mkdirSync(mods, { recursive: true })
    for (const v of forgeJars) { const d = path.join(inst, 'Install', 'libraries', 'net', 'minecraftforge', 'forge', v); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `forge-${v}-universal.jar`), synthJar()) }
    for (const v of neoJars) { const d = path.join(inst, 'Install', 'libraries', 'net', 'neoforged', 'neoforge', v); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `neoforge-${v}-universal.jar`), synthJar()) }
    const client = new EventEmitter(); client.version = mc
    client.forgeRegistries = { entity_type: new Map([[7, 'synth:thing']]) }
    if (modList) client.forgeModList = modList
    if (modData) client.forgeModData = modData
    if (tag) client.tagHost = tag
    const spawns = []; const announced = []
    client.on('spawn_entity', (p) => spawns.push(p)); client.on('loaderSpawnDecoder', (s) => announced.push(s))
    installLoaderSpawnDecoder(client, { modsPaths: [mods] }, { family: installFamily })
    const play = (n, p) => client.emit('packet', p, { name: n, state: 'play' })
    return { client, spawns, announced, play }
  }

  it('NeoForge 20.2 wire (FML3 mod list names neoforge 20.2.88) + only a same-MC forge-1.20.2 jar in the shared tree → ABSTAIN naming the foreign jar; payloads counted attempted/abstained', () => {
    const { client, spawns, announced, play } = rigClient({ name: 'foreign', forgeJars: ['1.20.2-48.1.0'], modList: { mods: ['minecraft', 'neoforge', 'somemod'], channels: [], registries: [] }, modData: { mods: { neoforge: { version: '20.2.88' } } } })
    play('login', {})
    const st = client.loaderSpawn
    assert.strictEqual(st.status, 'abstained')
    assert.strictEqual(st.wireFamily, 'neoforge'); assert.strictEqual(st.family, 'neoforge'); assert.strictEqual(st.installFamily, 'forge'); assert.strictEqual(st.jarFamily, null)
    assert.match(st.reason, /no neoforge universal jar/)
    assert.match(st.reason, /server announced neoforge 20\.2\.88/)
    assert.match(st.reason, /family proved by the wire: mod list names neoforge 20\.2\.88/)
    assert.match(st.reason, /1 foreign-family loader jar\(s\) present \(forge 1\.20\.2-48\.1\.0\) — a foreign loader family is never borrowed/)
    assert.strictEqual(announced.length, 1)
    play('custom_payload', { channel: 'fml:play', data: Buffer.from([0, 1, 2, 3]) })
    play('custom_payload', { channel: 'fml:play', data: Buffer.from([1, 1]) })
    play('custom_payload', { channel: 'other:thing', data: Buffer.from([1]) })
    assert.strictEqual(spawns.length, 0)
    assert.strictEqual(st.loaderPayloads, 2, 'attempted: every loader-family payload, whatever the arm status')
    assert.strictEqual(st.abstainedPayloads, 2)
    const snap = snapshot(st)
    assert.strictEqual(snap.decoded, 0); assert.strictEqual(snap.loaderPayloads, 2); assert.strictEqual(snap.wireFamily, 'neoforge'); assert.strictEqual(snap.jar, null)
  })

  it('the same wire with a local neoforge 20.2.88 jar → the neoforge locator arms it (server-announced build honored)', () => {
    const { client, spawns, play } = rigClient({ name: 'neo', forgeJars: ['1.20.2-48.1.0'], neoJars: ['20.2.88', '20.2.20'], modList: { mods: ['neoforge'], channels: [], registries: [] }, modData: { mods: { neoforge: { version: '20.2.88' } } } })
    play('login', {})
    const st = client.loaderSpawn
    assert.strictEqual(st.status, 'derived'); assert.strictEqual(st.jarFamily, 'neoforge'); assert.strictEqual(st.jarVersion, '20.2.88'); assert.strictEqual(st.matchedPreferred, true)
    assert.strictEqual(path.basename(st.jar), 'neoforge-20.2.88-universal.jar')
    play('custom_payload', { channel: 'synth:play', data: encodeSpawn(st.spec) })
    assert.strictEqual(spawns.length, 1); assert.strictEqual(st.synthesized, 1)
  })

  it('Forge wire (mod list names forge) keeps the forge locator; a neoforge jar nearby is the foreign one', () => {
    const { client, play } = rigClient({ name: 'forge', mc: '1.20.1', forgeJars: ['1.20.1-47.2.0'], neoJars: ['21.1.248'], modList: { mods: ['minecraft', 'forge'], channels: [], registries: [] }, modData: { mods: { forge: { version: '47.2.0' } } } })
    play('login', {})
    const st = client.loaderSpawn
    assert.strictEqual(st.status, 'derived'); assert.strictEqual(st.wireFamily, 'forge'); assert.strictEqual(st.jarFamily, 'forge'); assert.strictEqual(st.jarVersion, '1.20.1-47.2.0'); assert.strictEqual(st.matchedPreferred, true)
    const { client: c2 } = rigClient({ name: 'forge-none', mc: '1.20.1', neoJars: ['21.1.248'], modList: { mods: ['forge'], channels: [], registries: [] } })
    c2.emit('packet', {}, { name: 'login', state: 'play' })
    assert.match(c2.loaderSpawn.reason, /foreign-family loader jar\(s\) present \(neoforge 21\.1\.248\)/)
  })

  it('an unproven wire (no mod list) falls back to the install family; the host tag proves the forge line only', () => {
    const { client, play } = rigClient({ name: 'tag', mc: '1.20.1', forgeJars: ['1.20.1-47.2.0'], tag: '\0FML3\0' })
    play('login', {})
    assert.strictEqual(client.loaderSpawn.wireFamily, 'forge'); assert.match(client.loaderSpawn.wireEvidence, /handshake host tag/)
    const { client: c2 } = rigClient({ name: 'none', mc: '1.20.1', forgeJars: ['1.20.1-47.2.0'] })
    c2.emit('packet', {}, { name: 'login', state: 'play' })
    assert.strictEqual(c2.loaderSpawn.wireFamily, null); assert.strictEqual(c2.loaderSpawn.family, 'forge'); assert.strictEqual(c2.loaderSpawn.status, 'derived')
  })

  it('a later payload that PROVES the other family disarms the armed codec (abstain, counted, one announce); a same-line other channel is only counted', () => {
    const { client, spawns, announced, play } = rigClient({ name: 'late', mc: '1.20.1', forgeJars: ['1.20.1-47.2.0'] })
    play('login', {})
    const st = client.loaderSpawn
    assert.strictEqual(st.status, 'derived'); assert.strictEqual(announced.length, 1)
    play('custom_payload', { channel: 'fml:play', data: Buffer.from([1, 2]) }) // forge line, other channel: counted, still armed
    assert.strictEqual(st.otherChannel, 1); assert.strictEqual(st.status, 'derived'); assert.strictEqual(st.loaderPayloads, 1)
    play('custom_payload', { channel: 'neoforge:advanced_add_entity', data: Buffer.from([1, 2]) })
    assert.strictEqual(st.status, 'abstained'); assert.strictEqual(st.disarmedFrom, 'synth:play'); assert.strictEqual(st.otherChannel, 2); assert.strictEqual(st.abstainedPayloads, 1); assert.strictEqual(st.loaderPayloads, 2)
    assert.match(st.reason, /disarmed: the wire carries neoforge:advanced_add_entity \(neoforge family\) but the armed codec synth:play#0 came from a forge jar \(forge-1\.20\.1-47\.2\.0-universal\.jar\)/)
    assert.strictEqual(announced.length, 2)
    play('custom_payload', { channel: 'synth:play', data: encodeSpawn(st.spec) })
    assert.strictEqual(spawns.length, 0, 'disarmed: nothing synthesizes')
    assert.strictEqual(st.loaderPayloads, 2)
  })

  it('LOW-2: the codec derives at the mod-list hook (forgeMods), off the first PLAY packet path; PLAY entry is the fallback', () => {
    const { client, announced, play } = rigClient({ name: 'hook', mc: '1.20.1', forgeJars: ['1.20.1-47.2.0'] })
    client.forgeModList = { mods: ['forge'], channels: [], registries: [] }
    client.emit('forgeMods', ['forge'])
    assert.strictEqual(client.loaderSpawn.status, 'derived'); assert.strictEqual(client.loaderSpawn.derivedAt, 'mod-list'); assert.strictEqual(client.loaderSpawn.wireFamily, 'forge')
    play('login', {})
    assert.strictEqual(announced.length, 1, 'not re-derived on PLAY entry')
    const { client: c2 } = rigClient({ name: 'fallback', mc: '1.20.1', forgeJars: ['1.20.1-47.2.0'] })
    c2.emit('packet', {}, { name: 'login', state: 'play' })
    assert.strictEqual(c2.loaderSpawn.derivedAt, 'play-entry')
  })

  it('wireFamily ranks: mod list > identity fact > host tag', () => {
    const c = new EventEmitter()
    assert.deepStrictEqual(DEC.wireFamily(c), { family: null, evidence: null })
    c.tagHost = '\0FORGE'; assert.strictEqual(DEC.wireFamily(c).family, 'forge')
    c.minepalLoaderIdentity = { loader: 'neoforge-config' }; assert.strictEqual(DEC.wireFamily(c).family, 'neoforge')
    c.forgeModList = [{ id: 'forge', version: '48.1.0' }]; assert.deepStrictEqual(DEC.wireFamily(c), { family: 'forge', evidence: 'mod list names forge 48.1.0' })
    assert.strictEqual(DEC.namespaceFamily('fml:play'), 'forge-line'); assert.strictEqual(DEC.namespaceFamily('forge:handshake'), 'forge-line'); assert.strictEqual(DEC.namespaceFamily('neoforge:advanced_add_entity'), 'neoforge'); assert.strictEqual(DEC.namespaceFamily('minecraft:brand'), null)
  })
})

describe('D3 rider — ground truth on the rig\'s own Forge 1.20.1 jar (MINEPAL_D3_FORGE_JAR)', function () {
  const jar = process.env.MINEPAL_D3_FORGE_JAR
  const present = jar && fs.existsSync(jar)
  it('derives a length-prefixed tail and decodes the rig\'s red_merchant / hat_stand bodies; the fuzz class is refused', function () {
    if (!present) return this.skip()
    D._cache.clear()
    const spec = deriveLoaderSpawnCodec(jar)
    assert.strictEqual(spec.ok, true); assert.strictEqual(spec.channel, 'fml:play'); assert.strictEqual(spec.fields[12].tail, 'length-prefixed')
    const registry = new Map([[130, 'supplementaries:hat_stand'], [131, 'supplementaries:red_merchant']])
    for (const [typeId, entityId, x, y, z] of [[131, 145, 29.5, 67, 36.5], [130, 146, 35.5, 67, 36.5]]) {
      const p = vanillaSpawnPacket(decodeLoaderSpawn(spec, encodeSpawn(spec, { typeId, entityId, x, y, z, vel: [0, 0, 0] })).roles)
      assert.strictEqual(DEC.plausible(p, registry, { minY: -64, height: 384 }), null)
      assert.deepStrictEqual([p.entityId, p.type, p.x, p.y, p.z], [entityId, typeId, x, y, z])
    }
    const through = fuzzThrough(spec, registry, { minY: -64, height: 384 })
    assert.ok(through <= 2, `fuzz bodies synthesized: ${through}/20000 (the old gate: 687)`)
  })
})

// the verifier's fuzz shape (20000 random 60-byte bodies behind index 0), SEEDED so the pin is deterministic
function fuzzThrough (spec, registry, bounds, seed = 0x9e3779b9) {
  let s = seed >>> 0
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s & 0xff }
  let through = 0
  for (let k = 0; k < 20000; k++) {
    const b = Buffer.alloc(61); b[0] = 0; for (let i = 1; i < 61; i++) b[i] = next()
    try { const d = decodeLoaderSpawn(spec, b); if (!DEC.plausible(vanillaSpawnPacket(d.roles), registry, bounds)) through++ } catch { /* parse error = refused */ }
  }
  return through
}

describe('D3 rider — the verifier\'s fuzz on the synthetic (same-layout) codec', () => {
  it('20000 seeded garbage bodies: ≤ 2 pass the gate with the registry held, ≤ 2 without (the old gate: 687 / 1321)', () => {
    D._cache.clear()
    const spec = deriveLoaderSpawnCodec(writeJar(synthJar(), 'fuzz.jar'))
    const registry = new Map(); for (let i = 0; i < 140; i++) registry.set(i, 'reg:' + i)
    const held = fuzzThrough(spec, registry, { minY: -64, height: 384 })
    const none = fuzzThrough(spec, null, null)
    assert.ok(held <= 2, `registry held: ${held}/20000`)
    assert.ok(none <= 2, `no registry: ${none}/20000`)
  })
})
