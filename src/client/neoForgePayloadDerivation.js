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
//   ANNOTATION-REGISTRY (HF9, annotationRegistryDerivation.js)  a reflective
//              class-name-codec registry: the subscriber iterates a supplier
//              map's Class keys, reads a direction ANNOTATION off each class,
//              builds the Type from getSimpleName() through a namespace
//              helper, and dispatches on the enum through javac's $SwitchMap
//              idiom (Pixelmon 9.4.0 PacketRegistry / tcg PacketRegistration,
//              javap-verified). Runs as a post-pass over the same entry
//              methods; contributes channel components AND the config-phase
//              sync-ack contracts (syncContracts) the responder answers.
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
const { zipCentralEntries, zipEntryData, parseClassFile, cpUtf8, cpClassName, cpRef, resolveLambdaImpl } = require('./jarAnalysis')
const { deriveAnnotationRegistries } = require('./annotationRegistryDerivation')
const { deriveWrapperFactoryListenChannels, deriveFabricListenChannels, deriveContainerCarriedListenChannels, assembleListenOnly } = require('./listenOnlyDerivation')

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
    } else if (e.name.startsWith('META-INF/services/') && !e.name.endsWith('/')) {
      // HF11: ServiceLoader ground truth — veil's platform Factory (and the
      // wider @ExpectPlatform service idiom) binds its implementation here,
      // not in bytecode. Names are dotted; store internal-form.
      try {
        const iface = e.name.slice('META-INF/services/'.length).replace(/\./g, '/')
        const impls = zipEntryData(buf, e).toString('utf8')
          .split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean)
          .map((l) => l.replace(/\./g, '/'))
        if (impls.length > 0) {
          const list = out.services.get(iface) || []
          out.services.set(iface, list.concat(impls))
        }
      } catch { /* tolerated: services are an optional resolution aid */ }
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
  const services = new Map() // interface internalName -> [impl internalName]
  const parsed = new Map()
  const index = {
    raw,
    services,
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

// Seed a callee's locals from a call's abstract argument values, laying them
// out at REAL JVM slot numbers: a category-2 argument (J/D) occupies TWO
// local slots, so a filler slot follows each long/double (HF-R3, verifier
// probe P8 — without the filler, every argument AFTER a J/D in the
// descriptor sits one slot low and a registrar there silently misses its
// registrations with zero abstains). The value itself is modeled as ONE
// abstract stack entry (matching ldc2_w), so only LOCALS carry the filler.
function seedArgLocals (desc, argVals, recvVal) {
  const locals = recvVal === undefined ? [] : [recvVal]
  const types = argSlots(desc)
  for (let i = 0; i < types.length; i++) {
    locals.push(argVals[i] ?? UNKNOWN)
    if (types[i] === 'J' || types[i] === 'D') locals.push(UNKNOWN) // second slot of the category-2 value
  }
  return locals
}

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
          // HF11: `tryBuild` is ResourceLocation's null-returning sibling of
          // fromNamespaceAndPath (same (String,String) shape, same namespace
          // semantics) — tracks_plus 1.0.6b2's `Tracks.path` helper builds
          // every payload id through it and the old list silently missed the
          // whole mod (3 required play channels abstained).
          if (ref && ref.owner === RESLOC_TYPE && (ref.name === 'fromNamespaceAndPath' || ref.name === 'tryBuild' || ref.name === 'm_339182_')) sawFrom = true
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

// HF16 rider — the third member of the static-field resolution family
// (String fields and Type fields already resolve through the owning class's
// own initializers): a static ResourceLocation FIELD on another class
// (`new Type(JadeIds.PACKET_SERVER_PING)` where JadeIds.<clinit> does
// JADE("server_ping_v1") → fromNamespaceAndPath("jade", ...)). Pre-fix these
// registrations abstained "unresolved payload type id" — negotiation-safe,
// but the HF15 send guard still kills the join when such a channel carries a
// login-time unconditional send and is neither claimed nor declared.
function resolveReslocValue (index, val, state) {
  if (!val) return null
  if (val.k === 'resloc') return val.v
  if (val.k === 'field' && val.desc === `L${RESLOC_TYPE};`) {
    const key = `${val.owner}.${val.name}`
    if (!(key in state.fieldValues)) resolveClassTypeFields(index, val.owner, state)
    const resolved = state.fieldValues[key]
    if (resolved && resolved.k === 'resloc') return resolved.v
  }
  return null
}

// ---------- the linear abstract interpreter ----------

function simulate (index, classInfo, method, state, opts = {}) {
  // HF11: every registration carries its true site-method identity so the
  // aggregation pass can re-simulate exactly the method that abstained.
  opts = { ...opts, methodCtx: { cls: classInfo.className, name: method.method, desc: method.desc, flags: method.flags } }
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
      // Category-2 constants/loads model as ONE abstract push (matching the
      // ldc2_w handling below): a long/double is a single value on this
      // abstract stack — only the LOCALS layout carries its second slot
      // (see seedArgLocals). Before HF-R3 these opcodes pushed NOTHING, so
      // any values beneath them were eaten by later pops and registrations
      // downstream silently missed.
      case 0x09: case 0x0a: push(UNKNOWN); break // lconst_0/1
      case 0x0b: case 0x0c: case 0x0d: push(UNKNOWN); break // fconst_0/1/2
      case 0x0e: case 0x0f: push(UNKNOWN); break // dconst_0/1
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
      case 0x1e: case 0x1f: case 0x20: case 0x21: push(locals[op - 0x1e] ?? UNKNOWN); break // lload_n (one abstract push)
      case 0x22: case 0x23: case 0x24: case 0x25: push(locals[op - 0x22] ?? UNKNOWN); break // fload_n
      case 0x26: case 0x27: case 0x28: case 0x29: push(locals[op - 0x26] ?? UNKNOWN); break // dload_n (one abstract push)
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
          // HF11: a construction-context object carries CONCRETE field values
          // bound by the aggregation pass's ctor-body simulation — read them.
          if (obj.fields && ref.name in obj.fields) { push(obj.fields[ref.name]); break }
          // record-style position binding: match ctor arg by declared order of
          // same-typed fields is overkill here; wrapper consumers read ctorArgs
          push({ k: 'instfield', obj, name: ref.name, desc: ref.desc })
        } else if (obj && (obj.k === 'this' || obj.k === 'param') && ref) {
          // HF11 provenance: an instance-field read on the entry receiver (or
          // a parameter) stays symbolic so the aggregation pass can see WHAT
          // the abstained id depended on and go find binding candidates.
          push({ k: 'provfield', src: obj, name: ref.name, desc: ref.desc })
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
      recv.ctorDesc = ref.desc // HF11: lets the aggregation pass bind fields on demand
      if (recv.cls === PAYLOAD_TYPE_CLASS && argVals[0]) {
        // HF16 rider: the ctor arg may be a cross-class static
        // ResourceLocation field — resolve it through the owner's own
        // initializer (resolveReslocValue), same law as String/Type fields.
        const rl = argVals[0].k === 'resloc' ? argVals[0].v : resolveReslocValue(index, argVals[0], state)
        if (rl !== null) {
          recv.k = 'type'
          recv.v = rl
        }
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
    // HF16 PARAM-PROVENANCE VERSION LAW: when the version argument is an
    // UNBOUND method parameter ({k:'param'} provenance), the true version
    // provably lives at the CALL SITES of this method (the event-helper
    // dispatch binds it there). Such a registration must never take the
    // mods.toml fallback downstream — that heuristic is justified only for
    // the registrar(modVersion) runtime idiom, and substituting the mod
    // version for an explicit per-channel constant fails the negotiation
    // (rig-proven: create_connected 1.3.2-mc1.21.1 vs "2.0.0").
    const fromParam = version === null && !!argVals[0] && argVals[0].k === 'param'
    push({ k: 'registrar', version, optional: false, versionSource: version !== null ? 'constant' : 'unresolved', versionFromParam: fromParam })
    return
  }
  if (recv && recv.k === 'registrar') {
    if (ref.name === 'versioned') {
      const version = asStr(argVals[0]) ?? resolveStringValue(index, argVals[0], state)
      const fromParam = version === null && !!argVals[0] && argVals[0].k === 'param'
      push({ ...recv, version, versionSource: version !== null ? 'constant' : 'unresolved', versionFromParam: fromParam })
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
        idVal: argVals[0],
        methodCtx: opts.methodCtx,
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
          idVal: argVals[0],
          methodCtx: opts.methodCtx,
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

  // EVENT-HELPER shape (HF16, the sixth registration shape): the EVENT rides
  // as an argument into a helper whose body calls event.registrar(...) —
  // with the version as an EXPLICIT CONSTANT AT THE CALL SITE
  // (create_connected 1.3.2: CCommon.register does
  // registerAsSyncRoot(event, "2.0.0"), the body living in superclass
  // SyncConfigBase). Dispatch into the callee with ALL call-site argument
  // values bound as locals so the constant reaches the registrar() the body
  // performs. Without this, the callee is only ever simulated as a bare
  // phantom entry (its version parameter unresolved) and the mods.toml
  // fallback silently claims the MOD version as the CHANNEL version — the
  // server refuses the join ("Incompatible client").
  if (argSlots(ref.desc).some((t) => t === `L${EVENT_TYPE};`)) {
    dispatchEventHelper(index, ref, call.kind, recv, argVals, state, opts)
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
    // HF11 helper-CHAIN fallback: the single-method pattern scan above only
    // reads one body, but mods layer their id helpers (createbigcannons
    // 5.11.7: `CreateBigCannons.resource(p)` = ldc ns + delegate to
    // `CBCUtils.location(ns, p)` which performs the real
    // fromNamespaceAndPath). Simulating the body value-faithfully resolves
    // any depth of straight-line delegation under the shared frame budget,
    // or returns null and the registration abstains exactly as before.
    const chained = simulateForReturn(index, ref, call.kind, recv, argVals, state, opts, 'resloc')
    push(chained && chained.k === 'resloc' ? chained : UNKNOWN)
    return
  }
  if (call.kind === 'static' && ref.owner === RESLOC_TYPE && ref.desc === `(Ljava/lang/String;Ljava/lang/String;)L${RESLOC_TYPE};`) {
    const ns = asStr(argVals[0]); const p = asStr(argVals[1])
    push(ns !== null && p !== null ? vResloc(`${ns}:${p}`) : UNKNOWN)
    return
  }
  // HF11: any OTHER in-index static helper returning a ResourceLocation
  // ((String,String) two-arg wrappers included) resolves by simulating its
  // body — same bounds, honest UNKNOWN on miss.
  if (call.kind === 'static' && ref.owner !== RESLOC_TYPE && ref.desc.endsWith(`)L${RESLOC_TYPE};`) && index.get(ref.owner)) {
    const chained = simulateForReturn(index, ref, call.kind, recv, argVals, state, opts, 'resloc')
    push(chained && chained.k === 'resloc' ? chained : UNKNOWN)
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
      state.diagnostics.abstains.push(`registration dispatch budget exhausted at ${key} — remaining registrations abstained`)
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
      const locals = kind === 'static' ? seedArgLocals(ref.desc, argVals) : seedArgLocals(ref.desc, argVals, recv ?? UNKNOWN)
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
      state.diagnostics.abstains.push(`registration dispatch budget exhausted at ${key} — remaining registrations abstained`)
    }
    return
  }
  const info = index.get(ref.owner)
  const m = info && info.codes.find((c) => c.method === '<init>' && c.desc === ref.desc)
  if (!m) return
  state.helperStack.add(key)
  try {
    const locals = seedArgLocals(ref.desc, argVals, recv ?? UNKNOWN)
    // onReturn stripped for the same reason as the helper dispatch: a ctor
    // body's stray areturn must never leak into a TYPE-factory resolution.
    simulate(index, info, m, state, { ...opts, locals, onReturn: undefined })
  } finally {
    state.helperStack.delete(key)
  }
}

// EVENT-HELPER shape dispatch (HF16): simulate a method that receives the
// RegisterPayloadHandlersEvent as an ARGUMENT, binding every call-site value
// (version constants included) as its locals. Resolution is
// invokevirtual-faithful: the ref owner may be a SUBCLASS of the class that
// declares the body (create_connected: the invokevirtual ref names CCommon
// while registerAsSyncRoot lives in SyncConfigBase), so the lookup walks the
// owner's superclass chain (findVirtualMethod — bounded, in-index only);
// instance calls additionally fan out to scanned subclass OVERRIDES with the
// same >12 loud-abstain bound the wrapper dispatch uses. Shares the
// registrar-helper cycle guard + global frame budget.
function dispatchEventHelper (index, ref, kind, recv, argVals, state, opts) {
  state.helperStack = state.helperStack || new Set()
  state.helperFrames = state.helperFrames || 0
  const key = `${ref.owner}.${ref.name}${ref.desc}`
  if (state.helperStack.has(key)) return // recursive helper: cycle guard
  if (++state.helperFrames > HELPER_FRAME_BUDGET) {
    if (!state.helperBudgetBlown) {
      state.helperBudgetBlown = true
      state.diagnostics.abstains.push(`registration dispatch budget exhausted at ${key} — remaining registrations abstained`)
    }
    return
  }
  const targets = [] // {info, m}
  const resolved = findVirtualMethod(index, ref.owner, ref.name, ref.desc)
  if (resolved) targets.push(resolved)
  if (kind === 'instance') {
    for (const name of state.allClassNames) {
      if (name === ref.owner) continue
      if (isSubclassOf(index, name, ref.owner)) {
        const info = index.get(name)
        const m = info && info.codes.find((c) => c.method === ref.name && c.desc === ref.desc && c.code && c.code.length > 0)
        if (m) targets.push({ info, m })
      }
    }
    if (targets.length > 12) {
      state.diagnostics.abstains.push(`${key}: ${targets.length} overrides carrying the payload-handlers event — too many, abstaining`)
      return
    }
  }
  if (targets.length === 0) return
  state.helperStack.add(key)
  try {
    for (const t of targets) {
      const locals = kind === 'static' ? seedArgLocals(ref.desc, argVals) : seedArgLocals(ref.desc, argVals, recv ?? UNKNOWN)
      // onReturn stripped: same leak law as the registrar-helper dispatch.
      simulate(index, t.info, t.m, state, { ...opts, locals, onReturn: undefined })
    }
  } finally {
    state.helperStack.delete(key)
  }
}

// Simulate a method body to learn its RETURN value (TYPE-factory helpers;
// HF11: ResourceLocation-returning helper chains via want='resloc').
// Shares the registrar-helper bounds (cycle guard + frame budget); returns
// the last want-shaped value the body returned, else the last returned value.
function simulateForReturn (index, ref, kind, recv, argVals, state, opts, want = 'type') {
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
    const locals = kind === 'static' ? seedArgLocals(ref.desc, argVals) : seedArgLocals(ref.desc, argVals, recv ?? UNKNOWN)
    simulate(index, info, m, state, {
      ...opts,
      locals,
      onReturn: (v) => {
        last = v
        if (v && v.k === want) best = v
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
    const locals = seedArgLocals(ref.desc, argVals, UNKNOWN)
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

// ---------- HF11: AGGREGATOR shape — collection/instance/lambda-mediated ----
//
// A fifth ecosystem shape (field receipt 40cd36c4, the NeoForge 1.21.1
// silent-close cluster): a REUSABLE REGISTRATION OBJECT whose per-channel
// facts (id, version, phase) enter at its jar-wide POPULATION SITES, not at
// the registrar call. Exemplars read from the shipped bytecode of that
// receipt's own pack:
//
//   - glitchcore 2.1.0.2 `MixinPacketHandler.register(RL, packet)` — the
//     registration lambda's captures carry the channel; its phase is the
//     packet class's own getPhase() routed through a javac $SwitchMap; its
//     negotiation VERSION is literally the channel's namespace string
//     (`event.registrar(namespace)` — and the `.versioned()` result is
//     discarded by the mod, `pop` at bc13, so the namespace stays). Callers:
//     GlitchCore.registerPackets (glitchcore:sync_config, CONFIGURATION) and
//     sereneseasons' ModPackets.init -> register (sync_season_cycle, PLAY).
//   - supermartijn642 core 1.1.21 `PacketChannel.handleRegistration` — the
//     channel Type lives in an instance field written by the constructor;
//     population sites are `PacketChannel.create(ns, name)` call chains
//     (rechiseled: create("rechiseled") -> "rechiseled:main",
//     commonBidirectional, versioned("1"), non-optional).
//
// Resolution = three generic moves, no mod names anywhere:
//   1. PROVENANCE: pass-1 entry simulation tags parameters/receiver, so an
//      abstained registration knows the method it fired in.
//   2. CONTEXT HARVEST: find jar-wide invocation sites of that method
//      (virtual calls, constructor calls, and invokedynamic captures for
//      lambda bodies — including the mixin/@ExpectPlatform graft idiom where
//      the referenced owner's own body is a throw-only stub and exactly one
//      substantive same-name+desc implementation exists elsewhere), binding
//      argument values; call sites whose arguments are themselves unresolved
//      parameters recurse into THEIR callers (bounded depth/breadth).
//   3. CANDIDATE RE-EVALUATION: re-run the site method once per concrete
//      context under a BRANCH-FOLLOWING evaluator (decided conditionals and
//      enum switches are taken for real: Class.isAssignableFrom over the
//      class index, enum-constant ordinals, the javac $SwitchMap idiom,
//      guard-clause throw avoidance) so each candidate registers through
//      exactly the arm the server itself would take. Only fully concrete
//      tuples are claimed; anything else stays a loud abstain, and a channel
//      resolving with CONFLICTING flows/versions is dropped loudly (a wrong
//      claim is worse than no claim).
//
// Honest limits (growth path, not silent): registration loops over runtime
// collections (catnip's packetsView — covered separately by the
// ENUM-REGISTRY shape; balm/jade/veil/DH — all `.optional()` and therefore
// lawfully unclaimed) and architectury's multi-hop aggregator chain remain
// abstains.

const CLASS_TYPE = 'java/lang/Class'
const AGG_MAX_DEPTH = 3
const AGG_MAX_CONTEXTS = 24
const AGG_MAX_STEPS_PER_EVAL = 30000
const AGG_TOTAL_STEP_BUDGET = 2400000

function seedProvenanceLocals (desc, isStatic, cls) {
  const locals = isStatic ? [] : [{ k: 'this', cls }]
  const types = argSlots(desc)
  for (let i = 0; i < types.length; i++) {
    locals.push({ k: 'param', i })
    if (types[i] === 'J' || types[i] === 'D') locals.push(UNKNOWN)
  }
  return locals
}

function isConcreteish (v) {
  return !!v && (v.k === 'str' || v.k === 'int' || v.k === 'resloc' || v.k === 'type' ||
    v.k === 'cls' || v.k === 'obj' || v.k === 'enumconst')
}

// Method lookup through the hierarchy (superclasses, then interfaces — the
// interface walk is what resolves default methods like glitchcore
// CustomPacket.getPhase()'s PLAY default).
function findVirtualMethod (index, cls, name, desc, depth = 0) {
  if (!cls || depth > 8) return null
  const info = index.get(cls)
  if (!info) return null
  const m = info.codes.find((c) => c.method === name && c.desc === desc && c.code && c.code.length > 0)
  if (m) return { info, m }
  const viaSuper = findVirtualMethod(index, info.superName, name, desc, depth + 1)
  if (viaSuper) return viaSuper
  for (const i of info.interfaces || []) {
    const viaIface = findVirtualMethod(index, i, name, desc, depth + 1)
    if (viaIface) return viaIface
  }
  return null
}

// A throw-only stub: the platform/mixin graft idiom — body constructs one
// exception and athrows, nothing else (glitchcore's common PacketHandler,
// architectury @ExpectPlatform stubs). The real body lives in exactly one
// substantive same-name+desc method elsewhere in the scanned jars.
function isThrowOnlyStub (m) {
  if (!m || !m.code || m.code.length === 0 || m.code.length > 16) return false
  return m.code[m.code.length - 1] === 0xbf // athrow last
}

function resolveGraftImpl (index, state, owner, name, desc) {
  const key = `graft:${owner}.${name}${desc}`
  if (state.aggCache.has(key)) return state.aggCache.get(key)
  let result = null
  const candidates = []
  for (const cls of state.allClassNames) {
    if (cls === owner) continue
    const bytes = index.rawBytes(cls)
    if (!bytes) continue
    const info = index.get(cls)
    if (!info) continue
    const m = info.codes.find((c) => c.method === name && c.desc === desc && !isThrowOnlyStub(c))
    if (m) candidates.push(cls)
    if (candidates.length > 1) break
  }
  if (candidates.length === 1) result = candidates[0]
  state.aggCache.set(key, result)
  return result
}

// Enum constant ordinal by <clinit> putstatic order of self-typed fields.
function enumOrdinal (index, state, cls, constName) {
  const key = `enumord:${cls}`
  if (!state.aggCache.has(key)) {
    const order = []
    const info = index.get(cls)
    const clinit = info && info.codes.find((c) => c.method === '<clinit>')
    if (info && clinit) {
      walkLinear(clinit.code, info.cp, (op, pc, cp, code) => {
        if (op === 0xb3) { // putstatic
          const ref = cpRef(cp, code.readUInt16BE(pc + 1))
          if (ref && ref.owner === cls && ref.desc === `L${cls};`) order.push(ref.name)
        }
      })
    }
    state.aggCache.set(key, order)
  }
  const order = state.aggCache.get(key)
  const i = order.indexOf(constName)
  return i >= 0 ? i : null
}

// The javac enum-switch idiom: a synthetic `$SwitchMap$...` int[] whose
// <clinit> stores a case index per enum constant (each store wrapped in its
// own try/catch; the normal path is linear). Returns {byName: {CONST: k}}.
function resolveSwitchMap (index, state, owner, fieldName) {
  const key = `swmap:${owner}.${fieldName}`
  if (state.aggCache.has(key)) return state.aggCache.get(key)
  let result = null
  const info = index.get(owner)
  const clinit = info && info.codes.find((c) => c.method === '<clinit>')
  if (info && clinit) {
    const byName = {}
    const byOrd = {}
    let pendingConst = null
    let pendingInt = null
    walkLinear(clinit.code, info.cp, (op, pc, cp, code) => {
      if (op === 0xb2) { // getstatic
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        if (ref && ref.desc === `L${ref.owner};`) pendingConst = { owner: ref.owner, name: ref.name }
      } else if (op >= 0x02 && op <= 0x08) {
        pendingInt = op - 0x03
      } else if (op === 0x10) {
        pendingInt = code.readInt8(pc + 1)
      } else if (op === 0x11) {
        pendingInt = code.readInt16BE(pc + 1)
      } else if (op === 0x4f) { // iastore
        if (pendingConst !== null && pendingInt !== null) {
          byName[pendingConst.name] = pendingInt
          const ord = enumOrdinal(index, state, pendingConst.owner, pendingConst.name)
          if (ord !== null) byOrd[ord] = pendingInt
        }
        pendingConst = null
        pendingInt = null
      }
    })
    if (Object.keys(byName).length > 0) result = { byName, byOrd }
  }
  state.aggCache.set(key, result)
  return result
}

// Bind an abstract object's instance fields by evaluating its constructor
// body with the construction-site arguments (putfield writes land in
// obj.fields; chained getfields inside the ctor read them back).
function bindCtorFields (index, state, obj) {
  if (!obj || obj.k !== 'obj' || obj.fieldsBound) return
  obj.fieldsBound = true
  obj.fields = obj.fields || {}
  const info = index.get(obj.cls)
  if (!info || !obj.ctorDesc) return
  const m = info.codes.find((c) => c.method === '<init>' && c.desc === obj.ctorDesc)
  if (!m) return
  const locals = seedArgLocals(obj.ctorDesc, obj.ctorArgs || [], obj)
  evaluateMethod(index, info, m, state, { locals, recordPutstatic: false }, {})
}

// Peek ahead from pc: does this arm hit an athrow within a few instructions
// before branching away? (Guard-clause idiom: `if (!valid(x)) throw ...` —
// with the condition unknown, prefer the arm that does not immediately
// throw, so validation guards don't silently kill the harvest.)
function armThrowsImmediately (code, startPc, cp) {
  let pc = startPc
  let steps = 0
  const { JVM_OP_LEN } = require('./jarAnalysis')
  while (pc < code.length && steps < 16) {
    const op = code[pc]
    if (op === 0xbf) return true // athrow
    if (op === 0xa7 || op === 0xc8 || (op >= 0x99 && op <= 0xa6) || op === 0xb0 || op === 0xb1 || op === 0xac) return false
    let len = JVM_OP_LEN[op]
    if (op === 0xaa) { const p = (pc + 4) & ~3; len = (p - pc) + 12 + (code.readInt32BE(p + 8) - code.readInt32BE(p + 4) + 1) * 4 } else if (op === 0xab) { const p = (pc + 4) & ~3; len = (p - pc) + 8 + code.readInt32BE(p + 4) * 8 } else if (op === 0xc4) { len = code[pc + 1] === 0x84 ? 6 : 4 }
    pc += len
    steps++
  }
  return false
}

// The branch-following evaluator: simulate()'s value model with real control
// flow. Decided conditionals and enum switches are TAKEN (so a candidate
// registers through exactly the arm the server would take); unknown
// conditionals fall through, except that an arm which immediately athrows is
// avoided. Bounded by per-pc revisit counts, a per-evaluation step cap and a
// shared total budget — exhaustion is a loud abstain upstream, never a spin.
function evaluateMethod (index, classInfo, method, state, opts = {}, hooks = {}) {
  state.aggCache = state.aggCache || new Map()
  opts = { ...opts, methodCtx: { cls: classInfo.className, name: method.method, desc: method.desc, flags: method.flags } }
  const cp = classInfo.cp
  const code = method.code
  const stack = []
  const locals = opts.locals ? opts.locals.slice() : []
  const pop = (n = 1) => { for (let i = 0; i < n; i++) stack.pop() }
  const push = (v) => stack.push(v)
  const visits = new Map()
  const { JVM_OP_LEN } = require('./jarAnalysis')
  state.aggSteps = state.aggSteps || 0
  let steps = 0
  let pc = 0

  const instrLen = (p) => {
    const op = code[p]
    let len = JVM_OP_LEN[op]
    if (op === 0xaa) { const a = (p + 4) & ~3; len = (a - p) + 12 + (code.readInt32BE(a + 8) - code.readInt32BE(a + 4) + 1) * 4 } else if (op === 0xab) { const a = (p + 4) & ~3; len = (a - p) + 8 + code.readInt32BE(a + 4) * 8 } else if (op === 0xc4) { len = code[p + 1] === 0x84 ? 6 : 4 }
    return len
  }

  while (pc >= 0 && pc < code.length) {
    if (++steps > AGG_MAX_STEPS_PER_EVAL || ++state.aggSteps > AGG_TOTAL_STEP_BUDGET) {
      state.aggBudgetBlown = true
      return
    }
    const seen = (visits.get(pc) || 0) + 1
    visits.set(pc, seen)
    if (seen > 64) return // loop bound (collection expansion iterates for real)
    const op = code[pc]
    const next = pc + instrLen(pc)
    let jumped = false
    const jump = (target) => { pc = target; jumped = true }
    const condBranch = (target, known, takeJump) => {
      if (known) {
        if (takeJump) jump(target)
        return
      }
      // unknown condition: avoid an immediately-throwing arm
      if (armThrowsImmediately(code, next, cp) && !armThrowsImmediately(code, target, cp)) jump(target)
      // else fall through
    }

    switch (op) {
      case 0x01: push(UNKNOWN); break
      case 0x02: case 0x03: case 0x04: case 0x05: case 0x06: case 0x07: case 0x08:
        push(vInt(op - 0x03)); break
      case 0x09: case 0x0a: case 0x0b: case 0x0c: case 0x0d: case 0x0e: case 0x0f: push(UNKNOWN); break
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
      case 0x14: push(UNKNOWN); break
      case 0x15: case 0x16: case 0x17: case 0x18: case 0x19:
        push(locals[code[pc + 1]] ?? UNKNOWN); break
      case 0x1a: case 0x1b: case 0x1c: case 0x1d: push(locals[op - 0x1a] ?? UNKNOWN); break
      case 0x1e: case 0x1f: case 0x20: case 0x21: push(locals[op - 0x1e] ?? UNKNOWN); break
      case 0x22: case 0x23: case 0x24: case 0x25: push(locals[op - 0x22] ?? UNKNOWN); break
      case 0x26: case 0x27: case 0x28: case 0x29: push(locals[op - 0x26] ?? UNKNOWN); break
      case 0x2a: case 0x2b: case 0x2c: case 0x2d: push(locals[op - 0x2a] ?? UNKNOWN); break
      case 0x32: { // aaload — materialized arrays (enum values()) yield elements
        const idx = stack.pop()
        const arr = stack.pop()
        if (arr && arr.k === 'varr' && idx && idx.k === 'int') push(arr.items[idx.v] ?? UNKNOWN)
        else push(UNKNOWN)
        break
      }
      case 0xbe: { // arraylength
        const arr = stack.pop()
        push(arr && arr.k === 'varr' ? vInt(arr.items.length) : UNKNOWN)
        break
      }
      case 0x2e: { // iaload — the $SwitchMap read
        const idx = stack.pop()
        const arr = stack.pop()
        if (arr && arr.k === 'switchmap' && idx && idx.k === 'enumconst' && idx.name in arr.byName) {
          push(vInt(arr.byName[idx.name]))
        } else if (arr && arr.k === 'switchmap' && idx && idx.k === 'int' && idx.v in arr.byOrd) {
          push(vInt(arr.byOrd[idx.v]))
        } else push(UNKNOWN)
        break
      }
      case 0x36: case 0x37: case 0x38: case 0x39: case 0x3a:
        locals[code[pc + 1]] = stack.pop(); break
      case 0x3b: case 0x3c: case 0x3d: case 0x3e: locals[op - 0x3b] = stack.pop(); break
      case 0x3f: case 0x40: case 0x41: case 0x42: locals[op - 0x3f] = stack.pop(); break // lstore_n
      case 0x43: case 0x44: case 0x45: case 0x46: locals[op - 0x43] = stack.pop(); break // fstore_n
      case 0x47: case 0x48: case 0x49: case 0x4a: locals[op - 0x47] = stack.pop(); break // dstore_n
      case 0x4b: case 0x4c: case 0x4d: case 0x4e: locals[op - 0x4b] = stack.pop(); break
      case 0x57: pop(); break
      case 0x58: pop(2); break
      case 0x59: push(stack[stack.length - 1]); break
      case 0x5a: { const a = stack.pop(); const b = stack.pop(); push(a); push(b); push(a); break }
      case 0x5c: { const a = stack[stack.length - 1]; const b = stack[stack.length - 2]; push(b); push(a); break }
      case 0x84: { // iinc — real counters keep enum-values() loops finite
        const slot = code[pc + 1]
        const delta = code.readInt8(pc + 2)
        const cur = locals[slot]
        locals[slot] = cur && cur.k === 'int' ? vInt(cur.v + delta) : UNKNOWN
        break
      }
      case 0xb2: { // getstatic — switchmaps and enum constants get real values
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        if (!ref) { push(UNKNOWN); break }
        if (ref.desc === '[I' && ref.name.startsWith('$SwitchMap$')) {
          const map = resolveSwitchMap(index, state, ref.owner, ref.name)
          push(map ? { k: 'switchmap', byName: map.byName, byOrd: map.byOrd || {} } : UNKNOWN)
          break
        }
        if (ref.desc === `L${ref.owner};`) {
          const ownerInfo = index.get(ref.owner)
          if (ownerInfo && ownerInfo.superName === 'java/lang/Enum') {
            push({ k: 'enumconst', cls: ref.owner, name: ref.name })
            break
          }
        }
        const key = `${ref.owner}.${ref.name}`
        if (key in state.fieldValues) push(state.fieldValues[key])
        else push({ k: 'field', owner: ref.owner, name: ref.name, desc: ref.desc })
        break
      }
      case 0xb3: { // putstatic
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        const val = stack.pop()
        if (ref && val && opts.recordPutstatic) state.fieldValues[`${ref.owner}.${ref.name}`] = val
        break
      }
      case 0xb4: { // getfield — construction-bound objects read real values
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        const obj = stack.pop()
        if (obj && obj.k === 'obj' && ref) {
          if (!obj.fieldsBound && obj.ctorDesc && index.get(obj.cls)) bindCtorFields(index, state, obj)
          if (obj.fields && ref.name in obj.fields) { push(obj.fields[ref.name]); break }
          push({ k: 'instfield', obj, name: ref.name, desc: ref.desc })
        } else push(UNKNOWN)
        break
      }
      case 0xb5: { // putfield — binds fields on the object under construction
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        const val = stack.pop()
        const obj = stack.pop()
        if (obj && obj.k === 'obj' && ref) {
          obj.fields = obj.fields || {}
          obj.fields[ref.name] = val
        }
        break
      }
      case 0xbb: {
        const cls = cpClassName(cp, code.readUInt16BE(pc + 1))
        push({ k: 'new', cls })
        break
      }
      case 0xbd: pop(1); push({ k: 'arr' }); break
      case 0x53: pop(3); break
      case 0xb6: case 0xb7: case 0xb9: {
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        if (!ref) break
        const args = argSlots(ref.desc)
        const argVals = []
        for (let i = args.length - 1; i >= 0; i--) argVals[i] = stack.pop()
        const recv = stack.pop()
        if (hooks.onCall) hooks.onCall(ref, 'instance', recv, argVals)
        if (evaluatorPreInvoke(index, state, opts, ref, recv, argVals, push, hooks)) break
        handleInvoke(index, classInfo, state, opts, { kind: 'instance', ref, recv, argVals, push, pc })
        // focus-pass hook: an aggregator instance just finished constructing
        if (ref.name === '<init>' && recv && recv.k === 'obj' && state.aggFocus &&
            recv.cls === state.aggFocus && state.aggConstructed && !state.aggConstructed.includes(recv)) {
          state.aggConstructed.push(recv)
        }
        break
      }
      case 0xb8: {
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        if (!ref) break
        const args = argSlots(ref.desc)
        const argVals = []
        for (let i = args.length - 1; i >= 0; i--) argVals[i] = stack.pop()
        if (hooks.onCall) hooks.onCall(ref, 'static', null, argVals)
        if (evaluatorPreInvoke(index, state, opts, ref, null, argVals, push, hooks)) break
        handleInvoke(index, classInfo, state, opts, { kind: 'static', ref, recv: null, argVals, push, pc })
        break
      }
      case 0xba: { // invokedynamic — capture values surface to the harvest
        const c = cp[code.readUInt16BE(pc + 1)]
        const nat = c && cp[c.natIndex]
        const desc = nat ? cpUtf8(cp, nat.descIndex) : '()V'
        const nArgs = argSlots(desc).length
        const captured = []
        for (let i = nArgs - 1; i >= 0; i--) captured[i] = stack.pop()
        if (hooks.onIndy && c && classInfo.bootstrapMethods) {
          const impl = resolveLambdaImpl(classInfo, c.bsmIndex)
          if (impl) hooks.onIndy(impl, captured)
        }
        if (!returnsVoid(desc)) push(UNKNOWN)
        break
      }
      case 0xb0: {
        const v = stack.pop()
        if (opts.onReturn) opts.onReturn(v)
        return
      }
      case 0xac: case 0xad: case 0xae: case 0xaf: pop(); return // ireturn family
      case 0xb1: return // return
      case 0xbf: return // athrow: path ends
      case 0xc0: break // checkcast
      case 0xc1: pop(); push(UNKNOWN); break // instanceof
      case 0xa7: jump(pc + code.readInt16BE(pc + 1)); break // goto
      case 0xc8: jump(pc + code.readInt32BE(pc + 1)); break // goto_w
      case 0x99: { // ifeq
        const v = stack.pop()
        condBranch(pc + code.readInt16BE(pc + 1), v && v.k === 'int', v && v.k === 'int' && v.v === 0)
        break
      }
      case 0x9a: { // ifne
        const v = stack.pop()
        condBranch(pc + code.readInt16BE(pc + 1), v && v.k === 'int', v && v.k === 'int' && v.v !== 0)
        break
      }
      case 0x9b: case 0x9c: case 0x9d: case 0x9e: { // iflt/ge/gt/le
        const v = stack.pop()
        const known = v && v.k === 'int'
        const take = known && (
          (op === 0x9b && v.v < 0) || (op === 0x9c && v.v >= 0) ||
          (op === 0x9d && v.v > 0) || (op === 0x9e && v.v <= 0))
        condBranch(pc + code.readInt16BE(pc + 1), known, take)
        break
      }
      case 0x9f: case 0xa0: case 0xa1: case 0xa2: case 0xa3: case 0xa4: { // if_icmp*
        const b = stack.pop(); const a = stack.pop()
        const known = a && a.k === 'int' && b && b.k === 'int'
        const take = known && (
          (op === 0x9f && a.v === b.v) || (op === 0xa0 && a.v !== b.v) ||
          (op === 0xa1 && a.v < b.v) || (op === 0xa2 && a.v >= b.v) ||
          (op === 0xa3 && a.v > b.v) || (op === 0xa4 && a.v <= b.v))
        condBranch(pc + code.readInt16BE(pc + 1), known, take)
        break
      }
      case 0xa5: case 0xa6: { // if_acmpeq/ne — undecidable here
        pop(2)
        condBranch(pc + code.readInt16BE(pc + 1), false, false)
        break
      }
      case 0xc6: case 0xc7: { // ifnull / ifnonnull
        const v = stack.pop()
        const knownNonnull = !!v && (v.k === 'str' || v.k === 'int' || v.k === 'resloc' || v.k === 'type' || v.k === 'cls' || v.k === 'obj' || v.k === 'new' || v.k === 'enumconst' || v.k === 'registrar')
        condBranch(pc + code.readInt16BE(pc + 1), knownNonnull, knownNonnull && op === 0xc7)
        break
      }
      case 0xaa: { // tableswitch
        const v = stack.pop()
        const a = (pc + 4) & ~3
        const def = pc + code.readInt32BE(a)
        const lo = code.readInt32BE(a + 4)
        const hi = code.readInt32BE(a + 8)
        if (v && v.k === 'int' && v.v >= lo && v.v <= hi) jump(pc + code.readInt32BE(a + 12 + (v.v - lo) * 4))
        else jump(def)
        break
      }
      case 0xab: { // lookupswitch
        const v = stack.pop()
        const a = (pc + 4) & ~3
        const def = pc + code.readInt32BE(a)
        const n = code.readInt32BE(a + 4)
        let target = def
        if (v && v.k === 'int') {
          for (let i = 0; i < n; i++) {
            if (code.readInt32BE(a + 8 + i * 8) === v.v) { target = pc + code.readInt32BE(a + 12 + i * 8); break }
          }
        }
        jump(target)
        break
      }
      default: break
    }
    if (!jumped) pc = next
  }
}

// Evaluator-only invoke semantics layered ABOVE handleInvoke: real answers
// for the reflection/enum/RL calls the aggregator shapes route ids through.
// Returns true when the call was fully handled (value pushed as needed).
function evaluatorPreInvoke (index, state, opts, ref, recv, argVals, push, hooks = {}) {
  // collection modeling by OBJECT IDENTITY: `add` on any abstract object
  // gathers concrete elements onto that object; `iterator` replays exactly
  // them. This is what keeps multi-instance aggregators separate (each
  // manager's HashSet is its own vObj) — per-instance versions never mix.
  if (recv && recv.k === 'obj' && ref.name === 'add' && ref.desc === '(Ljava/lang/Object;)Z') {
    recv.items = recv.items || []
    if (isConcreteish(argVals[0]) && recv.items.length < 192) recv.items.push(argVals[0])
    push(vInt(1))
    return true
  }
  // NOTE: every {k:'obj'} was CONSTRUCTED inside this evaluation universe
  // (symbolic values stay {k:'field'}/{k:'param'}/UNKNOWN), so an obj with
  // no captured adds truthfully iterates EMPTY — an unknown-hasNext loop
  // would instead spin to the visit cap and abort the whole method (the
  // aeronautics manager's empty clientbound set killed its serverbound
  // harvest exactly that way).
  if (recv && (recv.k === 'collection' || recv.k === 'obj') && ref.name === 'iterator' && argVals.length === 0) {
    push({ k: 'iter', items: recv.items || [], i: 0 })
    return true
  }
  if (recv && recv.k === 'iter') {
    if (ref.name === 'hasNext') { push(vInt(recv.i < recv.items.length ? 1 : 0)); return true }
    if (ref.name === 'next') { push(recv.items[recv.i++] ?? UNKNOWN); return true }
  }
  // Class.isAssignableFrom over the scanned hierarchy
  if (ref.owner === CLASS_TYPE && ref.name === 'isAssignableFrom' && recv && recv.k === 'cls' && argVals[0] && argVals[0].k === 'cls') {
    const a = recv.v; const b = argVals[0].v
    push(vInt(a === b || isSubclassOf(index, b, a) ? 1 : 0))
    return true
  }
  // Enum.ordinal() on a known constant
  if (ref.name === 'ordinal' && ref.desc === '()I' && recv && recv.k === 'enumconst') {
    const ord = enumOrdinal(index, state, recv.cls, recv.name)
    push(ord === null ? UNKNOWN : vInt(ord))
    return true
  }
  // Enum name()/ordinal() on a construction-bound constant: javac passes
  // (name, ordinal) as the first two ctor args of every enum constructor —
  // this is what makes `name().toLowerCase(ROOT)` channel ids concrete
  // (Create's AllPackets idiom) under the aggregation evaluator.
  if (recv && recv.k === 'obj' && recv.ctorArgs && index.get(recv.cls) && index.get(recv.cls).superName === 'java/lang/Enum') {
    if (ref.name === 'name' && ref.desc === '()Ljava/lang/String;' && recv.ctorArgs[0]) {
      push(recv.ctorArgs[0])
      return true
    }
    if (ref.name === 'ordinal' && ref.desc === '()I' && recv.ctorArgs[1]) {
      push(recv.ctorArgs[1])
      return true
    }
  }
  // ResourceLocation accessors on a resolved id
  if (recv && recv.k === 'resloc' && ref.desc === '()Ljava/lang/String;') {
    const [ns, ...rest] = String(recv.v).split(':')
    if (ref.name === 'getNamespace') { push(vStr(ns)); return true }
    if (ref.name === 'getPath') { push(vStr(rest.join(':'))); return true }
    if (ref.name === 'toString') { push(vStr(recv.v)); return true }
  }
  // String.toLowerCase on a known string
  if (ref.owner === 'java/lang/String' && ref.name === 'toLowerCase' && recv && recv.k === 'str') {
    push(vStr(recv.v.toLowerCase()))
    return true
  }
  // chained constructor delegation on an object under construction
  if (ref.name === '<init>' && recv && recv.k === 'obj' && index.get(ref.owner)) {
    const info = index.get(ref.owner)
    const m = info.codes.find((c) => c.method === '<init>' && c.desc === ref.desc)
    if (m && !state.aggCtorStack?.has(`${ref.owner}${ref.desc}`)) {
      state.aggCtorStack = state.aggCtorStack || new Set()
      const key = `${ref.owner}${ref.desc}`
      state.aggCtorStack.add(key)
      try {
        evaluateMethod(index, info, m, state, { locals: seedArgLocals(ref.desc, argVals, recv), recordPutstatic: false }, {})
      } finally {
        state.aggCtorStack.delete(key)
      }
      return true
    }
    return false
  }
  // enum values(): materialize the constant array by evaluating the enum's
  // own <clinit> once — each constant is a construction-bound object whose
  // fields (payload class, codec, the Type built from name()) are readable.
  if (!recv && ref.name === 'values' && ref.desc === `()[L${ref.owner};`) {
    const info = index.get(ref.owner)
    if (info && info.superName === 'java/lang/Enum') {
      const cacheKey = `enumvals:${ref.owner}`
      if (!state.aggCache.has(cacheKey)) {
        state.aggCache.set(cacheKey, { items: [] }) // cycle guard
        const clinit = info.codes.find((c) => c.method === '<clinit>')
        if (clinit) {
          evaluateMethod(index, info, clinit, state, { locals: [], recordPutstatic: true }, {})
        }
        const items = []
        walkLinear(clinit ? clinit.code : Buffer.alloc(0), info.cp, (op2, pc2, cp2, code2) => {
          if (op2 === 0xb3) {
            const fref = cpRef(cp2, code2.readUInt16BE(pc2 + 1))
            if (fref && fref.owner === ref.owner && fref.desc === `L${ref.owner};`) {
              const v = state.fieldValues[`${fref.owner}.${fref.name}`]
              items.push(v ?? UNKNOWN)
            }
          }
        })
        state.aggCache.set(cacheKey, { items })
      }
      push({ k: 'varr', items: state.aggCache.get(cacheKey).items })
      return true
    }
  }
  // JDK collection view wrappers are identity for our purposes: the wrapped
  // collection's captured elements ARE the view's elements (catnip's
  // packetsView = Collections.unmodifiableSet(packets)).
  if (!recv && ref.owner === 'java/util/Collections' &&
      (ref.name.startsWith('unmodifiable') || ref.name.startsWith('synchronized')) && argVals.length === 1) {
    push(argVals[0])
    return true
  }
  // ServiceLoader idiom: a call written against an interface whose unique
  // implementation is named by a META-INF/services file dispatches into that
  // implementation (veil's platform Factory.create). The services file is
  // primary-source truth, never a guess; ambiguity (several impls) abstains.
  if ((!recv || recv.k === 'field' || recv === UNKNOWN) && index.services) {
    const impls = index.services.get(ref.owner)
    if (impls && new Set(impls).size === 1 && index.get(impls[0])) {
      const implRecv = { k: 'obj', cls: impls[0], fields: {}, fieldsBound: true, serviceImpl: true }
      return inlineDispatch(index, state, opts, implRecv, ref, argVals, push, hooks)
    }
  }
  // in-index virtual call on an abstract object: run the REAL body
  // (hierarchy-resolved, interface defaults included) — this is what turns
  // packet.getPhase() / factory.type() into concrete values and lets an
  // aggregator's registerX(...) population methods execute for real against
  // the exact instance being resolved.
  if (recv && recv.k === 'obj' && ref.name !== '<init>') {
    return inlineDispatch(index, state, opts, recv, ref, argVals, push, hooks)
  }
  // in-index STATIC call within the aggregation focus scope (the aggregator
  // class and its ancestors): factory chains like PacketChannel.create /
  // VeilPacketManager.create evaluate for real, yielding the constructed
  // aggregator object.
  if (!recv && ((state.aggStaticScope && state.aggStaticScope.has(ref.owner)) || state.aggInlineAll) && index.get(ref.owner)) {
    const info = index.get(ref.owner)
    const m = info.codes.find((c) => c.method === ref.name && c.desc === ref.desc)
    if (m) {
      state.aggInlineStack = state.aggInlineStack || new Set()
      const key = `s:${ref.owner}.${ref.name}${ref.desc}`
      if (state.aggInlineStack.has(key) || state.aggInlineStack.size > 24) return false
      state.aggInlineStack.add(key)
      let returned
      try {
        evaluateMethod(index, info, m, state, {
          locals: seedArgLocals(ref.desc, argVals),
          recordPutstatic: false,
          onReturn: (v) => { returned = v },
          onRegistration: opts.onRegistration
        }, hooks)
      } finally {
        state.aggInlineStack.delete(key)
      }
      if (!returnsVoid(ref.desc)) push(returned ?? UNKNOWN)
      return true
    }
  }
  return false
}

// Inline a virtual/interface call against a concrete receiver's real method
// body; adopts the return value. Cycle-guarded and depth-bounded — a miss
// falls back to handleInvoke's abstract handling (returns false).
function inlineDispatch (index, state, opts, recv, ref, argVals, push, hooks = {}) {
  const target = findVirtualMethod(index, recv.cls, ref.name, ref.desc)
  if (!target) return false
  state.aggInlineStack = state.aggInlineStack || new Set()
  const key = `${recv.cls}.${ref.name}${ref.desc}`
  if (state.aggInlineStack.has(key) || state.aggInlineStack.size > 24) return false
  state.aggInlineStack.add(key)
  let returned
  try {
    evaluateMethod(index, target.info, target.m, state, {
      locals: seedArgLocals(ref.desc, argVals, recv),
      recordPutstatic: false,
      onReturn: (v) => { returned = v },
      onRegistration: opts.onRegistration
    }, hooks)
  } finally {
    state.aggInlineStack.delete(key)
  }
  if (!returnsVoid(ref.desc)) push(returned ?? UNKNOWN)
  return true
}

// Jar-wide invocation harvest for one method: every (class, method) whose
// bytecode invokes the target (owner-exact, subclass owners, throw-only-stub
// grafts) or captures it through an invokedynamic. Bounded by the rawBytes
// prefilter (a caller must name the owner or the graft stub's owner).
function findInvocationSites (index, state, target) {
  const key = `sites:${target.cls}.${target.name}${target.desc}`
  if (state.aggCache.has(key)) return state.aggCache.get(key)
  const sites = []
  const simpleOwner = target.cls.split('/').pop()
  // owners whose invocation resolves to the target: itself + throw-only
  // stubs it grafts onto (glitchcore PacketHandler <- MixinPacketHandler)
  const ownerAliases = new Set([target.cls])
  for (const cls of state.allClassNames) {
    if (cls === target.cls) continue
    const info = index.get(cls)
    if (!info) continue
    const stub = info.codes.find((c) => c.method === target.name && c.desc === target.desc && isThrowOnlyStub(c))
    if (stub && resolveGraftImpl(index, state, cls, target.name, target.desc) === target.cls) ownerAliases.add(cls)
  }
  // abstract-owner aliasing: an invocation written against an interface or
  // abstract ancestor (VeilPacketManager.registerClientbound, the platform
  // Factory.create service idiom) resolves to the target implementation —
  // but ONLY when the target is the unique coded implementer among that
  // ancestor's scanned subclasses (two-loader merged jars ship several).
  for (const anc of state.allClassNames) {
    if (ownerAliases.has(anc)) continue
    if (!isSubclassOf(index, target.cls, anc)) continue
    const ancInfo = index.get(anc)
    if (!ancInfo) continue
    if (ancInfo.codes.some((c) => c.method === target.name && c.desc === target.desc)) continue
    let implementers = 0
    for (const sub of state.allClassNames) {
      if (!isSubclassOf(index, sub, anc) && sub !== anc) continue
      const subInfo = index.get(sub)
      if (subInfo && subInfo.codes.some((c) => c.method === target.name && c.desc === target.desc && !isThrowOnlyStub(c))) implementers++
      if (implementers > 1) break
    }
    if (implementers === 1) ownerAliases.add(anc)
  }
  const aliasSimple = [...ownerAliases].map((o) => o.split('/').pop())
  for (const cls of state.allClassNames) {
    const bytes = index.rawBytes(cls)
    if (!bytes) continue
    if (!aliasSimple.some((s) => bytes.includes(s))) continue
    const info = index.get(cls)
    if (!info) continue
    for (const m of info.codes) {
      if (cls === target.cls && m.method === target.name && m.desc === target.desc) continue
      let matched = false
      walkLinear(m.code, info.cp, (op, pc, cp, code) => {
        if (matched) return
        if (op === 0xb6 || op === 0xb7 || op === 0xb8 || op === 0xb9) {
          const ref = cpRef(cp, code.readUInt16BE(pc + 1))
          if (ref && ref.name === target.name && ref.desc === target.desc && ownerAliases.has(ref.owner)) matched = true
        } else if (op === 0xba && info.bootstrapMethods) {
          const c = cp[code.readUInt16BE(pc + 1)]
          const impl = c && resolveLambdaImpl(info, c.bsmIndex)
          if (impl && impl.name === target.name && impl.desc === target.desc && ownerAliases.has(impl.owner)) matched = true
        }
      })
      if (matched) sites.push({ cls, method: m.method, desc: m.desc })
    }
    if (sites.length > 64) break
  }
  if (process.env.MINEPAL_AGG_DEBUG) {
    debug(`agg sites ${target.cls}.${target.name}: aliases=${[...ownerAliases].join(',')} sites=${sites.map((s) => `${s.cls}.${s.method}`).join(' | ')}`)
  }
  state.aggCache.set(key, sites)
  return sites
}

// Concrete calling contexts for a method: run each invocation site under the
// evaluator, collect the argument values at the matching call; sites whose
// arguments are themselves unresolved parameters recurse into THEIR callers.
// A context is {recv, args}; for constructors, recv is the construction-bound
// object.
function resolveCallContexts (index, state, target, depth) {
  const key = `ctx:${target.cls}.${target.name}${target.desc}`
  if (state.aggCache.has(key)) return state.aggCache.get(key)
  state.aggCtxStack = state.aggCtxStack || new Set()
  if (depth > AGG_MAX_DEPTH || state.aggCtxStack.has(key)) return { contexts: [], partial: true }
  state.aggCtxStack.add(key)
  const contexts = []
  let partial = false
  try {
    const sites = findInvocationSites(index, state, target)
    if (sites.length === 0) partial = true
    for (const site of sites) {
      const info = index.get(site.cls)
      const m = info && info.codes.find((c) => c.method === site.method && c.desc === site.desc)
      if (!m) continue
      const makeHooks = (sink) => ({
        onCall: (ref, kind, recv, argVals) => {
          if (ref.name === target.name && ref.desc === target.desc) sink.push({ recv, args: argVals.slice() })
        },
        onIndy: (impl, captured) => {
          if (impl.name === target.name && impl.desc === target.desc) sink.push({ recv: null, args: captured.slice(), viaIndy: true })
        }
      })
      const collect = (bindingLocals) => {
        const matches = []
        const locals = bindingLocals || seedProvenanceLocals(m.desc, (m.flags & 0x0008) !== 0, site.cls)
        evaluateMethod(index, info, m, state, { locals, recordPutstatic: false }, makeHooks(matches))
        return matches
      }
      let matches = collect(null)
      const isUnresolvedCtx = (mt) => mt.args.some((a) => a && (a.k === 'param' || a.k === 'provfield' || a.k === 'this'))
      const unresolvedMatch = matches.some(isUnresolvedCtx)
      if (unresolvedMatch && depth < AGG_MAX_DEPTH) {
        // the call site itself depends on its own inputs — bind them from
        // ITS callers and re-collect
        const parent = resolveCallContexts(index, state, { cls: site.cls, name: site.method, desc: site.desc }, depth + 1)
        partial = partial || parent.partial
        const rebound = []
        for (const pctx of parent.contexts.slice(0, AGG_MAX_CONTEXTS)) {
          const isStatic = (m.flags & 0x0008) !== 0
          const locals = isStatic
            ? seedArgLocals(site.desc, pctx.args)
            : seedArgLocals(site.desc, pctx.args, pctx.recv ?? UNKNOWN)
          rebound.push(...collect(locals))
        }
        if (rebound.some((mt) => !isUnresolvedCtx(mt))) {
          matches = rebound
        } else {
          // TRANSITIVE ROOT CLIMB: some chains only become concrete at the
          // method where the aggregator is BORN (catnip: the registry is
          // constructed in a mod's AllPackets.register, mutated through a
          // register-once guard, and only then handed down the service
          // chain). Walk the caller graph upward and run each frontier
          // method for real with our hooks propagated through every inline
          // dispatch — the match then fires from inside the true chain, in
          // its natural single-execution order.
          const prevInlineAll = state.aggInlineAll
          state.aggInlineAll = true
          try {
            let frontier = [{ cls: site.cls, method: site.method, desc: site.desc }]
            const visited = new Set()
            for (let level = 0; level < AGG_MAX_DEPTH && !matches.some((mt) => !isUnresolvedCtx(mt)); level++) {
              const nextFrontier = []
              for (const f of frontier) {
                for (const up of findInvocationSites(index, state, { cls: f.cls, name: f.method, desc: f.desc })) {
                  const upKey = `${up.cls}.${up.method}${up.desc}`
                  if (visited.has(upKey)) continue
                  visited.add(upKey)
                  nextFrontier.push(up)
                  if (nextFrontier.length > 32) break
                }
              }
              if (nextFrontier.length === 0) { partial = true; break }
              for (const up of nextFrontier) {
                const upInfo = index.get(up.cls)
                const upM = upInfo && upInfo.codes.find((c) => c.method === up.method && c.desc === up.desc)
                if (!upM) continue
                const locals = seedProvenanceLocals(upM.desc, (upM.flags & 0x0008) !== 0, up.cls)
                evaluateMethod(index, upInfo, upM, state, { locals, recordPutstatic: true }, makeHooks(matches))
              }
              frontier = nextFrontier
            }
          } finally {
            state.aggInlineAll = prevInlineAll
          }
        }
      }
      matches = matches.filter((mt) => !isUnresolvedCtx(mt))
      for (const mt of matches) {
        if (contexts.length >= AGG_MAX_CONTEXTS) { partial = true; break }
        if (target.name === '<init>') {
          // materialize the constructed object with bound fields
          const obj = { k: 'obj', cls: target.cls, ctorArgs: mt.args, ctorDesc: target.desc, fields: {} }
          bindCtorFields(index, state, obj)
          contexts.push({ recv: obj, args: mt.args })
        } else {
          contexts.push({ recv: mt.recv, args: mt.args })
        }
      }
    }
  } finally {
    state.aggCtxStack.delete(key)
  }
  const result = { contexts, partial }
  if (process.env.MINEPAL_AGG_DEBUG) {
    debug(`agg contexts ${target.cls}.${target.name} depth=${depth}: ${contexts.length} contexts, partial=${partial} args=${JSON.stringify(contexts.map((c) => (c.args || []).map((a) => a && a.k)))}`)
  }
  state.aggCache.set(key, result)
  return result
}

// The FOCUS PASS: build every real instance of an aggregator class the jars
// themselves build. All classes referencing the aggregator (or an ancestor
// it is invoked through) get their initializers and methods evaluated with
// static factory chains in scope inlined, service-file dispatch live, and
// constructor field binding on — so `VeilPacketManager.create("sable","1")`
// materializes an object whose fields carry the true per-instance version
// and whose population calls (`registerClientbound(...)`) land elements on
// that same object's own collections (object identity IS the instance
// separation). Returns the constructed aggregator objects.
function collectFocusInstances (index, state, focusCls) {
  const key = `focus:${focusCls}`
  if (state.aggCache.has(key)) return state.aggCache.get(key)
  const constructed = []
  state.aggCache.set(key, constructed)
  // scope: the aggregator + its in-index ancestors (interfaces included) —
  // the classes whose static factories are worth evaluating for real
  const scope = new Set([focusCls])
  const addAncestors = (cls, depth) => {
    if (!cls || depth > 8) return
    const info = index.get(cls)
    if (!info) return
    for (const s of [info.superName, ...(info.interfaces || [])]) {
      if (s && index.get(s) && !scope.has(s)) {
        scope.add(s)
        addAncestors(s, depth + 1)
      }
    }
  }
  addAncestors(focusCls, 0)
  scope.delete('java/lang/Object')
  const scopeSimple = [...scope].map((s) => s.split('/').pop())
  const prevScope = state.aggStaticScope
  const prevFocus = state.aggFocus
  const prevConstructed = state.aggConstructed
  state.aggStaticScope = scope
  state.aggFocus = focusCls
  state.aggConstructed = constructed
  try {
    const referencing = []
    for (const cls of state.allClassNames) {
      if (scope.has(cls)) continue
      const bytes = index.rawBytes(cls)
      if (!bytes) continue
      if (scopeSimple.some((s) => bytes.includes(s))) referencing.push(cls)
      if (referencing.length > 512) { constructed.truncated = true; break }
    }
    // initializers first (they publish the instances into static fields),
    // then the remaining methods (they populate them)
    const roots = []
    for (const cls of referencing) {
      const info = index.get(cls)
      if (!info) continue
      for (const m of info.codes) roots.push({ info, m, isClinit: m.method === '<clinit>' })
    }
    roots.sort((a, b) => (b.isClinit ? 1 : 0) - (a.isClinit ? 1 : 0))
    for (const { info, m } of roots) {
      if (state.aggBudgetBlown) break
      const locals = seedProvenanceLocals(m.desc, (m.flags & 0x0008) !== 0, info.className)
      evaluateMethod(index, info, m, state, { locals, recordPutstatic: true }, {})
      if (process.env.MINEPAL_AGG_DEBUG) {
        debug(`focus ${focusCls}: after ${info.className}.${m.method} — ${constructed.length} instances`)
      }
    }
  } finally {
    state.aggStaticScope = prevScope
    state.aggFocus = prevFocus
    state.aggConstructed = prevConstructed
  }
  return constructed
}

// The aggregation resolver: for every pending (id-unresolved) registration,
// bind concrete calling contexts to its site method and re-evaluate. Emits
// fully-resolved rows; conflicting resolutions for the same channel drop the
// channel loudly.
function resolveAggregatedRegistrations (index, state, pending) {
  const rows = []
  const resolvedSites = new Set()
  const partialSites = new Set()
  state.aggCache = state.aggCache || new Map()
  const siteKey = (reg) => reg.methodCtx ? `${reg.methodCtx.cls}.${reg.methodCtx.name}${reg.methodCtx.desc}` : reg.site
  const doneSiteMethods = new Set()
  for (const reg of pending) {
    if (!reg.methodCtx) continue
    const sk = siteKey(reg)
    if (doneSiteMethods.has(sk)) continue
    doneSiteMethods.add(sk)
    const info = index.get(reg.methodCtx.cls)
    const m = info && info.codes.find((c) => c.method === reg.methodCtx.name && c.desc === reg.methodCtx.desc)
    if (!m) continue
    // Constructor-context or call-context binding for the site method itself
    const isStatic = (m.flags & 0x0008) !== 0
    let bindings = []
    let partial = false
    if (!isStatic && reg.methodCtx.name !== '<init>') {
      // instance site: candidates are the aggregator instances the jars
      // themselves construct AND populate (the focus pass — per-instance
      // versions and per-instance collection contents by object identity)
      const instances = collectFocusInstances(index, state, reg.methodCtx.cls)
      for (const inst of instances.slice(0, AGG_MAX_CONTEXTS)) bindings.push({ recv: inst, args: null })
      if (instances.length === 0 || instances.truncated || instances.length > AGG_MAX_CONTEXTS) partial = true
    }
    const callCtx = resolveCallContexts(index, state, { cls: reg.methodCtx.cls, name: reg.methodCtx.name, desc: reg.methodCtx.desc }, 0)
    partial = partial || callCtx.partial
    for (const c of callCtx.contexts) bindings.push({ recv: c.recv, args: c.args })
    if (bindings.length === 0) {
      if (partial) partialSites.add(sk)
      continue
    }
    let produced = 0
    let unresolvedInSite = 0
    for (const b of bindings.slice(0, AGG_MAX_CONTEXTS)) {
      const locals = []
      if (!isStatic) locals.push(b.recv ?? { k: 'this', cls: reg.methodCtx.cls })
      const types = argSlots(reg.methodCtx.desc)
      for (let i = 0; i < types.length; i++) {
        locals.push((b.args && b.args[i] !== undefined) ? b.args[i] : { k: 'param', i })
        if (types[i] === 'J' || types[i] === 'D') locals.push(UNKNOWN)
      }
      evaluateMethod(index, info, m, state, {
        locals,
        recordPutstatic: false,
        onRegistration: (r) => {
          if (process.env.MINEPAL_AGG_DEBUG) debug(`agg re-eval ${sk}: ${r.method} id=${r.id} version=${r.registrar && r.registrar.version}`)
          if (!r.id) { unresolvedInSite++; return }
          const spec = REGISTRATION_METHODS[r.method]
          if (!spec) return
          produced++
          rows.push({
            id: r.id,
            version: r.registrar ? r.registrar.version : null,
            versionSource: 'aggregated',
            versionFromParam: r.registrar ? !!r.registrar.versionFromParam : false,
            optional: r.registrar ? r.registrar.optional : false,
            flow: spec.flow,
            protocols: spec.protocols,
            method: r.method,
            source: `aggregated ${reg.methodCtx.cls}`,
            jar: r.jar,
            siteKey: sk
          })
        }
      }, {})
    }
    if (produced > 0) resolvedSites.add(sk)
    if (partial || unresolvedInSite > 0) partialSites.add(sk)
  }
  // conflict guard: one channel, one truth — conflicting flow/version/
  // optionality across candidates drops the channel LOUDLY (a wrong tuple
  // claim fails the negotiation with a worse diagnostic than an honest miss)
  const byChannel = new Map()
  for (const row of rows) {
    for (const proto of row.protocols) {
      const key = `${proto}:${row.id}`
      const prev = byChannel.get(key)
      if (!prev) byChannel.set(key, row)
      else if (prev.flow !== row.flow || prev.version !== row.version || prev.optional !== row.optional) {
        prev.conflicted = true
        row.conflicted = true
      }
    }
  }
  const conflicted = new Set()
  for (const row of rows) {
    if (row.conflicted) conflicted.add(row.id)
  }
  const clean = rows.filter((r) => !conflicted.has(r.id))
  for (const id of conflicted) {
    state.diagnostics.abstains.push(`${id}: aggregated candidates disagree on flow/version — unclaimed (a wrong tuple would fail the negotiation)`)
  }
  // versionless mandatory rows fall back to their jar's mods.toml version
  // downstream via the same rule as pass 1 (handled by the caller)
  return { rows: clean, resolvedSites, partialSites }
}

// ---------- HF11: blocking-task ACK contracts ----------
//
// tacz 1.1.8's configuration task (`NetworkHandler$Task.run`) sends
// `tacz:server_synced_entity_data_mapping` and does NOT finish itself: the
// server parks the configuration phase until the client answers
// `tacz:acknowledge` — whose handler calls IPayloadContext.finishCurrentTask
// and whose codec is StreamCodec.unit(INSTANCE) (an EMPTY wire payload).
// Claiming the mapping channel without speaking the ack wedges the join
// forever (keepalives keep the socket alive, no progress ever comes).
//
// The contract is derivable, generically, from three proofs read out of the
// same jar: (1) a payload class whose (IPayloadContext)V handler calls
// finishCurrentTask against a task TYPE owner; (2) that payload's codec is
// unit (empty encode is protocol-true); (3) the task class whose run()
// constructs the triggering payload. All three must hold or no contract is
// emitted — a guessed ack is worse than a wedge (it desyncs the phase).
const IPAYLOAD_CONTEXT = 'net/neoforged/neoforge/network/handling/IPayloadContext'
const CONFIG_TASK_TYPE = 'net/minecraft/server/network/ConfigurationTask$Type'
const STREAM_CODEC_TYPE = 'net/minecraft/network/codec/StreamCodec'

function classTypeId (index, state, cls) {
  // the class's own registered channel id: any Type-valued static resolved
  // out of its <clinit> (resolveClassTypeFields caches into fieldValues)
  resolveClassTypeFields(index, cls, state)
  for (const [key, val] of Object.entries(state.fieldValues)) {
    if (key.startsWith(`${cls}.`) && val && val.k === 'type') return val.v
  }
  return null
}

function deriveAckContracts (index, state) {
  const contracts = []
  for (const cls of state.allClassNames) {
    const bytes = index.rawBytes(cls)
    if (!bytes || !bytes.includes('finishCurrentTask')) continue
    const info = index.get(cls)
    if (!info) continue
    const handler = info.codes.find((c) => c.desc === `(L${IPAYLOAD_CONTEXT};)V`)
    if (!handler) continue
    // proof 1: the handler finishes a configuration task
    let taskOwner = null
    let lastTypeField = null
    walkLinear(handler.code, info.cp, (op, pc, cp, code) => {
      if (op === 0xb2) {
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        if (ref && ref.desc === `L${CONFIG_TASK_TYPE};`) lastTypeField = ref
      } else if (op === 0xb9 || op === 0xb6) {
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        if (ref && ref.name === 'finishCurrentTask' && lastTypeField) taskOwner = lastTypeField.owner
      }
    })
    if (!taskOwner) continue
    // proof 2: the ack payload's codec is unit (empty wire body)
    const clinit = info.codes.find((c) => c.method === '<clinit>')
    let unitCodec = false
    if (clinit) {
      walkLinear(clinit.code, info.cp, (op, pc, cp, code) => {
        if (op === 0xb8 || op === 0xb9) {
          const ref = cpRef(cp, code.readUInt16BE(pc + 1))
          if (ref && ref.owner === STREAM_CODEC_TYPE && ref.name === 'unit') unitCodec = true
        }
      })
    }
    if (!unitCodec) continue
    const ackId = classTypeId(index, state, cls)
    if (!ackId) continue
    // proof 3: the task's run() constructs the triggering payload
    const taskInfo = index.get(taskOwner)
    if (!taskInfo) continue
    const run = taskInfo.codes.find((c) => c.method === 'run' && c.desc === '(Ljava/util/function/Consumer;)V')
    if (!run) continue
    const constructed = []
    walkLinear(run.code, taskInfo.cp, (op, pc, cp, code) => {
      if (op === 0xbb) {
        const c = cpClassName(cp, code.readUInt16BE(pc + 1))
        if (c && c !== cls && index.get(c)) constructed.push(c)
      }
    })
    for (const triggerCls of constructed) {
      const triggerId = classTypeId(index, state, triggerCls)
      if (triggerId && triggerId !== ackId) {
        contracts.push({ trigger: triggerId, ack: ackId, task: taskOwner, source: cls })
      }
    }
  }
  return contracts
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
    // HF11: locals seeded with PROVENANCE tags instead of bare unknowns (the
    // receiver as {k:'this'}, each argument as {k:'param', i}) — same null
    // results everywhere a value stays unresolved, but an abstained
    // registration now records WHERE its id would have come from, which is
    // what the aggregation pass binds candidates to. The event/registrar
    // values are still produced by the interpreter when registrar() is
    // invoked on the event argument.
    const locals = seedProvenanceLocals(method.desc, (method.flags & 0x0008) !== 0, info.className)
    simulate(index, info, method, state, { onRegistration: record, recordPutstatic: false, locals })
  }

  const markers = discoverFlowMarkers(index, entryMethods)
  const enumComponents = deriveEnumRegistries(index, state, markers)

  // assemble, applying the version rules
  const byProtocol = { configuration: new Map(), play: new Map() }
  // HF16 ASSEMBLE CONFLICT GUARD: version sources that are BYTECODE-PROVEN
  // (a compile-time constant read at/through the registration site) outrank
  // the mods.toml fallback heuristic. A constant-proven tuple REPLACES a
  // fallback-sourced one for the same channel; two DISAGREEING constant
  // proofs drop the channel loudly (mirror of the aggregator conflict law —
  // a wrong tuple claim fails the negotiation with a worse diagnostic than
  // an honest miss).
  const CONSTANT_VERSION_SOURCES = new Set(['constant', 'enum-registry', 'annotation-registry'])
  const droppedConflicts = new Set()
  const add = (id, version, flow, optional, protocols, source, versionSource) => {
    for (const proto of protocols) {
      if (!byProtocol[proto]) continue
      if (droppedConflicts.has(`${proto}:${id}`)) continue
      const prev = byProtocol[proto].get(id)
      if (!prev) {
        byProtocol[proto].set(id, { id, version, flow, optional, source, versionSource })
        continue
      }
      const prevConst = CONSTANT_VERSION_SOURCES.has(prev.versionSource)
      const newConst = CONSTANT_VERSION_SOURCES.has(versionSource)
      if (newConst && !prevConst) {
        byProtocol[proto].set(id, { id, version, flow, optional, source, versionSource })
        continue
      }
      if (newConst && prevConst && (prev.version !== version || prev.flow !== flow || prev.optional !== optional)) {
        byProtocol[proto].delete(id)
        droppedConflicts.add(`${proto}:${id}`)
        diagnostics.abstains.push(`${id}: constant-proven registrations disagree on version/flow/optionality — unclaimed (a wrong tuple would fail the negotiation)`)
      }
      // otherwise the standing claim holds (identical or equally-provenanced)
    }
  }
  const pendingAgg = []
  // HF15 tier (a): a registration whose ID resolved but whose VERSION did
  // not is a LISTEN-ONLY fact — the id is jar truth, and the version-free
  // ad-hoc declaration tier (minecraft:register) is exactly the lawful home
  // for it. Today these abstain and vanish; now they abstain AND ride the
  // listen-only surface (never a claim — no version is ever invented).
  const listenOnlyNamed = []
  for (const reg of registrations) {
    diagnostics.registrations++
    let version = reg.registrar ? reg.registrar.version : null
    let versionSource = reg.registrar ? reg.registrar.versionSource : 'unresolved'
    const optional = reg.registrar ? reg.registrar.optional : false
    if (!reg.id) {
      // HF11: don't abstain yet — the AGGREGATOR pass may resolve this site
      // from its jar-wide population contexts. Unresolved leftovers abstain
      // below with the registrar's own optionality in the copy.
      pendingAgg.push(reg)
      continue
    }
    if (version === null) {
      const metaVersion = reg.jar && reg.jar.modVersion
      if (optional) {
        diagnostics.abstains.push(`${reg.id}: optional channel with unresolved version — safely unclaimed`)
        listenOnlyNamed.push(reg.id)
        continue
      }
      // HF16 PARAM-PROVENANCE VERSION LAW: the version rode an unbound
      // method parameter — the truth provably lives at the method's call
      // sites (the event-helper dispatch claims it there when a constant is
      // bound). The mods.toml fallback is FORBIDDEN for such rows: it is a
      // heuristic for the registrar(modVersion) runtime idiom only, and
      // substituting the mod version here claims a wrong tuple.
      if (reg.registrar && reg.registrar.versionFromParam) {
        diagnostics.abstains.push(`${reg.id}: version rides a caller parameter — claimed only where a call site binds a constant; mods.toml fallback forbidden (riding listen-only)`)
        listenOnlyNamed.push(reg.id)
        continue
      }
      if (metaVersion) {
        version = metaVersion
        versionSource = 'mods.toml'
      } else {
        diagnostics.abstains.push(`${reg.id}: required channel with no derivable version — join will be refused by the server`)
        listenOnlyNamed.push(reg.id)
        continue
      }
    }
    add(reg.id, version, reg.flow, optional, reg.protocols, reg.site, versionSource)
  }
  for (const c of enumComponents) {
    add(c.id, c.version, c.flow, c.optional, c.protocols, c.source, 'enum-registry')
  }

  // HF11 AGGREGATOR pass: resolve id-less registrations from their jar-wide
  // population contexts (see the shape header above); leftovers abstain with
  // honest optionality wording so P5 surfaces only real negotiation risk.
  const agg = resolveAggregatedRegistrations(index, state, pendingAgg)
  for (const row of agg.rows) {
    let version = row.version
    let versionSource = row.versionSource
    if (version === null) {
      const metaVersion = row.jar && row.jar.modVersion
      if (row.optional) {
        diagnostics.abstains.push(`${row.id}: aggregated optional channel with unresolved version — safely unclaimed`)
        listenOnlyNamed.push(row.id)
        continue
      }
      // HF16 PARAM-PROVENANCE VERSION LAW (same rule as the direct rows).
      if (row.versionFromParam) {
        diagnostics.abstains.push(`${row.id}: aggregated version rides a caller parameter — claimed only where a call site binds a constant; mods.toml fallback forbidden (riding listen-only)`)
        listenOnlyNamed.push(row.id)
        continue
      }
      if (metaVersion) {
        version = metaVersion
        versionSource = 'mods.toml'
      } else {
        diagnostics.abstains.push(`${row.id}: aggregated required channel with no derivable version — join will be refused by the server`)
        listenOnlyNamed.push(row.id)
        continue
      }
    }
    add(row.id, version, row.flow, row.optional, row.protocols, row.source, versionSource)
  }
  const abstainedSiteKeys = new Set()
  for (const reg of pendingAgg) {
    const sk = reg.methodCtx ? `${reg.methodCtx.cls}.${reg.methodCtx.name}${reg.methodCtx.desc}` : reg.site
    if (agg.resolvedSites.has(sk) && !agg.partialSites.has(sk)) continue
    if (abstainedSiteKeys.has(`${sk}#${reg.method}`)) continue
    abstainedSiteKeys.add(`${sk}#${reg.method}`)
    const opt = reg.registrar && reg.registrar.optional
    const partially = agg.resolvedSites.has(sk) ? ' (partially aggregated — remainder unresolved)' : ''
    diagnostics.abstains.push(opt
      ? `${reg.site}: ${reg.method} optional registration with unresolved payload type id — safely unclaimed${partially}`
      : `${reg.site}: ${reg.method} with unresolved payload type id${partially}`)
  }
  if (state.aggBudgetBlown) {
    diagnostics.abstains.push('aggregation budget exhausted — remaining aggregated registrations abstained')
  }

  // HF11: blocking-task ack contracts (see deriveAckContracts header) — the
  // responder answers each proven trigger with its proven empty ack so a
  // claimed mod config channel cannot park the phase forever.
  let ackContracts = []
  try {
    ackContracts = deriveAckContracts(index, state)
  } catch (err) {
    diagnostics.errors.push(`ack-contract derivation failed (${err.message}) — no contracts emitted`)
  }

  // HF9 — ANNOTATION-REGISTRY shape (annotationRegistryDerivation.js):
  // reflective class-name-codec registries (Pixelmon class). Contributes both
  // channel components (negotiation claims) and config-phase sync-ack
  // CONTRACTS (the mod's own task-finish protocol, jar-proven), which the
  // config responder answers so the mod's blocking configuration tasks can
  // complete. Fail-open: jars without the idiom contribute nothing here.
  const annotationRun = deriveAnnotationRegistries(index, state, entryMethods)
  for (const c of annotationRun.components) {
    add(c.id, c.version, c.flow, c.optional, c.protocols, c.source, 'annotation-registry')
  }

  const components = {
    configuration: [...byProtocol.configuration.values()],
    play: [...byProtocol.play.values()]
  }

  // HF15 — the LISTEN-ONLY surface (see listenOnlyDerivation.js header):
  // named-abstain ids (tier a, collected above) + wrapper-registrar factory
  // enumerations (tier b, the CreativeCore shape) + connector-served fabric
  // clientbound ids (tier c). Version-free by construction; declared over
  // minecraft:register into the server's ad-hoc send-permission tier, never
  // claimed. Fail-open: a scan failure lands in diagnostics.errors and the
  // derivation's components are untouched.
  let listenOnly = []
  try {
    const factoryIds = deriveWrapperFactoryListenChannels(index, diagnostics)
    const fabricIds = deriveFabricListenChannels(index, diagnostics)
    // HF15-R tier (d): the container-carried Type shape (a registrar site
    // reading payload Types off container records it iterates; the ids live
    // at the containers' construction sites, several parameter hops up the
    // caller graph). The walk rides THIS module's evaluator (injected — the
    // interpreter cannot be required from the listen-only module), with the
    // shared step budget as its ceiling.
    const containerIds = deriveContainerCarriedListenChannels(index, diagnostics, {
      evaluateMethod: (info, m, opts, hooks) => evaluateMethod(index, info, m, state, opts, hooks),
      seedProvenanceLocals,
      resolveTypeValue: (v) => resolveTypeValue(index, v, state),
      resolveReslocValue: (v) => resolveReslocValue(index, v, state),
      budgetBlown: () => !!state.aggBudgetBlown
    })
    const claimedIds = new Set(['configuration', 'play'].flatMap((p) => components[p].map((c) => c.id)))
    listenOnly = assembleListenOnly({ named: listenOnlyNamed, factory: factoryIds, fabric: fabricIds, container: containerIds, claimedIds, diagnostics })
  } catch (err) {
    diagnostics.errors.push(`listen-only derivation failed (${err.message}) — declaration rides the handler contract alone`)
  }

  debug(`neoforge derivation: ${components.configuration.length} configuration + ${components.play.length} play components + ${listenOnly.length} listen-only ids from ${diagnostics.jars.length} jars (${diagnostics.abstains.length} abstains, ${ackContracts.length} ack contracts, ${Date.now() - started}ms)`)
  return { components, diagnostics, ackContracts, syncContracts: annotationRun.syncContracts, listenOnly }
}

module.exports = { deriveNeoForgeComponents, deriveAckContracts, resolveAggregatedRegistrations }
