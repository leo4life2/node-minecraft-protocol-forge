// D3 — the loader custom-spawn DECODER: decodes the loader's own SpawnEntity
// message (Forge `fml:play`#0 on 1.16–1.20.1 + NeoForge 20.2,
// `forge:handshake`#7 on Forge 1.20.2–1.20.4 — every fact derived from the
// local loader jar by loaderSpawnDerivation.js) and SYNTHESIZES the vanilla
// `spawn_entity` event mineflayer's entities plugin already understands, so a
// modded entity whose getAddEntityPacket goes through the loader's
// NetworkHooks enters the bot's world model TYPED (entityType = the registry
// id the same registry sync names) instead of as a typeless id minted from
// its follow-up metadata/equipment packets.
//
// Laws:
//   - ABSTAIN, never guess: no local loader jar, or a jar whose codec cannot
//     be derived, means NO synthesis — receipted on client.loaderSpawn and
//     announced once through the `loaderSpawnDecoder` event; the payloads
//     are counted so the gap is visible, never silent.
//   - COMPANION payloads (NeoForge 20.4+ advanced_add_entity: entityId +
//     custom bytes next to a vanilla add_entity) synthesize nothing — the
//     vanilla spawn already arrived.
//   - IDEMPOTENT on entityId: an id the connection has already spawned
//     (vanilla `spawn_entity` or an earlier synthesis) and not yet destroyed
//     is never re-spawned; ids are released on entity_destroy and on a
//     login/respawn (dimension change) world reset.
//   - SANITY-GATED: a decoded message whose fields are not plausible (index
//     mismatch, non-positive entity id, non-finite/out-of-world position, a
//     type id outside the registry the connection holds when it holds one)
//     is refused and counted, never synthesized.
//   - PROTOCOL-FAITHFUL emission: the synthesized event carries exactly the
//     vanilla `spawn_entity` field names mineflayer consumes (entityId,
//     objectUUID, type, x/y/z, pitch/yaw/headPitch, objectData, velocity*),
//     emitted on the client the way neoForgeConfig's custom_time_packet →
//     update_time translation already does.
'use strict'

const path = require('path')
const debug = require('../../debug')
const { deriveLoaderSpawnCodec } = require('./loaderSpawnDerivation')
const { pickForgeLoaderJars, pickNeoForgeLoaderJars } = require('./neoForgeLoaderLocator')

const WORLD_LIMIT = 3.2e7

// --- wire primitives ---------------------------------------------------------------

function readVarInt (buf, off) {
  let result = 0
  let shift = 0
  for (;;) {
    if (off >= buf.length) throw new Error('varint past end')
    const b = buf[off++]
    result |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7
    if (shift > 35) throw new Error('varint too long')
  }
  return { value: result | 0, off }
}
function readVarLong (buf, off) {
  let result = 0n
  let shift = 0n
  for (;;) {
    if (off >= buf.length) throw new Error('varlong past end')
    const b = buf[off++]
    result |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7n
    if (shift > 70n) throw new Error('varlong too long')
  }
  return { value: BigInt.asIntN(64, result), off }
}
function uuidString (msb, lsb) {
  const hex = (BigInt.asUintN(64, msb).toString(16).padStart(16, '0') + BigInt.asUintN(64, lsb).toString(16).padStart(16, '0'))
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Read one field of `kind` at `off`; returns {value, off}. Throws on truncation. */
function readKind (buf, off, kind) {
  const need = (n) => { if (off + n > buf.length) throw new Error(`${kind} past end`) }
  switch (kind) {
    case 'varint': return readVarInt(buf, off)
    case 'varlong': return readVarLong(buf, off)
    case 'i32': need(4); return { value: buf.readInt32BE(off), off: off + 4 }
    case 'i64': need(8); return { value: buf.readBigInt64BE(off), off: off + 8 }
    case 'f64': need(8); return { value: buf.readDoubleBE(off), off: off + 8 }
    case 'f32': need(4); return { value: buf.readFloatBE(off), off: off + 4 }
    case 'i8': need(1); return { value: buf.readInt8(off), off: off + 1 }
    case 'u8': need(1); return { value: buf[off], off: off + 1 }
    case 'i16': need(2); return { value: buf.readInt16BE(off), off: off + 2 }
    case 'u16': need(2); return { value: buf.readUInt16BE(off), off: off + 2 }
    case 'bool': need(1); return { value: buf[off] !== 0, off: off + 1 }
    case 'uuid': { need(16); const msb = buf.readBigInt64BE(off); const lsb = buf.readBigInt64BE(off + 8); return { value: uuidString(msb, lsb), off: off + 16 } }
    case 'bytes': { const n = readVarInt(buf, off); need(n.off - off + n.value); return { value: buf.slice(n.off, n.off + n.value), off: n.off + n.value } }
    case 'string': { const n = readVarInt(buf, off); need(n.off - off + n.value); return { value: buf.toString('utf8', n.off, n.off + n.value), off: n.off + n.value } }
    case 'opaque': return { value: buf.slice(off), off: buf.length }
    default: throw new Error(`unknown field kind ${kind}`)
  }
}

/**
 * Decode one loader spawn message body against a derived spec.
 * @returns {{index:number, roles:object}|{skip:'other-index', index:number}}
 */
function decodeLoaderSpawn (spec, data) {
  let off = 0
  const idx = readKind(data, off, spec.indexWidth === 'u8' ? 'u8' : 'varint')
  off = idx.off
  if (idx.value !== spec.index) return { skip: 'other-index', index: idx.value }
  const roles = {}
  for (const f of spec.fields) {
    const r = readKind(data, off, f.kind)
    off = r.off
    if (f.role) roles[f.role] = r.value
  }
  return { index: idx.value, roles }
}

/** The vanilla spawn_entity-shaped packet for decoded roles. */
function vanillaSpawnPacket (roles) {
  const num = (v) => (typeof v === 'bigint' ? Number(v) : v)
  return {
    entityId: num(roles.entityId),
    objectUUID: roles.uuid || '00000000-0000-0000-0000-000000000000',
    type: num(roles.type),
    x: roles.x,
    y: roles.y,
    z: roles.z,
    pitch: num(roles.pitch) || 0,
    yaw: num(roles.yaw) || 0,
    headPitch: num(roles.headYaw) || 0,
    objectData: 0,
    velocityX: num(roles.velX) || 0,
    velocityY: num(roles.velY) || 0,
    velocityZ: num(roles.velZ) || 0
  }
}

function plausible (pkt, registry) {
  if (!Number.isInteger(pkt.entityId) || pkt.entityId <= 0) return 'entity id not positive'
  if (!Number.isInteger(pkt.type) || pkt.type < 0) return 'type id negative'
  for (const k of ['x', 'y', 'z']) { if (typeof pkt[k] !== 'number' || !Number.isFinite(pkt[k]) || Math.abs(pkt[k]) > WORLD_LIMIT) return `${k} out of world` }
  if (registry && registry.size > 0 && !registry.has(pkt.type)) return `type id ${pkt.type} outside the synced entity_type registry (${registry.size} ids)`
  return null
}

// --- jar selection -----------------------------------------------------------------

function modsPathsOf (options) {
  const raw = (options && (options.modsPaths || options.owoModsPaths)) || process.env.MINEPAL_FORGE_MODS_DIR || ''
  return (Array.isArray(raw) ? raw : String(raw).split(path.delimiter)).map((s) => s.trim()).filter(Boolean)
}
function announcedForgeVersion (client, options) {
  try {
    const fromData = client.forgeModData && client.forgeModData.mods && client.forgeModData.mods.forge && client.forgeModData.mods.forge.version
    if (fromData) return String(fromData)
    const fromPing = options && options.pingModVersions && options.pingModVersions.forge
    if (fromPing) return String(fromPing)
    if (Array.isArray(client.forgeModList)) {
      const m = client.forgeModList.find((x) => x && (x.id === 'forge' || x.modid === 'forge'))
      if (m && m.version) return String(m.version)
    }
  } catch { /* wire truth absent */ }
  return null
}

function selectLoaderJar (client, options, family) {
  const paths = modsPathsOf(options)
  if (family === 'neoforge') {
    const pick = pickNeoForgeLoaderJars(paths, { preferredVersion: options && options.neoForgeServerBuild ? options.neoForgeServerBuild : null })
    return { jar: pick.jars[0] || null, version: pick.version, matchedPreferred: pick.matchedPreferred, paths }
  }
  const mc = client.version || null
  const forgeVersion = announcedForgeVersion(client, options)
  const pick = pickForgeLoaderJars(paths, { mcVersion: mc, preferredVersion: mc && forgeVersion ? `${mc}-${forgeVersion}` : null })
  return { jar: pick.jars[0] || null, version: pick.version, matchedPreferred: pick.matchedPreferred, announced: forgeVersion, paths }
}

// --- the client hook -----------------------------------------------------------------

/**
 * Install the loader custom-spawn decoder on a Forge-family client.
 * @param {object} client node-minecraft-protocol client
 * @param {object} options the handshake options (modsPaths / pingModVersions …)
 * @param {{family:'forge'|'neoforge'}} [opts]
 */
function installLoaderSpawnDecoder (client, options, opts) {
  if (client.loaderSpawn) return client.loaderSpawn // one per connection
  const family = (opts && opts.family) || 'forge'
  const state = {
    family,
    status: 'pending', // pending | derived | companion | abstained
    reason: null,
    jar: null,
    jarVersion: null,
    matchedPreferred: false,
    channel: null,
    index: null,
    indexWidth: null,
    fields: null,
    payloadsSeen: 0, // custom payloads on the derived channel
    decoded: 0, // spawn messages decoded on the derived channel/index
    synthesized: 0, // vanilla spawn_entity events emitted
    duplicates: 0, // decoded but the id was already live
    refused: 0, // decoded but implausible
    otherIndex: 0, // other messages on the same channel (OpenContainer …)
    parseErrors: 0,
    abstainedPayloads: 0, // loader-spawn-looking payloads seen while abstained
    lastError: null,
    live: new Set()
  }
  client.loaderSpawn = state

  const announce = () => {
    try { client.emit('loaderSpawnDecoder', snapshot(state)) } catch { /* receipts never break the packet path */ }
  }

  function derive () {
    if (state.status !== 'pending') return
    const sel = selectLoaderJar(client, options, family)
    state.jar = sel.jar
    state.jarVersion = sel.version
    state.matchedPreferred = !!sel.matchedPreferred
    if (!sel.jar) {
      state.status = 'abstained'
      state.reason = `no ${family} universal jar found near the mods folder(s) (${sel.paths.length} configured${sel.announced ? `; server announced ${family} ${sel.announced}` : ''}) — loader custom-spawn entities stay typeless`
      debug(`loader spawn decoder ABSTAINED: ${state.reason}`)
      announce()
      return
    }
    const spec = deriveLoaderSpawnCodec(sel.jar)
    if (!spec.ok) {
      state.status = 'abstained'
      state.reason = `codec not derivable from ${path.basename(sel.jar)}: ${spec.reason}`
      debug(`loader spawn decoder ABSTAINED: ${state.reason}`)
      announce()
      return
    }
    state.channel = spec.channel
    state.fields = spec.fields
    if (spec.kind === 'companion') {
      state.status = 'companion'
      state.reason = spec.reason
      debug(`loader spawn decoder: ${spec.channel} is a companion payload on ${path.basename(sel.jar)} — vanilla spawn_entity carries the spawn, nothing to synthesize`)
      announce()
      return
    }
    state.status = 'derived'
    state.index = spec.index
    state.indexWidth = spec.indexWidth
    state.spec = spec
    debug(`loader spawn decoder armed: ${spec.channel}#${spec.index} (${spec.indexWidth} index, ${spec.indexDerivation}) from ${path.basename(sel.jar)}${state.matchedPreferred ? ' (server-announced build)' : ''}`)
    announce()
  }

  // world-model liveness for idempotence
  client.on('spawn_entity', (p) => { if (p && Number.isInteger(p.entityId)) state.live.add(p.entityId) })
  client.on('named_entity_spawn', (p) => { if (p && Number.isInteger(p.entityId)) state.live.add(p.entityId) })
  client.on('entity_destroy', (p) => {
    const ids = p && (p.entityIds || (Number.isInteger(p.entityId) ? [p.entityId] : []))
    for (const id of ids || []) state.live.delete(id)
  })
  client.on('login', () => state.live.clear())
  client.on('respawn', () => state.live.clear())

  client.on('packet', (packet, meta) => {
    if (!meta || meta.state !== 'play') return
    if (state.status === 'pending') derive()
    if (meta.name !== 'custom_payload' || !packet) return
    if (state.status === 'companion') { if (packet.channel === state.channel) state.payloadsSeen++; return }
    if (state.status !== 'derived') {
      // abstained: count what we could not decode so the gap is visible
      if (/^(fml|forge|neoforge):(play|handshake|advanced_add_entity)$/.test(String(packet.channel))) state.abstainedPayloads++
      return
    }
    if (packet.channel !== state.channel) return
    state.payloadsSeen++
    let decoded
    try {
      decoded = decodeLoaderSpawn(state.spec, packet.data || Buffer.alloc(0))
    } catch (err) {
      state.parseErrors++
      state.lastError = err.message
      if (state.parseErrors === 1) debug(`loader spawn decode failed on ${state.channel}: ${err.message}`)
      return
    }
    if (decoded.skip) { state.otherIndex++; return }
    state.decoded++
    const pkt = vanillaSpawnPacket(decoded.roles)
    const registry = client.forgeRegistries && client.forgeRegistries.entity_type
    const why = plausible(pkt, registry instanceof Map ? registry : null)
    if (why) {
      state.refused++
      state.lastError = why
      if (state.refused === 1) debug(`loader spawn refused (${why}) — not synthesized`)
      return
    }
    if (state.live.has(pkt.entityId)) { state.duplicates++; return }
    state.live.add(pkt.entityId)
    state.synthesized++
    const name = registry instanceof Map ? (registry.get(pkt.type) || null) : null
    try { client.emit('spawn_entity', pkt, { name: 'spawn_entity', state: 'play', synthesizedFrom: state.channel }) } catch (err) { state.lastError = `emit: ${err.message}` }
    try { client.emit('loaderSpawnEntity', { channel: state.channel, index: state.index, typeId: pkt.type, name, entityId: pkt.entityId, uuid: pkt.objectUUID, x: pkt.x, y: pkt.y, z: pkt.z, jar: state.jar ? path.basename(state.jar) : null }) } catch { /* receipts never break the packet path */ }
  })

  return state
}

function snapshot (state) {
  if (!state) return null
  const { live, spec, ...rest } = state
  return { ...rest, jar: state.jar ? path.basename(state.jar) : null, liveIds: live ? live.size : 0 }
}

module.exports = { installLoaderSpawnDecoder, decodeLoaderSpawn, vanillaSpawnPacket, snapshot, _internal: { readKind, readVarInt, uuidString, plausible, selectLoaderJar, announcedForgeVersion } }
