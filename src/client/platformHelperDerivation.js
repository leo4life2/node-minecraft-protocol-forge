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
const EVENT_TYPE = 'net/neoforged/neoforge/network/event/RegisterPayloadHandlersEvent'
const LIST_TYPE = 'java/util/List'
const ITERATOR_TYPE = 'java/util/Iterator'

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
    if (pattern.shape === 'list-provider') { deriveListProviderRows(index, state, pattern, h, rows, abstains, resolvedClasses); continue }
    if (pattern.shape === 'builder-counter') { deriveBuilderCounterRows(index, state, pattern, h, rows, abstains, resolvedClasses); continue }
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

// HF127 R1 - THE LIST-PROVIDER LOOP (pattern row shape 'list-provider'):
// the mod's own listener takes the registrar at a constant version and loops
// over a static list provider, registering each element's own type:
//   event.registrar("<v>"); for (TypeAndCodec tac : <Provider>.getDefinitions())
//     registrar.playToX(tac.type(), tac.codec(), handler)
// The provider is proven STATIC from its bytes (only new TypeAndCodec(
// getstatic <Msg>.<Type field>, getstatic <Msg>.<codec field>) elements handed
// to List.of, then areturn); each element's id is its message class's static
// initializer read through resolveNamespaceHelper (reslocOfTypeField). The
// version is the registrar's constant String, the flow the PayloadRegistrar
// method, optional only when PayloadRegistrar.optional() is invoked in the
// method. A provider the bytes cannot prove static, a version that is not one
// constant, or an element whose id does not resolve abstains by name.
function staticListElementsOf (index, state, owner, name, desc, h) {
  const key = `list:${owner}.${name}${desc}`
  if (state.platformHelperCache.has(key)) return state.platformHelperCache.get(key)
  const info = index.get(owner)
  const m = info && info.codes.find((c) => c.method === name && c.desc === desc && c.code)
  let out = null
  if (m && (m.flags & 0x0008) !== 0) {
    const elements = []
    const statics = []
    let ok = true
    let listed = false
    h.walkLinear(m.code, info.cp, (op, pc, cp, code) => {
      if (!ok) return
      if (op === 0xbb) { if (cpClassName(cp, code.readUInt16BE(pc + 1)) !== TYPE_AND_CODEC) ok = false; return }
      if (op === 0x59 || (op >= 0x02 && op <= 0x08) || op === 0x10 || op === 0x53) return // dup, int constants, aastore (List.of varargs array)
      if (op === 0xbd) { if (cpClassName(cp, code.readUInt16BE(pc + 1)) === null) ok = false; return } // anewarray (varargs)
      if (op === 0xb2) { statics.push(cpRef(cp, code.readUInt16BE(pc + 1))); return }
      if (op === 0xb7) {
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        if (!ref || ref.owner !== TYPE_AND_CODEC || ref.name !== '<init>' || statics.length < 2) { ok = false; return }
        const typeField = statics[statics.length - 2]
        statics.length = 0
        if (!typeField || typeField.desc !== `L${PAYLOAD_TYPE};`) { ok = false; return }
        elements.push(typeField)
        return
      }
      if (op === 0xb8) {
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        if (ref && ref.owner === LIST_TYPE && ref.name === 'of' && !listed) { listed = true; return }
        ok = false; return
      }
      if (op === 0xb0) return // areturn
      ok = false
    })
    if (ok && listed && statics.length === 0) out = elements
  }
  state.platformHelperCache.set(key, out)
  return out
}

function deriveListProviderRows (index, state, pattern, h, rows, abstains, resolvedClasses) {
  if (pattern.idRule !== 'list-provider' || pattern.versionRule !== 'registrar-string-constant' || typeof pattern.providerDesc !== 'string') return
  const providerBytes = Buffer.from(pattern.providerDesc)
  for (const cls of h.seedNames()) {
    const bytes = index.rawBytes(cls)
    if (!bytes || !bytes.includes(providerBytes) || !bytes.includes(ITERATOR_TYPE)) continue
    const info = index.get(cls)
    if (!info) continue
    for (const m of info.codes) {
      if (!m.code || !m.desc.includes(`L${EVENT_TYPE};`)) continue
      const site = `${cls}.${m.method}`
      let lastStr = null
      const versions = new Set()
      let versionUnknown = false
      let optional = false
      let provider = null
      let looping = null
      let element = null
      let typed = null
      const regs = []
      h.walkLinear(m.code, info.cp, (op, pc, cp, code) => {
        if (op === 0x12 || op === 0x13) { const c = cp[op === 0x12 ? code[pc + 1] : code.readUInt16BE(pc + 1)]; lastStr = (c && c.tag === 8) ? cpUtf8(cp, c.strIndex) : null; return }
        if (op !== 0xb6 && op !== 0xb8 && op !== 0xb9) { if (op !== 0x2a && op !== 0x2b && op !== 0x59) lastStr = null; return }
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        if (!ref) return
        if ((ref.owner === EVENT_TYPE && ref.name === 'registrar') || (ref.owner === REGISTRAR_TYPE && ref.name === 'versioned')) {
          if (typeof lastStr === 'string') versions.add(lastStr)
          else versionUnknown = true
        } else if (ref.owner === REGISTRAR_TYPE && ref.name === 'optional') {
          optional = true
        } else if (op === 0xb8 && ref.desc === pattern.providerDesc && index.get(ref.owner)) {
          provider = ref
        } else if (ref.owner === LIST_TYPE && ref.name === 'iterator') {
          looping = provider
          provider = null
        } else if (ref.owner === ITERATOR_TYPE && ref.name === 'next') {
          element = looping
        } else if (ref.owner === TYPE_AND_CODEC && ref.name === 'type') {
          typed = element
        } else if (ref.owner === REGISTRAR_TYPE && h.registrationMethods[ref.name] && ref.desc.startsWith(`(L${PAYLOAD_TYPE};`)) {
          if (typed) regs.push({ provider: typed, regMethod: ref.name })
          typed = null
        }
        lastStr = null
      })
      if (regs.length === 0) continue
      const version = (!versionUnknown && versions.size === 1) ? [...versions][0] : null
      let complete = true
      for (const reg of regs) {
        const via = `${reg.provider.owner.split('/').pop()}.${reg.provider.name}`
        if (version === null) { abstains.push(`${site}: list-provider loop over ${via} without one constant registrar version — unclaimed`); complete = false; continue }
        const elements = staticListElementsOf(index, state, reg.provider.owner, reg.provider.name, reg.provider.desc, h)
        if (!elements) { abstains.push(`${site}: list-provider loop over ${via} whose list the bytes do not prove static — unclaimed`); complete = false; continue }
        const spec = h.registrationMethods[reg.regMethod]
        for (const f of elements) {
          const id = reslocOfTypeField(index, state, f.owner, f.name, h)
          if (!id) { abstains.push(`${site}: ${reg.regMethod} with unresolved payload type id (${f.owner}.${f.name}) from the list-provider loop over ${via} — unclaimed`); complete = false; continue }
          rows.push({ id, version, flow: spec.flow, optional, protocols: spec.protocols, source: `${pattern.sourceWord} ${via} via ${site} (${reg.regMethod}; version from the registrar's constant)`, jar: info.jar })
        }
      }
      if (complete) resolvedClasses.add(cls)
    }
  }
}

// HF127 R3 - THE NUMBERED-ID BUILDER (pattern row shape 'builder-counter'):
// a library hands each mod a channel builder keyed by the mod id; the mod
// chains its message classes onto it and the library numbers them:
//   <Api>.builder("<modid>")[.optional()].registerX(Msg.class)...   (consumer)
// The helper's bytes decide every rule (verified before any row is claimed):
// the builder implementation's constructor names the channel
// (fromNamespaceAndPath(<modid>, ldc <path>)) and keeps one insertion-ordered
// map per registration kind plus an AtomicInteger; each builder method feeds
// one map (read through interface defaults); the freeze body walks the maps
// in a fixed order; the id is the channel path through a withPath lambda whose
// concat recipe takes the counter's getAndIncrement; the concrete handler
// takes its registrar at channel.toLanguageKey() (= "<modid>.<path>"),
// optional only under the builder's optional flag, and registers each message
// through ONE PayloadRegistrar method (its flow). A helper whose bytes miss any
// rule, or a consumer chain the walk cannot read whole, abstains by name.
const RESLOC_TYPE = 'net/minecraft/resources/ResourceLocation'
const COUNTER_TYPE = 'java/util/concurrent/atomic/AtomicInteger'
const ORDERED_MAP_TYPE = 'java/util/LinkedHashMap'
function methodOf (info, name, desc) { return info ? info.codes.find((c) => c.method === name && c.desc === desc && c.code) : null }
function invokesOf (info, m, h) {
  const out = []
  h.walkLinear(m.code, info.cp, (op, pc, cp, code) => {
    if (op === 0xb4 || op === 0xb5 || op === 0xb6 || op === 0xb7 || op === 0xb8 || op === 0xb9) {
      const r = cpRef(cp, code.readUInt16BE(pc + 1))
      if (r) out.push({ op, ref: r, pc })
    } else if (op === 0xba) {
      out.push({ op, indy: cp[code.readUInt16BE(pc + 1)], pc })
    } else if (op === 0x12 || op === 0x13) {
      const c = cp[op === 0x12 ? code[pc + 1] : code.readUInt16BE(pc + 1)]
      if (c && c.tag === 8) out.push({ op, str: cpUtf8(cp, c.strIndex), pc })
    } else if (op === 0xbb) {
      out.push({ op, cls: cpClassName(cp, code.readUInt16BE(pc + 1)), pc })
    }
  })
  return out
}
function resolveBuilderCounterShape (index, state, builderType, h) {
  const key = `builder:${builderType}`
  if (state.platformHelperCache.has(key)) return state.platformHelperCache.get(key)
  state.platformHelperCache.set(key, null)
  const iface = index.get(builderType)
  if (!iface) return null
  const needle = Buffer.from(builderType)
  const impls = []
  for (const name of index.raw.keys()) {
    const b = index.rawBytes(name)
    if (!b || !b.includes(needle)) continue
    const info = index.get(name)
    if (info && (info.interfaces || []).includes(builderType)) impls.push(info)
  }
  if (impls.length !== 1) return null
  const impl = impls[0]
  // (1) the constructor: channel = fromNamespaceAndPath(<arg>, ldc <path>); ordered maps; the counter
  const ctor = methodOf(impl, '<init>', '(Ljava/lang/String;)V')
  if (!ctor) return null
  const ci = invokesOf(impl, ctor, h)
  let channelField = null; let channelPath = null; let counterField = null
  const mapFields = new Set()
  for (let i = 0; i < ci.length; i++) {
    const e = ci[i]
    if (e.op === 0xb8 && e.ref.owner === RESLOC_TYPE && h.isStrStrToReslocDesc(e.ref.desc) && ci[i - 1] && ci[i - 1].str !== undefined && ci[i + 1] && ci[i + 1].op === 0xb5) { channelPath = ci[i - 1].str; channelField = ci[i + 1].ref.name }
    if (e.op === 0xbb && ci[i + 2] && ci[i + 2].op === 0xb5) {
      if (e.cls === ORDERED_MAP_TYPE) mapFields.add(ci[i + 2].ref.name)
      if (e.cls === COUNTER_TYPE) counterField = ci[i + 2].ref.name
    }
  }
  if (!channelField || !channelPath || !counterField || mapFields.size === 0) return null
  // (2) each builder method -> the map it feeds (through interface defaults, depth 2); the optional flag method
  const feeds = (owner, name, desc, depth) => {
    const info = index.get(owner)
    let m = methodOf(info, name, desc)
    let mInfo = info
    if (!m && owner === builderType) { m = methodOf(impl, name, desc); mInfo = impl }
    if (!m && owner === impl.className) { m = methodOf(iface, name, desc); mInfo = iface }
    if (!m || depth > 2) return null
    for (const e of invokesOf(mInfo, m, h)) {
      if (e.op === 0xb4 && mapFields.has(e.ref.name) && e.ref.owner === impl.className) return e.ref.name
      if ((e.op === 0xb9 || e.op === 0xb6) && (e.ref.owner === builderType || e.ref.owner === impl.className) && e.ref.desc.startsWith('(Ljava/lang/Class;') && e.ref.desc.endsWith(`)L${builderType};`)) { const f = feeds(e.ref.owner, e.ref.name, e.ref.desc, depth + 1); if (f) return f }
    }
    return null
  }
  let optionalMethod = null; let optionalField = null
  for (const m of impl.codes) {
    if (!m.code || m.desc !== `()L${builderType};`) continue
    const ev = invokesOf(impl, m, h)
    const put = ev.find((e) => e.op === 0xb5 && e.ref.desc === 'Z')
    if (put) { optionalMethod = m.method; optionalField = put.ref.name }
  }
  // (3) the freeze order: the first method reading every map field, in read order
  let order = null
  for (const m of impl.codes) {
    if (!m.code || m.desc !== '()V') continue
    const reads = invokesOf(impl, m, h).filter((e) => e.op === 0xb4 && mapFields.has(e.ref.name)).map((e) => e.ref.name)
    const uniq = [...new Set(reads)]
    if (uniq.length === mapFields.size && uniq.length >= 1) { order = uniq; break }
  }
  if (!order) return null
  // (4) the id recipe: a lambda of the implementation reading the counter's getAndIncrement into a concat recipe, used by a withPath over the channel
  let recipe = null
  for (const m of impl.codes) {
    if (!m.code || m.desc !== '(Ljava/lang/String;)Ljava/lang/String;') continue
    const ev = invokesOf(impl, m, h)
    const gi = ev.findIndex((e) => e.op === 0xb4 && e.ref.name === counterField)
    const inc = ev.findIndex((e) => e.op === 0xb6 && e.ref.owner === COUNTER_TYPE && e.ref.name === 'getAndIncrement')
    const cat = ev.findIndex((e) => e.op === 0xba && e.indy)
    if (gi >= 0 && inc > gi && cat > inc) recipe = { info: impl, bsmIndex: ev[cat].indy.bsmIndex, lambda: m.method }
  }
  if (!recipe) return null
  const withPath = impl.codes.some((m) => m.code && invokesOf(impl, m, h).some((e, i, ev) => e.op === 0xb6 && e.ref.owner === RESLOC_TYPE && e.ref.name === 'withPath' && ev.slice(0, i).some((x) => x.op === 0xb4 && x.ref.name === channelField)))
  if (!withPath) return null
  // (5) the concrete handler: the registrar at channel.toLanguageKey(), the optional flag, ONE PayloadRegistrar method
  const subs = []
  for (const name of index.raw.keys()) {
    const b = index.rawBytes(name)
    if (!b || !b.includes(Buffer.from(impl.className))) continue
    const info = index.get(name)
    if (info && info.superName === impl.className) subs.push(info)
  }
  if (subs.length !== 1) return null
  const sub = subs[0]
  let languageKeyRegistrar = false; let optionalGuarded = false; let optionalBare = false
  const regMethods = new Set()
  for (const m of sub.codes) {
    if (!m.code) continue
    const ev = invokesOf(sub, m, h)
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]
      if (e.op === 0xb6 && e.ref.owner === EVENT_TYPE && e.ref.name === 'registrar' && ev[i - 1] && ev[i - 1].ref && ev[i - 1].ref.owner === RESLOC_TYPE && ev[i - 1].ref.name === 'toLanguageKey' && ev[i - 2] && ev[i - 2].op === 0xb4 && ev[i - 2].ref.name === channelField) languageKeyRegistrar = true
      if (e.op === 0xb6 && e.ref.owner === REGISTRAR_TYPE && e.ref.name === 'optional') { if (optionalField && ev.slice(0, i).some((x) => x.op === 0xb4 && x.ref.name === optionalField)) optionalGuarded = true; else optionalBare = true }
      if ((e.op === 0xb6 || e.op === 0xb9) && e.ref.owner === REGISTRAR_TYPE && h.registrationMethods[e.ref.name] && e.ref.desc.startsWith(`(L${PAYLOAD_TYPE};`)) regMethods.add(e.ref.name)
    }
  }
  if (!languageKeyRegistrar || optionalBare || regMethods.size !== 1) return null
  const shape = { builderType, impl: impl.className, sub: sub.className, channelPath, order, recipe, optionalMethod: optionalGuarded ? optionalMethod : null, regMethod: [...regMethods][0], feeds: (name, desc) => feeds(builderType, name, desc, 0) }
  state.platformHelperCache.set(key, shape)
  return shape
}

function deriveBuilderCounterRows (index, state, pattern, h, rows, abstains, resolvedClasses) {
  if (pattern.idRule !== 'builder-counter' || pattern.versionRule !== 'channel-language-key' || typeof pattern.entryArgs !== 'string') return
  const head = Buffer.from(pattern.entryArgs)
  for (const cls of h.seedNames()) {
    const bytes = index.rawBytes(cls)
    if (!bytes || !bytes.includes(head)) continue
    const info = index.get(cls)
    if (!info) continue
    for (const m of info.codes) {
      if (!m.code) continue
      const ev = invokesOf(info, m, h)
      for (let i = 1; i < ev.length; i++) {
        const e = ev[i]
        if (e.op !== 0xb8 || !e.ref.desc.startsWith(pattern.entryArgs) || ev[i - 1].str === undefined) continue
        const builderType = e.ref.desc.slice(pattern.entryArgs.length + 1, -1)
        if (!e.ref.desc.startsWith(`${pattern.entryArgs}L`) || !index.get(builderType)) continue
        const next = ev.slice(i + 1).find((x) => x.op !== 0xba && x.str === undefined) // the chain's own arguments (method references, constants) sit between the calls
        if (!next || next.op !== 0xb9 || next.ref.owner !== builderType) continue // not a chained builder
        const shape = resolveBuilderCounterShape(index, state, builderType, h)
        const site = `${cls}.${m.method}`
        if (!shape) continue // not the numbered-id builder shape (no rule of the row holds): another reader's
        const modId = ev[i - 1].str
        let optional = false
        const perMap = new Map(shape.order.map((f) => [f, []]))
        let complete = true
        for (let j = i + 1; j < ev.length; j++) {
          const c = ev[j]
          if (c.op === 0x12 || c.op === 0x13 || c.op === 0xba) continue
          if (c.op !== 0xb9 || c.ref.owner !== builderType) break
          if (shape.optionalMethod && c.ref.name === shape.optionalMethod && c.ref.desc === `()L${builderType};`) { optional = true; continue }
          if (!c.ref.desc.startsWith('(Ljava/lang/Class;')) continue
          const map = shape.feeds(c.ref.name, c.ref.desc)
          if (!map) continue // a builder method that feeds no map (a serializer): not a registration
          perMap.get(map).push(c.ref.name)
        }
        const ids = []
        let n = 0
        for (const f of shape.order) for (let k = 0; k < perMap.get(f).length; k++) { const v = h.concatWithConstants(shape.recipe.info, shape.recipe.bsmIndex, [{ k: 'str', v: shape.channelPath }, { k: 'int', v: n++ }]); if (!v || v.k !== 'str') complete = false; else ids.push(`${modId}:${v.v}`) }
        if (!complete) { abstains.push(`${site}: numbered-id builder ${shape.impl.split('/').pop()} whose id recipe did not fold - unclaimed`); continue }
        const spec = h.registrationMethods[shape.regMethod]
        for (const id of ids) rows.push({ id, version: `${modId}.${shape.channelPath}`, flow: spec.flow, optional, protocols: spec.protocols, source: `${pattern.sourceWord} ${shape.impl} via ${site} (${shape.regMethod}; numbered in the helper's freeze order; version from the channel's language key)`, jar: info.jar })
        if (ids.length > 0) { resolvedClasses.add(shape.impl); resolvedClasses.add(shape.sub) }
      }
    }
  }
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
