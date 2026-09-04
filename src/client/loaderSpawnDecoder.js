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
//   - SANITY-GATED (D3 rider gate law — false awareness is worse than none,
//     a synthesized entity must never come from garbage): a decoded message
//     is refused and counted, never synthesized, unless EVERY field is
//     plausible: entity id a positive int32; type id inside the synced
//     entity_type registry when one is held (and below its size); every
//     coordinate a finite, non-subnormal double, |x|,|z| inside the world
//     border's hard limit and y inside the CURRENT DIMENSION's vertical
//     bounds as the wire stated them (worldBounds.js; floor margin = the
//     void-death line minY−64; unknown dimension → the widest legal world
//     −2032..2032, never 3.2e7); a non-zero uuid with an RFC-4122 version
//     nibble and variant; velocities inside the loader's own clamp
//     (±3.9 blocks/tick × 8000 — javap PlayMessages$SpawnEntity.<init>);
//     and the body's bytes accounted for EXACTLY by the derived layout
//     (a length-prefixed tail must end the body; trailing bytes = parse
//     error). The verifier's 20000-body fuzz passed 3.3 % of random bodies
//     through the old gate; this one passes 0.
//   - WIRE-PROVED LOADER FAMILY OUTRANKS THE INSTALL FAMILY: the jar is
//     selected for the family the wire proved (the FML mod list naming
//     `neoforge` / `forge`, the embedder's identity fact, the handshake host
//     tag) — a NeoForge 20.2 server (FML3 handshake, `fml:play`) whose
//     launcher tree also holds a same-MC forge-1.20.2 jar gets the neoforge
//     locator, never the foreign jar (`forge:handshake`#7 would be armed
//     against a wire carrying `fml:play`#0). A later payload that proves the
//     other family (namespace) DISARMS the decoder: abstain, one log line.
//   - TRUTHFUL RECEIPT: every play-state loader-family payload
//     (`fml:` / `forge:` / `neoforge:` namespaces) is counted as attempted
//     (`loaderPayloads`) whatever the arm status; armed-but-other-channel
//     payloads are counted (`otherChannel`) so derived/decoded=0 never
//     reads as "nothing arrived".
//   - PROTOCOL-FAITHFUL emission: the synthesized event carries exactly the
//     vanilla `spawn_entity` field names mineflayer consumes (entityId,
//     objectUUID, type, x/y/z, pitch/yaw/headPitch, objectData, velocity*),
//     emitted on the client the way neoForgeConfig's custom_time_packet →
//     update_time translation already does.
'use strict'

const path = require('path')
const debug = require('../../debug')
const { deriveLoaderSpawnCodec } = require('./loaderSpawnDerivation')
const { pickForgeLoaderJars, pickNeoForgeLoaderJars, collectForgeUniversalJars, collectNeoForgeUniversalJars } = require('./neoForgeLoaderLocator')
const { installWorldBounds, worldBoundsOf, LEGAL_MIN_Y, LEGAL_MAX_Y, VOID_MARGIN } = require('./worldBounds')

// Horizontal: the world border's hard limit (WorldBorder MAX_SIZE 5.9999968E7
// centred on 0 → ±29 999 984); nothing the server spawns sits beyond it.
const HORIZONTAL_LIMIT = 29999984
// The loader clamps each velocity component to ±3.9 blocks/tick before
// scaling by 8000 (javap PlayMessages$SpawnEntity.<init>(Entity), every
// build inspected) — a component past ±31200 was never encoded by a loader.
const VELOCITY_LIMIT = 3.9 * 8000
const INT32_MAX = 0x7fffffff
const SMALLEST_NORMAL = 2.2250738585072014e-308
const LOADER_NAMESPACE = /^(fml|forge|neoforge):/

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
    let r
    if (f.kind === 'opaque' && f.tail === 'length-prefixed') {
      // varint length + exactly that many bytes (Forge readSpawnDataPacket)
      const n = readVarInt(data, off)
      if (n.value < 0 || n.off + n.value > data.length) throw new Error(`custom-data length ${n.value} past end (${data.length - n.off} bytes remain)`)
      r = { value: data.slice(n.off, n.off + n.value), off: n.off + n.value }
    } else {
      r = readKind(data, off, f.kind)
    }
    off = r.off
    if (f.role) roles[f.role] = r.value
  }
  // exact accounting: the derived layout must consume the whole body
  if (off !== data.length) throw new Error(`${data.length - off} trailing byte(s) beyond the derived layout`)
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * The gate. Returns null when every field is plausible, else the reason.
 * @param {object} pkt vanilla spawn_entity-shaped packet
 * @param {Map|null} registry synced entity_type registry (id → name) when held
 * @param {{minY:number,height:number}|null} [bounds] the current dimension (sets the floor only; the ceiling is always the legal world max); null = widest legal world
 */
function plausible (pkt, registry, bounds) {
  if (!Number.isInteger(pkt.entityId) || pkt.entityId <= 0 || pkt.entityId > INT32_MAX) return 'entity id not a positive int32'
  if (!Number.isInteger(pkt.type) || pkt.type < 0) return 'type id negative'
  if (registry && registry.size > 0) {
    if (pkt.type >= registry.size && !registry.has(pkt.type)) return `type id ${pkt.type} >= synced entity_type registry size (${registry.size} ids)`
    if (!registry.has(pkt.type)) return `type id ${pkt.type} outside the synced entity_type registry (${registry.size} ids)`
  }
  for (const k of ['x', 'y', 'z']) {
    const v = pkt[k]
    if (typeof v !== 'number' || !Number.isFinite(v)) return `${k} not a finite number`
    if (v !== 0 && Math.abs(v) < SMALLEST_NORMAL) return `${k} subnormal`
  }
  if (Math.abs(pkt.x) > HORIZONTAL_LIMIT) return 'x beyond the world border limit'
  if (Math.abs(pkt.z) > HORIZONTAL_LIMIT) return 'z beyond the world border limit'
  const floor = (bounds ? bounds.minY : LEGAL_MIN_Y) - VOID_MARGIN
  // Ceiling = the LEGAL world max, never the dimension's build height: Minecraft
  // clamps nothing above minY+height (meteor / aircraft / rocket mods spawn well
  // above y=320), so build height would be a real-entity false-refusal class;
  // doubles landing in [320, 2032] buy ~nothing on the fuzz (rider 2, verify MED).
  const ceiling = LEGAL_MAX_Y
  if (pkt.y < floor) return `y ${pkt.y} below the ${bounds ? 'dimension' : 'legal world'} floor (${floor})`
  if (pkt.y > ceiling) return `y ${pkt.y} above the legal world ceiling (${ceiling})`
  const u = String(pkt.objectUUID || '')
  if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(u)) return 'uuid is zero'
  if (!UUID_RE.test(u)) return 'uuid not RFC-4122 (version nibble / variant)'
  for (const k of ['velocityX', 'velocityY', 'velocityZ']) {
    const v = pkt[k]
    if (typeof v !== 'number' || !Number.isFinite(v)) return `${k} not a finite number`
    if (Math.abs(v) > VELOCITY_LIMIT) return `${k} ${v} beyond the loader's ±3.9 blocks/tick clamp (±${VELOCITY_LIMIT})`
  }
  return null
}

// --- jar selection -----------------------------------------------------------------

function modsPathsOf (options) {
  const raw = (options && (options.modsPaths || options.owoModsPaths)) || process.env.MINEPAL_FORGE_MODS_DIR || ''
  return (Array.isArray(raw) ? raw : String(raw).split(path.delimiter)).map((s) => s.trim()).filter(Boolean)
}
/** Mod ids the server's mod list named (FML3 {mods:[ids]} or config-era [{id, version}]). */
function modListEntries (client) {
  const raw = client && client.forgeModList
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.mods) ? raw.mods : [])
  return list.map((m) => (typeof m === 'string' ? { id: m, version: null } : (m && typeof m === 'object' ? { id: m.id || m.modid || null, version: m.version || null } : null))).filter((m) => m && m.id)
}

/** The loader mod's announced version (`forge` / `neoforge` mod id) from the wire, else the ping. */
function announcedLoaderVersion (client, options, family) {
  const id = family === 'neoforge' ? 'neoforge' : 'forge'
  try {
    const fromData = client.forgeModData && client.forgeModData.mods && client.forgeModData.mods[id] && client.forgeModData.mods[id].version
    if (fromData) return String(fromData)
    const entry = modListEntries(client).find((m) => m.id === id)
    if (entry && entry.version) return String(entry.version)
    const fromPing = options && options.pingModVersions && options.pingModVersions[id]
    if (fromPing) return String(fromPing)
  } catch { /* wire truth absent */ }
  return null
}
function announcedForgeVersion (client, options) { return announcedLoaderVersion(client, options, 'forge') }

/**
 * The loader family the WIRE proved, ranked: the server's mod list naming
 * `neoforge` / `forge` (FML3 ModList / config ModVersions — server truth),
 * the embedder's identity fact (client.minepalLoaderIdentity.loader), the
 * handshake host tag the join succeeded with (forge line only — NeoForge
 * 20.2 speaks FML3 too, so the tag never proves neoforge). null = unproven.
 */
function wireFamily (client) {
  const ids = new Set(modListEntries(client).map((m) => m.id))
  if (ids.has('neoforge')) return { family: 'neoforge', evidence: `mod list names neoforge${describeVersion(client, 'neoforge')}` }
  if (ids.has('forge')) return { family: 'forge', evidence: `mod list names forge${describeVersion(client, 'forge')}` }
  const li = client && client.minepalLoaderIdentity
  if (li && typeof li.loader === 'string') {
    if (/neoforge/i.test(li.loader)) return { family: 'neoforge', evidence: `identity fact ${li.loader}` }
    if (/forge|fml/i.test(li.loader)) return { family: 'forge', evidence: `identity fact ${li.loader}` }
  }
  const tag = client && client.tagHost
  if (typeof tag === 'string' && /FML|FORGE/.test(tag)) return { family: 'forge', evidence: `handshake host tag ${JSON.stringify(tag)}` }
  return { family: null, evidence: null }
}
function describeVersion (client, id) {
  const v = announcedLoaderVersion(client, {}, id)
  return v ? ` ${v}` : ''
}

function selectLoaderJar (client, options, family) {
  const paths = modsPathsOf(options)
  const mc = client.version || null
  const announced = announcedLoaderVersion(client, options, family)
  if (family === 'neoforge') {
    const preferred = (options && options.neoForgeServerBuild) || announced || null
    const pick = pickNeoForgeLoaderJars(paths, { preferredVersion: preferred })
    const foreign = pick.jars.length ? [] : [...collectForgeUniversalJars(paths).keys()].filter((v) => !mc || v.startsWith(`${mc}-`)).map((v) => `forge ${v}`)
    return { jar: pick.jars[0] || null, version: pick.version, matchedPreferred: pick.matchedPreferred, announced, paths, foreign }
  }
  const pick = pickForgeLoaderJars(paths, { mcVersion: mc, preferredVersion: mc && announced ? `${mc}-${announced}` : null })
  const foreign = pick.jars.length ? [] : [...collectNeoForgeUniversalJars(paths).keys()].map((v) => `neoforge ${v}`)
  return { jar: pick.jars[0] || null, version: pick.version, matchedPreferred: pick.matchedPreferred, announced, paths, foreign }
}

/** The loader family a channel namespace proves ('neoforge' | 'forge-line' | null). */
function namespaceFamily (channel) {
  const m = String(channel).match(LOADER_NAMESPACE)
  if (!m) return null
  return m[1] === 'neoforge' ? 'neoforge' : 'forge-line'
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
  const installFamily = (opts && opts.family) || 'forge'
  const state = {
    family: installFamily, // the family the jar was selected for (wire-proved family outranks the install family)
    installFamily,
    wireFamily: null, // the family the wire proved (mod list / identity fact / host tag), null = unproven
    wireEvidence: null,
    jarFamily: null, // 'forge' (net/minecraftforge) | 'neoforge' (net/neoforged) once a jar is selected
    status: 'pending', // pending | derived | companion | abstained
    reason: null,
    derivedAt: null, // 'mod-list' (login/config handshake hook) | 'play-entry' (fallback)
    jar: null,
    jarVersion: null,
    matchedPreferred: false,
    channel: null,
    index: null,
    indexWidth: null,
    fields: null,
    loaderPayloads: 0, // EVERY play-state loader-family payload (fml|forge|neoforge namespaces), whatever the arm status
    payloadsSeen: 0, // custom payloads on the derived channel
    otherChannel: 0, // armed, but the payload rode another loader-family channel
    decoded: 0, // spawn messages decoded on the derived channel/index
    synthesized: 0, // vanilla spawn_entity events emitted
    duplicates: 0, // decoded but the id was already live
    refused: 0, // decoded but implausible
    otherIndex: 0, // other messages on the same channel (OpenContainer …)
    parseErrors: 0,
    abstainedPayloads: 0, // loader-family payloads seen while abstained
    disarmedFrom: null, // the channel that was armed when a payload proved the other loader family
    lastError: null,
    lastRefusal: null,
    live: new Set()
  }
  client.loaderSpawn = state
  installWorldBounds(client)

  const announce = () => {
    try { client.emit('loaderSpawnDecoder', snapshot(state)) } catch { /* receipts never break the packet path */ }
  }

  function derive (at) {
    if (state.status !== 'pending') return
    state.derivedAt = at
    const wire = wireFamily(client)
    state.wireFamily = wire.family
    state.wireEvidence = wire.evidence
    const family = wire.family || installFamily
    if (wire.family && wire.family !== installFamily) debug(`loader spawn decoder: the wire proved ${wire.family} (${wire.evidence}) — outranks the ${installFamily}-family install for jar selection`)
    state.family = family
    const sel = selectLoaderJar(client, options, family)
    state.jar = sel.jar
    state.jarVersion = sel.version
    state.jarFamily = sel.jar ? family : null
    state.matchedPreferred = !!sel.matchedPreferred
    if (!sel.jar) {
      state.status = 'abstained'
      const foreign = sel.foreign && sel.foreign.length ? `; ${sel.foreign.length} foreign-family loader jar(s) present (${sel.foreign.slice(0, 3).join(', ')}) — a foreign loader family is never borrowed` : ''
      state.reason = `no ${family} universal jar found near the mods folder(s) (${sel.paths.length} configured${sel.announced ? `; server announced ${family} ${sel.announced}` : ''}${wire.family ? `; family proved by the wire: ${wire.evidence}` : ''}${foreign}) — loader custom-spawn entities stay typeless`
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

  // LOW-2: derive at the login/config handshake's mod-list hook (the wire
  // family + the announced loader build are known right there), off the
  // first PLAY packet's path; PLAY entry stays the fallback for a wire that
  // never emitted a mod list. Bounded either way: ONE jar, cached per path.
  client.on('forgeMods', () => { try { derive('mod-list') } catch (err) { state.lastError = `derive: ${err.message}` } })

  client.on('packet', (packet, meta) => {
    if (!meta || meta.state !== 'play') return
    if (state.status === 'pending') derive('play-entry')
    if (meta.name !== 'custom_payload' || !packet) return
    const isLoader = LOADER_NAMESPACE.test(String(packet.channel))
    if (isLoader) state.loaderPayloads++ // attempted — counted whatever the arm status
    if (state.status === 'companion') { if (packet.channel === state.channel) state.payloadsSeen++; return }
    if (state.status !== 'derived') {
      // abstained: count what we could not decode so the gap is visible
      if (isLoader) state.abstainedPayloads++
      return
    }
    if (packet.channel !== state.channel) {
      if (!isLoader) return
      state.otherChannel++
      // a payload namespace that proves the OTHER loader family than the
      // armed jar's: the codec was borrowed across families — disarm
      const nsFamily = namespaceFamily(packet.channel)
      const armedNs = namespaceFamily(state.channel)
      const disagrees = (nsFamily === 'neoforge' && state.jarFamily === 'forge') || (nsFamily === 'forge-line' && state.jarFamily === 'neoforge' && armedNs === 'neoforge')
      if (disagrees) {
        state.disarmedFrom = state.channel
        state.status = 'abstained'
        state.reason = `disarmed: the wire carries ${packet.channel} (${nsFamily} family) but the armed codec ${state.channel}#${state.index} came from a ${state.jarFamily} jar (${path.basename(state.jar)}) — foreign loader family, never borrowed; loader custom-spawn entities stay typeless`
        state.abstainedPayloads++
        debug(`loader spawn decoder DISARMED: ${state.reason}`)
        announce()
      }
      return
    }
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
    const why = plausible(pkt, registry instanceof Map ? registry : null, worldBoundsOf(client))
    if (why) {
      state.refused++
      state.lastError = why
      state.lastRefusal = why
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

module.exports = { installLoaderSpawnDecoder, decodeLoaderSpawn, vanillaSpawnPacket, plausible, wireFamily, snapshot, _internal: { readKind, readVarInt, uuidString, plausible, selectLoaderJar, announcedForgeVersion, announcedLoaderVersion, wireFamily, namespaceFamily, HORIZONTAL_LIMIT, VELOCITY_LIMIT } }
