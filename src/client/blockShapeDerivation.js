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
    // field may be inherited from a mod superclass
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
      propKeys.push(...v.props)
      if (!v.callsSuper) break
    }
    if (vocab.ns.hierarchy[c] === undefined) {
      // unknown ancestor: its contributions are unknowable
      return c === 'java/lang/Object' ? product(propKeys, universe, vocab) : null
    }
    c = vocab.ns.hierarchy[c]
  }
  return product(propKeys, universe, vocab)
}

function product (propKeys, universe, vocab) {
  let n = 1
  for (const pk of propKeys) {
    const card = propCardOf(pk, universe, vocab)
    if (card == null) return null
    n *= card
  }
  return n
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

function solidityOf (cls, supplierRows, universe, vocab) {
  // signals from the supplier body plus every mod constructor on the chain
  const sig = propsSignals(supplierRows || [], vocab)
  const { chain } = chainOf(cls, universe, vocab)
  for (const c of chain) {
    if (!universe.has(c)) break
    const p = universe.get(c)
    if (!p) break
    for (const m of p.codes) {
      if (m.method !== '<init>') continue
      const s = propsSignals(decodeInstructions(m.code, p.cp), vocab)
      sig.noColl = sig.noColl || s.noColl
      if (!sig.copyVanillaField && s.copyVanillaField) sig.copyVanillaField = s.copyVanillaField
    }
  }
  const provenNonSolid = sig.noColl ||
    (sig.copyVanillaField != null && vocab.vanillaNonSolid.has(sig.copyVanillaField))
  if (provenNonSolid) {
    if (collisionOverrideOnChain(cls, universe, vocab)) return { shape: 'abstain', why: 'noCollission but getCollisionShape override on chain' }
    return { shape: 'nonsolid', why: sig.noColl ? 'Properties.noCollission' : `Properties.copy(${sig.copyVanillaField})` }
  }
  if (sig.copyVanillaField != null) return { shape: 'solid', why: `Properties.copy(${sig.copyVanillaField}) with collision` }
  if (sig.of) return { shape: 'solid', why: 'Properties.of() with collision' }
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
      if (impl.refKind === 8) { // Class::new
        cls = impl.owner
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
      out.push({ name: `${modid}:${lastStr}`, cls, supplierRows, era: vocab.era })
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
  for (const unit of universe.units) {
    for (const [cls, entry] of unit.classes) {
      let raw
      try { raw = zipEntryData(unit.buf, entry) } catch { continue }
      const isForgeReg = raw.includes(DR_CLS)
      const isFabricReg = interRegistry && raw.includes(interRegistry)
      if (!isForgeReg && !isFabricReg) continue
      let parsed
      try { parsed = parseClassFile(raw) } catch { continue }
      if (!parsed) continue
      const era = eraOfClass(parsed) ?? (isForgeReg ? 'srg' : 'intermediary')
      const vocab = VOCABS[era]
      stats.regClasses++
      try {
        if (isForgeReg) forgeRegistrations(parsed, universe, vocab, regs)
        if (isFabricReg) {
          fabricDirectRegistrations(parsed, universe, vocab, regs)
          for (const m of parsed.codes) {
            const h = fabricHelperSignature(parsed, m, vocab)
            if (h) fabricHelpers.set(`${h.owner}#${h.name}#${h.desc}`, h)
          }
        }
      } catch (err) {
        debug(`shape scan: registration extraction failed in ${cls}: ${err.message}`)
      }
    }
  }
  // second pass: call sites of the Fabric registration helpers (the caller
  // classes need not reference the Registry class themselves)
  if (fabricHelpers.size) {
    const vocab = VOCABS.intermediary
    for (const helper of fabricHelpers.values()) {
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
            fabricHelperCallSites(parsed, helper, universe, vocab, regs)
          } catch (err) {
            debug(`shape scan: helper call-site extraction failed in ${cls}: ${err.message}`)
          }
        }
      }
    }
  }
  const blocks = new Map()
  for (const reg of regs) {
    if (blocks.has(reg.name)) {
      // duplicate registration of one name: ambiguous evidence => abstain
      blocks.set(reg.name, { shape: 'abstain', stateCount: null, cls: reg.cls, why: 'duplicate registration' })
      continue
    }
    const vocab = VOCABS[reg.era]
    let entry
    try {
      const sol = solidityOf(reg.cls, reg.supplierRows, universe, vocab)
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

module.exports = { deriveBlockShapes, _internal: { buildUniverse, eraOfClass, VOCABS, chainOf, stateCountOf, solidityOf } }
