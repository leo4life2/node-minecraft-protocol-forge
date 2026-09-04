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
//      wrong for real NeoForge build numbers).
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
 * @param {{preferredVersion?: string|null}} options preferredVersion = the
 *   build the SERVER announced (kick/hint wire truth); honored only when
 *   that exact build exists locally — never invented.
 * @returns {{jars: string[], version: string|null, matchedPreferred: boolean}}
 */
function pickNeoForgeLoaderJars (modsPaths, options = {}) {
  const preferred = options.preferredVersion || null
  const found = collectNeoForgeUniversalJars(modsPaths)
  if (found.size === 0) return { jars: [], version: null, matchedPreferred: false }
  if (preferred && found.has(preferred)) {
    return { jars: [found.get(preferred)], version: preferred, matchedPreferred: true }
  }
  const newest = [...found.keys()].sort(compareNeoForgeVersions).pop()
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
  collectForgeUniversalJars,
  pickForgeLoaderJars
}
