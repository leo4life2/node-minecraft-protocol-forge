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
// HF48-P2: the same run also emits, per namespace, the FriendlyByteBuf
// WRITE-METHOD vocabulary (namespaces.<era>.ids.friendlyByteBufWrites =
// {mojangName: [eraNames]} + ids.classNames.friendlyByteBuf) for every
// Mojang write the runtime layout reader models (the shared table
// src/client/friendlyByteBufWrites.js, so generator and reader cannot
// drift): mojang -> obf through the proguard mappings (name + JVM
// descriptor, so overloads that share an obf name never cross), obf -> srg
// through the tsrg2 line of the same obf class + descriptor, obf ->
// intermediary through tiny-v2; an unobfuscated member (the netty
// ByteBuf overrides writeByte/writeInt/...) is its own name in every era.
// SRG ids are stable across MC versions, so the 1.20.1 srg vocabulary
// covers every SRG-era (1.17-1.20.1) Forge jar.
//
// Inputs used for the shipped table (2026-09-15, Mac mini):
//   --srg-jar /Users/nemossoftware/minepal-coop/forge-block-registry/verify/server/libraries/net/minecraft/server/1.20.1-20230612.114412/server-1.20.1-20230612.114412-srg.jar
//   --tsrg    <forge 1.20.1-47.3.22 install>/libraries/de/oceanlabs/mcp/mcp_config/1.20.1-20230612.114412/mcp_config-1.20.1-20230612.114412-mappings.txt
//             (the installer's extracted config/joined.tsrg, header "tsrg2 obf srg id")
//   --mojmap  <forge 1.20.1-47.3.22 install>/libraries/net/minecraft/server/1.20.1-20230612.114412/server-1.20.1-20230612.114412-mappings.txt (proguard)
//   --tiny    mappings/mappings.tiny out of https://maven.fabricmc.net/net/fabricmc/intermediary/1.20.1/intermediary-1.20.1-v2.jar
//   --mc-data node_modules/minecraft-data
//
// HF58b MOJMAP ERA (Forge 1.20.2+ / NeoForge / 26.x jars carry Mojang member
// names): a third namespace 'mojmap' generated from a Mojang-named server jar
// (Mojang ships deobfuscated server jars from 26.1) and MERGED into the
// existing file, whose srg/intermediary namespaces are kept and enriched with
// the state-index value orders (propCard.kind/min/values) of their own version:
//   node tools/genBlockShapeTables.js --era mojmap \
//     --jar <server-26.3-unpacked.jar (the Forge 26.3 installer's libraries/net/minecraft/server/26.3/)> \
//     --mc-data <node_modules/minecraft-data> --mc-version 26.3 \
//     --merge src/client/data/blockShapeTables.json --out src/client/data/blockShapeTables.json
//   (shipped table: 2026-09-20, server-26.3-unpacked.jar sha1 cc3964451a3b32a0488110d5e3e6ad8d75fe6a66, self-test 878/878)
//
// Usage:
//   node tools/genBlockShapeTables.js \
//     --srg-jar <server-...-srg.jar> --tsrg <joined.tsrg> \
//     --tiny <intermediary mappings.tiny> --mc-data <node_modules/minecraft-data> \
//     --mc-version 1.20.1 --out src/client/data/blockShapeTables.json

const fs = require('fs')
const path = require('path')
const {
  zipCentralEntries, zipEntryData, parseClassFile, decodeInstructions, resolveLambdaImpl
} = require('../src/client/jarAnalysis')
const { WRITES } = require('../src/client/friendlyByteBufWrites')

const FBB_CLS = 'net/minecraft/network/FriendlyByteBuf'
const REGISTRY_FBB_CLS = 'net/minecraft/network/RegistryFriendlyByteBuf' // 1.20.5+ only; absent on 1.20.1

// ---------------------------------------------------------------------------
function parseArgs () {
  const a = process.argv.slice(2)
  const out = {}
  for (let i = 0; i < a.length; i += 2) out[a[i].replace(/^--/, '')] = a[i + 1]
  const required = out.era === 'mojmap'
    ? ['jar', 'mc-data', 'mc-version', 'out'] // HF58b: --era mojmap --jar <Mojang-named server jar> [--merge <existing tables>]
    : ['srg-jar', 'tsrg', 'tiny', 'mojmap', 'mc-data', 'mc-version', 'out']
  for (const k of required) {
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
    if (hi !== undefined) return { kind: 'value', name, card: hi - lo + 1, min: lo, propKind: 'int', put }
    return { kind: 'unknown', name, put }
  }
  if (d.startsWith('(Ljava/lang/String;)')) {
    // BooleanProperty.create(name) => 2; DirectionProperty.create(name) => all 6
    const isDir = d.endsWith(`L${P}DirectionProperty;`)
    return { kind: 'value', name, card: isDir ? 6 : 2, propKind: isDir ? 'enum' : 'bool', put }
  }
  if (d.startsWith('(Ljava/lang/String;Ljava/lang/Class;)')) {
    const clsRow = [...stmt].reverse().find((r) => (r.op === 0x12 || r.op === 0x13) && r.cls)
    return { kind: 'enumAll', name, enumCls: clsRow ? clsRow.cls : null, put }
  }
  // varargs / collection / predicate flavors: count aastores when present
  const aastores = stmt.filter((r) => r.op === 0x53).length
  if (aastores > 0) return { kind: 'value', name, card: aastores, propKind: 'enum', put }
  return { kind: 'unsolved', name, create: create.ref, put }
}

function loadMcData (args, mcVersion) {
  const dataRoot = path.join(args['mc-data'], 'minecraft-data', 'data')
  const dataPaths = JSON.parse(fs.readFileSync(path.join(dataRoot, 'dataPaths.json'), 'utf8'))
  const blocksRel = dataPaths.pc[mcVersion].blocks
  return JSON.parse(fs.readFileSync(path.join(dataRoot, blocksRel, 'blocks.json'), 'utf8'))
}

// property name + cardinality -> {type, values} from minecraft-data's per-block
// state lists; a pair whose value list differs between blocks is 'ambiguous'
// (never exported - a wrong value order would misname states).
function buildValueIndex (mcData) {
  const idx = new Map()
  for (const b of mcData) {
    for (const s of b.states || []) {
      const k = `${s.name}#${s.num_values}`
      const values = s.type === 'bool' ? ['true', 'false'] : (s.values || []).map(String)
      const cur = idx.get(k)
      if (cur === undefined) idx.set(k, { type: s.type, values })
      else if (cur !== 'ambiguous' && (cur.type !== s.type || cur.values.join(',') !== values.join(','))) idx.set(k, 'ambiguous')
    }
  }
  return idx
}

// HF58b: enrich an already-generated namespace's propCard with the value
// orders of its own minecraft version (the srg/intermediary tables keep
// their vocabulary; only the state-index fields are added).
function enrichValues (ns, valueIndex) {
  for (const v of Object.values(ns.propCard || {})) {
    if (!v || !v.name || v.card == null) continue
    const vi = valueIndex.get(`${v.name}#${v.card}`)
    if (!vi || vi === 'ambiguous') continue
    if (!v.kind) v.kind = vi.type
    if (vi.type === 'int' && v.min == null && vi.values.length) v.min = Number(vi.values[0])
    if (vi.type === 'enum' && !v.values) v.values = vi.values
  }
}

function main () {
  const args = parseArgs()
  if (args.era === 'mojmap') return mainMojmap(args)
  const jar = jarIndex(args['srg-jar'])
  const mcData = loadMcData(args, args['mc-version'])
  const valueIndex = buildValueIndex(mcData)
  const built = buildEraTables(jar, mcData, valueIndex)
  const srgTables = built.tables
  const { ok, failures } = built
  const nameToClass = { size: built.total }
  const classMapMojToObf = parseProguardClasses(fs.readFileSync(args.mojmap, 'utf8'))
  const { memberMapSrgToObf } = parseTsrg(fs.readFileSync(args.tsrg, 'utf8'))
  const tiny = parseTiny(fs.readFileSync(args.tiny, 'utf8'))
  const inter = translateTables(srgTables, classMapMojToObf, memberMapSrgToObf, tiny)
  const writeVocab = friendlyByteBufWriteVocab(fs.readFileSync(args.mojmap, 'utf8'), fs.readFileSync(args.tsrg, 'utf8'), tiny, classMapMojToObf)
  srgTables.ids.friendlyByteBufWrites = writeVocab.srg
  srgTables.ids.classNames.friendlyByteBuf = FBB_CLS
  inter.ids.friendlyByteBufWrites = writeVocab.intermediary
  inter.ids.classNames.friendlyByteBuf = tiny.classes.get(classMapMojToObf.get(FBB_CLS)) ?? null
  console.log('friendlyByteBufWrites:', JSON.stringify(writeVocab))

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

// HF58b MOJMAP ERA: Forge 1.20.2+ / NeoForge / any Mojang-named jar - the
// vocabulary IS the Mojang spelling, read from a Mojang-named server jar of
// that era (Mojang ships deobfuscated server jars from 26.1; earlier eras
// take the Forge/NeoForge installer's official-names jar). --merge keeps the
// other namespaces of an existing tables file and enriches their propCard
// with the state-index value orders of their own version.
function mainMojmap (args) {
  const jar = jarIndex(args.jar)
  const mcData = loadMcData(args, args['mc-version'])
  const valueIndex = buildValueIndex(mcData)
  const built = buildEraTables(jar, mcData, valueIndex)
  const tables = built.tables
  // FriendlyByteBuf writes: a Mojang-named jar spells every write by its
  // Mojang name (identity vocabulary; the shared WRITES table is the list)
  tables.ids.friendlyByteBufWrites = Object.fromEntries(Object.keys(WRITES).map((w) => [w, [w]]))
  tables.ids.classNames.friendlyByteBuf = FBB_CLS
  const vanillaNonSolid = mcData.filter((b) => b.boundingBox === 'empty').map((b) => b.name)
  let out
  if (args.merge) {
    out = JSON.parse(fs.readFileSync(args.merge, 'utf8'))
    const mergedMcData = loadMcData(args, out.mcVersion)
    const mergedIndex = buildValueIndex(mergedMcData)
    for (const ns of Object.values(out.namespaces)) enrichValues(ns, mergedIndex)
    out.vanillaNonSolid = [...new Set([...out.vanillaNonSolid, ...vanillaNonSolid])]
  } else {
    out = { generated: null, generator: 'tools/genBlockShapeTables.js', mcVersion: null, selfTest: null, vanillaNonSolid, namespaces: {} }
  }
  out.generated = new Date().toISOString()
  const jarSha1 = require('crypto').createHash('sha1').update(fs.readFileSync(args.jar)).digest('hex')
  out.mojmap = { mcVersion: args['mc-version'], jar: path.basename(args.jar), jarSha1, selfTest: { ok: built.ok, total: built.total, failures: built.failures.length } }
  out.namespaces.mojmap = tables
  fs.mkdirSync(path.dirname(args.out), { recursive: true })
  fs.writeFileSync(args.out, JSON.stringify(out))
  console.log(`wrote ${args.out} (${(fs.statSync(args.out).size / 1024).toFixed(0)} KB) with namespaces ${Object.keys(out.namespaces).join(',')}`)
  if (built.failures.length) process.exit(1)
}

// The vocabulary of ONE mapping era, read from ONE deobfuscated server jar
// and self-tested against that version's minecraft-data (HF58b: shared by
// the srg pipeline and the mojmap era; nothing here knows which era it is).
function buildEraTables (jar, mcData, valueIndex) {
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
                 /\)\[?L([^;]+);$/.test(r.ref.desc) && isPropDesc(`L${r.ref.desc.match(/\)\[?L([^;]+);$/)[1]};`)) {
        dynamic = true // a helper PRODUCES properties, one or an ARRAY of them (MultifaceBlock-style; HF58b remediation: the array form too)
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
  // a method whose return type is any block-package class (helpers return
  // concrete subtypes: log() -> RotatedPillarBlock, bed() -> BedBlock, ...)
  const returnsBlockClass = (desc) => {
    const m = desc.match(/\)L([^;]+);$/)
    return !!(m && (m[1] === BLOCK_CLS || hierarchy[m[1]] !== undefined))
  }
  // the block class a row window constructs: a `new <block class>`, a
  // factory handle (Class::new = REF_newInvokeSpecial, or a static lambda of
  // Blocks whose body constructs one - the 1.21+ register(id, Factory,
  // Properties) idiom), or a Blocks helper returning a block class (its body
  // resolved the same way, bounded)
  const classOfRows = (rows, depth = 0) => {
    if (depth > 3) return null
    const n = rows.find((r) => r.op === 0xbb && r.cls && hierarchy[r.cls] !== undefined)
    if (n) return n.cls
    for (const r of rows) {
      if (r.op !== 0xba || r.bsmIndex === undefined) continue
      const impl = resolveLambdaImpl(blocksParsed, r.bsmIndex)
      if (!impl) continue
      if (impl.refKind === 8 && (impl.owner === BLOCK_CLS || hierarchy[impl.owner] !== undefined)) return impl.owner
      if (impl.owner === BLOCKS_CLS) {
        const m = blocksParsed.codes.find((c) => c.method === impl.name && c.desc === impl.desc)
        const viaLambda = m ? classOfRows(decodeInstructions(m.code, blocksParsed.cp), depth + 1) : null
        if (viaLambda) return viaLambda
      }
    }
    for (const r of rows) {
      if (r.op === 0xb8 && r.ref && r.ref.owner === BLOCKS_CLS && returnsBlockClass(r.ref.desc) && !r.ref.desc.startsWith('(Ljava/lang/String;')) {
        const m = blocksParsed.codes.find((c) => c.method === r.ref.name && c.desc === r.ref.desc)
        const viaHelper = m ? classOfRows(decodeInstructions(m.code, blocksParsed.cp), depth + 1) : null
        if (viaHelper) return viaHelper
      }
    }
    return null
  }
  // the registry name of a Blocks statement: its first string literal, else
  // (1.21+: register(BlockItemIds.X, ...)) the string that defines the id
  // constant it reads - the first literal of that constant's own clinit
  // statement in its declaring class
  const constNameMemo = new Map()
  const constNameOf = (owner, field) => {
    const k = key(owner, field)
    if (constNameMemo.has(k)) return constNameMemo.get(k)
    let out = null
    const p = jar.get(owner)
    const ci = p && p.codes.find((m) => m.method === '<clinit>')
    if (ci) {
      for (const st of statements(decodeInstructions(ci.code, p.cp))) {
        const put = st[st.length - 1]
        if (!put.ref || put.ref.owner !== owner || put.ref.name !== field) continue
        const sr = st.find((r) => r.str !== undefined)
        out = sr ? sr.str : null
        break
      }
    }
    constNameMemo.set(k, out)
    return out
  }
  const nameOfStmt = (stmt) => {
    const sr = stmt.find((r) => r.str !== undefined)
    if (sr) return sr.str
    for (const r of stmt) {
      if (r.op !== 0xb2 || !r.ref || !r.ref.desc.startsWith('L')) continue
      if (r.ref.owner.startsWith('net/minecraft/world/level/block/') || r.ref.owner === BLOCKS_CLS) continue
      const n = constNameOf(r.ref.owner, r.ref.name)
      if (n) return n
    }
    return null
  }
  const blocksFieldToName = {}
  const nameToClass = new Map()
  for (const stmt of statements(rows)) {
    const put = stmt[stmt.length - 1]
    if (!put.ref || put.ref.owner !== BLOCKS_CLS || put.ref.desc !== `L${BLOCK_CLS};`) continue
    const name = nameOfStmt(stmt)
    if (!name) continue
    blocksFieldToName[put.ref.name] = name
    nameToClass.set(name, classOfRows(stmt))
  }

  // ---- 5. effective property set + count per vanilla block ----------------
  const effectiveProps = (cls) => {
    // walk down from cls: most-derived createBlockStateDefinition, following
    // super calls upward. A dynamic (loop/lambda-driven) body contributes an
    // unknown FACTOR for its whole body (its partially-visible props are
    // subsumed by the factor); factors are solved below against
    // minecraft-data totals exactly like unknown property cardinalities.
    const out = []
    const dynClasses = []
    let c = cls
    while (c && c !== 'java/lang/Object') {
      const contrib = classContrib[c]
      if (contrib) {
        if (contrib.dynamic) dynClasses.push(c)
        else out.push(...contrib.props)
        if (!contrib.callsSuper) return { props: out, dynClasses }
      }
      c = hierarchy[c] ?? null
    }
    return { props: out, dynClasses }
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

  const dynFactor = new Map() // dynamic-bodied class -> solved contribution factor
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
    const dynUnknowns = []
    for (const dc of eff.dynClasses) {
      const f = dynFactor.get(dc)
      if (f != null) product *= f
      else dynUnknowns.push(dc)
    }
    return { product, unknowns, dynUnknowns, props }
  }

  // solve unknown cardinalities AND dynamic-body factors against
  // minecraft-data. Factors are adopted only when EVERY single-unknown
  // equation for the class agrees (a disagreement poisons the class: its
  // body is instance-dependent, so chains through it must abstain).
  let progress = true
  const solved = new Map()
  const factorPoisoned = new Set()
  while (progress) {
    progress = false
    const factorCand = new Map() // cls -> Set of candidate factors
    for (const [name, cls] of nameToClass) {
      if (!cls) continue
      const md = mdByName.get(name)
      if (!md) continue
      const truth = md.maxStateId - md.minStateId + 1
      const { product, unknowns, dynUnknowns } = derivedCount(cls)
      const un = [...new Set(unknowns.filter((u) => !solved.has(u)))]
      if (dynUnknowns.length === 0 && un.length === 1 && unknowns.filter((u) => u === un[0]).length === 1) {
        const v = truth / product
        if (Number.isInteger(v) && v >= 1) {
          solved.set(un[0], v)
          const pc = propCard.get(un[0]) || { name: null, card: null }
          pc.card = v
          propCard.set(un[0], pc)
          progress = true
        }
      } else if (un.length === 0 && dynUnknowns.length === 1 && !factorPoisoned.has(dynUnknowns[0])) {
        const v = truth / product
        if (Number.isInteger(v) && v >= 1) {
          if (!factorCand.has(dynUnknowns[0])) factorCand.set(dynUnknowns[0], new Set())
          factorCand.get(dynUnknowns[0]).add(v)
        } else {
          factorPoisoned.add(dynUnknowns[0]) // non-integer: body not a clean factor
        }
      }
    }
    for (const [dc, vals] of factorCand) {
      if (factorPoisoned.has(dc)) continue
      if (vals.size === 1) { dynFactor.set(dc, [...vals][0]); progress = true } else {
        factorPoisoned.add(dc) // instances disagree: instance-dependent body
      }
    }
  }
  if (dynFactor.size) {
    console.log('solved dynamic-body factors:',
      JSON.stringify([...dynFactor].map(([c, f]) => `${c.split('/').pop()}=${f}`)))
  }
  if (factorPoisoned.size) {
    console.log('poisoned dynamic classes (abstain):', [...factorPoisoned].join(', '))
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
    const { product, unknowns, dynUnknowns } = derivedCount(cls)
    if (dynUnknowns.length) { abstain++; abstainNames.push(name); continue }
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
  const propsCopyAll = [] // every static copy factory (one on 1.20.1; ofFullCopy + ofLegacyCopy on 1.21+)
  for (const m of propsParsed.codes) {
    if (m.desc === `()L${PROPS_CLS};` && (m.flags & 0x0008)) propsOf.push(m.method) // static of()
    if (m.desc === `(L${BEHAVIOUR_CLS};)L${PROPS_CLS};` && (m.flags & 0x0008)) propsCopyAll.push(m.method)
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
    propsCopy: propsCopyAll.length === 1 ? propsCopyAll[0] : propsCopyAll,
    registryRegister: registerMethods
  }
  console.log('ids:', JSON.stringify(ids, null, 1))

  // ---- 8. emit srg tables + translate to intermediary ---------------------
  // emit contributions with canonical (declaring-class) property keys so the
  // runtime table lookups are direct
  const classContribCanon = {}
  for (const [c, v] of Object.entries(classContrib)) {
    const f = v.dynamic && !factorPoisoned.has(c) ? dynFactor.get(c) : null
    classContribCanon[c] = f != null
      // solved dynamic body: the factor subsumes the WHOLE body (incl. its
      // partially-visible props), so props are dropped for this class
      ? { callsSuper: v.callsSuper, props: [], contribFactor: f }
      : {
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

  // HF58b STATE INDEX: the value ORDER of every property, so a state id
  // names its property values. kind/min come from the create call the
  // bytecode shows; the value list comes from minecraft-data (keyed by
  // property name + cardinality, kept only when every vanilla block that
  // uses that pair agrees - 'facing'/4 is the horizontal set everywhere,
  // 'facing'/6 the full set). Ints and bools need no list (ascending /
  // [true, false] by the vanilla Property contracts).
  for (const [k, v] of propCard) {
    const raw = propRaw.get(k)
    if (raw && raw.kind === 'value' && raw.propKind) {
      v.kind = raw.propKind
      if (raw.min != null) v.min = raw.min
    } else if (raw && (raw.kind === 'enumAll' || raw.kind === 'unsolved')) v.kind = 'enum'
    if (v.kind === 'enum' && v.name && v.card != null) {
      const vi = valueIndex.get(`${v.name}#${v.card}`)
      if (vi && vi !== 'ambiguous' && vi.type === 'enum') v.values = vi.values
    }
  }
  // unsolved property cardinalities (no vanilla instance pinned them): a
  // mod class reading one abstains at runtime - named here so the table's
  // blind spots are visible
  const unsolvedKeys = [...propCard].filter(([, v]) => v.card == null).map(([k]) => k)
  const unsolvedUsed = Object.entries(classContrib).filter(([, v]) => v.props.some((pk) => unsolvedKeys.includes(canonPropKey(pk)))).map(([c]) => c.split('/').pop())
  console.log(`unsolved property cardinalities: ${unsolvedKeys.length} (${unsolvedKeys.map((k) => k.split('/').pop()).join(', ')}); classes reading them: ${unsolvedUsed.join(', ') || 'none'}`)
  const eraTables = {
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
        propDirection: jar.get(`${P}DirectionProperty`) ? `${P}DirectionProperty` : null,
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
  return { tables: eraTables, ok, total: nameToClass.size, failures }
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
      }),
      // abstain/factor semantics MUST survive translation: dropping `dynamic`
      // here would make intermediary-era subclasses of loop-driven classes
      // MISCOUNT (missing contribution) instead of abstaining
      ...(v.dynamic ? { dynamic: true } : {}),
      ...(v.contribFactor != null ? { contribFactor: v.contribFactor } : {})
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

// -- FriendlyByteBuf write vocabulary (HF48-P2) -----------------------------
// proguard member lines of one Mojang class: "    [l:l:]ret name(args) -> obf"
function parseProguardMembers (text, mojClass) {
  const dotted = mojClass.replace(/\//g, '.')
  const out = []
  let inClass = false
  for (const line of text.split('\n')) {
    if (!line.startsWith(' ')) { inClass = line.startsWith(dotted + ' -> '); continue }
    if (!inClass) continue
    const m = line.match(/^\s+(?:\d+:\d+:)?(\S+) (\S+)\((.*)\) -> (\S+)$/)
    if (m) out.push({ ret: m[1], name: m[2], args: m[3] ? m[3].split(',') : [], obf: m[4] })
  }
  return out
}

// a proguard (Java-source) type -> JVM descriptor in OBF class names
function jvmType (t, classMojToObf) {
  let dims = 0
  while (t.endsWith('[]')) { dims++; t = t.slice(0, -2) }
  const prim = { void: 'V', boolean: 'Z', byte: 'B', char: 'C', short: 'S', int: 'I', long: 'J', float: 'F', double: 'D' }[t]
  const inner = prim || ('L' + (classMojToObf.get(t.replace(/\./g, '/')) || t.replace(/\./g, '/')) + ';')
  return '['.repeat(dims) + inner
}

// tsrg2 members keyed by obf class: "obfName#obfDesc" -> srg name
function parseTsrgByClass (text) {
  const byClass = new Map()
  let cur = null
  for (const line of text.split('\n').slice(1)) {
    if (!line || line.startsWith('\t\t')) continue
    if (!line.startsWith('\t')) { cur = new Map(); byClass.set(line.trim().split(/\s+/)[0], cur); continue }
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 3 && parts[1].startsWith('(')) cur.set(`${parts[0]}#${parts[1]}`, parts[2])
  }
  return byClass
}

function friendlyByteBufWriteVocab (mojmapText, tsrgText, tiny, classMojToObf) {
  const byClass = parseTsrgByClass(tsrgText)
  const srg = {}
  const intermediary = {}
  for (const mojClass of [FBB_CLS, REGISTRY_FBB_CLS]) {
    const obfClass = classMojToObf.get(mojClass)
    if (!obfClass) continue
    const members = parseProguardMembers(mojmapText, mojClass)
    const tsrgMembers = byClass.get(obfClass) || new Map()
    for (const mojang of Object.keys(WRITES)) {
      for (const m of members) {
        if (m.name !== mojang) continue
        const desc = `(${m.args.map((a) => jvmType(a.trim(), classMojToObf)).join('')})${jvmType(m.ret, classMojToObf)}`
        const unobf = m.obf === mojang // netty override: no obfuscation, its own name in every era
        const srgName = unobf ? mojang : tsrgMembers.get(`${m.obf}#${desc}`)
        const interName = unobf ? mojang : tiny.methods.get(`${obfClass}#${m.obf}#${desc}`)
        if (!srgName) console.warn(`no tsrg line for ${mojClass}.${mojang}${desc} (obf ${m.obf}); srg vocabulary skips it`)
        if (!interName) console.warn(`no tiny line for ${mojClass}.${mojang}${desc} (obf ${m.obf}); intermediary vocabulary skips it`)
        if (srgName && !(srg[mojang] || []).includes(srgName)) (srg[mojang] = srg[mojang] || []).push(srgName)
        if (interName && !(intermediary[mojang] || []).includes(interName)) (intermediary[mojang] = intermediary[mojang] || []).push(interName)
      }
    }
  }
  return { srg, intermediary }
}

main()
