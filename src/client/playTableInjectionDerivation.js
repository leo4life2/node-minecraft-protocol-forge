'use strict'

// HF131 - THE CULPRIT FROM THE BYTES. Which jar of a matched pack injects a
// packet type into the CLIENTBOUND play template (the play-entry table
// mismatch the tolerant play parser raises). A class-constant-pool and
// annotation read of the pack's jars (nested jars included) against the
// version's row of data/playTableInjectionPatterns.json; a jar is never run,
// never imported. The rule is a SHAPE, data-driven per version and mapping
// namespace: a class whose constant pool carries a method reference to the
// protocol builder's add-packet method, whose @Mixin targets the GameProtocols
// class, and whose injector annotation names the clientbound builder lambda in
// its `method` element. A reference the walk cannot bind to the clientbound
// builder is an ABSTAIN with its reason, never a claim; a pack with no such
// jar says so (culprit_basis), never a guessed mod.

const fs = require('fs')
const path = require('path')
const debug = require('debug')('minecraft-protocol-forge')
const { parseClassFile, readAnnotationsAttr, cpRef, zipEntryData } = require('./jarAnalysis')
const { collectUnits } = require('./packetBodyWireDerivation')
const ROWS = require('./data/playTableInjectionPatterns.json')

const CULPRIT_BASIS = Object.freeze(['add_packet_reference', 'no_pack', 'no_version_data', 'no_jar_matched'])
const MIXIN_ANNOTATION = 'Lorg/spongepowered/asm/mixin/Mixin;'

function rowsFor (version) {
  const versions = ROWS.versions || {}
  if (!version) return null
  if (versions[version]) return versions[version]
  try {
    const mc = require('minecraft-data')(version)
    const v = mc && mc.version && mc.version.minecraftVersion
    if (v && versions[v]) return versions[v]
  } catch (ignored) {}
  return null
}

function listJars (paths) {
  const jars = []
  for (const p of paths || []) {
    try {
      const st = fs.statSync(p)
      if (st.isDirectory()) jars.push(...fs.readdirSync(p).filter((f) => f.endsWith('.jar')).sort().map((f) => path.join(p, f)))
      else if (p.endsWith('.jar')) jars.push(p)
    } catch (err) { debug(`play-table injection read: skipping ${p} (${err.message})`) }
  }
  return jars
}

// the strings of an annotation element: a string, an array of strings, a class
// descriptor (`Lx/y;`) - everything else contributes nothing
function stringsOf (value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out)
  return out
}
const classOfDescriptor = (s) => (typeof s === 'string' && s.startsWith('L') && s.endsWith(';')) ? s.slice(1, -1) : s
const methodNameOf = (s) => (typeof s === 'string' ? s.replace(/\(.*$/, '').replace(/^.*;/, '') : s)

// both annotation tables: @Mixin is CLASS-retained (RuntimeInvisibleAnnotations),
// @Inject RUNTIME-retained; third-party injectors may be either
function annotationsOf (parsed, visibleAt, invisibleAt) {
  const out = []
  for (const at of [visibleAt, invisibleAt]) {
    if (at == null) continue
    try { out.push(...readAnnotationsAttr(parsed.bytes, at, parsed.cp, { rich: true })) } catch (err) { /* a table this read cannot walk contributes nothing */ }
  }
  return out
}

// the add-packet method reference in the constant pool (a Methodref or an
// InterfaceMethodref on the builder class with the add-packet name)
function addPacketReferenceOf (parsed, names) {
  for (let i = 1; i < parsed.cp.length; i++) {
    const c = parsed.cp[i]
    if (!c || (c.tag !== 10 && c.tag !== 11)) continue
    const ref = cpRef(parsed.cp, i)
    if (ref && ref.owner === names.protocolInfoBuilder && ref.name === names.addPacket) return ref
  }
  return null
}

// the class's @Mixin targets (value: class descriptors; targets: strings)
function mixinTargetsOf (parsed) {
  const out = []
  for (const a of annotationsOf(parsed, parsed.classAnnotationsAt, parsed.classInvisibleAnnotationsAt)) {
    if (a.type !== MIXIN_ANNOTATION) continue
    for (const s of stringsOf(a.elements.value)) out.push(classOfDescriptor(s).replace(/\./g, '/'))
    for (const s of stringsOf(a.elements.targets)) out.push(String(s).replace(/\./g, '/'))
  }
  return out
}

// the methods an injector annotation on any member names (its `method` element)
function injectedMethodsOf (parsed) {
  const out = []
  for (const m of parsed.methods) {
    for (const a of annotationsOf(parsed, m.annotationsAt, m.invisibleAnnotationsAt)) {
      if (!a.elements || a.elements.method == null) continue
      for (const s of stringsOf(a.elements.method)) out.push(methodNameOf(s))
    }
  }
  return out
}

function classVerdict (parsed, className, namespaces) {
  for (const [namespace, names] of Object.entries(namespaces)) {
    const ref = addPacketReferenceOf(parsed, names)
    if (!ref) continue
    const targets = mixinTargetsOf(parsed)
    if (!targets.includes(names.gameProtocols)) {
      return { matched: false, namespace, className, reason: 'mixin_target_not_game_protocols' }
    }
    const methods = injectedMethodsOf(parsed)
    if (!methods.includes(names.clientboundBuilder)) {
      return { matched: false, namespace, className, reason: 'not_bound_to_clientbound_builder' }
    }
    return { matched: true, namespace, className }
  }
  return null
}

/**
 * Names the jar of a pack whose bytes carry the add-packet reference into the
 * clientbound play template of the given game version.
 *
 * @param {{paths?: string[], version?: string}} opts jar paths or mods folders; the game version (minecraft-data name)
 * @returns {{version: string|null, culprit_jar: string|null, culprit_basis: string, culprit_mod: {id: string, name: string, version: string|null}|null, matches: Array, abstained: Array, jars: number, errors: string[]}}
 */
function derivePlayTableInjection ({ paths = [], version = null } = {}) {
  const result = { version: version || null, culprit_jar: null, culprit_basis: 'no_jar_matched', culprit_mod: null, matches: [], abstained: [], jars: 0, errors: [] }
  const jars = listJars(paths)
  result.jars = jars.length
  if (!jars.length) { result.culprit_basis = 'no_pack'; return result }
  const namespaces = rowsFor(version)
  if (!namespaces) { result.culprit_basis = 'no_version_data'; return result }
  const needles = Object.values(namespaces).map((n) => n.addPacket)
  for (const jar of jars) {
    let units
    try { units = collectUnits(jar) } catch (err) { result.errors.push(`${path.basename(jar)}: unreadable (${err.message})`); continue }
    const outerMod = units.length ? units[0].mod : null
    for (const unit of units) {
      for (const [className, entry] of unit.classes) {
        let bytes
        try { bytes = zipEntryData(unit.buf, entry) } catch (err) { continue }
        if (!needles.some((n) => bytes.includes(n))) continue
        const parsed = parseClassFile(bytes)
        if (!parsed) continue
        const v = classVerdict(parsed, className, namespaces)
        if (!v) continue
        const row = { jar: path.basename(jar), nested: unit.nested, className, namespace: v.namespace, mod: unit.mod || outerMod || null }
        if (v.matched) result.matches.push(row)
        else result.abstained.push({ ...row, reason: v.reason })
      }
    }
  }
  if (result.matches.length) {
    const first = result.matches[0]
    result.culprit_jar = first.jar
    result.culprit_basis = 'add_packet_reference'
    result.culprit_mod = first.mod ? { id: first.mod.id, name: first.mod.name, version: first.mod.version ?? null } : null
  }
  return result
}

module.exports = { derivePlayTableInjection, CULPRIT_BASIS, __internals: { rowsFor, classVerdict, listJars } }
