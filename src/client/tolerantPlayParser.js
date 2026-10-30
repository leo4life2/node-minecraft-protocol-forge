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

// HF131 - THE PLAY-ENTRY LAW. On a host whose clientbound id table matches the
// pal's, the first clientbound play frame this client parses is `login` (a
// bundle_delimiter or a custom_payload may precede it). A decode failure of a
// clientbound play frame BEFORE this client has parsed its own login frame - a
// throw the base path would fail loudly on, a throw it would drop, or a partial
// read that leaves bytes over - is not one exotic packet: it is the id table
// itself (a mod that injects its own packet type early in the clientbound
// template shifts every later vanilla id by one, so every frame reads under the
// wrong name). The parser raises that ONCE as a typed fact it knows from the
// frame that failed first, and SUSPENDS the stream from that frame on: no
// misread frame is ever emitted as a packet event, so nothing downstream can
// answer one. After login the base tolerance path stands byte for byte.
const PLAY_ENTRY_PRELUDE = new Set(['bundle_delimiter', 'custom_payload'])
const PLAY_TABLE_MISMATCH_PACKET = 'forge_play_table_mismatch'

function playEntryOf (client) {
  // per play deserializer (nmp swaps one in per state change; a re-entered play
  // state begins with its own login frame again)
  client._forgePlayEntry = { loginSeen: false, framesBeforeLogin: 0, mismatch: null }
  return client._forgePlayEntry
}

function suspendedPacket (buffer, packetId) {
  return {
    data: { name: PLAY_TABLE_MISMATCH_PACKET, params: { id: packetId } },
    metadata: { size: buffer.length },
    buffer,
    fullBuffer: buffer
  }
}

function raisePlayTableMismatch (client, entry, buffer, packetId, packetName, outcome, cause) {
  const fact = {
    phase: 'play_entry',
    first_id: packetId,
    read_as: packetName,
    outcome,
    frames_before_login: entry.framesBeforeLogin
  }
  entry.mismatch = fact
  const label = packetName || (packetId >= 0 ? `id ${packetId}` : 'unknown id')
  console.warn(`[mc-parse] play-entry table mismatch: clientbound play frame id=${packetId} (${label}) failed (${outcome}) before this client's login frame; the stream is suspended from this frame on: ${cause && cause.message}`)
  client.emit('play_table_mismatch', fact)
  const handler = client._forgePlayTableMismatchHandler
  if (typeof handler === 'function') {
    try { handler(fact, cause) } catch (err) { debug(`play-table-mismatch handler threw: ${err.message}`) }
  } else {
    // no embedder owns the stop: fail loudly AND typed, never zombie
    const typed = new Error(`play table mismatch at play entry: clientbound play frame id ${packetId}${packetName ? ` read as ${packetName}` : ''} failed (${outcome}) before login`)
    typed.playTableMismatch = fact
    typed.cause = cause
    client.emit('error', typed)
  }
  return suspendedPacket(buffer, packetId)
}

function wrapDeserializer (client) {
  const deserializer = client.deserializer
  if (!deserializer || deserializer._forgeTolerant) return
  deserializer._forgeTolerant = true
  const entry = playEntryOf(client)
  const parse = deserializer.parsePacketBuffer.bind(deserializer)
  deserializer.parsePacketBuffer = (buffer) => {
    if (entry.mismatch) {
      // HF131: suspended - the table is wrong, nothing is parsed or emitted
      let packetId = -1
      try { packetId = readVarInt(buffer, 0).value } catch (ignored) {}
      return suspendedPacket(buffer, packetId)
    }
    try {
      const packet = parse(buffer)
      const name = packet.data && packet.data.name
      if (packet.metadata && packet.metadata.size !== buffer.length) {
        if (!entry.loginSeen && name !== 'login' && !PLAY_ENTRY_PRELUDE.has(name)) {
          // HF131: a frame that reads only partly under a name other than login
          // before login - the table, not the body
          let packetId = -1
          try { packetId = readVarInt(buffer, 0).value } catch (ignored) {}
          return raisePlayTableMismatch(client, entry, buffer, packetId, name || null, 'partial', new Error(`partial read ${packet.metadata.size}/${buffer.length}`))
        }
        // partially-read packet (e.g. declare_commands with modded argument
        // parsers): keep the readable prefix, but stop FullPacketParser from
        // console-dumping the whole packet as hex
        debug(`partially parsed play packet ${packet.data && packet.data.name} (${packet.metadata.size}/${buffer.length} bytes)`)
        packet.metadata.size = buffer.length
      }
      if (!entry.loginSeen) {
        if (name === 'login') entry.loginSeen = true
        else entry.framesBeforeLogin++
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

      // HF131: before this client's login frame the failure is the id table,
      // whatever the base path would have made of it (a loud failure or a drop)
      if (!entry.loginSeen) {
        const outcome = (packetName === null || CRITICAL_PACKETS.has(packetName)) ? 'throw' : 'drop'
        return raisePlayTableMismatch(client, entry, buffer, packetId, packetName, outcome, err)
      }

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
 * HF131: `onPlayTableMismatch(fact, cause)` lets the embedder own the stop on
 * the play-entry table mismatch (it is called once, from the frame that failed
 * first, after the stream is suspended); without it the parser emits a typed
 * client 'error' (err.playTableMismatch = the fact) so a classified end runs.
 * The first handler given wins; a later install without one keeps it.
 *
 * @param {import('minecraft-protocol').Client} client client that is connecting to the server.
 * @param {{onPlayTableMismatch?: function}} [opts]
 */
module.exports = function installTolerantPlayParser (client, opts = {}) {
  if (opts && typeof opts.onPlayTableMismatch === 'function' && !client._forgePlayTableMismatchHandler) {
    client._forgePlayTableMismatchHandler = opts.onPlayTableMismatch
  }
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
