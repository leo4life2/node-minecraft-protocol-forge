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
// NeoForge 1.20.5+ jars (full mojmap member names) are not yet in the tables:
// those jars derive nothing and every block abstains (honest degradation).

const fs = require('fs')
const {
  zipCentralEntries, zipEntryData, parseClassFile, decodeInstructions, resolveLambdaImpl
} = require('./jarAnalysis')
const debug = require('debug')('minecraft-protocol-forge')

const TABLES = require('./data/blockShapeTables.json')

const NESTED_JAR_RE = /^META-INF\/(?:jars|jarjar)\/[^/]+\.jar$/
const MAX_NESTED_DEPTH = 2
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
    propsCopy: ns.ids.propsCopy,
    registerNames: new Set((ns.ids.registryRegister || []).map((r) => r.name)),
    // the base-implementation owner is not an "override": collision there
    // respects the hasCollision flag the noCollission signal proves.
    overridesCollision: new Set(ns.overridesCollision.filter((c) => c !== cn.behaviour)),
    vanillaNonSolid: new Set(TABLES.vanillaNonSolid)
  }
}
const VOCABS = { srg: eraVocab('srg'), intermediary: eraVocab('intermediary') }

// ---------------------------------------------------------------------------
// class universe across all jars (top-level + nested), lazy parse
function buildUniverse (jarPaths) {
  const units = [] // {source, buf, entries: Map<clsName, entry>}
  const addUnit = (buf, source, depth) => {
    let entries
    try { entries = zipCentralEntries(buf) } catch { return }
    const classes = new Map()
    for (const e of entries) {
      if (e.name.endsWith('.class')) {
        const cls = e.name.slice(0, -6)
        if (!classes.has(cls)) classes.set(cls, e)
      } else if (depth < MAX_NESTED_DEPTH && NESTED_JAR_RE.test(e.name)) {
        try { addUnit(zipEntryData(buf, e), `${source}!${e.name}`, depth + 1) } catch { /* unreadable nested jar */ }
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
  return {
    units,
    has: (cls) => where.has(cls),
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

// era of one class file: intermediary if it references intermediary-mapped
// vanilla classes, srg if it references mojmap-named vanilla classes.
function eraOfClass (parsed) {
  let sawIntermediary = false
  let sawMojmap = false
  for (const c of parsed.cp) {
    if (!c || c.tag !== 1 || typeof c.str !== 'string') continue
    if (c.str.startsWith('net/minecraft/class_')) sawIntermediary = true
    else if (c.str.startsWith('net/minecraft/world/') || c.str.startsWith('net/minecraft/core/')) sawMojmap = true
  }
  if (sawIntermediary) return 'intermediary'
  if (sawMojmap) return 'srg'
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
// Returns {card} | {aliasTo: 'owner#field'} | null (unknown => abstain).
function classifyModPropertyStatement (stmt, vocab, universe) {
  if (stmt.some((r) => r.target !== undefined)) return null // branches: not a straight-line definition
  const creates = stmt.filter((r) => (r.op === 0xb8 || r.op === 0xb6) && r.ref &&
    vocab.propDescs.has(retDesc(r.ref.desc)))
  if (creates.length === 0) {
    const aliases = stmt.filter((r) => r.op === 0xb2 && r.ref && vocab.propDescs.has(r.ref.desc))
    if (aliases.length) {
      const a = aliases[aliases.length - 1].ref
      return { aliasTo: `${a.owner}#${a.name}` }
    }
    return null
  }
  const create = creates[creates.length - 1]
  const d = create.ref.desc
  if (d.startsWith('(Ljava/lang/String;II)')) {
    const ints = stmt.filter((r) => r.int !== undefined).map((r) => r.int)
    const [lo, hi] = ints.slice(-2)
    return hi !== undefined ? { card: hi - lo + 1 } : null
  }
  if (d.startsWith('(Ljava/lang/String;)')) {
    return { card: retDesc(d) === `L${vocab.cn.propDirection};` ? 6 : 2 }
  }
  if (d.startsWith('(Ljava/lang/String;Ljava/lang/Class;)')) {
    const clsRow = [...stmt].reverse().find((r) => (r.op === 0x12 || r.op === 0x13) && r.cls)
    if (!clsRow) return null
    const n = enumConstCount(clsRow.cls, universe, vocab)
    return n ? { card: n } : null
  }
  const aastores = stmt.filter((r) => r.op === 0x53).length
  if (aastores > 0) return { card: aastores }
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

// resolve a property field reference to a cardinality (mod fields chase their
// clinit definition; vanilla fields hit the table, walking the declaring
// hierarchy because javac may qualify inherited statics with the subclass)
function propCardOf (propKey, universe, vocab, seen = new Set()) {
  if (seen.has(propKey)) return null
  seen.add(propKey)
  const direct = vanillaPropCard(propKey, vocab)
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
        if (c.card != null) return c.card
        if (c.aliasTo) return propCardOf(c.aliasTo, universe, vocab, seen)
        return null
      }
    }
    // field may be inherited: JVM resolution order is the class itself,
    // then superinterfaces (interface constants - the Create
    // ProperWaterloggedBlock.WATERLOGGED idiom), then the superclass
    for (const iface of p.interfaces || []) {
      const viaIface = propCardOf(`${iface}#${field}`, universe, vocab, seen)
      if (viaIface != null) return viaIface
    }
    if (p.superName) return propCardOf(`${p.superName}#${field}`, universe, vocab, seen)
    return null
  }
  return null
}

function vanillaPropCard (propKey, vocab) {
  const hit = vocab.ns.propCard[propKey]
  if (hit && hit.card != null) return hit.card
  let [owner, field] = propKey.split('#')
  while (vocab.ns.hierarchy[owner] !== undefined) {
    owner = vocab.ns.hierarchy[owner]
    if (owner == null) break
    const h = vocab.ns.propCard[`${owner}#${field}`]
    if (h && h.card != null) return h.card
  }
  return null
}

// ---------------------------------------------------------------------------
// state count: effective createBlockStateDefinition contributions over the
// chain (mod bodies parsed with abstain-on-any-branch discipline; vanilla
// classes from the generated table, including its dynamic/abstain flags)
function modCbsdContrib (parsed, vocab) {
  const m = parsed.codes.find((c) => vocab.cbsdNames.has(c.method) && c.desc === vocab.builderDesc)
  if (!m) return null // does not define it
  const rows = decodeInstructions(m.code, parsed.cp)
  const props = []
  let dynamic = false
  let callsSuper = false
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (r.target !== undefined) dynamic = true // ANY branch in a mod body
    else if (r.op === 0xba) dynamic = true
    else if (r.op === 0xb2 && r.ref && vocab.propDescs.has(r.ref.desc)) props.push(`${r.ref.owner}#${r.ref.name}`)
    else if (r.op === 0xb2 && r.ref && r.ref.desc.startsWith('[') && vocab.propDescs.has(r.ref.desc.slice(1))) dynamic = true
    else if (r.op === 0xb9 && r.ref && /^java\/util\//.test(r.ref.owner)) dynamic = true
    else if ((r.op === 0xb6 || r.op === 0xb7 || r.op === 0xb8) && r.ref && vocab.propDescs.has(retDesc(r.ref.desc))) dynamic = true
    if (r.op === 0xb7 && r.ref && vocab.cbsdNames.has(r.ref.name) && r.ref.desc === vocab.builderDesc) {
      callsSuper = true
      dynamic = dynamic || false
    }
  }
  // the super call itself is an invokespecial to a props-returning..? no: void.
  return { props, callsSuper, dynamic }
}

function stateCountOf (cls, universe, vocab) {
  const propKeys = []
  let factor = 1 // solved whole-body contributions of loop-driven vanilla classes
  let c = cls
  let cap = 24
  while (c && cap-- > 0) {
    if (universe.has(c)) {
      const p = universe.get(c)
      if (!p) return null
      const contrib = modCbsdContrib(p, vocab)
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
      if (v.contribFactor != null) factor *= v.contribFactor
      propKeys.push(...v.props)
      if (!v.callsSuper) break
    }
    if (vocab.ns.hierarchy[c] === undefined) {
      // unknown ancestor: its contributions are unknowable
      return c === 'java/lang/Object' ? product(propKeys, factor, universe, vocab) : null
    }
    c = vocab.ns.hierarchy[c]
  }
  return product(propKeys, factor, universe, vocab)
}

function product (propKeys, factor, universe, vocab) {
  let n = factor
  for (const pk of propKeys) {
    const card = propCardOf(pk, universe, vocab)
    if (card == null) return null
    n *= card
  }
  return n
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
      else if (r.ref.name === vocab.propsCopy) {
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
// registration extraction
function forgeRegistrations (parsed, universe, vocab, out) {
  const clinit = parsed.codes.find((m) => m.method === '<clinit>')
  if (!clinit) return
  const rows = decodeInstructions(clinit.code, parsed.cp)
  // modid per DeferredRegister field
  const drModid = new Map()
  for (const stmt of statements(rows)) {
    const put = stmt[stmt.length - 1]
    if (!put.ref || put.ref.desc !== `L${DR_CLS};`) continue
    const hasCreate = stmt.some((r) => r.op === 0xb8 && r.ref && r.ref.owner === DR_CLS && r.ref.name === 'create')
    if (!hasCreate) continue
    const strs = stmt.filter((r) => r.str !== undefined).map((r) => r.str)
    if (strs.length) drModid.set(`${put.ref.owner}#${put.ref.name}`, strs[strs.length - 1])
  }
  let lastStr = null
  let lastIndy = null
  let lastDr = null
  for (const r of rows) {
    if (r.str !== undefined) lastStr = r.str
    else if (r.op === 0xba) lastIndy = r
    else if (r.op === 0xb2 && r.ref && r.ref.desc === `L${DR_CLS};`) lastDr = `${r.ref.owner}#${r.ref.name}`
    else if (r.op === 0xb6 && r.ref && r.ref.owner === DR_CLS && r.ref.name === 'register' && r.ref.desc === DR_REGISTER_DESC) {
      if (lastStr == null || lastIndy == null) continue
      const impl = resolveLambdaImpl(parsed, lastIndy.bsmIndex)
      if (!impl) continue
      let cls = null
      let supplierRows = null
      let ctorDesc = null
      if (impl.refKind === 8) { // Class::new - the handle desc IS the invoked ctor
        cls = impl.owner
        ctorDesc = impl.desc
      } else {
        const implOwner = impl.owner === parsed.className ? parsed : universe.get(impl.owner)
        const body = implOwner && implOwner.codes.find((m) => m.method === impl.name && m.desc === impl.desc)
        if (!body) continue
        supplierRows = decodeInstructions(body.code, implOwner.cp)
        for (const b of supplierRows) {
          if (b.op === 0xbb && b.cls && chainReachesBlock(b.cls, universe, vocab)) { cls = b.cls; break }
        }
      }
      if (!cls || !chainReachesBlock(cls, universe, vocab)) continue
      const modid = drModid.get(lastDr) ?? (drModid.size === 1 ? [...drModid.values()][0] : null)
      if (!modid) continue
      out.push({ name: `${modid}:${lastStr}`, cls, supplierRows, era: vocab.era, ctorDesc })
    }
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
      const era = eraOfClass(parsed) ?? (isFabricReg ? 'intermediary' : 'srg')
      const vocab = VOCABS[era]
      if (isForgeReg || isFabricReg || isRegistrate) stats.regClasses++
      try {
        if (isForgeReg) forgeRegistrations(parsed, universe, vocab, regs)
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
    ...[...consumerHelpers.values()].map((e) => ({ helper: e.helper, vocab: e.vocab, sites: consumerHelperCallSites }))
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
        blocks.set(reg.name, { shape: 'abstain', stateCount: null, cls: reg.cls, why: 'duplicate registration' })
      }
      continue
    }
    regCls.set(reg.name, reg.cls)
    const vocab = VOCABS[reg.era]
    let entry
    try {
      const sol = reg.registrate
        ? registrateSolidity(reg, universe, vocab)
        : solidityOf(reg.cls, reg.supplierRows, universe, vocab, reg.ctorDesc)
      const stateCount = stateCountOf(reg.cls, universe, vocab)
      entry = { shape: sol.shape, stateCount, cls: reg.cls, why: sol.why }
    } catch (err) {
      entry = { shape: 'abstain', stateCount: null, cls: reg.cls, why: `derivation error: ${err.message}` }
    }
    blocks.set(reg.name, entry)
  }
  stats.registrations = blocks.size
  for (const b of blocks.values()) {
    stats[b.shape] = (stats[b.shape] ?? 0) + 1
    if (b.stateCount != null) stats.counted++
  }
  stats.ms = Date.now() - t0
  debug(`shape scan: ${stats.registrations} blocks from ${stats.units} jar units in ${stats.ms}ms ` +
    `(${stats.nonsolid} nonsolid, ${stats.solid} solid, ${stats.abstain} abstain, ${stats.counted} state-counted)`)
  return { blocks, stats }
}

module.exports = { deriveBlockShapes, _internal: { buildUniverse, eraOfClass, VOCABS, chainOf, stateCountOf, solidityOf, ctorChainSignals } }
