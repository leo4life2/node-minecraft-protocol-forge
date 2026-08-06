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
 * }} options
 */
function installNeoForgeConfigNegotiation (client, options = {}) {
  const components = options.components || { configuration: [], play: [] }
  const state = {
    negotiated: false,
    setup: null,
    registries: {},
    frozenRegistryCount: 0,
    dataMapsAnswered: false,
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
          const reply = encodeNetworkQuery(components)
          debug(`neoforge config: query received, claiming ${components.configuration.length} configuration + ${components.play.length} play components`)
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
