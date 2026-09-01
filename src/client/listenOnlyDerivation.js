'use strict'

// HF15 — LISTEN-ONLY channel derivation (the send-permission surface).
//
// WHY THIS EXISTS (the HF15 receipt, rig-reproduced 3/3 on the field
// instance): NeoForge's outbound send guard (NetworkRegistry.checkPacket,
// 21.1.249 bytecode: passes iff payload ∈ BUILTIN_PAYLOADS ∨ namespace ==
// "minecraft" ∨ hasChannel(listener, id), where hasChannel = negotiated
// payload-setup channels ∨ common channels ∨ AD-HOC channels) throws
// UnsupportedOperationException("Payload %s may not be sent to the client!")
// for any server-side mod send outside those tiers. A mod that sends
// UNCONDITIONALLY at placement time (PlayerEvent.PlayerLoggedInEvent — fired
// inside PlayerList.placeNewPlayer) aborts the placement itself: the server
// disconnects "Invalid player data" and the client sees only a raw socket
// close. The negotiated CLAIM tier requires version truth (String.equals) —
// but the AD-HOC tier is version-free by primary source
// (DinnerboneProtocolUtils.CHANNELS_CODEC: NUL-separated ids, no versions;
// NetworkRegistry.onMinecraftRegister addAll's them unconditionally). So a
// channel whose ID is derivable but whose VERSION is not can still be
// truthfully DECLARED as listen-only: the declaration is a statement about
// what THIS CLIENT tolerates receiving, never a claim about any mod version.
// Over-declaring listen-only is truthful; the wire cost is bytes.
//
// Three jar-derived tiers (nothing invented — every id is a fact of the
// pack's own bytecode; a nameable id without a version is exactly a
// listen-only row, never a versioned claim):
//   (a) NAMED-ABSTAIN ids: registration sites whose payload id resolved to a
//       constant but whose version derivation abstained (collected by
//       deriveNeoForgeComponents and passed in — today these vanish).
//   (b) WRAPPER-REGISTRAR CHANNEL FACTORY (the CreativeCore shape, pinned
//       from CreativeCore_NEOFORGE_v2.13.41 bytecode): a class that builds
//       CustomPacketPayload$Type ids from a COUNTER field via
//       makeConcatWithConstants ((I)Ljava/lang/String; recipe), feeds them
//       through ResourceLocation.tryBuild, and forwards to
//       PayloadRegistrar.playTo*/commonTo*/configurationTo*. The ids are
//       dynamic (per-packet-type counter — rig-proven: declaring 1s moved
//       the server's throw to 2s) but the SHAPE is statically derivable:
//       namespace from the factory's construction-site ResourceLocation
//       constant, side suffixes from the packet-type class's own
//       makeConcatWithConstants recipes ("\u0001s"/"\u0001c"), and the id
//       range enumerated over the counted register call sites under a hard
//       cap.
//   (c) CONNECTOR-SERVED FABRIC JARS: fabric-idiom registrations
//       (PayloadTypeRegistry.playS2C()/configurationS2C().register(TYPE, …))
//       run through Sinytra Connector land in the same NeoForge send guard.
//       The clientbound Type ids are string constants of the jar (directly,
//       or through a one-string helper like `asId` whose concat recipe is a
//       constant) — derive them for the same listen-only tier.
//
// PRIVACY LAWS (same as the rest of this lib): LOCAL-ONLY, READ-ONLY,
// PURPOSE-LIMITED. Requires only the shared jar/class primitives. Nothing is
// classloaded or executed; no network; no writes.

const debug = require('../../debug')
const { decodeInstructions, cpUtf8 } = require('./jarAnalysis')

const REGISTRAR_TYPE = 'net/neoforged/neoforge/network/registration/PayloadRegistrar'
const PAYLOAD_TYPE_CLASSES = new Set([
  'net/minecraft/network/protocol/common/custom/CustomPacketPayload$Type', // mojmap (NeoForge)
  'net/minecraft/class_8710$class_9154' // intermediary (production fabric jars)
])
const RESLOC_CLASSES = new Set([
  'net/minecraft/resources/ResourceLocation', // mojmap
  'net/minecraft/class_2960', // intermediary
  'net/minecraft/util/Identifier' // yarn (dev jars)
])
const FABRIC_PAYLOAD_REGISTRY = 'net/fabricmc/fabric/api/networking/v1/PayloadTypeRegistry'
// Clientbound-opening accessors (fabric-api PayloadTypeRegistries): S2C =
// server-to-client — exactly the flow the send guard kills when undeclared.
const FABRIC_S2C_ACCESSORS = new Set(['playS2C', 'configurationS2C'])

// Hard caps — the LAW that keeps enumeration honest and bounded. A factory's
// counter is dynamic (call sites can sit in loops), so the enumerated range
// is call-site count + margin, never past the cap. Over-declaring is
// truthful listen-tolerance; the caps bound the wire bytes.
const FACTORY_ENUM_MARGIN = 32
const FACTORY_ENUM_CAP = 96
const LISTEN_ONLY_TOTAL_CAP = 512
const MAX_FACTORIES = 20

const NAMESPACE_RE = /^[a-z0-9_.-]+$/
const RESOURCE_ID_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/
// A makeConcatWithConstants recipe of the side-suffix shape: exactly one
// dynamic slot with a short suffix ("\u0001s" / "\u0001c" — CreativeCore's
// CreativeNetworkPacket BSM args, javap-verified).
const SUFFIX_RECIPE_RE = /^\u0001[a-z0-9_]{1,8}$/
// The counter recipe: one dynamic slot, optional short path affixes.
const COUNTER_RECIPE_RE = /^[a-z0-9_./-]{0,16}\u0001[a-z0-9_./-]{0,16}$/

// The string-concat recipe constant of an invokedynamic
// makeConcatWithConstants call site (first String arg of its bootstrap
// method), or null.
function concatRecipeOf (parsed, bsmIndex) {
  const bsm = parsed.bootstrapMethods && parsed.bootstrapMethods[bsmIndex]
  if (!bsm) return null
  for (const argIdx of bsm.args) {
    const c = parsed.cp[argIdx]
    if (c && c.tag === 8) return cpUtf8(parsed.cp, c.strIndex)
  }
  return null
}

// Every class name referenced from a parsed class's constant pool.
function referencedClassNames (parsed) {
  const names = []
  for (const c of parsed.cp) {
    if (c && c.tag === 7) {
      const n = cpUtf8(parsed.cp, c.nameIndex)
      if (n) names.push(n)
    }
  }
  return names
}

function isReslocFactoryCall (row) {
  return row.op === 0xb8 && row.ref && RESLOC_CLASSES.has(row.ref.owner)
}

function fieldDescIsPayloadType (desc) {
  if (typeof desc !== 'string' || !desc.startsWith('L') || !desc.endsWith(';')) return false
  return PAYLOAD_TYPE_CLASSES.has(desc.slice(1, -1))
}

// ---------- tier (b): the wrapper-registrar channel factory ----------

// Counter-method fingerprint inside a candidate factory class: one method
// that (1) increments an int FIELD of the class (getfield C.f:I … iadd …
// putfield C.f:I), (2) builds a string from an int via
// makeConcatWithConstants (I)Ljava/lang/String;, and (3) feeds a
// ResourceLocation factory. That is the counted-id registration shape.
function findCounterMethod (info) {
  for (const m of info.codes) {
    let rows
    try { rows = decodeInstructions(m.code, info.cp) } catch { continue }
    let getsIntField = false
    let putsIntField = false
    let recipe = null
    let callsResloc = false
    for (const row of rows) {
      if (row.op === 0xb4 && row.ref && row.ref.owner === info.className && row.ref.desc === 'I') getsIntField = true
      if (row.op === 0xb5 && row.ref && row.ref.owner === info.className && row.ref.desc === 'I') putsIntField = true
      if (row.op === 0xba && row.samName === 'makeConcatWithConstants' && recipe === null) {
        const r = concatRecipeOf(info, row.bsmIndex)
        if (r != null && COUNTER_RECIPE_RE.test(r)) recipe = r
      }
      if (isReslocFactoryCall(row)) callsResloc = true
    }
    if (getsIntField && putsIntField && recipe != null && callsResloc) {
      return { method: m, recipe }
    }
  }
  return null
}

// Side suffixes from the factory's collaborator classes: a class the factory
// references that constructs CustomPacketPayload$Type ids via
// makeConcatWithConstants suffix recipes in the SAME method that news the
// Type ("\u0001s"/"\u0001c" in CreativeNetworkPacket.<init>).
function findSideSuffixes (index, factoryInfo) {
  const suffixes = new Set()
  const candidates = new Set(referencedClassNames(factoryInfo))
  candidates.add(factoryInfo.className)
  for (const name of candidates) {
    if (!index.raw.has(name)) continue
    const info = index.get(name)
    if (!info) continue
    for (const m of info.codes) {
      let rows
      try { rows = decodeInstructions(m.code, info.cp) } catch { continue }
      const newsPayloadType = rows.some((r) => (r.op === 0xbb) && PAYLOAD_TYPE_CLASSES.has(r.cls))
      if (!newsPayloadType) continue
      for (const row of rows) {
        if (row.op === 0xba && row.samName === 'makeConcatWithConstants') {
          const recipe = concatRecipeOf(info, row.bsmIndex)
          if (recipe != null && SUFFIX_RECIPE_RE.test(recipe)) suffixes.add(recipe.slice(1))
        }
      }
    }
  }
  return suffixes
}

// Namespaces from the factory's construction sites: any class that
// invokespecial's the factory's <init> with a ResourceLocation built from
// string constants in the same instruction window (CreativeCore.<clinit>:
// ldc "creativecore"; ldc "main"; invokestatic ResourceLocation.tryBuild;
// invokespecial CreativeNetwork.<init>).
function findCtorNamespaces (index, factoryName) {
  const namespaces = new Set()
  const needle = Buffer.from(factoryName, 'utf8')
  for (const name of [...index.raw.keys()]) {
    const bytes = index.rawBytes(name)
    if (!bytes || !bytes.includes(needle)) continue
    const info = index.get(name)
    if (!info) continue
    for (const m of info.codes) {
      let rows
      try { rows = decodeInstructions(m.code, info.cp) } catch { continue }
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        if (row.op !== 0xb7 || !row.ref || row.ref.owner !== factoryName || row.ref.name !== '<init>') continue
        // Look back a bounded window for the ResourceLocation the ctor got.
        const start = Math.max(0, i - 40)
        const window = rows.slice(start, i)
        let ns = null
        for (let j = window.length - 1; j >= 0; j--) {
          if (!isReslocFactoryCall(window[j])) continue
          const strs = window.slice(0, j).filter((r) => typeof r.str === 'string').map((r) => r.str)
          if (strs.length >= 2 && NAMESPACE_RE.test(strs[strs.length - 2])) {
            ns = strs[strs.length - 2] // (namespace, path) two-arg form
          } else if (strs.length >= 1 && strs[strs.length - 1].includes(':')) {
            const cand = strs[strs.length - 1].split(':')[0]
            if (NAMESPACE_RE.test(cand)) ns = cand // "ns:path" one-arg form
          }
          break
        }
        if (ns) namespaces.add(ns)
      }
    }
  }
  return namespaces
}

// Static call-site count of the factory's counter method across the pack.
function countCounterCallSites (index, factoryName, counterMethod) {
  let count = 0
  const needle = Buffer.from(factoryName, 'utf8')
  for (const name of [...index.raw.keys()]) {
    const bytes = index.rawBytes(name)
    if (!bytes || !bytes.includes(needle)) continue
    const info = index.get(name)
    if (!info) continue
    for (const m of info.codes) {
      let rows
      try { rows = decodeInstructions(m.code, info.cp) } catch { continue }
      for (const row of rows) {
        if ((row.op === 0xb6 || row.op === 0xb7 || row.op === 0xb9) && row.ref &&
            row.ref.owner === factoryName && row.ref.name === counterMethod.method && row.ref.desc === counterMethod.desc) {
          count++
        }
      }
    }
  }
  return count
}

function deriveWrapperFactoryListenChannels (index, diagnostics) {
  const ids = []
  let factories = 0
  for (const name of [...index.raw.keys()]) {
    if (factories >= MAX_FACTORIES) break
    let bytes
    try { bytes = index.rawBytes(name) } catch { continue }
    if (!bytes || !bytes.includes(REGISTRAR_TYPE)) continue
    const info = index.get(name)
    if (!info) continue
    try {
      const counter = findCounterMethod(info)
      if (!counter) continue
      // The factory must actually forward to the registrar (any registration
      // method on PayloadRegistrar anywhere in the class).
      const forwards = info.codes.some((m) => {
        let rows
        try { rows = decodeInstructions(m.code, info.cp) } catch { return false }
        return rows.some((r) => (r.op === 0xb6 || r.op === 0xb9) && r.ref && r.ref.owner === REGISTRAR_TYPE)
      })
      if (!forwards) continue
      factories++
      const suffixes = findSideSuffixes(index, info)
      if (suffixes.size === 0) suffixes.add('')
      const namespaces = findCtorNamespaces(index, info.className)
      if (namespaces.size === 0) {
        diagnostics.abstains.push(`${info.className}: wrapper-registrar channel factory detected but no construction-site namespace constant resolved — listen-only enumeration abstained`)
        continue
      }
      const callSites = countCounterCallSites(index, info.className, counter.method)
      const cap = Math.min(Math.max(callSites, 1) + FACTORY_ENUM_MARGIN, FACTORY_ENUM_CAP)
      for (const ns of namespaces) {
        for (let i = 0; i < cap; i++) {
          const base = counter.recipe.replace('\u0001', String(i))
          for (const sfx of suffixes) {
            const id = `${ns}:${base}${sfx}`
            if (RESOURCE_ID_RE.test(id)) ids.push(id)
          }
        }
      }
      debug(`listen-only factory ${info.className}: ns=[${[...namespaces].join(',')}] suffixes=[${[...suffixes].join(',')}] callSites=${callSites} cap=${cap}`)
      diagnostics.listenOnlyNotes = diagnostics.listenOnlyNotes || []
      diagnostics.listenOnlyNotes.push(`wrapper-registrar factory ${info.className}: ${namespaces.size} namespace(s) x ${cap} counted ids x ${suffixes.size} suffix(es)`)
    } catch (err) {
      diagnostics.errors.push(`listen-only factory scan failed at ${name}: ${err.message}`)
    }
  }
  return ids
}

// ---------- tier (c): connector-served fabric jars ----------

// Resolve a payload-Type static field to its ResourceLocation id: the
// owner's <clinit> constructs the Type from string constants — directly
// (two-string of/tryBuild, or one "ns:path" parse) or through a one-string
// helper whose body is a constant concat recipe + a ResourceLocation
// factory call (the sengoku `asId` shape).
function resolveTypeFieldId (index, ownerName, fieldName, helperCache) {
  const info = index.get(ownerName)
  if (!info) return null
  const clinit = info.codes.find((m) => m.method === '<clinit>')
  if (!clinit) return null
  let rows
  try { rows = decodeInstructions(clinit.code, info.cp) } catch { return null }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.op !== 0xb3 || !row.ref || row.ref.owner !== ownerName || row.ref.name !== fieldName) continue
    // Window back to the previous putstatic (one field's initializer).
    let start = 0
    for (let j = i - 1; j >= 0; j--) {
      if (rows[j].op === 0xb3) { start = j + 1; break }
    }
    const window = rows.slice(start, i)
    const strs = window.filter((r) => typeof r.str === 'string').map((r) => r.str)
    // one-string helper: invokestatic <helper>(Ljava/lang/String;)L<resloc>;
    for (const r of window) {
      if (r.op === 0xb8 && r.ref && !RESLOC_CLASSES.has(r.ref.owner) &&
          /^\(Ljava\/lang\/String;\)L[^;]+;$/.test(r.ref.desc || '') &&
          RESLOC_CLASSES.has((r.ref.desc.match(/\)L([^;]+);$/) || [])[1])) {
        const recipe = resolveStringHelperRecipe(index, r.ref, helperCache)
        if (recipe != null && strs.length > 0) {
          const id = recipe.replace('\u0001', strs[strs.length - 1])
          if (RESOURCE_ID_RE.test(id)) return id
        }
      }
    }
    // direct two-string form (of/fromNamespaceAndPath/tryBuild)
    for (let j = window.length - 1; j >= 0; j--) {
      if (isReslocFactoryCall(window[j]) && /\(Ljava\/lang\/String;Ljava\/lang\/String;\)/.test(window[j].ref.desc || '')) {
        if (strs.length >= 2) {
          const id = `${strs[strs.length - 2]}:${strs[strs.length - 1]}`
          if (RESOURCE_ID_RE.test(id)) return id
        }
      }
    }
    // direct one-string "ns:path" form (parse/method_60654/tryParse)
    for (const s of strs) {
      if (RESOURCE_ID_RE.test(s)) return s
    }
    return null
  }
  return null
}

// A helper like sengoku's asId(String): body = invokedynamic
// makeConcatWithConstants (constant recipe) + a ResourceLocation factory
// call. Returns the recipe ("sengoku:\u0001") or "\u0001" for a pass-through.
function resolveStringHelperRecipe (index, ref, cache) {
  const key = `${ref.owner}.${ref.name}${ref.desc}`
  if (cache.has(key)) return cache.get(key)
  let recipe = null
  const info = index.get(ref.owner)
  if (info) {
    const m = info.codes.find((c) => c.method === ref.name && c.desc === ref.desc)
    if (m) {
      try {
        const rows = decodeInstructions(m.code, info.cp)
        const usesResloc = rows.some((r) => isReslocFactoryCall(r))
        if (usesResloc) {
          const idy = rows.find((r) => r.op === 0xba && r.samName === 'makeConcatWithConstants')
          if (idy) {
            const r = concatRecipeOf(info, idy.bsmIndex)
            if (r != null && (r.match(/\u0001/g) || []).length === 1) recipe = r
          } else {
            recipe = '\u0001' // pass-through helper
          }
        }
      } catch { /* helper unreadable: no recipe */ }
    }
  }
  cache.set(key, recipe)
  return recipe
}

function deriveFabricListenChannels (index, diagnostics) {
  const ids = new Set()
  const helperCache = new Map()
  const needle = Buffer.from(FABRIC_PAYLOAD_REGISTRY, 'utf8')
  for (const name of [...index.raw.keys()]) {
    let bytes
    try { bytes = index.rawBytes(name) } catch { continue }
    if (!bytes || !bytes.includes(needle)) continue
    const info = index.get(name)
    if (!info) continue
    try {
      for (const m of info.codes) {
        let rows
        try { rows = decodeInstructions(m.code, info.cp) } catch { continue }
        let clientbound = false
        for (const row of rows) {
          if (row.op === 0xb8 && row.ref && row.ref.owner === FABRIC_PAYLOAD_REGISTRY) {
            clientbound = FABRIC_S2C_ACCESSORS.has(row.ref.name)
            continue
          }
          if (!clientbound) continue
          if (row.op === 0xb2 && row.ref && fieldDescIsPayloadType(row.ref.desc)) {
            const id = resolveTypeFieldId(index, row.ref.owner, row.ref.name, helperCache)
            if (id) ids.add(id)
          }
          if (row.op === 0xb9 && row.ref && row.ref.owner === FABRIC_PAYLOAD_REGISTRY && row.ref.name === 'register') {
            clientbound = false // one registration consumed
          }
        }
      }
    } catch (err) {
      diagnostics.errors.push(`listen-only fabric scan failed at ${name}: ${err.message}`)
    }
  }
  return [...ids]
}

// ---------- assembly ----------

/**
 * The combined listen-only id set for the pack: named-abstain ids +
 * factory-enumerated ids + fabric clientbound ids, minus everything already
 * claimed (negotiated channels pass the guard's first tier), minus
 * neoforge:* (the HF6 handler/tolerated contracts own the built-ins) and
 * minecraft:* (namespace-exempt in checkPacket). Deduped, deterministic
 * order, capped.
 */
function assembleListenOnly ({ named = [], factory = [], fabric = [], claimedIds = new Set(), diagnostics }) {
  const out = []
  const seen = new Set()
  for (const id of [...named, ...factory, ...fabric]) {
    if (typeof id !== 'string' || !RESOURCE_ID_RE.test(id)) continue
    if (id.startsWith('neoforge:') || id.startsWith('minecraft:')) continue
    if (claimedIds.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= LISTEN_ONLY_TOTAL_CAP) {
      if (diagnostics) diagnostics.errors.push(`listen-only set capped at ${LISTEN_ONLY_TOTAL_CAP} ids — remainder dropped (loud)`)
      break
    }
  }
  return out
}

module.exports = {
  deriveWrapperFactoryListenChannels,
  deriveFabricListenChannels,
  assembleListenOnly,
  concatRecipeOf,
  FACTORY_ENUM_CAP,
  FACTORY_ENUM_MARGIN,
  LISTEN_ONLY_TOTAL_CAP
}
