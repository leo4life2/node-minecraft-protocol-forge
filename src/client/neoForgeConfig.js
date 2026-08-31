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
  'minecraft:entity_type': 'entity_type'
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
 *   ackContracts: Array<{trigger: string, ack: string}> | undefined,
 *     // HF11: jar-proven blocking-task rows — on receiving `trigger` during
 *     // configuration, send `ack` with an EMPTY body (the derivation proved
 *     // the ack's codec is StreamCodec.unit and its handler is what calls
 *     // finishCurrentTask server-side). Never guessed, receipted in
 *     // state.acked + the neoForgeConfigAck event.
 * }} options
 */
function installNeoForgeConfigNegotiation (client, options = {}) {
  const rawComponents = options.components || { configuration: [], play: [] }
  const declareListening = options.declareListening !== false
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
  for (const row of options.ackContracts || []) {
    if (row && typeof row.trigger === 'string' && typeof row.ack === 'string') {
      ackContracts.set(row.trigger, row.ack)
    }
  }
  // HF6 intersection law (header §1): a clientbound/bidirectional neoforge:*
  // built-in outside the phase's contract must never be claimed — a
  // configuration task may block on a reply we cannot give, and an unknown
  // play built-in has semantics we cannot vouch for. Mod channels and
  // serverbound built-ins (our own acks/replies) pass through untouched.
  // (`neoforge:split` falls out of both contracts by the same law.)
  const unclaimedBuiltins = []
  const builtinFilter = (contract) => (c) => {
    if (typeof c.id !== 'string' || !c.id.startsWith('neoforge:')) return true
    if (c.flow === 'serverbound') return true
    if (contract.includes(c.id)) return true
    unclaimedBuiltins.push(c.id)
    return false
  }
  const components = {
    configuration: (rawComponents.configuration || []).filter(builtinFilter(HANDLED_CLIENTBOUND_CONFIG_CHANNELS)),
    play: (rawComponents.play || []).filter(builtinFilter(TOLERATED_CLIENTBOUND_PLAY_CHANNELS))
  }
  if (unclaimedBuiltins.length > 0) {
    debug(`neoforge config: refusing to claim ${unclaimedBuiltins.length} configuration built-in(s) this responder cannot answer: ${unclaimedBuiltins.join(', ')}`)
  }
  const state = {
    negotiated: false,
    setup: null,
    registries: {},
    frozenRegistryCount: 0,
    dataMapsAnswered: false,
    declaredListening: null,
    queryAnswer: null, // HF8: {configuration, play, bytes} once answered
    setupFailed: null, // HF8: the server's per-channel failure reasons
    acked: [], // HF11: {trigger, ack} rows actually answered this phase
    unclaimedBuiltins,
    unhandled: [],
    log: []
  }
  client.neoForgeConfig = state

  const send = (channel, data) => {
    debug(`neoforge config: sending ${channel} (${data.length} bytes)`)
    client.write('custom_payload', { channel, data })
  }

  client.on('packet', (packet, meta) => {
    if (meta.state !== 'configuration' || meta.name !== 'custom_payload') return
    const channel = packet.channel
    const data = packet.data || Buffer.alloc(0)
    try {
      switch (channel) {
        case 'neoforge:register': {
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
            state.declaredListening = [...HANDLED_CLIENTBOUND_CONFIG_CHANNELS, ...TOLERATED_CLIENTBOUND_PLAY_CHANNELS]
            debug(`neoforge config: declaring ${state.declaredListening.length} listening channels over minecraft:register`)
            // HF8 size law: register frames are additive server-side
            // (onMinecraftRegister addAll), so an oversize declaration rides
            // multiple lawful frames instead of one over-cap frame.
            for (const frame of splitDinnerboneFrames(state.declaredListening)) {
              send('minecraft:register', frame)
            }
          }
          const reply = encodeNetworkQuery(components)
          debug(`neoforge config: query received, claiming ${components.configuration.length} configuration + ${components.play.length} play components`)
          // HF8 receipt: the answer's true wire size + claim counts, so a
          // silent post-answer close is classifiable (sub-shape A: the
          // server closed without EITHER neoforge:network or
          // modded_network_setup_failed — the claim's fate must be namable
          // from our side with real numbers, not tap estimates).
          state.queryAnswer = {
            configuration: components.configuration.length,
            play: components.play.length,
            bytes: reply.length
          }
          send('neoforge:register', reply)
          break
        }
        case 'neoforge:network': {
          state.setup = decodeNetworkSetup(data)
          state.negotiated = true
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
          // HF11 — a jar-proven blocking-task trigger: answer with its
          // proven empty ack so the server's configuration task finishes
          // (without this, a claimed mod config channel parks the phase
          // FOREVER — keepalives keep the socket up, progress never comes).
          if (typeof channel === 'string' && ackContracts.has(channel)) {
            const ack = ackContracts.get(channel)
            debug(`neoforge config: blocking-task trigger ${channel} (${data.length} bytes) — sending its jar-proven empty ack ${ack}`)
            state.acked.push({ trigger: channel, ack })
            send(ack, Buffer.alloc(0))
            client.emit('neoForgeConfigAck', { trigger: channel, ack })
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
  HANDLED_CLIENTBOUND_CONFIG_CHANNELS,
  TOLERATED_CLIENTBOUND_PLAY_CHANNELS,
  encodeDinnerboneChannels,
  MAX_SERVERBOUND_CUSTOM_PAYLOAD_BYTES,
  splitDinnerboneFrames,
  encodeNetworkQuery,
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
