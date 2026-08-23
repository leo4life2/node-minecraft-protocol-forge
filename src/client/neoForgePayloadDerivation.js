// Static derivation of NeoForge 1.20.5+ network components from local jars.
//
// NeoForge's config-phase negotiation (see neoForgeConfig.js) demands that the
// client claim, for every payload channel the server's mods registered, the
// exact tuple (id, version, flow, optional). Those tuples are static facts of
// the jars: every registration funnels through
// net.neoforged.neoforge.network.registration.PayloadRegistrar, whose nine
// helper methods fix protocols+flow, and whose version/optional state comes
// from RegisterPayloadHandlersEvent.registrar(version)/.versioned()/.optional().
//
// This module reads those facts out of the shipped bytecode with a small
// linear abstract interpreter plus three ECOSYSTEM SHAPES observed in the
// wild (same posture as loginAckDerivation.js: shapes + honest ABSTAIN):
//
//   DIRECT     event.registrar("1").playToClient(TYPE, CODEC, handler)...
//              (NeoForge's own NetworkInitialization, FarmersDelight, most
//              simple mods). Type ids resolve through the owning class's
//              <clinit> (new Type(ResourceLocation...) directly or through a
//              one-hop (String)->ResourceLocation helper such as
//              Mekanism.rl / Create.asResource).
//   WRAPPER    the mod wraps the registrar in a small record carrying a
//              direction boolean and registers through virtual methods
//              (Mekanism's BasePacketHandler.PacketRegistrar). The wrapper
//              method's own bytecode names which PayloadRegistrar method each
//              branch of the boolean maps to; virtual dispatch is resolved
//              against every subclass present in the scanned jars.
//   HELPER     the registrar is passed as an ARGUMENT into a helper method
//              whose body performs the real PayloadRegistrar call (AE2
//              19.2.17 InitNetwork: clientbound(registrar, TYPE, CODEC) ->
//              registrar.playToClient(TYPE, CODEC, handler); HF-NEOFORGE
//              lane: this shape was silently invisible — 34 required ae2:*
//              play channels derived as ZERO with zero abstains, so the
//              config-phase negotiation failed "Incompatible client!").
//              Each call site dispatches INTO the callee with the caller's
//              abstract argument values as locals, so the registrar state
//              and the per-call payload TYPE flow through; bounded by a
//              re-entrancy cycle guard + a global frame budget that
//              abstains loudly instead of spinning.
//   ENUM-REGISTRY  an enum whose constants each build a Type from
//              name().toLowerCase(ROOT) + a namespace helper and carry the
//              payload class; a static method constructs a registry object
//              with (modId, networkVersion) and a loader-side helper
//              registers every constant, deciding flow by marker-interface
//              isAssignableFrom checks (catnip: Create's AllPackets, Ponder's
//              CatnipPackets). Marker interfaces are read out of the helper's
//              own bytecode, flows out of each payload class's hierarchy.
//
// VERSION RULES: a version string is used only when it is a compile-time
// constant (directly or via a static String field / String.valueOf(int)).
// When the registrar version is a runtime value, the registration rides the
// "registrar(modVersion)" idiom and the jar's own mods.toml version is used
// (verified live: Mekanism 10.7.19). If even that is unavailable the
// registration ABSTAINS: for optional channels an abstain is safe by
// negotiation semantics (both-sides-optional channels are dropped when
// unclaimed); for required channels the abstain is reported — a wrong guess
// would fail the join with a worse diagnostic than an honest miss.
//
// PRIVACY LAWS (same as jarAnalysis/loginAckDerivation, enforced by the
// embedding app's privacy-laws tests): LOCAL-ONLY, READ-ONLY, PURPOSE-LIMITED.
// Requires only fs + the shared jar/class primitives (zlib). Nothing is
// classloaded or executed; no network; no writes.
'use strict'

const fs = require('fs')
const path = require('path')
const debug = require('../../debug')
const { zipCentralEntries, zipEntryData, parseClassFile, cpUtf8, cpClassName, cpRef } = require('./jarAnalysis')

const EVENT_TYPE = 'net/neoforged/neoforge/network/event/RegisterPayloadHandlersEvent'
const REGISTRAR_TYPE = 'net/neoforged/neoforge/network/registration/PayloadRegistrar'
const RESLOC_TYPE = 'net/minecraft/resources/ResourceLocation'
const PAYLOAD_TYPE_CLASS = 'net/minecraft/network/protocol/common/custom/CustomPacketPayload$Type'

// PayloadRegistrar registration methods -> {protocols, flow} (decompiled 21.1.248)
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

// ---------- jar walking ----------

function collectJarClasses (jarPath, out, diagnostics, jarLabel) {
  let buf
  try {
    buf = fs.readFileSync(jarPath)
  } catch (err) {
    diagnostics.errors.push(`${jarLabel}: unreadable (${err.message})`)
    return
  }
  collectBufferClasses(buf, out, diagnostics, jarLabel)
}

function collectBufferClasses (buf, out, diagnostics, jarLabel) {
  let entries
  try {
    entries = zipCentralEntries(buf)
  } catch (err) {
    diagnostics.errors.push(`${jarLabel}: bad zip (${err.message})`)
    return
  }
  let modVersion = null
  for (const e of entries) {
    if (e.name === 'META-INF/neoforge.mods.toml' || e.name === 'META-INF/mods.toml') {
      try {
        const toml = zipEntryData(buf, e).toString('utf8')
        const m = toml.match(/^\s*version\s*=\s*"([^"]+)"/m)
        if (m && !m[1].includes('${')) modVersion = m[1]
        if (m && m[1].includes('${')) {
          // maven placeholder -> Implementation-Version from the manifest
          const mf = entries.find((x) => x.name === 'META-INF/MANIFEST.MF')
          if (mf) {
            const iv = zipEntryData(buf, mf).toString('utf8').match(/^Implementation-Version:\s*(\S+)/m)
            if (iv) modVersion = iv[1]
          }
        }
      } catch { /* tolerated */ }
    }
  }
  const jarInfo = { label: jarLabel, modVersion }
  diagnostics.jars.push(jarInfo)
  for (const e of entries) {
    if (e.name.endsWith('.class') && !e.name.includes('module-info')) {
      const className = e.name.slice(0, -6)
      if (!out.raw.has(className)) {
        out.raw.set(className, { buf, entry: e, jar: jarInfo })
      }
    } else if ((e.name.startsWith('META-INF/jars/') || e.name.startsWith('META-INF/jarjar/')) && e.name.endsWith('.jar')) {
      try {
        collectBufferClasses(zipEntryData(buf, e), out, diagnostics, `${jarLabel}!${e.name.split('/').pop()}`)
      } catch (err) {
        diagnostics.errors.push(`${jarLabel}!${e.name}: nested jar unreadable (${err.message})`)
      }
    }
  }
}

function makeClassIndex () {
  const raw = new Map() // internalName -> {buf, entry, jar}
  const parsed = new Map()
  const index = {
    raw,
    get (name) {
      if (!name) return null
      if (parsed.has(name)) return parsed.get(name)
      const r = raw.get(name)
      let info = null
      if (r) {
        try {
          info = parseClassFile(zipEntryData(r.buf, r.entry))
          if (info) info.jar = r.jar
        } catch { info = null }
      }
      parsed.set(name, info)
      return info
    },
    rawBytes (name) {
      const r = raw.get(name)
      if (!r) return null
      try { return zipEntryData(r.buf, r.entry) } catch { return null }
    }
  }
  return index
}

// ---------- descriptor helpers ----------

function argSlots (desc) {
  // returns array of one entry per argument (type descriptor string)
  const args = []
  let i = desc.indexOf('(') + 1
  while (desc[i] !== ')') {
    const start = i
    while (desc[i] === '[') i++
    if (desc[i] === 'L') { i = desc.indexOf(';', i) + 1 } else { i++ }
    args.push(desc.slice(start, i))
  }
  return args
}

function returnsVoid (desc) { return desc.endsWith(')V') }

// ---------- abstract values ----------

const UNKNOWN = null
const vStr = (v) => ({ k: 'str', v })
const vInt = (v) => ({ k: 'int', v })
const vCls = (v) => ({ k: 'cls', v })
const vResloc = (v) => ({ k: 'resloc', v })

function asStr (val) { return val && val.k === 'str' ? val.v : null }

// ---------- helper resolution: (String)->ResourceLocation namespace helpers ----------

function resolveNamespaceHelper (index, owner, name, desc, cache) {
  const key = `${owner}.${name}${desc}`
  if (cache.has(key)) return cache.get(key)
  let result = null
  const info = index.get(owner)
  if (info) {
    const m = info.codes.find((c) => c.method === name && c.desc === desc)
    if (m) {
      // linear scan: a single LDC string + fromNamespaceAndPath/parse-with-prefix
      const strings = []
      let sawFrom = false
      let sawConcatParse = false
      walkLinear(m.code, info.cp, (op, pc, cp, code) => {
        if (op === 0x12 || op === 0x13) {
          const idx = op === 0x12 ? code[pc + 1] : code.readUInt16BE(pc + 1)
          const c = cp[idx]
          if (c && c.tag === 8) strings.push(cpUtf8(cp, c.strIndex))
        } else if (op === 0xb8) {
          const ref = cpRef(cp, code.readUInt16BE(pc + 1))
          if (ref && ref.owner === RESLOC_TYPE && (ref.name === 'fromNamespaceAndPath' || ref.name === 'm_339182_')) sawFrom = true
          if (ref && ref.owner === RESLOC_TYPE && (ref.name === 'parse' || ref.name === 'tryParse')) sawConcatParse = true
        }
      })
      if (sawFrom && strings.length === 1) result = { nsPrefix: strings[0] }
      else if (sawConcatParse && strings.length === 1 && strings[0].endsWith(':')) result = { nsPrefix: strings[0].slice(0, -1) }
    }
  }
  cache.set(key, result)
  return result
}

function walkLinear (code, cp, visit) {
  // linear opcode walk sharing jarAnalysis length rules
  const { JVM_OP_LEN } = require('./jarAnalysis')
  let pc = 0
  while (pc < code.length) {
    const op = code[pc]
    let len = JVM_OP_LEN[op]
    if (op === 0xaa) { const p = (pc + 4) & ~3; len = (p - pc) + 12 + (code.readInt32BE(p + 8) - code.readInt32BE(p + 4) + 1) * 4 } else if (op === 0xab) { const p = (pc + 4) & ~3; len = (p - pc) + 8 + code.readInt32BE(p + 4) * 8 } else if (op === 0xc4) { len = code[pc + 1] === 0x84 ? 6 : 4 }
    visit(op, pc, cp, code)
    pc += len
  }
}

// ---------- Type-field resolution via <clinit>/method scan ----------

function resolveClassTypeFields (index, className, state) {
  if (state.typeFieldsResolved.has(className)) return
  state.typeFieldsResolved.add(className)
  const info = index.get(className)
  if (!info) return
  for (const m of info.codes) {
    simulate(index, info, m, state, { recordPutstatic: true })
  }
}

function resolveTypeValue (index, val, state) {
  if (!val) return null
  if (val.k === 'type') return val.v
  if (val.k === 'field' && val.desc === `L${PAYLOAD_TYPE_CLASS};`) {
    const key = `${val.owner}.${val.name}`
    if (!(key in state.fieldValues)) resolveClassTypeFields(index, val.owner, state)
    const resolved = state.fieldValues[key]
    if (resolved && resolved.k === 'type') return resolved.v
    return null
  }
  return null
}

function resolveStringValue (index, val, state) {
  if (!val) return null
  if (val.k === 'str') return val.v
  if (val.k === 'int') return String(val.v)
  if (val.k === 'field' && val.desc === 'Ljava/lang/String;') {
    const key = `${val.owner}.${val.name}`
    if (!(key in state.fieldValues)) resolveClassTypeFields(index, val.owner, state)
    const resolved = state.fieldValues[key]
    if (resolved && resolved.k === 'str') return resolved.v
  }
  return null
}

// ---------- the linear abstract interpreter ----------

function simulate (index, classInfo, method, state, opts = {}) {
  const cp = classInfo.cp
  const code = method.code
  const stack = []
  const locals = opts.locals ? opts.locals.slice() : []
  const pop = (n = 1) => { for (let i = 0; i < n; i++) stack.pop() }
  const push = (v) => stack.push(v)

  walkLinear(code, cp, (op, pc) => {
    switch (op) {
      case 0x01: push(UNKNOWN); break // aconst_null
      case 0x02: case 0x03: case 0x04: case 0x05: case 0x06: case 0x07: case 0x08:
        push(vInt(op - 0x03)); break
      case 0x10: push(vInt(code.readInt8(pc + 1))); break
      case 0x11: push(vInt(code.readInt16BE(pc + 1))); break
      case 0x12: case 0x13: {
        const idx = op === 0x12 ? code[pc + 1] : code.readUInt16BE(pc + 1)
        const c = cp[idx]
        if (c && c.tag === 8) push(vStr(cpUtf8(cp, c.strIndex)))
        else if (c && c.tag === 7) push(vCls(cpUtf8(cp, c.nameIndex)))
        else if (c && c.tag === 3) push(vInt(c.int))
        else push(UNKNOWN)
        break
      }
      case 0x14: push(UNKNOWN); break // ldc2_w
      case 0x15: case 0x16: case 0x17: case 0x18: case 0x19:
        push(locals[code[pc + 1]] ?? UNKNOWN); break
      case 0x1a: case 0x1b: case 0x1c: case 0x1d: push(locals[op - 0x1a] ?? UNKNOWN); break // iload_n
      case 0x2a: case 0x2b: case 0x2c: case 0x2d: push(locals[op - 0x2a] ?? UNKNOWN); break // aload_n
      case 0x36: case 0x37: case 0x38: case 0x39: case 0x3a:
        locals[code[pc + 1]] = stack.pop(); break
      case 0x3b: case 0x3c: case 0x3d: case 0x3e: locals[op - 0x3b] = stack.pop(); break // istore_n
      case 0x4b: case 0x4c: case 0x4d: case 0x4e: locals[op - 0x4b] = stack.pop(); break // astore_n
      case 0x57: pop(); break
      case 0x58: pop(2); break
      case 0x59: push(stack[stack.length - 1]); break // dup (aliases!)
      case 0x5a: { const a = stack.pop(); const b = stack.pop(); push(a); push(b); push(a); break } // dup_x1
      case 0x5c: { const a = stack[stack.length - 1]; const b = stack[stack.length - 2]; push(b); push(a); break } // dup2 (approx)
      case 0xb2: { // getstatic
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        if (!ref) { push(UNKNOWN); break }
        const key = `${ref.owner}.${ref.name}`
        if (key in state.fieldValues) push(state.fieldValues[key])
        else push({ k: 'field', owner: ref.owner, name: ref.name, desc: ref.desc })
        break
      }
      case 0xb3: { // putstatic
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        const val = stack.pop()
        if (ref && val && opts.recordPutstatic) {
          state.fieldValues[`${ref.owner}.${ref.name}`] = val
        }
        break
      }
      case 0xb4: { // getfield
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        const obj = stack.pop()
        if (obj && obj.k === 'obj' && ref) {
          // record-style position binding: match ctor arg by declared order of
          // same-typed fields is overkill here; wrapper consumers read ctorArgs
          push({ k: 'instfield', obj, name: ref.name, desc: ref.desc })
        } else push(UNKNOWN)
        break
      }
      case 0xb5: pop(2); break // putfield
      case 0xbb: { // new
        const cls = cpClassName(cp, code.readUInt16BE(pc + 1))
        push({ k: 'new', cls })
        break
      }
      case 0xbd: pop(1); push({ k: 'arr' }); break // anewarray
      case 0x53: pop(3); break // aastore
      case 0xb6: case 0xb7: case 0xb9: { // invokevirtual/special/interface
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        if (!ref) break
        const args = argSlots(ref.desc)
        const argVals = []
        for (let i = args.length - 1; i >= 0; i--) argVals[i] = stack.pop()
        const recv = stack.pop()
        handleInvoke(index, classInfo, state, opts, { kind: 'instance', ref, recv, argVals, push, pc })
        break
      }
      case 0xb8: { // invokestatic
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        if (!ref) break
        const args = argSlots(ref.desc)
        const argVals = []
        for (let i = args.length - 1; i >= 0; i--) argVals[i] = stack.pop()
        handleInvoke(index, classInfo, state, opts, { kind: 'static', ref, recv: null, argVals, push, pc })
        break
      }
      case 0xba: { // invokedynamic
        const c = cp[code.readUInt16BE(pc + 1)]
        const nat = c && cp[c.natIndex]
        const desc = nat ? cpUtf8(cp, nat.descIndex) : '()V'
        pop(argSlots(desc).length)
        if (!returnsVoid(desc)) push(UNKNOWN)
        break
      }
      case 0xb0: { // areturn: hand the returned abstract value to the caller
        const v = stack.pop()
        if (v && opts.onReturn) opts.onReturn(v)
        break
      }
      case 0xc0: break // checkcast: value unchanged
      default: break
    }
  })
}

function handleInvoke (index, classInfo, state, opts, call) {
  const { ref, recv, argVals, push } = call
  const retVoid = returnsVoid(ref.desc)

  // <init>: bind constructor args onto the aliased 'new' object
  if (ref.name === '<init>') {
    if (recv && recv.k === 'new') {
      recv.k = 'obj'
      recv.ctorArgs = argVals
      if (recv.cls === PAYLOAD_TYPE_CLASS && argVals[0] && argVals[0].k === 'resloc') {
        recv.k = 'type'
        recv.v = argVals[0].v
      }
    }
    // CTOR-BODY shape (HF-R2, same silent-miss family as the HELPER shape):
    // a registrar passed INTO a constructor whose body performs the real
    // registrations (new Networking(registrar) with registrar.playToClient
    // in the <init> body). This branch used to return BEFORE the helper
    // dispatch below, so such registrations derived NOTHING with zero
    // abstains — invisible to the honesty layer. Dispatch into the <init>
    // body with the ctor args as locals (slot 0 = the object under
    // construction), under the same re-entrancy cycle guard + global frame
    // budget as the registrar-helper dispatch. The WRAPPER shape is
    // unaffected: wrapper ctors only store fields (putfield is a no-op to
    // the interpreter) and their registrations still resolve through the
    // wrapper-method analysis on later calls.
    if (argVals.some((a) => a && a.k === 'registrar')) {
      dispatchCtorBody(index, ref, recv, argVals, state, opts)
    }
    return
  }

  // RegisterPayloadHandlersEvent.registrar(version)
  if (ref.name === 'registrar' && ref.desc === `(Ljava/lang/String;)L${REGISTRAR_TYPE};`) {
    const version = asStr(argVals[0]) ?? resolveStringValue(index, argVals[0], state)
    push({ k: 'registrar', version, optional: false, versionSource: version !== null ? 'constant' : 'unresolved' })
    return
  }
  if (recv && recv.k === 'registrar') {
    if (ref.name === 'versioned') {
      const version = asStr(argVals[0]) ?? resolveStringValue(index, argVals[0], state)
      push({ ...recv, version, versionSource: version !== null ? 'constant' : 'unresolved' })
      return
    }
    if (ref.name === 'optional') { push({ ...recv, optional: true }); return }
    if (ref.name === 'executesOn') { push(recv); return }
    if (REGISTRATION_METHODS[ref.name]) {
      const typeId = resolveTypeValue(index, argVals[0], state) ??
        (argVals[0] && argVals[0].k === 'resloc' ? argVals[0].v : null)
      opts.onRegistration?.({
        method: ref.name,
        id: typeId,
        registrar: recv,
        jar: classInfo.jar,
        site: `${classInfo.className}`
      })
      push(recv)
      return
    }
    push(recv)
    return
  }

  // wrapper-object method call (WRAPPER shape): recv is an object whose ctor
  // captured a registrar; map the wrapper method to a registrar method.
  if (recv && recv.k === 'obj' && recv.ctorArgs && recv.ctorArgs.some((a) => a && a.k === 'registrar')) {
    const registrar = recv.ctorArgs.find((a) => a && a.k === 'registrar')
    const boolArg = recv.ctorArgs.find((a) => a && a.k === 'int')
    const mapping = analyzeWrapperMethod(index, recv.cls, ref.name, ref.desc, state)
    if (mapping) {
      const regMethod = mapping.branches
        ? (boolArg && boolArg.v ? mapping.branches.true : mapping.branches.false)
        : mapping.single
      if (regMethod && REGISTRATION_METHODS[regMethod]) {
        let typeId = resolveTypeValue(index, argVals[0], state)
        if (!typeId && argVals[0] && argVals[0].k === 'resloc') typeId = argVals[0].v
        opts.onRegistration?.({
          method: regMethod,
          id: typeId,
          registrar,
          jar: classInfo.jar,
          site: `${classInfo.className} via ${recv.cls}.${ref.name}`
        })
      }
    }
    if (!retVoid) push(recv)
    return
  }

  // virtual dispatch of a wrapper-carrying call into scanned subclasses
  // (BasePacketHandler.registerClientToServer(new PacketRegistrar(reg, true)))
  if (call.kind === 'instance' && argVals.some((a) => a && a.k === 'obj' && a.ctorArgs && a.ctorArgs.some((x) => x && x.k === 'registrar'))) {
    dispatchVirtual(index, ref, argVals, state, opts)
    if (!retVoid) push(UNKNOWN)
    return
  }

  // HELPER shape: the registrar itself rides as an argument into a helper
  // method whose body performs the real registration (AE2's InitNetwork).
  // Simulate the callee with this call's abstract arguments as its locals —
  // once per CALL SITE, because each call carries a different payload TYPE.
  if (argVals.some((a) => a && a.k === 'registrar')) {
    dispatchRegistrarHelper(index, ref, call.kind, recv, argVals, state, opts)
    if (!retVoid) push(UNKNOWN)
    return
  }

  // TYPE-factory helper: a method that RETURNS a CustomPacketPayload$Type —
  // simulate its body with this call's arguments and adopt the returned
  // abstract value (AE2's CustomAppEngPayload.createType(String) ->
  // new Type(AppEng.makeId(name))). Same bounds as the registrar-helper
  // dispatch; an unresolvable body pushes UNKNOWN and the registration
  // abstains loudly downstream.
  if (ref.desc.endsWith(`)L${PAYLOAD_TYPE_CLASS};`)) {
    const returned = simulateForReturn(index, ref, call.kind, recv, argVals, state, opts)
    push(returned ?? UNKNOWN)
    return
  }

  // namespace helper: static (String) -> ResourceLocation
  if (call.kind === 'static' && ref.desc === `(Ljava/lang/String;)L${RESLOC_TYPE};`) {
    if (ref.owner === RESLOC_TYPE && (ref.name === 'parse' || ref.name === 'tryParse')) {
      const s = asStr(argVals[0])
      push(s && s.includes(':') ? vResloc(s) : UNKNOWN)
      return
    }
    const helper = resolveNamespaceHelper(index, ref.owner, ref.name, ref.desc, state.helperCache)
    const s = asStr(argVals[0])
    if (helper && s !== null) { push(vResloc(`${helper.nsPrefix}:${s}`)); return }
    push(UNKNOWN)
    return
  }
  if (call.kind === 'static' && ref.owner === RESLOC_TYPE && ref.desc === `(Ljava/lang/String;Ljava/lang/String;)L${RESLOC_TYPE};`) {
    const ns = asStr(argVals[0]); const p = asStr(argVals[1])
    push(ns !== null && p !== null ? vResloc(`${ns}:${p}`) : UNKNOWN)
    return
  }
  if (call.kind === 'static' && ref.owner === 'java/lang/String' && ref.name === 'valueOf' && argVals[0] && argVals[0].k === 'int') {
    push(vStr(String(argVals[0].v)))
    return
  }

  if (!retVoid) push(UNKNOWN)
}

// HELPER shape dispatch: simulate the called method with the caller's
// abstract argument values as locals so a registrar passed BY ARGUMENT keeps
// flowing (static helpers seed locals from the args directly; instance
// helpers seed slot 0 with the receiver). Bounds: a per-path re-entrancy
// guard kills recursive helper cycles, a global frame budget turns
// pathological fan-out into a loud abstain (never a wedge), and unresolvable
// instance declarations fall back to the same scanned-subclass search (and
// the same >12-override abstain) the wrapper dispatch uses.
const HELPER_FRAME_BUDGET = 20000

function dispatchRegistrarHelper (index, ref, kind, recv, argVals, state, opts) {
  state.helperStack = state.helperStack || new Set()
  state.helperFrames = state.helperFrames || 0
  const key = `${ref.owner}.${ref.name}${ref.desc}`
  if (state.helperStack.has(key)) return // recursive helper: cycle guard
  if (++state.helperFrames > HELPER_FRAME_BUDGET) {
    if (!state.helperBudgetBlown) {
      state.helperBudgetBlown = true
      state.diagnostics.abstains.push(`registrar-helper dispatch budget exhausted at ${key} — remaining helper registrations abstained`)
    }
    return
  }
  const targets = []
  const ownerInfo = index.get(ref.owner)
  const hasOwn = ownerInfo && ownerInfo.codes.some((c) => c.method === ref.name && c.desc === ref.desc)
  if (hasOwn) {
    targets.push(ref.owner)
  } else if (kind === 'instance') {
    for (const name of state.allClassNames) {
      if (name === ref.owner) continue
      if (isSubclassOf(index, name, ref.owner)) {
        const info = index.get(name)
        if (info && info.codes.some((c) => c.method === ref.name && c.desc === ref.desc)) targets.push(name)
      }
    }
    if (targets.length > 12) {
      state.diagnostics.abstains.push(`${key}: ${targets.length} overrides carrying a registrar — too many, abstaining`)
      return
    }
  }
  if (targets.length === 0) return
  state.helperStack.add(key)
  try {
    for (const target of targets) {
      const info = index.get(target)
      const m = info.codes.find((c) => c.method === ref.name && c.desc === ref.desc)
      const locals = kind === 'static' ? argVals.slice() : [recv ?? UNKNOWN, ...argVals]
      // onReturn stripped: a nested registration helper's return value must
      // never leak into an enclosing TYPE-factory resolution.
      simulate(index, info, m, state, { ...opts, locals, onReturn: undefined })
    }
  } finally {
    state.helperStack.delete(key)
  }
}

// CTOR-BODY shape dispatch: simulate a constructor body that received a
// registrar as an argument (new Networking(registrar) registering channels
// directly in <init>). Exactly-known target — invokespecial <init> binds to
// ref.owner's own constructor, never a subclass override — so no scanned-
// subclass search: if the owner class (or its exact <init> descriptor) is
// not in the scanned jars there is nothing to simulate. Shares the
// registrar-helper cycle guard (self-recursive ctors terminate) and the
// global frame budget (pathological fan-out abstains loudly).
function dispatchCtorBody (index, ref, recv, argVals, state, opts) {
  state.helperStack = state.helperStack || new Set()
  state.helperFrames = state.helperFrames || 0
  const key = `${ref.owner}.${ref.name}${ref.desc}`
  if (state.helperStack.has(key)) return // self-recursive ctor: cycle guard
  if (++state.helperFrames > HELPER_FRAME_BUDGET) {
    if (!state.helperBudgetBlown) {
      state.helperBudgetBlown = true
      state.diagnostics.abstains.push(`registrar-helper dispatch budget exhausted at ${key} — remaining helper registrations abstained`)
    }
    return
  }
  const info = index.get(ref.owner)
  const m = info && info.codes.find((c) => c.method === '<init>' && c.desc === ref.desc)
  if (!m) return
  state.helperStack.add(key)
  try {
    const locals = [recv ?? UNKNOWN, ...argVals]
    // onReturn stripped for the same reason as the helper dispatch: a ctor
    // body's stray areturn must never leak into a TYPE-factory resolution.
    simulate(index, info, m, state, { ...opts, locals, onReturn: undefined })
  } finally {
    state.helperStack.delete(key)
  }
}

// Simulate a method body to learn its RETURN value (TYPE-factory helpers).
// Shares the registrar-helper bounds (cycle guard + frame budget); returns
// the last type-shaped value the body returned, else the last returned value.
function simulateForReturn (index, ref, kind, recv, argVals, state, opts) {
  state.helperStack = state.helperStack || new Set()
  state.helperFrames = state.helperFrames || 0
  const key = `${ref.owner}.${ref.name}${ref.desc}`
  if (state.helperStack.has(key)) return null
  if (++state.helperFrames > HELPER_FRAME_BUDGET) return null
  const info = index.get(ref.owner)
  const m = info && info.codes.find((c) => c.method === ref.name && c.desc === ref.desc)
  if (!m) return null
  let best = null
  let last = null
  state.helperStack.add(key)
  try {
    const locals = kind === 'static' ? argVals.slice() : [recv ?? UNKNOWN, ...argVals]
    simulate(index, info, m, state, {
      ...opts,
      locals,
      onReturn: (v) => {
        last = v
        if (v && v.k === 'type') best = v
      }
    })
  } finally {
    state.helperStack.delete(key)
  }
  return best ?? last
}

// virtual call carrying a registrar-wrapper: simulate the declared method on
// the static owner AND on every scanned subclass that overrides it.
function dispatchVirtual (index, ref, argVals, state, opts) {
  const key = `${ref.owner}.${ref.name}${ref.desc}`
  if (state.dispatched.has(key)) return
  state.dispatched.add(key)
  const targets = []
  const ownerInfo = index.get(ref.owner)
  if (ownerInfo && ownerInfo.codes.some((c) => c.method === ref.name && c.desc === ref.desc)) targets.push(ref.owner)
  for (const name of state.allClassNames) {
    if (name === ref.owner) continue
    if (isSubclassOf(index, name, ref.owner)) {
      const info = index.get(name)
      if (info && info.codes.some((c) => c.method === ref.name && c.desc === ref.desc)) targets.push(name)
    }
  }
  if (targets.length > 12) {
    state.diagnostics.abstains.push(`${key}: ${targets.length} overrides — too many, abstaining`)
    return
  }
  for (const target of targets) {
    const info = index.get(target)
    const m = info.codes.find((c) => c.method === ref.name && c.desc === ref.desc)
    const locals = [UNKNOWN, ...argVals]
    simulate(index, info, m, state, { ...opts, locals })
  }
}

function isSubclassOf (index, name, ancestor, depth = 0) {
  if (depth > 8 || !name || name === 'java/lang/Object') return false
  const info = index.get(name)
  if (!info) return false
  if (info.superName === ancestor || (info.interfaces || []).includes(ancestor)) return true
  return isSubclassOf(index, info.superName, ancestor, depth + 1) ||
    (info.interfaces || []).some((i) => isSubclassOf(index, i, ancestor, depth + 1))
}

// WRAPPER shape: read which PayloadRegistrar method each boolean branch of a
// wrapper method invokes (Mekanism PacketRegistrar.configuration/play/...).
function analyzeWrapperMethod (index, wrapperCls, methodName, desc, state) {
  const key = `${wrapperCls}.${methodName}${desc}`
  if (state.wrapperCache.has(key)) return state.wrapperCache.get(key)
  let result = null
  const info = index.get(wrapperCls)
  if (info) {
    const m = info.codes.find((c) => c.method === methodName && c.desc === desc)
    if (m) {
      const regInvokes = [] // {pc, name}
      let branch = null // {pc, target, negate}
      walkLinear(m.code, info.cp, (op, pc, cp, code) => {
        if (op === 0x99 || op === 0x9a) { // ifeq / ifne
          if (!branch) branch = { pc, target: pc + code.readInt16BE(pc + 1), negate: op === 0x99 }
        } else if (op === 0xb6 || op === 0xb9) {
          const ref = cpRef(cp, code.readUInt16BE(pc + 1))
          if (ref && ref.owner === REGISTRAR_TYPE && REGISTRATION_METHODS[ref.name]) regInvokes.push({ pc, name: ref.name })
        }
      })
      if (branch && regInvokes.length >= 2) {
        const inFallthrough = regInvokes.find((r) => r.pc > branch.pc && r.pc < branch.target)
        const inJumpTarget = regInvokes.find((r) => r.pc >= branch.target)
        if (inFallthrough && inJumpTarget) {
          // ifeq jumps away when the boolean is 0: the fallthrough arm is the
          // TRUE case. ifne is the reverse.
          result = {
            branches: branch.negate
              ? { true: inFallthrough.name, false: inJumpTarget.name }
              : { false: inFallthrough.name, true: inJumpTarget.name }
          }
        }
      } else if (regInvokes.length === 1) {
        result = { single: regInvokes[0].name }
      }
    }
  }
  state.wrapperCache.set(key, result)
  return result
}

// ---------- ENUM-REGISTRY shape (catnip) ----------

function deriveEnumRegistries (index, state, markers) {
  const out = []
  for (const name of state.allClassNames) {
    const bytes = index.rawBytes(name)
    if (!bytes) continue
    // cheap prefilter: enum + Type construction + toLowerCase
    if (!bytes.includes('java/lang/Enum') || !bytes.includes('CustomPacketPayload$Type') || !bytes.includes('toLowerCase')) continue
    const info = index.get(name)
    if (!info || info.superName !== 'java/lang/Enum') continue
    const ctor = info.codes.find((c) => c.method === '<init>')
    const clinit = info.codes.find((c) => c.method === '<clinit>')
    if (!ctor || !clinit) continue
    // ctor must lowercase name() and call a namespace helper
    let helperNs = null
    let lowercases = false
    walkLinear(ctor.code, info.cp, (op, pc, cp, code) => {
      if (op === 0xb6) {
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        if (ref && ref.name === 'toLowerCase') lowercases = true
      } else if (op === 0xb8) {
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        if (ref && ref.desc === `(Ljava/lang/String;)L${RESLOC_TYPE};`) {
          const helper = resolveNamespaceHelper(index, ref.owner, ref.name, ref.desc, state.helperCache)
          if (helper) helperNs = helper.nsPrefix
        }
      }
    })
    if (!lowercases || !helperNs) continue
    // constants from <clinit>: NEW E ... LDC constName ... LDC class ... invokespecial E.<init>
    const constants = []
    let current = null
    walkLinear(clinit.code, info.cp, (op, pc, cp, code) => {
      if (op === 0xbb && cpClassName(cp, code.readUInt16BE(pc + 1)) === name) {
        current = { name: null, classes: [] }
      } else if (current && (op === 0x12 || op === 0x13)) {
        const idx = op === 0x12 ? code[pc + 1] : code.readUInt16BE(pc + 1)
        const c = cp[idx]
        if (c && c.tag === 8 && current.name === null) current.name = cpUtf8(cp, c.strIndex)
        if (c && c.tag === 7) {
          const cls = cpUtf8(cp, c.nameIndex)
          if (cls !== name) current.classes.push(cls)
        }
      } else if (current && op === 0xb7) {
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        if (ref && ref.owner === name && ref.name === '<init>') {
          if (current.name) constants.push(current)
          current = null
        }
      }
    })
    if (!constants.length) continue
    // registry construction: NEW R; LDC modId; LDC version|iconst; invokespecial R.<init>(Ljava/lang/String;...)
    let registry = null
    for (const m of info.codes) {
      if (m.method === '<init>' || m.method === '<clinit>') continue
      let pendingNew = null
      const consts = []
      walkLinear(m.code, info.cp, (op, pc, cp, code) => {
        if (op === 0xbb) { pendingNew = cpClassName(cp, code.readUInt16BE(pc + 1)); consts.length = 0 } else if (pendingNew && (op === 0x12 || op === 0x13)) {
          const idx = op === 0x12 ? code[pc + 1] : code.readUInt16BE(pc + 1)
          const c = cp[idx]
          if (c && c.tag === 8) consts.push({ k: 'str', v: cpUtf8(cp, c.strIndex) })
          else if (c && c.tag === 3) consts.push({ k: 'int', v: c.int })
        } else if (pendingNew && op >= 0x02 && op <= 0x08) {
          consts.push({ k: 'int', v: op - 0x03 })
        } else if (pendingNew && (op === 0x10 || op === 0x11)) {
          consts.push({ k: 'int', v: op === 0x10 ? code.readInt8(pc + 1) : code.readInt16BE(pc + 1) })
        } else if (pendingNew && op === 0xb2) {
          const ref = cpRef(cp, code.readUInt16BE(pc + 1))
          if (ref && ref.desc === 'Ljava/lang/String;') {
            const resolved = resolveStringValue(index, { k: 'field', owner: ref.owner, name: ref.name, desc: ref.desc }, state)
            if (resolved !== null) consts.push({ k: 'str', v: resolved })
          }
        } else if (pendingNew && op === 0xb7) {
          const ref = cpRef(cp, code.readUInt16BE(pc + 1))
          if (ref && ref.owner === pendingNew && ref.name === '<init>' && ref.desc.startsWith('(Ljava/lang/String;')) {
            if (consts.length >= 2 && consts[0].k === 'str') {
              registry = { modId: consts[0].v, version: consts[1].k === 'str' ? consts[1].v : String(consts[1].v) }
            }
            pendingNew = null
          }
        }
      })
      if (registry) break
    }
    if (!registry) {
      state.diagnostics.abstains.push(`${name}: enum packet registry without (modId, version) construction`)
      continue
    }
    for (const c of constants) {
      const payloadClass = c.classes[0] || null
      const flow = payloadClass ? flowFromHierarchy(index, payloadClass, markers) : null
      const id = `${helperNs}:${c.name.toLowerCase()}`
      if (!flow) {
        state.diagnostics.abstains.push(`${id}: no flow marker on ${payloadClass}`)
        continue
      }
      out.push({
        id,
        version: registry.version,
        flow,
        optional: false,
        protocols: ['play'],
        source: `enum-registry ${name} (${registry.modId})`,
        jar: info.jar
      })
    }
  }
  return out
}

function flowFromHierarchy (index, cls, markers, depth = 0) {
  if (!cls || depth > 8) return null
  if (markers.clientbound.has(cls)) return 'clientbound'
  if (markers.serverbound.has(cls)) return 'serverbound'
  const info = index.get(cls)
  if (!info) return null
  for (const s of [info.superName, ...(info.interfaces || [])]) {
    const f = flowFromHierarchy(index, s, markers, depth + 1)
    if (f) return f
  }
  return null
}

// Marker interfaces are read out of loader-helper lambdas: a method taking the
// registrar event whose body pairs Class.isAssignableFrom checks with
// playToClient/playToServer registrations (catnip's NeoForgeNetworkHelper).
function discoverFlowMarkers (index, entryMethods) {
  const markers = { clientbound: new Set(), serverbound: new Set() }
  for (const { info, method } of entryMethods) {
    const classConsts = []
    const playInvokes = []
    let sawAssignable = false
    walkLinear(method.code, info.cp, (op, pc, cp, code) => {
      if (op === 0x12 || op === 0x13) {
        const idx = op === 0x12 ? code[pc + 1] : code.readUInt16BE(pc + 1)
        const c = cp[idx]
        if (c && c.tag === 7) classConsts.push(cpUtf8(cp, c.nameIndex))
      } else if (op === 0xb6 || op === 0xb9) {
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        if (ref && ref.name === 'isAssignableFrom') sawAssignable = true
        if (ref && (ref.name === 'playToClient' || ref.name === 'playToServer')) playInvokes.push(ref.name)
      }
    })
    if (sawAssignable && classConsts.length >= 2 && playInvokes.length >= 2) {
      // pair i-th marker constant with i-th play invoke kind
      for (let i = 0; i < Math.min(classConsts.length, playInvokes.length); i++) {
        if (playInvokes[i] === 'playToClient') markers.clientbound.add(classConsts[i])
        else markers.serverbound.add(classConsts[i])
      }
    }
  }
  return markers
}

// ---------- top-level derivation ----------

/**
 * Derive the NeoForge network component table from local jars.
 * @param {string[]} jarPaths mod jars (+ the neoforge universal jar when
 *   available — its NetworkInitialization carries the built-in channels)
 * @returns {{components: {configuration: Array, play: Array},
 *            diagnostics: {jars, abstains, errors, registrations}}}
 */
function deriveNeoForgeComponents (jarPaths) {
  const started = Date.now()
  const index = makeClassIndex()
  const diagnostics = { jars: [], abstains: [], errors: [], registrations: 0 }
  for (const p of jarPaths) collectJarClasses(p, index, diagnostics, path.basename(p))

  const state = {
    fieldValues: Object.create(null),
    typeFieldsResolved: new Set(),
    helperCache: new Map(),
    wrapperCache: new Map(),
    dispatched: new Set(),
    allClassNames: [...index.raw.keys()],
    diagnostics
  }

  // entry points: any method whose descriptor takes the registrar event
  const entryMethods = []
  for (const name of state.allClassNames) {
    const bytes = index.rawBytes(name)
    if (!bytes || !bytes.includes(EVENT_TYPE)) continue
    const info = index.get(name)
    if (!info) continue
    for (const m of info.codes) {
      if (m.desc.includes(`L${EVENT_TYPE};`)) entryMethods.push({ info, method: m })
    }
  }

  const registrations = []
  const record = (reg) => {
    const spec = REGISTRATION_METHODS[reg.method]
    if (!spec) return
    registrations.push({ ...reg, ...spec })
  }
  for (const { info, method } of entryMethods) {
    // locals seeded with unknowns; the event/registrar values are produced by
    // the interpreter when registrar() is invoked on the event argument.
    simulate(index, info, method, state, { onRegistration: record, recordPutstatic: false })
  }

  const markers = discoverFlowMarkers(index, entryMethods)
  const enumComponents = deriveEnumRegistries(index, state, markers)

  // assemble, applying the version rules
  const byProtocol = { configuration: new Map(), play: new Map() }
  const add = (id, version, flow, optional, protocols, source, versionSource) => {
    for (const proto of protocols) {
      if (!byProtocol[proto]) continue
      if (!byProtocol[proto].has(id)) {
        byProtocol[proto].set(id, { id, version, flow, optional, source, versionSource })
      }
    }
  }
  for (const reg of registrations) {
    diagnostics.registrations++
    let version = reg.registrar ? reg.registrar.version : null
    let versionSource = reg.registrar ? reg.registrar.versionSource : 'unresolved'
    const optional = reg.registrar ? reg.registrar.optional : false
    if (!reg.id) {
      diagnostics.abstains.push(`${reg.site}: ${reg.method} with unresolved payload type id`)
      continue
    }
    if (version === null) {
      const metaVersion = reg.jar && reg.jar.modVersion
      if (optional) {
        diagnostics.abstains.push(`${reg.id}: optional channel with unresolved version — safely unclaimed`)
        continue
      }
      if (metaVersion) {
        version = metaVersion
        versionSource = 'mods.toml'
      } else {
        diagnostics.abstains.push(`${reg.id}: required channel with no derivable version — join will be refused by the server`)
        continue
      }
    }
    add(reg.id, version, reg.flow, optional, reg.protocols, reg.site, versionSource)
  }
  for (const c of enumComponents) {
    add(c.id, c.version, c.flow, c.optional, c.protocols, c.source, 'enum-registry')
  }

  const components = {
    configuration: [...byProtocol.configuration.values()],
    play: [...byProtocol.play.values()]
  }
  debug(`neoforge derivation: ${components.configuration.length} configuration + ${components.play.length} play components from ${diagnostics.jars.length} jars (${diagnostics.abstains.length} abstains, ${Date.now() - started}ms)`)
  return { components, diagnostics }
}

module.exports = { deriveNeoForgeComponents }
