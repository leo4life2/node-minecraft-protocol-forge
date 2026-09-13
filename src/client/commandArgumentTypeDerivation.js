'use strict'

const fs = require('fs')
const path = require('path')
const debug = require('debug')('minecraft-protocol-forge')
const { zipCentralEntries, zipEntryData, parseClassFile, decodeInstructions, resolveLambdaImpl } = require('./jarAnalysis')

// HF45 — derives THIS server's command argument-type parser table for the
// ids the vanilla schema does not know, from two truths and nothing else:
//
//   (a) the WIRE: the `minecraft:command_argument_type` registry the server
//       synced during configuration (NeoForge frozen_registry, Fabric registry
//       sync) — id -> name for vanilla, loader and mod argument types. The
//       numbering is the server's (registration order after the vanilla
//       table); it is never assumed.
//   (b) the JARS: for every non-vanilla name, the ArgumentTypeInfo serializer
//       registered under it — found at its registration site (the path
//       string next to the register call, the supplier lambda followed into
//       the `new <Info>` / SingletonArgumentInfo it returns) — and the
//       PROPERTY LAYOUT its serializeToNetwork(template, FriendlyByteBuf)
//       writes, read straight from the bytecode: each FriendlyByteBuf write
//       becomes one protodef field (writeUtf -> string, writeVarInt ->
//       varint, ...). A serializer that branches, encodes through a codec,
//       or calls a write this table does not model is NON-DERIVABLE and the
//       id is abstained by name; the boundary then drops the tree honestly
//       naming that id instead of guessing its bytes.
//
// Mechanism, not instance: no loader or mod name appears in the walk. The
// only class names pinned are vanilla API contracts every loader shares
// (FriendlyByteBuf's write methods, ArgumentTypeInfos.registerByClass,
// SingletonArgumentInfo whose serializer writes nothing).
//
// PRIVACY LAWS: local jar reads only (never executed), no network, no writes.

const ARGUMENT_TYPE_INFO = 'net/minecraft/commands/synchronization/ArgumentTypeInfo'
const SINGLETON_INFO = 'net/minecraft/commands/synchronization/SingletonArgumentInfo'
const REGISTER_BY_CLASS = { owner: 'net/minecraft/commands/synchronization/ArgumentTypeInfos', name: 'registerByClass' }
const FRIENDLY_BYTE_BUF = /(^|\/)(Registry)?FriendlyByteBuf$|(^|\/)ByteBuf$/

// FriendlyByteBuf write -> protodef type (minecraft-data's own primitive names).
const WRITES = {
  writeUtf: 'string',
  writeResourceLocation: 'string',
  writeIdentifier: 'string',
  writeResourceKey: 'string',
  writeBoolean: 'bool',
  writeByte: 'i8',
  writeShort: 'i16',
  writeInt: 'i32',
  writeLong: 'i64',
  writeFloat: 'f32',
  writeDouble: 'f64',
  writeVarInt: 'varint',
  writeVarLong: 'varlong',
  writeEnum: 'varint',
  writeUUID: 'UUID'
}

const ACC_BRIDGE = 0x0040
const ACC_SYNTHETIC = 0x1000

function isVanillaName (name) { return /^(minecraft|brigadier):/.test(name) }

function readModIds (byName, buf) {
  const ids = new Set()
  for (const n of ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']) {
    const e = byName.get(n)
    if (!e) continue
    try {
      const text = zipEntryData(buf, e).toString('utf8')
      for (const m of text.matchAll(/^\s*modId\s*=\s*"([^"]+)"/gm)) ids.add(m[1])
    } catch {}
  }
  const fmj = byName.get('fabric.mod.json')
  if (fmj) {
    try { const j = JSON.parse(zipEntryData(buf, fmj).toString('utf8')); if (typeof j.id === 'string') ids.add(j.id) } catch {}
  }
  return ids
}

// Bytecode layout of one serializer method. Returns { fields } or { abstain }.
function layoutOfMethod (parsed, codeEntry, depth = 0) {
  const rows = decodeInstructions(codeEntry.code, parsed.cp)
  const fields = []
  const writes = []
  for (const row of rows) {
    if (row.target !== undefined || row.op === 0xaa || row.op === 0xab) return { abstain: 'conditional-write' }
    if (row.op === 0xba) return { abstain: 'lambda-in-serializer' }
    if (row.op < 0xb6 || row.op > 0xb9 || !row.ref) continue
    const { owner, name, desc } = row.ref
    if (!owner) continue
    if (FRIENDLY_BYTE_BUF.test(owner)) {
      const type = WRITES[name]
      if (!type) return { abstain: `unmodelled-write:${name}` }
      fields.push({ name: `${name.replace(/^write/, '').toLowerCase()}${fields.length}`, type })
      writes.push(name)
      continue
    }
    if (/Codec/.test(owner) || /\/StreamCodec/.test(owner)) return { abstain: `codec-encoded:${owner.split('/').pop()}.${name}` }
    if (owner === parsed.className && typeof desc === 'string' && /FriendlyByteBuf;/.test(desc)) {
      if (depth >= 3) return { abstain: 'delegation-too-deep' }
      const target = parsed.codes.find((c) => c.method === name && c.desc === desc)
      if (!target) return { abstain: `delegate-missing:${name}` }
      const sub = layoutOfMethod(parsed, target, depth + 1)
      if (sub.abstain) return sub
      fields.push(...sub.fields); writes.push(...sub.writes)
    }
  }
  return { fields, writes }
}

// The serializer's layout: the non-bridge serializeToNetwork(T, FriendlyByteBuf).
function layoutOfInfoClass (parsed) {
  const cands = parsed.codes.filter((c) => c.method === 'serializeToNetwork' && /FriendlyByteBuf;\)V$/.test(c.desc))
  if (!cands.length) return { abstain: 'no-serializeToNetwork' }
  const real = cands.filter((c) => !(c.flags & ACC_BRIDGE) && !(c.flags & ACC_SYNTHETIC))
  const chosen = (real.length ? real : cands)[0]
  const out = layoutOfMethod(parsed, chosen)
  return { ...out, method: `${chosen.method}${chosen.desc}` }
}

function isInfoClass (parsed) {
  if ((parsed.interfaces || []).includes(ARGUMENT_TYPE_INFO)) return true
  return parsed.codes.some((c) => c.method === 'serializeToNetwork' && /FriendlyByteBuf;\)V$/.test(c.desc))
}

// Walk one jar (and its nested jars one level down): the Info classes it
// carries and the registration sites (path string -> serializer) it holds.
function scanJar (jarPath, out) {
  let buf
  try { buf = fs.readFileSync(jarPath) } catch (err) { out.unreadable.push({ jar: path.basename(jarPath), error: err.message }); return }
  scanJarBuffer(buf, path.basename(jarPath), out, 0)
}

function scanJarBuffer (buf, jarLabel, out, nesting) {
  let entries
  try { entries = zipCentralEntries(buf) } catch (err) { out.unreadable.push({ jar: jarLabel, error: err.message }); return }
  const byName = new Map(entries.map((e) => [e.name, e]))
  const modIds = readModIds(byName, buf)
  const jar = { jar: jarLabel, modIds: [...modIds], classes: 0, infos: new Map(), sites: [] }
  out.jars.push(jar)
  const parsedByName = new Map()
  for (const e of entries) {
    if (nesting === 0 && /^META-INF\/(jars|jarjar)\/.+\.jar$/.test(e.name)) {
      try { scanJarBuffer(zipEntryData(buf, e), `${jarLabel}!${e.name.split('/').pop()}`, out, 1) } catch {}
      continue
    }
    if (!e.name.endsWith('.class')) continue
    let data
    try { data = zipEntryData(buf, e) } catch { continue }
    if (!data.includes('ArgumentTypeInfo')) continue
    let parsed
    try { parsed = parseClassFile(data) } catch { continue }
    if (!parsed) continue
    jar.classes++
    parsedByName.set(parsed.className, parsed)
  }
  for (const parsed of parsedByName.values()) {
    if (isInfoClass(parsed)) jar.infos.set(parsed.className, layoutOfInfoClass(parsed))
  }
  // Registration sites: an ldc path string whose following instructions (the
  // supplier lambda followed) reach a serializer instance.
  for (const parsed of parsedByName.values()) {
    const classStrings = new Set()
    for (const c of parsed.cp) if (c && typeof c.str === 'string') classStrings.add(c.str)
    for (const codeEntry of parsed.codes) {
      let rows
      try { rows = decodeInstructions(codeEntry.code, parsed.cp) } catch { continue }
      for (let i = 0; i < rows.length; i++) {
        const str = rows[i].str
        if (typeof str !== 'string' || !/^[a-z0-9_./-]+(:[a-z0-9_./-]+)?$/.test(str) || str.length > 80) continue
        let j = i + 1
        while (j < rows.length && typeof rows[j].str !== 'string') j++
        const window = expandLambdas(parsed, rows.slice(i + 1, j), 0)
        const found = serializerInWindow(parsed, window, jar.infos, parsedByName)
        if (!found) continue
        const [ns, p] = str.includes(':') ? str.split(':') : [null, str]
        jar.sites.push({ path: p, ns, className: parsed.className, method: codeEntry.method, classStrings, ...found })
      }
    }
  }
}

function expandLambdas (parsed, rows, depth) {
  if (depth > 2) return rows
  const out = []
  for (const r of rows) {
    out.push(r)
    if (r.op !== 0xba || r.bsmIndex === undefined) continue
    const impl = resolveLambdaImpl(parsed, r.bsmIndex)
    if (!impl || impl.owner !== parsed.className) continue
    const code = parsed.codes.find((c) => c.method === impl.name && c.desc === impl.desc)
    if (!code) continue
    try { out.push(...expandLambdas(parsed, decodeInstructions(code.code, parsed.cp), depth + 1)) } catch {}
  }
  return out
}

function serializerInWindow (parsed, rows, infos, parsedByName) {
  let registerEvidence = false
  let info = null
  for (const r of rows) {
    if (r.op === 0xbb && r.cls && infos.has(r.cls)) info = info || { infoClass: r.cls }
    if (r.op === 0xb2 && r.ref && typeof r.ref.desc === 'string') { // getstatic of an Info-typed field
      const m = r.ref.desc.match(/^L(.+);$/)
      if (m && infos.has(m[1])) info = info || { infoClass: m[1] }
    }
    if (r.op >= 0xb6 && r.op <= 0xb9 && r.ref) {
      if (r.ref.owner === REGISTER_BY_CLASS.owner && r.ref.name === REGISTER_BY_CLASS.name) registerEvidence = true
      if (r.ref.owner === SINGLETON_INFO) info = info || { singleton: true }
      if (typeof r.ref.desc === 'string' && r.ref.desc.includes(ARGUMENT_TYPE_INFO)) registerEvidence = true
      // a factory on another class of this jar returning a serializer instance
      if (!info && typeof r.ref.desc === 'string') {
        const m = r.ref.desc.match(/\)L(.+);$/)
        if (m && infos.has(m[1])) info = { infoClass: m[1] }
      }
    }
  }
  if (!info) return null
  return { ...info, registerEvidence }
}

/**
 * @param {object} args
 * @param {Map<number,string>|Array<[number,string]>} args.registry the synced command_argument_type registry (id -> name)
 * @param {Set<string>|string[]} args.vanillaNames parser names the version's schema already models
 * @param {string[]} args.jars local jar paths (mods + the loader's own jar)
 * @returns {{ extension: {parsers: object[]}|null, derived: object[], abstains: object[], vanilla: number, jars: object[], unreadable: object[], ms: number }}
 */
function deriveCommandArgumentTypes ({ registry, vanillaNames, vanillaMaxId = null, jars }) {
  const t0 = Date.now()
  const entries = registry instanceof Map ? [...registry.entries()] : [...(registry || [])]
  const vanilla = new Set(vanillaNames || [])
  const maxId = Number.isInteger(vanillaMaxId) ? vanillaMaxId : (vanilla.size ? vanilla.size - 1 : -1)
  // The schema keys the vanilla table BY ID; a vanilla id whose wire name is
  // spelled differently from minecraft-data's label (26.2 wire
  // minecraft:team_color / minecraft:nbt_compound_tag vs the schema's
  // minecraft:color / minecraft:nbt) is still parsed by that id — it is
  // recorded as an alias, never abstained.
  const covered = ([id, name]) => vanilla.has(name) || (isVanillaName(name) && id <= maxId)
  const out = { jars: [], unreadable: [] }
  const wanted = entries.filter((e) => !covered(e))
  if (wanted.length) for (const jar of jars || []) scanJar(jar, out)
  const derived = []
  const abstains = []
  const aliases = []
  let vanillaCount = 0
  for (const [id, name] of entries) {
    if (covered([id, name])) { vanillaCount++; if (!vanilla.has(name)) aliases.push({ id, name }); continue }
    if (isVanillaName(name)) { abstains.push({ id, name, reason: 'vanilla-type-unmodelled-by-schema' }); continue }
    if (id <= maxId) { abstains.push({ id, name, reason: 'id-collides-with-vanilla-table' }); continue }
    const [ns, p] = name.includes(':') ? name.split(':') : [null, name]
    const cands = []
    for (const jar of out.jars) {
      for (const s of jar.sites) {
        if (s.path !== p) continue
        const nsEvidence = s.ns === ns ? 'literal' : (jar.modIds.includes(ns) ? 'mod-descriptor' : (s.classStrings.has(ns) ? 'class-string' : null))
        cands.push({ jar, site: s, nsEvidence })
      }
    }
    let pick = cands.filter((c) => c.nsEvidence)
    let evidence = 'namespace'
    if (!pick.length && cands.length === 1) { pick = cands; evidence = 'unique-path' }
    if (!pick.length) { abstains.push({ id, name, reason: cands.length ? 'ambiguous-registration' : 'no-registration-site', candidates: cands.length }); continue }
    if (pick.length > 1) {
      const uniq = new Set(pick.map((c) => c.site.singleton ? 'singleton' : c.site.infoClass))
      if (uniq.size > 1) { abstains.push({ id, name, reason: 'ambiguous-registration', candidates: pick.length }); continue }
    }
    const { jar, site } = pick[0]
    if (site.singleton) {
      derived.push({ id, name, fields: [], source: { jar: jar.jar, site: `${site.className}.${site.method}`, serializer: SINGLETON_INFO, kind: 'vanilla-api-no-properties', evidence } })
      continue
    }
    const layout = jar.infos.get(site.infoClass)
    if (!layout || layout.abstain) { abstains.push({ id, name, reason: `serializer-non-derivable:${layout ? layout.abstain : 'unknown'}`, serializer: site.infoClass, jar: jar.jar }); continue }
    derived.push({ id, name, fields: layout.fields, source: { jar: jar.jar, site: `${site.className}.${site.method}`, serializer: site.infoClass, method: layout.method, writes: layout.writes, evidence } })
  }
  const ms = Date.now() - t0
  debug(`command argument types: ${vanillaCount} vanilla, ${derived.length} derived, ${abstains.length} abstained from ${out.jars.length} jars in ${ms} ms`)
  return {
    extension: derived.length ? { parsers: derived.map((d) => ({ id: d.id, name: d.name, fields: d.fields })) } : null,
    derived,
    abstains,
    vanilla: vanillaCount,
    aliases,
    jars: out.jars.map((j) => ({ jar: j.jar, modIds: j.modIds, classes: j.classes, infos: j.infos.size, sites: j.sites.length })),
    unreadable: out.unreadable,
    ms
  }
}

module.exports = { deriveCommandArgumentTypes, layoutOfMethod, layoutOfInfoClass, scanJar, WRITES, isVanillaName }
