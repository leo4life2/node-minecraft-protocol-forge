'use strict'

const fs = require('fs')
const path = require('path')
const forgeHandshake = require('./forgeHandshake')
const forgeHandshake2 = require('./forgeHandshake2')
const forgeHandshake3 = require('./forgeHandshake3')
const forgeHandshakeConfig = require('./forgeHandshakeConfig')
const decodeOptimized = require('./decodeOptimized')
const { deriveNeoForgeComponents } = require('./neoForgePayloadDerivation')
const { installNeoForgeConfigNegotiation } = require('./neoForgeConfig')

// top-level jars in the resolved local mods folder(s)
function listModJars (modsPaths) {
  const jars = []
  for (const dir of modsPaths || []) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.jar')) jars.push(path.join(dir, f))
      }
    } catch { /* unreadable dir: honest miss */ }
  }
  return jars
}

// The neoforge universal jar carries NetworkInitialization (the built-in
// channel registrations that opt into registry sync + data-map negotiation).
// Launchers keep it in a `libraries` tree near the instance: vanilla
// launcher .minecraft/libraries, CurseForge minecraft/Install/libraries,
// servers ./libraries. Walk a few levels up from the mods folder and take
// the newest universal jar found. Missing is tolerated (mod channels alone
// still negotiate; registry sync is then skipped by the server).
function findNeoForgeLoaderJars (modsPaths) {
  for (const modsDir of modsPaths || []) {
    let dir = path.resolve(modsDir)
    for (let depth = 0; depth < 5; depth++) {
      dir = path.dirname(dir)
      for (const libRoot of [path.join(dir, 'libraries'), path.join(dir, 'Install', 'libraries')]) {
        const neoRoot = path.join(libRoot, 'net', 'neoforged', 'neoforge')
        try {
          const versions = fs.readdirSync(neoRoot).sort().reverse()
          for (const v of versions) {
            const jar = path.join(neoRoot, v, `neoforge-${v}-universal.jar`)
            if (fs.existsSync(jar)) {
              debug(`neoforge universal jar located: ${jar}`)
              return [jar]
            }
          }
        } catch { /* no libraries tree here */ }
      }
    }
  }
  debug('no neoforge universal jar found near the mods folder(s) — built-in channels unclaimed')
  return []
}

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

    // modsPaths: same source as FML3 — jar-derived wrapped-channel login
    // replies (and honest failures) also apply to the FML2 login phase
    forgeHandshake2(client, { forgeMods, modsPaths: options.modsPaths || options.owoModsPaths })
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
      // local instance mods folder(s): source for jar-DERIVED mod login
      // replies (owo fingerprints, SimpleChannel login acks). The embedding
      // app resolves it (or the MINEPAL_FORGE_MODS_DIR env var applies
      // downstream). Previously dropped here, which orphaned owoModsPaths.
      modsPaths: options.modsPaths || options.owoModsPaths,
      pingModVersions
    })
  })

  // NeoForge 1.20.5+: the ping carries isModded with NO forgeData (NeoForge
  // dropped the FML ping payload after 1.20.1) and the join is decided by the
  // config-phase modded-network negotiation (neoforge:register /
  // neoforge:network). The component tuples the negotiator demands are
  // derived STATICALLY from the local instance's jars (options.modsPaths, the
  // same folder the login-phase derivations use) plus the neoforge universal
  // jar when it can be found near the instance. Without jars this stays a
  // plain vanilla attempt (servers whose modded channels are all optional
  // accept those; ones with required channels reject us exactly as before).
  client.autoVersionHooks.push(function (response) {
    if (response.forgeData || response.modinfo) return // Forge hooks own those
    const protocol = (response.version && response.version.protocol) || 0
    if (response.isModded !== true || protocol < PROTOCOL_1_20_2) return
    if (options.forgeSpoof === false) {
      debug('NeoForge 1.20.5+ server detected but forgeSpoof is disabled, connecting as vanilla')
      return
    }
    const modsPaths = options.modsPaths || options.owoModsPaths || []
    const jarPaths = listModJars(modsPaths)
    const loaderJars = options.neoForgeLoaderJars || findNeoForgeLoaderJars(modsPaths)
    if (jarPaths.length === 0) {
      debug('NeoForge 1.20.5+ server detected but no local mod jars resolved — attempting vanilla join')
      return
    }
    try {
      const { components, diagnostics } = deriveNeoForgeComponents([...jarPaths, ...loaderJars])
      // channels the transport does not implement must not be claimed:
      // neoforge:split would invite split payloads this responder cannot
      // reassemble yet.
      for (const proto of Object.keys(components)) {
        components[proto] = components[proto].filter((c) => c.id !== 'neoforge:split')
      }
      debug(`NeoForge 1.20.5+ server detected — claiming ${components.configuration.length} configuration + ${components.play.length} play jar-derived components (${jarPaths.length} mod jars, ${loaderJars.length} loader jars, ${diagnostics.abstains.length} abstains)`)
      installNeoForgeConfigNegotiation(client, { components })
      client.emit('neoForgeDerivation', { components, diagnostics })
    } catch (err) {
      debug(`NeoForge component derivation failed (${err.message}) — attempting vanilla join`)
    }
  })

  // Config-phase Forge (1.20.2+): forgeData is still in the ping, but the
  // handshake happens in the configuration state.
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
