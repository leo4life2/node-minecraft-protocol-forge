// NeoForge universal-jar locator — the ONE selector of the local loader jar
// the component derivation claims built-in channels from.
//
// The neoforge universal jar carries NetworkInitialization (the built-in
// channel registrations that opt into registry sync + data-map negotiation).
// Launchers keep it in a `libraries` tree near the instance: vanilla launcher
// .minecraft/libraries, CurseForge minecraft/Install/libraries, servers
// ./libraries. A machine often carries SEVERAL builds side by side (shared
// libraries trees, multiple instances), and the server's config-phase kick
// names the exact build it runs ("NeoForge 21.1.216" — NetworkRegistry,
// wire truth). Selection law:
//   1. when the caller knows the server's announced build
//      (preferredVersion) and that exact build exists locally, use it —
//      wire truth we can honor;
//   2. otherwise the numerically newest local build (segment-wise numeric
//      compare — lexicographic sort ranks 21.1.9 above 21.1.100 and is
//      wrong for real NeoForge build numbers) AMONG THE BUILDS OF THE WORLD'S
//      GAME VERSION when the caller hands it (HF100: a NeoForge build number
//      carries the game version it was built for in its leading components -
//      26.1.2.121 is a 26.1.2 loader, 26.3.0.83 a 26.3 loader, 21.1.216 a
//      1.21.1 loader; a loader of another game version is never the running
//      loader, so it is NAMED (foreignBuilds, the abstain enum) and handed
//      back only as a stamped GUESS the caller may read to keep a join alive,
//      never as a claim).
// Nothing here fabricates anything: no local jar, no built-in claims.
//
// PRIVACY: local filesystem reads only, bounded walk (5 levels up from each
// mods folder), never touches the network.
'use strict'

const fs = require('fs')
const path = require('path')

/** Segment-wise numeric-aware version compare (non-numeric segments compare as strings). */
function compareNeoForgeVersions (a, b) {
  const as = String(a).split(/[.-]/)
  const bs = String(b).split(/[.-]/)
  const len = Math.max(as.length, bs.length)
  for (let i = 0; i < len; i++) {
    const av = as[i]
    const bv = bs[i]
    // HF4 L1: when one side runs out of segments, a MISSING segment beats a
    // non-numeric (pre-release) segment — '21.1.0' outranks '21.1.0-beta' —
    // while a numeric-longer build still wins ('21.1.0.1' > '21.1.0').
    if (av === undefined) return /^\d+$/.test(String(bv)) ? -1 : 1
    if (bv === undefined) return /^\d+$/.test(String(av)) ? 1 : -1
    const an = /^\d+$/.test(av) ? Number(av) : NaN
    const bn = /^\d+$/.test(bv) ? Number(bv) : NaN
    if (!Number.isNaN(an) && !Number.isNaN(bn)) {
      if (an !== bn) return an - bn
    } else if (av !== bv) {
      return av < bv ? -1 : 1
    }
  }
  return 0
}

/** HF100: the abstain enum of a pick whose every local build is of another game version. */
const LOADER_ABSTAIN_FOREIGN_GAME_VERSION = 'foreign-game-version'

/** The leading numeric segments of a version-like name, as numbers (stops at the first non-numeric segment). */
function numericLead (name) {
  const nums = []
  for (const seg of String(name ?? '').split(/[.-]/)) {
    if (!/^\d+$/.test(seg)) break
    nums.push(Number(seg))
  }
  return nums
}

/** Trailing zero components dropped ('26.3.0' and '26.3' name the same game version); never below one component. */
function dropTrailingZeros (comps) {
  const out = comps.slice()
  while (out.length > 1 && out[out.length - 1] === 0) out.pop()
  return out
}

/**
 * HF100 r3: the NeoForge lines numbered BEFORE the game-version scheme - data,
 * keyed by a build's leading number, valued as the game-version axis that line
 * names (the same shape neoForgeBuildGameAxis returns). From the NeoForge
 * release history: the project forked from Forge at Minecraft 1.20.1 and kept
 * Forge's 47.1.x numbering for that one line (47.1.3 was the first NeoForge
 * release, August 2023; every later 1.20.1 build is 47.1.x); from 1.20.2 on
 * each build is named after its game version (20.2.x and up). No other line
 * exists before the scheme, so the table has one row.
 */
const NEOFORGE_LEGACY_LINE_GAME_AXIS = Object.freeze({ 47: Object.freeze([20, 1]) })

/**
 * HF100: the game-version axis of a NeoForge build number - the numeric
 * leading segments minus the LAST one (the build counter), trailing zeros
 * dropped. NeoForge names every build after the game version it is built
 * for; the 1.x line drops Minecraft's leading major (the scheme, not a
 * version): 20.2.88 -> [20, 2] (1.20.2), 21.1.0-beta -> [21, 1] (1.21.1),
 * 26.1.2.121 -> [26, 1, 2] (26.1.2), 26.3.0.83 -> [26, 3] (26.3). A line
 * numbered before that scheme reads its axis from NEOFORGE_LEGACY_LINE_GAME_AXIS
 * (47.1.106 -> [20, 1], the 1.20.1 line). null when the name carries fewer
 * than two numeric segments.
 * @param {string} build
 * @returns {number[]|null}
 */
function neoForgeBuildGameAxis (build) {
  const nums = numericLead(build)
  if (nums.length < 2) return null
  const legacy = NEOFORGE_LEGACY_LINE_GAME_AXIS[nums[0]]
  if (legacy) return legacy.slice()
  return dropTrailingZeros(nums.slice(0, -1))
}

/**
 * HF100: does the build's game-version axis name `mcVersion` (the world game
 * version the client already knows)? Equal component lists, or equal once the
 * version's leading major is dropped (the NeoForge scheme for the 1.x line):
 * 21.1.216 names 1.21.1, 21.0.5 names 1.21, 26.3.0.83 names 26.3 and 26.3.0,
 * 26.3.0.83 does NOT name 26.1.2, 21.1.216 does NOT name 1.20.4.
 * @param {string} build
 * @param {string} mcVersion
 */
function neoForgeBuildMatchesGameVersion (build, mcVersion) {
  const axis = neoForgeBuildGameAxis(build)
  const mc = numericLead(mcVersion)
  if (!axis || mc.length === 0) return false
  const want = dropTrailingZeros(mc)
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
  return same(axis, want) || (want.length === axis.length + 1 && same(axis, want.slice(1)))
}

/**
 * HF100: what a pick lets the caller READ and what it lets the caller CLAIM -
 * the one record every consumer (the derivation census, the derivation child,
 * the play-entry scans, the spawn decoder) stamps from. A claim ('announced'
 * = rule 1, 'local' = rule 2) is the running loader; a 'guess' is the newest
 * foreign-game-version build handed back so a join can still carry its
 * built-ins (the learned belt corrects the claim set), stamped as a guess
 * with the abstain enum beside it, never as the running loader.
 * @param {ReturnType<typeof pickNeoForgeLoaderJars>} picked
 * @returns {{jars: string[], version: string|null, kind: 'announced'|'local'|'guess'|null, abstain: string|null, foreignBuilds: string[]}}
 */
function neoForgeLoaderClaimOf (picked) {
  const p = picked || {}
  const foreignBuilds = Array.isArray(p.foreignBuilds) ? p.foreignBuilds.slice() : []
  if (Array.isArray(p.jars) && p.jars.length > 0) {
    return { jars: p.jars.slice(), version: p.version ?? null, kind: p.matchedPreferred ? 'announced' : 'local', abstain: null, foreignBuilds }
  }
  if (p.guess && Array.isArray(p.guess.jars) && p.guess.jars.length > 0) {
    return { jars: p.guess.jars.slice(), version: p.guess.version ?? null, kind: 'guess', abstain: p.abstain ?? LOADER_ABSTAIN_FOREIGN_GAME_VERSION, foreignBuilds }
  }
  return { jars: [], version: null, kind: null, abstain: p.abstain ?? null, foreignBuilds }
}

/**
 * Every neoforge universal jar reachable from the mods folder(s):
 * Map<version, jarPath>. First hit wins per version (nearest tree).
 */
function collectNeoForgeUniversalJars (modsPaths) {
  const found = new Map()
  for (const modsDir of modsPaths || []) {
    let dir = path.resolve(modsDir)
    for (let depth = 0; depth < 5; depth++) {
      dir = path.dirname(dir)
      for (const libRoot of [path.join(dir, 'libraries'), path.join(dir, 'Install', 'libraries')]) {
        const neoRoot = path.join(libRoot, 'net', 'neoforged', 'neoforge')
        let versions = []
        try { versions = fs.readdirSync(neoRoot) } catch { continue }
        for (const v of versions) {
          if (found.has(v)) continue
          const jar = path.join(neoRoot, v, `neoforge-${v}-universal.jar`)
          if (fs.existsSync(jar)) found.set(v, jar)
        }
      }
    }
  }
  return found
}

/**
 * The loader jar(s) the derivation should read (0 or 1 entries).
 *
 * @param {string[]} modsPaths resolved local mods folder(s)
 * @param {{preferredVersion?: string|null, mcVersion?: string|null}} options
 *   preferredVersion = the build the SERVER announced (kick/hint wire truth);
 *   honored only when that exact build exists locally — never invented.
 *   mcVersion (HF100) = the world game version the client knows; rule 2 then
 *   picks among the builds of THAT game version only (neoForgeBuildMatchesGameVersion);
 *   with none matching the pick claims nothing: foreignBuilds names every
 *   local build, abstain names the enum, and guess carries the newest foreign
 *   build (today's rule-2 pick) for a caller that reads it as a stamped guess.
 *   Without mcVersion the pick is unfiltered (every build is a candidate).
 * @returns {{jars: string[], version: string|null, matchedPreferred: boolean, foreignBuilds?: string[], abstain?: string, guess?: {jars: string[], version: string, gameAxis: number[]|null}}}
 */
function pickNeoForgeLoaderJars (modsPaths, options = {}) {
  const preferred = options.preferredVersion || null
  const mc = options.mcVersion || null
  const found = collectNeoForgeUniversalJars(modsPaths)
  if (found.size === 0) return { jars: [], version: null, matchedPreferred: false }
  if (preferred && found.has(preferred)) {
    return { jars: [found.get(preferred)], version: preferred, matchedPreferred: true }
  }
  const sameGame = [...found.keys()].filter((v) => !mc || neoForgeBuildMatchesGameVersion(v, mc))
  if (sameGame.length === 0) {
    const foreignBuilds = [...found.keys()].sort(compareNeoForgeVersions)
    const newest = foreignBuilds[foreignBuilds.length - 1]
    return {
      jars: [],
      version: null,
      matchedPreferred: false,
      foreignBuilds,
      abstain: LOADER_ABSTAIN_FOREIGN_GAME_VERSION,
      guess: { jars: [found.get(newest)], version: newest, gameAxis: neoForgeBuildGameAxis(newest) }
    }
  }
  const newest = sameGame.sort(compareNeoForgeVersions).pop()
  return { jars: [found.get(newest)], version: newest, matchedPreferred: false }
}

// --- Forge (net/minecraftforge/forge) — D3 loader-spawn codec derivation -----
// Same trees, same walk, same laws. The Forge universal jar lives at
// libraries/net/minecraftforge/forge/<mc>-<forge>/forge-<mc>-<forge>-universal.jar
// (vanilla launcher, CurseForge Install/libraries, dedicated servers).

/** Every forge universal jar reachable from the mods folder(s): Map<'<mc>-<forge>', jarPath>. */
function collectForgeUniversalJars (modsPaths) {
  const found = new Map()
  for (const modsDir of modsPaths || []) {
    let dir = path.resolve(modsDir)
    for (let depth = 0; depth < 5; depth++) {
      dir = path.dirname(dir)
      for (const libRoot of [path.join(dir, 'libraries'), path.join(dir, 'Install', 'libraries')]) {
        const root = path.join(libRoot, 'net', 'minecraftforge', 'forge')
        let versions = []
        try { versions = fs.readdirSync(root) } catch { continue }
        for (const v of versions) {
          if (found.has(v)) continue
          const jar = path.join(root, v, `forge-${v}-universal.jar`)
          if (fs.existsSync(jar)) found.set(v, jar)
        }
      }
    }
  }
  return found
}

/**
 * The Forge loader jar the spawn-codec derivation should read (0 or 1).
 * Selection law: the exact build the server announced (`<mc>-<forge>` from
 * the FML mod list, wire truth) when present locally; else the numerically
 * newest local build FOR THE SAME MINECRAFT VERSION (a loader's built-in
 * channel codec is a fact of the loader line, never borrowed across
 * Minecraft versions — 1.20.1 fml:play#0/u8 vs 1.20.2+ forge:handshake#7/
 * varint); else nothing (the caller abstains).
 * @param {string[]} modsPaths
 * @param {{mcVersion?: string|null, preferredVersion?: string|null}} options
 */
function pickForgeLoaderJars (modsPaths, options = {}) {
  const preferred = options.preferredVersion || null
  const mc = options.mcVersion || null
  const found = collectForgeUniversalJars(modsPaths)
  if (found.size === 0) return { jars: [], version: null, matchedPreferred: false }
  if (preferred && found.has(preferred)) return { jars: [found.get(preferred)], version: preferred, matchedPreferred: true }
  const sameMc = [...found.keys()].filter((v) => !mc || v.startsWith(`${mc}-`))
  if (sameMc.length === 0) return { jars: [], version: null, matchedPreferred: false, foreignBuilds: [...found.keys()] }
  const newest = sameMc.sort((a, b) => compareNeoForgeVersions(a.slice(a.indexOf('-') + 1), b.slice(b.indexOf('-') + 1))).pop()
  return { jars: [found.get(newest)], version: newest, matchedPreferred: false }
}

module.exports = {
  collectNeoForgeUniversalJars,
  pickNeoForgeLoaderJars,
  compareNeoForgeVersions,
  // HF100: the game-version axis + the one claim record
  LOADER_ABSTAIN_FOREIGN_GAME_VERSION,
  NEOFORGE_LEGACY_LINE_GAME_AXIS,
  neoForgeBuildGameAxis,
  neoForgeBuildMatchesGameVersion,
  neoForgeLoaderClaimOf,
  collectForgeUniversalJars,
  pickForgeLoaderJars
}
