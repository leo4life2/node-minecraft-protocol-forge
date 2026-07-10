const debug = require('debug')('minecraft-protocol-forge')

// FML3 login handshake (Forge for Minecraft 1.18 - 1.20.1, fmlNetworkVersion 3).
//
// The server drives the handshake through vanilla login_plugin_request packets on
// the 'fml:loginwrapper' channel. Each wrapped payload is an 'fml:handshake'
// message: a one-byte discriminator followed by the message body
// (net.minecraftforge.network.HandshakeMessages):
//
//   1  S2CModList            -> reply 2 C2SModListReply (mirror mods/channels/registries)
//   3  S2CRegistry           -> reply 99 C2SAcknowledge
//   4  S2CConfigData         -> reply 99 C2SAcknowledge
//   5  S2CModData            -> informational (server expects no specific reply)
//   6  S2CChannelMismatchData-> only sent while rejecting us; parsed (names the
//                               rejected channels) and re-emitted as the
//                               'forgeChannelMismatch' client event
//   99 C2SAcknowledge        -> clientbound never
//
// We never apply registry/config payloads - we only acknowledge them so the login
// completes. Message bodies other than ModList are deliberately not parsed: their
// exact layout has changed between Forge versions (e.g. registry snapshots) and
// parsing them is not needed to get through the handshake.

const DISCRIMINATOR = {
  MOD_LIST: 1,
  MOD_LIST_REPLY: 2,
  SERVER_REGISTRY: 3,
  CHANNEL_MISMATCH: 6,
  ACKNOWLEDGEMENT: 99
}

// Forge registries whose id->name snapshot is worth keeping so the bot can name
// modded content the vanilla protocol reports as `unknown`. Maps the on-wire
// registry name to the short key stashed on client.forgeRegistries.
const SNAPSHOT_REGISTRIES = {
  'minecraft:item': 'item',
  'minecraft:block': 'block',
  'minecraft:entity_type': 'entity_type'
}

// --- FriendlyByteBuf-compatible primitives ---

function readVarInt (buffer, offset) {
  let result = 0
  let bytesRead = 0
  let currentByte
  do {
    if (offset + bytesRead >= buffer.length) throw new Error(`buffer ended while reading VarInt at ${offset}`)
    currentByte = buffer[offset + bytesRead]
    result |= (currentByte & 0x7F) << (7 * bytesRead)
    bytesRead++
    if (bytesRead > 5) throw new Error('VarInt too big')
  } while ((currentByte & 0x80) !== 0)
  return { value: result, size: bytesRead }
}

function writeVarInt (value) {
  const bytes = []
  do {
    let b = value & 0x7F
    value >>>= 7
    if (value !== 0) b |= 0x80
    bytes.push(b)
  } while (value !== 0)
  return Buffer.from(bytes)
}

function readString (buffer, offset) {
  const len = readVarInt(buffer, offset)
  // a 5-byte varint can decode negative; accepting it would move the read
  // cursor BACKWARD (size = len.size + len.value), letting a malformed packet
  // loop over the same bytes forever without ever hitting the bounds check
  if (len.value < 0) throw new Error(`negative string length at ${offset}`)
  const start = offset + len.size
  if (start + len.value > buffer.length) throw new Error(`buffer ended while reading string at ${offset}`)
  return { value: buffer.toString('utf8', start, start + len.value), size: len.size + len.value }
}

function writeString (str) {
  const utf8 = Buffer.from(str, 'utf8')
  return Buffer.concat([writeVarInt(utf8.length), utf8])
}

// --- fml:loginwrapper framing: string channel + varint-length-prefixed payload ---

function parseLoginWrapper (buffer) {
  let offset = 0
  const channel = readString(buffer, offset)
  offset += channel.size
  const len = readVarInt(buffer, offset)
  offset += len.size
  return { channel: channel.value, data: buffer.slice(offset, offset + len.value) }
}

function wrapLoginPayload (channel, payload) {
  return Buffer.concat([writeString(channel), writeVarInt(payload.length), payload])
}

// --- fml:handshake messages ---

// S2CModList: mods (string list), channels (name+version pairs), registries
// (name list) and, on 1.19+, dataPackRegistries (name list). The trailing field
// is parsed only if bytes remain, so both layouts work.
function parseModList (buffer, offset) {
  const readList = (reader) => {
    const count = readVarInt(buffer, offset)
    offset += count.size
    const out = []
    for (let i = 0; i < count.value; i++) out.push(reader())
    return out
  }
  const readStr = () => {
    const s = readString(buffer, offset)
    offset += s.size
    return s.value
  }

  const mods = readList(readStr)
  const channels = readList(() => {
    const name = readStr()
    const marker = readStr()
    return { name, marker }
  })
  const registries = readList(readStr)
  const dataPackRegistries = offset < buffer.length ? readList(readStr) : []
  return { mods, channels, registries, dataPackRegistries }
}

function encodeModListReply (reply) {
  const parts = [writeVarInt(DISCRIMINATOR.MOD_LIST_REPLY)]
  parts.push(writeVarInt(reply.mods.length))
  for (const mod of reply.mods) parts.push(writeString(mod))
  parts.push(writeVarInt(reply.channels.length))
  for (const channel of reply.channels) {
    parts.push(writeString(channel.name), writeString(channel.marker))
  }
  parts.push(writeVarInt(reply.registries.length))
  for (const registry of reply.registries) {
    parts.push(writeString(registry.name), writeString(registry.marker))
  }
  return Buffer.concat(parts)
}

function encodeAcknowledgement () {
  return writeVarInt(DISCRIMINATOR.ACKNOWLEDGEMENT)
}

// S2CChannelMismatchData (disc 6) body: a FriendlyByteBuf map — varint count,
// then count x (string channelName, string reason) — of the channels
// NetworkRegistry.validateServerChannels rejected. The server sends it ONLY
// while rejecting us, and on 1.20.1 then closes the socket RAW
// (Connection#disconnect during login sends no login-disconnect packet), so
// the client otherwise sees nothing but ECONNRESET. This message is the one
// record of WHY the join failed.
function parseChannelMismatch (buffer, offset) {
  const count = readVarInt(buffer, offset)
  offset += count.size
  // every entry costs >= 2 bytes (two 1-byte string length prefixes); a count
  // the buffer can't hold is malformed — reject before looping (same rationale
  // as readRegistryIdMap: this runs synchronously inside the packet handler)
  if (count.value < 0 || count.value * 2 > buffer.length - offset) {
    throw new Error(`channel mismatch count ${count.value} exceeds buffer at ${offset}`)
  }
  const mismatched = {}
  for (let i = 0; i < count.value; i++) {
    const name = readString(buffer, offset)
    offset += name.size
    const reason = readString(buffer, offset)
    offset += reason.size
    mismatched[name.value] = reason.value
  }
  return mismatched
}

// Leading `ids` map of a ForgeRegistry.Snapshot: varint count, then count x
// (string name, varint id). That's enough to name modded content; the trailing
// aliases/overrides/blocked lists are not needed. Same inner layout on FML3
// (login) and 1.20.2+ (config-phase) registry messages.
function readRegistryIdMap (buffer, offset) {
  const count = readVarInt(buffer, offset)
  let size = count.size
  // every entry costs >= 2 bytes (1-byte string length + 1-byte id), so a
  // count the buffer can't possibly hold is malformed; reject it up front
  // instead of iterating - this parse runs synchronously inside the packet
  // handler, where a spun loop freezes the whole event loop (no timer or
  // watchdog can preempt it)
  if (count.value < 0 || count.value * 2 > buffer.length - offset - size) {
    throw new Error(`registry id map count ${count.value} exceeds buffer at ${offset}`)
  }
  const ids = new Map()
  for (let i = 0; i < count.value; i++) {
    const entryName = readString(buffer, offset + size)
    size += entryName.size
    const id = readVarInt(buffer, offset + size)
    size += id.size
    ids.set(id.value, entryName.value)
  }
  return { value: ids, size }
}

// S2CRegistry (disc 3) body: registryName (string), hasSnapshot (bool), then a
// ForgeRegistry.Snapshot whose leading ids map is kept. (There is no `dummied`
// field on the wire, despite older protodef schemas.) The parsed id->name Map
// is stashed on client.forgeRegistries[key]. Best-effort: callers wrap this so
// a parse failure just falls through to a plain ack.
function parseServerRegistry (client, buffer, offset) {
  const name = readString(buffer, offset)
  offset += name.size
  const key = SNAPSHOT_REGISTRIES[name.value]
  if (!key) return // not a registry we name from
  const hasSnapshot = buffer[offset] !== 0
  offset += 1
  if (!hasSnapshot) return

  const ids = readRegistryIdMap(buffer, offset)
  client.forgeRegistries = client.forgeRegistries || {}
  client.forgeRegistries[key] = ids.value
  debug(`parsed ${name.value} registry snapshot: ${ids.value.size} ids`)
}

/**
 * Installs the FML3 handshake responder on a connecting client, so a modless
 * protocol client can log into a Forge 1.18-1.20.1 server by mirroring the
 * server's own mod list back at it.
 *
 * @param {import('minecraft-protocol').Client} client client that is connecting to the server.
 * @param {{
 *  forgeMods: Array.<string> | undefined,      // override mod ids sent in the reply
 *  channels: Object.<string, string> | undefined,  // override channel name -> version
 *  registries: Object.<string, string> | undefined, // override registry name -> marker
 *  pingModVersions: Object.<string, string> | undefined // mod id -> version, for the forgeMods event
 * }} options
 */
module.exports = function (client, options) {
  options = options || {}

  // passed to src/client/setProtocol.js; marks the connection as a Forge FML3
  // client in the set_protocol server address field
  client.tagHost = '\0FML3\0'
  debug('FML3 handshake handler installed')

  // remove nmp's default login_plugin_request listener, which would answer
  // everything with "not understood" and get us kicked
  const nmpListener = client.listeners('login_plugin_request').find((fn) => fn.name === 'onLoginPluginRequest')
  if (nmpListener) client.removeListener('login_plugin_request', nmpListener)

  function respond (messageId, data) {
    client.write('login_plugin_response', { messageId, data })
  }

  client.on('login_plugin_request', (packet) => {
    if (packet.channel !== 'fml:loginwrapper') {
      // a mod talking on its own raw login channel; we can't speak it, so give
      // the vanilla "not understood" response
      debug(`unknown login channel ${packet.channel}, replying not-understood`)
      client.write('login_plugin_response', { messageId: packet.messageId })
      return
    }

    let wrapper
    try {
      wrapper = parseLoginWrapper(packet.data)
      const disc = readVarInt(wrapper.data, 0)

      if (wrapper.channel === 'fml:handshake' && disc.value === DISCRIMINATOR.MOD_LIST) {
        const modList = parseModList(wrapper.data, disc.size)
        debug(`server ModList: ${modList.mods.length} mods, ${modList.channels.length} channels, ${modList.registries.length} registries`)
        client.forgeModList = modList

        const pingVersions = options.pingModVersions || {}
        client.emit('forgeMods', modList.mods.map((id) =>
          pingVersions[id] ? { modid: id, version: pingVersions[id] } : id
        ))

        // Mirror the server's own mods, channels and registries back at it so
        // NetworkRegistry.validateClientChannels finds nothing to complain about.
        const reply = {
          mods: options.forgeMods || modList.mods,
          channels: options.channels
            ? Object.entries(options.channels).map(([name, marker]) => ({ name, marker }))
            : modList.channels,
          registries: options.registries
            ? Object.entries(options.registries).map(([name, marker]) => ({ name, marker }))
            : modList.registries.map((name) => ({ name, marker: '1.0' }))
        }
        respond(packet.messageId, wrapLoginPayload('fml:handshake', encodeModListReply(reply)))
        return
      }

      // ServerRegistry (disc 3): keep the id->name snapshot for item/block/
      // entity registries so the bot can name modded content, then still ack.
      // Parsing is best-effort - never let it break the handshake.
      if (wrapper.channel === 'fml:handshake' && disc.value === DISCRIMINATOR.SERVER_REGISTRY) {
        try {
          parseServerRegistry(client, wrapper.data, disc.size)
        } catch (err) {
          debug(`failed to parse ServerRegistry snapshot (${err.message}), acking anyway`)
        }
      }

      // ChannelMismatchData (disc 6): the server is REJECTING us and this is
      // the only packet that names the offending channels — log it and hand it
      // to the embedding app before the raw socket close erases the evidence.
      // Parsing is best-effort; we still fall through to the ack either way
      // (the server disconnects regardless, an ack is harmless).
      if (wrapper.channel === 'fml:handshake' && disc.value === DISCRIMINATOR.CHANNEL_MISMATCH) {
        try {
          const mismatched = parseChannelMismatch(wrapper.data, disc.size)
          const names = Object.keys(mismatched)
          console.warn(`[forge] server rejected our mod channels (${names.length}): ` +
            names.map((n) => (mismatched[n] ? `${n} (${mismatched[n]})` : n)).join(', '))
          client.forgeChannelMismatch = mismatched
          client.emit('forgeChannelMismatch', mismatched)
        } catch (err) {
          debug(`failed to parse S2CChannelMismatchData (${err.message})`)
        }
      }

      // Registry snapshots, config data, mod data, unknown fml:handshake
      // messages and mod login payloads wrapped in the loginwrapper: just
      // acknowledge so the negotiation keeps moving. The ack goes back in the
      // ORIGINATING inner channel: the server-side LoginWrapper routes the
      // reply to whichever channel the response names, so wrapping a mod
      // channel's reply in fml:handshake would deliver it to the FML handshake
      // handler ("unexpected index") while the real channel waits forever.
      debug(`acknowledging loginwrapper message channel=${wrapper.channel} discriminator=${disc.value} length=${wrapper.data.length}`)
      respond(packet.messageId, wrapLoginPayload(wrapper.channel, encodeAcknowledgement()))
    } catch (err) {
      // A request left unanswered hangs the login until the server times us
      // out, so an acknowledgement is always the least-bad answer. If even the
      // outer wrapper failed to parse there is no originating channel to name,
      // so fall back to fml:handshake.
      debug(`failed to handle loginwrapper payload (${err.message}), acknowledging anyway`)
      respond(packet.messageId, wrapLoginPayload(wrapper ? wrapper.channel : 'fml:handshake', encodeAcknowledgement()))
    }
  })
}

// FriendlyByteBuf primitives and registry-snapshot helpers, shared with the
// config-phase handshake (1.20.2+)
module.exports.readVarInt = readVarInt
module.exports.writeVarInt = writeVarInt
module.exports.readString = readString
module.exports.writeString = writeString
module.exports.readRegistryIdMap = readRegistryIdMap
module.exports.SNAPSHOT_REGISTRIES = SNAPSHOT_REGISTRIES
