// HF9 — the ANNOTATION-REGISTRY derivation shape (content-mod join,
// owner-ordered 2026-08-30: "we just need the bot to join and do the basic
// things a vanilla player can do").
//
// THE SHAPE (read from the Pixelmon 9.4.0 universal jar's shipped bytecode —
// PacketRegistry.registerPacket, javap-verified; the same idiom appears twice
// in that jar, pixelmon + tcg): a RegisterPayloadHandlersEvent subscriber
// registers its payloads REFLECTIVELY —
//
//   for (Class<?> k : SUPPLIERS.keySet())            // keys: <clinit> ldc
//     PacketInfo a = k.getAnnotation(PacketInfo.class)
//     Type t = new Type(Helper.ns(k.getSimpleName())) // ns + toLowerCase
//     switch (a.value()[i])                           // $SwitchMap idiom
//       case CONFIGURATION_TO_CLIENT: registrar.configurationToClient(t,..)
//       ...
//
// No straight-line interpreter can see those registrations (the ids and
// directions live in class METADATA, not in the registration site's constant
// flow) — but every quantity is still a static fact of the class files:
//
//   - the ANNOTATION TYPE: the ldc class constant fed to getAnnotation;
//   - the ID FORMULA: getSimpleName() -> a (String)->ResourceLocation helper
//     whose chased body proves the namespace constant AND the toLowerCase
//     transform (ResourceLocation.fromNamespaceAndPath(ns.toLowerCase(...),
//     path.toLowerCase(...)) / tryParse(lowered));
//   - the DIRECTION MAP: javac's enum-switch idiom — the $SwitchMap holder's
//     <clinit> maps enum CONST -> case index (getstatic CONST / ordinal /
//     iconst k / iastore), and each switch arm names the PayloadRegistrar
//     method it invokes. Composing the two maps CONST -> {protocols, flow}
//     with NeoForge's own registrar semantics — the mod's constant NAMES are
//     never trusted, only its own dispatch bytecode;
//   - the CENSUS: classes bearing the annotation (RuntimeVisibleAnnotations
//     is class-file data), intersected with the site <clinit>'s ldc class
//     constants (the supplier-map keys) — a class outside the map never
//     registers, so it is never claimed;
//   - the ACK CONTRACTS: a configuration-to-client payload class whose
//     handler replies `new R(T.TYPE.id())` proves, from bytecode, the reply
//     payload class R, the task-TYPE field it names, and (via T's <clinit>)
//     the task id string. R must itself be a census class registered
//     configuration-to-server — we never send a payload the jar does not
//     prove serverbound. The wire bytes of the ack follow the registry's own
//     codec idiom (encode = writeUtf(class.getName()) + payload fields;
//     FinishSync's field = writeUtf(taskId)) — utf8-string sequences, exact.
//   - the TASK CENSUS: RegisterConfigurationTasksEvent subscribers in the
//     same jar name the task classes they register (new <Task> ... register).
//     A registered task with NO ack contract is a join the mod's own
//     protocol cannot finish headlessly — surfaced as unfinishableTasks
//     (the honest-refusal input), never silently wedged.
//
// ABSTAIN LAW (loginAckDerivation.js, verbatim): every quantity is proven
// from bytecode or the derivation abstains. An unproven namespace, an
// unmatched switch arm, an unresolvable task string — each abstains LOUDLY
// (state.diagnostics.abstains) and contributes nothing to claims or acks.
//
// PRIVACY: LOCAL-ONLY, READ-ONLY, PURPOSE-LIMITED — same laws as the rest of
// this lib. Class files are parsed, never classloaded or executed.
'use strict'

const debug = require('../../debug')
const { decodeInstructions, walkBytecode, cpRef, cpUtf8 } = require('./jarAnalysis')

const EVENT_TYPE = 'net/neoforged/neoforge/network/event/RegisterPayloadHandlersEvent'
const TASKS_EVENT_TYPE = 'net/neoforged/neoforge/network/event/RegisterConfigurationTasksEvent'
const REGISTRAR_TYPE = 'net/neoforged/neoforge/network/registration/PayloadRegistrar'
const PAYLOAD_TYPE_CLASS = 'net/minecraft/network/protocol/common/custom/CustomPacketPayload$Type'
const CONFIG_TASK_TYPE_DESC = 'Lnet/minecraft/server/network/ConfigurationTask$Type;'
const CONFIG_TASK_TYPE_CLASS = 'net/minecraft/server/network/ConfigurationTask$Type'

// PayloadRegistrar registration methods -> {protocols, flow} (NeoForge
// 21.1.248, decompiled — same table as neoForgePayloadDerivation).
const REGISTRATION_METHODS = {
  playToClient: { protocols: ['play'], flow: 'clientbound' },
  playToServer: { protocols: ['play'], flow: 'serverbound' },
  playBidirectional: { protocols: ['play'], flow: null },
  configurationToClient: { protocols: ['configuration'], flow: 'clientbound' },
  configurationToServer: { protocols: ['configuration'], flow: 'serverbound' },
  configurationBidirectional: { protocols: ['configuration'], flow: null },
  commonToClient: { protocols: ['play', 'configuration'], flow: 'clientbound' },
  commonToServer: { protocols: ['play', 'configuration'], flow: 'serverbound' },
  commonBidirectional: { protocols: ['play', 'configuration'], flow: null }
}

function simpleNameOf (internalName) {
  const afterSlash = internalName.slice(internalName.lastIndexOf('/') + 1)
  return afterSlash.slice(afterSlash.lastIndexOf('$') + 1)
}

function dottedNameOf (internalName) {
  return internalName.replace(/\//g, '.')
}

// --- switch decoding (tableswitch/lookupswitch operands) --------------------
// decodeInstructions models opcodes + cp operands but not switch tables; the
// jump tables are read here directly (JVMS 6.5, 4-aligned operands).
function decodeSwitchAt (code, pc) {
  const op = code[pc]
  const base = (pc + 4) & ~3
  if (op === 0xaa) { // tableswitch
    const def = code.readInt32BE(base)
    const low = code.readInt32BE(base + 4)
    const high = code.readInt32BE(base + 8)
    const cases = []
    for (let i = 0; i <= high - low; i++) {
      cases.push({ match: low + i, target: pc + code.readInt32BE(base + 12 + i * 4) })
    }
    return { defaultTarget: pc + def, cases }
  }
  if (op === 0xab) { // lookupswitch
    const def = code.readInt32BE(base)
    const n = code.readInt32BE(base + 4)
    const cases = []
    for (let i = 0; i < n; i++) {
      cases.push({
        match: code.readInt32BE(base + 8 + i * 8),
        target: pc + code.readInt32BE(base + 12 + i * 8)
      })
    }
    return { defaultTarget: pc + def, cases }
  }
  return null
}

// --- the id-formula proof ---------------------------------------------------
// Chases a (String)->ResourceLocation helper for its namespace constant and
// the lowercase transform. Depth-bounded (<=2 hops: ns(String) -> of(ns,
// String) -> ResourceLocation factory). Returns {namespace} or null.
function chaseNamespaceHelper (index, owner, name, desc, depth = 0) {
  if (depth > 2) return null
  const info = index.get(owner)
  if (!info) return null
  const method = info.codes.find((m) => m.method === name && m.desc === desc)
  if (!method) return null
  const rows = decodeInstructions(method.code, info.cp)
  let namespace = null
  let sawLower = false
  let sawFactory = false
  let next = null
  for (const row of rows) {
    if ((row.op === 0x12 || row.op === 0x13) && typeof row.str === 'string') {
      if (namespace === null) namespace = row.str
      else if (namespace !== row.str) return null // ambiguous constants: abstain
    }
    if ((row.op === 0xb6 || row.op === 0xb8 || row.op === 0xb9) && row.ref) {
      if (row.ref.name === 'toLowerCase') sawLower = true
      if (row.ref.owner === 'net/minecraft/resources/ResourceLocation' &&
          ['fromNamespaceAndPath', 'tryParse', 'parse', 'of'].includes(row.ref.name)) sawFactory = true
      if (row.op === 0xb8 && row.ref.desc && row.ref.desc.endsWith(')Lnet/minecraft/resources/ResourceLocation;') &&
          row.ref.owner !== 'net/minecraft/resources/ResourceLocation') {
        next = row.ref
      }
    }
  }
  if (sawFactory && sawLower && namespace) return { namespace }
  if (next) {
    const chased = chaseNamespaceHelper(index, next.owner, next.name, next.desc, depth + 1)
    if (chased) return chased
    // the hop below may carry the factory+lowercase while THIS frame carries
    // the namespace constant (Pixelmon: pixelmon(String) has the ldc, of(
    // String,String) has toLowerCase+fromNamespaceAndPath).
    if (namespace) {
      const sub = chaseHelperTransform(index, next.owner, next.name, next.desc)
      if (sub) return { namespace }
    }
  }
  return null
}

function chaseHelperTransform (index, owner, name, desc) {
  const info = index.get(owner)
  if (!info) return false
  const method = info.codes.find((m) => m.method === name && m.desc === desc)
  if (!method) return false
  let sawLower = false
  let sawFactory = false
  for (const row of decodeInstructions(method.code, info.cp)) {
    if ((row.op === 0xb6 || row.op === 0xb8) && row.ref) {
      if (row.ref.name === 'toLowerCase') sawLower = true
      if (row.ref.owner === 'net/minecraft/resources/ResourceLocation' &&
          ['fromNamespaceAndPath', 'tryParse', 'parse', 'of'].includes(row.ref.name)) sawFactory = true
    }
  }
  return sawLower && sawFactory
}

// --- $SwitchMap holder: enum CONST -> case index ----------------------------
function readSwitchMapHolder (index, holderOwner, holderField) {
  const info = index.get(holderOwner)
  if (!info) return null
  const clinit = info.codes.find((m) => m.method === '<clinit>')
  if (!clinit) return null
  const rows = decodeInstructions(clinit.code, info.cp)
  const map = Object.create(null)
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    // pattern (javac): getstatic <Enum>.<CONST> / invokevirtual ordinal /
    // iconst k / iastore — the NoSuchFieldError try/catch scaffolding between
    // assignments never matches this 4-row window.
    if (r.op !== 0xb2 || !r.ref || !r.ref.desc || !r.ref.desc.startsWith('L')) continue
    const a = rows[i + 1]; const b = rows[i + 2]; const c = rows[i + 3]
    if (!a || a.op !== 0xb6 || !a.ref || a.ref.name !== 'ordinal') continue
    if (!b || typeof b.int !== 'number') continue
    if (!c || c.op !== 0x4f) continue // iastore
    map[r.ref.name] = { caseIndex: b.int, enumClass: r.ref.owner }
  }
  return Object.keys(map).length > 0 ? { field: holderField, map } : null
}

// Resolves a ConfigurationTask$Type static field to its id STRING via the
// owning class's <clinit>: new Type / dup / ldc "<id>" / invokespecial
// <init>(String) / putstatic <field>. Returns the string or null.
function resolveTaskTypeString (index, owner, fieldName) {
  const info = index.get(owner)
  if (!info) return null
  const clinit = info.codes.find((m) => m.method === '<clinit>')
  if (!clinit) return null
  const rows = decodeInstructions(clinit.code, info.cp)
  let pendingStr = null
  let inTypeCtor = false
  for (const row of rows) {
    if (row.op === 0xbb && row.cls === CONFIG_TASK_TYPE_CLASS) { inTypeCtor = true; pendingStr = null; continue }
    if (inTypeCtor && (row.op === 0x12 || row.op === 0x13) && typeof row.str === 'string') { pendingStr = row.str; continue }
    if (inTypeCtor && row.op === 0xb7 && row.ref && row.ref.owner === CONFIG_TASK_TYPE_CLASS && row.ref.name === '<init>') {
      if (row.ref.desc !== '(Ljava/lang/String;)V') { pendingStr = null } // Type(ResourceLocation) etc: unprovable here
      continue
    }
    if (row.op === 0xb3 && row.ref && row.ref.name === fieldName && row.ref.desc === CONFIG_TASK_TYPE_DESC) {
      return pendingStr
    }
    if (row.op === 0xb3) { inTypeCtor = false; pendingStr = null }
  }
  return null
}

// --- the reply-ack contract proof -------------------------------------------
// Scans a payload class for the reply shape:
//   new R / dup / getstatic <Task>.TYPE:ConfigurationTask$Type /
//   invokevirtual Type.id() / invokespecial R.<init>(String) / ... reply(...)
// Returns {replyClass, taskField: {owner, name}} or null.
function findReplyShape (index, payloadClass) {
  const info = index.get(payloadClass)
  if (!info) return null
  for (const method of info.codes) {
    const rows = decodeInstructions(method.code, info.cp)
    let pendingNew = null
    let pendingTaskField = null
    let sawTypeId = false
    let candidate = null
    for (const row of rows) {
      if (row.op === 0xbb && row.cls) { pendingNew = row.cls; pendingTaskField = null; sawTypeId = false; continue }
      if (row.op === 0xb2 && row.ref && row.ref.desc === CONFIG_TASK_TYPE_DESC) { pendingTaskField = { owner: row.ref.owner, name: row.ref.name }; continue }
      if (row.op === 0xb6 && row.ref && row.ref.owner === CONFIG_TASK_TYPE_CLASS && row.ref.name === 'id') { sawTypeId = true; continue }
      if (row.op === 0xb7 && row.ref && row.ref.name === '<init>' && row.ref.desc === '(Ljava/lang/String;)V' &&
          row.ref.owner === pendingNew && pendingTaskField && sawTypeId) {
        candidate = { replyClass: pendingNew, taskField: pendingTaskField }
        continue
      }
      if (candidate && (row.op === 0xb6 || row.op === 0xb9) && row.ref && row.ref.name === 'reply') {
        return candidate
      }
    }
  }
  return null
}

// --- the derivation ---------------------------------------------------------

/**
 * Post-pass over the entry methods (RegisterPayloadHandlersEvent takers):
 * detects the annotation-registry idiom, proves its formula pieces, and
 * derives channel components + config-phase sync-ack contracts.
 *
 * @returns {{components: Array, syncContracts: {contracts, consumeOnly,
 *            unfinishableTasks, registries}}}
 */
function deriveAnnotationRegistries (index, state, entryMethods) {
  const abstain = (msg) => state.diagnostics.abstains.push(msg)
  const components = []
  const contracts = []
  const consumeOnly = []
  const registries = []
  const siteJars = new Set()
  const contractTaskOwners = new Set()
  const seenSites = new Set()

  for (const { info: entryInfo, method: entryMethod } of entryMethods) {
    const siteClass = entryInfo.className
    if (seenSites.has(siteClass)) continue
    seenSites.add(siteClass)

    // 1. the reflective idiom method (may be the entry method itself)
    let idiom = null
    for (const m of entryInfo.codes) {
      const rows = decodeInstructions(m.code, entryInfo.cp)
      let getAnno = false; let getSimple = false; let typeCtor = false; let registrarInvoke = false; let hasSwitch = false
      for (const row of rows) {
        if (row.op === 0xb6 && row.ref && row.ref.owner === 'java/lang/Class') {
          if (row.ref.name === 'getAnnotation') getAnno = true
          if (row.ref.name === 'getSimpleName') getSimple = true
        }
        if (row.op === 0xbb && row.cls === PAYLOAD_TYPE_CLASS) typeCtor = true
        if (row.op === 0xb6 && row.ref && row.ref.owner === REGISTRAR_TYPE && REGISTRATION_METHODS[row.ref.name]) registrarInvoke = true
        if (row.op === 0xaa || row.op === 0xab) hasSwitch = true
      }
      if (getAnno && getSimple && typeCtor && registrarInvoke && hasSwitch) { idiom = { method: m, rows } ; break }
    }
    if (!idiom) continue // not this shape; the interpreter shapes own the site

    const site = `${siteClass}.${idiom.method.method}`

    // 2a. annotation type: the last ldc class constant before getAnnotation
    let annotationCls = null
    {
      let lastCls = null
      for (const row of idiom.rows) {
        if ((row.op === 0x12 || row.op === 0x13) && row.cls) lastCls = row.cls
        if (row.op === 0xb6 && row.ref && row.ref.owner === 'java/lang/Class' && row.ref.name === 'getAnnotation') {
          annotationCls = lastCls
          break
        }
      }
    }
    if (!annotationCls) { abstain(`${site}: annotation-registry idiom without a provable annotation class`); continue }

    // 2b. id formula: the (String)->ResourceLocation helper fed by
    // getSimpleName, chased for namespace + lowercase proof
    let namespace = null
    {
      let sawSimple = false
      for (const row of idiom.rows) {
        if (row.op === 0xb6 && row.ref && row.ref.owner === 'java/lang/Class' && row.ref.name === 'getSimpleName') sawSimple = true
        if (sawSimple && row.op === 0xb8 && row.ref && row.ref.desc === '(Ljava/lang/String;)Lnet/minecraft/resources/ResourceLocation;') {
          const chased = chaseNamespaceHelper(index, row.ref.owner, row.ref.name, row.ref.desc)
          if (chased) namespace = chased.namespace
          break
        }
      }
    }
    if (!namespace) { abstain(`${site}: id-formula helper did not prove a namespace + lowercase transform`); continue }

    // 2c. direction map: $SwitchMap holder x switch arms
    let directionByConst = null
    let switchEnumClass = null
    {
      let holder = null
      let ordinalOwner = null
      for (const row of idiom.rows) {
        if (row.op === 0xb2 && row.ref && row.ref.name && row.ref.name.startsWith('$SwitchMap$')) holder = row.ref
        if (row.op === 0xb6 && row.ref && row.ref.name === 'ordinal' && row.ref.desc === '()I') ordinalOwner = row.ref.owner
      }
      let sw = null
      let swPc = -1
      walkBytecode(idiom.method.code, (op, pc) => {
        if (sw || (op !== 0xaa && op !== 0xab)) return
        sw = decodeSwitchAt(idiom.method.code, pc)
        swPc = pc
      })
      if (holder && ordinalOwner && sw) {
        const holderMap = readSwitchMapHolder(index, holder.owner, holder.name)
        if (holderMap) {
          // arm k -> registrar method: first registrar invoke between the
          // case target and the next case target (sorted by pc)
          const targets = sw.cases.map((c) => c.target).concat([sw.defaultTarget]).sort((a, b) => a - b)
          const armMethodAt = (target) => {
            const end = targets.find((t) => t > target) ?? idiom.method.code.length
            let found = null
            for (const row of idiom.rows) {
              if (row.pc < target || row.pc >= end) continue
              if (row.op === 0xb6 && row.ref && row.ref.owner === REGISTRAR_TYPE && REGISTRATION_METHODS[row.ref.name]) { found = row.ref.name; break }
            }
            return found
          }
          const byConst = Object.create(null)
          for (const [constName, { caseIndex, enumClass }] of Object.entries(holderMap.map)) {
            if (enumClass !== ordinalOwner) continue // holder for a different enum: not this switch
            const kase = sw.cases.find((c) => c.match === caseIndex)
            if (!kase) continue // const maps to the default arm: unregistered direction
            const armMethod = armMethodAt(kase.target)
            if (armMethod) byConst[constName] = { method: armMethod, ...REGISTRATION_METHODS[armMethod] }
          }
          if (Object.keys(byConst).length > 0) { directionByConst = byConst; switchEnumClass = ordinalOwner }
        }
      }
    }
    if (!directionByConst) { abstain(`${site}: direction switch did not prove an enum->registrar mapping`); continue }

    // 2d. registrar version + optional from the ENTRY method
    let version = null
    let optional = false
    {
      const entryRows = decodeInstructions(entryMethod.code, entryInfo.cp)
      let lastStr = null
      for (const row of entryRows) {
        if ((row.op === 0x12 || row.op === 0x13) && typeof row.str === 'string') lastStr = row.str
        if (row.op === 0xb6 && row.ref && row.ref.owner === EVENT_TYPE && row.ref.name === 'registrar') version = version ?? lastStr
        if (row.op === 0xb6 && row.ref && row.ref.owner === REGISTRAR_TYPE && row.ref.name === 'optional') optional = true
      }
    }
    if (version === null && entryInfo.jar && entryInfo.jar.modVersion) version = entryInfo.jar.modVersion
    if (version === null) { abstain(`${site}: annotation registry with no derivable registrar version`); continue }

    // 3. census: annotated classes ∩ site-<clinit> class constants
    const clinitCensus = new Set()
    for (const m of entryInfo.codes) {
      if (m.method !== '<clinit>') continue
      for (const row of decodeInstructions(m.code, entryInfo.cp)) {
        if ((row.op === 0x12 || row.op === 0x13) && row.cls) clinitCensus.add(row.cls)
      }
    }
    const annotationDescriptor = `L${annotationCls};`
    const annotationDescBytes = Buffer.from(annotationDescriptor, 'utf8')
    const siteJar = entryInfo.jar ? entryInfo.jar.label : null
    if (siteJar) siteJars.add(siteJar)
    const censusClasses = []
    for (const name of state.allClassNames) {
      if (clinitCensus.size > 0) {
        if (!clinitCensus.has(name)) continue
      } else {
        const rawInfo = index.raw.get(name)
        if (!rawInfo || !rawInfo.jar || rawInfo.jar.label !== siteJar) continue
      }
      const bytes = index.rawBytes(name)
      if (!bytes || !bytes.includes(annotationDescBytes)) continue
      const parsed = index.get(name)
      if (!parsed || !Array.isArray(parsed.annotations)) continue
      const anno = parsed.annotations.find((a) => a && a.type === annotationDescriptor)
      if (!anno) continue
      const value = anno.elements && anno.elements.value
      if (!Array.isArray(value)) continue
      const consts = value
        .filter((v) => v && v.enumType === `L${switchEnumClass};` && typeof v.constName === 'string')
        .map((v) => v.constName)
      if (consts.length > 0) censusClasses.push({ name, consts })
    }
    if (censusClasses.length === 0) { abstain(`${site}: annotation registry with an empty provable census`); continue }

    registries.push({ site, namespace, version, optional, annotation: annotationCls, classes: censusClasses.length })
    debug(`annotation-registry: ${site} -> ns=${namespace} version=${version} optional=${optional} census=${censusClasses.length}`)

    // 4. components
    const idOf = (cls) => `${namespace}:${simpleNameOf(cls).toLowerCase()}`
    const clientboundConfigClasses = []
    for (const { name, consts } of censusClasses) {
      const id = idOf(name)
      for (const constName of consts) {
        const spec = directionByConst[constName]
        if (!spec) { abstain(`${id}: direction ${constName} has no proven registrar mapping — that registration is unclaimed`); continue }
        components.push({
          id,
          version,
          flow: spec.flow,
          optional,
          protocols: spec.protocols,
          source: `annotation-registry ${site}`,
          className: dottedNameOf(name)
        })
        if (spec.flow === 'clientbound' && spec.protocols.includes('configuration')) {
          clientboundConfigClasses.push(name)
        }
      }
    }

    // 5. ack contracts for configuration-to-client payloads
    const censusByName = new Map(censusClasses.map((c) => [c.name, c.consts]))
    for (const cls of clientboundConfigClasses) {
      const shape = findReplyShape(index, cls)
      if (!shape) { consumeOnly.push(idOf(cls)); continue }
      const replyConsts = censusByName.get(shape.replyClass)
      const replyServerbound = Array.isArray(replyConsts) && replyConsts.some((cn) => {
        const spec = directionByConst[cn]
        return spec && spec.flow === 'serverbound' && spec.protocols.includes('configuration')
      })
      if (!replyServerbound) {
        abstain(`${idOf(cls)}: reply class ${shape.replyClass} is not a census configuration-to-server payload — ack withheld`)
        consumeOnly.push(idOf(cls))
        continue
      }
      const taskId = resolveTaskTypeString(index, shape.taskField.owner, shape.taskField.name)
      if (!taskId) {
        abstain(`${idOf(cls)}: task type ${shape.taskField.owner}.${shape.taskField.name} has no derivable id string — ack withheld`)
        consumeOnly.push(idOf(cls))
        continue
      }
      contractTaskOwners.add(shape.taskField.owner)
      contracts.push({
        channel: idOf(cls),
        taskId,
        taskClass: dottedNameOf(shape.taskField.owner),
        reply: {
          channel: idOf(shape.replyClass),
          // the registry codec idiom: writeUtf(class.getName()) + writeUtf(id)
          strings: [dottedNameOf(shape.replyClass), taskId]
        }
      })
    }
  }

  // 6. task census (site jars only): registered configuration tasks with no
  // ack contract are surfaced — a headless client cannot finish them.
  const unfinishableTasks = []
  if (siteJars.size > 0) {
    const tasksEventBytes = Buffer.from(TASKS_EVENT_TYPE, 'utf8')
    for (const name of state.allClassNames) {
      const rawInfo = index.raw.get(name)
      if (!rawInfo || !rawInfo.jar || !siteJars.has(rawInfo.jar.label)) continue
      const bytes = index.rawBytes(name)
      if (!bytes || !bytes.includes(tasksEventBytes)) continue
      const parsed = index.get(name)
      if (!parsed) continue
      for (const m of parsed.codes) {
        if (!m.desc.includes(`L${TASKS_EVENT_TYPE};`)) continue
        for (const row of decodeInstructions(m.code, parsed.cp)) {
          if (row.op !== 0xbb || !row.cls) continue
          const taskCls = row.cls
          if (contractTaskOwners.has(taskCls)) continue
          // only classes that ARE configuration tasks count (direct
          // ConfigurationTask interface or a Type-typed static field) —
          // other `new` sites in the subscriber are not task registrations.
          const parsedTask = index.get(taskCls)
          if (!parsedTask) continue
          const typeField = parsedTask.fields.find((f) => f.desc === CONFIG_TASK_TYPE_DESC)
          const isTask = (parsedTask.interfaces || []).includes('net/minecraft/server/network/ConfigurationTask') || Boolean(typeField)
          if (!isTask) continue
          // resolve for the receipt; unresolvable stays honest ('<owner>')
          const label = typeField ? resolveTaskTypeString(index, taskCls, typeField.name) : null
          unfinishableTasks.push(label || dottedNameOf(taskCls))
        }
      }
    }
  }
  if (unfinishableTasks.length > 0) {
    state.diagnostics.abstains.push(`annotation-registry: ${unfinishableTasks.length} registered configuration task(s) have no derivable finish ack: ${unfinishableTasks.slice(0, 8).join(', ')}`)
  }

  return {
    components,
    syncContracts: {
      contracts,
      consumeOnly,
      unfinishableTasks: [...new Set(unfinishableTasks)],
      registries
    }
  }
}

module.exports = { deriveAnnotationRegistries, REGISTRATION_METHODS }
