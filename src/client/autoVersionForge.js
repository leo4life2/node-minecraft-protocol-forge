'use strict'

const forgeHandshake = require('./forgeHandshake')
const forgeHandshake2 = require('./forgeHandshake2')
const forgeHandshake3 = require('./forgeHandshake3')
const forgeHandshakeConfig = require('./forgeHandshakeConfig')
const decodeOptimized = require('./decodeOptimized')

// 1.20.2 moved the Forge handshake from the login state into the vanilla
// configuration state; everything at or above this protocol uses the
// config-phase responder instead of FML3.
const PROTOCOL_1_20_2 = 764
const debug = require('debug')('minecraft-protocol-forge')

module.exports = function (client, options) {
  options = options || {}
  if (!client.autoVersionHooks) client.autoVersionHooks = []

  // FML1 (1.7 - 1.12): mod list is plain in the ping's modinfo
  client.autoVersionHooks.push(function (response) {
    if (!response.modinfo || response.modinfo.type !== 'FML') {
      return // not ours
    }

    // Use the list of Forge mods from the server ping, so client will match server
    const forgeMods = response.modinfo.modList
    debug('FML server detected, using forgeMods:', forgeMods)

    if (options.forgeSpoof === false) {
      debug('FML server detected but forgeSpoof is disabled, connecting as vanilla')
      return
    }

    // Install the FML|HS plugin with the given mods
    forgeHandshake(client, { forgeMods })
  })

  // FML2 (1.13 - 1.17): mod list is plain in the ping's forgeData
  client.autoVersionHooks.push(function (response) {
    if (!response.forgeData || response.forgeData.fmlNetworkVersion !== 2) {
      return // not ours
    }

    const forgeMods = response.forgeData.mods
    debug('FML2 server detected, using forgeMods:', forgeMods)

    if (options.forgeSpoof === false) {
      debug('FML2 server detected but forgeSpoof is disabled, connecting as vanilla')
      return
    }

    forgeHandshake2(client, { forgeMods })
  })

  // FML3 (1.18 - 1.20.1): fmlNetworkVersion 3; mods and channels are packed
  // into the compressed forgeData.d blob (or, on early 1.18 builds, still plain)
  client.autoVersionHooks.push(function (response) {
    const forgeData = response.forgeData
    if (!forgeData) return // not ours
    // 1.20.2+ Forge still ships forgeData.d in the ping, but its handshake
    // lives in the configuration phase - handled by the hook below
    if (response.version.protocol >= PROTOCOL_1_20_2) return
    if (forgeData.fmlNetworkVersion !== 3 && !forgeData.d) return // not ours

    let ping = null
    if (forgeData.d) {
      try {
        ping = decodeOptimized(forgeData.d)
      } catch (err) {
        debug(`failed to decode forgeData.d: ${err.message}`)
      }
    } else if (Array.isArray(forgeData.channels)) {
      ping = {
        truncated: !!forgeData.truncated,
        mods: (forgeData.mods || []).map((mod) => ({ id: mod.modId, version: mod.modmarker })),
        channels: forgeData.channels.map((ch) => ({ name: ch.res, version: ch.version, required: !!ch.required }))
      }
    }

    const pingModVersions = {}
    if (ping && ping.mods.length > 0) {
      for (const mod of ping.mods) pingModVersions[mod.id] = mod.version
      client.forgePingMods = ping.mods
      client.emit('forgeMods', ping.mods.map((mod) => ({ modid: mod.id, version: mod.version })))
    }

    // Always run the FML3 handshake, like a real Forge client would. Whether a
    // server accepts plain-vanilla connections is decided by server-side
    // channel predicates that are NOT exposed in the ping (the per-channel
    // "required" flag measures something else - verified empirically), so
    // vanilla-when-possible cannot be detected reliably up front. Mirroring the
    // server's own mod list passes channel validation on every server class,
    // including ones that would also have accepted vanilla.
    if (options.forgeSpoof === false) {
      debug('FML3 server detected but forgeSpoof is disabled, connecting as vanilla')
      return
    }

    debug(`FML3 server detected (${ping ? ping.mods.length : 'unknown'} mods), installing handshake spoof`)
    forgeHandshake3(client, {
      forgeMods: options.forgeMods,
      channels: options.channels,
      registries: options.registries,
      pingModVersions
    })
  })

  // Config-phase Forge (1.20.2+): forgeData is still in the ping, but the
  // handshake happens in the configuration state. NeoForge is deliberately not
  // handled here: its ping carries no forgeData and its config phase needs
  // nothing beyond the vanilla pong (which mineflayer already sends); servers
  // with mandatory modded payloads reject modless clients regardless.
  client.autoVersionHooks.push(function (response) {
    const forgeData = response.forgeData
    if (!forgeData) return // not ours
    if (response.version.protocol < PROTOCOL_1_20_2) return // login-phase FML above

    let ping = null
    if (forgeData.d) {
      try {
        // 1.20.2+ (protocol >= 764) writes per-channel versions as VarInt
        ping = decodeOptimized(forgeData.d, { varIntChannelVersions: true })
      } catch (err) {
        debug(`failed to decode forgeData.d: ${err.message}`)
      }
    }
    if (ping && ping.mods.length > 0) {
      client.forgePingMods = ping.mods
      client.emit('forgeMods', ping.mods.map((mod) => ({ modid: mod.id, version: mod.version })))
    }

    if (options.forgeSpoof === false) {
      debug('config-phase Forge server detected but forgeSpoof is disabled, connecting as vanilla')
      return
    }

    debug(`config-phase Forge server detected (${ping ? ping.mods.length : 'unknown'} mods), installing handshake spoof`)
    forgeHandshakeConfig(client, { forgeMods: options.forgeMods })
  })
}
