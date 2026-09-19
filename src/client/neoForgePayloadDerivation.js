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
const { nestedJarEntriesOf } = require('./nestedJars') // HF53 rider: the one nested-jar rule
const { deriveAnnotationRegistries } = require('./annotationRegistryDerivation')
const { deriveWrapperFactoryListenChannels, deriveFabricListenChannels, deriveContainerCarriedListenChannels, assembleListenOnly } = require('./listenOnlyDerivation')

const EVENT_TYPE = 'net/neoforged/neoforge/network/event/RegisterPayloadHandlersEvent'
const REGISTRAR_TYPE = 'net/neoforged/neoforge/network/registration/PayloadRegistrar'
const REGISTRAR_SIMPLE = REGISTRAR_TYPE.split('/').pop()
// HF43: the id class is a SET, not one name — Minecraft 26.1 renamed
// net.minecraft.resources.ResourceLocation to net.minecraft.resources.Identifier
// (same static factories: fromNamespaceAndPath / parse / tryParse / tryBuild /
// withDefaultNamespace). Every owner/descriptor comparison below goes through
// these helpers so a 26.1 jar's Identifier.fromNamespaceAndPath resolves
// exactly like a 1.21 jar's ResourceLocation.fromNamespaceAndPath. Rig-proven:
// NeoForge 26.1.2.109 with 13 mods derived 0+0 components with 23 abstains
// ("unresolved payload type id" across five unrelated mods) purely because
// the id type name changed under the same registration shapes.
const RESLOC_TYPES = new Set(['net/minecraft/resources/ResourceLocation', 'net/minecraft/resources/Identifier'])
const isReslocOwner = (owner) => RESLOC_TYPES.has(owner)
const isReslocDesc = (desc) => typeof desc === 'string' && desc.startsWith('L') && desc.endsWith(';') && RESLOC_TYPES.has(desc.slice(1, -1))
const returnsResloc = (desc) => { const m = typeof desc === 'string' && desc.match(/\)L([^;]+);$/); return !!m && RESLOC_TYPES.has(m[1]) }
const isStrToReslocDesc = (desc) => typeof desc === 'string' && desc.startsWith('(Ljava/lang/String;)') && returnsResloc(desc)
const isStrStrToReslocDesc = (desc) => typeof desc === 'string' && desc.startsWith('(Ljava/lang/String;Ljava/lang/String;)') && returnsResloc(desc)
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
  collectBufferClasses(buf, out, diagnostics, jarLabel, 0)
}

// HF53 rider: nested jars through the one shared rule; the nesting bound
// (NESTED_JAR_DEPTH_BOUND) is this deriver's — a jar nested that deep is
// still read, one deeper is not (the walk used to have no floor).
const NESTED_JAR_DEPTH_BOUND = 3

function collectBufferClasses (buf, out, diagnostics, jarLabel, depth) {
  let entries
  try {
    entries = zipCentralEntries(buf)
  } catch (err) {
    diagnostics.errors.push(`${jarLabel}: bad zip (${err.message})`)
    return
  }
  let modVersion = null
  const modIds = [] // HF37: the jar's declared mod ids (a version lookup key — ModList.getModContainerById("id") / event.registrar("id"))
  const nested = new Map(nestedJarEntriesOf(buf, entries).map((n) => [n.entry.name, n]))
  for (const e of entries) {
    if (e.name === 'META-INF/neoforge.mods.toml' || e.name === 'META-INF/mods.toml') {
      try {
        const toml = zipEntryData(buf, e).toString('utf8')
        // only the [[mods]] tables declare this jar's ids — a
        // [[dependencies.x]] table's modId names ANOTHER mod
        let table = null
        for (const line of toml.split(/\r?\n/)) {
          const th = line.match(/^\s*\[\[?\s*([A-Za-z0-9_.-]+)\s*\]?\]/)
          if (th) { table = th[1]; continue }
          const mm = table === 'mods' && line.match(/^\s*modId\s*=\s*"([^"]+)"/)
          if (mm) modIds.push(mm[1])
        }
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
  const jarInfo = { label: jarLabel, modVersion, modIds }
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
    } else if (nested.has(e.name)) {
      if (depth >= NESTED_JAR_DEPTH_BOUND) continue
      try {
        collectBufferClasses(zipEntryData(buf, e), out, diagnostics, `${jarLabel}!${nested.get(e.name).relPath}`, depth + 1)
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
          if (ref && isReslocOwner(ref.owner) && (ref.name === 'fromNamespaceAndPath' || ref.name === 'tryBuild' || ref.name === 'm_339182_')) sawFrom = true
          if (ref && isReslocOwner(ref.owner) && (ref.name === 'parse' || ref.name === 'tryParse')) sawConcatParse = true
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

// HF16-R — JVMS §5.4.3.2 field resolution. The constant-pool owner of a
// getstatic is the class named at the USE site, not necessarily the class
// that DECLARES the field: `SPSetRemotePlayerSkill.CLIENT_BOUND_SET_REMOTE_PLAYER_SKILL`
// (Epic Fight 21.17.3.1) names a static Type declared on the superinterface
// ManagedCustomPacketPayload, whose <clinit> is the only initializer that ever
// putstatics it. Keying the lookup by the use-site owner simulated the
// record's own <clinit> (STREAM_CODEC only), found nothing, and abstained the
// registration — a REQUIRED server channel then went unclaimed and NeoForge's
// negotiator kicked the join (missing.server.client, field receipt 2026-09-05).
// The JVM resolves such a reference class-first, then superinterfaces
// (recursively), then the superclass chain — do exactly that here so every
// static-field resolver (Type / String / ResourceLocation) keys by the true
// declarer and simulates the true initializer. Unknown classes fall back to
// the use-site owner (never a wider claim than before).
function resolveFieldDeclarer (index, owner, name, desc, seen = new Set()) {
  if (!owner || seen.has(owner)) return null
  seen.add(owner)
  const info = index.get(owner)
  if (!info) return null
  if ((info.fields || []).some((f) => f.name === name && f.desc === desc)) return owner
  for (const itf of info.interfaces || []) {
    const hit = resolveFieldDeclarer(index, itf, name, desc, seen)
    if (hit) return hit
  }
  return resolveFieldDeclarer(index, info.superName, name, desc, seen)
}

// HF16-R rider — the ONE key both sides of a static use: javac qualifies an
// inherited static written from a subclass body by the SUBCLASS (JLS 13.1),
// so a putstatic keyed by its constant-pool owner never met a getstatic that
// resolved to the declarer. Unknown classes fall back to the use-site owner.
function staticFieldDeclarer (index, ref) {
  return resolveFieldDeclarer(index, ref.owner, ref.name, ref.desc) || ref.owner
}
function staticFieldKey (index, ref) {
  return `${staticFieldDeclarer(index, ref)}.${ref.name}`
}

function lookupStaticField (index, val, state) {
  const declarer = staticFieldDeclarer(index, val)
  const key = `${declarer}.${val.name}`
  if (!(key in state.fieldValues)) resolveClassTypeFields(index, declarer, state)
  return state.fieldValues[key]
}

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
    const resolved = lookupStaticField(index, val, state)
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
    const resolved = lookupStaticField(index, val, state)
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
  if (val.k === 'field' && isReslocDesc(val.desc)) {
    const resolved = lookupStaticField(index, val, state)
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

  // HF51-rider: the undecided flag is PER METHOD — a callee inherits its
  // caller's (a helper reached past a conditional is under it) but its own
  // conditionals never leak back into the caller's later `.optional()` calls
  // (a walk that throws leaves the flag raised — the safe direction: an
  // `.optional()` is then unproven, never a false optional)
  opts.walk = opts.walk || {}
  const undecidedOnEntry = !!opts.walk.undecided
  walkLinear(code, cp, (op, pc) => {
    // HF51: the linear walk decides no branch — an `.optional()` met past a
    // conditional is not a proven optional (see the registrar model)
    if ((op >= 0x99 && op <= 0xa6) || op === 0xc6 || op === 0xc7) opts.walk.undecided = true
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
      case 0xb3: { // putstatic — keyed by the DECLARER, symmetric with getstatic (HF16-R rider)
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        const val = stack.pop()
        // HF16-R2 rider — the STATIC-REGISTRAR shape: an entry that stores the
        // registrar in a static field for population sites run later
        // (`registrar = event.registrar("x").optional(); Networking.init()`)
        // is a fact about the entry itself, recorded under every walk.
        if (ref && val && (opts.recordPutstatic || val.k === 'registrar')) {
          state.fieldValues[staticFieldKey(index, ref)] = val
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
      case 0xbd: { pop(1); push({ k: 'varr', items: [] }); break } // anewarray — HF51: a real array (reflection argument lists)
      case 0x53: { const v = stack.pop(); const i = stack.pop(); const a = stack.pop(); if (a && a.k === 'varr' && i && i.k === 'int') a.items[i.v] = v; break } // aastore
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
        const n = argSlots(desc).length
        const captured = stack.splice(Math.max(0, stack.length - n), n)
        // HF43: fold StringConcatFactory recipes when every operand is
        // concrete (the deep evaluator already did; the linear walk pushed
        // UNKNOWN, so a "ns:" + path helper never yielded an id here).
        const samName = nat ? cpUtf8(cp, nat.nameIndex) : null
        const impl = (c && classInfo.bootstrapMethods) ? resolveLambdaImpl(classInfo, c.bsmIndex) : null
        if (samName === 'makeConcatWithConstants' && c && classInfo.bootstrapMethods) push(concatWithConstants(classInfo, c.bsmIndex, captured))
        else if (impl && impl.refKind >= 5 && impl.refKind <= 9 && !returnsVoid(desc)) push({ k: 'lambda', impl, captured, sam: samName })
        else if (!returnsVoid(desc)) push(UNKNOWN)
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
  opts.walk.undecided = undecidedOnEntry
}

// HF51 — JDK / loader-value semantics shared by BOTH evaluators (the linear
// walk and the branch-following one), so a registration shape reads the same
// wherever it is met:
//   keyed stores   Map.get/put/putIfAbsent/computeIfAbsent/containsKey,
//                  Set.contains, guava Table.get/put/row, entrySet/keySet/
//                  Map$Entry — by OBJECT IDENTITY on a universe-constructed
//                  object (a registration object keyed by mod id is the
//                  same object at the listener that iterates it); a key this
//                  universe cannot decide makes the store opaque (never a
//                  false "known null")
//   reflection     Class.getConstructor(..).newInstance(..) / Class.newInstance
//                  on a class constant constructs the object for real (the
//                  registration-object factory and the reflective packet
//                  instance both live here)
//   payload type   CustomPacketPayload$Type.id() on a resolved Type, the
//                  Identifier accessors on a resolved id
//   equals         two constants of one kind decide
//   active mod     ModLoadingContext.get().getActiveNamespace()/
//                  getActiveContainer() = the mod root being walked
let objSeq = 0
function keyIdOf (v) {
  if (!v) return null
  if (v.k === 'str' || v.k === 'int' || v.k === 'cls' || v.k === 'resloc' || v.k === 'type') return `${v.k}:${v.v}`
  if (v.k === 'enumconst') return `enum:${v.cls}.${v.name}`
  if (v.k === 'obj') { if (!v.__id) v.__id = ++objSeq; return `obj:${v.__id}` }
  return null
}
const STORE_OWNER = (owner) => typeof owner === 'string' && (owner.startsWith('java/util/') || owner.startsWith('com/google/common/collect/'))
function storeUpsert (recv, keyId, key, value) {
  recv.entries = recv.entries || []
  if (keyId === null) { recv.opaqueKeys = true; recv.entries.push({ keyId: null, key: UNKNOWN, value }); return }
  const e = recv.entries.find((x) => x.keyId === keyId)
  if (e) e.value = value
  else recv.entries.push({ keyId, key, value })
}
// Absence is KNOWN only on a store whose WRITER lives in this universe: the
// class holding the field (heldBy, tagged at putfield / putstatic) mutates
// it somewhere in its own code (a getfield/getstatic of the field and a
// put/add on a collection type in one method). A store no local class ever
// writes is filled by the loader (a mod-bus map the platform populates) and
// reads UNKNOWN, so presence-gated paths (Optional.ifPresent) still run.
const STORE_MUTATORS = new Set(['put', 'putIfAbsent', 'computeIfAbsent', 'putAll', 'add', 'addAll', 'offer', 'offerFirst', 'offerLast', 'push', 'addFirst', 'addLast'])
function storeWriterKnown (index, state, recv) {
  const h = recv && recv.heldBy
  if (!h || !h.cls) return false
  state.storeWriters = state.storeWriters || new Map()
  const key = `${h.cls}.${h.field}`
  if (state.storeWriters.has(key)) return state.storeWriters.get(key)
  let writer = false
  const info = index.get(h.cls)
  for (const m of (info ? info.codes : [])) {
    let touches = false; let mutates = false
    try {
      walkLinear(m.code, info.cp, (op, pc, cp, code) => {
        if (op === 0xb2 || op === 0xb4) {
          const r = cpRef(cp, code.readUInt16BE(pc + 1))
          if (r && r.name === h.field && (r.owner === h.cls || isSubclassOf(index, h.cls, r.owner))) touches = true
        } else if ((op === 0xb6 || op === 0xb9) && touches) {
          const r = cpRef(cp, code.readUInt16BE(pc + 1))
          if (r && STORE_OWNER(r.owner) && STORE_MUTATORS.has(r.name)) mutates = true
        }
      })
    } catch { /* an unreadable method gives no verdict */ }
    if (touches && mutates) { writer = true; break }
  }
  state.storeWriters.set(key, writer)
  return writer
}
function storeLookup (index, state, recv, keyId) {
  if (keyId === null) return UNKNOWN
  const e = (recv.entries || []).find((x) => x.keyId === keyId)
  if (e) return e.value
  if (recv.opaqueKeys) return UNKNOWN
  const populatedHere = recv.entries && recv.entries.length > 0
  return populatedHere || storeWriterKnown(index, state, recv) ? { k: 'null' } : UNKNOWN
}
function storeInvoke (index, state, opts, ref, recv, argVals, push, hooks = {}) {
  if (!recv || !STORE_OWNER(ref.owner)) return false
  if (recv.k === 'entry') {
    if (ref.name === 'getKey' && argVals.length === 0) { push(recv.key ?? UNKNOWN); return true }
    if (ref.name === 'getValue' && argVals.length === 0) { push(recv.value ?? UNKNOWN); return true }
    return false
  }
  if (recv.k === 'collection') {
    if ((ref.name === 'values' || ref.name === 'stream') && argVals.length === 0) { push(recv); return true }
    if (ref.name === 'size' && argVals.length === 0) { push(recv.opaqueItems ? UNKNOWN : vInt(recv.items.length)); return true }
    if (ref.name === 'isEmpty' && argVals.length === 0) { push(recv.opaqueItems ? UNKNOWN : vInt(recv.items.length === 0 ? 1 : 0)); return true }
    return false
  }
  if (recv.k !== 'obj') return false
  const objArg = (n) => ref.desc === `(${'Ljava/lang/Object;'.repeat(n)})Ljava/lang/Object;`
  if (ref.name === 'get' && objArg(1)) { push(storeLookup(index, state, recv, keyIdOf(argVals[0]))); return true }
  if (ref.name === 'get' && objArg(2)) { const a = keyIdOf(argVals[0]); const b = keyIdOf(argVals[1]); push(storeLookup(index, state, recv, a === null || b === null ? null : `${a}|${b}`)); return true }
  if (ref.name === 'getOrDefault' && ref.desc === '(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;') { const v = storeLookup(index, state, recv, keyIdOf(argVals[0])); push(v && v.k === 'null' ? argVals[1] : v); return true }
  if (ref.name === 'put' && objArg(2)) { materializeElement(recv, argVals[1], false); storeUpsert(recv, keyIdOf(argVals[0]), argVals[0], argVals[1]); push(UNKNOWN); return true }
  if (ref.name === 'put' && objArg(3)) {
    const a = keyIdOf(argVals[0]); const b = keyIdOf(argVals[1])
    materializeElement(recv, argVals[2], false)
    storeUpsert(recv, a === null || b === null ? null : `${a}|${b}`, argVals[0], argVals[2])
    push(UNKNOWN); return true
  }
  if (ref.name === 'putIfAbsent' && objArg(2)) {
    const have = storeLookup(index, state, recv, keyIdOf(argVals[0]))
    if (have && have.k !== 'null') { push(have); return true }
    materializeElement(recv, argVals[1], false); storeUpsert(recv, keyIdOf(argVals[0]), argVals[0], argVals[1]); push({ k: 'null' }); return true
  }
  if (ref.name === 'computeIfAbsent' && ref.desc === '(Ljava/lang/Object;Ljava/util/function/Function;)Ljava/lang/Object;') {
    const have = storeLookup(index, state, recv, keyIdOf(argVals[0]))
    if (have && have.k !== 'null') { push(have); return true }
    let made = UNKNOWN
    if (argVals[1] && argVals[1].k === 'lambda') invokeLambda(index, state, opts, argVals[1], [argVals[0]], (v) => { made = v }, hooks)
    if (made) { materializeElement(recv, made, false); storeUpsert(recv, keyIdOf(argVals[0]), argVals[0], made) }
    push(made ?? UNKNOWN); return true
  }
  if ((ref.name === 'containsKey' || ref.name === 'contains') && ref.desc === '(Ljava/lang/Object;)Z') {
    const keyId = keyIdOf(argVals[0])
    if (keyId === null) { push(UNKNOWN); return true }
    const hit = (recv.entries || []).some((e) => e.keyId === keyId) || (recv.items || []).some((it) => keyIdOf(it) === keyId)
    const populatedHere = (recv.entries && recv.entries.length > 0) || (recv.items && recv.items.length > 0)
    push(hit ? vInt(1) : (recv.opaqueKeys || recv.opaqueItems || !(populatedHere || storeWriterKnown(index, state, recv)) ? UNKNOWN : vInt(0)))
    return true
  }
  if (ref.name === 'row' && ref.desc === '(Ljava/lang/Object;)Ljava/util/Map;') {
    const keyId = keyIdOf(argVals[0])
    if (keyId === null || recv.opaqueKeys) { push(UNKNOWN); return true }
    push({ k: 'collection', items: (recv.entries || []).filter((e) => typeof e.keyId === 'string' && e.keyId.startsWith(`${keyId}|`)).map((e) => e.value) })
    return true
  }
  if (ref.name === 'entrySet' && ref.desc === '()Ljava/util/Set;') { push({ k: 'collection', items: (recv.entries || []).map((e) => ({ k: 'entry', key: e.key, value: e.value })), opaqueItems: !!recv.opaqueKeys }); return true }
  if (ref.name === 'keySet' && ref.desc === '()Ljava/util/Set;') { push({ k: 'collection', items: (recv.entries || []).filter((e) => e.keyId !== null).map((e) => e.key), opaqueItems: !!recv.opaqueKeys }); return true }
  if (ref.name === 'size' && ref.desc === '()I') { const n = storeCountOf(recv); push(n === null ? UNKNOWN : vInt(n)); return true }
  if (ref.name === 'isEmpty' && ref.desc === '()Z') { const n = storeCountOf(recv); push(n === null ? UNKNOWN : vInt(n === 0 ? 1 : 0)); return true }
  return false
}
// HF51-rider: a KEYED store (filled by put) is its entries — an upsert under
// one key is one element, so size()/values() read the entries, never the
// per-put items; a collection is its items; an opaque store reads UNKNOWN
function storeValuesOf (recv) {
  return recv.entries && recv.entries.length > 0 ? recv.entries.map((e) => e.value) : (recv.items || [])
}
function storeCountOf (recv) {
  if (recv.opaqueItems || recv.opaqueKeys) return null
  return storeValuesOf(recv).length
}
// Reflective construction: the constructor is chosen by arity (and by the
// Class[] parameter types when the site spelled them); ambiguity abstains
// to UNKNOWN, never a guess.
function constructReflected (index, state, cls, args, argTypes) {
  const info = index.get(cls)
  if (!info) return UNKNOWN
  let ctors = info.codes.filter((c) => c.method === '<init>' && argSlots(c.desc).length === args.length)
  if (argTypes && argTypes.every((t) => t && t.k === 'cls')) {
    const want = `(${argTypes.map((t) => `L${t.v};`).join('')})V`
    const exact = ctors.filter((c) => c.desc === want)
    if (exact.length > 0) ctors = exact
  }
  if (ctors.length !== 1) return UNKNOWN
  const obj = { k: 'obj', cls, ctorArgs: args, ctorDesc: ctors[0].desc, fields: {} }
  bindCtorFields(index, state, obj)
  return obj
}
function jdkModelInvoke (index, state, opts, ref, recv, argVals, push, kind) {
  if (recv && recv.k === 'type' && ref.name === 'id' && ref.desc.startsWith('()L') && typeof recv.v === 'string') { push(vResloc(recv.v)); return true }
  if (recv && recv.k === 'resloc' && ref.desc === '()Ljava/lang/String;') {
    const [ns, ...rest] = String(recv.v).split(':')
    if (ref.name === 'getNamespace') { push(vStr(ns)); return true }
    if (ref.name === 'getPath') { push(vStr(rest.join(':'))); return true }
    if (ref.name === 'toString') { push(vStr(recv.v)); return true }
  }
  if (ref.name === 'equals' && ref.desc === '(Ljava/lang/Object;)Z' && recv && argVals[0]) {
    const a = recv; const b = argVals[0]
    if (a.k === 'enumconst' && b.k === 'enumconst') { push(vInt(a.cls === b.cls && a.name === b.name ? 1 : 0)); return true }
    if ((a.k === 'str' && b.k === 'str') || (a.k === 'resloc' && b.k === 'resloc') || (a.k === 'int' && b.k === 'int')) { push(vInt(a.v === b.v ? 1 : 0)); return true }
    if (a.k === 'obj' && b.k === 'obj') { push(vInt(a === b ? 1 : 0)); return true }
  }
  if (ref.owner === CLASS_TYPE && (ref.name === 'getConstructor' || ref.name === 'getDeclaredConstructor') && ref.desc === '([Ljava/lang/Class;)Ljava/lang/reflect/Constructor;' && recv && recv.k === 'cls') {
    push({ k: 'ctorref', cls: recv.v, argTypes: argVals[0] && argVals[0].k === 'varr' ? argVals[0].items : null })
    return true
  }
  if (ref.owner === 'java/lang/reflect/Constructor' && ref.name === 'newInstance' && ref.desc === '([Ljava/lang/Object;)Ljava/lang/Object;' && recv && recv.k === 'ctorref') {
    const args = argVals[0] && argVals[0].k === 'varr' ? argVals[0].items.slice() : null
    push(args ? constructReflected(index, state, recv.cls, args, recv.argTypes) : UNKNOWN)
    return true
  }
  if (ref.owner === CLASS_TYPE && ref.name === 'newInstance' && ref.desc === '()Ljava/lang/Object;' && recv && recv.k === 'cls') {
    push(constructReflected(index, state, recv.v, [], null))
    return true
  }
  if (kind === 'static' && ref.owner === 'net/neoforged/fml/ModLoadingContext' && ref.name === 'get' && ref.desc === '()Lnet/neoforged/fml/ModLoadingContext;') { push({ k: 'modctx' }); return true }
  if (recv && recv.k === 'modctx') {
    if (ref.name === 'getActiveNamespace' && state.activeModId) { push(vStr(state.activeModId)); return true }
    if (ref.name === 'getActiveContainer' && state.activeModId) { push({ k: 'modref', id: state.activeModId }); return true }
    if (!returnsVoid(ref.desc)) push(UNKNOWN)
    return true
  }
  return false
}

function handleInvoke (index, classInfo, state, opts, call) {
  const { ref, recv, argVals, push } = call
  const retVoid = returnsVoid(ref.desc)
  if (opts.onInvoke) opts.onInvoke(call, classInfo)
  if (jdkModelInvoke(index, state, opts, ref, recv, argVals, push, call.kind)) return
  if (storeInvoke(index, state, opts, ref, recv, argVals, push, {})) return

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
          if (argVals[0].counter) recv.counter = argVals[0].counter
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
    // HF37: the registrar's NAMESPACE names the mod whose version a runtime
    // `.versioned(modVersion)` means — kept for the mods.toml fallback, which
    // must read THAT mod's jar, not the jar hosting the registration site
    // (a library-hosted site — ldtteam blockui — carries the library's version).
    // HF51-rider: the registrar(x) ARGUMENT is its version — an argument the
    // walk cannot fold is an unresolved version, never an "unversioned"
    // registrar (the receipt names which argument went unresolved)
    push({ k: 'registrar', version, namespace: version, optional: false, versionSource: version !== null ? 'constant' : 'unresolved', versionFromParam: fromParam, versionFrom: 'registrar-argument', versioned: true })
    return
  }
  // HF37: the FML mod-list version idiom, resolved from the jar index —
  // ModList.get().getModContainerById("id").get().getModInfo().getVersion().toString()
  // is the mod's own mods.toml version (javap: minecolonies, structurize).
  if (call.kind === 'static' && ref.owner === 'net/neoforged/fml/ModList' && ref.name === 'get' && ref.desc === '()Lnet/neoforged/fml/ModList;') {
    push({ k: 'modlist' })
    return
  }
  if (recv && recv.k === 'modlist') {
    const id = ref.name === 'getModContainerById' ? asStr(argVals[0]) : null
    if (id !== null) push({ k: 'modref', id })
    else if (!retVoid) push(UNKNOWN)
    return
  }
  if (recv && recv.k === 'modref') {
    if (ref.name === 'toString' || ref.name === 'getQualifier') {
      const v = state.versionByModId ? state.versionByModId[recv.id] : null
      push(v ? vStr(v) : UNKNOWN)
    } else if (ref.name === 'getModId') push(vStr(recv.id))
    else if (!retVoid) push(recv)
    return
  }
  if (recv && recv.k === 'registrar') {
    if (ref.name === 'versioned') {
      const version = asStr(argVals[0]) ?? resolveStringValue(index, argVals[0], state)
      const fromParam = version === null && !!argVals[0] && argVals[0].k === 'param'
      push({ ...recv, version, versionSource: version !== null ? 'constant' : 'unresolved', versionFromParam: fromParam, versionFrom: 'versioned-argument', versioned: true })
      return
    }
    // HF51: `.optional()` reached under a condition this walk could not decide
    // (`if (isClientOnly(modId)) registrar = registrar.optional()`) is NOT a
    // proven optional — the abstain downstream labels it unresolved-required.
    if (ref.name === 'optional') { push({ ...recv, optional: true, optionalUndecided: !!(opts.walk && opts.walk.undecided) }); return }
    if (ref.name === 'executesOn') { push(recv); return }
    if (REGISTRATION_METHODS[ref.name]) {
      const typeId = resolveTypeValue(index, argVals[0], state) ??
        (argVals[0] && argVals[0].k === 'resloc' ? argVals[0].v : null)
      opts.onRegistration?.({
        method: ref.name,
        id: typeId,
        idVal: argVals[0],
        counter: argVals[0] && argVals[0].counter ? argVals[0].counter : null,
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
  if (call.kind === 'static' && isStrToReslocDesc(ref.desc)) {
    if (isReslocOwner(ref.owner) && (ref.name === 'parse' || ref.name === 'tryParse' || ref.name === 'withDefaultNamespace')) {
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
  if (call.kind === 'static' && isReslocOwner(ref.owner) && isStrStrToReslocDesc(ref.desc)) {
    const ns = asStr(argVals[0]); const p = asStr(argVals[1])
    push(ns !== null && p !== null ? vResloc(`${ns}:${p}`) : UNKNOWN)
    return
  }
  // HF11: any OTHER in-index static helper returning a ResourceLocation
  // ((String,String) two-arg wrappers included) resolves by simulating its
  // body — same bounds, honest UNKNOWN on miss.
  if (call.kind === 'static' && !isReslocOwner(ref.owner) && returnsResloc(ref.desc) && index.get(ref.owner)) {
    const chained = simulateForReturn(index, ref, call.kind, recv, argVals, state, opts, 'resloc')
    push(chained && chained.k === 'resloc' ? chained : UNKNOWN)
    return
  }
  // HF43: an in-index static STRING helper feeding an id factory
  // (sophisticatedcore 26.1: `Identifier.parse(getRegistryName(p))` where
  // getRegistryName = makeConcatWithConstants("sophisticatedcore:" + p)) —
  // the (String)->Identifier helper's body only ever saw UNKNOWN here because
  // no branch simulated a String-returning helper. Same bounds as the
  // resloc helper chain (frame budget + re-entrancy guard); UNKNOWN on miss.
  // HF51: a ZERO-argument String helper (`SecurityCraft.getVersion()` = the
  // ModList version idiom + a "v" concat) is a constant too — it was never
  // simulated, so `.versioned(getVersion())` fell to the mods.toml version.
  if (call.kind === 'static' && ref.desc.endsWith(')Ljava/lang/String;') && argVals.every((a) => a && (a.k === 'str' || a.k === 'int')) && index.get(ref.owner)) {
    const chained = simulateForReturn(index, ref, call.kind, recv, argVals, state, opts, 'str')
    push(chained && chained.k === 'str' ? chained : UNKNOWN)
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

// Does override `cls`'s implementation of `ref` carry the registrar? Its own
// bytes name the registrar type (checkcast / typed parameter), OR — one hop —
// its body passes an Object-typed argument into a method declared on ANOTHER
// scanned class whose bytes name the registrar (Kotlin `invoke(Object)`
// bridges forwarding straight into `Helper.register(Object)`). Bounded to
// one hop by construction: the callee's bytes are inspected, never walked.
function overrideCarriesRegistrar (index, cls, ref) {
  const own = index.rawBytes(cls)
  if (!own) return false
  if (own.includes(REGISTRAR_SIMPLE)) return true
  const info = index.get(cls)
  const m = info && info.codes.find((c) => c.method === ref.name && c.desc === ref.desc)
  if (!m) return false
  let carries = false
  walkLinear(m.code, info.cp, (op, pc, cp, code) => {
    if (carries || op < 0xb6 || op > 0xb9) return // invokevirtual/special/static/interface
    const callee = cpRef(cp, code.readUInt16BE(pc + 1))
    if (!callee || callee.owner === cls || !callee.desc.includes('Ljava/lang/Object;')) return
    const callBytes = index.rawBytes(callee.owner)
    if (callBytes && callBytes.includes(REGISTRAR_SIMPLE)) carries = true
  })
  return carries
}

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
      // HF16-R2: a generic functional interface (kotlin Function1.invoke,
      // Consumer.accept) has hundreds of scanned implementors, almost none of
      // which can CARRY the registrar — an override that does names the
      // registrar type (its checkcast / typed parameter). Count only those
      // before the bound; the rest are provably not registration bodies.
      //
      // HF16-R2 rider: "names the registrar" is widened ONE hop — an override
      // that forwards its Object argument into a method of another class
      // that names the registrar (the checkcast lives in the helper) is a
      // registration body too. Whatever is still dropped while siblings are
      // walked is abstained WITH the count and the site, never a silent
      // debug line: a forwarded override beyond the hop must not lose its
      // channels behind a sibling's successful claim.
      const carrying = targets.filter((t) => overrideCarriesRegistrar(index, t, ref))
      if (carrying.length > 12) {
        state.diagnostics.abstains.push(`${key}: ${carrying.length} overrides carrying a registrar — too many, abstaining`)
        return
      }
      const dropped = targets.length - carrying.length
      if (dropped > 0 && carrying.length > 0) {
        state.diagnostics.abstains.push(`${key}: ${dropped} of ${targets.length} overrides carry no registrar (own bytes or one forwarding hop) — dropped unfollowed, ${carrying.length} walked (${carrying.join(', ')})`)
      } else {
        debug(`${key}: ${dropped} of ${targets.length} overrides carry no registrar — dropped, ${carrying.length} walked`)
      }
      targets.length = 0
      targets.push(...carrying)
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

// HF51-rider: the mods.toml fallback receipt names WHICH version argument
// the walk could not fold — `.versioned(x)` or `registrar(x)` — and says
// "unversioned" only for a registrar that carries no version argument at all
function fallbackReceiptOf (registrar) {
  if (!registrar || !registrar.versioned) return 'mods.toml-fallback (registrar unversioned)'
  return registrar.versionFrom === 'registrar-argument' ? 'mods.toml-fallback (registrar argument unresolved)' : 'mods.toml-fallback (versioned argument unresolved)'
}

// TRI-STATE (HF51-rider): true when `ancestor` is on the chain, false when the
// whole chain up to java/lang/Object is indexed and never names it, UNKNOWN
// (null) when a class on the chain is not indexed (a library base the jar
// does not carry may implement the tested interface) or the depth bound cut
// the climb. Boolean readers treat UNKNOWN as "not proven"; instanceof /
// isAssignableFrom push UNKNOWN so the walk keeps the productive arm.
function isSubclassOf (index, name, ancestor, depth = 0) {
  if (!name || name === 'java/lang/Object') return false
  if (depth > 8) return UNKNOWN
  const info = index.get(name)
  if (!info) return UNKNOWN
  if (info.superName === ancestor || (info.interfaces || []).includes(ancestor)) return true
  let unknown = false
  for (const up of [info.superName, ...(info.interfaces || [])]) {
    const r = isSubclassOf(index, up, ancestor, depth + 1)
    if (r === true) return true
    if (r === UNKNOWN) unknown = true
  }
  return unknown ? UNKNOWN : false
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
        if (ref && isStrToReslocDesc(ref.desc)) {
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
const AGG_MAX_CONTEXTS = 512 // HF37: bounded by the step budgets below; 24 truncated a 160-holder pack (minecolonies) to nothing
const AGG_MAX_STEPS_PER_EVAL = 30000
// HF16-R2: an UNDECIDED loop (symbolic hasNext / unknown counter) is bounded
// per pc at 64 as before — raising that bound pack-wide (256 in round 1) let
// every undecided loop spin four times longer and exhausted the SHARED step
// budget on a 71-jar pack (65 required channels lost to "aggregation budget
// exhausted"). A DECIDED collection walk (a materialized iterator advancing
// over the elements the pack itself queued) earns its extra visits one per
// element consumed, charged to the walk that consumed them (opts.walk),
// never to the shared budget's bound — so a 53-packet queue is walked whole
// and an unknown loop still stops at 64.
const AGG_MAX_LOOP_VISITS = 64
const AGG_MAX_ITEMS = 512
const AGG_MAX_POPULATION_SITES = 64
const AGG_TOTAL_STEP_BUDGET = 2400000
// HF43-r MOD-ROOT walk: the JVM's own order — every @Mod constructor runs
// (class init included), THEN the loader fires RegisterPayloadHandlersEvent
// at each listener the constructors registered. Its own step budget: a pack
// whose constructors are heavy must not starve the entry passes below.
// HF51 (A3): the mod-root walk's budget is PROPORTIONAL — one budget per
// unit (a root's constructor, a listener) and a hard total cap — never one
// shared pool a single heavy constructor drains before the first listener
// runs (26.3 pack: 29 roots exhausted 1.6M steps in the constructor phase,
// 0 of 7 listeners ran, and the loud line said "ran out after 7 listeners"
// as if they had). A unit that blows its budget is abstained BY NAME (its
// root / site) and the walk continues with the next unit.
const MOD_ROOT_UNIT_STEP_BUDGET = 2000000
const MOD_ROOT_TOTAL_STEP_BUDGET = 24000000
const MOD_ROOT_STEP_BUDGET = MOD_ROOT_UNIT_STEP_BUDGET // the per-unit limit the evaluator sees
const MOD_ROOT_MAX_LISTENERS = 256
const PLATFORM_MODELED_TYPES = new Set([REGISTRAR_TYPE, EVENT_TYPE]) // modeled by handleInvoke, never inlined from the loader jar
const COUNTER_TYPES = new Set(['java/util/concurrent/atomic/AtomicInteger', 'java/util/concurrent/atomic/AtomicLong'])
const LISTENER_REGISTRATION_METHODS = new Set(['addListener', 'addGenericListener', 'register']) // the loader bus API (NeoForge / Forge)
// The loader's own dispatch order (javap net/neoforged/neoforge/internal/
// CommonModLoader.load, 26.1.2.109): "Common setup" (FMLCommonSetupEvent,
// enqueueWork drained after) -> "Sided setup" (FMLDedicatedServerSetupEvent
// on a server) -> "Registration events" (NetworkRegistry.setup posts
// RegisterPayloadHandlersEvent). A mod may build its network in common setup
// and still register it; the walk fires the phases in that order.
const LIFECYCLE_PHASES = [
  'net/neoforged/fml/event/lifecycle/FMLConstructModEvent',
  'net/neoforged/fml/event/lifecycle/FMLCommonSetupEvent',
  'net/neoforged/fml/event/lifecycle/FMLDedicatedServerSetupEvent',
  EVENT_TYPE
]
const isModEntryAnnotation = (type) => /^L(?:net\/neoforged\/fml\/common|net\/minecraftforge\/fml\/common)\/Mod;$/.test(String(type))

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
    v.k === 'cls' || v.k === 'obj' || v.k === 'enumconst' || v.k === 'lambda') // HF37: a registration lambda is a populated element
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
// the arm's first instruction ends the path (a return) or jumps away (goto)
function armLeavesAtOnce (code, startPc) {
  const op = code[startPc]
  return op === 0xb1 || op === 0xb0 || op === 0xac || op === 0xad || op === 0xae || op === 0xaf || op === 0xa7 || op === 0xc8
}
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
  const prevClassInfo = state.evalClassInfo
  state.evalClassInfo = classInfo
  const stack = state.modRootPass ? state.rootStack : null
  if (stack) {
    const k = `${classInfo.className}.${method.method}${method.desc}`
    stack.push(k)
    if (state.rootVisited) state.rootVisited.add(k)
  }
  try {
    return evaluateMethodInner(index, classInfo, method, state, opts, hooks)
  } finally {
    state.evalClassInfo = prevClassInfo
    if (stack) stack.pop()
  }
}

// HF43-r: a (object, field) counter holder — who advanced it (roots /
// listeners) and whether it was ever re-stored. Registered on the object.
function counterHolder (state, obj, name) {
  obj.counters = obj.counters || {}
  if (!obj.counters[name]) obj.counters[name] = { touches: new Set(), mutated: false, cls: obj.cls, field: name }
  const h = obj.counters[name]
  if (state.currentRoot) h.touches.add(state.currentRoot)
  return h
}

// HF43-r: run a class's static initializer once, on first static read
// (JVMS §5.5), cycle-guarded and budget-bounded; a class outside the jars,
// or one already initialized, is a no-op.
function lazyClassInit (index, state, cls) {
  state.clinitDone = state.clinitDone || new Set()
  if (state.clinitDone.has(cls)) return
  const info = index.get(cls)
  if (!info) return
  state.clinitDone.add(cls)
  const clinit = info.codes.find((c) => c.method === '<clinit>')
  if (!clinit) return
  if (state.aggSteps > (state.aggStepLimit ?? AGG_TOTAL_STEP_BUDGET) * 0.8) return
  if (process.env.MINEPAL_MODROOT_TRACE) debug(`mr-clinit ${cls} steps=${state.aggSteps}`)
  evaluateMethod(index, info, clinit, state, { locals: [], recordPutstatic: true }, state.rootHooks || {})
}

// HF37: run a lambda value. captured + call arguments seed the implementation
// method's locals (a bound instance method reference takes its receiver from
// the first captured value, an unbound one from the first call argument; a
// constructor reference builds the object). Implementations outside the
// scanned jars route through the ordinary invoke path so a registrar method
// reference registers exactly like a direct registrar call.
function invokeLambda (index, state, opts, lam, args, push, hooks = {}) {
  const { impl, captured } = lam
  const all = [...captured, ...args]
  const isStatic = impl.refKind === 6
  const retVoid = returnsVoid(impl.desc)
  if (impl.name === '<init>') {
    const obj = { k: 'obj', cls: impl.owner, ctorArgs: all, ctorDesc: impl.desc, fields: {} }
    push(obj)
    return true
  }
  const recvVal = isStatic ? null : all[0]
  const callArgs = isStatic ? all : all.slice(1)
  const dispatchCls = (!isStatic && recvVal && recvVal.k === 'obj' && index.get(recvVal.cls)) ? recvVal.cls : impl.owner
  // HF43-r: the loader's registrar / event are MODELED values (handleInvoke),
  // never run from their own bytecode — with the loader universal jar in the
  // census a `PayloadRegistrar::playToClient` method reference would
  // otherwise inline the loader's body and the registration would vanish.
  const platform = PLATFORM_MODELED_TYPES.has(dispatchCls) || (recvVal && recvVal.k === 'registrar')
  const target = (!platform && index.get(dispatchCls)) ? findVirtualMethod(index, dispatchCls, impl.name, impl.desc) : null
  if (target) {
    state.aggInlineStack = state.aggInlineStack || new Set()
    const key = `l:${target.info.className}.${impl.name}${impl.desc}`
    if (state.aggInlineStack.has(key) || state.aggInlineStack.size > 24) { if (!retVoid) push(UNKNOWN); return true }
    state.aggInlineStack.add(key)
    let returned
    try {
      evaluateMethod(index, target.info, target.m, state, {
        locals: isStatic ? seedArgLocals(impl.desc, callArgs) : seedArgLocals(impl.desc, callArgs, recvVal ?? UNKNOWN),
        recordPutstatic: false,
        onReturn: (v) => { returned = v },
        onRegistration: opts.onRegistration
      }, hooks)
    } finally {
      state.aggInlineStack.delete(key)
    }
    if (!retVoid) push(returned ?? UNKNOWN)
    return true
  }
  const ref = { owner: impl.owner, name: impl.name, desc: impl.desc }
  const kind = isStatic ? 'static' : 'instance'
  if (hooks.onCall) hooks.onCall(ref, kind, recvVal, callArgs)
  if (evaluatorPreInvoke(index, state, opts, ref, recvVal, callArgs, push, hooks, kind)) return true
  const classInfo = state.evalClassInfo || { className: impl.owner, jar: null }
  handleInvoke(index, classInfo, state, opts, { kind, ref, recv: recvVal, argVals: callArgs, push, pc: -1 })
  return true
}

// HF37: javac's invokedynamic string concatenation — the bootstrap recipe
// (\u0001 = next dynamic operand, \u0002 = next bootstrap constant) folds to a
// string only when every operand is concrete; anything else stays UNKNOWN.
function concatWithConstants (classInfo, bsmIndex, captured) {
  const bsm = classInfo.bootstrapMethods && classInfo.bootstrapMethods[bsmIndex]
  if (!bsm) return UNKNOWN
  const cp = classInfo.cp
  const consts = []
  let recipe = null
  for (const argIdx of bsm.args) {
    const c = cp[argIdx]
    if (!c) return UNKNOWN
    if (c.tag === 8) { const str = cpUtf8(cp, c.strIndex); if (recipe === null) recipe = str; else consts.push(str) } else if (c.tag === 3) consts.push(String(c.int)); else return UNKNOWN
  }
  if (recipe === null) return UNKNOWN
  let out = ''
  let di = 0; let ci = 0
  let taint = null
  for (const ch of recipe) {
    if (ch === '\u0001') {
      const v = captured[di++]
      if (v && v.k === 'str') out += v.v
      else if (v && v.k === 'int') out += String(v.v)
      else if (v && v.k === 'resloc') out += v.v
      else return UNKNOWN
      if (v.counter) taint = v.counter
    } else if (ch === '\u0002') {
      if (ci >= consts.length) return UNKNOWN
      out += consts[ci++]
    } else out += ch
  }
  const res = vStr(out)
  if (taint) res.counter = taint
  return res
}

function evaluateMethodInner (index, classInfo, method, state, opts = {}, hooks = {}) {
  state.aggCache = state.aggCache || new Map()
  opts = { ...opts, methodCtx: { cls: classInfo.className, name: method.method, desc: method.desc, flags: method.flags }, walk: { iterAdvances: 0 } }
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
    if (++steps > AGG_MAX_STEPS_PER_EVAL || ++state.aggSteps > (state.aggStepLimit ?? AGG_TOTAL_STEP_BUDGET)) {
      state.aggBudgetBlown = true
      return
    }
    const seen = (visits.get(pc) || 0) + 1
    visits.set(pc, seen)
    // loop bound: 64 per pc for an undecided loop; a decided iterator walk adds one visit per element it consumed (bounded by the element cap)
    if (seen > AGG_MAX_LOOP_VISITS + Math.min(opts.walk.iterAdvances, AGG_MAX_ITEMS)) return
    const op = code[pc]
    const next = pc + instrLen(pc)
    let jumped = false
    const jump = (target) => { pc = target; jumped = true }
    const condBranch = (target, known, takeJump) => {
      if (known) {
        if (takeJump) jump(target)
        return
      }
      // unknown condition: avoid an immediately-throwing arm; HF51-rider: and
      // an arm that leaves at once (a guard's `return` / a loop's `continue`
      // goto) when the other arm does work — `if (!(e instanceof I)) continue;
      // register(e)` walks the registration instead of skipping it silently
      if (opts.walk) opts.walk.undecided = true // HF51: an `.optional()` met past here is not proven
      if (armThrowsImmediately(code, next, cp) && !armThrowsImmediately(code, target, cp)) jump(target)
      else if (armLeavesAtOnce(code, next) && !armLeavesAtOnce(code, target) && !armThrowsImmediately(code, target, cp)) jump(target)
      // else fall through
    }

    switch (op) {
      case 0x01: push({ k: 'null' }); break // aconst_null is a KNOWN null (HF37: decides ifnull/ifnonnull on ctor-bound fields)
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
      case 0x60: case 0x64: case 0x68: { // iadd / isub / imul — decided for two ints (HF43-r: `"/" + next++` int-field counters); the counter taint rides the result
        const b = stack.pop(); const a = stack.pop()
        if (a && a.k === 'int' && b && b.k === 'int') {
          const v = op === 0x60 ? a.v + b.v : op === 0x64 ? a.v - b.v : Math.imul(a.v, b.v)
          const out = vInt(v)
          const taint = a.counter || b.counter
          if (taint) out.counter = taint
          push(out)
        } else push(UNKNOWN)
        break
      }
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
          // HF37: a self-typed static of a class OUTSIDE the scanned jars
          // (PacketFlow.CLIENTBOUND, a loader enum) is an identity — decided
          // by name in if_acmp / $SwitchMap, never by a guessed ordinal.
          if ((ownerInfo && ownerInfo.superName === 'java/lang/Enum') || !ownerInfo) {
            push({ k: 'enumconst', cls: ref.owner, name: ref.name })
            break
          }
        }
        const key = `${ref.owner}.${ref.name}`
        if (key in state.fieldValues) { push(state.fieldValues[key]); break }
        // HF16-R2: the use-site owner may be a subclass/implementor of the
        // declarer (JVMS §5.4.3.2) — read through the declarer key the
        // putstatic side already writes (a Kotlin object INSTANCE / a
        // companion read through an inheriting owner).
        const declKey = staticFieldKey(index, ref)
        // HF43-r: under the mod-root walk a static read of a class whose
        // initializer has not run yet runs it first (JVMS §5.5: getstatic
        // triggers class initialization) — once per class, cycle-guarded,
        // under the walk's own budget. This is what makes a packet's static
        // TYPE / ID and a mod's static channel object real values instead of
        // {k:'field'} placeholders.
        if (state.lazyClinit && !(declKey in state.fieldValues)) lazyClassInit(index, state, declKey.slice(0, declKey.length - ref.name.length - 1))
        if (declKey in state.fieldValues) push(state.fieldValues[declKey])
        else push({ k: 'field', owner: ref.owner, name: ref.name, desc: ref.desc })
        break
      }
      case 0xb3: { // putstatic — keyed by the DECLARER, symmetric with getstatic (HF16-R rider)
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        let val = stack.pop()
        if (ref && state.lazyClinit && opts.methodCtx && opts.methodCtx.name !== '<clinit>') lazyClassInit(index, state, staticFieldDeclarer(index, ref)) // JVMS §5.5: putstatic initializes the class
        // HF51: a static COLLECTION / registry table a class initializer fills
        // from a library factory (`HashBasedTable.create()`, `Tables.synchronizedTable`)
        // is an object with IDENTITY — the keyed store every later get/put on
        // it addresses — never an unknown that forgets what was put.
        if (ref && !val && state.modRootPass && opts.methodCtx && opts.methodCtx.name === '<clinit>' && /^L(java\/util\/|com\/google\/common\/collect\/)[^;]+;$/.test(ref.desc) && index.get(staticFieldDeclarer(index, ref))) {
          val = { k: 'obj', cls: ref.desc.slice(1, -1), fields: {}, fieldsBound: true, opaqueFactory: true }
        }
        if (ref && val && val.k === 'obj' && !val.heldBy) val.heldBy = { cls: staticFieldDeclarer(index, ref), field: ref.name } // HF51: the store's holder (its writer scan)
        if (ref && val && (opts.recordPutstatic || val.k === 'registrar' || state.modRootPass)) state.fieldValues[staticFieldKey(index, ref)] = val // HF43-r: under the mod-root walk every static store is JVM state (a channel built in a setup lambda is read back by getstatic); registrar statics: see the linear walk
        break
      }
      case 0xb4: { // getfield — construction-bound objects read real values
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        const obj = stack.pop()
        if (obj && obj.k === 'obj' && ref) {
          if (!obj.fieldsBound && obj.ctorDesc && index.get(obj.cls)) bindCtorFields(index, state, obj)
          if (obj.fields && ref.name in obj.fields) {
            const held = obj.fields[ref.name]
            // HF43-r: an int read from a field the object later re-stores is
            // a registration COUNTER candidate — the taint carries the field
            // holder so the assembly can prove (or refuse) its order.
            if (held && held.k === 'int' && state.modRootPass) {
              const holder = counterHolder(state, obj, ref.name)
              push({ k: 'int', v: held.v, counter: holder })
            } else push(held)
            break
          }
          // HF43-r: a primitive field the constructor never stored holds the
          // JVM default (JVMS §2.3 / §4.5) — decided only for an object built
          // in this universe whose constructor body ran (`private int next;`).
          if (obj.fieldsBound && obj.ctorDesc && /^[IJSBCZ]$/.test(ref.desc) && state.modRootPass) {
            push({ k: 'int', v: 0, counter: counterHolder(state, obj, ref.name) })
            break
          }
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
          const prev = obj.fields[ref.name]
          if (state.modRootPass && val && val.k === 'int' && prev && prev.k === 'int' && prev.v !== val.v) counterHolder(state, obj, ref.name).mutated = true
          obj.fields[ref.name] = val
          if (val && val.k === 'obj' && !val.heldBy) val.heldBy = { cls: obj.cls, field: ref.name } // HF51: the store's holder (its writer scan)
        }
        break
      }
      case 0xbb: {
        const cls = cpClassName(cp, code.readUInt16BE(pc + 1))
        if (state.lazyClinit) lazyClassInit(index, state, cls) // JVMS §5.5: `new` initializes the class
        push({ k: 'new', cls })
        break
      }
      case 0xbd: pop(1); push({ k: 'varr', items: [] }); break // HF51: a real array
      case 0x53: { const v = stack.pop(); const i = stack.pop(); const a = stack.pop(); if (a && a.k === 'varr' && i && i.k === 'int') a.items[i.v] = v; break } // aastore
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
          // HF37: a focus instance's constructor runs AT construction (as the
          // JVM does), so its population side effects — `ALL_NETWORKS.add(this)`
          // into the focus class's static registry — happen for every instance,
          // not only for those some later read happened to bind lazily.
          bindCtorFields(index, state, recv)
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
        if (state.lazyClinit) lazyClassInit(index, state, ref.owner) // JVMS §5.5: invokestatic initializes the class
        if (hooks.onCall) hooks.onCall(ref, 'static', null, argVals)
        if (evaluatorPreInvoke(index, state, opts, ref, null, argVals, push, hooks, 'static')) break
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
        const impl = (c && classInfo.bootstrapMethods) ? resolveLambdaImpl(classInfo, c.bsmIndex) : null
        if (hooks.onIndy && impl) hooks.onIndy(impl, captured)
        if (!returnsVoid(desc)) {
          // HF37: a lambda / method reference is a VALUE — its implementation
          // handle plus the captured arguments — invoked when the functional
          // interface method is called on it (evaluatorPreInvoke); javac's
          // StringConcatFactory recipe folds when every operand is concrete.
          const samName = nat ? cpUtf8(cp, nat.nameIndex) : null
          if (impl && impl.refKind >= 5 && impl.refKind <= 9) {
            push({ k: 'lambda', impl, captured, sam: samName })
          } else if (samName === 'makeConcatWithConstants' && c) {
            push(concatWithConstants(classInfo, c.bsmIndex, captured))
          } else push(UNKNOWN)
        }
        break
      }
      case 0xb0: {
        const v = stack.pop()
        if (opts.onReturn) opts.onReturn(v)
        return
      }
      case 0xac: { const v = stack.pop(); if (opts.onReturn) opts.onReturn(v); return } // ireturn — HF51: a boolean / int result (Set.contains) reaches the caller's branch
      case 0xad: case 0xae: case 0xaf: pop(); return // lreturn / freturn / dreturn
      case 0xb1: return // return
      case 0xbf: return // athrow: path ends
      case 0xc0: break // checkcast
      case 0xc1: { // instanceof — HF51: decided for a universe-constructed object of an indexed class
        const v = stack.pop()
        const target = cpClassName(cp, code.readUInt16BE(pc + 1))
        if (v && v.k === 'obj' && target && index.get(v.cls)) { const r = v.cls === target ? true : isSubclassOf(index, v.cls, target); push(r === UNKNOWN ? UNKNOWN : vInt(r ? 1 : 0)) } else if (v && v.k === 'null') push(vInt(0))
        else push(UNKNOWN)
        break
      }
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
      case 0xa5: case 0xa6: { // if_acmpeq/ne — decidable for two enum identities or two construction-bound objects (HF37)
        const b = stack.pop(); const a = stack.pop()
        const bothEnum = !!(a && b && a.k === 'enumconst' && b.k === 'enumconst')
        const bothObj = !!(a && b && a.k === 'obj' && b.k === 'obj')
        const eq = bothEnum ? (a.cls === b.cls && a.name === b.name) : a === b
        condBranch(pc + code.readInt16BE(pc + 1), bothEnum || bothObj, op === 0xa5 ? eq : !eq)
        break
      }
      case 0xc6: case 0xc7: { // ifnull / ifnonnull
        const v = stack.pop()
        const knownNonnull = !!v && (v.k === 'str' || v.k === 'int' || v.k === 'resloc' || v.k === 'type' || v.k === 'cls' || v.k === 'obj' || v.k === 'new' || v.k === 'enumconst' || v.k === 'registrar' || v.k === 'lambda')
        const knownNull = !!v && v.k === 'null'
        condBranch(pc + code.readInt16BE(pc + 1), knownNonnull || knownNull, (knownNonnull && op === 0xc7) || (knownNull && op === 0xc6))
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
const MATERIALIZING_ADDS = { add: 'last', addLast: 'last', offer: 'last', offerLast: 'last', addFirst: 'first', offerFirst: 'first', push: 'first' }

// Gathers a concrete element onto a constructed collection object; the same
// lambda (same implementation, same captured values by identity) added twice
// is one element — a producer runs once under its caller contexts and once
// more when a context climb inlines it.
function materializeElement (recv, v, first) {
  recv.items = recv.items || []
  if (!isConcreteish(v)) recv.opaqueItems = true // HF51: a contains()/size() on this store can no longer say "absent"
  const dup = !!v && v.k === 'lambda' && recv.items.some((it) => it && it.k === 'lambda' && it.impl.owner === v.impl.owner &&
    it.impl.name === v.impl.name && it.impl.desc === v.impl.desc && it.captured.length === v.captured.length && it.captured.every((c, i) => c === v.captured[i]))
  if (!isConcreteish(v) || dup || recv.items.length >= AGG_MAX_ITEMS) return
  if (first) recv.items.unshift(v); else recv.items.push(v)
}

function evaluatorPreInvoke (index, state, opts, ref, recv, argVals, push, hooks = {}, callKind = recv ? 'instance' : 'unknown') {
  // HF37 LAMBDA invocation: the functional-interface call on a lambda value
  // runs its implementation with captured + call arguments (a method
  // reference onto a loader API such as PayloadRegistrar::playToClient
  // routes through the ordinary registrar recognition).
  if (recv && recv.k === 'lambda' && (!recv.sam || ref.name === recv.sam)) {
    return invokeLambda(index, state, opts, recv, argVals, push, hooks)
  }
  // HF37 collection walk: forEach over a jar-populated collection applies
  // the consumer lambda to every populated element (bounded by the
  // population cap and the step budgets).
  if (recv && (recv.k === 'obj' || recv.k === 'collection' || recv.k === 'varr') && ref.name === 'forEach' &&
      argVals.length === 1 && argVals[0] && argVals[0].k === 'lambda') {
    for (const item of (recv.items || []).slice(0, AGG_MAX_ITEMS)) invokeLambda(index, state, opts, argVals[0], [item], () => {}, hooks)
    return true
  }
  // HF43-r FML deferred work: event.enqueueWork(runnable|supplier) runs on the
  // sync executor before the next lifecycle phase — run it now.
  if (ref.name === 'enqueueWork' && !index.get(ref.owner) && argVals.length === 1 && argVals[0] && argVals[0].k === 'lambda') {
    invokeLambda(index, state, opts, argVals[0], [], () => {}, hooks)
    if (!returnsVoid(ref.desc)) push(UNKNOWN)
    return true
  }
  if (!recv && ref.owner === 'java/util/Objects' && ref.name === 'requireNonNull' && argVals.length >= 1) {
    push(argVals[0]) // identity pass-through (javac's null-check idiom around method references)
    return true
  }
  if (!recv && ref.owner === 'java/lang/Integer' && ref.name === 'toString' && ref.desc === '(I)Ljava/lang/String;') {
    push(argVals[0] && argVals[0].k === 'int' ? vStr(String(argVals[0].v)) : UNKNOWN)
    return true
  }
  // collection modeling by OBJECT IDENTITY: `add` on any abstract object
  // gathers concrete elements onto that object; `iterator` replays exactly
  // them. This is what keeps multi-instance aggregators separate (each
  // manager's HashSet is its own vObj) — per-instance versions never mix.
  // HF16-R2 round 2: every single-element collection mutator the producer
  // detector accepts (COLLECTION_MUTATORS) materializes — add/addLast/offer/
  // offerLast append, addFirst/offerFirst/push prepend (a Deque used as a
  // stack replays LIFO), Map.put keeps the VALUE (a values() walk replays
  // them). One rule, one element cap, one identity dedupe.
  if (storeInvoke(index, state, opts, ref, recv, argVals, push, hooks)) return true // HF51 keyed stores (shared with the linear walk)
  if (recv && recv.k === 'obj' && MATERIALIZING_ADDS[ref.name] && (ref.desc === '(Ljava/lang/Object;)Z' || ref.desc === '(Ljava/lang/Object;)V')) {
    materializeElement(recv, argVals[0], MATERIALIZING_ADDS[ref.name] === 'first')
    if (ref.desc.endsWith('Z')) push(vInt(1))
    return true
  }
  if (recv && recv.k === 'obj' && ref.name === 'put' && ref.desc === '(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;') {
    materializeElement(recv, argVals[1], false)
    push(UNKNOWN)
    return true
  }
  if (recv && recv.k === 'obj' && ref.name === 'values' && ref.desc === '()Ljava/util/Collection;') {
    push({ k: 'collection', items: storeValuesOf(recv), opaqueItems: !!recv.opaqueItems })
    return true
  }
  // NOTE: every {k:'obj'} was CONSTRUCTED inside this evaluation universe
  // (symbolic values stay {k:'field'}/{k:'param'}/UNKNOWN), so an obj with
  // no captured adds truthfully iterates EMPTY — an unknown-hasNext loop
  // would instead spin to the visit cap and abort the whole method (the
  // aeronautics manager's empty clientbound set killed its serverbound
  // harvest exactly that way).
  if (recv && (recv.k === 'collection' || recv.k === 'obj') && ref.name === 'iterator' && argVals.length === 0) {
    push({ k: 'iter', items: recv.k === 'obj' ? storeValuesOf(recv) : (recv.items || []), i: 0 })
    return true
  }
  if (recv && recv.k === 'iter') {
    if (ref.name === 'hasNext') { push(vInt(recv.i < recv.items.length ? 1 : 0)); return true }
    if (ref.name === 'next') {
      if (recv.i < recv.items.length && opts.walk) opts.walk.iterAdvances++ // a decided advance — the walk earns one more loop visit
      push(recv.items[recv.i++] ?? UNKNOWN)
      return true
    }
  }
  // Class.isAssignableFrom over the scanned hierarchy
  if (ref.owner === CLASS_TYPE && ref.name === 'isAssignableFrom' && recv && recv.k === 'cls' && argVals[0] && argVals[0].k === 'cls') {
    const a = recv.v; const b = argVals[0].v
    const r = a === b ? true : isSubclassOf(index, b, a)
    push(r === UNKNOWN ? UNKNOWN : vInt(r ? 1 : 0))
    return true
  }
  // Enum.ordinal() on a known constant
  if (ref.name === 'ordinal' && ref.desc === '()I' && recv && recv.k === 'enumconst') {
    const ord = enumOrdinal(index, state, recv.cls, recv.name)
    push(ord === null ? recv : vInt(ord)) // HF37: an enum outside the scanned jars keeps its identity — the $SwitchMap read resolves by constant NAME
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
  // HF43-r registry COUNTERS (java.util.concurrent.atomic): the counter is a
  // construction-bound object whose value advances in evaluation order — the
  // class-init order the JVM would follow. Every value it hands out carries
  // the counter so an id built from it can be refused when the order is not
  // provable (two independent listeners advancing one counter).
  if (recv && recv.k === 'obj' && COUNTER_TYPES.has(recv.cls)) {
    const holder = counterHolder(state, recv, '#atomic')
    if (recv.count === undefined) {
      const seed = recv.ctorArgs && recv.ctorArgs[0]
      recv.count = !seed ? 0 : (seed.k === 'int' ? seed.v : null)
    }
    if (state.currentRoot) holder.touches.add(state.currentRoot)
    const known = recv.count !== null
    const arg0 = argVals[0] && argVals[0].k === 'int' ? argVals[0].v : null
    const out = (v) => { const r = vInt(v); r.counter = holder; return r }
    switch (ref.name) {
      case 'get': case 'intValue': case 'longValue': case 'getPlain': case 'getAcquire': push(known ? out(recv.count) : UNKNOWN); return true
      case 'getAndIncrement': holder.mutated = true; if (known) { push(out(recv.count)); recv.count++ } else push(UNKNOWN); return true
      case 'incrementAndGet': holder.mutated = true; if (known) { recv.count++; push(out(recv.count)) } else push(UNKNOWN); return true
      case 'getAndDecrement': holder.mutated = true; if (known) { push(out(recv.count)); recv.count-- } else push(UNKNOWN); return true
      case 'decrementAndGet': holder.mutated = true; if (known) { recv.count--; push(out(recv.count)) } else push(UNKNOWN); return true
      case 'getAndAdd': holder.mutated = true; if (known && arg0 !== null) { push(out(recv.count)); recv.count += arg0 } else { recv.count = null; push(UNKNOWN) } return true
      case 'addAndGet': holder.mutated = true; if (known && arg0 !== null) { recv.count += arg0; push(out(recv.count)) } else { recv.count = null; push(UNKNOWN) } return true
      case 'set': case 'lazySet': case 'setPlain': holder.mutated = true; recv.count = arg0; if (!returnsVoid(ref.desc)) push(UNKNOWN); return true
      default: recv.count = null; if (!returnsVoid(ref.desc)) push(UNKNOWN); return true // anything else (compareAndSet, updateAndGet ...) makes the value unprovable
    }
  }
  // HF43-r Identifier derivations on a resolved id: withSuffix / withPrefix /
  // withPath (26.1 Identifier + 1.21 ResourceLocation spell them alike).
  if (recv && recv.k === 'resloc' && isReslocOwner(ref.owner) && ref.desc === `(Ljava/lang/String;)L${ref.owner};` && argVals[0] && argVals[0].k === 'str') {
    const [ns, ...rest] = String(recv.v).split(':')
    const p = rest.join(':')
    let v = null
    if (ref.name === 'withSuffix') v = `${recv.v}${argVals[0].v}`
    else if (ref.name === 'withPrefix') v = `${ns}:${argVals[0].v}${p}`
    else if (ref.name === 'withPath') v = `${ns}:${argVals[0].v}`
    if (v !== null) {
      const out = vResloc(v)
      const taint = recv.counter || argVals[0].counter
      if (taint) out.counter = taint
      push(out)
      return true
    }
  }
  // HF43-r class-NAME ids: the message class reference (an ldc class
  // constant) names itself — getSimpleName / getName / getTypeName /
  // getPackageName are decided from the constant, never from a runtime Class.
  if (recv && recv.k === 'cls' && ref.owner === CLASS_TYPE && ref.desc === '()Ljava/lang/String;') {
    const internal = String(recv.v)
    const binary = internal.replace(/\//g, '.')
    if (ref.name === 'getSimpleName') { const last = internal.split('/').pop(); push(vStr(last.slice(last.lastIndexOf('$') + 1))); return true }
    if (ref.name === 'getName' || ref.name === 'getTypeName' || ref.name === 'getCanonicalName') { push(vStr(ref.name === 'getName' ? binary : binary.replace(/\$/g, '.'))); return true }
    if (ref.name === 'getPackageName') { push(vStr(binary.includes('.') ? binary.slice(0, binary.lastIndexOf('.')) : '')); return true }
  }
  // HF43-r java.util.Optional (JDK semantics): a DECIDED optional carries its
  // value; ifPresent on an optional this universe cannot decide (a mod's
  // event bus looked up from the loader) runs the consumer — the loader
  // hands every loaded mod its bus, and a registration behind an undecided
  // presence check is one the server performs. A decided-EMPTY optional
  // never runs it.
  if (callKind === 'static' && ref.owner === 'java/util/Optional') {
    if (ref.name === 'of' || ref.name === 'ofNullable') { push({ k: 'optional', v: argVals[0] ?? UNKNOWN }); return true }
    if (ref.name === 'empty') { push({ k: 'optional', v: { k: 'null' } }); return true }
  }
  if (ref.owner === 'java/util/Optional' && (!recv || recv.k !== 'obj')) {
    const decided = recv && recv.k === 'optional'
    const empty = decided && recv.v && recv.v.k === 'null'
    const held = decided && !empty ? (recv.v ?? UNKNOWN) : UNKNOWN
    if ((ref.name === 'ifPresent' || ref.name === 'ifPresentOrElse') && argVals[0] && argVals[0].k === 'lambda') {
      if (!empty) invokeLambda(index, state, opts, argVals[0], [held], () => {}, hooks)
      else if (ref.name === 'ifPresentOrElse' && argVals[1] && argVals[1].k === 'lambda') invokeLambda(index, state, opts, argVals[1], [], () => {}, hooks)
      return true
    }
    if (decided) {
      if (ref.name === 'isPresent') { push(held === UNKNOWN && !empty ? UNKNOWN : vInt(empty ? 0 : 1)); return true }
      if (ref.name === 'isEmpty') { push(held === UNKNOWN && !empty ? UNKNOWN : vInt(empty ? 1 : 0)); return true }
      if (ref.name === 'get' || ref.name === 'orElseThrow' || ref.name === 'orElse' || ref.name === 'orElseGet') { push(empty ? (ref.name === 'orElse' ? (argVals[0] ?? UNKNOWN) : UNKNOWN) : held); return true }
      if ((ref.name === 'map' || ref.name === 'flatMap') && argVals[0] && argVals[0].k === 'lambda') {
        if (empty) { push(recv); return true }
        let returned = UNKNOWN
        invokeLambda(index, state, opts, argVals[0], [held], (v) => { returned = v }, hooks)
        push(ref.name === 'map' ? { k: 'optional', v: returned ?? UNKNOWN } : (returned && returned.k === 'optional' ? returned : { k: 'optional', v: UNKNOWN }))
        return true
      }
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
              const v = state.fieldValues[staticFieldKey(index, fref)]
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
  // HF16-R2 rider: an invokestatic against the interface (a static interface
  // method, geckolib GeckoLibNetworking.registerPacket) has NO receiver to
  // dispatch on — seeding the impl as slot 0 shifted every argument by one
  // (the Type became the service object). Static calls take the static
  // inline rule below; the services rule is for receiver-less INSTANCE calls.
  if (callKind !== 'static' && (!recv || recv.k === 'field' || recv.k === 'instfield' || recv === UNKNOWN) && index.services) {
    // HF43-r: a receiver read from a field DECLARED as the service interface
    // (puzzles `ProxyImpl.INSTANCE`, called through a super-interface method)
    // names the service by its declared type; the call's owner is the second
    // key. Either way the services file is the truth and ambiguity abstains.
    const candidates = []
    if (recv && (recv.k === 'field' || recv.k === 'instfield') && typeof recv.desc === 'string' && recv.desc.startsWith('L') && recv.desc.endsWith(';')) candidates.push(recv.desc.slice(1, -1))
    candidates.push(ref.owner)
    for (const iface of candidates) {
      const impls = index.services.get(iface)
      if (impls && new Set(impls).size === 1 && index.get(impls[0]) && findVirtualMethod(index, impls[0], ref.name, ref.desc)) {
        const implRecv = { k: 'obj', cls: impls[0], fields: {}, fieldsBound: true, serviceImpl: true }
        return inlineDispatch(index, state, opts, implRecv, ref, argVals, push, hooks)
      }
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
  if (!recv && ((state.aggStaticScope && state.aggStaticScope.has(ref.owner)) || state.aggInlineAll) && index.get(ref.owner) && !PLATFORM_MODELED_TYPES.has(ref.owner)) {
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
  // owners whose invocation resolves to the target: itself + throw-only
  // stubs it grafts onto (glitchcore PacketHandler <- MixinPacketHandler)
  const ownerAliases = new Set([target.cls])
  for (const cls of state.allClassNames) {
    if (cls === target.cls) continue
    const info = index.get(cls)
    if (!info) continue
    const stub = info.codes.find((c) => c.method === target.name && c.desc === target.desc && isThrowOnlyStub(c))
    if (stub && resolveGraftImpl(index, state, cls, target.name, target.desc) === target.cls) { ownerAliases.add(cls); continue }
    // HF16-R2 — JVMS §5.4.3.3 downward: javac/kotlinc qualify an inherited
    // method by the receiver's STATIC type, so `this.register(p)` inside a
    // subclass names the SUBCLASS as owner; it resolves up the superclass
    // chain to the target when no class in between overrides it.
    if (target.name !== '<init>' && resolvesUpTo(index, cls, target)) ownerAliases.add(cls)
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

// Does an invocation written against `cls` (which does not declare the
// method itself) resolve up the superclass chain to target.cls? Bounded walk.
// HF16-R2 round 2: when no superclass declares the method, the resolution
// continues into the interfaces of every class on the chain (an interface
// DEFAULT method, JVMS §5.4.3.3 step 3) — bounded, superclass-first.
function resolvesUpTo (index, cls, target) {
  const chain = []
  let cur = cls
  for (let depth = 0; cur && depth <= 8; depth++) {
    const info = index.get(cur)
    if (!info) break
    if (cur !== cls && cur === target.cls) return true
    if (info.codes.some((c) => c.method === target.name && c.desc === target.desc)) return false
    if (info.superName === target.cls) return true
    chain.push(info)
    cur = info.superName
  }
  const seen = new Set()
  const queue = chain.flatMap((info) => info.interfaces || [])
  for (let n = 0; n < queue.length && n < 64; n++) {
    const itf = queue[n]
    if (seen.has(itf)) continue
    seen.add(itf)
    if (itf === target.cls) return true
    const ii = index.get(itf)
    if (!ii) continue
    if (ii.codes.some((c) => c.method === target.name && c.desc === target.desc)) return false
    queue.push(...(ii.interfaces || []))
  }
  return false
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
  const prevInlineAll = state.aggInlineAll
  try {
    // HF37: the focus class's own static registries (`ALL_NETWORKS = new
    // HashSet<>()` in its <clinit>) must exist before population sites add
    // to them; population chains run through builders/service helpers in
    // OTHER classes, so static calls inline through any scanned class here
    // (still bounded by the inline depth + the step budgets).
    const focusInfo = index.get(focusCls)
    const focusClinit = focusInfo && focusInfo.codes.find((c) => c.method === '<clinit>')
    if (focusClinit) evaluateMethod(index, focusInfo, focusClinit, state, { locals: [], recordPutstatic: true }, {})
    state.aggInlineAll = true
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
    state.aggInlineAll = prevInlineAll
    state.aggStaticScope = prevScope
    state.aggFocus = prevFocus
    state.aggConstructed = prevConstructed
  }
  return constructed
}

// The static java.util registries an entry method reads: on OTHER classes
// (focus-pass candidates) and on the entry's OWN class (own-registry
// population, HF16-R2).
function entryRegistries (index, info, method) {
  const registries = new Set()
  const own = new Set()
  walkLinear(method.code, info.cp, (op, pc, cp, code) => {
    if (op !== 0xb2) return
    const ref = cpRef(cp, code.readUInt16BE(pc + 1))
    if (!ref || !ref.desc.startsWith('Ljava/util/') || !index.get(ref.owner)) return
    if (ref.owner === info.className) own.add(ref.name)
    else registries.add(ref.owner)
  })
  return { registries, own, any: registries.size + own.size > 0 }
}

// HF16-R2 — OWN-REGISTRY POPULATION (the queue-deferred registration idiom):
// the entry's class initializer runs first (the collections and the
// object INSTANCE exist), then every production site — a method anywhere
// in the jars that reads one of the fields (directly, or through a
// straight-line getter of the entry class) AND calls a collection mutator —
// runs under its resolved CALLER CONTEXTS (the aggregator's context climb:
// interface dispatch through the services file, subclass-qualified
// callers, `new Packet()` at the initializer), falling back to provenance
// locals when no caller is found (the deep walk then records an id-less
// registration that abstains loudly, never a silent zero). Bounded by the
// site cap, the context cap and the shared step budgets.
const COLLECTION_MUTATORS = new Set(['add', 'addAll', 'addFirst', 'addLast', 'offer', 'push', 'put', 'putAll', 'putIfAbsent', 'set', 'plusAssign'])

function populateOwnRegistries (index, state, info, fieldNames, entryMethod) {
  const cls = info.className
  const key = `ownreg:${cls}`
  if (state.aggCache.has(key)) return
  state.aggCache.set(key, true)
  // straight-line getters of the registry fields: `getstatic f; areturn`
  const getters = new Map()
  for (const m of info.codes) {
    if (m.code && m.code.length === 4 && m.code[0] === 0xb2 && m.code[3] === 0xb0) {
      const ref = cpRef(info.cp, m.code.readUInt16BE(1))
      if (ref && ref.owner === cls && fieldNames.has(ref.name)) getters.set(`${m.method}${m.desc}`, ref.name)
    }
  }
  const simple = cls.split('/').pop()
  const producers = []
  let capped = false
  for (const name of state.allClassNames) {
    const bytes = index.rawBytes(name)
    if (!bytes || !bytes.includes(simple)) continue
    const pinfo = index.get(name)
    if (!pinfo) continue
    for (const m of pinfo.codes) {
      if (name === cls && (m.method === '<clinit>' || (m.method === entryMethod.method && m.desc === entryMethod.desc))) continue
      let reads = false
      let mutates = false
      walkLinear(m.code, pinfo.cp, (op, pc, cp, code) => {
        if (op === 0xb2) {
          const ref = cpRef(cp, code.readUInt16BE(pc + 1))
          if (ref && ref.owner === cls && fieldNames.has(ref.name)) reads = true
        } else if (op >= 0xb6 && op <= 0xb9) {
          const ref = cpRef(cp, code.readUInt16BE(pc + 1))
          if (!ref) return
          if (ref.owner === cls && getters.has(`${ref.name}${ref.desc}`)) reads = true
          else if (COLLECTION_MUTATORS.has(ref.name)) mutates = true
        }
      })
      if (reads && mutates) producers.push({ info: pinfo, m })
      if (producers.length > AGG_MAX_POPULATION_SITES) { capped = true; break }
    }
    if (capped) break
  }
  if (capped) state.diagnostics.abstains.push(`${cls}: more than ${AGG_MAX_POPULATION_SITES} population sites for its static registries — the remainder's channels unclaimed`)
  // Phase 1 — caller contexts of every production site (the climb runs the
  // sites themselves under provenance locals as a side effect, which would
  // queue a packet-less lambda that can only abstain). Phase 2 — the entry
  // class initializer, AFTER the climb, so the registries the deep walk
  // reads are fresh and hold exactly what phase 3 queues under bindings.
  const contexts = producers.map(({ info: pinfo, m }) => m.method === '<clinit>' ? { contexts: [] } : resolveCallContexts(index, state, { cls: pinfo.className, name: m.method, desc: m.desc }, 0))
  const clinit = info.codes.find((c) => c.method === '<clinit>')
  if (clinit) evaluateMethod(index, info, clinit, state, { locals: [], recordPutstatic: true }, {})
  const prevInlineAll = state.aggInlineAll
  state.aggInlineAll = true
  try {
    for (let i = 0; i < producers.length; i++) {
      const { info: pinfo, m } = producers[i]
      if (state.aggBudgetBlown) break
      const isStatic = (m.flags & 0x0008) !== 0
      const ctx = contexts[i]
      const bindings = ctx.contexts.slice(0, AGG_MAX_CONTEXTS).map((c) => isStatic ? seedArgLocals(m.desc, c.args || []) : seedArgLocals(m.desc, c.args || [], c.recv ?? UNKNOWN))
      if (bindings.length === 0) bindings.push(seedProvenanceLocals(m.desc, isStatic, pinfo.className))
      for (const locals of bindings) {
        if (state.aggBudgetBlown) break
        evaluateMethod(index, pinfo, m, state, { locals, recordPutstatic: false }, {})
      }
      if (process.env.MINEPAL_AGG_DEBUG) debug(`ownreg ${cls}: producer ${pinfo.className}.${m.method} run under ${bindings.length} binding(s)`)
    }
  } finally {
    state.aggInlineAll = prevInlineAll
  }
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
    const bindings = []
    let partial = false
    let instances = []
    if (!isStatic && reg.methodCtx.name !== '<init>') {
      // instance site: candidates are the aggregator instances the jars
      // themselves construct AND populate (the focus pass — per-instance
      // versions and per-instance collection contents by object identity)
      instances = collectFocusInstances(index, state, reg.methodCtx.cls)
      if (instances.length === 0 || instances.truncated) partial = true
    }
    const callCtx = resolveCallContexts(index, state, { cls: reg.methodCtx.cls, name: reg.methodCtx.name, desc: reg.methodCtx.desc }, 0)
    partial = partial || callCtx.partial
    // HF37 HOLDER shape (ldtteam PlayMessageType, javap-verified): the
    // registration object is built by a static FACTORY (modId, name) into a
    // static HOLDER field of the payload class (`TYPE = forServer("ns",
    // "name", ..)`), and the entry registers it through the holder
    // (`getstatic X.TYPE; invokevirtual register(registrar)`). The instance's
    // ctor-bound facts (its Type) live on the focus-pass object the holder
    // now holds; the registrar (its version) lives at the call site. A call
    // context whose receiver is that static holder binds to the held object,
    // so both facts meet in ONE evaluation. Fully-bound contexts go first;
    // an instance no context reached still gets an instance-only binding
    // (registrar unbound — its version then rides mods.toml or abstains).
    const boundRecvs = new Set()
    for (const c of callCtx.contexts) {
      let recv = c.recv
      if (recv && recv.k === 'field') {
        const held = state.fieldValues[staticFieldKey(index, recv)] ?? state.fieldValues[`${recv.owner}.${recv.name}`]
        if (held && held.k === 'obj') recv = held
      }
      if (recv && recv.k === 'obj') boundRecvs.add(recv)
      bindings.push({ recv, args: c.args })
    }
    for (const inst of instances) if (!boundRecvs.has(inst)) bindings.push({ recv: inst, args: null })
    if (bindings.length > AGG_MAX_CONTEXTS) partial = true
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
            versionFrom: r.registrar ? (r.registrar.versionFrom || null) : null,
            versioned: r.registrar ? !!r.registrar.versioned : false,
            versionFromParam: r.registrar ? !!r.registrar.versionFromParam : false,
            namespace: r.registrar ? r.registrar.namespace : null,
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
// ---------- HF43: MOD-PRESENCE GATES ----------
//
// SHAPE (sophisticatedcore 1.5.0 / 26.1.2, rig-proven): a compat table
//   CompatRegistry.registerCompat(new CompatInfo("create"), () -> CreateCompat::new)
// whose loader only instantiates the compat class when CompatInfo.isLoaded()
// (= ModList.getModContainerById(modId).isPresent()) says the keyed mod is
// loaded; CreateCompat then registers three REQUIRED play channels. The
// server registers them only with Create installed, so a client claiming
// them on a Create-less pack fails the negotiation ("missing.client.server")
// exactly as an unclaimed required channel would the other way round.
//
// MECHANISM (data-driven, no mod names): (1) PRESENCE-KEY HOLDERS are
// in-index classes constructed with a String whose own methods invoke a
// loader mod-presence probe (ModList.isLoaded / getModContainerById /
// getModFileById, Forge or NeoForge spelling). (2) A GATE is a call that
// carries such a holder (keyed by a constant string) NEXT TO a lambda /
// method reference; the classes that lambda constructs (transitively,
// bounded) are gated on that key. (3) An instance-hosted entry method whose
// class is ONLY ever constructed under a gate is claimed iff the key names a
// mod in the jar census (mods.toml ids of every scanned jar, nested jars
// included); otherwise its channels are left unclaimed with a NAMED abstain.
// A class also constructed anywhere outside a gate is not gated (claimed as
// before). Receipted in diagnostics.presenceGates for both outcomes.
const PRESENCE_PROBE_OWNERS = new Set([
  'net/neoforged/fml/ModList', 'net/neoforged/fml/loading/LoadingModList', 'net/neoforged/fml/loading/FMLLoader',
  'net/minecraftforge/fml/ModList', 'net/minecraftforge/fml/loading/LoadingModList', 'net/minecraftforge/fml/loading/FMLLoader'
])
const PRESENCE_PROBE_METHODS = new Set(['isLoaded', 'getModContainerById', 'getModFileById'])
const GATE_LAMBDA_DEPTH = 4
const ALWAYS_PRESENT_MOD_IDS = new Set(['minecraft', 'neoforge', 'forge'])

function presenceProbeOf (info) {
  let found = null
  for (const m of info.codes) {
    if (found) break
    walkLinear(m.code, info.cp, (op, pc, cp, code) => {
      if (found) return
      if (op === 0xb6 || op === 0xb8 || op === 0xb9) {
        const ref = cpRef(cp, code.readUInt16BE(pc + 1))
        if (ref && PRESENCE_PROBE_OWNERS.has(ref.owner) && PRESENCE_PROBE_METHODS.has(ref.name)) found = `${m.method} -> ${ref.owner.split('/').pop()}.${ref.name}`
      }
    })
  }
  return found
}

function lambdaConstructs (index, impl, depth, out, seen) {
  if (!impl || depth > GATE_LAMBDA_DEPTH) return
  if (impl.refKind === 8) { if (index.get(impl.owner)) out.add(impl.owner); return } // C::new
  const key = `${impl.owner}.${impl.name}${impl.desc}`
  if (seen.has(key)) return
  seen.add(key)
  const info = index.get(impl.owner)
  const m = info && info.codes.find((c) => c.method === impl.name && c.desc === impl.desc)
  if (!m) return
  walkLinear(m.code, info.cp, (op, pc, cp, code) => {
    if (op === 0xbb) {
      const cls = cpClassName(cp, code.readUInt16BE(pc + 1))
      if (cls && index.get(cls)) out.add(cls)
    } else if (op === 0xba) {
      const c = cp[code.readUInt16BE(pc + 1)]
      const inner = (c && info.bootstrapMethods) ? resolveLambdaImpl(info, c.bsmIndex) : null
      if (inner && inner.refKind >= 5 && inner.refKind <= 9) lambdaConstructs(index, inner, depth + 1, out, seen)
    } else if (op === 0xb8) {
      const ref = cpRef(cp, code.readUInt16BE(pc + 1))
      if (ref && index.get(ref.owner)) lambdaConstructs(index, { ...ref, refKind: 6 }, depth + 1, out, seen)
    }
  })
}

function deriveModPresenceGates (index, state) {
  const holders = new Map()
  for (const name of state.allClassNames) {
    const bytes = index.rawBytes(name)
    if (!bytes) continue
    let mentions = false
    for (const o of PRESENCE_PROBE_OWNERS) if (bytes.includes(o)) { mentions = true; break }
    if (!mentions) continue
    const info = index.get(name)
    if (!info) continue
    if (!info.codes.some((c) => c.method === '<init>' && c.desc.startsWith('(Ljava/lang/String;'))) continue
    const probe = presenceProbeOf(info)
    if (probe) holders.set(name, probe)
  }
  const gates = new Map()
  if (holders.size === 0) return gates
  const walkedLambdas = new Set()
  for (const name of state.allClassNames) {
    const bytes = index.rawBytes(name)
    if (!bytes) continue
    let hit = null
    for (const h of holders.keys()) if (bytes.includes(h)) { hit = h; break }
    if (!hit) continue
    const info = index.get(name)
    if (!info) continue
    for (const m of info.codes) {
      const locals = seedProvenanceLocals(m.desc, (m.flags & 0x0008) !== 0, info.className)
      simulate(index, info, m, state, {
        locals,
        onInvoke: (call) => {
          const keyed = call.argVals.find((a) => a && a.k === 'obj' && holders.has(a.cls) && a.ctorArgs && a.ctorArgs[0] && a.ctorArgs[0].k === 'str')
          const lambdas = call.argVals.filter((a) => a && a.k === 'lambda')
          if (!keyed || lambdas.length === 0) return
          const constructed = new Set()
          for (const lam of lambdas) lambdaConstructs(index, lam.impl, 0, constructed, walkedLambdas)
          for (const cls of constructed) {
            if (holders.has(cls) || gates.has(cls)) continue
            gates.set(cls, { modId: a0(keyed), holder: keyed.cls, probe: holders.get(keyed.cls), site: `${info.className}.${m.method}` })
          }
        }
      })
    }
  }
  // a gated class ALSO constructed outside any walked lambda body is not
  // gated — the plain construction registers regardless of the key.
  if (gates.size > 0) {
    for (const name of state.allClassNames) {
      const bytes = index.rawBytes(name)
      if (!bytes) continue
      const gatedHere = [...gates.keys()].filter((g) => bytes.includes(g))
      if (gatedHere.length === 0) continue
      const info = index.get(name)
      if (!info) continue
      for (const m of info.codes) {
        if (walkedLambdas.has(`${info.className}.${m.method}${m.desc}`)) continue
        walkLinear(m.code, info.cp, (op, pc, cp, code) => {
          if (op !== 0xbb) return
          const cls = cpClassName(cp, code.readUInt16BE(pc + 1))
          if (cls && gates.has(cls) && cls !== info.className) gates.delete(cls)
        })
      }
    }
  }
  return gates
  function a0 (obj) { return obj.ctorArgs[0].v }
}

// HF43-r MOD-ROOT WALK (mechanism, javap-verified on PuzzlesLib 26.1.14 +
// MutantMonsters 26.1.3 and ResourcefulLib 4.0.1 + FriendsAndFoes 4.0.27):
// two id families are only readable in the loader's own order — a
// registry-COUNTER id ("<ns>:main" + "/" + AtomicInteger.getAndIncrement(),
// one per registration in class-init order) and a version-prefixed id
// ("<ns>:<path>/v<N>" + "/" + the packet's own namespace/path or class name,
// the "v<N>" registrar version built from an int constant). Both are born in
// a @Mod constructor's call chain and registered when the loader fires
// RegisterPayloadHandlersEvent at the listener that chain registered on the
// mod bus. So: (A) every @Mod constructor runs under the evaluator (static
// initializers on first read, services files, lambdas, Optional), collecting
// the event-typed listeners it hands the bus; (B) each listener is fired
// once with the event, in registration order, and its registrations are
// recorded with the values the chain proved. A counter advanced from more
// than one root/listener has no provable order — its ids are refused BY
// NAME. Own step budget; per-root / per-listener isolation; nothing here
// classloads or executes jar code.
function deriveModRootRegistrations (index, state, record) {
  const diagnostics = state.diagnostics
  const summary = { roots: 0, listeners: 0, registrations: 0, resolvedIds: 0, unresolvedIds: 0, droppedUnprovenOrder: 0, budgetExhausted: false, listenerSites: [], rows: [], steps: 0, unitBudget: MOD_ROOT_UNIT_STEP_BUDGET, totalBudget: MOD_ROOT_TOTAL_STEP_BUDGET, exhaustedUnits: [] }
  diagnostics.modRoot = summary
  const roots = []
  for (const name of state.allClassNames) {
    const bytes = index.rawBytes(name)
    if (!bytes || !bytes.includes('/Mod;')) continue
    const info = index.get(name)
    if (!info || !Array.isArray(info.annotations)) continue
    const ann = info.annotations.find((a) => a && isModEntryAnnotation(a.type))
    if (!ann) continue
    roots.push({ info, modId: (ann.elements && typeof ann.elements.value === 'string') ? ann.elements.value : name })
  }
  roots.sort((a, b) => (a.modId < b.modId ? -1 : a.modId > b.modId ? 1 : (a.info.className < b.info.className ? -1 : 1)))
  summary.roots = roots.length
  if (roots.length === 0) return []
  const savedSteps = state.aggSteps || 0
  const prev = { pass: state.modRootPass, lazy: state.lazyClinit, inlineAll: state.aggInlineAll, limit: state.aggStepLimit, root: state.currentRoot, stack: state.rootStack }
  state.modRootPass = true
  state.lazyClinit = true
  state.aggInlineAll = true
  state.aggSteps = 0
  state.aggStepLimit = MOD_ROOT_STEP_BUDGET
  state.rootStack = []
  state.rootHooks = null
  state.modRootResolved = state.modRootResolved || new Set()
  const listeners = []
  const seenListeners = new Set()
  const rows = []
  const trace = process.env.MINEPAL_MODROOT_TRACE ? (ref, kind, recv, argVals) => debug(`mr-call ${state.currentRoot} ${ref.owner}.${ref.name}${ref.desc.slice(0, 60)} recv=${recv ? recv.k + (recv.cls ? ':' + recv.cls : '') : '-'} args=${argVals.map((a) => a ? a.k + ((a.k === 'str' || a.k === 'resloc' || a.k === 'int' || a.k === 'cls') ? ':' + a.v : a.k === 'obj' ? ':' + a.cls : a.k === 'lambda' ? ':' + a.impl.owner.split('/').pop() + '.' + a.impl.name : '') : '?').join(',')}`) : null
  const listenerHooks = {
    onCall: (ref, kind, recv, argVals) => {
      if (trace) trace(ref, kind, recv, argVals)
      if (!LISTENER_REGISTRATION_METHODS.has(ref.name) || index.get(ref.owner)) return // the loader's bus API lives outside the jars
      // HF51: `bus.register(object)` / `bus.register(Class)` subscribe every
      // @SubscribeEvent method of that object (instance) or class (static)
      // whose one parameter is a lifecycle event — a registration OBJECT
      // created per mod by a library and handed to the mod's own bus.
      if (ref.name === 'register' && argVals.length === 1 && argVals[0] && (argVals[0].k === 'obj' || argVals[0].k === 'cls')) {
        const sub = argVals[0]
        const cls = sub.k === 'obj' ? sub.cls : sub.v
        const info = index.get(cls)
        const raw = info ? index.rawBytes(cls) : null
        if (!info || !raw || !raw.includes('SubscribeEvent')) return
        for (const m of info.codes) {
          const isStatic = (m.flags & 0x0008) !== 0
          if (isStatic !== (sub.k === 'cls')) continue
          const pm = String(m.desc).match(/^\(L([^;]+);\)V$/)
          if (!pm) continue
          const phase = LIFECYCLE_PHASES.indexOf(pm[1])
          if (phase < 0) continue
          const lam = { impl: { owner: cls, name: m.method, desc: m.desc, refKind: isStatic ? 6 : 5 }, captured: isStatic ? [] : [sub] }
          const key = `${cls}.${m.method}${m.desc}#${isStatic ? 'static' : `obj:${keyIdOf(sub)}`}`
          if (seenListeners.has(key) || listeners.length >= MOD_ROOT_MAX_LISTENERS) continue
          seenListeners.add(key)
          listeners.push({ lam, root: state.currentRoot, phase, order: listeners.length, subscriber: true })
        }
        return
      }
      for (const a of argVals) {
        if (!a || a.k !== 'lambda') continue
        const phase = LIFECYCLE_PHASES.findIndex((ev) => String(a.impl.desc).includes(`L${ev};`))
        if (phase < 0) continue
        const key = `${a.impl.owner}.${a.impl.name}${a.impl.desc}#${a.captured.map((c) => (c && c.k === 'obj') ? `obj:${c.cls}` : JSON.stringify(c)).join(',')}`
        if (seenListeners.has(key) || listeners.length >= MOD_ROOT_MAX_LISTENERS) continue
        seenListeners.add(key)
        listeners.push({ lam: a, root: state.currentRoot, phase, order: listeners.length })
      }
    }
  }
  // HF51 (A3): one budget per unit; the total is a hard cap. Returns false
  // when the total is spent (the caller stops and abstains by name).
  const beginUnit = () => {
    state.aggSteps = 0
    state.aggBudgetBlown = false
    state.aggStepLimit = Math.max(0, Math.min(MOD_ROOT_UNIT_STEP_BUDGET, MOD_ROOT_TOTAL_STEP_BUDGET - summary.steps))
    return state.aggStepLimit > 0
  }
  const endUnit = (what) => {
    summary.steps += state.aggSteps || 0
    if (!state.aggBudgetBlown) return
    summary.exhaustedUnits.push(what)
    diagnostics.abstains.push(`mod-root walk: ${what} exhausted its ${MOD_ROOT_UNIT_STEP_BUDGET}-step budget — registrations past that point are not derived here (the entry passes still run)`)
    state.aggBudgetBlown = false
  }
  let totalSpent = false
  try {
    state.rootHooks = listenerHooks // static initializers run on first touch register listeners too
    for (const { info, modId } of roots) {
      if (!beginUnit()) { totalSpent = true; break }
      state.currentRoot = `root:${modId}`
      state.activeModId = modId // HF51: ModLoadingContext.get().getActiveNamespace() while this root loads
      try {
        lazyClassInit(index, state, info.className)
        for (const m of info.codes) {
          if (m.method !== '<init>') continue
          const locals = seedProvenanceLocals(m.desc, false, info.className)
          evaluateMethod(index, info, m, state, { locals, recordPutstatic: true }, listenerHooks)
        }
      } catch (err) {
        diagnostics.errors.push(`mod-root walk of ${info.className} failed (${err.message})`)
      }
      endUnit(`the constructor of ${modId} (${info.className})`)
    }
    listeners.sort((a, b) => (a.phase - b.phase) || (a.order - b.order))
    summary.listeners = listeners.length
    summary.phases = LIFECYCLE_PHASES.map((ev, i) => ({ event: ev.split('/').pop(), listeners: listeners.filter((l) => l.phase === i).length }))
    for (let i = 0; i < listeners.length; i++) {
      if (totalSpent || !beginUnit()) { totalSpent = true; break }
      const { lam, root } = listeners[i]
      state.currentRoot = `listener:${i}:${lam.impl.owner}.${lam.impl.name}`
      state.activeModId = typeof root === 'string' && root.startsWith('root:') ? root.slice(5) : null
      const site = `${lam.impl.owner}.${lam.impl.name}`
      const opts = {
        onRegistration: (r) => {
          if (trace) debug(`mr-reg ${state.currentRoot} ${r.method} id=${r.id} version=${r.registrar && r.registrar.version} site=${r.site}`)
          summary.registrations++
          if (!r.id) { summary.unresolvedIds++; rows.push({ ...r, site: `${r.site} (mod-root ${root} -> ${site})`, root, listenerSite: site, unresolved: true }); return }
          summary.resolvedIds++
          resolvedHere = true
          rows.push({ ...r, site: `${r.site} (mod-root ${root} -> ${site})`, root, listenerSite: site })
        }
      }
      let resolvedHere = false
      state.rootVisited = new Set([`${lam.impl.owner}.${lam.impl.name}${lam.impl.desc}`])
      try {
        state.rootStack.length = 0
        invokeLambda(index, state, opts, lam, [{ k: 'param', i: 0 }], () => {}, trace ? { onCall: trace } : {})
      } catch (err) {
        diagnostics.errors.push(`mod-root listener ${site} failed (${err.message})`)
      }
      // every method the listener's chain executed on the way to a proven
      // registration is part of the machinery that claimed it
      if (resolvedHere) for (const k of state.rootVisited) state.modRootResolved.add(k)
      state.rootVisited = null
      summary.listenerSites.push(site)
      endUnit(`listener ${site} (${root})`)
    }
    if (totalSpent) {
      summary.budgetExhausted = true
      diagnostics.abstains.push(`mod-root walk: the total step budget (${MOD_ROOT_TOTAL_STEP_BUDGET}) ran out after ${summary.listenerSites.length} of ${summary.listeners} listener(s) — registrations past that point are not derived here (the entry passes still run)`)
    }
  } finally {
    state.aggBudgetBlown = false
    state.aggSteps = savedSteps
    state.modRootPass = prev.pass
    state.lazyClinit = prev.lazy
    state.aggInlineAll = prev.inlineAll
    state.aggStepLimit = prev.limit
    state.currentRoot = prev.root
    state.rootStack = prev.stack
    state.rootHooks = null
    state.activeModId = null
  }
  // the order law: an id built from a counter that more than one root or
  // listener advanced is refused by name
  const dropped = new Map()
  const kept = []
  for (const r of rows) {
    if (r.unresolved) continue
    const h = r.counter
    if (h && h.mutated && h.touches.size > 1) {
      const key = `${r.listenerSite}|${h.cls}.${h.field}`
      if (!dropped.has(key)) dropped.set(key, { site: r.listenerSite, holder: h, ids: [] })
      dropped.get(key).ids.push(r.id)
      summary.droppedUnprovenOrder++
      continue
    }
    kept.push(r)
  }
  for (const d of dropped.values()) {
    diagnostics.abstains.push(`${d.site}: registry-counter ids (${d.ids.join(', ')}) whose counter ${d.holder.cls.split('/').pop()}.${d.holder.field} is advanced by ${d.holder.touches.size} independent listeners/roots — the registration order is not provable, unclaimed`)
  }
  const unresolvedSites = new Set(rows.filter((r) => r.unresolved).map((r) => `${r.site.split(' (mod-root')[0]}.${r.method} (via ${r.listenerSite})`))
  for (const site of unresolvedSites) {
    diagnostics.abstains.push(`${site}: the mod-root walk reached this registration without a provable id (a runtime class reference, an unreadable counter or an unresolved string) — unclaimed`)
  }
  for (const r of kept) {
    record(r)
    if (summary.rows.length < 400) summary.rows.push({ id: r.id, version: r.registrar ? r.registrar.version : null, flow: (REGISTRATION_METHODS[r.method] || {}).flow, family: r.counter ? 'counter' : 'chain', root: r.root, listener: r.listenerSite, jar: r.jar && r.jar.label ? r.jar.label : undefined })
  }
  return kept
}

function deriveNeoForgeComponents (jarPaths) {
  const started = Date.now()
  const index = makeClassIndex()
  const diagnostics = { jars: [], abstains: [], errors: [], registrations: 0, presenceGates: [] }
  for (const p of jarPaths) collectJarClasses(p, index, diagnostics, path.basename(p))

  const versionByModId = Object.create(null)
  for (const j of diagnostics.jars) for (const id of j.modIds || []) if (j.modVersion && !versionByModId[id]) versionByModId[id] = j.modVersion
  // HF37: a runtime-versioned registrar falls back to the mods.toml version of
  // the mod the registrar NAMESPACE names (its own jar), then the site's jar.
  const metaVersionFor = (namespace, jar) => (namespace && versionByModId[namespace]) || (jar && jar.modVersion) || null
  const state = {
    versionByModId,
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
  const silentEntries = []
  const presenceGates = deriveModPresenceGates(index, state)
  const modRootStart = registrations.length
  const censusHas = (modId) => ALWAYS_PRESENT_MOD_IDS.has(modId) || diagnostics.jars.some((j) => (j.modIds || []).includes(modId))
  const record = (reg) => {
    const spec = REGISTRATION_METHODS[reg.method]
    if (process.env.MINEPAL_AGG_DEBUG) debug(`record ${reg.method} id=${reg.id} idVal=${JSON.stringify(reg.idVal).slice(0, 160)} site=${reg.site} version=${reg.registrar && reg.registrar.version}`)
    if (!spec) return
    registrations.push({ ...reg, ...spec })
  }
  try {
    deriveModRootRegistrations(index, state, record)
  } catch (err) {
    diagnostics.errors.push(`mod-root walk failed (${err.message})`)
  }
  diagnostics.registrations = registrations.length - modRootStart
  for (const { info, method } of entryMethods) {
    // HF11: locals seeded with PROVENANCE tags instead of bare unknowns (the
    // receiver as {k:'this'}, each argument as {k:'param', i}) — same null
    // results everywhere a value stays unresolved, but an abstained
    // registration now records WHERE its id would have come from, which is
    // what the aggregation pass binds candidates to. The event/registrar
    // values are still produced by the interpreter when registrar() is
    // invoked on the event argument.
    const gate = (method.flags & 0x0008) === 0 ? presenceGates.get(info.className) : null
    if (gate) {
      const present = censusHas(gate.modId)
      diagnostics.presenceGates.push({ site: `${info.className}.${method.method}`, modId: gate.modId, present, holder: gate.holder, probe: gate.probe, gateSite: gate.site })
      if (!present) {
        diagnostics.abstains.push(`${info.className}.${method.method}: registrations gated on mod presence — ${gate.site} keys ${gate.holder.split('/').pop()}("${gate.modId}") whose ${gate.probe} decides construction, and "${gate.modId}" is not in the jar census (${diagnostics.jars.length} jars) — this entry's channels unclaimed (the server registers them only with that mod loaded)`)
        continue
      }
    }
    const locals = seedProvenanceLocals(method.desc, (method.flags & 0x0008) !== 0, info.className)
    let reached = 0
    let reachedWithId = 0
    const abstainStart = diagnostics.abstains.length
    const regStart = registrations.length
    simulate(index, info, method, state, { onRegistration: (r) => { reached++; if (r.id) reachedWithId++; record(r) }, recordPutstatic: false, locals })
    // HF16-R2: the linear walk's abstains for an entry the deep pass takes
    // over are held back and published only if the deep pass fails too — a
    // "too many overrides" line next to the very channels it names as
    // claimed is false awareness. An entry that reached only ID-LESS
    // registrations through a scanned-subclass guess while reading a static
    // collection is walked deep as well (the collection's populated
    // elements are the truth the guess lacked).
    if (reached === 0) {
      silentEntries.push({ info, method, linearAbstains: diagnostics.abstains.splice(abstainStart) })
    } else if (reachedWithId === 0 && entryRegistries(index, info, method).any) {
      silentEntries.push({ info, method, soft: true, linearAbstains: diagnostics.abstains.splice(abstainStart), linearRegs: registrations.slice(regStart) })
    }
  }
  // HF37 SILENT-ENTRY deep pass (mechanism, javap-verified on framework
  // 0.13.11 + createcolonies 2.0.6): an entry whose registrar never reaches
  // a registrar call under the linear walk (registrations mediated by a
  // static registry of network objects, lambdas, forEach, method references)
  // is walked again under the branch-following evaluator: every static
  // registry the entry reads is first POPULATED from its jar-wide
  // population sites (the focus pass), then lambdas run, collections walk
  // and method references onto the registrar register. An entry that still
  // yields nothing is reported — never a silent zero.
  // HF16-R2 (queue-deferred registration, javap-verified on a Kotlin pack):
  // the registry the entry iterates may live on the entry's OWN class
  // (`object Events { val queue = ArrayList<(PayloadRegistrar) -> Unit>() }`),
  // populated from OTHER classes through its getter with lambda VALUES
  // (invokedynamic / a Lambda subclass) whose captured packet is the
  // producer's PARAMETER. Such a registry is populated from its production
  // sites run under THEIR resolved caller contexts (populateOwnRegistries),
  // so every queued lambda captures a concrete packet object and the deep
  // walk registers each with a jar-proven id; the queue's Function1.invoke /
  // Consumer.accept on the lambda value runs its body with the registrar
  // bound (the evaluator's lambda law).
  for (const entry of silentEntries) {
    const { info, method } = entry
    // HF43-r: an entry the mod-root walk ran to a proven registration (it is
    // on the chain a listener's registrations came through) is resolved —
    // no deep re-walk, no "never reaches" line against claimed channels.
    if (state.modRootResolved && state.modRootResolved.has(`${info.className}.${method.method}${method.desc}`)) continue
    // a lambda body's enclosing entry reports for it — when there IS one: a
    // listener lambda registered from a plain `init(IEventBus)` (the
    // STATIC-REGISTRAR shape: geckolib's `bus.addListener(this::onRegister)`)
    // has no enclosing entry and is walked on its own (HF16-R2 rider; before,
    // such a class derived ZERO with ZERO abstains — and the server CRASHED
    // sending its unguarded optional payload to the unclaimed client).
    if (method.method.startsWith('lambda$') && entryMethods.some((e) => e.info === info && !e.method.method.startsWith('lambda$'))) {
      diagnostics.abstains.push(...entry.linearAbstains)
      continue
    }
    const before = registrations.length
    const { registries, own } = entryRegistries(index, info, method)
    state.aggCache = state.aggCache || new Map()
    for (const owner of registries) {
      if (state.aggBudgetBlown) break
      collectFocusInstances(index, state, owner)
    }
    if (own.size > 0 && !state.aggBudgetBlown) {
      try {
        populateOwnRegistries(index, state, info, own, method)
      } catch (err) {
        diagnostics.errors.push(`population of ${info.className} static registries failed (${err.message})`)
      }
    }
    const prevInlineAll = state.aggInlineAll
    state.aggInlineAll = true
    try {
      const locals = seedProvenanceLocals(method.desc, (method.flags & 0x0008) !== 0, info.className)
      evaluateMethod(index, info, method, state, { locals, recordPutstatic: false, onRegistration: (r) => record({ ...r, site: `${r.site} (deep walk from ${info.className}.${method.method})` }) }, {})
    } catch (err) {
      diagnostics.errors.push(`deep walk of ${info.className}.${method.method} failed (${err.message})`)
    } finally {
      state.aggInlineAll = prevInlineAll
    }
    const resolvedDeep = registrations.slice(before).some((r) => r.id)
    if (resolvedDeep && entry.linearRegs) {
      // the deep walk proved the ids the linear guess could not: the guess's
      // id-less rows would only abstain against the same channels downstream
      for (const r of entry.linearRegs) {
        const at = registrations.indexOf(r)
        if (at >= 0 && !r.id) registrations.splice(at, 1)
      }
    }
    if (!resolvedDeep) diagnostics.abstains.push(...entry.linearAbstains)
    if (registrations.length === before && !entry.soft) {
      diagnostics.abstains.push(`${info.className}.${method.method}: the registrar never reaches a registration (deep walk incl. ${registries.size + own.size} static registr${registries.size + own.size === 1 ? 'y' : 'ies'}) — no channel claimed from this entry`)
    }
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
  const add = (id, version, flow, optional, protocols, source, versionSource, versionFrom = null) => {
    for (const proto of protocols) {
      if (!byProtocol[proto]) continue
      if (droppedConflicts.has(`${proto}:${id}`)) continue
      const prev = byProtocol[proto].get(id)
      if (!prev) {
        byProtocol[proto].set(id, { id, version, flow, optional, source, versionSource, versionFrom })
        continue
      }
      const prevConst = CONSTANT_VERSION_SOURCES.has(prev.versionSource)
      const newConst = CONSTANT_VERSION_SOURCES.has(versionSource)
      if (newConst && !prevConst) {
        byProtocol[proto].set(id, { id, version, flow, optional, source, versionSource, versionFrom })
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
    let versionFrom = reg.registrar ? (reg.registrar.versionFrom || null) : null // HF51: the receipt names where the version came from
    const optional = reg.registrar ? reg.registrar.optional : false
    if (!reg.id) {
      // HF11: don't abstain yet — the AGGREGATOR pass may resolve this site
      // from its jar-wide population contexts. Unresolved leftovers abstain
      // below with the registrar's own optionality in the copy.
      pendingAgg.push(reg)
      continue
    }
    if (version === null) {
      const metaVersion = metaVersionFor(reg.registrar && reg.registrar.namespace, reg.jar)
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
        versionFrom = fallbackReceiptOf(reg.registrar)
      } else {
        diagnostics.abstains.push(`${reg.id}: required channel with no derivable version — join will be refused by the server`)
        listenOnlyNamed.push(reg.id)
        continue
      }
    }
    add(reg.id, version, reg.flow, optional, reg.protocols, reg.site, versionSource, versionFrom)
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
    let versionFrom = row.versionFrom || null
    if (version === null) {
      const metaVersion = metaVersionFor(row.namespace, row.jar)
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
        versionFrom = fallbackReceiptOf(row)
      } else {
        diagnostics.abstains.push(`${row.id}: aggregated required channel with no derivable version — join will be refused by the server`)
        listenOnlyNamed.push(row.id)
        continue
      }
    }
    add(row.id, version, row.flow, row.optional, row.protocols, row.source, versionSource, versionFrom)
  }
  const abstainedSiteKeys = new Set()
  for (const reg of pendingAgg) {
    const sk = reg.methodCtx ? `${reg.methodCtx.cls}.${reg.methodCtx.name}${reg.methodCtx.desc}` : reg.site
    if (agg.resolvedSites.has(sk) && !agg.partialSites.has(sk)) continue
    // HF51: a site the mod-root walk resolved (its registration object
    // iterated with the real elements) is derived, not abstained — the entry
    // pass met it with an empty registration object
    if (state.modRootResolved && state.modRootResolved.has(sk)) { (diagnostics.modRootCovered = diagnostics.modRootCovered || []).push(sk); continue }
    if (abstainedSiteKeys.has(`${sk}#${reg.method}`)) continue
    abstainedSiteKeys.add(`${sk}#${reg.method}`)
    const opt = reg.registrar && reg.registrar.optional && !reg.registrar.optionalUndecided
    const undecided = reg.registrar && reg.registrar.optional && reg.registrar.optionalUndecided
    const partially = agg.resolvedSites.has(sk) ? ' (partially aggregated — remainder unresolved)' : ''
    diagnostics.abstains.push(opt
      ? `${reg.site}: ${reg.method} optional registration with unresolved payload type id — safely unclaimed${partially}`
      : undecided
        ? `${reg.site}: ${reg.method} with unresolved payload type id — unresolved-required (its .optional() sits under a condition this walk could not decide, so it is NOT safely unclaimed; the server names it in its refusal)${partially}`
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
