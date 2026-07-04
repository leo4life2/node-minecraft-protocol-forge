const debug = require('debug')('minecraft-protocol-forge')
const { readVarInt, writeVarInt, readString, writeString } = require('./forgeHandshake3')
const installTolerantPlayParser = require('./tolerantPlayParser')

// Forge configuration-phase handshake (Minecraft 1.20.2+, protocol >= 764).
//
// Since 1.20.2 Forge negotiates during the vanilla configuration state instead
// of the login state. The server drives it through clientbound custom_payload
// packets on the 'forge:handshake' channel; each payload is a VarInt
// discriminator followed by FriendlyByteBuf fields
// (net.minecraftforge.network.HandshakeMessages, config-phase variant):
//
//   0  Acknowledge      -> clientbound never (our reply for 3/4)
//   1  ModVersions      -> map modid -> (displayName, version); mirror it back
//   2  ChannelVersions  -> map channel -> VarInt version; VALIDATED, echo verbatim
//   3  RegistryList     -> reply Acknowledge with the message's VarInt token
//   4  RegistryData     -> one per registry, each with the next token; ack each
//   5  ConfigData       -> no reply expected
//   6  MismatchData     -> only sent while rejecting us
//
// Registry/config payload contents are never applied, only acknowledged. The
// per-message token must be echoed exactly: a wrong token is an instant
// disconnect, and a MISSING ack hangs the configuration phase FOREVER - there
// is no server-side handshake timeout; the only ticking clock is keep_alive,
// which nmp auto-answers, so neither side ever gives up. A watchdog (below)
// exists precisely to fail fast instead of hanging in that case. After the
// forge:handshake tasks the vanilla configuration flow
// (select_known_packs, registry_data, tags, finish_configuration) proceeds and
// node-minecraft-protocol's own auto-replies take it to the play state.

const DISCRIMINATOR = {
  ACKNOWLEDGE: 0,
  MOD_VERSIONS: 1,
  CHANNEL_VERSIONS: 2,
  REGISTRY_LIST: 3,
  REGISTRY_DATA: 4,
  CONFIG_DATA: 5,
  MISMATCH_DATA: 6
}

// ModVersions: VarInt count, then count x (modid, displayName, version) strings
function parseModVersions (buffer, offset) {
  const count = readVarInt(buffer, offset)
  offset += count.size
  const mods = []
  for (let i = 0; i < count.value; i++) {
    const id = readString(buffer, offset)
    offset += id.size
    const name = readString(buffer, offset)
    offset += name.size
    const version = readString(buffer, offset)
    offset += version.size
    mods.push({ id: id.value, name: name.value, version: version.value })
  }
  return mods
}

// autoVersionForge hands the SAME options.forgeMods to both forgeHandshake3
// (Array<string>) and this file (expects Array<{id,name,version}>). Normalize
// so a string override carried from a 1.20.1 config to a 1.21 server can't turn
// into writeString(undefined) -> throw -> ModVersions never answered -> hang.
function normalizeMod (mod) {
  if (typeof mod === 'string') return { id: mod, name: mod, version: '1.0' }
  return {
    id: mod.id != null ? mod.id : (mod.name != null ? mod.name : ''),
    name: mod.name != null ? mod.name : (mod.id != null ? mod.id : ''),
    version: mod.version != null ? mod.version : '1.0'
  }
}

function encodeModVersions (mods) {
  const normalized = mods.map(normalizeMod)
  const parts = [writeVarInt(DISCRIMINATOR.MOD_VERSIONS), writeVarInt(normalized.length)]
  for (const mod of normalized) {
    parts.push(writeString(mod.id), writeString(mod.name), writeString(mod.version))
  }
  return Buffer.concat(parts)
}

function encodeAcknowledge (token) {
  return Buffer.concat([writeVarInt(DISCRIMINATOR.ACKNOWLEDGE), writeVarInt(token)])
}

/**
 * Installs the configuration-phase Forge handshake responder on a connecting
 * client, so a modless protocol client can join a Forge 1.20.2+ server by
 * mirroring the server's own mod and channel versions back at it.
 *
 * @param {import('minecraft-protocol').Client} client client that is connecting to the server.
 * @param {{
 *  forgeMods: Array.<{id: string, name: string, version: string}> | undefined // override mods sent in the ModVersions reply
 * }} options
 */
module.exports = function (client, options) {
  // Two installs -> duplicate replies/acks -> instant server disconnect at
  // registry sync. Guard like _forgeTolerant does for the play deserializer.
  if (client._forgeConfigHandshake) return
  client._forgeConfigHandshake = true

  options = options || {}

  // passed to src/client/setProtocol.js; marks the connection as MODDED in the
  // set_protocol server address field. 1.20.2+ Forge expects exactly '\0FORGE'
  // (no trailing separator, no version digit - unlike the older '\0FML3\0').
  client.tagHost = '\0FORGE'
  debug('Forge config-phase handshake handler installed')

  function send (data) {
    client.write('custom_payload', { channel: 'forge:handshake', data })
  }

  // A missing/unanswerable forge:handshake reply hangs configuration forever
  // (see module header). Arm a watchdog once handshake activity starts, reset
  // it on every handled message, and if PLAY is never reached, emit a
  // descriptive error naming the last thing we saw so the embedder fails fast.
  const CONFIG_HANDSHAKE_TIMEOUT_MS = 20000
  let watchdog = null
  let lastActivity = 'none'
  function clearWatchdog () {
    if (watchdog) { clearTimeout(watchdog); watchdog = null }
  }
  function armWatchdog () {
    clearWatchdog()
    watchdog = setTimeout(() => {
      watchdog = null
      if (client.state === 'play' || client.ended) return
      client.emit('error', new Error(
        `Forge config-phase handshake stalled for ${CONFIG_HANDSHAKE_TIMEOUT_MS}ms without reaching play ` +
        `(last forge:handshake activity: ${lastActivity}); a required reply was likely missing or unanswerable`))
    }, CONFIG_HANDSHAKE_TIMEOUT_MS)
    if (watchdog.unref) watchdog.unref()
  }
  client.on('state', (newState) => { if (newState === 'play') clearWatchdog() })
  client.on('end', clearWatchdog)
  client.on('error', clearWatchdog)

  client.on('custom_payload', (packet) => {
    if (client.state !== 'configuration') return
    if (packet.channel !== 'forge:handshake') return

    armWatchdog()
    try {
      const disc = readVarInt(packet.data, 0)
      switch (disc.value) {
        case DISCRIMINATOR.MOD_VERSIONS: {
          lastActivity = 'ModVersions(1)'
          let mods = []
          try {
            mods = parseModVersions(packet.data, disc.size)
          } catch (err) {
            debug(`failed to parse ModVersions (${err.message}), replying with empty mod map`)
          }
          debug(`server ModVersions: ${mods.length} mods`)
          if (mods.length > 0) {
            client.forgeModList = mods
            client.emit('forgeMods', mods.map((mod) => ({ modid: mod.id, version: mod.version })))
          }
          // Content is not validated server-side (an empty map also passes);
          // mirror the server's own map back like a matching client would. On
          // ANY encode failure (e.g. a bad forgeMods override), fall back to
          // mirroring the server's own ModVersions - the least-bad answer that
          // still keeps the handshake moving.
          try {
            send(encodeModVersions(options.forgeMods || mods))
          } catch (err) {
            console.warn(`[forge] failed to encode ModVersions reply (${err.message}); mirroring server's own list`)
            send(encodeModVersions(mods))
          }
          break
        }
        case DISCRIMINATOR.CHANNEL_VERSIONS:
          // channel -> VarInt version map. This one IS validated: a mismatch
          // gets us MismatchData + disconnect, so echo the payload verbatim.
          lastActivity = 'ChannelVersions(2)'
          debug(`echoing ChannelVersions (${packet.data.length} bytes)`)
          send(packet.data)
          break
        case DISCRIMINATOR.REGISTRY_LIST:
        case DISCRIMINATOR.REGISTRY_DATA: {
          const token = readVarInt(packet.data, disc.size)
          lastActivity = `${disc.value === DISCRIMINATOR.REGISTRY_LIST ? 'RegistryList(3)' : 'RegistryData(4)'} token=${token.value}`
          debug(`acknowledging ${disc.value === DISCRIMINATOR.REGISTRY_LIST ? 'RegistryList' : 'RegistryData'} token=${token.value}`)
          send(encodeAcknowledge(token.value))
          break
        }
        case DISCRIMINATOR.CONFIG_DATA:
          // Known, benign, no reply expected - stay quiet (debug-only).
          lastActivity = 'ConfigData(5)'
          debug(`ignoring ConfigData length=${packet.data.length}`)
          break
        case DISCRIMINATOR.MISMATCH_DATA:
          lastActivity = 'MismatchData(6)'
          debug('server reported channel mismatch, expect disconnect')
          break
        default: {
          // An unknown discriminator can be a mod's own reply-gated task on a
          // channel we don't speak, which would hang us - surface it (not
          // debug-only) so a stall has a named cause.
          const hex = packet.data.slice(0, Math.min(8, packet.data.length)).toString('hex')
          lastActivity = `unknown-discriminator(${disc.value})`
          console.warn(`[forge] unhandled forge:handshake discriminator=${disc.value} length=${packet.data.length} prefix=0x${hex}`)
          break
        }
      }
    } catch (err) {
      const hex = packet.data.slice(0, Math.min(8, packet.data.length)).toString('hex')
      console.warn(`[forge] failed to handle forge:handshake config payload length=${packet.data.length} prefix=0x${hex}: ${err.message}`)
    }
  })

  // Raw node-minecraft-protocol does not answer the configuration-state ping
  // (mineflayer does, globally). Only step in when nobody else will.
  client.on('ping', (packet) => {
    if (client.state !== 'configuration') return
    if (client.listenerCount('ping') > 1) return
    client.write('pong', { id: packet.id })
  })

  // Modded play packets (e.g. data-component-bearing slots on 1.20.5+) can be
  // unparseable against the vanilla protocol; the shared tolerant deserializer
  // drops them instead of letting protodef destroy the stream. MinePal already
  // installs it per-client at creation (client._tolerantPlayParser), in which
  // case this is a no-op; direct library users get it installed here.
  installTolerantPlayParser(client)
}
