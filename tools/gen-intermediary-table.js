'use strict'

// GENERATOR (dev-time only; never required from src/) for
// src/client/data/packetBodyRuntimeNames.json - the RUNTIME-NAME COLUMN of the
// packet-body wire table, one column per game version, read from the two
// published mapping files and never typed from memory:
//   * FabricMC intermediary (maven.fabricmc.net net/fabricmc/intermediary/<mc>/
//     intermediary-<mc>-v2.jar -> mappings/mappings.tiny, tiny v2, official
//     (obfuscated) -> intermediary = the names a production Fabric jar carries
//     in its @Mixin targets and member strings);
//   * Mojang's official server mappings (piston-meta version json ->
//     downloads.server_mappings, a ProGuard map, Mojang -> obfuscated).
// Joined by the obfuscated class name and the obfuscated method descriptor,
// the column says which runtime class name each PACKET_CLASS_TABLE row (and
// FriendlyByteBuf) carries on that version and which runtime method name the
// members the derivation walks carry (write / read (FriendlyByteBuf) of a
// packet row, the buffer members the primitive tables name; <init> is
// name-stable in every mapping and needs no entry).
//
// THE VERSION AXIS is minecraft-data's supportedVersions.pc (the protocol axis
// the client speaks). A version FabricMC publishes no intermediary for is
// recorded 'no-fabric' (Fabric does not run there); one whose piston json
// carries no server_mappings is 'no-mojang-mappings'. Both get no column.
//
// Every download is checksum-verified against the publisher (FabricMC's .sha256
// beside the jar, Mojang's sha1 in the version json) and sha256-recorded in the
// sources record beside the data file. A local pair (--local) is used for its
// bytes after the same checks.
//
// Usage:
//   node tools/gen-intermediary-table.js [--cache <dir>] [--local <mc>=<tiny-or-jar>,<server.txt>]...
//        [--versions a,b,c] [--out <json>] [--sources <json>]
//   node tools/gen-intermediary-table.js --column <mc> --local <mc>=<tiny-or-jar>,<server.txt>
//        (prints the one column as the data file serialises it; no network)

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { zipCentralEntries, zipEntryData } = require('../src/client/jarAnalysis')
const { PACKET_CLASS_TABLE } = require('../src/client/packetBodyWireDerivation')
const { WRITE_PRIMS, READ_PRIMS } = require('../src/client/itemStackWireDerivation')

const FABRIC_MAVEN = 'https://maven.fabricmc.net/net/fabricmc/intermediary'
const MOJANG_MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'
const ALLOWED_HOSTS = new Set(['maven.fabricmc.net', 'launchermeta.mojang.com', 'piston-meta.mojang.com', 'piston-data.mojang.com'])
const BUF = 'net/minecraft/network/FriendlyByteBuf'
// the interface every tabled packet implements: tiny v2 lists an overridden member ONLY under the type that declares it
// (write(FriendlyByteBuf) is Packet's), so a packet row's write resolves through the interface row when its own class has no entry
const PACKET_IFACE = 'net/minecraft/network/protocol/Packet'
// the vanilla payload packet deriveRedirect names (a mod's payload-ctor injection wraps world packets); a runtime-named owner resolves through the column too
const PAYLOAD_PACKET = 'net/minecraft/network/protocol/game/ClientboundCustomPayloadPacket'
const OUT = path.join(__dirname, '..', 'src', 'client', 'data', 'packetBodyRuntimeNames.json')
const SOURCES = path.join(__dirname, '..', 'src', 'client', 'data', 'packetBodyRuntimeNames.sources.json')
const SCHEMA = 1

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex')

// ------------------------------------------------------------ the two formats

// ProGuard map (Mojang -> obfuscated): `a.b.C -> x:` then `    [l:l:]ret name(args) -> obf`
function parseProguard (text) {
  const classes = new Map() // mojang dotted -> obf dotted
  const members = new Map() // mojang dotted -> [{ ret, name, args, obf }]
  let cur = null
  for (const line of text.split('\n')) {
    const c = line.match(/^(\S+) -> (\S+):\s*$/)
    if (c) { cur = c[1]; classes.set(cur, c[2]); members.set(cur, []); continue }
    if (!cur) continue
    const m = line.match(/^\s+(?:\d+:\d+:)?(\S+) (\S+)\(([^)]*)\) -> (\S+)\s*$/)
    if (m) members.get(cur).push({ ret: m[1], name: m[2], args: m[3] ? m[3].split(',') : [], obf: m[4] })
  }
  return { classes, members }
}

// tiny v2 (official -> intermediary): `c\t<obf>\t<inter>` then `\tm\t<obf desc>\t<obf>\t<inter>`
function parseTiny (text) {
  const lines = text.split('\n')
  const head = (lines[0] || '').split('\t')
  if (head[0] !== 'tiny' || head[1] !== '2') throw new Error('not a tiny v2 mapping')
  const ns = head.slice(3)
  const iObf = ns.indexOf('official'); const iInt = ns.indexOf('intermediary')
  if (iObf < 0 || iInt < 0) throw new Error(`tiny namespaces ${ns.join(',')} carry no official/intermediary pair`)
  const classes = new Map() // obf slash -> inter slash
  const methods = new Map() // obf slash -> Map(`${obfName}${obfDesc}` -> inter)
  let cur = null
  for (const line of lines) {
    const p = line.split('\t')
    if (p[0] === 'c') { cur = p[1 + iObf]; classes.set(cur, p[1 + iInt]); methods.set(cur, new Map()); continue }
    if (p[0] === '' && p[1] === 'm' && cur) methods.get(cur).set(`${p[3 + iObf]}${p[2]}`, p[3 + iInt])
  }
  return { classes, methods }
}

const PRIM_DESC = { void: 'V', int: 'I', long: 'J', short: 'S', byte: 'B', boolean: 'Z', float: 'F', double: 'D', char: 'C' }
// a ProGuard type (Mojang dotted, `[]` per dimension) -> a JVM descriptor in the name system `classOf` renders (obf or Mojang)
function typeDesc (t, classOf) {
  let dims = 0
  while (t.endsWith('[]')) { t = t.slice(0, -2); dims++ }
  const base = PRIM_DESC[t] || `L${classOf(t).replace(/\./g, '/')};`
  return '['.repeat(dims) + base
}
const methodDesc = (m, classOf) => `(${m.args.map((a) => typeDesc(a, classOf)).join('')})${typeDesc(m.ret, classOf)}`

// ------------------------------------------------------------------ the join

// The classes a column names: every PACKET_CLASS_TABLE row of every era + the buffer.
function wantedClasses () {
  const out = new Set([BUF, PACKET_IFACE, PAYLOAD_PACKET])
  for (const row of PACKET_CLASS_TABLE) for (const cls of Object.keys(row.classes)) out.add(cls)
  return [...out].sort()
}
// The buffer members the primitive tables name (Mojang spellings only: a `method_` key is a runtime spelling already)
function wantedBufferMembers () {
  const names = new Set()
  for (const k of [...Object.keys(WRITE_PRIMS), ...Object.keys(READ_PRIMS)]) { const n = k.slice(0, k.indexOf(':')); if (!/^method_\d+$/.test(n)) names.add(n) }
  return names
}

// ONE column: { classes: { mojang -> runtime }, methods: { mojang owner -> { `name(desc)` -> runtime name } } }
function buildColumn (tinyText, proguardText) {
  const pg = parseProguard(proguardText)
  const tiny = parseTiny(tinyText)
  const obfOf = (dotted) => pg.classes.get(dotted) || dotted
  const classes = {}; const methods = {}
  const bufNames = wantedBufferMembers()
  const ifaceObf = pg.classes.get(PACKET_IFACE.replace(/\//g, '.'))
  const ifaceRows = ifaceObf ? (tiny.methods.get(ifaceObf.replace(/\./g, '/')) || new Map()) : new Map()
  for (const cls of wantedClasses()) {
    const dotted = cls.replace(/\//g, '.')
    const obf = pg.classes.get(dotted)
    if (!obf) continue
    const inter = tiny.classes.get(obf.replace(/\./g, '/'))
    if (!inter) continue
    classes[cls] = inter
    const tm = tiny.methods.get(obf.replace(/\./g, '/')) || new Map()
    const rows = {}
    for (const m of pg.members.get(dotted) || []) {
      if (m.name === '<init>' || !/^[A-Za-z_$][\w$]*$/.test(m.name)) continue // constructors are name-stable; fields and specials are not walked
      const isPacketMember = cls !== BUF && (m.name === 'write' || m.name === 'read') && m.args.length === 1 && m.args[0] === BUF.replace(/\//g, '.')
      const isBufMember = cls === BUF && bufNames.has(m.name)
      if (!isPacketMember && !isBufMember) continue
      if (m.obf === m.name) continue // a name the mapping keeps (a netty override) needs no runtime spelling
      const key = `${m.obf}${methodDesc(m, obfOf)}`
      const runtime = tm.get(key) || (isPacketMember ? ifaceRows.get(key) : undefined) // own row first, then the interface's (the override keeps the declaring type's name)
      if (!runtime || runtime === m.name) continue
      rows[`${m.name}${methodDesc(m, (c) => c)}`] = runtime
    }
    if (Object.keys(rows).length) methods[cls] = sortKeys(rows)
  }
  return { classes: sortKeys(classes), methods: sortKeys(methods) }
}

function sortKeys (o) { const out = {}; for (const k of Object.keys(o).sort()) out[k] = o[k]; return out }
// the one serialisation of the data file and of a column (sorted keys, two-space indent, trailing newline)
function canon (o) { return JSON.stringify(o, null, 2) + '\n' }

function tinyFromJarOrText (p) {
  const b = fs.readFileSync(p)
  if (b[0] === 0x50 && b[1] === 0x4b) { const e = zipCentralEntries(b).find((x) => x.name === 'mappings/mappings.tiny'); if (!e) throw new Error(`${path.basename(p)} carries no mappings/mappings.tiny`); return zipEntryData(b, e).toString('utf8') }
  return b.toString('utf8')
}

// ----------------------------------------------------------------- fetching

async function fetchBytes (url) {
  const u = new URL(url)
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) throw new Error(`refused host ${u.hostname}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

function parseArgs (argv) {
  const a = { local: {}, versions: null, cache: path.join(process.cwd(), '.hf112-mappings'), out: OUT, sources: SOURCES, column: null }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]; const v = argv[i + 1]
    if (k === '--local') { const m = /^([^=]+)=([^,]+),(.+)$/.exec(v); if (!m) throw new Error('--local <mc>=<tiny-or-jar>,<server.txt>'); a.local[m[1]] = { tiny: m[2], server: m[3] }; i++ } else if (k === '--versions') { a.versions = v.split(','); i++ } else if (k === '--cache') { a.cache = v; i++ } else if (k === '--out') { a.out = v; i++ } else if (k === '--sources') { a.sources = v; i++ } else if (k === '--column') { a.column = v; i++ } else throw new Error(`unknown argument ${k}`)
  }
  return a
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.column) {
    const l = args.local[args.column]
    if (!l) throw new Error(`--column ${args.column} needs --local ${args.column}=<tiny-or-jar>,<server.txt>`)
    process.stdout.write(canon(buildColumn(tinyFromJarOrText(l.tiny), fs.readFileSync(l.server, 'utf8'))))
    return
  }
  const axis = require('minecraft-data').supportedVersions.pc.slice()
  const versions = args.versions || axis
  fs.mkdirSync(args.cache, { recursive: true })
  const today = new Date().toISOString().slice(0, 10)
  const prior = fs.existsSync(args.sources) ? JSON.parse(fs.readFileSync(args.sources, 'utf8')) : { versions: {} }
  const priorData = fs.existsSync(args.out) ? JSON.parse(fs.readFileSync(args.out, 'utf8')) : { columns: {} }
  // the publisher indexes: which versions FabricMC maps, where Mojang keeps each version's json
  const metaUrl = `${FABRIC_MAVEN}/maven-metadata.xml`
  const meta = await fetchBytes(metaUrl)
  const fabricVersions = new Set([...meta.toString('utf8').matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]))
  const manifest = JSON.parse((await fetchBytes(MOJANG_MANIFEST)).toString('utf8'))
  const manifestByVersion = new Map(manifest.versions.map((v) => [v.id, v]))
  const sources = { schema: SCHEMA, axis: 'minecraft-data supportedVersions.pc', fabricIndex: { url: metaUrl, sha256: sha256(meta), fetched: today }, mojangManifest: { url: MOJANG_MANIFEST, fetched: today }, versions: { ...prior.versions } }
  const columns = { ...priorData.columns }
  for (const mc of versions) {
    try {
      if (!fabricVersions.has(mc)) { sources.versions[mc] = { verdict: 'no-fabric', checked: today }; delete columns[mc]; continue }
      const entry = manifestByVersion.get(mc)
      if (!entry) { sources.versions[mc] = { verdict: 'no-mojang-version', checked: today }; delete columns[mc]; continue }
      const vjson = JSON.parse((await fetchBytes(entry.url)).toString('utf8'))
      const sm = vjson.downloads && vjson.downloads.server_mappings
      if (!sm) { sources.versions[mc] = { verdict: 'no-mojang-mappings', versionJson: entry.url, checked: today }; delete columns[mc]; continue }
      const jarUrl = `${FABRIC_MAVEN}/${mc}/intermediary-${mc}-v2.jar`
      const dir = path.join(args.cache, mc); fs.mkdirSync(dir, { recursive: true })
      const jarPath = path.join(dir, `intermediary-${mc}-v2.jar`); const serverPath = path.join(dir, 'server.txt')
      const expectJarSha = (await fetchBytes(`${jarUrl}.sha256`)).toString('utf8').trim().slice(0, 64)
      const local = args.local[mc]
      // intermediary: the local pair's bytes, else the cache, else the fetch - always checked against the publisher's sha256
      let jar = local ? fs.readFileSync(local.tiny) : (fs.existsSync(jarPath) ? fs.readFileSync(jarPath) : null)
      if (!jar || (jar[0] === 0x50 && sha256(jar) !== expectJarSha)) { if (local) throw new Error(`local intermediary for ${mc} is not the published jar (sha256 ${sha256(jar)} vs ${expectJarSha})`); jar = await fetchBytes(jarUrl); fs.writeFileSync(jarPath, jar) }
      if (jar[0] === 0x50 && sha256(jar) !== expectJarSha) throw new Error(`intermediary ${mc} sha256 ${sha256(jar)} != published ${expectJarSha}`)
      let server = local ? fs.readFileSync(local.server) : (fs.existsSync(serverPath) ? fs.readFileSync(serverPath) : null)
      if (!server || sha1(server) !== sm.sha1) { if (local) throw new Error(`local server mappings for ${mc} are not Mojang's (sha1 ${sha1(server)} vs ${sm.sha1})`); server = await fetchBytes(sm.url); fs.writeFileSync(serverPath, server) }
      if (sha1(server) !== sm.sha1) throw new Error(`server mappings ${mc} sha1 ${sha1(server)} != Mojang's ${sm.sha1}`)
      const tinyText = jar[0] === 0x50 ? tinyFromJarOrText(local ? local.tiny : jarPath) : jar.toString('utf8')
      columns[mc] = buildColumn(tinyText, server.toString('utf8'))
      sources.versions[mc] = {
        verdict: 'column',
        intermediary: { url: jarUrl, sha256: jar[0] === 0x50 ? sha256(jar) : null, tinySha256: sha256(tinyText) },
        mojang: { versionJson: entry.url, url: sm.url, sha1: sm.sha1, sha256: sha256(server) },
        classes: Object.keys(columns[mc].classes).length,
        generated: today
      }
      console.log(`${mc}: ${Object.keys(columns[mc].classes).length} classes, ${Object.values(columns[mc].methods).reduce((n, m) => n + Object.keys(m).length, 0)} members`)
    } catch (err) {
      sources.versions[mc] = { verdict: 'error', detail: String(err.message).slice(0, 200), checked: today }
      console.log(`${mc}: ERROR ${err.message}`)
    }
  }
  sources.versions = sortKeys(sources.versions)
  const data = { schema: SCHEMA, note: 'runtime (intermediary) names of the packet-body wire table per game version, generated by tools/gen-intermediary-table.js from the published FabricMC intermediary and Mojang server mappings; constructors keep the name <init> in every mapping', columns: sortKeys(columns) }
  fs.writeFileSync(args.out, canon(data))
  fs.writeFileSync(args.sources, canon(sources))
  const verdicts = {}
  for (const v of Object.values(sources.versions)) verdicts[v.verdict] = (verdicts[v.verdict] || 0) + 1
  console.log(`wrote ${args.out} (${Object.keys(columns).length} columns) and ${args.sources}; verdicts ${JSON.stringify(verdicts)}`)
}

module.exports = { buildColumn, parseProguard, parseTiny, canon, wantedClasses, wantedBufferMembers, SCHEMA }

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1) })
