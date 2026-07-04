'use strict'

const debug = require('debug')('minecraft-protocol-forge')
const { readVarInt } = require('./forgeHandshake3')

// Tolerant play-state deserializer, shared by every MinePal connection (not
// just Forge). Modded servers ship play packets the vanilla protocol cannot
// read - e.g. 1.20.5+ item stacks are typed data components and a modded
// server remaps the data_component_type registry ids, so slot-bearing packets
// (window_items, or the ~448KB declare_recipes a Fabric 1.21.x content server
// sends at join) misalign the parser. Stock protodef FullPacketParser loses
// either way: it swallows PartialReadError itself (stack dump + cb(), the
// packet is silently lost), while a HARD error takes cb(err), which destroys
// the read stream and silently kills the connection before spawn. This
// wrapper drops DEGRADABLE packets under a synthetic name so one exotic
// packet cannot take the session down, but fails LOUDLY (client 'error') when
// a session-critical packet is lost - a bot that cannot read keep_alive or
// position must exit into recovery, never zombie. On vanilla servers every
// packet parses, so this is a pure no-op.

// Play packets whose drop means the bot's inventory view is now wrong.
const INVENTORY_PACKETS = new Set(['window_items', 'set_slot', 'entity_equipment'])

// Play packets whose loss zombies the session: unanswered keep-alives time
// the connection out, and a lost join/position/respawn/chunk/health leaves
// mineflayer permanently wrong about the world. Dropping one of these must
// fail the session loudly instead. Canonical nmp names (minecraft-data play
// toClient mappings, stable across 1.8-1.21.x).
const CRITICAL_PACKETS = new Set(['keep_alive', 'login', 'position', 'respawn', 'map_chunk', 'update_health'])

// Resolve a clientbound play packet id to its name via minecraft-data (the same
// mapping nmp compiles), cached per version on the client. Used only for
// human-readable drop diagnostics, so any failure degrades to a hex id.
function resolvePlayPacketName (client, packetId) {
  try {
    if (!client._forgePlayPacketNames) {
      const mcData = require('minecraft-data')(client.version)
      const mapper = mcData.protocol.play.toClient.types.packet[1][0].type[1]
      const byId = {}
      for (const [key, name] of Object.entries(mapper.mappings)) byId[parseInt(key, 16)] = name
      client._forgePlayPacketNames = byId
    }
    return client._forgePlayPacketNames[packetId] || null
  } catch (err) {
    return null
  }
}

// protodef throws PartialReadError (err.partialReadError / name / message) when
// a packet runs off the end of the buffer - the dominant modded failure, since
// a mod-registered data-component patch on an item makes the whole window_items
// unreadable against the vanilla protocol.
function isPartialReadError (err) {
  return !!(err && (
    err.partialReadError === true ||
    err.name === 'PartialReadError' ||
    (err.constructor && err.constructor.name === 'PartialReadError') ||
    (typeof err.message === 'string' && (err.message.includes('Read error') || err.message.includes('buffer end') || err.message.includes('Reached end of buffer')))
  ))
}

function wrapDeserializer (client) {
  const deserializer = client.deserializer
  if (!deserializer || deserializer._forgeTolerant) return
  deserializer._forgeTolerant = true
  const parse = deserializer.parsePacketBuffer.bind(deserializer)
  deserializer.parsePacketBuffer = (buffer) => {
    try {
      const packet = parse(buffer)
      if (packet.metadata && packet.metadata.size !== buffer.length) {
        // partially-read packet (e.g. declare_commands with modded argument
        // parsers): keep the readable prefix, but stop FullPacketParser from
        // console-dumping the whole packet as hex
        debug(`partially parsed play packet ${packet.data && packet.data.name} (${packet.metadata.size}/${buffer.length} bytes)`)
        packet.metadata.size = buffer.length
      }
      return packet
    } catch (err) {
      // PartialReadError is handled IDENTICALLY to a hard error: it is the
      // dominant real failure (a modded item's mod-registered data-component
      // patch makes the whole window_items unparseable), and rethrowing it
      // alone would let FullPacketParser swallow it - the packet silently
      // lost with nothing but a console stack. Degradable packets are
      // synthesized into a drop; critical ones fail loudly below.
      let packetId = -1
      try {
        packetId = readVarInt(buffer, 0).value
      } catch (ignored) {}
      const packetName = resolvePlayPacketName(client, packetId)
      const label = packetName || (packetId >= 0 ? `0x${packetId.toString(16)}` : 'unknown(id=-1)')

      // Critical packet, or an id/name that cannot even be resolved (protocol
      // skew - nothing about this stream can be trusted): surface the parse
      // failure on the client so the embedder's classified disconnect and
      // recovery path runs. A PartialReadError must be emitted here because
      // FullPacketParser swallows it; a hard error reaches the client through
      // node-minecraft-protocol's own deserializer error path via the rethrow.
      if (packetName === null || CRITICAL_PACKETS.has(packetName)) {
        console.warn(`[mc-parse] unparseable session-critical ${label} packet (id=0x${packetId.toString(16)} length=${buffer.length}): ${err.message}; failing loudly instead of dropping`)
        if (isPartialReadError(err)) client.emit('error', err)
        throw err
      }

      client._forgeDropCounts = client._forgeDropCounts || {}
      const count = (client._forgeDropCounts[packetId] = (client._forgeDropCounts[packetId] || 0) + 1)
      if (count === 1 || count % 100 === 0) {
        // one warn per packet-id on the first drop, then every 100th
        const modded = !!(client.minepalForgeDetail || client.fabricRegistries || client.tagHost)
        const cause = modded
          ? "modded data the vanilla protocol can't read"
          : 'possible protocol version skew'
        console.warn(`[mc-parse] dropped unparseable ${label} packet (${cause}): ${err.message}; ${count} so far`)
      }
      debug(`dropping unparseable play packet ${label} id=0x${packetId.toString(16)} length=${buffer.length} partialRead=${isPartialReadError(err)}: ${err.message}`)

      // Inventory packets: the bot's item view is now wrong; MinePal listens
      // for this and logs it prominently (src/utils/mcdata.js). Non-inventory
      // drops keep the pre-existing synthetic name.
      if (packetName && INVENTORY_PACKETS.has(packetName)) {
        client.emit('forge_inventory_unreliable', { packet: packetName, id: packetId })
      }
      return {
        data: { name: 'forge_unparseable_packet', params: { id: packetId } },
        metadata: { size: buffer.length },
        buffer,
        fullBuffer: buffer
      }
    }
  }
}

/**
 * Installs the tolerant play-state deserializer on a client. Idempotent:
 * MinePal installs it once per client at creation, and the Forge config-phase
 * handshake installs it again for direct library users - the second install
 * is a no-op (client._tolerantPlayParser), and the per-deserializer
 * _forgeTolerant guard prevents a double wrap either way.
 *
 * @param {import('minecraft-protocol').Client} client client that is connecting to the server.
 */
module.exports = function installTolerantPlayParser (client) {
  if (client._tolerantPlayParser) return
  client._tolerantPlayParser = true
  debug('tolerant play deserializer installed')

  // nmp swaps in a fresh deserializer on every state change, so wrap the play
  // one as soon as it exists (and immediately, if already in play).
  client.on('state', (newState) => {
    if (newState !== 'play') return
    wrapDeserializer(client)
  })
  if (client.state === 'play') wrapDeserializer(client)
}
