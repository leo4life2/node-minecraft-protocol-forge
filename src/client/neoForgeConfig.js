// NeoForge 1.20.5+ configuration-phase modded-network negotiation.
//
// NeoForge (21.x, MC 1.20.5+) dropped the login-phase FML handshake entirely.
// A modded server opens the configuration phase with an EMPTY
// `neoforge:register` query (ModdedNetworkQueryPayload) followed by a vanilla
// ping(0). What happens next is decided by which packet the client answers
// first (net.minecraft.server.network.ServerConfigurationPacketListenerImpl,
// read from the shipped 21.1.248 server bytecode):
//
//   - pong(0) with no query answer  -> ConnectionType.OTHER -> the server
//     runs NetworkComponentNegotiator against an empty client component list
//     and, when any non-optional modded channel exists, disconnects with
//     "neoforge.network.negotiation.failure.vanilla.client.not_supported".
//   - `neoforge:register` reply     -> ConnectionType.NEOFORGE -> the server
//     negotiates the client's claimed components against its own
//     PAYLOAD_REGISTRATIONS per protocol (CONFIGURATION, then PLAY).
//
// Negotiation rules (net.neoforged.neoforge.network.negotiation.
// NetworkComponentNegotiator, decompiled): optional components missing on the
// other side are silently dropped; every surviving component must exist on
// BOTH sides with a String.equals version and an identical Optional<flow>.
// So the ONLY way in is to claim, for every required server channel, the
// exact (id, version, flow, optional) tuple the server's mods registered.
// Those tuples are static facts of the modpack's jars — this module gets
// them from neoForgePayloadDerivation (the mods-folder scanner) via
// options.components.
//
// After a successful negotiation the server sends `neoforge:network`
// (NetworkPayloadSetup) and runs its configuration tasks. Which NeoForge
// tasks run is gated on the channels the CLIENT claimed (decompiled
// ConfigurationInitialization): claiming the frozen-registry trio opts into
// SyncRegistries (the server streams every synced registry's id->name map —
// exactly the per-server binding surface the knowledge layer needs);
// claiming `neoforge:known_registry_data_maps` steers RegistryDataMapNegotiation
// onto the data/reply path (required whenever any mod ships a mandatory data
// map, else the server refuses "vanilla" clients); CheckExtensibleEnums and
// CheckFeatureFlags always run for NEOFORGE-type connections and are answered
// with their unit ack payloads (acks ride the ad-hoc channel allowance for
// optional serverbound registrations, no claim needed — NetworkRegistry
// .hasAdhocChannel).
//
// HF6 — the loader contract rides TWO lawful wires (read verbatim from the
// neoforged/NeoForge 1.21.1 branch sources):
//
//   1. CLAIMS (versioned tuples in the `neoforge:register` answer) stay
//      JAR-DERIVED ONLY. Versions are negotiation inputs (String.equals) and
//      only the local universal jar gives version truth; nothing is ever
//      fabricated. Claims are additionally INTERSECTED with this responder's
//      handler contract (below): a clientbound configuration built-in we
//      cannot answer is never claimed, because several configuration tasks
//      block on a client reply and a claimed-but-ignored payload wedges the
//      phase (the no-blind-accept law).
//
//   2. LISTENING DECLARATION (new): a real NeoForge client also declares the
//      channels it listens on via the vanilla `minecraft:register` payload
//      (Dinnerbone protocol, NUL-separated ids, NO versions —
//      DinnerboneProtocolUtils.CHANNELS_CODEC; NetworkRegistry
//      .initializeNeoForgeConnection client-side). The server handles that
//      payload UNCONDITIONALLY, before any negotiation state exists
//      (ServerCommonPacketListenerImpl patch: "Neo: Unconditionally handle
//      register/unregister payloads" -> NetworkRegistry.onMinecraftRegister
//      -> the connection's AD-HOC channel set), and the send-path guard
//      consults exactly that set as its last tier (NetworkRegistry
//      .hasChannel: negotiated setup -> common channels -> ad-hoc).
//
// WHY the declaration is load-bearing (the HF6 receipt): NetworkRegistry
// .checkPacket throws UnsupportedOperationException("Payload %s may not be
// sent to the client!") for any clientbound custom payload outside the
// negotiation carriers (BUILTIN_PAYLOADS), the minecraft namespace, and
// hasChannel — killing the connection with vanilla's "Internal Exception"
// disconnect. `neoforge:extensible_enum_data` is NOT a carrier: it is a
// normal optional("1") configurationToClient registration
// (NetworkInitialization, since 21.0.127-beta / PR #1305 — every 21.1.x
// build has it), and CheckExtensibleEnums.start() sends it UNCONDITIONALLY
// to every non-memory NEOFORGE-type connection with no hasChannel gate
// (unlike its siblings: RegistryDataMapNegotiation and CheckFeatureFlags
// both gate, SyncRegistries/SyncConfig gate at registration). So a client
// that answered the query (NEOFORGE type) without claiming that channel —
// exactly what happens when no local universal jar can be found and the
// built-ins go unclaimed — makes the SERVER crash its own send. Declaring
// the handler contract over `minecraft:register` at query time (before our
// component answer, so the ad-hoc set is populated before any task runs)
// makes that send lawful with nothing invented: the declaration carries no
// versions, and every declared channel is one this stack truly implements
// (the configuration handler contract) or lawfully tolerates (the reply-free
// clientbound PLAY built-ins — see TOLERATED_CLIENTBOUND_PLAY_CHANNELS: play
// sends share the same crash class, e.g. IEntityExtension.sendPairingData
// ships neoforge:advanced_add_entity ungated for IEntityWithComplexSpawn
// entities, and the ad-hoc set is connection-scoped so one declaration
// covers both phases).
//
// Everything here is bytes-on-the-wire per the decompiled STREAM_CODECs; no
// guessing. FriendlyByteBuf primitives: varint, utf8 string (varint length),
// ResourceLocation (string), Optional (bool prefix), map (varint count of
// key/value pairs), collection (varint count), enum (varint ordinal).
// ConnectionProtocol ordinals (1.21.1): HANDSHAKING=0, PLAY=1, STATUS=2,
// LOGIN=3, CONFIGURATION=4. PacketFlow: SERVERBOUND=0, CLIENTBOUND=1.
//
// PRIVACY: same laws as the rest of this lib — reads local jars only (in the
// derivation module), never touches the network itself, never writes disk.
'use strict'

const debug = require('../../debug')

const PROTOCOL_ORDINALS = { handshaking: 0, play: 1, status: 2, login: 3, configuration: 4 }
const PROTOCOL_NAMES = ['handshaking', 'play', 'status', 'login', 'configuration']
const FLOW_ORDINALS = { serverbound: 0, clientbound: 1 }

// Registries worth stashing for naming/binding, same shape as the FML3 path:
// client.forgeRegistries[key] = Map<rawId, 'ns:path'>.
const SNAPSHOT_REGISTRIES = {
  'minecraft:item': 'item',
  'minecraft:block': 'block',
  'minecraft:entity_type': 'entity_type',
  // HF45: the server's command argument-type numbering (loader/mod parser
  // ids after the vanilla table) — the wire half of the declare_commands
  // argument-type derivation (commandArgumentTypeInstall.js)
  'minecraft:command_argument_type': 'command_argument_type'
}

// HF6 — the responder's HANDLER CONTRACT: every clientbound (or
// bidirectional) configuration-phase channel the switch below truly
// implements. This is a fact about THIS FILE, not a guess about any server:
// it is what we declare over `minecraft:register` (listening declaration)
// and the ceiling for clientbound neoforge:* configuration CLAIMS (the
// intersection law). A channel outside this list is neither declared nor
// claimed — a payload whose semantics we cannot honor is refused at the
// boundary, never silently mishandled (`neoforge:split` falls out of claims
// here by the same law: this transport cannot reassemble split payloads).
const HANDLED_CLIENTBOUND_CONFIG_CHANNELS = Object.freeze([
  'neoforge:frozen_registry_sync_start',
  'neoforge:frozen_registry',
  'neoforge:frozen_registry_sync_completed',
  'neoforge:known_registry_data_maps',
  'neoforge:extensible_enum_data',
  'neoforge:feature_flags',
  'neoforge:config_file'
])

// HF6 — the TOLERATED play-phase contract: NeoForge's clientbound PLAY
// built-ins, every one a pure informational toClient stream with NO reply
// semantics (NetworkInitialization, 1.21.1 branch: all playToClient, no
// serverbound counterpart registered; corroborated by the 21.1.248 universal
// jar derivation — the play neoforge:* set carries no serverbound flow).
// The play phase has no blocking tasks, so ignoring these is protocol-sound;
// it is also exactly what happens today when they ride the negotiated setup
// from a jar-derived claim (the play parser tolerates unknown custom
// payloads). They must be DECLARED because play sends share the receipt's
// crash class: e.g. IEntityExtension.sendPairingData ships
// `neoforge:advanced_add_entity` for every IEntityWithComplexSpawn entity
// with no hasChannel gate — a NEOFORGE-type connection that neither claimed
// nor declared it dies on the server's own send the moment such an entity
// spawns in view.
const TOLERATED_CLIENTBOUND_PLAY_CHANNELS = Object.freeze([
  'neoforge:advanced_add_entity',
  'neoforge:advanced_open_screen',
  'neoforge:auxiliary_light_data',
  'neoforge:registry_data_map_sync',
  'neoforge:advanced_container_set_data',
  'neoforge:custom_time_packet',
  'neoforge:sync_attachments'
])

// Vanilla `minecraft:register` payload body: NUL-separated channel ids, no
// versions (DinnerboneProtocolUtils.CHANNELS_CODEC, 1.21.1 branch — the
// reader splits on '\0' and parses the trailing segment too).
function encodeDinnerboneChannels (channels) {
  return Buffer.from(channels.join('\u0000'), 'utf8')
}

// HF8 — THE DECLARATION SIZE LAW. The real protocol constant, read from the
// 1.21.1 sources (vanilla lines preserved verbatim in NeoForge's
// ServerboundCustomPayloadPacket.java.patch): any serverbound custom payload
// WITHOUT a registered codec decodes as `DiscardedPayload.codec(id, 32767)`
// — for BOTH the configuration and play protocols — and an oversize frame is
// a decode exception that kills the connection. NeoForge exempts exactly its
// BUILTIN_PAYLOADS (NetworkRegistry.getCodec consults BUILTIN_PAYLOADS
// first; `neoforge:register`, `minecraft:register` et al. decode by their
// own codecs, uncapped), but the vanilla-lineage cap is the ONLY bound a
// declaration can rely on across every stack that may parse the frame
// (vanilla, Paper, proxies) — so every declaration payload we emit is bound
// to it.
//
// HOW an oversize declaration stays truthful (the HF8 adjudication order —
// drop nothing that can lawfully ride another frame):
//   - `minecraft:register` is ADDITIVE by primary source (NetworkRegistry
//     .onMinecraftRegister: `getOrCreateAdHocChannels(connection)
//     .addAll(...)` — a Set union per frame), so a large declaration SPLITS
//     into multiple well-formed register payloads, each a complete
//     NUL-separated list under the cap. Nothing is dropped; order is
//     preserved (callers put race-sensitive channels first).
//   - the `neoforge:register` component ANSWER is one atomic
//     ModdedNetworkQueryPayload with a builtin (uncapped) codec on every
//     NeoForge endpoint — it is never split and never trimmed: trimming
//     claims we lawfully hold would forfeit negotiable channels for no
//     protocol reason. Its size is RECEIPTED (state.queryAnswer) so a
//     post-answer failure names the real bytes — the sub-shape-A receipt's
//     "42,171-byte payload" was a JSON-length artifact of the diagnostics
//     tap over a ~13KB wire frame, under every real limit.
const MAX_SERVERBOUND_CUSTOM_PAYLOAD_BYTES = 32767

// Splits a channel list into Dinnerbone register frames, each encoding to at
// most MAX_SERVERBOUND_CUSTOM_PAYLOAD_BYTES. Returns an array of Buffers
// (>= 1; an empty channel list yields one empty frame). A single id that
// alone exceeds the cap cannot ride any lawful frame (real
// ResourceLocations are orders of magnitude shorter) — it is dropped
// LOUDLY, never sent malformed.
function splitDinnerboneFrames (channels, warn = (m) => console.warn(m)) {
  const frames = []
  let current = []
  let currentBytes = 0
  for (const ch of channels || []) {
    const chBytes = Buffer.byteLength(String(ch), 'utf8')
    if (chBytes > MAX_SERVERBOUND_CUSTOM_PAYLOAD_BYTES) {
      warn(`[neoforge] declaration channel id exceeds the serverbound custom-payload law (${chBytes} > ${MAX_SERVERBOUND_CUSTOM_PAYLOAD_BYTES} bytes) and cannot ride any lawful frame — dropped: ${String(ch).slice(0, 80)}...`)
      continue
    }
    const sep = current.length > 0 ? 1 : 0
    if (currentBytes + sep + chBytes > MAX_SERVERBOUND_CUSTOM_PAYLOAD_BYTES) {
      frames.push(encodeDinnerboneChannels(current))
      current = [ch]
      currentBytes = chBytes
    } else {
      current.push(ch)
      currentBytes += sep + chBytes
    }
  }
  frames.push(encodeDinnerboneChannels(current))
  return frames
}

// --- FriendlyByteBuf primitives ---

function readVarInt (buf, offset) {
  let result = 0
  let bytes = 0
  let b
  do {
    if (offset + bytes >= buf.length) throw new Error('varint past end')
    b = buf[offset + bytes]
    result |= (b & 0x7f) << (7 * bytes)
    bytes++
    if (bytes > 5) throw new Error('varint too long')
  } while (b & 0x80)
  return { value: result >>> 0, size: bytes }
}

function writeVarInt (value) {
  const out = []
  let v = value >>> 0
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v !== 0) b |= 0x80
    out.push(b)
  } while (v !== 0)
  return Buffer.from(out)
}

function readString (buf, offset) {
  const len = readVarInt(buf, offset)
  const start = offset + len.size
  if (start + len.value > buf.length) throw new Error('string past end')
  return { value: buf.toString('utf8', start, start + len.value), size: len.size + len.value }
}

function writeString (str) {
  const bytes = Buffer.from(str, 'utf8')
  return Buffer.concat([writeVarInt(bytes.length), bytes])
}

function readBool (buf, offset) {
  return { value: buf[offset] !== 0, size: 1 }
}

// --- payload codecs ---

// ModdedNetworkQueryPayload: Map<ConnectionProtocol, Set<ModdedNetworkQueryComponent>>
// Component: id (ResourceLocation), version (String), flow (Optional<PacketFlow>), optional (bool)
function encodeNetworkQuery (components) {
  const parts = []
  const protocols = Object.keys(components).filter((p) => (components[p] || []).length > 0)
  parts.push(writeVarInt(protocols.length))
  for (const protocol of protocols) {
    const ordinal = PROTOCOL_ORDINALS[protocol]
    if (ordinal === undefined) throw new Error(`unknown protocol ${protocol}`)
    parts.push(writeVarInt(ordinal))
    const set = components[protocol]
    parts.push(writeVarInt(set.length))
    for (const c of set) {
      parts.push(writeString(c.id))
      parts.push(writeString(String(c.version)))
      if (c.flow === null || c.flow === undefined) {
        parts.push(Buffer.from([0]))
      } else {
        const flowOrdinal = FLOW_ORDINALS[c.flow]
        if (flowOrdinal === undefined) throw new Error(`unknown flow ${c.flow}`)
        parts.push(Buffer.from([1]), writeVarInt(flowOrdinal))
      }
      parts.push(Buffer.from([c.optional ? 1 : 0]))
    }
  }
  return Buffer.concat(parts)
}

// NetworkPayloadSetup: Map<ConnectionProtocol, Map<ResourceLocation, NetworkChannel(id, version)>>
// HF43: the server's own `neoforge:register` query is ModdedNetworkQueryPayload
// .fromRegistry(...) — ITS component sets per protocol (id, version, optional
// flow, optional flag), the same wire shape encodeNetworkQuery writes. Decoded
// as ground truth for the negotiation: what the server has, at which version.
function decodeNetworkQuery (buf) {
  let offset = 0
  const mapCount = readVarInt(buf, offset); offset += mapCount.size
  const query = {}
  for (let i = 0; i < mapCount.value; i++) {
    const ordinal = readVarInt(buf, offset); offset += ordinal.size
    const protocol = PROTOCOL_NAMES[ordinal.value] ?? `protocol_${ordinal.value}`
    const count = readVarInt(buf, offset); offset += count.size
    const rows = []
    for (let j = 0; j < count.value; j++) {
      const id = readString(buf, offset); offset += id.size
      const version = readString(buf, offset); offset += version.size
      const hasFlow = buf[offset]; offset += 1
      let flow = null
      if (hasFlow) {
        const fo = readVarInt(buf, offset); offset += fo.size
        flow = fo.value === 0 ? 'serverbound' : fo.value === 1 ? 'clientbound' : `flow_${fo.value}`
      }
      const optional = buf[offset] === 1; offset += 1
      rows.push({ id: id.value, version: version.value, flow, optional })
    }
    query[protocol] = rows
  }
  return query
}

// HF43: the server rows a client claim set would fail on (decompiled
// NetworkComponentNegotiator: a NON-optional server component absent on the
// client fails "missing.server.client"; a non-optional client component
// absent on the server fails the other way). Pure — feeds the learn belt.
// HF43-r (MED-3): an EMPTY or absent server query is UNKNOWN, not "the server
// holds nothing" — 26.1.2 and 1.21.1 both send a 0+0 query and still hold
// required channels. `known` is false then and no row is called extra on
// the client; a query that lists at least one component is compared.
function negotiationDelta (serverQuery, components) {
  const listed = serverQuery ? ['configuration', 'play'].reduce((n, p) => n + ((serverQuery[p] || []).length), 0) : 0
  const delta = { known: listed > 0, missingOnClient: [], extraOnClient: [] }
  if (!delta.known) return delta
  for (const protocol of ['configuration', 'play']) {
    const ours = new Set((components[protocol] || []).map((c) => c.id))
    const theirs = new Map((serverQuery[protocol] || []).map((r) => [r.id, r]))
    for (const r of theirs.values()) if (!r.optional && !ours.has(r.id)) delta.missingOnClient.push({ protocol, ...r })
    for (const c of components[protocol] || []) if (!c.optional && !theirs.has(c.id)) delta.extraOnClient.push({ protocol, id: c.id, version: c.version })
  }
  return delta
}

// HF43: typed reading of neoforge:modded_network_setup_failed rows against
// the server's own query — the translate key names the rule that failed,
// the query row names the tuple the server holds for that channel.
function classifyNegotiationFailure (reasons, serverQuery) {
  const out = []
  const rowOf = (id) => {
    for (const protocol of ['configuration', 'play']) {
      const r = ((serverQuery && serverQuery[protocol]) || []).find((x) => x.id === id)
      if (r) return { protocol, ...r }
    }
    return null
  }
  // every translate/text key in the component TREE — NeoForge wraps the
  // rule key inside neoforge.network.negotiation.failure.mod's arguments
  // (rig-proven 26.1.2: {translate: ...failure.mod, with: [{translate:
  // ...missing.server.client}]}), so the top-level key alone says nothing.
  const keyOf = (why, depth = 0) => {
    if (!why || depth > 6) return ''
    if (typeof why === 'string') return why
    if (Array.isArray(why)) return why.map((w) => keyOf(w, depth + 1)).filter(Boolean).join(' ')
    if (typeof why !== 'object') return ''
    const parts = []
    if (typeof why.translate === 'string') parts.push(why.translate)
    if (typeof why.text === 'string') parts.push(why.text)
    for (const k of ['with', 'extra', 'value']) if (why[k] !== undefined && why[k] !== null) { const inner = keyOf(why[k], depth + 1); if (inner) parts.push(inner) }
    return parts.join(' ')
  }
  for (const [id, why] of Object.entries(reasons || {})) {
    const key = keyOf(why)
    let kind = 'other'
    if (/missing\.server\.client/.test(key)) kind = 'missing_on_client'
    else if (/missing\.client\.server/.test(key)) kind = 'missing_on_server'
    else if (/version/.test(key)) kind = 'version_mismatch'
    else if (/flow\.[a-z]+\.missing/.test(key)) kind = 'flow_missing'
    else if (/flow/.test(key)) kind = 'flow_mismatch'
    else if (/failure\.mod/.test(key)) kind = 'mod_rule'
    const server = rowOf(id)
    // version.mismatch carries BOTH versions as arguments (decompiled
    // validateComponent: translatable(key, [theirs, ours])) — surfaced so a
    // learner can take the one that is not its own claim.
    const versions = []
    const strings = (w, depth = 0) => {
      if (w === null || w === undefined || depth > 6) return
      if (typeof w === 'string') { versions.push(w); return }
      if (Array.isArray(w)) { for (const x of w) strings(x, depth + 1); return }
      if (typeof w === 'object') { if (typeof w.text === 'string') versions.push(w.text); else if (w.with !== undefined) strings(w.with, depth + 1) }
    }
    // the RULE component (the one whose translate key names flow/version)
    // carries the expected value in ITS arguments — failure.mod's own first
    // argument is the mod's display name, never a version
    const ruleOf = (w, depth = 0) => {
      if (!w || typeof w !== 'object' || depth > 6) return null
      if (Array.isArray(w)) { for (const x of w) { const r = ruleOf(x, depth + 1); if (r) return r } return null }
      if (typeof w.translate === 'string' && /failure\.(flow|version)/.test(w.translate)) return w
      return w.with !== undefined ? ruleOf(w.with, depth + 1) : null
    }
    if (kind === 'version_mismatch' || kind === 'flow_missing' || kind === 'flow_mismatch') { const rule = ruleOf(why); if (rule) strings(rule.with) }
    // flow.<side>.missing / flow.<side>.mismatch carry the PRESENT flow's
    // PacketFlow.toString() (CLIENTBOUND / SERVERBOUND) as an argument
    const flowArg = versions.map((v) => String(v).toLowerCase()).find((v) => v === 'clientbound' || v === 'serverbound') ?? null
    out.push({ id, kind, key, server, versions, flow: flowArg })
  }
  return out
}

function decodeNetworkSetup (buf) {
  let offset = 0
  const mapCount = readVarInt(buf, offset); offset += mapCount.size
  const setup = {}
  for (let i = 0; i < mapCount.value; i++) {
    const ordinal = readVarInt(buf, offset); offset += ordinal.size
    const protocol = PROTOCOL_NAMES[ordinal.value] ?? `protocol_${ordinal.value}`
    const chanCount = readVarInt(buf, offset); offset += chanCount.size
    const channels = {}
    for (let j = 0; j < chanCount.value; j++) {
      const key = readString(buf, offset); offset += key.size
      const id = readString(buf, offset); offset += id.size
      const version = readString(buf, offset); offset += version.size
      channels[key.value] = { id: id.value, version: version.value }
    }
    setup[protocol] = channels
  }
  return setup
}

// ModdedNetworkSetupFailedPayload: Map<ResourceLocation, Component (network NBT)>
function decodeSetupFailed (buf) {
  let offset = 0
  const count = readVarInt(buf, offset); offset += count.size
  const reasons = {}
  for (let i = 0; i < count.value; i++) {
    const id = readString(buf, offset); offset += id.size
    const tag = readAnonymousNbt(buf, offset); offset += tag.size
    reasons[id.value] = tag.value
  }
  return reasons
}

// Minimal anonymous network-NBT reader (1.20.3+ wire components): typeId byte,
// no root name, then payload. Only the tag types chat components actually use.
function readAnonymousNbt (buf, offset) {
  const type = buf[offset]
  const body = readNbtPayload(buf, offset + 1, type)
  return { value: body.value, size: 1 + body.size }
}

function readNbtPayload (buf, offset, type) {
  switch (type) {
    case 0: return { value: null, size: 0 }
    case 1: return { value: buf.readInt8(offset), size: 1 }
    case 2: return { value: buf.readInt16BE(offset), size: 2 }
    case 3: return { value: buf.readInt32BE(offset), size: 4 }
    case 4: return { value: buf.readBigInt64BE(offset).toString(), size: 8 }
    case 5: return { value: buf.readFloatBE(offset), size: 4 }
    case 6: return { value: buf.readDoubleBE(offset), size: 8 }
    case 7: { const n = buf.readInt32BE(offset); return { value: `bytes[${n}]`, size: 4 + n } }
    case 8: { const n = buf.readUInt16BE(offset); return { value: buf.toString('utf8', offset + 2, offset + 2 + n), size: 2 + n } }
    case 9: {
      const itemType = buf[offset]
      const n = buf.readInt32BE(offset + 1)
      let size = 5
      const items = []
      for (let i = 0; i < n; i++) {
        const item = readNbtPayload(buf, offset + size, itemType)
        items.push(item.value)
        size += item.size
      }
      return { value: items, size }
    }
    case 10: {
      let size = 0
      const value = {}
      for (;;) {
        const entryType = buf[offset + size]
        size += 1
        if (entryType === 0) break
        const nameLen = buf.readUInt16BE(offset + size)
        const name = buf.toString('utf8', offset + size + 2, offset + size + 2 + nameLen)
        size += 2 + nameLen
        const entry = readNbtPayload(buf, offset + size, entryType)
        value[name] = entry.value
        size += entry.size
      }
      return { value, size }
    }
    case 11: { const n = buf.readInt32BE(offset); return { value: `ints[${n}]`, size: 4 + n * 4 } }
    case 12: { const n = buf.readInt32BE(offset); return { value: `longs[${n}]`, size: 4 + n * 8 } }
    default: throw new Error(`nbt tag ${type} unsupported`)
  }
}

// FrozenRegistrySyncStartPayload: List<ResourceLocation>
function decodeFrozenStart (buf) {
  let offset = 0
  const count = readVarInt(buf, offset); offset += count.size
  const names = []
  for (let i = 0; i < count.value; i++) {
    const name = readString(buf, offset); offset += name.size
    names.push(name.value)
  }
  return names
}

// FrozenRegistryPayload: registryName (ResourceLocation) + RegistrySnapshot
// (map<varint, ResourceLocation> ids + map<ResourceLocation, ResourceLocation> aliases)
function decodeFrozenRegistry (buf) {
  let offset = 0
  const name = readString(buf, offset); offset += name.size
  const idCount = readVarInt(buf, offset); offset += idCount.size
  const ids = new Map()
  for (let i = 0; i < idCount.value; i++) {
    const rawId = readVarInt(buf, offset); offset += rawId.size
    const entry = readString(buf, offset); offset += entry.size
    ids.set(rawId.value, entry.value)
  }
  const aliasCount = readVarInt(buf, offset); offset += aliasCount.size
  const aliases = new Map()
  for (let i = 0; i < aliasCount.value; i++) {
    const from = readString(buf, offset); offset += from.size
    const to = readString(buf, offset); offset += to.size
    aliases.set(from.value, to.value)
  }
  return { name: name.value, ids, aliases }
}

// KnownRegistryDataMapsPayload: Map<registryKey(ResourceLocation), List<KnownDataMap(id, mandatory)>>
function decodeKnownDataMaps (buf) {
  let offset = 0
  const count = readVarInt(buf, offset); offset += count.size
  const maps = []
  for (let i = 0; i < count.value; i++) {
    const registry = readString(buf, offset); offset += registry.size
    const entryCount = readVarInt(buf, offset); offset += entryCount.size
    const entries = []
    for (let j = 0; j < entryCount.value; j++) {
      const id = readString(buf, offset); offset += id.size
      const mandatory = readBool(buf, offset); offset += mandatory.size
      entries.push({ id: id.value, mandatory: mandatory.value })
    }
    maps.push({ registry: registry.value, entries })
  }
  return maps
}

// KnownRegistryDataMapsReplyPayload: Map<registryKey, Collection<ResourceLocation>>
function encodeKnownDataMapsReply (maps) {
  const parts = [writeVarInt(maps.length)]
  for (const m of maps) {
    parts.push(writeString(m.registry))
    parts.push(writeVarInt(m.entries.length))
    for (const e of m.entries) parts.push(writeString(e.id))
  }
  return Buffer.concat(parts)
}

/**
 * Installs the configuration-phase NeoForge negotiation responder.
 *
 * @param {import('minecraft-protocol').Client} client connecting client
 * @param {{
 *   components: { configuration: Array<{id, version, flow, optional}>,
 *                 play: Array<{id, version, flow, optional}> },
 *   claimBuiltins: boolean | undefined, // default true: claim the optional
 *     // neoforge built-in channels that opt into registry sync + data-map
 *     // negotiation (the ones this responder can actually answer)
 *   declareListening: boolean | undefined, // default true: declare the
 *     // handler contract over `minecraft:register` at query time (HF6 —
 *     // populates the server's ad-hoc channel set so its send-path guard
 *     // accepts the configuration built-ins its tasks send unconditionally)
 *   listenOnly: Array<string> | undefined, // HF15: jar-derived LISTEN-ONLY
 *     // channel ids (listenOnlyDerivation.js — named-abstain ids, wrapper-
 *     // factory enumerations, connector-served fabric clientbound ids, plus
 *     // any per-host learned hints) appended to the HF6 declaration. The
 *     // ad-hoc tier is version-free by primary source, so declaring these
 *     // is truthful tolerance, never a claim; a server-side mod's
 *     // unconditional send (checkPacket, the HF15 placement-abort receipt)
 *     // becomes lawful instead of killing the placement.
 *   ackContracts: Array<{trigger: string, ack: string}> | undefined,
 *     // HF11: jar-proven blocking-task rows — on receiving `trigger` during
 *     // configuration, send `ack` with an EMPTY body (the derivation proved
 *     // the ack's codec is StreamCodec.unit and its handler is what calls
 *     // finishCurrentTask server-side). Never guessed, receipted in
 *     // state.acked + the neoForgeConfigAck event.
 *   proveAckContract: (async ({channel, namespace, bytes, serverQuery, claimed, learned}) =>
 *     {contracts: Array<{trigger, ack}>, source, owner, reason, unprovable}) | undefined,
 *     // HF55 ACQUIRE-TO-PROVE: asked ONCE per configuration-phase mod
 *     // payload that no proven contract covers (a learned channel's payload
 *     // included — on a bare client that is exactly the blocking task the
 *     // server parked the phase on). The embedder proves the contract from
 *     // a jar it OBTAINS (registry acquisition, its own caps) or from its
 *     // per-host contract cache; the responder answers a proven trigger with
 *     // the proven empty ack, corroborated against the server's own query
 *     // (the ack must be a channel the server declared), and a miss that
 *     // leaves the phase parked is emitted as neoForgeConfigTaskUnprovable
 *     // — never a silent stall. While a proof is in flight the responder
 *     // holds the join watchdogs (minepalConfigProgress + the join window).
 *   configProofBudgetMs: number | undefined, // HF55: how long one proof may hold the phase (default CONFIG_PROOF_BUDGET_MS)
 *   parkedGraceMs: number | undefined, // HF55: the parked read's grace after a proof settles without a contract (default PARKED_GRACE_MS)
 * }} options
 */
// HF55: one proof may hold the configuration phase this long (the server
// keeps the phase open on keep-alives — measured on the rig, no server-side
// deadline; the bound is OUR patience: a registry download + one derivation).
const CONFIG_PROOF_BUDGET_MS = 150000
// HF55: after a proof settles without a contract, the phase is read as PARKED
// when no further non-keep-alive configuration packet arrives inside this
// grace — a fire-and-forget payload the server sent and moved past is never
// called a blocking task.
const PARKED_GRACE_MS = 3000
// HF55: the hold tick — the fabric registry-sync watchdog (20 s) and the join
// window are restarted this often while a proof is in flight.
const HOLD_TICK_MS = 5000
// HF37: how long the configuration pong may wait for the negotiation verdict
// before the fallback release (the vanilla login window is 30 s; a 40 KB
// verdict on a slow uplink is well inside this).
const PONG_HOLD_MS = 2500

function installNeoForgeConfigNegotiation (client, options = {}) {
  const rawComponents = options.components || { configuration: [], play: [] }
  const declareListening = options.declareListening !== false
  // HF15 — the listen-only surface: sanitized here so a malformed id can
  // never ride a declaration frame (ids are jar-derived or hint-learned
  // upstream; this is the wire boundary's own belt).
  const listenOnly = (options.listenOnly || []).filter((id) =>
    typeof id === 'string' && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id))
  // HF11 — blocking-task ACK CONTRACTS, jar-derived rows {trigger, ack}:
  // a mod configuration task that sends `trigger` and parks the phase until
  // the client answers `ack` (tacz's NetworkHandler$Task — the server calls
  // finishCurrentTask only in its `tacz:acknowledge` handler, and that ack's
  // codec is StreamCodec.unit, i.e. an EMPTY body). Every row was PROVEN
  // from the mod's own bytecode by the derivation (unit codec +
  // finishCurrentTask + the task's run() constructing the trigger payload);
  // nothing here is guessed, and a channel without a proven contract is
  // never acked (it surfaces instead).
  const ackContracts = new Map()
  // HF55: where each contract came from — 'local-jar' (the HF11 rows, no
  // source stamp on the row) or the embedder's stamp (contract-cache /
  // acquired-jar); receipts and copy read it, the ack itself is the same.
  const contractSources = new Map()
  for (const row of options.ackContracts || []) {
    if (row && typeof row.trigger === 'string' && typeof row.ack === 'string') {
      ackContracts.set(row.trigger, row.ack)
      if (typeof row.source === 'string' && row.source) contractSources.set(row.trigger, row.source)
    }
  }
  const proveAckContract = typeof options.proveAckContract === 'function' ? options.proveAckContract : null
  const configProofBudgetMs = Number.isFinite(options.configProofBudgetMs) ? options.configProofBudgetMs : CONFIG_PROOF_BUDGET_MS
  const parkedGraceMs = Number.isFinite(options.parkedGraceMs) ? options.parkedGraceMs : PARKED_GRACE_MS
  // HF6 intersection law (header §1): a clientbound/bidirectional neoforge:*
  // built-in outside the phase's contract must never be claimed — a
  // configuration task may block on a reply we cannot give, and an unknown
  // play built-in has semantics we cannot vouch for. Mod channels and
  // serverbound built-ins (our own acks/replies) pass through untouched.
  // (`neoforge:split` falls out of both contracts by the same law.)
  const unclaimedBuiltins = []
  const toleratedDerived = [] // HF43: loader-derived clientbound play built-ins beyond the 21.1-pinned list
  const builtinFilter = (contract, tolerateDerivedClientbound = false) => (c) => {
    if (typeof c.id !== 'string' || !c.id.startsWith('neoforge:')) return true
    if (c.flow === 'serverbound') return true
    if (contract.includes(c.id)) return true
    // HF43: the loader jar is the authority on ITS play built-ins — a
    // clientbound one is a pure toClient stream by the HF6 argument (no
    // serverbound counterpart, no blocking task at play) and MUST be claimed:
    // NetworkRegistry.checkPacket throws on the server's own send of an
    // unnegotiated payload and the join dies at placeNewPlayer (rig-proven
    // 26.1.2.109: `neoforge:recipe_content`, new in 26.1, "Invalid player
    // data"). The framing carrier (neoforge:split, flow null) stays refused.
    if (tolerateDerivedClientbound && c.flow === 'clientbound' && c.id !== 'neoforge:split') {
      toleratedDerived.push(c.id)
      return true
    }
    unclaimedBuiltins.push(c.id)
    return false
  }
  const components = {
    configuration: (rawComponents.configuration || []).filter(builtinFilter(HANDLED_CLIENTBOUND_CONFIG_CHANNELS)),
    play: (rawComponents.play || []).filter(builtinFilter(TOLERATED_CLIENTBOUND_PLAY_CHANNELS, true))
  }
  if (toleratedDerived.length > 0) {
    debug(`neoforge config: tolerating ${toleratedDerived.length} loader-derived clientbound play built-in(s) beyond the pinned list: ${toleratedDerived.join(', ')}`)
  }
  // HF43 LEARN BELT: channels the SERVER named in an earlier negotiation
  // failure (tuple from its own query) ride the claim STAMPED learned — never
  // as derived; their payloads are received and dropped, never acted on.
  // Built-ins and ids already derived never enter here.
  const learnedIds = new Set()
  const learnedRows = { configuration: [], play: [] }
  // HF51: a lesson the server taught about a channel the jars DID derive
  // (its version / flow) overrides the derived tuple on the retry — the
  // server's own refusal is the primary source; the row is stamped
  // learned-over-derived and the receipt lists it (the derived claim used
  // to win forever: SecurityCraft's "v"-prefixed version, 47 channels, 5 kicks).
  const learnedOverDerived = { configuration: [], play: [] }
  for (const protocol of ['configuration', 'play']) {
    for (const row of ((options.learnedComponents || {})[protocol] || [])) {
      if (!row || typeof row.id !== 'string' || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(row.id) || row.id.startsWith('neoforge:') || row.id.startsWith('minecraft:')) continue
      const derived = components[protocol].find((c) => c.id === row.id)
      if (derived) {
        const lFlow = row.flow === 'serverbound' || row.flow === 'clientbound' ? row.flow : null
        const lVersion = typeof row.version === 'string' && row.version !== '' ? row.version : null
        const changes = []
        if (lVersion !== null && derived.version !== lVersion) { changes.push(`version ${derived.version} -> ${lVersion}`); derived.version = lVersion }
        if (lFlow !== null && derived.flow !== lFlow) { changes.push(`flow ${derived.flow} -> ${lFlow}`); derived.flow = lFlow }
        if (changes.length > 0) {
          derived.learnedOverDerived = true
          derived.source = `learned-over-derived:${row.learnedFrom || 'server'} (${changes.join(', ')}; was ${derived.source || 'derived'})`
          learnedOverDerived[protocol].push({ id: row.id, changes })
        }
        continue
      }
      if (learnedIds.has(`${protocol}/${row.id}`)) continue
      const flow = row.flow === 'serverbound' || row.flow === 'clientbound' ? row.flow : null
      // optional unless the learner says otherwise: an optional client row
      // the server lacks is dropped by the negotiator, a required one fails it
      const learned = { id: row.id, version: String(row.version ?? ''), flow, optional: row.optional !== false, learned: true, source: `learned:${row.learnedFrom || 'server'}` }
      components[protocol].push(learned)
      learnedRows[protocol].push(learned)
      learnedIds.add(`${protocol}/${row.id}`)
    }
  }
  const learnedChannelIds = new Set([...learnedRows.configuration, ...learnedRows.play].map((r) => r.id))
  if (unclaimedBuiltins.length > 0) {
    debug(`neoforge config: refusing to claim ${unclaimedBuiltins.length} configuration built-in(s) this responder cannot answer: ${unclaimedBuiltins.join(', ')}`)
  }
  // HF9 — content-mod config-phase SYNC CONTRACTS (annotation-registry
  // derivation, jar-proven): each contract names a configuration-to-client
  // mod channel whose payload the mod's OWN client answers with a fixed
  // task-finish ack (`new FinishAck(Task.TYPE.id())` -> serverbound reply
  // whose wire bytes are utf8-string sequences per the registry's codec).
  // The server's vanilla task queue advances ONLY on finishCurrentTask
  // (ServerConfigurationPacketListenerImpl: a mismatched finish is an
  // IllegalStateException kick), so the responder acks EXACTLY ONCE per
  // task id per configuration session:
  //   - multi-part sync payloads (jar truth: SyncSpecies/SyncMoves/
  //     SyncPokeBalls carry a `last` boolean and the reference client acks
  //     on the last part) are acked on the FIRST part instead — all parts
  //     were already flushed by the task's own start(), finishCurrentTask
  //     matches the still-current task, and the remaining parts are
  //     consumed. Parsing each mod's per-class field layout for the `last`
  //     flag would add per-mod codec knowledge for zero server-visible
  //     difference; the once-per-task law is the mechanism.
  //   - the acked set resets on every configuration re-entry (the server
  //     builds a fresh task queue per reconfiguration).
  const syncContracts = options.syncContracts || null
  const contractByChannel = new Map()
  for (const c of (syncContracts && syncContracts.contracts) || []) {
    if (c && typeof c.channel === 'string' && c.reply && Array.isArray(c.reply.strings)) {
      contractByChannel.set(c.channel, c)
    }
  }
  const consumeOnlyChannels = new Set((syncContracts && syncContracts.consumeOnly) || [])
  const state = {
    negotiated: false,
    setup: null,
    registries: {},
    frozenRegistryCount: 0,
    dataMapsAnswered: false,
    declaredListening: null,
    listenOnlyDeclared: null, // HF15: how many jar-derived listen-only ids rode the declaration
    queryAnswer: null, // HF8: {configuration, play, bytes} once answered (+ HF43 learned counts)
    serverQuery: null, // HF43: the server's own component sets from its neoforge:register query
    serverDelta: null, // HF43: {missingOnClient, extraOnClient} — the rows the negotiator would fail on
    learned: { configuration: learnedRows.configuration.map((r) => r.id), play: learnedRows.play.map((r) => r.id) }, // HF43 receipt: claimed-as-learned ids
    learnedOverDerived, // HF51 receipt: derived rows whose version / flow the server's own refusal corrected
    claimed: { configuration: components.configuration.map((c) => ({ id: c.id, version: c.version, flow: c.flow, optional: c.optional, learned: !!c.learned })), play: components.play.map((c) => ({ id: c.id, version: c.version, flow: c.flow, optional: c.optional, learned: !!c.learned })) }, // HF51: the belt reads OUR side of every refusal row from here
    learnedDropped: {}, // HF43: payloads received on learned channels and dropped, by id
    setupFailed: null, // HF8: the server's per-channel failure reasons
    pongHold: null, // HF37: {id, heldMs, outcome} — the configuration pong held until the negotiation verdict
    acked: [], // HF11: {trigger, ack} rows actually answered this phase (+ source when not the local jar — HF55)
    proofs: {}, // HF55: per-channel acquire-to-prove receipts {status, namespace, source, owner, reason, ms, payloads, parked}
    unprovable: [], // HF55: the channels the phase parked on with no provable contract (the honest stop's facts)
    holds: [], // HF55: {channel, since, until} — how long each proof held the phase
    configInboundSeq: 0, // HF55: non-keep-alive configuration packets seen (the parked read)
    unclaimedBuiltins,
    toleratedDerived, // HF43 receipt
    unhandled: [],
    log: [],
    // HF9 receipts: which mod sync tasks were acked, what was consumed —
    // the join classifier reads these when a modded config still stalls.
    modSync: contractByChannel.size > 0 || consumeOnlyChannels.size > 0
      ? { contracts: contractByChannel.size, ackedTasks: [], consumed: {}, unfinishableTasks: (syncContracts && syncContracts.unfinishableTasks) || [] }
      : null
  }
  client.neoForgeConfig = state
  if (learnedChannelIds.size > 0) {
    debug(`neoforge config: ${learnedChannelIds.size} channel(s) ride the claim as LEARNED from this server's own negotiation (not jar-derived): ${[...learnedChannelIds].join(', ')}`)
    // play-phase payloads on learned channels: counted and dropped (the
    // transport ignores unknown custom payloads; the receipt says how many)
    client.on('packet', (packet, meta) => {
      if (meta.state !== 'play' || meta.name !== 'custom_payload') return
      if (typeof packet.channel === 'string' && learnedChannelIds.has(packet.channel)) {
        state.learnedDropped[packet.channel] = (state.learnedDropped[packet.channel] || 0) + 1
      }
    })
  }
  // D3: NeoForge 1.20.5+ advanced_add_entity is a COMPANION payload (entityId
  // + custom bytes next to vanilla add_entity — javap 20.4.237 / 21.1.248);
  // the decoder derives that from the local universal jar and synthesizes
  // nothing, receipting the classification (abstain when no jar).
  try { require('./loaderSpawnDecoder').installLoaderSpawnDecoder(client, { modsPaths: options.modsPaths || options.jarPaths || [] }, { family: 'neoforge' }) } catch (err) { debug(`loader spawn decoder install failed: ${err.message}`) }
  if (state.modSync && state.modSync.unfinishableTasks.length > 0) {
    // Requirement-5 honesty: the jars prove the mod registers configuration
    // tasks this client cannot finish — the join may wedge on them, and the
    // receipt names them BEFORE it does.
    console.warn(`[neoforge] content-mod sync: ${state.modSync.unfinishableTasks.length} registered configuration task(s) have no derivable finish ack (${state.modSync.unfinishableTasks.slice(0, 5).join(', ')}) — if the join stalls in configuration, this is why`)
  }

  const send = (channel, data) => {
    debug(`neoforge config: sending ${channel} (${data.length} bytes)`)
    client.write('custom_payload', { channel, data })
  }
  // HF11 / HF55 — ONE answer path for a proven blocking-task trigger: the
  // proven empty ack, receipted with its source (a local-jar row keeps the
  // exact pre-HF55 shape).
  const answerProvenTrigger = (channel, bytes) => {
    const ack = ackContracts.get(channel)
    const source = contractSources.get(channel) || null
    debug(`neoforge config: blocking-task trigger ${channel} (${bytes} bytes) — sending its ${source ? source + '-proven' : 'jar-proven'} empty ack ${ack}`)
    const row = source ? { trigger: channel, ack, source } : { trigger: channel, ack }
    state.acked.push(row)
    send(ack, Buffer.alloc(0))
    client.emit('neoForgeConfigAck', { ...row })
  }
  // HF55 — the parked read: every non-keep-alive configuration packet bumps
  // the sequence; a proof that settles with no contract and sees no further
  // packet inside PARKED_GRACE_MS is the phase parked on that task.
  client.on('packet', (packet, meta) => {
    if (meta.state !== 'configuration' || meta.name === 'keep_alive' || meta.name === 'ping') return
    state.configInboundSeq++
  })
  const serverDeclaredIds = () => {
    const q = state.serverQuery
    if (!q || !Array.isArray(q.configuration) || q.configuration.length === 0) return null // unknown query: nothing to corroborate against
    return new Set(q.configuration.map((r) => r && r.id).filter((id) => typeof id === 'string'))
  }
  const startHold = (channel) => {
    const hold = { channel, since: Date.now(), until: null }
    state.holds.push(hold)
    const tick = () => {
      try { client.emit('minepalConfigProgress', `proving the configuration task on ${channel} (a jar is being obtained and read)`) } catch (err) { debug(`hold tick failed (${err.message})`) }
      try { if (typeof client.minepalJoinWatchdogExtend === 'function') client.minepalJoinWatchdogExtend(`configuration-task proof on ${channel} in flight`) } catch (err) { debug(`join watchdog extend failed (${err.message})`) }
    }
    tick()
    const timer = setInterval(tick, HOLD_TICK_MS)
    if (timer.unref) timer.unref()
    return { stop: () => { clearInterval(timer); hold.until = Date.now() } }
  }
  const pendingByNamespace = new Map()
  const settleProof = (channel, result, hold) => {
    hold.stop()
    const receipt = state.proofs[channel]
    receipt.ms = Date.now() - receipt.startedAt
    receipt.source = (result && typeof result.source === 'string') ? result.source : null
    receipt.owner = (result && result.owner && typeof result.owner === 'object') ? { modId: result.owner.modId || null, version: result.owner.version || null } : null
    const rows = (result && Array.isArray(result.contracts) ? result.contracts : []).filter((r) => r && typeof r.trigger === 'string' && typeof r.ack === 'string')
    const declared = serverDeclaredIds()
    const uncorroborated = []
    for (const row of rows) {
      // corroboration at the wire boundary: an ack the server never declared
      // is not an ack this server can finish a task on — refused, named.
      if (declared && !declared.has(row.ack)) { uncorroborated.push(row.ack); continue }
      if (!ackContracts.has(row.trigger)) {
        ackContracts.set(row.trigger, row.ack)
        contractSources.set(row.trigger, receipt.source || 'proven')
      }
    }
    if (uncorroborated.length > 0) receipt.uncorroborated = uncorroborated
    if (client.state !== 'configuration' || client.ended) { receipt.status = 'late'; return }
    if (ackContracts.has(channel)) {
      receipt.status = 'proven'
      answerProvenTrigger(channel, receipt.bytes)
      return
    }
    const refused = (result && Array.isArray(result.unprovable) ? result.unprovable : []).find((u) => u && u.trigger === channel) || null
    if (refused) receipt.refused = { ack: refused.ack || null, reason: refused.reason || 'refused' }
    receipt.status = refused ? 'unprovable' : (rows.length > 0 ? 'no-contract-for-channel' : 'unprovable')
    receipt.reason = (result && typeof result.reason === 'string' && result.reason) ||
      (refused ? `the jar proves a blocking task on this channel whose ack ${refused.ack || '(unresolved)'} is not an empty body (${refused.reason}) — a reply this client cannot invent` : null) ||
      (uncorroborated.length > 0 ? `the proven ack ${uncorroborated.join(', ')} is not a channel this server declared` : null) ||
      'the jar proves no blocking-task contract for this channel'
    debug(`neoforge config: no proven contract for ${channel} (${receipt.status}: ${receipt.reason}) — watching whether the phase moved on`)
    const seq = state.configInboundSeq
    const parkedTimer = setTimeout(() => {
      if (client.state !== 'configuration' || client.ended) { receipt.parked = false; return }
      receipt.parked = state.configInboundSeq === seq
      if (!receipt.parked) { debug(`neoforge config: the phase moved past ${channel} — not a blocking task`); return }
      const fact = { channel, namespace: receipt.namespace, owner: receipt.owner, source: receipt.source, status: receipt.status, reason: receipt.reason, refused: receipt.refused || null, ms: receipt.ms }
      state.unprovable.push(fact)
      debug(`neoforge config: the configuration phase is PARKED on ${channel} with no provable contract — surfacing (${receipt.reason})`)
      client.emit('neoForgeConfigTaskUnprovable', fact)
    }, parkedGraceMs)
    if (parkedTimer.unref) parkedTimer.unref()
  }
  // HF55 — the acquire-to-prove entry: once per channel, one proof per
  // namespace at a time (one jar proves every contract of its namespace).
  const proveOrPark = (channel, bytes) => {
    if (!proveAckContract) return // no prover wired: the pre-HF55 posture (the stall copy names it)
    if (state.proofs[channel]) { state.proofs[channel].payloads++; return }
    const namespace = channel.split(':')[0]
    const receipt = { status: 'pending', namespace, payloads: 1, bytes, startedAt: Date.now(), ms: null, source: null, owner: null, reason: null, learned: learnedChannelIds.has(channel) }
    state.proofs[channel] = receipt
    debug(`neoforge config: ${receipt.learned ? 'learned' : 'unproven'} mod payload ${channel} (${bytes} bytes) has no proven contract — asking the embedder to PROVE one (budget ${configProofBudgetMs} ms)`)
    const hold = startHold(channel)
    let pending = pendingByNamespace.get(namespace)
    if (!pending) {
      // the prover STARTS synchronously (the acquisition clock runs from the trigger, not from the next tick)
      try {
        pending = Promise.resolve(proveAckContract({ channel, namespace, bytes, serverQuery: state.serverQuery, claimed: state.claimed, learned: receipt.learned }))
      } catch (err) {
        pending = Promise.resolve({ contracts: [], reason: `the prover failed (${err && err.message ? err.message : err})` })
      }
      pending = pending.catch((err) => ({ contracts: [], reason: `the prover failed (${err && err.message ? err.message : err})` }))
      pendingByNamespace.set(namespace, pending)
      const clear = () => { if (pendingByNamespace.get(namespace) === pending) pendingByNamespace.delete(namespace) }
      pending.then(clear, clear)
    }
    let budgetTimer = null
    const budget = new Promise((resolve) => {
      budgetTimer = setTimeout(() => resolve({ contracts: [], reason: `the proof did not finish inside its budget (${configProofBudgetMs} ms)` }), configProofBudgetMs)
      if (budgetTimer.unref) budgetTimer.unref()
    })
    Promise.race([pending, budget]).then((result) => {
      clearTimeout(budgetTimer)
      try { settleProof(channel, result, hold) } catch (err) {
        hold.stop()
        debug(`neoforge config: proof settle failed for ${channel} (${err.message})`)
        client.emit('neoForgeConfigError', { channel, error: err })
      }
    })
  }
  // HF37 — the configuration pong is HELD until the negotiation verdict.
  // The server sends `neoforge:register` + ping(0) back to back; we answer
  // the query and the vanilla auto-pong lands in the same tick. When the
  // claim fails, the server's netty thread is inside the negotiation
  // handler when our pong arrives: it sends the named verdict
  // (modded_network_setup_failed + the disconnect packet) and closes the
  // socket with our pong still UNREAD in its receive buffer, so the kernel
  // answers with TCP RST instead of FIN (RFC 2525 §2.17). Windows discards
  // the not-yet-read receive buffer on RST, so the verdict and the kick
  // vanish and the client sees a bare close (field: 20/20 silent rows win32,
  // rig: ECONNRESET with a trailing frame, FIN without). Holding the pong
  // keeps the server's receive buffer EMPTY at close: FIN, and the named
  // kick reaches every platform. On success the pong is released the moment
  // `neoforge:network` arrives (the server's pong handler starts the
  // configuration tasks, and the verdict always precedes that need); on a
  // failure verdict it is dropped for good (the socket is closing — a late
  // pong would re-arm the very reset this avoids); a bounded fallback
  // releases it when no verdict comes, well inside the login window.
  const pongHoldMs = Number.isFinite(options.pongHoldMs) ? options.pongHoldMs : PONG_HOLD_MS
  const held = { packet: null, timer: null, write: null }
  const finishHold = (outcome, deliver) => {
    if (held.timer) { clearTimeout(held.timer); held.timer = null }
    const p = held.packet
    if (!p) return
    held.packet = null
    const heldMs = Date.now() - p.at
    state.pongHold = { id: p.params && p.params.id, heldMs, outcome }
    debug(`neoforge config: held pong(${state.pongHold.id}) ${deliver ? 'released' : 'dropped'} after ${heldMs} ms (${outcome})`)
    if (!deliver) return
    try { held.write.call(client, 'pong', p.params) } catch (err) { debug(`neoforge config: held pong write failed (${err.message})`) }
  }
  const releasePong = (outcome) => finishHold(outcome, true)
  const dropPong = (outcome) => finishHold(outcome, false)
  if (typeof client.write === 'function' && !client.__neoForgePongHold) {
    held.write = client.write
    client.__neoForgePongHold = true
    client.write = function (name, params) {
      if (name === 'pong' && client.state === 'configuration' && state.queryAnswer &&
          !state.negotiated && !state.setupFailed && !held.packet) {
        held.packet = { params, at: Date.now() }
        debug(`neoforge config: holding pong(${params && params.id}) until the negotiation verdict (fallback ${pongHoldMs} ms)`)
        held.timer = setTimeout(() => releasePong('fallback timeout'), pongHoldMs)
        if (held.timer.unref) held.timer.unref()
        return
      }
      return held.write.apply(this, arguments)
    }
    client.on('state', (newState) => { if (held.packet && newState !== 'configuration') releasePong(`state ${newState}`) })
    client.on('end', () => dropPong('socket end'))
    client.on('error', () => dropPong('socket error'))
  }

  // HF9: fresh task queue per configuration entry -> fresh ack ledger.
  if (state.modSync) {
    client.on('state', (newState) => {
      if (newState === 'configuration') state.modSync.ackedTasks = []
    })
  }

  // HF16 (D2, clock-blindness) — SPEAK THE TIME PROTOCOL WE SUMMON.
  // NeoForge 21.1's patched MinecraftServer.synchronizeTime (javap over the
  // rig's own neoforge-21.1.249-server.jar) builds BOTH time packets every
  // 20 ticks and picks per player:
  //   hasChannel(neoforge:custom_time_packet) ? send ClientboundCustomSetTime
  //                                           : send vanilla set_time
  // Our HF6/HF15 `minecraft:register` declaration puts that channel in the
  // connection's AD-HOC set, so the server sends time EXCLUSIVELY as the
  // custom payload — and a client that declares-but-ignores it is clock-blind
  // forever (rig-proven: 89 custom_time_packet payloads and ZERO update_time
  // in 90s on a BARE 21.1.249 server). Same law as the J2 c:-opener fix:
  // a declaration is a claim to speak the protocol. The reference NeoForge
  // client parses this payload and applies it as time truth — so do we,
  // translating it to the vanilla update_time shape mineflayer already
  // ingests (including vanilla's negative-dayTime encoding of a false
  // doDaylightCycle — ClientboundSetTimePacket ctor (JJZ) semantics).
  // Wire format (ClientboundCustomSetTimePayload STREAM_CODEC, javap):
  //   VAR_LONG gameTime, VAR_LONG dayTime, BOOL gameRule,
  //   FLOAT dayTimeFraction, FLOAT dayTimePerTick (extras informational).
  client.on('packet', (packet, meta) => {
    if (meta.state !== 'play' || meta.name !== 'custom_payload') return
    if (!packet || packet.channel !== 'neoforge:custom_time_packet') return
    try {
      const data = packet.data || Buffer.alloc(0)
      let off = 0
      const readVarLong = () => {
        let result = 0n
        let shift = 0n
        for (;;) {
          const b = data[off++]
          if (b === undefined) throw new Error('varlong past end')
          result |= BigInt(b & 0x7f) << shift
          if ((b & 0x80) === 0) break
          shift += 7n
          if (shift > 70n) throw new Error('varlong too long')
        }
        return BigInt.asIntN(64, result)
      }
      const gameTime = readVarLong()
      const dayTime = readVarLong()
      const gameRule = data[off] !== 0
      // vanilla encoding: daylight-cycle OFF rides as negated dayTime (-1 for 0)
      let encodedDayTime = dayTime
      if (!gameRule) encodedDayTime = dayTime === 0n ? -1n : -dayTime
      const pair = (v) => {
        const x = BigInt.asUintN(64, v)
        return [Number(BigInt.asIntN(32, x >> 32n)), Number(x & 0xffffffffn)]
      }
      if (!state.customTimeTranslated) {
        state.customTimeTranslated = 0
        debug('neoforge play: translating neoforge:custom_time_packet -> vanilla update_time semantics (NeoForge sends time only as this payload once the channel is declared)')
      }
      state.customTimeTranslated++
      client.emit('update_time', { age: pair(gameTime), time: pair(encodedDayTime) }, { name: 'update_time', state: 'play' })
    } catch (err) {
      // never throw on the packet path; one loud line, then quiet
      if (!state.customTimeParseFailed) {
        state.customTimeParseFailed = true
        debug(`neoforge play: custom_time_packet translation failed (${err.message}) — time stays vanilla-absent`)
      }
    }
  })

  client.on('packet', (packet, meta) => {
    if (meta.state !== 'configuration' || meta.name !== 'custom_payload') return
    const channel = packet.channel
    const data = packet.data || Buffer.alloc(0)
    try {
      switch (channel) {
        case 'neoforge:register': {
          try {
            state.serverQuery = decodeNetworkQuery(data)
            state.serverDelta = negotiationDelta(state.serverQuery, components)
            const sq = state.serverQuery
            debug(`neoforge config: server query holds ${(sq.configuration || []).length} configuration + ${(sq.play || []).length} play components; ${state.serverDelta.missingOnClient.length} required server row(s) absent from our claim${state.serverDelta.missingOnClient.length ? ` [${state.serverDelta.missingOnClient.map((r) => `${r.id}@${r.version}`).join(',')}]` : ''}; ${state.serverDelta.extraOnClient.length} required claim(s) the server lacks${state.serverDelta.extraOnClient.length ? ` [${state.serverDelta.extraOnClient.map((r) => r.id).join(',')}]` : ''}`)
            client.emit('neoForgeServerQuery', { serverQuery: state.serverQuery, delta: state.serverDelta })
          } catch (err) {
            state.serverQuery = null
            debug(`neoforge config: server query not decodable (${err.message}) — answering from the jar-derived claim alone`)
          }
          // The server's (empty) component query. Answer with our claimed
          // component sets BEFORE the vanilla pong can classify us as a
          // vanilla client (the query always precedes ping(0), so a
          // synchronous reply is ordered ahead of nmp's pong).
          //
          // HF6 — LISTENING DECLARATION first (header §2): the server
          // handles `minecraft:register` unconditionally into the
          // connection's ad-hoc channel set, and processes our packets in
          // order, so declaring BEFORE the component answer guarantees the
          // ad-hoc set is populated before negotiation completes and any
          // configuration task (CheckExtensibleEnums sends with no
          // hasChannel gate) can crash its own send. Nothing is invented:
          // the declaration is version-free and names only channels this
          // responder implements.
          if (declareListening) {
            // HF15: the HF6 handler contract keeps frame-front position
            // (race-sensitive: CheckExtensibleEnums sends the moment
            // negotiation completes); the jar-derived listen-only surface
            // rides behind it, deduped. onMinecraftRegister is addAll-
            // additive server-side, so extra frames are lawful (HF8).
            const contract = [...HANDLED_CLIENTBOUND_CONFIG_CHANNELS, ...TOLERATED_CLIENTBOUND_PLAY_CHANNELS, ...toleratedDerived]
            const contractSet = new Set(contract)
            const extras = listenOnly.filter((id) => !contractSet.has(id))
            state.declaredListening = [...contract, ...extras]
            state.listenOnlyDeclared = extras.length
            debug(`neoforge config: declaring ${state.declaredListening.length} listening channels over minecraft:register (${extras.length} jar-derived listen-only)`)
            // HF8 size law: register frames are additive server-side
            // (onMinecraftRegister addAll), so an oversize declaration rides
            // multiple lawful frames instead of one over-cap frame.
            for (const frame of splitDinnerboneFrames(state.declaredListening)) {
              send('minecraft:register', frame)
            }
          }
          const reply = encodeNetworkQuery(components)
          debug(`neoforge config: query received, claiming ${components.configuration.length} configuration + ${components.play.length} play components`)
          // HF16-R receipt: the claim BY ID (the server's setup_failed names
          // components by id — a dual-side reading needs ours next to theirs).
          debug(`neoforge config: claim ids: configuration=[${components.configuration.map((c) => `${c.id}@${c.version}`).join(',')}] play=[${components.play.map((c) => `${c.id}@${c.version}`).join(',')}]`)
          // HF8 receipt: the answer's true wire size + claim counts, so a
          // silent post-answer close is classifiable (sub-shape A: the
          // server closed without EITHER neoforge:network or
          // modded_network_setup_failed — the claim's fate must be namable
          // from our side with real numbers, not tap estimates).
          state.queryAnswer = {
            configuration: components.configuration.length,
            play: components.play.length,
            learnedConfiguration: learnedRows.configuration.length,
            learnedPlay: learnedRows.play.length,
            bytes: reply.length
          }
          send('neoforge:register', reply)
          break
        }
        case 'neoforge:network': {
          state.setup = decodeNetworkSetup(data)
          state.negotiated = true
          releasePong('verdict neoforge:network')
          const cfg = Object.keys(state.setup.configuration || {}).length
          const play = Object.keys(state.setup.play || {}).length
          debug(`neoforge config: negotiation SUCCEEDED (${cfg} configuration / ${play} play channels)`)
          client.emit('neoForgeNegotiation', state.setup)
          break
        }
        case 'neoforge:modded_network_setup_failed': {
          let reasons = null
          try { reasons = decodeSetupFailed(data) } catch (err) { reasons = { parse_error: err.message } }
          debug(`neoforge config: negotiation FAILED: ${JSON.stringify(reasons)}`)
          state.setupFailed = reasons // HF8 receipt: the answer got a verdict
          dropPong('verdict modded_network_setup_failed') // the socket is closing; a late pong would re-arm the reset
          client.emit('neoForgeNegotiationFailed', reasons)
          break
        }
        case 'neoforge:frozen_registry_sync_start': {
          const names = decodeFrozenStart(data)
          debug(`neoforge config: frozen registry sync start (${names.length} registries)`)
          break
        }
        case 'neoforge:frozen_registry': {
          const registry = decodeFrozenRegistry(data)
          state.frozenRegistryCount++
          const key = SNAPSHOT_REGISTRIES[registry.name]
          if (key) {
            client.forgeRegistries = client.forgeRegistries || {}
            client.forgeRegistries[key] = registry.ids
            debug(`neoforge config: stashed ${registry.name} snapshot (${registry.ids.size} ids)`)
          }
          state.registries[registry.name] = registry.ids.size
          break
        }
        case 'neoforge:frozen_registry_sync_completed': {
          // Bidirectional unit payload: echoing it completes SyncRegistries
          // server-side (ServerPayloadHandler -> finishCurrentTask).
          debug(`neoforge config: frozen registry sync complete after ${state.frozenRegistryCount} registries — acknowledging`)
          send('neoforge:frozen_registry_sync_completed', Buffer.alloc(0))
          client.emit('neoForgeRegistries', client.forgeRegistries)
          break
        }
        case 'neoforge:known_registry_data_maps': {
          const maps = decodeKnownDataMaps(data)
          // Claim knowledge of exactly the maps the server announced (their
          // ids are the server's own truth; the reply is what
          // RegistryDataMapNegotiation waits for).
          debug(`neoforge config: known data maps for ${maps.length} registries — echoing reply`)
          send('neoforge:known_registry_data_maps_reply', encodeKnownDataMapsReply(maps))
          state.dataMapsAnswered = true
          break
        }
        case 'neoforge:extensible_enum_data': {
          // CheckExtensibleEnums: data is informational for a headless
          // client; the ack (unit payload) finishes the task server-side.
          debug('neoforge config: extensible enum data — acknowledging')
          send('neoforge:extensible_enum_ack', Buffer.alloc(0))
          break
        }
        case 'neoforge:feature_flags': {
          debug('neoforge config: feature flags — acknowledging')
          send('neoforge:feature_flags_ack', Buffer.alloc(0))
          break
        }
        case 'neoforge:config_file': {
          // SyncConfig data; no reply required (task finishes after send).
          break
        }
        default:
          // HF9 — content-mod sync-task payloads (jar-proven contracts): the
          // mod's configuration task sent this and blocks the phase until
          // the mod's own finish ack arrives. Ack once per task id (see the
          // once-per-task law above); every subsequent part of the same task
          // is consumed with a receipt. A consume-only channel (jar truth:
          // its reference handler sends nothing) is consumed with a receipt
          // and never answered.
          if (state.modSync && contractByChannel.has(channel)) {
            const contract = contractByChannel.get(channel)
            state.modSync.consumed[channel] = (state.modSync.consumed[channel] || 0) + 1
            if (!state.modSync.ackedTasks.includes(contract.taskId)) {
              state.modSync.ackedTasks.push(contract.taskId)
              const wire = Buffer.concat(contract.reply.strings.map((s) => writeString(String(s))))
              debug(`neoforge config: content-mod sync ${channel} (${data.length} bytes) -> finish ack for ${contract.taskId} on ${contract.reply.channel} (${wire.length} bytes)`)
              send(contract.reply.channel, wire)
            } else {
              debug(`neoforge config: content-mod sync ${channel} — task ${contract.taskId} already acked, consuming part`)
            }
            break
          }
          if (state.modSync && consumeOnlyChannels.has(channel)) {
            state.modSync.consumed[channel] = (state.modSync.consumed[channel] || 0) + 1
            debug(`neoforge config: content-mod payload ${channel} (${data.length} bytes) — consume-only per jar contract`)
            break
          }
          // HF11 — a jar-proven blocking-task trigger: answer with its
          // proven empty ack so the server's configuration task finishes
          // (without this, a claimed mod config channel parks the phase
          // FOREVER — keepalives keep the socket up, progress never comes).
          // Composed after HF9's task contracts: the maps are derived
          // disjointly, and a channel with a full sync contract is answered
          // by its own finish ack, never a blind empty one. HF55: a contract
          // proven this phase or cached from an earlier join answers a
          // LEARNED channel too, so this sits BEFORE the learned drop.
          if (typeof channel === 'string' && ackContracts.has(channel)) {
            answerProvenTrigger(channel, data.length)
            break
          }
          if (typeof channel === 'string' && learnedChannelIds.has(channel)) {
            // HF43: a learned channel's payload is received and DROPPED —
            // its protocol is unknown to this client by construction.
            state.learnedDropped[channel] = (state.learnedDropped[channel] || 0) + 1
            debug(`neoforge config: payload on learned channel ${channel} (${data.length} bytes) dropped (${state.learnedDropped[channel]} so far)`)
            // HF55: on a bare client this is exactly where a blocking task
            // parks the phase — prove its contract from an obtained jar.
            proveOrPark(channel, data.length)
            break
          }
          if (typeof channel === 'string' && !channel.startsWith('neoforge:') && !channel.startsWith('minecraft:') && channel.includes(':')) {
            // HF55: a mod payload no contract covers (a claimed channel whose
            // jar proved nothing, or an unclaimed one): prove or surface.
            proveOrPark(channel, data.length)
            break
          }
          // HF6 boundary honesty: a neoforge:* configuration payload outside
          // the handler contract is SURFACED, never silently swallowed and
          // never answered with an invented reply. (Post-intersection we
          // never claim such a channel, and post-declaration we never
          // declare it, so a lawful server will not send one — this firing
          // means a server-side unconditional send of a payload newer than
          // this responder, the same class as the HF6 receipt.)
          if (typeof channel === 'string' && channel.startsWith('neoforge:')) {
            state.unhandled.push(channel)
            debug(`neoforge config: UNHANDLED neoforge payload ${channel} (${data.length} bytes) — surfacing, not answering`)
            client.emit('neoForgeUnhandledPayload', { channel, bytes: data.length })
          }
          break
      }
    } catch (err) {
      debug(`neoforge config: error handling ${channel}: ${err.message}`)
      client.emit('neoForgeConfigError', { channel, error: err })
    }
  })
}

module.exports = {
  installNeoForgeConfigNegotiation,
  CONFIG_PROOF_BUDGET_MS,
  PARKED_GRACE_MS,
  HOLD_TICK_MS,
  HANDLED_CLIENTBOUND_CONFIG_CHANNELS,
  TOLERATED_CLIENTBOUND_PLAY_CHANNELS,
  encodeDinnerboneChannels,
  MAX_SERVERBOUND_CUSTOM_PAYLOAD_BYTES,
  splitDinnerboneFrames,
  encodeNetworkQuery,
  decodeNetworkQuery,
  negotiationDelta,
  classifyNegotiationFailure,
  decodeNetworkSetup,
  decodeSetupFailed,
  decodeFrozenStart,
  decodeFrozenRegistry,
  decodeKnownDataMaps,
  encodeKnownDataMapsReply,
  readVarInt,
  writeVarInt,
  readString,
  writeString,
  SNAPSHOT_REGISTRIES,
  PROTOCOL_ORDINALS,
  FLOW_ORDINALS
}
