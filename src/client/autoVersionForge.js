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
const { warmLoginAssessmentsDetailed, warmLoginAssessmentsSync, exportLoginAssessments, importLoginAssessments, isLoginAssessmentCached } = require('./loginAckDerivation')

// HF38: THE PRE-LOGIN DERIVATION. The inputs of every jar-derived login
// verdict — the ping's channel census + the local instance jars — are known
// before login_start, so the verdicts are computed here, off the login path
// (HF12's warm-up), and made persistent through the embedder's store
// (options.loginAssessmentStore: { load() -> entries, save(entries) }, keyed
// by the embedder on its jar census so any pack change invalidates it). The
// timeline is filed on the client (forgePreloginDerivation) for the
// login-window summary and the join receipts. Never on the reply path:
// an unwarmed channel still assesses inline (timed by the ledger).
const DEFAULT_PRELOGIN_SYNC_BUDGET_MS = 8000

function preloginDerivation (client, options, channelNames, modsPaths) {
  const store = options && options.loginAssessmentStore
  let imported = 0
  if (store && typeof store.load === 'function') {
    try { imported = importLoginAssessments(store.load()) } catch (err) { debug(`login-assessment store load failed (${err.message})`) }
  }
  // Phase 1 — SYNCHRONOUS, on the ping hook's own turn: nmp emits
  // connect_allowed only after every hook returns, so everything assessed
  // here is provably before set_protocol (the server's clock does not exist
  // yet). Bounded (options.preloginSyncBudgetMs, default 8 s); with the
  // persistent store it is ~0 ms on every run after the first.
  // HF46: an OFF-THREAD warmer (options.loginAssessmentWarm(channelNames, modsPaths)
  // -> Promise<entries as exportLoginAssessments() shapes them>) replaces both the
  // on-loop sync pass and the setImmediate stepping that used to assess one
  // channel per turn (each a full jar walk: seconds of blocked loop per step on a
  // large local mods folder, right through PLAY entry — the keep-alive timeout
  // mechanism). Entries import into the cache as they arrive; a query that lands
  // before its channel is warm still takes the inline path (unchanged).
  const warm = options && typeof options.loginAssessmentWarm === 'function' ? options.loginAssessmentWarm : null
  if (warm) {
    const startedAt = Date.now()
    const queue = (channelNames || []).filter((ch) => typeof ch === 'string' && ch.includes(':') && !/^(fml|forge|minecraft):/.test(ch))
    const pathsKey = (modsPaths || []).filter(Boolean).join('|')
    const cachedNow = queue.filter((ch) => isLoginAssessmentCached(`${pathsKey}::${ch}`)).length
    const pre = { assessed: cachedNow, fromCache: cachedNow, ms: 0, syncMs: 0, imported, channels: queue.length, startedAt, finishedAt: null, finishedBeforeLoginStart: null, remaining: queue.length - cachedNow, offThread: true }
    client.forgePreloginDerivation = pre
    const report = () => {
      console.log(`[forge] pre-login derivation: ${pre.assessed} login-channel verdict(s) ready in ${pre.ms} ms (${pre.fromCache} from cache, ${pre.assessed - pre.fromCache} assessed OFF the main thread; ${pre.remaining} still pending when the login started: ${pre.finishedBeforeLoginStart === false ? 'inline path covers them' : 'none'})`)
      if (store && typeof store.save === 'function' && pre.assessed > pre.fromCache) {
        try { store.save(exportLoginAssessments()) } catch (err) { debug(`login-assessment store save failed (${err.message})`) }
      }
    }
    if (pre.remaining === 0) { pre.finishedAt = startedAt; pre.finishedBeforeLoginStart = true; report(); return Promise.resolve(pre) }
    return Promise.resolve()
      .then(() => warm(queue.filter((ch) => !isLoginAssessmentCached(`${pathsKey}::${ch}`)), modsPaths))
      .then((entries) => {
        const n = importLoginAssessments(entries)
        const startAt = client.forgeLoginWindow && client.forgeLoginWindow.startAt
        pre.finishedAt = Date.now()
        pre.ms = pre.finishedAt - startedAt
        pre.assessed = cachedNow + n
        pre.finishedBeforeLoginStart = startAt == null || pre.finishedAt <= startAt
        pre.remaining = Math.max(0, queue.length - pre.assessed)
        report()
        return pre
      })
      .catch((err) => { debug(`off-thread login assessment warm failed (${err && err.message}); inline path covers every channel`); pre.error = String(err && err.message); return pre })
  }
  const syncBudget = Number.isFinite(options && options.preloginSyncBudgetMs) ? options.preloginSyncBudgetMs : DEFAULT_PRELOGIN_SYNC_BUDGET_MS
  const sync = warmLoginAssessmentsSync(channelNames, modsPaths, syncBudget)
  const startedAt = Date.now() - sync.ms
  const pre = { assessed: sync.assessed, fromCache: sync.fromCache, ms: sync.ms, syncMs: sync.ms, imported, channels: (channelNames || []).length, startedAt, finishedAt: Date.now(), finishedBeforeLoginStart: true, remaining: sync.remaining.length }
  client.forgePreloginDerivation = pre
  const report = () => {
    if (pre.assessed > 0 || pre.channels > 0) {
      console.log(`[forge] pre-login derivation: ${pre.assessed} login-channel verdict(s) ready in ${pre.ms} ms (${pre.syncMs} ms before the connection was allowed; ${pre.fromCache} already cached, ${imported} imported from the persistent store)${pre.finishedBeforeLoginStart ? ' — before login_start' : ` — ${pre.remaining} finished AFTER login_start`}`)
    }
    if (store && typeof store.save === 'function' && pre.assessed > pre.fromCache) {
      try { store.save(exportLoginAssessments()) } catch (err) { debug(`login-assessment store save failed (${err.message})`) }
    }
  }
  if (sync.remaining.length === 0) { report(); return Promise.resolve(pre) }
  // Phase 2 — the rest, chunked one channel per turn (HF12's shape); the
  // login path's inline assessment (timed by the ledger) covers a channel
  // the server asks about before its verdict is ready.
  return warmLoginAssessmentsDetailed(sync.remaining, modsPaths)
    .then((facts) => {
      const startAt = client.forgeLoginWindow && client.forgeLoginWindow.startAt
      pre.assessed += facts.assessed
      pre.fromCache += facts.fromCache
      pre.finishedAt = facts.finishedAt
      pre.ms = pre.finishedAt - startedAt
      pre.finishedBeforeLoginStart = startAt == null || facts.finishedAt <= startAt
      report()
      return pre
    })
    .catch(() => null) // inline assessment still covers every channel
}

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
// Selection semantics live in neoForgeLoaderLocator (one selector: exact
// server-announced build first, else numerically newest local build).
// Missing is tolerated (mod channels alone still negotiate; registry sync is
// then skipped by the server).
const { pickNeoForgeLoaderJars } = require('./neoForgeLoaderLocator')

function findNeoForgeLoaderJars (modsPaths, preferredVersion) {
  const picked = pickNeoForgeLoaderJars(modsPaths, { preferredVersion })
  if (picked.jars.length > 0) {
    debug(`neoforge universal jar located: ${picked.jars[0]}${picked.matchedPreferred ? ' (matches the server-announced build)' : ''}`)
  } else {
    debug('no neoforge universal jar found near the mods folder(s) — built-in channels unclaimed')
  }
  return picked.jars
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
    const fml2ModsPaths = options.modsPaths || options.owoModsPaths
    // HF13: the ping's mod list is announced-reality evidence for the
    // wrapped-channel corroboration gate, same as FML3 below.
    const fml2PingVersions = {}
    for (const mod of forgeMods || []) {
      const id = mod && (mod.modId ?? mod.modid ?? mod.id)
      if (id != null) fml2PingVersions[id] = mod.modmarker ?? mod.version ?? null
    }
    // HF23: the embedder's announced-mod acquisition accessor (lazy, only
    // for an 'unknown + announced' login channel) rides both login-phase eras.
    forgeHandshake2(client, { forgeMods, modsPaths: fml2ModsPaths, pingModVersions: fml2PingVersions, announcedModAcquisition: options.announcedModAcquisition, mcVersion: options.mcVersion })
    // HF12: same off-path warmup as FML3 (see below) — the FML2 wrapped-mod
    // login lane shares the inline assessment and its exposure.
    if (Array.isArray(response.forgeData.channels)) {
      preloginDerivation(client, options, response.forgeData.channels.map((ch) => ch.res), fml2ModsPaths)
    }
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
    const modsPaths = options.modsPaths || options.owoModsPaths
    forgeHandshake3(client, {
      forgeMods: options.forgeMods,
      channels: options.channels,
      registries: options.registries,
      // local instance mods folder(s): source for jar-DERIVED mod login
      // replies (owo fingerprints, SimpleChannel login acks). The embedding
      // app resolves it (or the MINEPAL_FORGE_MODS_DIR env var applies
      // downstream). Previously dropped here, which orphaned owoModsPaths.
      modsPaths,
      pingModVersions,
      // HF23: announced-mod acquisition accessor (embedder-owned network +
      // cache policy; this lib only awaits it) + the MC version it keys on
      announcedModAcquisition: options.announcedModAcquisition,
      mcVersion: options.mcVersion
    })
    // HF12: precompute the jar verdicts for every pinged mod channel while
    // the connection is still being set up — the inline cold assessment used
    // to run INSIDE the login_plugin_request handler (~650ms on the receipt's
    // TACZ pack), long enough for the server to complete negotiation and arm
    // compression while our reply was still being computed. Chunked one
    // channel per turn; failures leave the inline path as the fallback.
    // HF38: the warm-up is the PRE-LOGIN derivation — its inputs (the ping's
    // channel census + the local instance jars) are known before login_start,
    // so the verdicts are computed here and, through the embedder's
    // persistent store (options.loginAssessmentStore: { load(), save(entries) },
    // keyed on the jar census), survive the process. Its timeline is filed on
    // the client for the login-window summary and the join receipts.
    if (ping && Array.isArray(ping.channels)) {
      preloginDerivation(client, options, ping.channels.map((ch) => ch.name), modsPaths)
    }
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
    const loaderJars = options.neoForgeLoaderJars || findNeoForgeLoaderJars(modsPaths, options.neoForgePreferredVersion)
    if (jarPaths.length === 0) {
      debug('NeoForge 1.20.5+ server detected but no local mod jars resolved — attempting vanilla join')
      return
    }
    try {
      const { components, diagnostics, syncContracts } = deriveNeoForgeComponents([...jarPaths, ...loaderJars])
      // channels the transport does not implement must not be claimed:
      // neoforge:split would invite split payloads this responder cannot
      // reassemble yet.
      for (const proto of Object.keys(components)) {
        components[proto] = components[proto].filter((c) => c.id !== 'neoforge:split')
      }
      debug(`NeoForge 1.20.5+ server detected — claiming ${components.configuration.length} configuration + ${components.play.length} play jar-derived components (${jarPaths.length} mod jars, ${loaderJars.length} loader jars, ${diagnostics.abstains.length} abstains)`)
      installNeoForgeConfigNegotiation(client, { components, syncContracts })
      client.emit('neoForgeDerivation', { components, diagnostics, syncContracts })
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
