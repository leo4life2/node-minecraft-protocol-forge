// HF105 item B — THE PLATFORM HELPER shape: a library registers payloads at
// runtime from the list each mod hands it. The mod's call site is
//   <helper>.addNetworkRegistration(consumer, int)   (desc (Ljava/util/function/Consumer;I)V)
// where `consumer` is the mod's lambda over the helper's registration event
// and the int is the mod's protocol version. The helper's entry captures both
// into a listener lambda that constructs ONE registrar object (an anonymous
// class) and hands it to the consumer; each registrar method takes the mod's
// CustomPacketPayload$TypeAndCodec and performs the loader registration:
//   event.registrar(...).versioned(<the int as a String>)[.optional()].playToX(arg.type(), arg.codec(), handler)
// The id is therefore the ARGUMENT's own type id (built in the message class's
// static initializer through the mod's namespace helper), the flow is the
// PayloadRegistrar method the registrar method invokes, the version is the
// call site's int folded through the listener lambda's concat recipe, and
// optionality is the registrar method's own .optional() call.
//
// Pre-HF105 the linear and deep walks reached the registrar's methods with an
// UNRESOLVED payload type (a parameter) and the consumer lambdas were never
// followed (F39 Case B: 53 server-named ids, none in the claim). This walk
// reads the shape from the bytes of the fixture jars cited in
// data/platformHelperPatterns.json; every rule it applies (the entry
// descriptor, the id rule, the version rule, the source word) is a row of
// that table and is VERIFIED against the helper's bytes before any row is
// claimed: a helper whose registrar does not register the argument's own
// type, or whose version is not the call site's int, abstains by name.
// Pure local bytecode parsing (jarAnalysis + the main module's helpers,
// injected); no I/O, no network.
const { cpUtf8, cpClassName, cpRef, resolveLambdaImpl } = require('./jarAnalysis')
const PATTERNS = require('./data/platformHelperPatterns.json')

const REGISTRAR_TYPE = 'net/neoforged/neoforge/network/registration/PayloadRegistrar'
const TYPE_AND_CODEC = 'net/minecraft/network/protocol/common/custom/CustomPacketPayload$TypeAndCodec'
const PAYLOAD_TYPE = 'net/minecraft/network/protocol/common/custom/CustomPacketPayload$Type'
const MAX_FORWARD_DEPTH = 3

function ldcIndex (op, code, pc) { return op === 0x12 ? code[pc + 1] : code.readUInt16BE(pc + 1) }

function intConstOf (op, code, pc, cp) {
  if (op >= 0x02 && op <= 0x08) return op - 0x03
  if (op === 0x10) return code.readInt8(pc + 1)
  if (op === 0x11) return code.readInt16BE(pc + 1)
  if (op === 0x12 || op === 0x13) { const c = cp[ldcIndex(op, code, pc)]; if (c && c.tag === 3) return c.int }
  return null
}

/**
 * The helper shape behind `owner.name(desc)`: follows same-shaped static
 * forwarders, finds the listener lambda, the registrar class it constructs,
 * the version recipe and the registrar's method table. Cached per entry.
 */
function resolveHelperShape (index, state, pattern, owner, name, desc, h, depth = 0) {
  const key = `${owner}.${name}${desc}`
  if (state.platformHelperCache.has(key)) return state.platformHelperCache.get(key)
  state.platformHelperCache.set(key, null)
  const info = index.get(owner)
  const m = info && info.codes.find((c) => c.method === name && c.desc === desc && c.code)
  if (!m) return null
  let forward = null
  let listener = null
  const indyInfos = []
  h.walkLinear(m.code, info.cp, (op, pc, cp, code) => {
    if (op === 0xb8) {
      const ref = cpRef(cp, code.readUInt16BE(pc + 1))
      if (ref && ref.desc === desc && !(ref.owner === owner && ref.name === name)) forward = ref
    } else if (op === 0xba && info.bootstrapMethods) {
      const c = cp[code.readUInt16BE(pc + 1)]
      const impl = c && resolveLambdaImpl(info, c.bsmIndex)
      if (impl) indyInfos.push(impl)
    }
  })
  let result = null
  if (forward && depth < MAX_FORWARD_DEPTH && indyInfos.length === 0) {
    result = resolveHelperShape(index, state, pattern, forward.owner, forward.name, forward.desc, h, depth + 1)
  } else {
    // the listener lambda: the implementation whose descriptor carries the int and the consumer (captured) plus the event
    listener = indyInfos.find((i) => i.owner === owner && /^\(ILjava\/util\/function\/Consumer;L[^;]+;\)V$/.test(i.desc)) || null
    const lm = listener && info.codes.find((c) => c.method === listener.name && c.desc === listener.desc && c.code)
    if (lm) {
      let registrarClass = null
      let versionRecipe = null // { kind: 'concat', bsmIndex } | { kind: 'string-of-int' }
      h.walkLinear(lm.code, info.cp, (op, pc, cp, code) => {
        if (op === 0xbb) {
          const cls = cpClassName(cp, code.readUInt16BE(pc + 1))
          if (cls && !registrarClass) registrarClass = cls
        } else if (op === 0xba && info.bootstrapMethods) {
          const c = cp[code.readUInt16BE(pc + 1)]
          const bsm = c && info.bootstrapMethods[c.bsmIndex]
          const nt = c && cp[c.natIndex]
          const indyName = nt ? cpUtf8(cp, nt.nameIndex) : null
          if (indyName === 'makeConcatWithConstants' || (bsm && bsm.ref && bsm.ref.name === 'makeConcatWithConstants')) versionRecipe = { kind: 'concat', bsmIndex: c.bsmIndex }
        } else if (op === 0xb8) {
          const ref = cpRef(cp, code.readUInt16BE(pc + 1))
          if (ref && ref.desc === '(I)Ljava/lang/String;' && (ref.name === 'valueOf' || ref.name === 'toString')) versionRecipe = { kind: 'string-of-int' }
        }
      })
      const table = registrarClass ? registrarMethodTable(index, registrarClass, h) : null
      if (registrarClass && table && Object.keys(table).length > 0 && versionRecipe) {
        result = { owner, name, desc, listenerInfo: info, registrarClass, table, versionRecipe }
      }
    }
  }
  state.platformHelperCache.set(key, result)
  return result
}

/**
 * The registrar class's method table read from ITS bytes: every method taking
 * the TypeAndCodec -> the PayloadRegistrar.play* it invokes, whether the
 * registered type is the ARGUMENT's own (.type() on it), whether .optional()
 * and .versioned(..) are invoked.
 */
function registrarMethodTable (index, cls, h) {
  const info = index.get(cls)
  if (!info) return null
  const table = {}
  for (const m of info.codes) {
    if (!m.code || m.desc !== `(L${TYPE_AND_CODEC};)V`) continue
    let argType = false
    let optional = false
    let versioned = false
    let regMethod = null
    let argLoaded = false
    h.walkLinear(m.code, info.cp, (op, pc, cp, code) => {
      if (op === 0x2b) { argLoaded = true; return } // aload_1
      if (op === 0xb6 || op === 0xb9) {
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        if (!ref) return
        if (ref.owner === TYPE_AND_CODEC && ref.name === 'type' && argLoaded) argType = true
        if (ref.owner === REGISTRAR_TYPE && ref.name === 'optional') optional = true
        if (ref.owner === REGISTRAR_TYPE && ref.name === 'versioned') versioned = true
        if (ref.owner === REGISTRAR_TYPE && h.registrationMethods[ref.name] && ref.desc.startsWith(`(L${PAYLOAD_TYPE};`)) regMethod = ref.name
      }
      if (op !== 0x2b) argLoaded = argLoaded && (op === 0xb6 || op === 0xb9) ? false : argLoaded
    })
    if (regMethod) table[`${m.method}${m.desc}`] = { regMethod, optional, versioned, argType }
  }
  return table
}

/** The ResourceLocation a static TypeAndCodec / Type field is built from, read off the owner's static initializer. */
function reslocOfTypeField (index, state, owner, field, h) {
  const key = `${owner}.${field}`
  if (state.platformHelperFieldIds.has(key)) return state.platformHelperFieldIds.get(key)
  const info = index.get(owner)
  const clinit = info && info.codes.find((c) => c.method === '<clinit>' && c.code)
  const found = Object.create(null)
  if (clinit) {
    const strings = []
    let last = null
    h.walkLinear(clinit.code, info.cp, (op, pc, cp, code) => {
      if (op === 0x12 || op === 0x13) {
        const c = cp[ldcIndex(op, code, pc)]
        if (c && c.tag === 8) strings.push(cpUtf8(cp, c.strIndex))
      } else if (op === 0xb8) {
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        if (!ref) return
        if (h.isStrToReslocDesc(ref.desc)) {
          const helper = h.resolveNamespaceHelper(index, ref.owner, ref.name, ref.desc, state.helperCache)
          const s = strings[strings.length - 1]
          if (helper && typeof s === 'string') last = `${helper.nsPrefix}:${s}`
          else if (h.isReslocOwner(ref.owner) && (ref.name === 'parse' || ref.name === 'tryParse' || ref.name === 'of') && typeof s === 'string' && s.includes(':')) last = s
        } else if (h.isStrStrToReslocDesc(ref.desc) && h.isReslocOwner(ref.owner) && strings.length >= 2) {
          last = `${strings[strings.length - 2]}:${strings[strings.length - 1]}`
        }
      } else if (op === 0xb2) {
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        if (ref && h.isReslocDesc(ref.desc)) {
          const v = h.resolveReslocValue({ k: 'field', owner: ref.owner, name: ref.name, desc: ref.desc })
          if (v) last = v
        }
      } else if (op === 0xb3) {
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        if (ref && (ref.desc === `L${TYPE_AND_CODEC};` || ref.desc === `L${PAYLOAD_TYPE};`)) {
          if (last) found[ref.name] = last
          last = null
          strings.length = 0
        }
      }
    })
  }
  for (const [f, v] of Object.entries(found)) state.platformHelperFieldIds.set(`${owner}.${f}`, v)
  if (!state.platformHelperFieldIds.has(key)) state.platformHelperFieldIds.set(key, null)
  return state.platformHelperFieldIds.get(key)
}

/**
 * The unit's platform-helper registrations: every call site of a helper entry
 * of the pattern's shape in the unit's classes, its consumer lambda followed
 * to the (field, registrar method) pairs, each resolved to a row.
 * @returns {{ rows: Array, abstains: string[], resolvedClasses: Set<string> }}
 */
function derivePlatformHelperRegistrations (index, state, h) {
  const rows = []
  const abstains = []
  const resolvedClasses = new Set()
  state.platformHelperCache = state.platformHelperCache || new Map()
  state.platformHelperFieldIds = state.platformHelperFieldIds || new Map()
  for (const pattern of PATTERNS.patterns || []) {
    if (pattern.shape !== 'consumer-registrar' || typeof pattern.entryDesc !== 'string') continue
    const descBytes = Buffer.from(pattern.entryDesc)
    for (const cls of h.seedNames()) {
      const bytes = index.rawBytes(cls)
      if (!bytes || !bytes.includes(descBytes)) continue
      const info = index.get(cls)
      if (!info) continue
      for (const m of info.codes) {
        if (!m.code) continue
        let lastIndy = null
        let lastInt = null
        h.walkLinear(m.code, info.cp, (op, pc, cp, code) => {
          if (op === 0xba && info.bootstrapMethods) {
            const c = cp[code.readUInt16BE(pc + 1)]
            lastIndy = (c && resolveLambdaImpl(info, c.bsmIndex)) || null
            return
          }
          const iv = intConstOf(op, code, pc, cp)
          if (iv !== null) { lastInt = iv; return }
          if (op !== 0xb8) return
          const ref = cpRef(cp, code.readUInt16BE(pc + 1))
          if (!ref || ref.desc !== pattern.entryDesc) return
          if (m.desc === pattern.entryDesc) return // a same-shaped forwarder (the library's own API front), not a mod's call site
          const site = `${cls}.${m.method}`
          const helper = resolveHelperShape(index, state, pattern, ref.owner, ref.name, ref.desc, h)
          if (!helper) { abstains.push(`${site}: ${ref.owner}.${ref.name} is not the platform-helper shape the table names (no registrar object / no version recipe) — unclaimed`); return }
          if (!lastIndy || lastIndy.owner !== cls || lastInt === null) { abstains.push(`${site}: platform-helper call without a constant version or a same-class consumer lambda — unclaimed`); return }
          const version = versionOf(helper, lastInt, h)
          if (version === null) { abstains.push(`${site}: platform-helper version recipe did not fold the call site's int — unclaimed`); return }
          const lam = info.codes.find((c) => c.method === lastIndy.name && c.desc === lastIndy.desc && c.code)
          if (!lam) { abstains.push(`${site}: consumer lambda ${lastIndy.name} not found — unclaimed`); return }
          let pendingField = null
          let n = 0
          h.walkLinear(lam.code, info.cp, (op2, pc2, cp2, code2) => {
            if (op2 === 0xb2) {
              const f = cpRef(cp2, code2.readUInt16BE(pc2 + 1))
              if (f && f.desc === `L${TYPE_AND_CODEC};`) pendingField = f
              return
            }
            if (op2 !== 0xb9 && op2 !== 0xb6) return
            const call = cpRef(cp2, code2.readUInt16BE(pc2 + 1))
            if (!call || call.desc !== `(L${TYPE_AND_CODEC};)V`) return
            const entry = helper.table[`${call.name}${call.desc}`]
            if (!entry) { pendingField = null; return }
            const field = pendingField
            pendingField = null
            if (!field) { abstains.push(`${site}: ${call.name} with a payload type that is not a static TypeAndCodec field — unclaimed`); return }
            if (pattern.idRule !== 'argument-type-and-codec' || !entry.argType) { abstains.push(`${site}: ${helper.registrarClass}.${call.name} does not register the argument's own type (id rule ${pattern.idRule}) — unclaimed`); return }
            const id = reslocOfTypeField(index, state, field.owner, field.name, h)
            if (!id) { abstains.push(`${site}: ${call.name} with unresolved payload type id (${field.owner}.${field.name}) — unclaimed`); return }
            const spec = h.registrationMethods[entry.regMethod]
            rows.push({
              id,
              version,
              flow: spec.flow,
              optional: !!entry.optional,
              protocols: spec.protocols,
              source: `${pattern.sourceWord} ${helper.owner} via ${site} (${call.name} -> ${entry.regMethod}; version from the call site's int)`,
              jar: info.jar
            })
            n++
          })
          if (n > 0) { resolvedClasses.add(helper.registrarClass); resolvedClasses.add(helper.owner); if (helper.listenerInfo) resolvedClasses.add(helper.listenerInfo.className) }
        })
      }
    }
  }
  return { rows, abstains, resolvedClasses }
}

function versionOf (helper, intValue, h) {
  const r = helper.versionRecipe
  if (!r) return null
  if (r.kind === 'string-of-int') return String(intValue)
  if (r.kind === 'concat') {
    const v = h.concatWithConstants(helper.listenerInfo, r.bsmIndex, [{ k: 'int', v: intValue }])
    return v && v.k === 'str' ? v.v : null
  }
  return null
}

module.exports = { derivePlatformHelperRegistrations, __internals: { resolveHelperShape, registrarMethodTable, reslocOfTypeField } }
