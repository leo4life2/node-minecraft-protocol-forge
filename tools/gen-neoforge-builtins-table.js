'use strict'

// GENERATOR (dev-time only; never required from src/) for
// src/client/data/neoForgeBuiltins.json - ONE COLUMN PER NEOFORGE LINE of the
// loader's own built-in network payloads (the neoforge:* ids a universal jar
// registers, configuration and play, each with its flow), read from the
// published universal jars and never typed from memory.
//
// HF113: the pal must DECLARE the loader's clientbound built-ins over
// minecraft:register before the server's own sends reach the pal
// (NetworkRegistry.checkPacket throws on an undeclared payload and the join
// dies at PlayerList.placeNewPlayer - `neoforge:recipe_content`, new at the
// 21.11 line, absent from the 21.1-pinned list). When the world's own loader
// jar is readable it is the authority (HF43); when it is not, the column of
// the world game version's line stands in; the pinned constant is the last
// resort. This generator writes the columns.
//
// THE READER is the runtime's own: neoForgePayloadDerivation.deriveNeoForgeComponents
// over the one jar - exactly what the derivation child runs on a found loader
// jar. The generator never grows a second reader.
//
// THE LINE of a build is the game axis the loader pick already carries
// (neoForgeLoaderLocator.neoForgeBuildGameAxis: 21.1.248 -> 21.1, 26.1.2.124 ->
// 26.1.2, 26.3.0.95 -> 26.3, the legacy 47.x -> 20.1). THE GAME-VERSION AXIS is
// what the client's version fact can carry: the release names minecraft-data
// knows (versionsByMinecraftVersion.pc, no pre/rc/snapshot) from the oldest
// game version any published line reaches; a line reaches a version iff
// neoForgeBuildMatchesGameVersion(latest build, version). An axis version no
// line reaches is recorded 'no-neoforge'; a line no axis version reaches is
// recorded off-axis and gets no column. A line whose jar the reader finds NO
// registration in (the 20.x lines) is recorded 'empty-read' and gets no column:
// the runtime keeps its pinned constant there (an empty column would declare
// nothing).
//
// THE BUILD of a column is the latest build of its line in maven-metadata.xml.
// Every build read is recorded; when a local jar of an older build is present
// it is read too and a set that differs between builds is recorded as a fact
// in the sources record (the column takes the latest build; at runtime the
// world's own jar wins whenever it is readable).
//
// Every artifact comes from the one publisher host (maven.neoforged.net); the
// publisher's checksum file beside the artifact is checked when present and
// the sha256 is recorded always. Local jars (--jars <dir> / HF113_JAR_DIR) are
// taken by path when their file name matches a build and are sha256-matched
// against the publisher checksum before any fetch.
//
// Usage:
//   node tools/gen-neoforge-builtins-table.js [--metadata <local maven-metadata.xml>] [--jars <dir>]
//        [--cache <dir>] [--lines a,b,c] [--out <json>] [--sources <json>] [--offline]
//   node tools/gen-neoforge-builtins-table.js --column <build> --jar <path>
//        (prints the one column as the data file serialises it; no network)

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const https = require('https')
const { deriveNeoForgeComponents } = require('../src/client/neoForgePayloadDerivation')
const { neoForgeBuildGameAxis, neoForgeBuildMatchesGameVersion, compareNeoForgeVersions } = require('../src/client/neoForgeLoaderLocator')

const MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge'
const METADATA_URL = `${MAVEN}/maven-metadata.xml`
const ALLOWED_HOSTS = new Set(['maven.neoforged.net'])
const OUT = path.join(__dirname, '..', 'src', 'client', 'data', 'neoForgeBuiltins.json')
const SOURCES = path.join(__dirname, '..', 'src', 'client', 'data', 'neoForgeBuiltins.sources.json')
const SCHEMA = 1
const NAMESPACE = 'neoforge:'
const FLOWS = Object.freeze(['clientbound', 'serverbound', null])

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const universalUrl = (build) => `${MAVEN}/${build}/neoforge-${build}-universal.jar`
const universalName = (build) => `neoforge-${build}-universal.jar`

/** The line a build belongs to: its game axis joined by dots (null when the build number does not parse). */
function lineOf (build) {
  const axis = neoForgeBuildGameAxis(build)
  return axis ? axis.join('.') : null
}

/** The <version> list of a maven-metadata.xml, in the publisher's order. */
function versionsOfMetadata (xml) {
  return [...String(xml).matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1].trim()).filter(Boolean)
}

/** Builds grouped by line: Map<line, builds[]> (publisher order kept); unparsed builds listed apart. */
function linesOf (versions) {
  const lines = new Map()
  const unparsed = []
  for (const v of versions) {
    const line = lineOf(v)
    if (!line) { unparsed.push(v); continue }
    if (!lines.has(line)) lines.set(line, [])
    lines.get(line).push(v)
  }
  return { lines, unparsed }
}

/** The latest build of a line (numeric-aware; a -beta build is a build like any other). */
function latestBuild (builds) {
  return builds.slice().sort(compareNeoForgeVersions)[builds.length - 1]
}

/** The release game versions minecraft-data knows (no pre/rc/snapshot/week names), oldest first by data version. */
function releaseGameVersions () {
  const md = require('minecraft-data')
  const rows = md.versions.pc.filter((v) => /^\d+(\.\d+)+$/.test(v.minecraftVersion))
  rows.sort((a, b) => (a.dataVersion ?? 0) - (b.dataVersion ?? 0) || compareNeoForgeVersions(a.minecraftVersion, b.minecraftVersion))
  const seen = new Set()
  return rows.map((v) => v.minecraftVersion).filter((v) => !seen.has(v) && seen.add(v))
}

/** The game versions a line's latest build reaches on the axis. */
function reachedBy (build, axis) {
  return axis.filter((v) => neoForgeBuildMatchesGameVersion(build, v))
}

/** ONE column from ONE jar through THE runtime reader: the neoforge:* rows with their flow, sorted by id then flow. */
function columnOf (jarPath, build) {
  const { components } = deriveNeoForgeComponents([jarPath])
  const rows = (list) => (list || [])
    .filter((c) => typeof c.id === 'string' && c.id.startsWith(NAMESPACE))
    .map((c) => ({ id: c.id, flow: FLOWS.includes(c.flow) ? c.flow : null }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : String(a.flow).localeCompare(String(b.flow))))
    .filter((r, i, a) => i === 0 || a[i - 1].id !== r.id || a[i - 1].flow !== r.flow)
  return { build, configuration: rows(components.configuration), play: rows(components.play) }
}

/** The set a column pins, as one string (the differ-across-builds fact and the tests compare these). */
function setKeyOf (column) {
  return [...column.configuration.map((r) => `configuration ${r.id} ${r.flow}`), ...column.play.map((r) => `play ${r.id} ${r.flow}`)].join('\n')
}

/** Deterministic bytes: sorted keys, two-space indent, trailing newline. */
function canon (value) {
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys)
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
    return v
  }
  return JSON.stringify(sortKeys(value), null, 2) + '\n'
}

// ------------------------------------------------------------ the one publisher

async function fetchBytes (url, { redirects = 3 } = {}) {
  const u = new URL(url)
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) throw new Error(`refused host ${u.hostname}`)
  return new Promise((resolve, reject) => {
    https.get(u, { headers: { 'user-agent': 'minepal-hf113-generator' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume()
        return fetchBytes(new URL(res.headers.location, u).toString(), { redirects: redirects - 1 }).then(resolve, reject)
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)) }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
  })
}

/** The publisher's sha256 beside the artifact ('absent' when the host has none). */
async function publisherSha256 (url, offline) {
  if (offline) return null
  try {
    const text = (await fetchBytes(`${url}.sha256`)).toString('utf8').trim().split(/\s+/)[0].toLowerCase()
    return /^[0-9a-f]{64}$/.test(text) ? text : null
  } catch { return null }
}

/**
 * The jar of a build: a local copy (jarsDir/<name>) first, else the cache, else
 * fetched from the publisher. The sha256 is checked against the publisher's
 * checksum file when that exists; a mismatch is an error, never a column.
 */
async function obtainJar (build, { jarsDir, cacheDir, offline, log }) {
  const name = universalName(build)
  const url = universalUrl(build)
  const expected = await publisherSha256(url, offline)
  const candidates = [jarsDir && path.join(jarsDir, name), cacheDir && path.join(cacheDir, name)].filter(Boolean)
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue
    const bytes = fs.readFileSync(p)
    const sha = sha256(bytes)
    if (expected && sha !== expected) throw new Error(`${name}: local copy sha256 ${sha} != publisher ${expected}`)
    return { path: p, sha256: sha, size: bytes.length, url, source: p.startsWith(jarsDir || '\u0000') ? 'local' : 'cache', publisherChecksum: expected ? 'sha256-match' : 'absent' }
  }
  if (offline) throw new Error(`${name}: no local copy and --offline`)
  log(`fetching ${url}`)
  const bytes = await fetchBytes(url)
  const sha = sha256(bytes)
  if (expected && sha !== expected) throw new Error(`${name}: fetched sha256 ${sha} != publisher ${expected}`)
  fs.mkdirSync(cacheDir, { recursive: true })
  const p = path.join(cacheDir, name)
  fs.writeFileSync(p, bytes)
  return { path: p, sha256: sha, size: bytes.length, url, source: 'fetched', publisherChecksum: expected ? 'sha256-match' : 'absent' }
}

/** Local jars under jarsDir whose names are universal jars of the line (older builds read for the differ fact). */
function localBuildsOfLine (jarsDir, line) {
  if (!jarsDir || !fs.existsSync(jarsDir)) return []
  return fs.readdirSync(jarsDir)
    .map((f) => /^neoforge-(.+)-universal\.jar$/.exec(f))
    .filter(Boolean)
    .map((m) => m[1])
    .filter((b) => lineOf(b) === line)
}

// ------------------------------------------------------------ main

function parseArgs (argv) {
  const out = { lines: null, offline: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--metadata') out.metadata = next()
    else if (a === '--jars') out.jars = next()
    else if (a === '--cache') out.cache = next()
    else if (a === '--lines') out.lines = next().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--out') out.out = next()
    else if (a === '--sources') out.sources = next()
    else if (a === '--offline') out.offline = true
    else if (a === '--column') out.column = next()
    else if (a === '--jar') out.jar = next()
    else throw new Error(`unknown argument ${a}`)
  }
  return out
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const log = (m) => process.stderr.write(`${m}\n`)
  if (args.column) {
    if (!args.jar) throw new Error('--column needs --jar <path>')
    process.stdout.write(canon(columnOf(args.jar, args.column)))
    return
  }
  const jarsDir = args.jars || process.env.HF113_JAR_DIR || null
  const cacheDir = args.cache || path.join(os.tmpdir(), 'hf113-neoforge-jars')
  const today = new Date().toISOString().slice(0, 10)

  let metadataBytes
  let metadataSource
  if (args.metadata) { metadataBytes = fs.readFileSync(args.metadata); metadataSource = 'local' } else { metadataBytes = await fetchBytes(METADATA_URL); metadataSource = 'fetched' }
  const versions = versionsOfMetadata(metadataBytes.toString('utf8'))
  const { lines, unparsed } = linesOf(versions)
  const axis = releaseGameVersions()

  const columns = {}
  const sourcesLines = {}
  const offAxis = []
  const reach = new Map() // game version -> line
  for (const [line, builds] of lines) {
    if (args.lines && !args.lines.includes(line)) continue
    const build = latestBuild(builds)
    const gameVersions = reachedBy(build, axis)
    if (gameVersions.length === 0) { offAxis.push({ line, build }); continue }
    const jar = await obtainJar(build, { jarsDir, cacheDir, offline: args.offline, log })
    const column = columnOf(jar.path, build)
    // THE EMPTY-READ RULE: a jar in which the reader finds no neoforge:* registration
    // at all (the 20.x lines register through an API the reader does not model) gets
    // NO column - the fact is recorded and the runtime keeps its pinned constant for
    // that line; an empty column would declare nothing, a regression never a table.
    const emptyRead = column.configuration.length === 0 && column.play.length === 0
    if (!emptyRead) columns[line] = column
    const buildsRead = [{ build, sha256: jar.sha256, size: jar.size, source: jar.source }]
    let differs = false
    for (const other of localBuildsOfLine(jarsDir, line)) {
      if (other === build) continue
      const otherJar = await obtainJar(other, { jarsDir, cacheDir: null, offline: true, log })
      const otherColumn = columnOf(otherJar.path, other)
      buildsRead.push({ build: other, sha256: otherJar.sha256, size: otherJar.size, source: otherJar.source })
      if (setKeyOf(otherColumn) !== setKeyOf(column)) differs = true
    }
    sourcesLines[line] = { verdict: emptyRead ? 'empty-read' : 'column', build, url: jar.url, sha256: jar.sha256, size: jar.size, publisherChecksum: jar.publisherChecksum, buildsRead, buildsPublished: builds.length, setDiffersAcrossBuildsRead: differs, gameVersions }
    for (const v of gameVersions) reach.set(v, { line, verdict: emptyRead ? 'no-column' : 'column' })
    log(`${line}: ${build} -> ${column.configuration.length} configuration + ${column.play.length} play rows (${gameVersions.join(', ')})${emptyRead ? ' [EMPTY READ: no column]' : ''}${differs ? ' [set differs across the builds read]' : ''}`)
  }
  // the axis from the oldest game version any line reaches
  const reachedIdx = axis.map((v, i) => (reach.has(v) ? i : -1)).filter((i) => i >= 0)
  const first = reachedIdx.length ? Math.min(...reachedIdx) : axis.length
  const versionsRecord = {}
  // verdict per axis version (closed set): column | no-column (a line reaches it, its jar read empty) | no-neoforge (no line reaches it)
  for (const v of axis.slice(first)) versionsRecord[v] = reach.has(v) ? { verdict: reach.get(v).verdict, line: reach.get(v).line } : { verdict: 'no-neoforge', line: null }

  const data = { schema: SCHEMA, keyedBy: 'neoforge line (the game axis of the build: neoForgeLoaderLocator.neoForgeBuildGameAxis)', columns }
  const sources = {
    schema: SCHEMA,
    generated: today,
    generator: 'tools/gen-neoforge-builtins-table.js',
    reader: 'neoForgePayloadDerivation.deriveNeoForgeComponents (the runtime loader-jar reader)',
    axis: 'minecraft-data versionsByMinecraftVersion.pc release names (what the client version fact carries) from the oldest game version a published line reaches',
    metadata: { url: METADATA_URL, sha256: sha256(metadataBytes), versions: versions.length, source: metadataSource, unparsedVersions: unparsed },
    lines: sourcesLines,
    offAxisLines: offAxis,
    versions: versionsRecord
  }
  const outPath = args.out || OUT
  const sourcesPath = args.sources || SOURCES
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, canon(data))
  fs.writeFileSync(sourcesPath, canon(sources))
  log(`wrote ${outPath} (${Object.keys(columns).length} columns) and ${sourcesPath}`)
}

const VERSION_VERDICTS = Object.freeze(['column', 'no-column', 'no-neoforge'])
const LINE_VERDICTS = Object.freeze(['column', 'empty-read'])

module.exports = { VERSION_VERDICTS, LINE_VERDICTS, lineOf, linesOf, latestBuild, releaseGameVersions, reachedBy, columnOf, setKeyOf, canon, versionsOfMetadata, universalUrl, FLOWS, SCHEMA, OUT, SOURCES, METADATA_URL }

if (require.main === module) {
  main().catch((err) => { process.stderr.write(`${err.stack || err}\n`); process.exit(1) })
}
