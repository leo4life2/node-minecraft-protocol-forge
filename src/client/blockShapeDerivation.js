'use strict'

// MODDED BLOCK SHAPE DERIVATION - static, mapping-level analysis of the local
// instance's mod jars that answers, per registered modded block:
//   - shapeClass: 'nonsolid' (provably no collision) | 'solid' | 'abstain'
//   - stateCount: exact number of block states, or null (not derivable)
// so the state-calibration layer can resolve modded palette ids to passable
// blocks instead of the conservative all-solid placeholder (nonsolid modded
// plants - Farmer's Delight wild crops etc. - stop reading as walls).
//
// DESIGN LAWS (owner-ratified; enforced by test/privacyLaws.test.js and the
// embedding app's privacy suites):
//   - LOCAL-ONLY, READ-ONLY, JARS-ONLY: reads bytes from local jar files and
//     parses them; performs no network I/O; never classloads/executes mod
//     code; writes nothing.
//   - PURPOSE-LIMITED: output is {registryName -> shape/stateCount} handed to
//     the perception calibration layer. Nothing else is extracted here.
//   - NO PER-MOD DATA: every signal is library/mapping-level - vanilla
//     base-class facts, mapping-era identifier names, resource formats. The
//     vocabulary lives in data/blockShapeTables.json, generated mechanically
//     from the real deobfuscated vanilla jar + published mappings by
//     tools/genBlockShapeTables.js (see its 1003-block self-test).
//
// TRUTH DISCIPLINE: absent/ambiguous/dynamic evidence => ABSTAIN, which the
// consumer maps to today's conservative solid placeholder. The one failure
// mode that could mislead movement - a false 'nonsolid' - is guarded by (a)
// requiring an explicit no-collision proof (Properties.noCollission call or
// Properties.copy of a provably no-collision vanilla block), and (b) refusing
// 'nonsolid' whenever any class on the block's chain overrides
// getCollisionShape (statically unknowable collision). stateCounts abstain on
// ANY branch/loop/helper indirection in a state-definition body.
//
// Namespaces ('eras'):
//   srg          - Forge 1.17-1.20.1 jars (mojmap class names, SRG members)
//   intermediary - Fabric jars (any version; intermediary ids are stable)
//   mojmap       - Forge 1.20.2+ / NeoForge / 26.x jars (Mojang member names;
//                  HF58b, generated from a Mojang-named server jar)
// A jar of an era absent from the tables derives nothing and every block
// abstains (honest degradation).

const fs = require('fs')
const {
  zipCentralEntries, zipEntryData, parseClassFile, decodeInstructions, resolveLambdaImpl, cpRef, cpUtf8
} = require('./jarAnalysis')
const debug = require('debug')('minecraft-protocol-forge')

const TABLES = require('./data/blockShapeTables.json')

const { forEachNestedJar } = require('./nestedJars') // HF53: the one nested-jar rule
const DR_CLS = 'net/minecraftforge/registries/DeferredRegister'
const DR_REGISTER_DESC = '(Ljava/lang/String;Ljava/util/function/Supplier;)Lnet/minecraftforge/registries/RegistryObject;'

// ---------------------------------------------------------------------------
// era vocabularies from the generated tables
function eraVocab (era) {
  const ns = TABLES.namespaces[era]
  const cn = ns.ids.classNames
  const propDescs = new Set([cn.propInteger, cn.propBoolean, cn.propEnum, cn.propDirection, cn.propBase]
    .filter(Boolean).map((c) => `L${c};`))
  return {
    era,
    ns,
    cn,
    propDescs,
    builderDesc: `(L${cn.builder};)V`,
    cbsdNames: new Set(ns.ids.createBlockStateDefinition.filter(Boolean)),
    gcsNames: new Set(ns.ids.getCollisionShape.filter(Boolean)),
    noColl: ns.ids.propsNoCollission,
    propsOf: new Set(ns.ids.propsOf.filter(Boolean)),
    propsCopy: new Set([].concat(ns.ids.propsCopy || []).filter(Boolean)), // one name on 1.20.1, ofFullCopy + ofLegacyCopy on 1.21+
    registerNames: new Set((ns.ids.registryRegister || []).map((r) => r.name)),
    // the base-implementation owner is not an "override": collision there
    // respects the hasCollision flag the noCollission signal proves.
    overridesCollision: new Set(ns.overridesCollision.filter((c) => c !== cn.behaviour)),
    vanillaNonSolid: new Set(TABLES.vanillaNonSolid)
  }
}
// HF58b: every namespace the generated tables carry (srg, intermediary, and
// mojmap - Forge 1.20.2+ / NeoForge / 26.x jars with Mojang member names)
const VOCABS = Object.fromEntries(Object.keys(TABLES.namespaces).map((era) => [era, eraVocab(era)]))

// ---------------------------------------------------------------------------
// class universe across all jars (top-level + nested), lazy parse
function buildUniverse (jarPaths) {
  const units = [] // {source, buf, entries: Map<clsName, entry>}
  const addUnit = (buf, source, depth) => {
    let entries
    try { entries = zipCentralEntries(buf) } catch { return }
    const classes = new Map()
    forEachNestedJar(buf, entries, depth, ({ entry, data }) => {
      try { addUnit(data, `${source}!${entry.name}`, depth + 1) } catch { /* unreadable nested jar */ }
    })
    for (const e of entries) {
      if (e.name.endsWith('.class')) {
        const cls = e.name.slice(0, -6)
        if (!classes.has(cls)) classes.set(cls, e)
      }
    }
    units.push({ source, buf, classes })
  }
  for (const p of jarPaths) {
    try { addUnit(fs.readFileSync(p), p, 0) } catch (err) { debug(`shape scan: unreadable jar ${p} (${err.message})`) }
  }
  const where = new Map() // clsName -> {unit, entry}
  for (const u of units) {
    for (const [cls, e] of u.classes) if (!where.has(cls)) where.set(cls, { unit: u, entry: e })
  }
  const parsed = new Map()
  // HF58b: a jar unit's mapping era by the member spellings anywhere in it
  // (srg ids m_1234_/f_1234_, intermediary class_/method_/field_ ids, else
  // Mojang names) - the fallback for a class whose own constant pool shows
  // only class names (registrars, enums)
  const unitEras = new Map()
  const unitEra = (unit) => {
    if (!unit) return null
    if (unitEras.has(unit)) return unitEras.get(unit)
    let era = null
    let sawMoj = false
    for (const [, e] of unit.classes) {
      let raw
      try { raw = zipEntryData(unit.buf, e).toString('latin1') } catch { continue }
      if (/(?:^|[^A-Za-z0-9_])(?:m|f|p)_\d{3,}_(?![A-Za-z0-9_])/.test(raw)) { era = 'srg'; break }
      if (raw.includes('net/minecraft/class_')) { era = 'intermediary'; break }
      if (raw.includes('net/minecraft/')) sawMoj = true
    }
    if (!era && sawMoj) era = VOCABS.mojmap ? 'mojmap' : 'srg'
    unitEras.set(unit, era)
    return era
  }
  return {
    units,
    has: (cls) => where.has(cls),
    eraOf (cls, p) {
      const own = p ? eraOfClass(p) : null
      if (own) return own
      const loc = where.get(cls)
      return unitEra(loc ? loc.unit : null)
    },
    get (cls) {
      if (parsed.has(cls)) return parsed.get(cls)
      const loc = where.get(cls)
      let p = null
      if (loc) { try { p = parseClassFile(zipEntryData(loc.unit.buf, loc.entry)) } catch { p = null } }
      parsed.set(cls, p)
      return p
    }
  }
}

// era of one class file by the SPELLING of the members it references or
// declares: srg ids (m_1234_ / f_1234_ / p_1234_) = the Forge 1.17-1.20.1
// srg era; intermediary ids (class_ / method_ / field_) = Fabric; a class
// that shows only Mojang-named vanilla classes and no era-spelled member is
// AMBIGUOUS between srg and mojmap (null - the caller falls back to the jar
// unit's era; a mojmap-era table absent from the tables resolves to srg).
const SRG_MEMBER_RE = /^(?:m|f|p)_\d+_$/
const INTER_MEMBER_RE = /^(?:method|field)_\d+$/
function eraOfClass (parsed) {
  let sawInter = false
  let sawMoj = false
  let sawSrg = false
  let sawMojMember = false // a plainly-spelled member of a Mojang-named vanilla class
  for (const c of parsed.cp) {
    if (!c) continue
    if (c.tag === 1 && typeof c.str === 'string') {
      if (c.str.startsWith('net/minecraft/class_')) sawInter = true
      else if (c.str.startsWith('net/minecraft/')) sawMoj = true
    } else if (c.tag === 9 || c.tag === 10 || c.tag === 11) {
      const ref = cpRef(parsed.cp, parsed.cp.indexOf(c))
      if (!ref || !ref.owner || !ref.owner.startsWith('net/minecraft/')) continue
      if (SRG_MEMBER_RE.test(ref.name)) sawSrg = true
      else if (INTER_MEMBER_RE.test(ref.name) || ref.owner.startsWith('net/minecraft/class_')) sawInter = true
      else if (ref.name !== '<init>' && ref.name !== '<clinit>') sawMojMember = true
    }
  }
  for (const m of parsed.methods || []) {
    if (SRG_MEMBER_RE.test(m.name)) sawSrg = true
    else if (INTER_MEMBER_RE.test(m.name)) sawInter = true
  }
  if (sawInter) return 'intermediary'
  if (sawSrg) return 'srg'
  if (sawMoj && !VOCABS.mojmap) return 'srg'
  if (sawMojMember) return 'mojmap'
  return null
}

// ---------------------------------------------------------------------------
// hierarchy walk over mod classes + the vanilla table
function chainOf (cls, universe, vocab, cap = 24) {
  const chain = []
  let c = cls
  while (c && cap-- > 0) {
    chain.push(c)
    if (universe.has(c)) {
      const p = universe.get(c)
      if (!p) return { chain, complete: false }
      c = p.superName
      continue
    }
    const vSuper = vocab.ns.hierarchy[c]
    if (vSuper !== undefined) {
      if (c === vocab.cn.block || vSuper === 'java/lang/Object' || vSuper == null) return { chain, complete: true }
      c = vSuper
      continue
    }
    // unknown class (missing dependency / other era): chain not provable
    return { chain, complete: c === 'java/lang/Object' }
  }
  return { chain, complete: c === 'java/lang/Object' || c == null }
}

function chainReachesBlock (cls, universe, vocab) {
  const { chain, complete } = chainOf(cls, universe, vocab)
  return complete && chain.includes(vocab.cn.block)
}

// ---------------------------------------------------------------------------
// statement segmentation + property-constant classification (runtime flavor:
// stricter than the generator - any branch inside a statement abstains)
function statements (rows) {
  const stmts = []
  let cur = []
  for (const r of rows) {
    cur.push(r)
    if (r.op === 0xb3) { stmts.push(cur); cur = [] }
  }
  return stmts
}

// classify `putstatic <property field>` statements in a MOD class clinit.
// Returns a property INFO {name, card, kind, min, values} | {aliasTo:
// 'owner#field'} | null (unknown => abstain). HF58b: the info carries what
// the state index needs beside the cardinality - the property name (the
// create call's string), its kind and the int floor; a mod enum's
// serialized names are not modelled (values null: the count stays exact,
// the state name shows that property's value index).
// HF58b r3: a definition is read ONLY when the era's own property class
// creates it in ONE straight call - the statement's single invoke is a
// create owned by a property class of the era vocabulary, and the name is
// the one string constant feeding it (the create's String parameter). Any
// other call in the statement (a mod-owned helper returning a property, a
// name built by a call, a lambda predicate, a collection factory) means the
// bytes do not carry the definition: abstain, never a guessed exact count.
function classifyModPropertyStatement (stmt, vocab, universe) {
  if (stmt.some((r) => r.target !== undefined)) return null // branches: not a straight-line definition
  const invokes = stmt.filter((r) => r.op >= 0xb6 && r.op <= 0xba) // invokevirtual/special/static/interface/dynamic
  if (invokes.length === 0) {
    const aliases = stmt.filter((r) => r.op === 0xb2 && r.ref && vocab.propDescs.has(r.ref.desc))
    if (aliases.length) {
      const a = aliases[aliases.length - 1].ref
      return { aliasTo: `${a.owner}#${a.name}` }
    }
    return null
  }
  if (invokes.length !== 1) return null // a helper, a name call, a lambda beside the create: abstain
  const create = invokes[0]
  if ((create.op !== 0xb8 && create.op !== 0xb6) || !create.ref) return null
  if (!vocab.propDescs.has(`L${create.ref.owner};`) || !vocab.propDescs.has(retDesc(create.ref.desc))) return null // owned by the era's property class
  const d = create.ref.desc
  const strs = stmt.filter((r) => r.str !== undefined).map((r) => r.str)
  if (strs.length !== 1) return null // the name is the one ldc the create takes
  const name = strs[0]
  if (d.startsWith('(Ljava/lang/String;II)')) {
    const ints = stmt.filter((r) => r.int !== undefined).map((r) => r.int)
    const [lo, hi] = ints.slice(-2)
    return hi !== undefined ? { name, card: hi - lo + 1, kind: 'int', min: lo } : null
  }
  if (d.startsWith('(Ljava/lang/String;)')) {
    const isDir = retDesc(d) === `L${vocab.cn.propDirection};`
    return isDir ? { name, card: 6, kind: 'enum', values: null } : { name, card: 2, kind: 'bool' }
  }
  if (d.startsWith('(Ljava/lang/String;Ljava/lang/Class;)')) {
    const clsRow = [...stmt].reverse().find((r) => (r.op === 0x12 || r.op === 0x13) && r.cls)
    if (!clsRow) return null
    const n = enumConstCount(clsRow.cls, universe, vocab)
    return n ? { name, card: n, kind: 'enum', values: null } : null
  }
  const aastores = stmt.filter((r) => r.op === 0x53).length
  if (aastores > 0) return { name, card: aastores, kind: 'enum', values: null }
  return null
}

function retDesc (desc) {
  const m = desc.match(/\)(L[^;]+;)$/)
  return m ? m[1] : null
}

function enumConstCount (cls, universe, vocab) {
  if (vocab.ns.enumCounts[cls] !== undefined) return vocab.ns.enumCounts[cls]
  const p = universe.has(cls) ? universe.get(cls) : null
  if (!p) return null
  const consts = p.fields.filter((f) => f.desc === `L${cls};` && (f.flags & 0x4000))
  return consts.length || null
}

// resolve a property field reference to its info {name, card, kind, min,
// values} (mod fields chase their clinit definition; vanilla fields hit the
// table, walking the declaring hierarchy because javac may qualify
// inherited statics with the subclass). null = unknown => abstain.
function propInfoOf (propKey, universe, vocab, seen = new Set()) {
  if (seen.has(propKey)) return null
  seen.add(propKey)
  const direct = vanillaPropInfo(propKey, vocab)
  if (direct != null) return direct
  const [owner, field] = propKey.split('#')
  if (universe.has(owner)) {
    const p = universe.get(owner)
    if (!p) return null
    const clinit = p.codes.find((m) => m.method === '<clinit>')
    if (clinit) {
      for (const stmt of statements(decodeInstructions(clinit.code, p.cp))) {
        const put = stmt[stmt.length - 1]
        if (!put.ref || put.ref.name !== field || !vocab.propDescs.has(put.ref.desc)) continue
        const c = classifyModPropertyStatement(stmt, vocab, universe)
        if (!c) return null
        if (c.card != null) return c
        if (c.aliasTo) return propInfoOf(c.aliasTo, universe, vocab, seen)
        return null
      }
    }
    // field may be inherited: JVM resolution order is the class itself,
    // then superinterfaces (interface constants - the Create
    // ProperWaterloggedBlock.WATERLOGGED idiom), then the superclass
    for (const iface of p.interfaces || []) {
      const viaIface = propInfoOf(`${iface}#${field}`, universe, vocab, seen)
      if (viaIface != null) return viaIface
    }
    if (p.superName) return propInfoOf(`${p.superName}#${field}`, universe, vocab, seen)
    return null
  }
  return null
}

function vanillaPropInfo (propKey, vocab) {
  const hit = vocab.ns.propCard[propKey]
  if (hit && hit.card != null) return hit
  let [owner, field] = propKey.split('#')
  while (vocab.ns.hierarchy[owner] !== undefined) {
    owner = vocab.ns.hierarchy[owner]
    if (owner == null) break
    const h = vocab.ns.propCard[`${owner}#${field}`]
    if (h && h.card != null) return h
  }
  return null
}

// ---------------------------------------------------------------------------
// state count: effective createBlockStateDefinition contributions over the
// chain (mod bodies parsed with abstain-on-any-branch discipline; vanilla
// classes from the generated table, including its dynamic/abstain flags).
// HF58b remediation: a mod body is read by ALLOWLIST - the only rows that
// may appear in an exactly-counted body are the vanilla varargs idiom
// (aload / int const / anewarray of a property class / dup / aastore /
// getstatic of a KNOWN property field / Builder.add / pop / checkcast /
// return) and the super createBlockStateDefinition call. ANY other row -
// an invoke that is not Builder.add nor the super call (a helper that
// returns Property, Property[] or nothing while registering on the
// builder), a getfield, a getstatic of an unknown type or of an array, an
// invokedynamic, a branch - is DYNAMIC and the whole chain abstains. The
// old shape recognised helpers only when they RETURNED a single property:
// a helper returning Property[] read as zero properties and the parent
// count shipped as exact (the verifier's weird_arr).
const CBSD_PLAIN_OPS = new Set([
  0x00, // nop
  0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, // iconst_m1..5
  0x10, 0x11, 0x12, 0x13, // bipush, sipush, ldc, ldc_w (array lengths)
  0x19, 0x2a, 0x2b, 0x2c, 0x2d, // aload, aload_n
  0x3a, 0x4b, 0x4c, 0x4d, 0x4e, // astore, astore_n (a builder alias)
  0x53, // aastore
  0x57, 0x59, // pop, dup
  0xb1, // return
  0xc0 // checkcast
])
function builderAddOf (vocab) {
  if (!vocab._builderAdd) vocab._builderAdd = { owner: vocab.cn.builder, desc: `([L${vocab.cn.propBase};)L${vocab.cn.builder};` }
  return vocab._builderAdd
}
// HF58b r3: can a parameter of this type carry the builder reference? The
// builder's only supertype is Object, so Object, the builder class and
// arrays of either can hold it; a String, a primitive or any other class
// (a mod class is never the builder) cannot.
function paramMayCarryBuilder (t, vocab) {
  const base = t.replace(/^\[+/, '')
  return base === 'Ljava/lang/Object;' || base === `L${vocab.cn.builder};`
}
function paramIsProperty (t, vocab) { return vocab.propDescs.has(t.replace(/^\[+/, '')) }
// HF58b r3: a void call in a createBlockStateDefinition body that the
// builder cannot reach - not on the builder, no property parameter, and
// either no parameter that can carry the builder at all, or (the Kotlin
// Intrinsics.checkNotNullParameter(Object, String) idiom) an Object
// parameter whose callee body is read and is builder-blind: it names no
// builder or property class, stores nothing (no putfield/putstatic/
// aastore), has no invokedynamic, and every call it makes takes only
// parameters that cannot carry the builder (the Object is never forwarded).
// A callee outside the universe cannot be read: the call stays flagged.
function builderBlindVoidCall (r, vocab, universe) {
  if (!r.ref || !r.ref.desc.endsWith(')V')) return false
  if (r.ref.owner === vocab.cn.builder || vocab.propDescs.has(`L${r.ref.owner};`)) return false
  const params = descParamTypes(r.ref.desc)
  if (params.some((t) => paramIsProperty(t, vocab))) return false
  if (!params.some((t) => paramMayCarryBuilder(t, vocab))) return true
  if (params.some((t) => t.replace(/^\[+/, '') === `L${vocab.cn.builder};`)) return false
  if (!universe) return false
  const callee = universeMethod(universe, r.ref.owner, r.ref.name, r.ref.desc)
  if (!callee) return false
  for (const q of callee.rows) {
    if (q.op === 0xba || q.op === 0xb3 || q.op === 0xb5 || q.op === 0x53) return false
    if (q.cls && (q.cls === vocab.cn.builder || vocab.propDescs.has(`L${q.cls};`))) return false
    if (!q.ref) continue
    if (q.ref.owner === vocab.cn.builder || vocab.propDescs.has(`L${q.ref.owner};`) || paramIsProperty(q.ref.desc, vocab)) return false
    if (q.op >= 0xb6 && q.op <= 0xb9 &&
      descParamTypes(q.ref.desc).some((t) => paramMayCarryBuilder(t, vocab) || paramIsProperty(t, vocab))) return false
  }
  return true
}
function modCbsdContrib (parsed, vocab, universe) {
  const m = parsed.codes.find((c) => vocab.cbsdNames.has(c.method) && c.desc === vocab.builderDesc)
  if (!m) return null // does not define it
  const rows = decodeInstructions(m.code, parsed.cp)
  const props = []
  let dynamic = false
  let dynamicWhy = null
  let callsSuper = false
  const add = builderAddOf(vocab)
  const flag = (why) => { if (!dynamic) { dynamic = true; dynamicWhy = why } }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (r.target !== undefined) { flag('branch'); continue } // ANY branch in a mod body
    if (r.op === 0xb2 && r.ref) {
      if (vocab.propDescs.has(r.ref.desc)) props.push(`${r.ref.owner}#${r.ref.name}`)
      else flag(`getstatic ${r.ref.owner}#${r.ref.name}:${r.ref.desc}`) // an array of properties, or a field of a type we cannot read as a property
      continue
    }
    if (r.op === 0xbd) { // anewarray: the varargs array of a property class
      if (r.cls && vocab.propDescs.has(`L${r.cls};`)) continue
      flag(`anewarray ${r.cls}`)
      continue
    }
    if (r.op === 0xb6 || r.op === 0xb7 || r.op === 0xb8 || r.op === 0xb9) {
      if (!r.ref) { flag('invoke ?'); continue }
      if (r.op === 0xb7 && vocab.cbsdNames.has(r.ref.name) && r.ref.desc === vocab.builderDesc) { callsSuper = true; continue }
      if ((r.op === 0xb6 || r.op === 0xb7) && r.ref.owner === add.owner && r.ref.desc === add.desc) continue // Builder.add(Property...)
      if (builderBlindVoidCall(r, vocab, universe)) continue // HF58b r3: a void call the builder cannot reach (a null check, a log line)
      flag(`invoke ${r.ref.owner}.${r.ref.name}${r.ref.desc}`) // a helper: it may add, return or build properties
      continue
    }
    if (CBSD_PLAIN_OPS.has(r.op)) continue
    flag(`op 0x${r.op.toString(16)}`) // invokedynamic, getfield, arithmetic, locals of other kinds ...
  }
  return { props, callsSuper, dynamic, dynamicWhy }
}

// HF58b: the state INDEX of a block class - its exact state count plus the
// ordered property list vanilla lays the states out by: properties sorted by
// NAME (StateDefinition keeps an ImmutableSortedMap; the first name is the
// slowest-varying), each with its value order (bool [true, false]; ints
// ascending from the create floor; enums in the vanilla-known order, or null
// when the order is not derivable - the count stays exact, the name shows
// the value index). Returns {count, props} | null (UNKNOWN: any unresolved
// contribution on the chain - never the parent's count as exact).
function stateIndexOf (cls, universe, vocab) {
  const propKeys = []
  let factor = 1 // solved whole-body contributions of loop-driven vanilla classes
  let indexed = true // false when a solved factor hides its properties
  let c = cls
  let cap = 24
  while (c && cap-- > 0) {
    if (universe.has(c)) {
      const p = universe.get(c)
      if (!p) return null
      const contrib = modCbsdContrib(p, vocab, universe)
      if (contrib) {
        if (contrib.dynamic) return null
        propKeys.push(...contrib.props)
        if (!contrib.callsSuper) break
      }
      c = p.superName
      continue
    }
    const v = vocab.ns.classContrib[c]
    if (v) {
      if (v.dynamic) return null
      if (v.contribFactor != null) { factor *= v.contribFactor; if (v.contribFactor !== 1) indexed = false }
      propKeys.push(...v.props)
      if (!v.callsSuper) break
    }
    if (vocab.ns.hierarchy[c] === undefined) {
      // unknown ancestor: its contributions are unknowable
      if (c !== 'java/lang/Object') return null
      break
    }
    c = vocab.ns.hierarchy[c]
  }
  let count = factor
  const props = []
  for (const pk of propKeys) {
    const info = propInfoOf(pk, universe, vocab)
    if (info == null || info.card == null) return null
    count *= info.card
    props.push(info)
  }
  if (!indexed || props.some((p) => !p.name)) return { count, props: null }
  const sorted = [...props].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return {
    count,
    props: sorted.map((p) => ({ name: p.name, card: p.card, values: propValuesOf(p) }))
  }
}

function propValuesOf (p) {
  if (p.kind === 'bool') return ['true', 'false']
  if (p.kind === 'int') return p.min != null ? Array.from({ length: p.card }, (_, i) => String(p.min + i)) : null
  if (p.kind === 'enum') return Array.isArray(p.values) && p.values.length === p.card ? p.values : null
  return null
}

function stateCountOf (cls, universe, vocab) {
  const idx = stateIndexOf(cls, universe, vocab)
  return idx ? idx.count : null
}

// decode a state offset inside a block's span into its property values
// (the consumer's naming: 'name[face=floor,facing=west,variant=5]'). A
// property whose value order is unknown reads as its value index ('#3').
function decodeStateIndex (index, offset) {
  if (!index || !Array.isArray(index.props)) return null
  const out = {}
  let rem = offset
  const strides = []
  let stride = 1
  for (let i = index.props.length - 1; i >= 0; i--) {
    strides[i] = stride
    stride *= index.props[i].card ?? (index.props[i].values ? index.props[i].values.length : 1)
  }
  for (let i = 0; i < index.props.length; i++) {
    const p = index.props[i]
    const card = p.card ?? (p.values ? p.values.length : 1)
    const vi = Math.floor(rem / strides[i]) % card
    rem -= vi * strides[i]
    out[p.name] = p.values ? p.values[vi] : `#${vi}`
  }
  return out
}

// generic superclass reachability across the mod universe only (for
// framework classes like AbstractRegistrate that are not vanilla-table names)
function chainReachesClass (cls, target, universe, cap = 24) {
  let c = cls
  while (c && cap-- > 0) {
    if (c === target) return true
    if (!universe.has(c)) return false
    const p = universe.get(c)
    if (!p) return false
    c = p.superName
  }
  return false
}

// find a method body anywhere in the universe: {rows, parsed} or null
function universeMethod (universe, owner, name, desc) {
  if (!universe.has(owner)) return null
  const p = universe.get(owner)
  if (!p) return null
  const m = p.codes.find((c) => c.method === name && c.desc === desc)
  if (!m) return null
  let rows
  try { rows = decodeInstructions(m.code, p.cp) } catch { return null }
  return { rows, parsed: p, flags: m.flags }
}

// ---------------------------------------------------------------------------
// solidity: explicit no-collision proof + collision-override guard
function collisionOverrideOnChain (cls, universe, vocab) {
  const { chain, complete } = chainOf(cls, universe, vocab)
  if (!complete) return true // unknown chain: treat as unknowable collision
  for (const c of chain) {
    if (universe.has(c)) {
      const p = universe.get(c)
      if (!p) return true
      if (p.codes.some((m) => vocab.gcsNames.has(m.method) && m.desc.split(')')[0].split(';').length === 5)) return true
    } else if (vocab.overridesCollision.has(c)) {
      return true
    }
  }
  return false
}

// scan rows (a supplier lambda body, constructor body, or a Fabric
// registration window) for Properties-chain signals
function propsSignals (rows, vocab) {
  const out = { noColl: false, of: false, copyVanillaField: null, copyOther: false }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if ((r.op === 0xb6 || r.op === 0xb8) && r.ref) {
      if (r.ref.name === vocab.noColl) out.noColl = true
      else if (vocab.propsOf.has(r.ref.name)) out.of = true
      else if (vocab.propsCopy.has(r.ref.name)) {
        // copy source: nearest preceding getstatic of a vanilla Blocks field
        let src = null
        for (let j = i - 1; j >= 0 && j > i - 4; j--) {
          const g = rows[j]
          if (g.op === 0xb2 && g.ref && g.ref.owner === vocab.cn.blocks) { src = g.ref.name; break }
        }
        if (src != null && vocab.ns.blocksFieldToName[src]) out.copyVanillaField = vocab.ns.blocksFieldToName[src]
        else out.copyOther = true
      }
    }
  }
  return out
}

// the ctor descriptor a registration actually invokes: an explicit
// Class::new method-handle desc, or the last `new <cls>` + invokespecial
// <init> pair inside the supplier/window rows.
function invokedCtorDesc (cls, rows) {
  if (!rows) return null
  let desc = null
  for (const r of rows) {
    if (r.op === 0xb7 && r.ref && r.ref.owner === cls && r.ref.name === '<init>') desc = r.ref.desc
  }
  return desc
}

// Properties signals along the ACTUALLY-INVOKED constructor chain: starting
// at cls.<init>(ctorDesc), follow this()/super() delegations only (never
// sibling overloads - a nonsolid convenience ctor must not poison a plain
// one). `fresh` records that a ctor on the chain built its own Properties
// (of()/copy(...)): external (supplier/builder) evidence cannot be trusted
// to reach super() in that case.
function ctorChainSignals (cls, ctorDesc, universe, vocab, cap = 12) {
  const out = { noColl: false, of: false, copyVanillaField: null, fresh: false }
  let cur = cls
  let desc = ctorDesc
  while (cur && desc && cap-- > 0) {
    if (!universe.has(cur)) break // vanilla/unknown ancestors: table classes add no Properties signals in ctors
    const p = universe.get(cur)
    if (!p) break
    const m = p.codes.find((c) => c.method === '<init>' && c.desc === desc)
    if (!m) break
    let rows
    try { rows = decodeInstructions(m.code, p.cp) } catch { break }
    const s = propsSignals(rows, vocab)
    out.noColl = out.noColl || s.noColl
    if (!out.copyVanillaField && s.copyVanillaField) out.copyVanillaField = s.copyVanillaField
    if (s.of || s.copyOther || s.copyVanillaField) out.fresh = true
    // the this()/super() delegation: the first <init> invocation NOT paired
    // with a `new` of the same class earlier in this body
    const newCounts = new Map()
    let deleg = null
    for (const r of rows) {
      if (r.op === 0xbb && r.cls) newCounts.set(r.cls, (newCounts.get(r.cls) || 0) + 1)
      else if (r.op === 0xb7 && r.ref && r.ref.name === '<init>') {
        const n = newCounts.get(r.ref.owner) || 0
        if (n > 0) { newCounts.set(r.ref.owner, n - 1); continue }
        if (r.ref.owner === cur || r.ref.owner === p.superName) { deleg = r.ref; break }
      }
    }
    if (!deleg) break
    cur = deleg.owner
    desc = deleg.desc
  }
  return out
}

function solidityOf (cls, supplierRows, universe, vocab, ctorDesc) {
  // signals from the supplier body plus the actually-invoked ctor chain
  // (verifier MEDIUM-1 hardening: never union sibling ctor overloads)
  const sig = propsSignals(supplierRows || [], vocab)
  const resolvedDesc = ctorDesc ?? invokedCtorDesc(cls, supplierRows)
  const ctorSig = resolvedDesc ? ctorChainSignals(cls, resolvedDesc, universe, vocab) : null
  const ctorFresh = !!(ctorSig && ctorSig.fresh)
  let nonsolidWhy = null
  if (ctorSig && ctorSig.noColl) nonsolidWhy = 'Properties.noCollission (invoked ctor chain)'
  else if (ctorSig && ctorSig.copyVanillaField && vocab.vanillaNonSolid.has(ctorSig.copyVanillaField)) nonsolidWhy = `Properties.copy(${ctorSig.copyVanillaField}) (invoked ctor chain)`
  else if (!ctorFresh && sig.noColl) nonsolidWhy = 'Properties.noCollission'
  else if (!ctorFresh && sig.copyVanillaField != null && vocab.vanillaNonSolid.has(sig.copyVanillaField)) nonsolidWhy = `Properties.copy(${sig.copyVanillaField})`
  if (nonsolidWhy) {
    if (collisionOverrideOnChain(cls, universe, vocab)) return { shape: 'abstain', why: 'noCollission but getCollisionShape override on chain' }
    return { shape: 'nonsolid', why: nonsolidWhy }
  }
  if (sig.noColl || (sig.copyVanillaField != null && vocab.vanillaNonSolid.has(sig.copyVanillaField))) {
    // external nonsolid evidence conflicting with a fresh-props ctor:
    // statically unresolvable which Properties won - abstain
    return { shape: 'abstain', why: 'nonsolid evidence conflicts with fresh Properties in invoked ctor' }
  }
  const copyField = sig.copyVanillaField || (ctorSig && ctorSig.copyVanillaField) || null
  if (copyField != null) return { shape: 'solid', why: `Properties.copy(${copyField}) with collision` }
  if (sig.of || (ctorSig && ctorSig.of)) return { shape: 'solid', why: 'Properties.of() with collision' }
  return { shape: 'abstain', why: 'no properties signal' }
}

// ---------------------------------------------------------------------------
// HF58b: a symbolic operand-stack walk over ONE method body. Every value
// the walk pushes is a small description of where it came from (a string
// literal, a static field, a `new`, a call with its receiver and arguments,
// an invokedynamic with its captures, an array element, a parameter) so a
// registration call can be asked "what is your name argument?" even when
// the name was built by a StringConcatFactory indy from an enum constant's
// accessor inside a loop, or arrived as a helper's parameter. Anything the
// walk does not model poisons the stack until the next statement boundary
// (a poisoned argument never resolves - honest abstention, never a guess).
const SCF_CLS = 'java/lang/invoke/StringConcatFactory'
const STRING_CLS = 'java/lang/String'

// local-variable slot -> parameter index for a STATIC method (long/double
// take two slots)
function paramSlotsOf (desc) {
  const slots = new Map()
  let slot = 0
  descParamTypes(desc).forEach((t, index) => {
    slots.set(slot, { index, type: t })
    slot += (t === 'J' || t === 'D') ? 2 : 1
  })
  return slots
}

// bootstrap-method view of an invokedynamic: a lambda (impl handle), a
// string concatenation (recipe + constants), or something else
function indyInfo (parsed, bsmIndex) {
  const bsm = parsed.bootstrapMethods && parsed.bootstrapMethods[bsmIndex]
  if (!bsm) return null
  const mh = parsed.cp[bsm.ref]
  const mref = mh && mh.tag === 15 ? cpRef(parsed.cp, mh.refIndex) : null
  const strArg = (i) => { const c = parsed.cp[bsm.args[i]]; return c && c.tag === 8 ? cpUtf8(parsed.cp, c.strIndex) : null }
  if (mref && mref.owner === SCF_CLS) {
    return { kind: 'concat', recipe: strArg(0), consts: bsm.args.slice(1).map((_, i) => strArg(i + 1)) }
  }
  const impl = resolveLambdaImpl(parsed, bsmIndex)
  return { kind: impl ? 'lambda' : 'other', impl }
}

const RETURN_OPS = new Set([0xac, 0xad, 0xae, 0xaf, 0xb0])
function isBinaryArith (op) { return op >= 0x60 && op <= 0x83 && !(op >= 0x74 && op <= 0x77) }

// visit(row, index, recv, args, stmtRows) is called at every invoke row with
// the symbolic receiver/arguments (before the call's result is pushed)
function symbolicWalk (parsed, method, visit) {
  let rows
  try { rows = decodeInstructions(method.code, parsed.cp) } catch { return [] }
  const locals = new Map()
  let stack = []
  let stmtStart = 0
  const pop = (n) => {
    if (!stack) return new Array(n).fill(null)
    if (stack.length < n) { stack = null; return new Array(n).fill(null) }
    return stack.splice(stack.length - n, n)
  }
  const push = (v) => { if (stack) stack.push(v) }
  const poison = () => { stack = null }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const op = r.op
    if (op === 0x00) continue
    else if (op === 0x01 || (op >= 0x02 && op <= 0x0f) || op === 0x10 || op === 0x11 || op === 0x14) push(r.int !== undefined ? { k: 'int', v: r.int } : { k: 'const' })
    else if (op === 0x12 || op === 0x13) push(r.str !== undefined ? { k: 'str', v: r.str } : r.cls ? { k: 'cls', cls: r.cls } : r.int !== undefined ? { k: 'int', v: r.int } : { k: 'const' })
    else if (r.aload !== undefined) push(locals.get(r.aload) ?? { k: 'param', n: r.aload })
    else if ((op >= 0x15 && op <= 0x18) || (op >= 0x1a && op <= 0x29)) push({ k: 'val' })
    else if (op === 0x32) { const [arr] = pop(2); push({ k: 'elem', arr }) /* aaload */ } else if (op >= 0x2e && op <= 0x35) { pop(2); push({ k: 'val' }) } else if (r.astore !== undefined) { const [v] = pop(1); locals.set(r.astore, v) } else if ((op >= 0x36 && op <= 0x39) || (op >= 0x3b && op <= 0x4a)) pop(1)
    else if (op >= 0x4f && op <= 0x56) pop(3)
    else if (op === 0x57) pop(1)
    else if (op === 0x58) pop(2)
    else if (op === 0x59) { const [v] = pop(1); push(v); push(v) } else if (op === 0x5a) { const [b, a] = pop(2); push(a); push(b); push(a) } else if (op === 0x5f) { const [b, a] = pop(2); push(a); push(b) } else if (op === 0x5b || op === 0x5c || op === 0x5d || op === 0x5e) poison()
    else if (isBinaryArith(op) || (op >= 0x94 && op <= 0x98)) { pop(2); push({ k: 'val' }) } else if ((op >= 0x74 && op <= 0x77) || op === 0x84 || (op >= 0x85 && op <= 0x93) || op === 0xc0) { /* unary / iinc / conversions / checkcast: no net change */ } else if ((op >= 0x99 && op <= 0x9e) || op === 0xc6 || op === 0xc7 || op === 0xaa || op === 0xab) pop(1)
    else if (op >= 0x9f && op <= 0xa6) pop(2)
    else if (op === 0xa7 || op === 0xc8 || op === 0xb1) { /* goto / return void */ } else if (RETURN_OPS.has(op)) pop(1)
    else if (op === 0xb2) push({ k: 'field', ref: r.ref })
    else if (op === 0xb3) pop(1)
    else if (op === 0xb4) { const [recv] = pop(1); push({ k: 'ifield', ref: r.ref, recv }) } else if (op === 0xb5) pop(2)
    else if (op >= 0xb6 && op <= 0xb9) {
      if (!r.ref) { poison(); continue }
      const n = descParamTypes(r.ref.desc).length
      const args = pop(n)
      const recv = op === 0xb8 ? null : pop(1)[0]
      visit(r, i, recv, args, rows.slice(stmtStart, i))
      if (!r.ref.desc.endsWith(')V')) push({ k: 'call', ref: r.ref, recv, args })
    } else if (op === 0xba) {
      if (!r.samDesc) { poison(); continue }
      const captures = pop(descParamTypes(r.samDesc).length)
      push({ k: 'indy', bsmIndex: r.bsmIndex, samName: r.samName, captures, parsed })
    } else if (op === 0xbb) push({ k: 'new', cls: r.cls })
    else if (op === 0xbc || op === 0xbd) { pop(1); push({ k: 'arr', cls: r.cls }) } else if (op === 0xbe || op === 0xc1) { pop(1); push({ k: 'val' }) } else if (op === 0xc2 || op === 0xc3) pop(1)
    else poison() // wide / multianewarray / jsr / athrow / anything else
    // statement boundaries: an empty (or poisoned, now reset) stack after a
    // consuming instruction
    const ends = op === 0xb3 || op === 0xb5 || op === 0x57 || op === 0x58 || r.astore !== undefined ||
      (op >= 0x36 && op <= 0x4e) || RETURN_OPS.has(op) || op === 0xb1 || op === 0xa7 || op === 0xc8 ||
      (op >= 0x99 && op <= 0xa6) || op === 0xc6 || op === 0xc7 || op === 0xbf
    if (ends) { if (!stack) stack = []; if (stack.length === 0) stmtStart = i + 1 } else if (stack && stack.length === 0) stmtStart = i + 1
  }
  return rows
}

// the class of an enum iterated by `for (E e : E.values())`: the element of
// an array produced by E.values()
function enumOfSym (sym, universe) {
  if (!sym || sym.k !== 'elem' || !sym.arr || sym.arr.k !== 'call' || !sym.arr.ref) return null
  const ref = sym.arr.ref
  if (ref.name !== 'values' || !ref.desc.startsWith('()[L') || !ref.desc.endsWith(';')) return null
  const en = ref.desc.slice(4, -1)
  if (ref.owner !== en || !universe.has(en)) return null
  const p = universe.get(en)
  return p && p.superName === 'java/lang/Enum' ? en : null
}

// the ordered enum constants of E (the <clinit> putstatic order) with the
// string an accessor returns for each: a getter of a field the constructor
// stores from a String parameter (the value is that constant's literal
// argument), or Enum.name() (optionally case-folded). null = not derivable.
function enumConstantStrings (en, accessorRef, universe, ctx) {
  const memoKey = `${en}#${accessorRef.owner}#${accessorRef.name}${accessorRef.desc}`
  if (ctx.enumStrings.has(memoKey)) return ctx.enumStrings.get(memoKey)
  let out = null
  try { out = deriveEnumConstantStrings(en, accessorRef, universe) } catch { out = null }
  ctx.enumStrings.set(memoKey, out)
  return out
}

function deriveEnumConstantStrings (en, accessorRef, universe) {
  const p = universe.get(en)
  if (!p) return null
  const enumFields = new Set(p.fields.filter((f) => f.desc === `L${en};` && (f.flags & 0x4000)).map((f) => f.name))
  const clinit = p.codes.find((m) => m.method === '<clinit>')
  if (!clinit) return null
  const consts = [] // {field, strs} in putstatic order
  for (const stmt of statements(decodeInstructions(clinit.code, p.cp))) {
    const put = stmt[stmt.length - 1]
    if (!put.ref || put.ref.owner !== en || !enumFields.has(put.ref.name)) continue
    if (stmt.some((r) => r.target !== undefined)) return null
    consts.push({ field: put.ref.name, strs: stmt.filter((r) => r.str !== undefined).map((r) => r.str), ctorDesc: [...stmt].reverse().find((r) => r.op === 0xb7 && r.ref && r.ref.name === '<init>' && r.ref.owner === en)?.ref.desc })
  }
  if (consts.length !== enumFields.size) return null
  // the accessor body
  let mode = null
  if (accessorRef.owner === 'java/lang/Enum' && accessorRef.name === 'name') mode = { name: true, fold: null }
  else {
    const m = universeMethod(universe, accessorRef.owner, accessorRef.name, accessorRef.desc)
    if (!m) return null
    const body = m.rows.filter((r) => r.op !== 0x00)
    if (body.length === 3 && body[0].aload === 0 && body[1].op === 0xb4 && body[1].ref && body[1].ref.owner === en && body[2].op === 0xb0) {
      mode = { field: body[1].ref.name }
    } else if (body.length >= 3 && body[0].aload === 0 && body[1].op === 0xb6 && body[1].ref && body[1].ref.name === 'name' && body[1].ref.desc === '()Ljava/lang/String;' && body[body.length - 1].op === 0xb0) {
      const mid = body.slice(2, -1)
      const fold = mid.find((r) => r.op === 0xb6 && r.ref && r.ref.owner === STRING_CLS && (r.ref.name === 'toLowerCase' || r.ref.name === 'toUpperCase'))
      if (mid.some((r) => !(r.op === 0xb2 || (r.op === 0xb6 && r.ref && r.ref.owner === STRING_CLS)))) return null
      mode = { name: true, fold: fold ? fold.ref.name : null }
    } else return null
  }
  if (mode.name) {
    const names = []
    for (const c of consts) {
      if (c.strs[0] !== c.field) return null // javac passes the constant's own name first
      names.push(mode.fold === 'toLowerCase' ? c.field.toLowerCase() : mode.fold === 'toUpperCase' ? c.field.toUpperCase() : c.field)
    }
    return names
  }
  // field mode: which String parameter does the constructor store into it?
  const ctorDesc = consts[0].ctorDesc
  if (!ctorDesc || consts.some((c) => c.ctorDesc !== ctorDesc)) return null
  const init = universeMethod(universe, en, '<init>', ctorDesc)
  if (!init) return null
  let slot = null
  for (let i = 1; i < init.rows.length; i++) {
    const r = init.rows[i]
    if (r.op === 0xb5 && r.ref && r.ref.owner === en && r.ref.name === mode.field) {
      const prev = init.rows[i - 1]
      if (prev.aload === undefined || prev.aload === 0) return null
      slot = prev.aload
      break
    }
  }
  if (slot == null) return null
  const params = descParamTypes(ctorDesc)
  let s = 1
  let stringOrdinal = -1
  let hit = null
  params.forEach((t) => {
    if (t === STR_DESC) stringOrdinal++
    if (s === slot) hit = t === STR_DESC ? stringOrdinal : null
    s += (t === 'J' || t === 'D') ? 2 : 1
  })
  if (hit == null) return null
  const stringParams = params.filter((t) => t === STR_DESC).length
  const names = []
  for (const c of consts) {
    if (c.strs.length !== stringParams) return null // a non-literal String argument: not derivable
    names.push(c.strs[hit])
  }
  return names
}

// the registry NAME(S) a symbolic value stands for: one literal, or the
// ordered list an enum-loop recipe expands to. null = not derivable.
function nameValuesOf (sym, universe, ctx, depth = 0) {
  if (!sym || depth > 6) return null
  if (sym.k === 'str') return [sym.v]
  if (sym.k === 'indy') {
    const info = indyInfo(sym.parsed, sym.bsmIndex)
    if (!info || info.kind !== 'concat' || info.recipe == null) return null
    const parts = sym.captures.map((c) => nameValuesOf(c, universe, ctx, depth + 1))
    if (parts.some((x) => !x)) return null
    const pieces = []
    let ai = 0
    let ci = 0
    let lit = ''
    for (const ch of info.recipe) {
      if (ch === '' || ch === '') {
        if (lit) { pieces.push(lit); lit = '' }
        if (ch === '') { if (ai >= parts.length) return null; pieces.push(parts[ai++]) } else { const c = info.consts[ci++]; if (c == null) return null; pieces.push(c) }
      } else lit += ch
    }
    if (lit) pieces.push(lit)
    if (ai !== parts.length) return null
    const varying = pieces.filter((x) => Array.isArray(x) && x.length > 1)
    if (varying.length > 1) return null
    const n = varying.length ? varying[0].length : 1
    const out = []
    for (let c = 0; c < n; c++) out.push(pieces.map((x) => typeof x === 'string' ? x : (x.length === 1 ? x[0] : x[c])).join(''))
    return out
  }
  if (sym.k === 'call' && sym.ref) {
    const ref = sym.ref
    if (ref.owner === STRING_CLS && (ref.name === 'toLowerCase' || ref.name === 'toUpperCase') && retDesc(ref.desc) === STR_DESC) {
      const inner = nameValuesOf(sym.recv, universe, ctx, depth + 1)
      return inner ? inner.map((s) => ref.name === 'toLowerCase' ? s.toLowerCase() : s.toUpperCase()) : null
    }
    if (ref.desc === '()Ljava/lang/String;' && sym.recv) {
      const en = enumOfSym(sym.recv, universe)
      if (en) return enumConstantStrings(en, ref, universe, ctx)
    }
  }
  return null
}

// the block FACTORY a symbolic value stands for: {cls, ctorDesc, factoryRows}
// from a Class::new handle, a lambda whose body constructs a block, a `new`,
// or a static producer returning a block-typed value (one hop). null = none.
function factoryOfSym (sym, parsed, universe, vocab) {
  if (!sym) return null
  if (sym.k === 'indy') {
    const info = indyInfo(sym.parsed, sym.bsmIndex)
    if (!info || info.kind !== 'lambda') return null
    return factoryFromImpl(info.impl, sym.parsed, universe, vocab)
  }
  if (sym.k === 'new') return chainReachesBlock(sym.cls, universe, vocab) ? { cls: sym.cls, ctorDesc: null, factoryRows: null } : null
  if (sym.k === 'call' && sym.ref && sym.ref.desc.startsWith('(')) {
    const rd = retDesc(sym.ref.desc)
    if (!rd || !chainReachesBlock(rd.slice(1, -1), universe, vocab)) return null
    const body = universeMethod(universe, sym.ref.owner, sym.ref.name, sym.ref.desc)
    if (!body) return null
    const n = body.rows.find((r) => r.op === 0xbb && r.cls && chainReachesBlock(r.cls, universe, vocab))
    return n ? { cls: n.cls, ctorDesc: invokedCtorDesc(n.cls, body.rows), factoryRows: body.rows } : null
  }
  return null
}

// modid of a DeferredRegister: the last string literal of the clinit
// statement that creates the field the register call reads (memoized over
// the universe; a registrar class with exactly one register is its own
// fallback)
function drModidOf (fieldKey, universe, ctx) {
  if (ctx.drModids.has(fieldKey)) return ctx.drModids.get(fieldKey)
  let out = null
  const [owner] = fieldKey.split('#')
  const body = universeMethod(universe, owner, '<clinit>', '()V')
  if (body) {
    for (const stmt of statements(body.rows)) {
      const put = stmt[stmt.length - 1]
      if (!put.ref || `${put.ref.owner}#${put.ref.name}` !== fieldKey || put.ref.desc !== `L${DR_CLS};`) continue
      const hasCreate = stmt.some((r) => r.op === 0xb8 && r.ref && r.ref.owner === DR_CLS && r.ref.name === 'create')
      if (!hasCreate) continue
      const strs = stmt.filter((r) => r.str !== undefined).map((r) => r.str)
      if (strs.length) out = strs[strs.length - 1]
      break
    }
  }
  ctx.drModids.set(fieldKey, out)
  return out
}

function drModidOfSym (recv, parsed, universe, ctx) {
  if (recv && recv.k === 'field' && recv.ref && recv.ref.desc === `L${DR_CLS};`) {
    const m = drModidOf(`${recv.ref.owner}#${recv.ref.name}`, universe, ctx)
    if (m) return m
  }
  // fallback: the class creates exactly one DeferredRegister
  const keys = []
  for (const f of parsed.fields) if (f.desc === `L${DR_CLS};`) keys.push(`${parsed.className}#${f.name}`)
  const modids = [...new Set(keys.map((k) => drModidOf(k, universe, ctx)).filter(Boolean))]
  return modids.length === 1 ? modids[0] : null
}

function isDrRegister (r) {
  return r.op === 0xb6 && r.ref && r.ref.owner === DR_CLS && r.ref.name === 'register' && r.ref.desc === DR_REGISTER_DESC
}

// registration SITES of one method: every matching call whose name(s) and
// factory resolve. Sites inside a loop (a backward branch spans them) whose
// name lists share a length are emitted CONSTANT-MAJOR - the order the loop
// body actually registers in (name_<c> then other_<c> for each c).
function collectSites (parsed, method, universe, vocab, ctx, matcher, argsOf) {
  const sites = []
  const rows = symbolicWalk(parsed, method, (r, i, recv, args, stmtRows) => {
    if (!matcher(r)) return
    const picked = argsOf(r, recv, args, stmtRows)
    if (!picked) return
    const names = nameValuesOf(picked.nameSym, universe, ctx)
    if (!names || !names.length) return
    const fac = factoryOfSym(picked.factorySym, parsed, universe, vocab)
    if (!fac) return
    sites.push({ pc: r.pc, names, fac, modid: picked.modid, stmtRows })
  })
  if (!sites.length) return []
  const loops = rows.filter((r) => r.target !== undefined && r.target <= r.pc).map((r) => ({ start: r.target, end: r.pc }))
  const regionOf = (pc) => {
    let best = null
    for (const l of loops) if (pc >= l.start && pc <= l.end && (!best || (l.end - l.start) < (best.end - best.start))) best = l
    return best
  }
  const out = []
  const done = new Set()
  for (const s of sites) {
    if (done.has(s)) continue
    const region = regionOf(s.pc)
    const group = region ? sites.filter((x) => regionOf(x.pc) === region) : [s]
    for (const g of group) done.add(g)
    const n = group[0].names.length
    const uniform = group.every((g) => g.names.length === n)
    if (uniform) {
      for (let c = 0; c < n; c++) for (const g of group) out.push({ name: g.names[c], site: g })
    } else {
      for (const g of group) for (const nm of g.names) out.push({ name: nm, site: g })
    }
  }
  return out
}

function pushRegistration (out, name, site, vocab) {
  const { fac, modid, stmtRows } = site
  if (!modid || !name || name.includes(':') || name.includes(' ')) return
  out.push({
    name: `${modid}:${name}`,
    cls: fac.cls,
    supplierRows: fac.factoryRows ?? stmtRows,
    era: vocab.era,
    ctorDesc: fac.ctorDesc ?? invokedCtorDesc(fac.cls, stmtRows)
  })
}

// ---------------------------------------------------------------------------
// registration extraction (Forge DeferredRegister): every DR.register call
// in any method of the class whose name resolves - a literal, or an
// enum-loop recipe (HF58b)
function forgeRegistrations (parsed, universe, vocab, out, ctx) {
  for (const method of parsed.codes) {
    const emitted = collectSites(parsed, method, universe, vocab, ctx, isDrRegister, (r, recv, args) => {
      const modid = drModidOfSym(recv, parsed, universe, ctx)
      return modid ? { nameSym: args[0], factorySym: args[1], modid } : null
    })
    for (const e of emitted) pushRegistration(out, e.name, e.site, vocab)
  }
}

// HF58b: a mod's OWN registration helper - a static method whose body calls
// DR.register with one of its own String parameters as the name (directly,
// or by forwarding to such a helper). Returns {owner, name, desc, nameParam,
// modid} or null.
function drHelperSignature (parsed, method, universe, ctx, known) {
  if (!(method.flags & 0x0008)) return null
  const slots = paramSlotsOf(method.desc)
  let found = null
  symbolicWalk(parsed, method, (r, i, recv, args) => {
    if (found) return
    let nameSym = null
    let modid = null
    if (isDrRegister(r)) {
      nameSym = args[0]
      modid = drModidOfSym(recv, parsed, universe, ctx)
    } else {
      const h = r.op === 0xb8 && r.ref ? known.get(`${r.ref.owner}#${r.ref.name}#${r.ref.desc}`) : null
      if (!h) return
      nameSym = args[h.nameParam]
      modid = h.modid
    }
    if (!modid || !nameSym || nameSym.k !== 'param') return
    const ps = slots.get(nameSym.n)
    if (!ps || ps.type !== STR_DESC) return
    found = { owner: parsed.className, name: method.method, desc: method.desc, nameParam: ps.index, modid }
  })
  return found
}

// call sites of a DR helper across one parsed class: the name argument
// resolves like any registration (literal or loop recipe), the factory is
// whichever argument stands for a block factory
function drHelperCallSites (parsed, helper, universe, vocab, out, ctx) {
  const isHelperCall = (r) => r.op === 0xb8 && r.ref &&
    r.ref.owner === helper.owner && r.ref.name === helper.name && r.ref.desc === helper.desc
  for (const method of parsed.codes) {
    if (parsed.className === helper.owner && method.method === helper.name && method.desc === helper.desc) continue
    const emitted = collectSites(parsed, method, universe, vocab, ctx, isHelperCall, (r, recv, args) => {
      const factorySym = args.find((a, i) => i !== helper.nameParam && factoryOfSym(a, parsed, universe, vocab))
      return factorySym ? { nameSym: args[helper.nameParam], factorySym, modid: helper.modid } : null
    })
    for (const e of emitted) pushRegistration(out, e.name, e.site, vocab)
  }
}

const REGISTRY_NAME_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/

// a call that produces a ResourceLocation: its constructor, or any static
// factory ON the ResourceLocation class (covers every version's of()/parse()
// without knowing their era names)
function isRlProducer (r, vocab) {
  if (!r.ref || r.ref.owner !== vocab.cn.resourceLocation) return false
  if (r.op === 0xb7 && r.ref.name === '<init>') return true
  return r.op === 0xb8 && retDesc(r.ref.desc) === `L${vocab.cn.resourceLocation};`
}

function isRegisterCall (r, vocab) {
  return (r.op === 0xb8 || r.op === 0xb6 || r.op === 0xb9) && r.ref &&
    r.ref.owner === vocab.cn.registry && vocab.registerNames.has(r.ref.name)
}

// derive a registry name from the strings visible in a window (either
// ['ns','path'] feeding an RL producer, or one 'ns:path' string), with an
// optional helper-provided constant namespace
function nameFromWindow (strs, nsConst) {
  if (nsConst != null) {
    const path = strs.length ? strs[strs.length - 1] : null
    if (path && !path.includes(':')) return `${nsConst}:${path}`
    if (path && REGISTRY_NAME_RE.test(path)) return path
    return null
  }
  const s = strs.slice(-2)
  if (s.length === 2 && !s[0].includes(':') && !s[1].includes(':')) return `${s[0]}:${s[1]}`
  if (s.length >= 1 && s[s.length - 1].includes(':')) return s[s.length - 1]
  return null
}

// Statement-aligned windows: a registration's evidence must come from ITS
// OWN statement, never a neighbor's (a noCollission call in the previous
// registration must not leak). javac ends registration statements with
// putstatic (field assignment), pop (discarded return), or the consuming
// call itself.
function forEachStatementWindow (rows, vocab, isTarget, visit) {
  let winStart = 0
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const boundary = r.op === 0xb3 || r.op === 0x57 || isRegisterCall(r, vocab) || isTarget(r)
    if (isTarget(r)) visit(rows.slice(winStart, i), r)
    if (boundary) winStart = i + 1
  }
}

// Direct Fabric registrations: Registry.register(reg, id, new Block...) in
// any method, value NEW in the same statement window.
function fabricDirectRegistrations (parsed, universe, vocab, out) {
  for (const method of parsed.codes) {
    const rows = decodeInstructions(method.code, parsed.cp)
    forEachStatementWindow(rows, vocab, (r) => isRegisterCall(r, vocab), (win) => {
      let cls = null
      for (let j = win.length - 1; j >= 0; j--) {
        if (win[j].op === 0xbb && win[j].cls && chainReachesBlock(win[j].cls, universe, vocab)) { cls = win[j].cls; break }
      }
      if (!cls) return
      const name = nameFromWindow(win.filter((w) => w.str !== undefined).map((w) => w.str), null)
      if (!name || !REGISTRY_NAME_RE.test(name)) return
      out.push({ name, cls, supplierRows: win, era: vocab.era })
    })
  }
}

// Helper-pattern detection: a STATIC method whose body Registry.register()s a
// PARAMETER (the dominant Fabric idiom - registerBlock(String, Block) with a
// constant namespace). Returns {owner, name, desc, nsConst} or null.
function fabricHelperSignature (parsed, method, vocab) {
  if (!(method.flags & 0x0008)) return null // static helpers only
  const rows = decodeInstructions(method.code, parsed.cp)
  for (let i = 0; i < rows.length; i++) {
    if (!isRegisterCall(rows[i], vocab)) continue
    // the registered value must load a parameter right before the call
    const prev = rows[i - 1]
    if (!prev || prev.aload === undefined) return null
    // namespace: [ldc ns][aload path] feeding an RL producer earlier in body
    let nsConst = null
    for (let j = 0; j < i; j++) {
      if (isRlProducer(rows[j], vocab)) {
        const a = rows[j - 1]
        const b = rows[j - 2]
        if (a && a.aload !== undefined && b && b.str !== undefined) nsConst = b.str
        break
      }
    }
    return { owner: parsed.className, name: method.method, desc: method.desc, nsConst }
  }
  return null
}

// call sites of a registration helper, across the given parsed class
function fabricHelperCallSites (parsed, helper, universe, vocab, out) {
  const isHelperCall = (r) => r.op === 0xb8 && r.ref &&
    r.ref.owner === helper.owner && r.ref.name === helper.name && r.ref.desc === helper.desc
  for (const method of parsed.codes) {
    if (parsed.className === helper.owner && method.method === helper.name && method.desc === helper.desc) continue
    const rows = decodeInstructions(method.code, parsed.cp)
    forEachStatementWindow(rows, vocab, isHelperCall, (win) => {
      let cls = null
      for (let j = win.length - 1; j >= 0; j--) {
        if (win[j].op === 0xbb && win[j].cls && chainReachesBlock(win[j].cls, universe, vocab)) { cls = win[j].cls; break }
      }
      if (!cls) return
      const name = nameFromWindow(win.filter((w) => w.str !== undefined).map((w) => w.str), helper.nsConst)
      if (!name || !REGISTRY_NAME_RE.test(name)) return
      out.push({ name, cls, supplierRows: win, era: vocab.era })
    })
  }
}

// ---------------------------------------------------------------------------
// Registrate framework (com.tterrag.registrate - Create and friends):
// registrations are fluent builder chains  REGISTRATE.block("name", Cls::new)
// .initialProperties(sup).properties(p -> ...)...register()  where the name,
// the factory and the Properties evidence all sit in bytecode reachable from
// the statement window. Everything here is FRAMEWORK vocabulary (the
// com.tterrag.registrate class names) - never per-mod.
const RG_PKG = 'com/tterrag/registrate/'
const RG_BB = RG_PKG + 'builders/BlockBuilder'
const RG_BUILDER = RG_PKG + 'builders/Builder'
const RG_ABS = RG_PKG + 'AbstractRegistrate'
const RG_ENTRY_RET_RE = /\)Lcom\/tterrag\/registrate\/util\/entry\/[A-Za-z]*Entry;$/
const STR_DESC = 'Ljava/lang/String;'

function isRegistrateType (cls, universe) {
  return cls === RG_ABS || chainReachesClass(cls, RG_ABS, universe)
}

// modid of a registrate-instance FIELD: chase the clinit statement assigning
// it - either a creation call taking a String modid and returning a
// registrate type, or a no-arg static getter returning one (follow the
// getter to the field it reads). Bounded, memoized.
function registrateFieldModid (fieldKey, universe, ctx, hops = 0) {
  if (ctx.fieldModids.has(fieldKey)) return ctx.fieldModids.get(fieldKey)
  ctx.fieldModids.set(fieldKey, null) // cycle guard
  const scanStmt = (stmt) => {
    let lastStr = null
    for (const r of stmt) {
      if (r.str !== undefined) { lastStr = r.str; continue }
      if (!(r.op >= 0xb6 && r.op <= 0xb9) || !r.ref) continue
      const rd = retDesc(r.ref.desc)
      const created = (rd && r.ref.desc.includes(STR_DESC) && isRegistrateType(rd.slice(1, -1), universe)) ||
        (r.op === 0xb7 && r.ref.name === '<init>' && r.ref.desc.includes(STR_DESC) && isRegistrateType(r.ref.owner, universe))
      if (created && lastStr != null) return lastStr
      if (r.op === 0xb8 && r.ref.desc.startsWith('()') && rd && isRegistrateType(rd.slice(1, -1), universe)) {
        const g = universeMethod(universe, r.ref.owner, r.ref.name, r.ref.desc)
        if (g) {
          for (let i = g.rows.length - 1; i >= 0; i--) {
            const gr = g.rows[i]
            if (gr.op === 0xb2 && gr.ref && gr.ref.desc.startsWith('L') && isRegistrateType(gr.ref.desc.slice(1, -1), universe)) {
              const viaGetter = registrateFieldModid(`${gr.ref.owner}#${gr.ref.name}`, universe, ctx, hops + 1)
              if (viaGetter != null) return viaGetter
              break
            }
          }
        }
      }
    }
    return null
  }
  let out = null
  const [owner] = fieldKey.split('#')
  const body = universeMethod(universe, owner, '<clinit>', '()V')
  if (body && hops < 4) {
    for (const stmt of statements(body.rows)) {
      const put = stmt[stmt.length - 1]
      if (!put.ref || `${put.ref.owner}#${put.ref.name}` !== fieldKey) continue
      out = scanStmt(stmt)
      if (out != null) break
    }
  }
  ctx.fieldModids.set(fieldKey, out)
  return out
}

// jar-universe-wide (registrate SUBTYPE -> Set<modid>) creation bindings, for
// registrations whose receiver is not a chaseable field (helper params). Only
// an UNambiguous subtype binding is usable; the framework types themselves
// never bind.
function registrateTypeModid (type, universe, ctx) {
  if (!type || type.startsWith(RG_PKG)) return null
  const set = ctx.typeModids.get(type)
  return set && set.size === 1 ? [...set][0] : null
}

function collectRegistrateCreations (parsed, universe, ctx) {
  for (const m of parsed.codes) {
    let rows
    try { rows = decodeInstructions(m.code, parsed.cp) } catch { continue }
    let lastStr = null
    for (const r of rows) {
      if (r.str !== undefined) { lastStr = r.str; continue }
      if (!(r.op >= 0xb6 && r.op <= 0xb9) || !r.ref || lastStr == null) continue
      const rd = retDesc(r.ref.desc)
      let type = null
      if (rd && r.ref.desc.includes(STR_DESC) && isRegistrateType(rd.slice(1, -1), universe)) type = rd.slice(1, -1)
      else if (r.op === 0xb7 && r.ref.name === '<init>' && r.ref.desc.includes(STR_DESC) && isRegistrateType(r.ref.owner, universe)) type = r.ref.owner
      if (type && !type.startsWith(RG_PKG)) {
        if (!ctx.typeModids.has(type)) ctx.typeModids.set(type, new Set())
        ctx.typeModids.get(type).add(lastStr)
      }
    }
  }
}

// resolve a lambda/method-handle impl to a block factory: the constructed
// block class, its invoked-ctor descriptor, and the factory body rows (for
// the fresh-Properties guard). Class::new handles carry the ctor desc
// directly.
function factoryFromImpl (impl, parsed, universe, vocab) {
  if (!impl) return null
  if (impl.refKind === 8) {
    if (!chainReachesBlock(impl.owner, universe, vocab)) return null
    return { cls: impl.owner, ctorDesc: impl.desc, factoryRows: null }
  }
  const home = impl.owner === parsed.className ? parsed : (universe.has(impl.owner) ? universe.get(impl.owner) : null)
  if (!home) return null
  const m = home.codes.find((c) => c.method === impl.name && c.desc === impl.desc)
  if (!m) return null
  let rows
  try { rows = decodeInstructions(m.code, home.cp) } catch { return null }
  let cls = null
  for (const r of rows) {
    if (r.op === 0xbb && r.cls && chainReachesBlock(r.cls, universe, vocab)) cls = r.cls
  }
  if (!cls) return null
  return { cls, ctorDesc: invokedCtorDesc(cls, rows), factoryRows: rows }
}

// initialProperties(...) supplier -> the copied vanilla block's registry
// name, following at most one hop through a static universe method that
// returns a vanilla Blocks field (the SharedProperties.stone() idiom).
// Returns {copy: name} | {unknown: true}.
function registrateBaseFromImpl (impl, parsed, universe, vocab) {
  if (!impl) return { unknown: true }
  const seek = (rows) => {
    let field = null
    let call = null
    for (const r of rows) {
      if (r.op === 0xb2 && r.ref && r.ref.owner === vocab.cn.blocks) field = r.ref.name
      else if (r.op === 0xb8 && r.ref && retDesc(r.ref.desc)) call = r.ref
    }
    return { field, call }
  }
  const home = impl.owner === parsed.className ? parsed : (universe.has(impl.owner) ? universe.get(impl.owner) : null)
  const m = home && home.codes.find((c) => c.method === impl.name && c.desc === impl.desc)
  if (!m) return { unknown: true }
  let rows
  try { rows = decodeInstructions(m.code, home.cp) } catch { return { unknown: true } }
  let { field, call } = seek(rows)
  if (!field && call) {
    const hop = universeMethod(universe, call.owner, call.name, call.desc)
    if (hop) field = seek(hop.rows).field
  }
  if (field && vocab.ns.blocksFieldToName[field]) return { copy: vocab.ns.blocksFieldToName[field] }
  return { unknown: true }
}

// walk a builder-chain row range, folding Properties evidence into ev
function registrateChainEvidence (rows, from, parsed, universe, vocab, ev) {
  let lastIndy = null
  for (let i = from; i < rows.length; i++) {
    const r = rows[i]
    if (r.op === 0xba) { lastIndy = r; continue }
    if (!(r.op >= 0xb6 && r.op <= 0xb9) || !r.ref) continue
    if (r.ref.owner === RG_BB || r.ref.owner === RG_BUILDER) {
      if (r.ref.name === 'initialProperties') {
        ev.baseCount++
        const impl = lastIndy ? resolveLambdaImpl(parsed, lastIndy.bsmIndex) : null
        const base = impl ? registrateBaseFromImpl(impl, parsed, universe, vocab) : { unknown: true }
        ev.base = base
        if (base.unknown) ev.opaque = true
      } else if (r.ref.name === 'properties') {
        const impl = lastIndy ? resolveLambdaImpl(parsed, lastIndy.bsmIndex) : null
        let scanned = false
        if (impl) {
          const home = impl.owner === parsed.className ? parsed : (universe.has(impl.owner) ? universe.get(impl.owner) : null)
          const m = home && home.codes.find((c) => c.method === impl.name && c.desc === impl.desc)
          if (m) {
            try {
              const s = propsSignals(decodeInstructions(m.code, home.cp), vocab)
              ev.noColl = ev.noColl || s.noColl
              scanned = true
            } catch { }
          }
        }
        if (!scanned) ev.opaque = true
      } else if (r.ref.name === 'transform') {
        ev.opaque = true
      } else if (r.ref.name === 'register' && r.ref.owner === RG_BB) {
        ev.registered = true
      }
      lastIndy = null
    }
  }
}

// resolve the mint (builder-producing) call of one window: name, receiver
// modid source, factory. Descends once into a universe helper body when the
// factory is not visible at the call site (WindowGen/paletteStoneBlock
// idioms).
function registrateResolveMint (rows, mintIdx, parsed, universe, vocab, ev, depth) {
  const mint = rows[mintIdx]
  // name from the call site (never overridden by helper bodies)
  if (ev.name == null && mint.ref.desc.includes(STR_DESC)) {
    for (let j = mintIdx - 1; j >= 0; j--) {
      if (rows[j].str !== undefined) { ev.name = rows[j].str; break }
    }
  }
  if (ev.name == null && !mint.ref.desc.includes(STR_DESC)) {
    // fluid/object idiom: the name was bound by an earlier chain call that
    // produced this receiver (e.g. standardFluid("honey", ...))
    for (let j = mintIdx - 1; j >= 0; j--) {
      const r = rows[j]
      if (!(r.op >= 0xb6 && r.op <= 0xb9) || !r.ref || !r.ref.desc.includes(STR_DESC)) continue
      const rd = retDesc(r.ref.desc)
      if (!rd) continue
      const rt = rd.slice(1, -1)
      if (rt === mint.ref.owner || isRegistrateType(rt, universe) || rt.startsWith(RG_PKG)) {
        for (let k = j - 1; k >= 0; k--) {
          if (rows[k].str !== undefined) { ev.name = rows[k].str; break }
        }
        break
      }
    }
  }
  // receiver -> modid source
  if (!ev.registrateField && !ev.receiverType) {
    for (let j = mintIdx - 1; j >= 0; j--) {
      const r = rows[j]
      if (r.op === 0xb2 && r.ref && r.ref.desc.startsWith('L') && isRegistrateType(r.ref.desc.slice(1, -1), universe)) {
        ev.registrateField = `${r.ref.owner}#${r.ref.name}`
        break
      }
    }
    if (!ev.registrateField) {
      if (isRegistrateType(parsed.className, universe)) ev.receiverType = parsed.className
      else if (isRegistrateType(mint.ref.owner, universe) && !mint.ref.owner.startsWith(RG_PKG)) ev.receiverType = mint.ref.owner
    }
  }
  // factory: nearest invokedynamic before the mint
  if (!ev.cls) {
    for (let j = mintIdx - 1; j >= 0; j--) {
      const r = rows[j]
      if (r.op === 0xba) {
        const f = factoryFromImpl(resolveLambdaImpl(parsed, r.bsmIndex), parsed, universe, vocab)
        if (f) { ev.cls = f.cls; ev.ctorDesc = f.ctorDesc; ev.factoryRows = f.factoryRows }
        break
      }
    }
  }
  // descend once into a non-framework universe helper body for the factory
  // and the in-helper chain evidence
  if (!ev.cls && depth < 2 && !mint.ref.owner.startsWith(RG_PKG)) {
    const body = universeMethod(universe, mint.ref.owner, mint.ref.name, mint.ref.desc)
    if (body) {
      const owner = universe.get(mint.ref.owner)
      for (let i = 0; i < body.rows.length; i++) {
        const r = body.rows[i]
        if (!(r.op >= 0xb6 && r.op <= 0xb9) || !r.ref || r.ref.owner === RG_BB || r.ref.owner === RG_BUILDER) continue
        const rd = retDesc(r.ref.desc)
        if (rd === `L${RG_BB};`) {
          registrateResolveMint(body.rows, i, owner, universe, vocab, ev, depth + 1)
          registrateChainEvidence(body.rows, i + 1, owner, universe, vocab, ev)
          break
        }
      }
    }
  }
}

function registrateWindow (win, parsed, universe, vocab, out, ctx) {
  let mintIdx = -1
  for (let i = 0; i < win.length; i++) {
    const r = win[i]
    if (!(r.op >= 0xb6 && r.op <= 0xb9) || !r.ref || r.ref.owner === RG_BB || r.ref.owner === RG_BUILDER) continue
    if (r.ref.owner.startsWith(RG_PKG + 'util/')) continue
    const rd = retDesc(r.ref.desc)
    if (rd === `L${RG_BB};` || (RG_ENTRY_RET_RE.test(r.ref.desc) && r.ref.desc.includes(STR_DESC) && universe.has(r.ref.owner))) {
      mintIdx = i
      break
    }
  }
  if (mintIdx < 0) return
  const ev = {
    name: null, cls: null, ctorDesc: null, factoryRows: null, base: null, baseCount: 0, noColl: false, opaque: false, registered: false, registrateField: null, receiverType: null
  }
  registrateResolveMint(win, mintIdx, parsed, universe, vocab, ev, 0)
  registrateChainEvidence(win, mintIdx + 1, parsed, universe, vocab, ev)
  if (!ev.name || !ev.cls || ev.name.includes(':') || !/^[a-z0-9_./-]+$/.test(ev.name)) return
  let modid = ev.registrateField ? registrateFieldModid(ev.registrateField, universe, ctx) : null
  if (!modid && ev.receiverType) modid = registrateTypeModid(ev.receiverType, universe, ctx)
  if (!modid) return
  out.push({ name: `${modid}:${ev.name}`, cls: ev.cls, supplierRows: null, era: vocab.era, ctorDesc: ev.ctorDesc, registrate: ev })
}

function registrateRegistrations (parsed, universe, vocab, out, ctx) {
  if (parsed.className.startsWith(RG_PKG)) return
  for (const method of parsed.codes) {
    let rows
    try { rows = decodeInstructions(method.code, parsed.cp) } catch { continue }
    let winStart = 0
    for (let i = 0; i < rows.length; i++) {
      const op = rows[i].op
      if (op === 0xb3 || op === 0x57 || (op >= 0xac && op <= 0xb1) || op === 0xbf) {
        const win = rows.slice(winStart, i)
        winStart = i + 1
        if (win.some((r) => r.ref && (r.ref.owner === RG_BB || (retDesc(r.ref.desc || '') === `L${RG_BB};`)))) {
          try { registrateWindow(win, parsed, universe, vocab, out, ctx) } catch { }
        }
      }
    }
  }
}

// verdict for a registrate builder chain. noCollission applied by ANY
// properties operator is irreversible in the vanilla Properties API, so it
// survives opaque transforms; base-copy evidence does not (a transform can
// replace initialProperties wholesale).
function registrateSolidity (reg, universe, vocab) {
  const ev = reg.registrate
  const ctorSig = reg.ctorDesc ? ctorChainSignals(reg.cls, reg.ctorDesc, universe, vocab) : null
  const ctorFresh = !!(ctorSig && ctorSig.fresh)
  const factorySig = ev.factoryRows ? propsSignals(ev.factoryRows, vocab) : null
  const factoryFresh = !!(factorySig && (factorySig.of || factorySig.copyOther || factorySig.copyVanillaField))
  let nonsolidWhy = null
  if (ctorSig && ctorSig.noColl) nonsolidWhy = 'Properties.noCollission (invoked ctor chain)'
  else if (factorySig && factorySig.noColl && !ctorFresh) nonsolidWhy = 'Properties.noCollission (factory body)'
  else if (ev.noColl && !ctorFresh && !factoryFresh) nonsolidWhy = 'Properties.noCollission (builder properties op)'
  else if (ev.base && ev.base.copy && vocab.vanillaNonSolid.has(ev.base.copy) && !ev.opaque && ev.baseCount === 1 && !ctorFresh && !factoryFresh) nonsolidWhy = `Properties.copy(${ev.base.copy}) (initialProperties)`
  if (nonsolidWhy) {
    if (collisionOverrideOnChain(reg.cls, universe, vocab)) return { shape: 'abstain', why: 'noCollission but getCollisionShape override on chain' }
    return { shape: 'nonsolid', why: nonsolidWhy }
  }
  if (ev.noColl || (factorySig && factorySig.noColl) || (ev.base && ev.base.copy && vocab.vanillaNonSolid.has(ev.base.copy))) {
    return { shape: 'abstain', why: 'nonsolid evidence not provable through the invoked ctor/factory' }
  }
  if (ev.base && ev.base.copy) return { shape: 'solid', why: `Properties.copy(${ev.base.copy}) with collision` }
  if (ev.baseCount === 0) return { shape: 'solid', why: 'Registrate default Properties.of() with collision' }
  return { shape: 'abstain', why: 'no properties signal' }
}

// ---------------------------------------------------------------------------
// Const-namespace consumer-helper idiom (Biomes O' Plenty and other
// platform-abstraction mods): a STATIC helper takes a registration sink
// (BiConsumer/Consumer), a Block and a String, builds
// `new ResourceLocation(<const-ns>, nameParam)` and hands the Block param to
// the sink. Call sites carry `new <BlockCls>(<Properties chain>)` (or a
// one-hop static producer) plus the LDC name. Mechanism-level: the helper is
// detected structurally, never by mod identity.
function descParamTypes (desc) {
  const m = desc.match(/^\(([^)]*)\)/)
  if (!m) return []
  const out = []
  let s = m[1]
  while (s.length) {
    let i = 0
    while (s[i] === '[') i++
    if (s[i] === 'L') {
      const j = s.indexOf(';', i)
      out.push(s.slice(0, j + 1))
      s = s.slice(j + 1)
    } else {
      out.push(s.slice(0, i + 1))
      s = s.slice(i + 1)
    }
  }
  return out
}

function consumerHelperSignature (parsed, method, vocab, universe) {
  if (!(method.flags & 0x0008)) return null // static only
  const params = descParamTypes(method.desc)
  const blockParam = params.find((d) => d.startsWith('L') && chainReachesBlock(d.slice(1, -1), universe, vocab))
  if (!blockParam || !params.includes(STR_DESC)) return null
  let rows
  try { rows = decodeInstructions(method.code, parsed.cp) } catch { return null }
  let nsConst = null
  let rlAt = -1
  for (let j = 0; j < rows.length; j++) {
    if (isRlProducer(rows[j], vocab)) {
      const a = rows[j - 1]
      const b = rows[j - 2]
      if (a && a.aload !== undefined && b && b.str !== undefined) { nsConst = b.str; rlAt = j }
      break
    }
  }
  if (nsConst == null) return null
  // the Block param must feed an invocation after the RL is built (the sink)
  const sunk = rows.some((r, i) => i > rlAt && (r.op === 0xb9 || r.op === 0xb6 || r.op === 0xb8) && r.ref &&
    rows.slice(Math.max(0, i - 3), i).some((p) => p.aload !== undefined))
  if (!sunk) return null
  return { owner: parsed.className, name: method.method, desc: method.desc, nsConst }
}

// call-site windows of a const-namespace helper: value = NEW in window or a
// one-hop static producer method returning a block-typed value
function consumerHelperCallSites (parsed, helper, universe, vocab, out) {
  const isHelperCall = (r) => r.op === 0xb8 && r.ref &&
    r.ref.owner === helper.owner && r.ref.name === helper.name && r.ref.desc === helper.desc
  for (const method of parsed.codes) {
    if (parsed.className === helper.owner && method.method === helper.name && method.desc === helper.desc) continue
    let rows
    try { rows = decodeInstructions(method.code, parsed.cp) } catch { continue }
    forEachStatementWindow(rows, vocab, isHelperCall, (win) => {
      let cls = null
      let evidenceRows = win
      let ctorDesc = null
      for (let j = win.length - 1; j >= 0; j--) {
        if (win[j].op === 0xbb && win[j].cls && chainReachesBlock(win[j].cls, universe, vocab)) { cls = win[j].cls; break }
      }
      if (cls) {
        ctorDesc = invokedCtorDesc(cls, win)
      } else {
        // one-hop producer: static call returning a block-typed value
        for (let j = win.length - 1; j >= 0; j--) {
          const r = win[j]
          if (r.op !== 0xb8 || !r.ref) continue
          const rd = retDesc(r.ref.desc)
          if (!rd || !chainReachesBlock(rd.slice(1, -1), universe, vocab)) continue
          const body = universeMethod(universe, r.ref.owner, r.ref.name, r.ref.desc)
          if (!body) break
          for (const br of body.rows) {
            if (br.op === 0xbb && br.cls && chainReachesBlock(br.cls, universe, vocab)) cls = br.cls
          }
          if (cls) {
            ctorDesc = invokedCtorDesc(cls, body.rows)
            evidenceRows = win.concat(body.rows)
          }
          break
        }
      }
      if (!cls) return
      const name = nameFromWindow(win.filter((w) => w.str !== undefined).map((w) => w.str), helper.nsConst)
      if (!name || !REGISTRY_NAME_RE.test(name)) return
      out.push({ name, cls, supplierRows: evidenceRows, era: vocab.era, ctorDesc })
    })
  }
}

// ---------------------------------------------------------------------------
/**
 * Derive modded block shapes from the local instance's jars.
 *
 * @param {Array.<string>} jarPaths - mod jar file paths (top level; nested
 *   jar-in-jar entries are discovered automatically)
 * @returns {{ blocks: Map<string, {shape: string, stateCount: ?number,
 *   cls: string, why: string}>, stats: Object }}
 */
function deriveBlockShapes (jarPaths) {
  const t0 = Date.now()
  const universe = buildUniverse(jarPaths)
  const regs = []
  const stats = { jars: jarPaths.length, units: universe.units.length, regClasses: 0, registrations: 0, nonsolid: 0, solid: 0, abstain: 0, counted: 0 }
  const interRegistry = VOCABS.intermediary.cn.registry
  const fabricHelpers = new Map() // 'owner#name#desc' -> helper signature
  const consumerHelpers = new Map() // 'owner#name#desc' -> {helper, vocab}
  const rgCtx = { fieldModids: new Map(), typeModids: new Map() }
  const rgClasses = [] // registrate registration candidates (second sweep so modid creation bindings exist first)
  const ctx = { enumStrings: new Map(), drModids: new Map() } // HF58b: memo for the enum-loop / helper registrars
  const drRegClasses = [] // HF58b: DeferredRegister-referencing classes (helper signatures need every class parsed first)
  const drHelpers = new Map() // 'owner#name#desc' -> {helper, vocab}
  const rgBytes = Buffer.from(RG_PKG)
  const rgBbBytes = Buffer.from(RG_BB)
  const funcBytes = Buffer.from('java/util/function/')
  const rlBytes = [VOCABS.srg.cn.resourceLocation, VOCABS.intermediary.cn.resourceLocation]
    .filter(Boolean).map((s) => Buffer.from(s))
  for (const unit of universe.units) {
    for (const [cls, entry] of unit.classes) {
      let raw
      try { raw = zipEntryData(unit.buf, entry) } catch { continue }
      const isForgeReg = raw.includes(DR_CLS)
      const isFabricReg = interRegistry && raw.includes(interRegistry)
      const isRegistrate = raw.includes(rgBytes)
      const isConsumerCand = raw.includes(funcBytes) && rlBytes.some((b) => raw.includes(b))
      if (!isForgeReg && !isFabricReg && !isRegistrate && !isConsumerCand) continue
      let parsed
      try { parsed = parseClassFile(raw) } catch { continue }
      if (!parsed) continue
      const era = universe.eraOf(cls, parsed) ?? (isFabricReg ? 'intermediary' : 'srg')
      const vocab = VOCABS[era] || VOCABS.srg
      if (isForgeReg || isFabricReg || isRegistrate) stats.regClasses++
      try {
        if (isForgeReg) { forgeRegistrations(parsed, universe, vocab, regs, ctx); drRegClasses.push({ parsed, vocab }) }
        if (isFabricReg) {
          fabricDirectRegistrations(parsed, universe, vocab, regs)
          for (const m of parsed.codes) {
            const h = fabricHelperSignature(parsed, m, vocab)
            if (h) fabricHelpers.set(`${h.owner}#${h.name}#${h.desc}`, h)
          }
        }
        if (isRegistrate) {
          collectRegistrateCreations(parsed, universe, rgCtx)
          if (raw.includes(rgBbBytes)) rgClasses.push({ parsed, vocab })
        }
        if (isConsumerCand) {
          for (const m of parsed.codes) {
            const h = consumerHelperSignature(parsed, m, vocab, universe)
            if (h) {
              const key = `${h.owner}#${h.name}#${h.desc}`
              if (!fabricHelpers.has(key)) consumerHelpers.set(key, { helper: h, vocab })
            }
          }
        }
      } catch (err) {
        debug(`shape scan: registration extraction failed in ${cls}: ${err.message}`)
      }
    }
  }
  // HF58b: the mods' own DeferredRegister helpers (two rounds: a helper
  // that forwards its name parameter to another helper resolves once the
  // target is known)
  for (let round = 0; round < 2; round++) {
    for (const { parsed, vocab } of drRegClasses) {
      for (const m of parsed.codes) {
        const key = `${parsed.className}#${m.method}#${m.desc}`
        if (drHelpers.has(key)) continue
        let h = null
        try { h = drHelperSignature(parsed, m, universe, ctx, new Map([...drHelpers].map(([k, v]) => [k, v.helper]))) } catch { h = null }
        if (h) drHelpers.set(key, { helper: h, vocab })
      }
    }
  }
  // registrate registrations (after creation bindings are collected)
  for (const { parsed, vocab } of rgClasses) {
    try {
      registrateRegistrations(parsed, universe, vocab, regs, rgCtx)
    } catch (err) {
      debug(`shape scan: registrate extraction failed in ${parsed.className}: ${err.message}`)
    }
  }
  // second pass: call sites of registration helpers (the caller classes need
  // not reference the Registry/sink classes themselves)
  const helperPasses = [
    ...[...fabricHelpers.values()].map((h) => ({ helper: h, vocab: VOCABS.intermediary, sites: fabricHelperCallSites })),
    ...[...consumerHelpers.values()].map((e) => ({ helper: e.helper, vocab: e.vocab, sites: consumerHelperCallSites })),
    ...[...drHelpers.values()].map((e) => ({ helper: e.helper, vocab: e.vocab, sites: (p, h, u, v, o) => drHelperCallSites(p, h, u, v, o, ctx) }))
  ]
  for (const { helper, vocab, sites } of helperPasses) {
    const ownerBytes = Buffer.from(helper.owner)
    for (const unit of universe.units) {
      for (const [cls, entry] of unit.classes) {
        let raw
        try { raw = zipEntryData(unit.buf, entry) } catch { continue }
        if (!raw.includes(ownerBytes)) continue
        let parsed
        try { parsed = parseClassFile(raw) } catch { continue }
        if (!parsed) continue
        try {
          sites(parsed, helper, universe, vocab, regs)
        } catch (err) {
          debug(`shape scan: helper call-site extraction failed in ${cls}: ${err.message}`)
        }
      }
    }
  }
  const blocks = new Map()
  const regCls = new Map() // name -> cls of the entry we kept
  for (const reg of regs) {
    if (blocks.has(reg.name)) {
      // duplicate registration of one name: identical class = double
      // extraction of the same chain (keep it); differing class = genuinely
      // ambiguous evidence => abstain
      if (regCls.get(reg.name) !== reg.cls) {
        blocks.set(reg.name, { shape: 'abstain', stateCount: null, stateIndex: null, witness: 'unknown', cls: reg.cls, why: 'duplicate registration' })
      }
      continue
    }
    regCls.set(reg.name, reg.cls)
    // HF58b: the BLOCK class's own era decides the vocabulary its state
    // definition is read with (a registrar and its blocks can differ only
    // in a mixed jar; the registrar's era is the fallback)
    const clsParsed = universe.has(reg.cls) ? universe.get(reg.cls) : null
    const clsEra = clsParsed ? universe.eraOf(reg.cls, clsParsed) : null
    const vocab = VOCABS[clsEra] || VOCABS[reg.era]
    let entry
    try {
      const sol = reg.registrate
        ? registrateSolidity(reg, universe, vocab)
        : solidityOf(reg.cls, reg.supplierRows, universe, vocab, reg.ctorDesc)
      const idx = stateIndexOf(reg.cls, universe, vocab)
      entry = {
        shape: sol.shape,
        stateCount: idx ? idx.count : null,
        stateIndex: idx && idx.props ? { props: idx.props } : null,
        witness: idx ? 'bytecode' : 'unknown',
        era: vocab.era,
        cls: reg.cls,
        why: sol.why
      }
    } catch (err) {
      entry = { shape: 'abstain', stateCount: null, stateIndex: null, witness: 'unknown', cls: reg.cls, why: `derivation error: ${err.message}` }
    }
    blocks.set(reg.name, entry)
  }
  stats.registrations = blocks.size
  for (const b of blocks.values()) {
    stats[b.shape] = (stats[b.shape] ?? 0) + 1
    if (b.stateCount != null) stats.counted++
    if (b.stateIndex) stats.indexed = (stats.indexed ?? 0) + 1
  }
  stats.ms = Date.now() - t0
  debug(`shape scan: ${stats.registrations} blocks from ${stats.units} jar units in ${stats.ms}ms ` +
    `(${stats.nonsolid} nonsolid, ${stats.solid} solid, ${stats.abstain} abstain, ${stats.counted} state-counted)`)
  return { blocks, stats }
}

module.exports = { deriveBlockShapes, decodeStateIndex, _internal: { buildUniverse, eraOfClass, VOCABS, chainOf, stateCountOf, stateIndexOf, solidityOf, ctorChainSignals, symbolicWalk, nameValuesOf } }
