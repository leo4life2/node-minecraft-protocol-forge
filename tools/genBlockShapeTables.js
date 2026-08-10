'use strict'

// GENERATOR (dev-time only, never shipped in the runtime path) for
// src/client/data/blockShapeTables.json — the mapping-era vocabulary the
// block-shape derivation (src/client/blockShapeDerivation.js) uses to read
// MOD jars: vanilla block-class hierarchy, per-class state-definition
// property contributions, property-constant cardinalities, Blocks
// field->registry-name, and the era-specific identifier names
// (createBlockStateDefinition / Properties.noCollission / property create
// methods / Registry.register), in TWO namespaces:
//   srg           - mojmap class names + SRG member names (Forge 1.17-1.20.1
//                   mod jars reference exactly this namespace)
//   intermediary  - Fabric runtime namespace (class_/method_/field_)
//
// NOTHING in the emitted file is hand-written: every entry is extracted from
// the REAL Forge-deobfuscated (srg) server jar's bytecode with the same
// pure-JS class parser the runtime uses, member/class names are translated
// srg->obf->intermediary through the REAL mcp_config joined.tsrg and Fabric
// intermediary tiny-v2 mappings, and property cardinalities that bytecode
// cannot prove (predicate-based enum subsets) are SOLVED against
// minecraft-data's per-block state counts. The generator refuses to emit
// unless it can re-derive the state count of EVERY vanilla block exactly
// (the 1003/1003 self-test) — that self-test is what validates the
// derivation rules (property parsing, alias chains, super-call semantics,
// hierarchy walk) at scale before any mod jar is ever read.
//
// Usage:
//   node tools/genBlockShapeTables.js \
//     --srg-jar <server-...-srg.jar> --tsrg <joined.tsrg> \
//     --tiny <intermediary mappings.tiny> --mc-data <node_modules/minecraft-data> \
//     --mc-version 1.20.1 --out src/client/data/blockShapeTables.json

const fs = require('fs')
const path = require('path')
const {
  zipCentralEntries, zipEntryData, parseClassFile, decodeInstructions
} = require('../src/client/jarAnalysis')

// ---------------------------------------------------------------------------
function parseArgs () {
  const a = process.argv.slice(2)
  const out = {}
  for (let i = 0; i < a.length; i += 2) out[a[i].replace(/^--/, '')] = a[i + 1]
  for (const k of ['srg-jar', 'tsrg', 'tiny', 'mojmap', 'mc-data', 'mc-version', 'out']) {
    if (!out[k]) { console.error(`missing --${k}`); process.exit(2) }
  }
  return out
}

// -- lazy class index over a jar --------------------------------------------
function jarIndex (jarPath) {
  const buf = fs.readFileSync(jarPath)
  const entries = new Map()
  for (const e of zipCentralEntries(buf)) {
    if (e.name.endsWith('.class')) entries.set(e.name.slice(0, -6), e)
  }
  const parsed = new Map()
  return {
    classNames: [...entries.keys()],
    get (cls) {
      if (parsed.has(cls)) return parsed.get(cls)
      const e = entries.get(cls)
      let p = null
      if (e) { try { p = parseClassFile(zipEntryData(buf, e)) } catch { p = null } }
      parsed.set(cls, p)
      return p
    }
  }
}

const P = 'net/minecraft/world/level/block/state/properties/'
const PROP_TYPES = new Set([
  `L${P}IntegerProperty;`, `L${P}BooleanProperty;`, `L${P}EnumProperty;`,
  `L${P}DirectionProperty;`, `L${P}Property;`
])
const BUILDER_DESC = '(Lnet/minecraft/world/level/block/state/StateDefinition$Builder;)V'
const PROPS_CLS = 'net/minecraft/world/level/block/state/BlockBehaviour$Properties'
const BEHAVIOUR_CLS = 'net/minecraft/world/level/block/state/BlockBehaviour'
const BLOCK_CLS = 'net/minecraft/world/level/block/Block'
const BLOCKS_CLS = 'net/minecraft/world/level/block/Blocks'

function isPropDesc (desc) { return PROP_TYPES.has(desc) }
function key (owner, name) { return `${owner}#${name}` }

// -- statement segmentation: rows between PUTSTATICs ------------------------
function statements (rows) {
  const stmts = []
  let cur = []
  for (const r of rows) {
    cur.push(r)
    if (r.op === 0xb3) { stmts.push(cur); cur = [] } // putstatic ends a statement
  }
  return stmts
}

// Classify one clinit statement that ends in `putstatic <property field>`.
function classifyPropertyStatement (stmt) {
  const put = stmt[stmt.length - 1]
  const creates = stmt.filter((r) => r.op === 0xb8 && r.ref && r.ref.owner.startsWith(P))
  if (creates.length === 0) {
    // alias: last getstatic of a property-typed field
    const aliases = stmt.filter((r) => r.op === 0xb2 && r.ref && isPropDesc(r.ref.desc))
    if (aliases.length) return { kind: 'alias', to: aliases[aliases.length - 1].ref, put }
    return { kind: 'unknown', put }
  }
  const create = creates[creates.length - 1]
  const name = [...stmt].reverse().find((r) => r.str !== undefined)?.str ?? null
  const d = create.ref.desc
  if (d.startsWith('(Ljava/lang/String;II)')) {
    const ints = stmt.filter((r) => r.int !== undefined).map((r) => r.int)
    const [lo, hi] = ints.slice(-2)
    if (hi !== undefined) return { kind: 'value', name, card: hi - lo + 1, put }
    return { kind: 'unknown', name, put }
  }
  if (d.startsWith('(Ljava/lang/String;)')) {
    // BooleanProperty.create(name) => 2; DirectionProperty.create(name) => all 6
    const card = d.endsWith(`L${P}DirectionProperty;`) ? 6 : 2
    return { kind: 'value', name, card, put }
  }
  if (d.startsWith('(Ljava/lang/String;Ljava/lang/Class;)')) {
    const clsRow = [...stmt].reverse().find((r) => (r.op === 0x12 || r.op === 0x13) && r.cls)
    return { kind: 'enumAll', name, enumCls: clsRow ? clsRow.cls : null, put }
  }
  // varargs / collection / predicate flavors: count aastores when present
  const aastores = stmt.filter((r) => r.op === 0x53).length
  if (aastores > 0) return { kind: 'value', name, card: aastores, put }
  return { kind: 'unsolved', name, create: create.ref, put }
}

function main () {
  const args = parseArgs()
  const jar = jarIndex(args['srg-jar'])
  const dataRoot = path.join(args['mc-data'], 'minecraft-data', 'data')
  const dataPaths = JSON.parse(fs.readFileSync(path.join(dataRoot, 'dataPaths.json'), 'utf8'))
  const blocksRel = dataPaths.pc[args['mc-version']].blocks
  const mcData = JSON.parse(fs.readFileSync(path.join(dataRoot, blocksRel, 'blocks.json'), 'utf8'))
  const mdByName = new Map(mcData.map((b) => [b.name, b]))

  // ---- 1. block-package class set + hierarchy -----------------------------
  const blockClasses = jar.classNames.filter((c) =>
    c.startsWith('net/minecraft/world/level/block/') && !c.includes('$Builder'))
  const hierarchy = {}
  const interfacesOf = {}
  for (const cls of blockClasses) {
    const p = jar.get(cls)
    if (!p) continue
    hierarchy[cls] = p.superName
    interfacesOf[cls] = p.interfaces
  }

  // ---- 2. property constants: field -> {name, card} -----------------------
  // Scan clinits of every block-package class (BlockStateProperties + the
  // per-class aliases like CropBlock.AGE).
  const propRaw = new Map() // key -> classification
  for (const cls of blockClasses) {
    const p = jar.get(cls)
    if (!p) continue
    const clinit = p.codes.find((m) => m.method === '<clinit>')
    if (!clinit) continue
    const rows = decodeInstructions(clinit.code, p.cp)
    for (const stmt of statements(rows)) {
      const put = stmt[stmt.length - 1]
      if (!put.ref || !isPropDesc(put.ref.desc)) continue
      propRaw.set(key(put.ref.owner, put.ref.name), classifyPropertyStatement(stmt))
    }
  }

  // property ARRAY fields (BrewingStandBlock.HAS_BOTTLE = {p0, p1, p2}):
  // capture element property keys in aastore order.
  const propArrays = new Map() // key -> [elementPropKey...]
  for (const cls of blockClasses) {
    const p = jar.get(cls)
    if (!p) continue
    const clinit = p.codes.find((m) => m.method === '<clinit>')
    if (!clinit) continue
    for (const stmt of statements(decodeInstructions(clinit.code, p.cp))) {
      const put = stmt[stmt.length - 1]
      if (!put.ref || !put.ref.desc.startsWith('[') || !isPropDesc(put.ref.desc.slice(1))) continue
      const elems = stmt.filter((r) => r.op === 0xb2 && r.ref && isPropDesc(r.ref.desc))
        .map((r) => key(r.ref.owner, r.ref.name))
      propArrays.set(key(put.ref.owner, put.ref.name), elems)
    }
  }

  // enum constant counts for enumAll creates
  const enumCount = (cls) => {
    const p = jar.get(cls)
    if (!p) return null
    const consts = p.fields.filter((f) => f.desc === `L${cls};` && (f.flags & 0x4000)) // ACC_ENUM
    return consts.length || null
  }

  // resolve aliases + enums to concrete cardinalities
  const propCard = new Map() // key -> {name, card} (card may be null = unsolved)
  const resolve = (k, seen = new Set()) => {
    if (propCard.has(k)) return propCard.get(k)
    if (seen.has(k)) return null
    seen.add(k)
    const raw = propRaw.get(k)
    if (!raw) return null
    let out = null
    if (raw.kind === 'value') out = { name: raw.name, card: raw.card }
    else if (raw.kind === 'enumAll') out = { name: raw.name, card: raw.enumCls ? enumCount(raw.enumCls) : null }
    else if (raw.kind === 'alias') {
      // aliases SHARE the target entry object so a later equation solve on
      // either key updates every alias of the same property
      out = resolve(key(raw.to.owner, raw.to.name), seen) ?? null
    } else out = { name: raw.name ?? null, card: null }
    if (out) propCard.set(k, out)
    return out
  }
  for (const k of propRaw.keys()) resolve(k)

  // ---- 3. createBlockStateDefinition contributions per class --------------
  // identified purely by descriptor (unique among block-class methods)
  let cbsdName = null
  const classContrib = {}
  for (const cls of blockClasses) {
    const p = jar.get(cls)
    if (!p) continue
    const m = p.codes.find((c) => c.desc === BUILDER_DESC && c.method !== '<init>')
    if (!m) continue
    if (!cbsdName) cbsdName = m.method
    else if (cbsdName !== m.method && cls !== BEHAVIOUR_CLS) {
      // additional methods with same desc would break the identification
      console.error(`ambiguous createBlockStateDefinition name: ${cbsdName} vs ${m.method} in ${cls}`)
    }
    const rows = decodeInstructions(m.code, p.cp)
    const props = []
    let dynamic = false
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      if (r.op === 0xb2 && r.ref && isPropDesc(r.ref.desc)) {
        props.push(key(r.ref.owner, r.ref.name))
      } else if (r.op === 0xb2 && r.ref && r.ref.desc.startsWith('[') && isPropDesc(r.ref.desc.slice(1))) {
        // property ARRAY access: getstatic arr, <iconst k>, aaload
        const idxRow = rows[i + 1]
        const loadRow = rows[i + 2]
        if (idxRow && idxRow.int !== undefined && loadRow && loadRow.op === 0x32) {
          const arr = propArrays.get(key(r.ref.owner, r.ref.name))
          const el = arr && arr[idxRow.int]
          if (el) props.push(el)
          else dynamic = true
        } else dynamic = true // array used non-literally (loops)
      } else if (r.op === 0xba) {
        dynamic = true // lambda (forEach-style property registration)
      } else if (r.op === 0xb9 && r.ref && /^java\/util\/(List|Map|Collection|Set|Iterator|Iterable)$/.test(r.ref.owner)) {
        dynamic = true // collection-driven property registration
      } else if ((r.op === 0xb6 || r.op === 0xb7 || r.op === 0xb8) && r.ref &&
                 /\)L([^;]+);$/.test(r.ref.desc) && isPropDesc(`L${r.ref.desc.match(/\)L([^;]+);$/)[1]};`)) {
        dynamic = true // a helper PRODUCES properties (MultifaceBlock-style)
      } else if (r.target !== undefined && r.target < r.pc) {
        dynamic = true // backward branch: property registration inside a loop
      }
    }
    const callsSuper = rows.some((r) => r.op === 0xb7 && r.ref && r.ref.name === m.method && r.ref.desc === BUILDER_DESC)
    classContrib[cls] = { props, callsSuper, ...(dynamic ? { dynamic: true } : {}) }
  }

  // ---- 4. Blocks.<clinit>: field -> name, name -> constructed class -------
  const blocksParsed = jar.get(BLOCKS_CLS)
  const clinit = blocksParsed.codes.find((m) => m.method === '<clinit>')
  const rows = decodeInstructions(clinit.code, blocksParsed.cp)
  const helperNew = (methodName, desc) => {
    const m = blocksParsed.codes.find((c) => c.method === methodName && c.desc === desc)
    if (!m) return null
    const hRows = decodeInstructions(m.code, blocksParsed.cp)
    const n = hRows.find((r) => r.op === 0xbb && r.cls && hierarchy[r.cls] !== undefined)
    if (n) return n.cls
    // helper may itself delegate (one more level)
    for (const r of hRows) {
      if (r.op === 0xb8 && r.ref && r.ref.owner === BLOCKS_CLS && returnsBlockClass(r.ref.desc)) {
        const inner = helperNew(r.ref.name, r.ref.desc)
        if (inner) return inner
      }
    }
    return null
  }
  // a method whose return type is any block-package class (helpers return
  // concrete subtypes: log() -> RotatedPillarBlock, bed() -> BedBlock, ...)
  const returnsBlockClass = (desc) => {
    const m = desc.match(/\)L([^;]+);$/)
    return !!(m && (m[1] === BLOCK_CLS || hierarchy[m[1]] !== undefined))
  }
  const blocksFieldToName = {}
  const nameToClass = new Map()
  for (const stmt of statements(rows)) {
    const put = stmt[stmt.length - 1]
    if (!put.ref || put.ref.owner !== BLOCKS_CLS || put.ref.desc !== `L${BLOCK_CLS};`) continue
    const nameRow = stmt.find((r) => r.str !== undefined)
    if (!nameRow) continue
    const name = nameRow.str
    blocksFieldToName[put.ref.name] = name
    let cls = null
    const news = stmt.filter((r) => r.op === 0xbb && r.cls && hierarchy[r.cls] !== undefined)
    if (news.length) cls = news[0].cls
    if (!cls) {
      for (const r of stmt) {
        if (r.op === 0xb8 && r.ref && r.ref.owner === BLOCKS_CLS && returnsBlockClass(r.ref.desc) && !r.ref.desc.startsWith('(Ljava/lang/String;')) {
          cls = helperNew(r.ref.name, r.ref.desc)
          if (cls) break
        }
      }
    }
    nameToClass.set(name, cls)
  }

  // ---- 5. effective property set + count per vanilla block ----------------
  const effectiveProps = (cls) => {
    // walk down from cls: most-derived createBlockStateDefinition, following
    // super calls upward. dynamic=true anywhere on the effective chain means
    // the property set is not statically derivable -> honest abstention.
    const out = []
    let dynamic = false
    let c = cls
    while (c && c !== 'java/lang/Object') {
      const contrib = classContrib[c]
      if (contrib) {
        out.push(...contrib.props)
        if (contrib.dynamic) dynamic = true
        if (!contrib.callsSuper) return { props: out, dynamic }
      }
      c = hierarchy[c] ?? null
    }
    return { props: out, dynamic }
  }

  // Inherited static fields may be referenced through the SUBCLASS as the
  // constant-pool owner (javac emits the compile-time qualifier): resolve a
  // property key by walking the owner up the hierarchy to its declaration.
  const canonPropKey = (pk) => {
    if (propCard.has(pk)) return pk
    let [owner, field] = pk.split('#')
    while (owner && hierarchy[owner] !== undefined) {
      owner = hierarchy[owner]
      const k2 = key(owner, field)
      if (propCard.has(k2)) return k2
    }
    return pk
  }

  const derivedCount = (cls) => {
    const eff = effectiveProps(cls)
    const props = eff.props.map(canonPropKey)
    let product = 1
    const unknowns = []
    for (const pk of props) {
      const pc = propCard.get(pk)
      if (!pc || pc.card == null) unknowns.push(pk)
      else product *= pc.card
    }
    return { product, unknowns, props, dynamic: eff.dynamic }
  }

  // solve unknown cardinalities against minecraft-data
  let progress = true
  const solved = new Map()
  while (progress) {
    progress = false
    for (const [name, cls] of nameToClass) {
      if (!cls) continue
      const md = mdByName.get(name)
      if (!md) continue
      const truth = md.maxStateId - md.minStateId + 1
      const { product, unknowns, dynamic } = derivedCount(cls)
      if (dynamic) continue // abstaining chains give no equations
      const un = [...new Set(unknowns.filter((u) => !solved.has(u)))]
      if (un.length === 1 && unknowns.filter((u) => u === un[0]).length === 1) {
        const v = truth / product
        if (Number.isInteger(v) && v >= 1) {
          solved.set(un[0], v)
          const pc = propCard.get(un[0]) || { name: null, card: null }
          pc.card = v
          propCard.set(un[0], pc)
          progress = true
        }
      }
    }
  }

  // ---- 6. SELF-TEST -------------------------------------------------------
  // Gate: every vanilla block must derive its exact state count OR abstain
  // honestly (dynamic state definition). A WRONG count is the one failure
  // mode that could mis-segment a modded state range, so wrongs are fatal.
  let ok = 0
  let abstain = 0
  const abstainNames = []
  const failures = []
  for (const [name, cls] of nameToClass) {
    const md = mdByName.get(name)
    if (!md) { failures.push({ name, reason: 'not in minecraft-data' }); continue }
    const truth = md.maxStateId - md.minStateId + 1
    if (!cls) { failures.push({ name, reason: 'no constructed class', truth }); continue }
    const { product, unknowns, dynamic } = derivedCount(cls)
    if (dynamic) { abstain++; abstainNames.push(name); continue }
    if (unknowns.length) { failures.push({ name, cls, reason: `unsolved ${unknowns.join(',')}`, truth }); continue }
    if (product !== truth) { failures.push({ name, cls, reason: `derived ${product} != md ${truth}` }); continue }
    ok++
  }
  console.log(`self-test: ${ok}/${nameToClass.size} vanilla blocks derive exactly, ` +
    `${abstain} abstain honestly (${abstainNames.join(', ')}), ${failures.length} WRONG/unresolved`)
  if (failures.length) {
    console.log('FAILURES (first 40):')
    for (const f of failures.slice(0, 40)) console.log(' ', JSON.stringify(f))
  }

  // ---- 6b. vanilla enum constant counts + collision-shape overriders -----
  // enums a mod's EnumProperty.create(name, VanillaEnum.class) may reference,
  // and the vanilla classes whose getCollisionShape override makes a
  // subclass's collision statically unknowable (the false-nonsolid guard).
  const enumCounts = {}
  for (const cls of jar.classNames) {
    if (!cls.startsWith('net/minecraft/world/level/block/') && !cls.startsWith('net/minecraft/core/')) continue
    const p = jar.get(cls)
    if (!p) continue
    const consts = p.fields.filter((f) => f.desc === `L${cls};` && (f.flags & 0x4000))
    if (consts.length) enumCounts[cls] = consts.length
  }

  // ---- 7. era identifier names (mechanically anchored) --------------------
  // getCollisionShape: BlockBehaviour method reading the hasCollision bool.
  const behaviour = jar.get(BEHAVIOUR_CLS)
  const shapeDesc = (m) => m.desc.startsWith('(Lnet/minecraft/world/level/block/state/BlockState;Lnet/minecraft/world/level/BlockGetter;Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/phys/shapes/CollisionContext;)')
  let getCollisionShape = null
  let hasCollisionField = null
  for (const m of behaviour.codes) {
    if (!shapeDesc(m)) continue
    const rowsB = decodeInstructions(m.code, behaviour.cp)
    // getfield of a boolean field on own class = the hasCollision read
    const zRead = rowsB.find((r) => r.op === 0xb4 && r.ref && r.ref.desc === 'Z')
    if (zRead) { getCollisionShape = m.method; hasCollisionField = zRead.ref.name; break }
  }
  // Properties.noCollission: the no-arg Properties->Properties method that
  // writes FALSE into the Properties field which BlockBehaviour.<init>
  // copies into its hasCollision field.
  const propsParsed = jar.get(PROPS_CLS)
  let propsHasCollision = null
  {
    const init = behaviour.codes.find((m) => m.method === '<init>')
    const rowsI = decodeInstructions(init.code, behaviour.cp)
    for (let i = 0; i < rowsI.length; i++) {
      const r = rowsI[i]
      if (r.op === 0xb5 && r.ref && r.ref.name === hasCollisionField && r.ref.desc === 'Z') {
        // find the getfield feeding it
        for (let j = i - 1; j >= 0 && j > i - 4; j--) {
          const g = rowsI[j]
          if (g.op === 0xb4 && g.ref && g.ref.owner === PROPS_CLS && g.ref.desc === 'Z') { propsHasCollision = g.ref.name; break }
        }
      }
    }
  }
  let noCollission = null
  const propsOf = []
  let propsCopy = null
  for (const m of propsParsed.codes) {
    if (m.desc === `()L${PROPS_CLS};` && (m.flags & 0x0008)) propsOf.push(m.method) // static of()
    if (m.desc === `(L${BEHAVIOUR_CLS};)L${PROPS_CLS};` && (m.flags & 0x0008)) propsCopy = m.method
    if (m.desc === `()L${PROPS_CLS};` && !(m.flags & 0x0008) && propsHasCollision) {
      const rowsM = decodeInstructions(m.code, propsParsed.cp)
      const writesFalse = rowsM.some((r, i) =>
        r.op === 0xb5 && r.ref && r.ref.name === propsHasCollision &&
        rowsM.slice(Math.max(0, i - 2), i).some((q) => q.int === 0))
      if (writesFalse) noCollission = m.method
    }
  }

  // Registry.register statics (for the Fabric linkage) — all overloads.
  const registryParsed = jar.get('net/minecraft/core/Registry')
  const registerMethods = []
  if (registryParsed) {
    for (const m of registryParsed.codes) {
      if ((m.flags & 0x0008) && /^\(Lnet\/minecraft\/core\/(Registry|WritableRegistry);/.test(m.desc) &&
          m.desc.endsWith('Ljava/lang/Object;)Ljava/lang/Object;')) {
        registerMethods.push({ name: m.method, desc: m.desc })
      }
    }
  }

  const ids = {
    createBlockStateDefinition: cbsdName,
    getCollisionShape,
    propsNoCollission: noCollission,
    propsOf,
    propsCopy,
    registryRegister: registerMethods
  }
  console.log('ids:', JSON.stringify(ids, null, 1))

  // ---- 8. emit srg tables + translate to intermediary ---------------------
  // emit contributions with canonical (declaring-class) property keys so the
  // runtime table lookups are direct
  const classContribCanon = {}
  for (const [c, v] of Object.entries(classContrib)) {
    classContribCanon[c] = {
      callsSuper: v.callsSuper,
      props: v.props.map(canonPropKey),
      ...(v.dynamic ? { dynamic: true } : {}) // dynamic MUST survive: it is the abstain signal
    }
  }
  const overridesCollision = []
  for (const cls of blockClasses) {
    const p = jar.get(cls)
    if (!p) continue
    if (p.codes.some((m) => m.method === getCollisionShape && shapeDesc(m))) overridesCollision.push(cls)
  }

  const srgTables = {
    ids: {
      ...ids,
      // override-sensitive method names ship as candidate ARRAYS in every
      // namespace (the intermediary side can resolve to several)
      createBlockStateDefinition: [ids.createBlockStateDefinition],
      getCollisionShape: [ids.getCollisionShape],
      classNames: {
        blocks: BLOCKS_CLS,
        properties: PROPS_CLS,
        behaviour: BEHAVIOUR_CLS,
        block: BLOCK_CLS,
        builder: 'net/minecraft/world/level/block/state/StateDefinition$Builder',
        registry: 'net/minecraft/core/Registry',
        resourceLocation: 'net/minecraft/resources/ResourceLocation',
        propInteger: `${P}IntegerProperty`,
        propBoolean: `${P}BooleanProperty`,
        propEnum: `${P}EnumProperty`,
        propDirection: `${P}DirectionProperty`,
        propBase: `${P}Property`
      }
    },
    hierarchy,
    classContrib: classContribCanon,
    propCard: Object.fromEntries([...propCard].map(([k, v]) => [k, v])),
    blocksFieldToName,
    enumCounts,
    overridesCollision
  }

  const classMapMojToObf = parseProguardClasses(fs.readFileSync(args.mojmap, 'utf8'))
  const { memberMapSrgToObf } = parseTsrg(fs.readFileSync(args.tsrg, 'utf8'))
  const tiny = parseTiny(fs.readFileSync(args.tiny, 'utf8'))
  const inter = translateTables(srgTables, classMapMojToObf, memberMapSrgToObf, tiny)

  // vanilla no-collision block names (minecraft-data: boundingBox empty)
  const vanillaNonSolid = mcData.filter((b) => b.boundingBox === 'empty').map((b) => b.name)

  const out = {
    generated: new Date().toISOString(),
    generator: 'tools/genBlockShapeTables.js',
    mcVersion: args['mc-version'],
    selfTest: { ok, total: nameToClass.size, failures: failures.length },
    vanillaNonSolid,
    namespaces: { srg: srgTables, intermediary: inter }
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true })
  fs.writeFileSync(args.out, JSON.stringify(out))
  console.log(`wrote ${args.out} (${(fs.statSync(args.out).size / 1024).toFixed(0)} KB)`)
  if (failures.length) process.exit(1)
}

// -- Mojang official (proguard) mappings: moj class -> obf class ------------
function parseProguardClasses (text) {
  const classMapMojToObf = new Map()
  for (const line of text.split('\n')) {
    if (line.startsWith(' ') || line.startsWith('#') || !line.includes(' -> ')) continue
    const m = line.match(/^(\S+) -> (\S+):$/)
    if (m) classMapMojToObf.set(m[1].replace(/\./g, '/'), m[2].replace(/\./g, '/'))
  }
  return classMapMojToObf
}

// -- mcp_config joined.tsrg (tsrg2: obf srg id): srg member -> obf ----------
function parseTsrg (text) {
  const memberMapSrgToObf = new Map() // srg member name -> {obfName, obfDesc?, obfClass}
  const lines = text.split('\n')
  let curObf = null
  for (let i = 1; i < lines.length; i++) { // skip 'tsrg2 obf srg id' header
    const line = lines[i]
    if (!line || line.startsWith('\t\t')) continue
    if (!line.startsWith('\t')) {
      curObf = line.trim().split(/\s+/)[0]
      continue
    }
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 2 && parts[1].startsWith('(')) { // method: obf desc srg [id]
      if (!memberMapSrgToObf.has(parts[2])) memberMapSrgToObf.set(parts[2], [])
      memberMapSrgToObf.get(parts[2]).push({ obfName: parts[0], obfDesc: parts[1], obfClass: curObf, kind: 'm' })
    } else if (parts.length >= 2) { // field: obf srg [id]
      if (!memberMapSrgToObf.has(parts[1])) memberMapSrgToObf.set(parts[1], [])
      memberMapSrgToObf.get(parts[1]).push({ obfName: parts[0], obfClass: curObf, kind: 'f' })
    }
  }
  return { memberMapSrgToObf }
}

// -- intermediary tiny v2: official(obf) -> intermediary --------------------
function parseTiny (text) {
  const classes = new Map() // obf class -> inter class
  const fields = new Map() // obfClass#obfName -> inter name
  const methods = new Map() // obfClass#obfName#obfDesc -> inter name
  let curObf = null
  for (const line of text.split('\n')) {
    const parts = line.split('\t')
    if (parts[0] === 'c') { classes.set(parts[1], parts[2]); curObf = parts[1] } else if (parts[0] === '' && parts[1] === 'f') {
      fields.set(`${curObf}#${parts[3]}`, parts[4])
    } else if (parts[0] === '' && parts[1] === 'm') {
      methods.set(`${curObf}#${parts[3]}#${parts[2]}`, parts[4])
    }
  }
  return { classes, fields, methods }
}

function translateTables (srg, classMojToObf, memberSrgToObf, tiny) {
  const PPKG = P
  const cls = (moj) => {
    const obf = classMojToObf.get(moj)
    if (!obf) return null
    return tiny.classes.get(obf) ?? null
  }
  // an SRG member id can appear on many classes (overrides); collect every
  // intermediary name the tiny mapping knows for any of those declarations
  const memberAll = (srgName) => {
    const entries = memberSrgToObf.get(srgName) || []
    const hits = new Set()
    for (const m of entries) {
      const hit = m.kind === 'f'
        ? tiny.fields.get(`${m.obfClass}#${m.obfName}`)
        : tiny.methods.get(`${m.obfClass}#${m.obfName}#${m.obfDesc}`)
      if (hit) hits.add(hit)
    }
    return [...hits]
  }
  const member = (srgName) => memberAll(srgName)[0] ?? null
  // non-srg member names (Forge-only or unobfuscated) translate to themselves
  const memberOrSelf = (name) => (/^(m|f)_\d+_$/.test(name) ? member(name) : name)
  const memberAllOrSelf = (name) => (/^(m|f)_\d+_$/.test(name) ? memberAll(name) : [name])

  const hierarchy = {}
  for (const [c, s] of Object.entries(srg.hierarchy)) {
    const ic = cls(c)
    if (!ic) continue
    hierarchy[ic] = s && s.startsWith('net/minecraft') ? cls(s) : s
  }
  const classContrib = {}
  for (const [c, v] of Object.entries(srg.classContrib)) {
    const ic = cls(c)
    if (!ic) continue
    classContrib[ic] = {
      callsSuper: v.callsSuper,
      props: v.props.map((pk) => {
        const [owner, field] = pk.split('#')
        const io = cls(owner)
        const f = memberOrSelf(field)
        return io && f ? `${io}#${f}` : pk
      })
    }
  }
  const propCard = {}
  for (const [pk, v] of Object.entries(srg.propCard)) {
    const [owner, field] = pk.split('#')
    const io = cls(owner)
    const f = memberOrSelf(field)
    if (io && f) propCard[`${io}#${f}`] = v
  }
  const blocksFieldToName = {}
  for (const [f, n] of Object.entries(srg.blocksFieldToName)) {
    const inf = memberOrSelf(f)
    if (inf) blocksFieldToName[inf] = n
  }
  const ids = {
    createBlockStateDefinition: srg.ids.createBlockStateDefinition.flatMap(memberAllOrSelf),
    getCollisionShape: srg.ids.getCollisionShape.flatMap(memberAllOrSelf),
    propsNoCollission: memberOrSelf(srg.ids.propsNoCollission),
    propsOf: srg.ids.propsOf.map(memberOrSelf).filter(Boolean),
    propsCopy: memberOrSelf(srg.ids.propsCopy),
    registryRegister: srg.ids.registryRegister.map((r) => ({ name: memberOrSelf(r.name), desc: r.desc })).filter((r) => r.name),
    // era key classes, translated so the runtime can rewrite its anchors
    classNames: {
      blocks: cls(BLOCKS_CLS),
      properties: cls(PROPS_CLS),
      behaviour: cls(BEHAVIOUR_CLS),
      block: cls(BLOCK_CLS),
      builder: cls('net/minecraft/world/level/block/state/StateDefinition$Builder'),
      registry: cls('net/minecraft/core/Registry'),
      resourceLocation: cls('net/minecraft/resources/ResourceLocation'),
      propInteger: cls(`${PPKG}IntegerProperty`),
      propBoolean: cls(`${PPKG}BooleanProperty`),
      propEnum: cls(`${PPKG}EnumProperty`),
      propDirection: cls(`${PPKG}DirectionProperty`),
      propBase: cls(`${PPKG}Property`)
    }
  }
  const enumCounts = {}
  for (const [c, n] of Object.entries(srg.enumCounts)) {
    const ic = cls(c)
    if (ic) enumCounts[ic] = n
  }
  const overridesCollision = srg.overridesCollision.map(cls).filter(Boolean)
  return { ids, hierarchy, classContrib, propCard, blocksFieldToName, enumCounts, overridesCollision }
}

main()
