'use strict'

const fs = require('fs')
const path = require('path')
const debug = require('debug')('minecraft-protocol-forge')
const { zipCentralEntries, zipEntryData, parseClassFile, readAnnotationsAttr, decodeInstructions } = require('./jarAnalysis')
const { WRITE_PRIMS, READ_PRIMS } = require('./itemStackWireDerivation')

// HF41 — jar-derived PACKET-BODY wire extensions (the HF35 item-stack walker
// generalised to whole vanilla packets).
//
// A mod may mixin into a vanilla network packet's (de)serializer and append
// bytes to its body: Immersive Portals' imm_ptl_core (nested inside the
// immersive-portals jar) injects at the RETURN of every
// ServerboundMovePlayerPacket$*.read(FriendlyByteBuf) a DimId.readWorldId →
// readInt (the player's dimension int id), paired with a client-side
// injection at the RETURN of the matching write(FriendlyByteBuf) → writeInt,
// and extends ClientboundPlayerPositionPacket the same way (server writes,
// client ctor reads when bytes remain). A vanilla-shaped 34-byte
// position_look is then kicked at the server's decoder ("readerIndex(34) +
// length(4) exceeds writerIndex(34)").
//
// This module DERIVES the extension from the local jars (mixin annotations +
// injection bytecode read as class-file data; nothing is loaded or run):
//   * every jar AND its nested jars are walked (Fabric jar-in-jar under
//     META-INF/jars/ + fabric.mod.json "jars"; Forge JarJar under
//     META-INF/jarjar/ + metadata.json);
//   * the target law: an @Inject at RETURN/TAIL (or HEAD) of a vanilla
//     packet class's read(FriendlyByteBuf) / write(FriendlyByteBuf) /
//     <init>(FriendlyByteBuf); Mojang names on Forge, intermediary targets
//     on Fabric resolved through the refmap json shipped in the jar (no
//     refmap → honest abstain);
//   * the primitives are read off the handler body, following static calls
//     into the jar's own classes (DimId.writeWorldId → writeInt) a bounded
//     number of hops;
//   * the HF35 pairing law: the server-read side and the client-write side
//     of one packet class must agree on anchor and primitive sequence;
//   * packet class → nmp packet name through PACKET_CLASS_TABLE (version
//     keyed data; a class outside it is a named abstain);
//   * the VALUE PROVIDER: the write side's source method names how the value
//     is obtained (a record class read from an NBT compound the server sends
//     on a channel); the channel id, the compound key and the value tag are
//     derived from the jar; a loader transport (Forge SimpleChannel) found in
//     the jar is a second candidate with its framing. No provider → abstain
//     (never a guessed 0).
// Anything the walk cannot pair or source is an ABSTAIN naming the mod, the
// jar, the class and why; the caller voices it, and never blames the account.

const MIXIN_ANN = 'Lorg/spongepowered/asm/mixin/Mixin;'
const INJECTOR_RE = /^L(?:org\/spongepowered\/asm\/mixin\/injection|com\/llamalad7\/mixinextras\/injector(?:\/v1)?)\/([A-Za-z]+);$/
const MAX_NESTED_DEPTH = 3
const MAX_CALL_HOPS = 3

// The vanilla type vocabulary in both name systems the jars use (Mojang /
// SRG share class names; intermediary class numbers are stable by design).
const VANILLA = {
  buf: new Set(['net/minecraft/network/FriendlyByteBuf', 'net/minecraft/class_2540']),
  compound: new Set(['net/minecraft/nbt/CompoundTag', 'net/minecraft/class_2487']),
  resourceLocation: new Set(['net/minecraft/resources/ResourceLocation', 'net/minecraft/class_2960'])
}
const isBuf = (c) => VANILLA.buf.has(c)
const isCompound = (c) => VANILLA.compound.has(c)
const isResLoc = (c) => VANILLA.resourceLocation.has(c)

// Loader transports whose registration a mod calls from its own bytecode;
// the framing is the loader's wire law (Forge SimpleChannel prefixes each
// message with a one-byte discriminator index).
const LOADER_TRANSPORTS = {
  'net/minecraftforge/network/NetworkRegistry$ChannelBuilder': { loader: 'forge-simplechannel', framing: 'u8-index' }
}

// Mojang packet class -> [direction, nmp packet name]; version keyed. The
// Mojang names are stable from 1.17 on (nmp's names are too). Extend with
// rows, never with special cases in the walk.
const PACKET_CLASS_TABLE = [
  {
    minVersion: '1.17',
    classes: {
      'net/minecraft/network/protocol/game/ServerboundMovePlayerPacket$Pos': ['toServer', 'position'],
      'net/minecraft/network/protocol/game/ServerboundMovePlayerPacket$PosRot': ['toServer', 'position_look'],
      'net/minecraft/network/protocol/game/ServerboundMovePlayerPacket$Rot': ['toServer', 'look'],
      'net/minecraft/network/protocol/game/ServerboundMovePlayerPacket$StatusOnly': ['toServer', 'flying'],
      'net/minecraft/network/protocol/game/ServerboundMoveVehiclePacket': ['toServer', 'vehicle_move'],
      'net/minecraft/network/protocol/game/ServerboundAcceptTeleportationPacket': ['toServer', 'teleport_confirm'],
      'net/minecraft/network/protocol/game/ClientboundPlayerPositionPacket': ['toClient', 'position'],
      'net/minecraft/network/protocol/game/ClientboundMoveVehiclePacket': ['toClient', 'vehicle_move'],
      'net/minecraft/network/protocol/game/ClientboundRespawnPacket': ['toClient', 'respawn']
    }
  }
]

function packetTableFor (version) {
  let mcData = null
  try { mcData = require('minecraft-data')(version) } catch { mcData = null }
  const rows = PACKET_CLASS_TABLE.filter((row) => {
    if (!mcData) return true // unknown version: every row is a candidate, the compile step checks the packet exists
    try { return mcData.isNewerOrEqualTo(row.minVersion) } catch { return true }
  })
  const table = {}
  for (const row of rows) Object.assign(table, row.classes)
  return table
}

// ---------------------------------------------------------------- jar walk

function readJar (jarPath) { return fs.readFileSync(jarPath) }

function listJars (paths) {
  const jars = []
  for (const p of paths || []) {
    try {
      const st = fs.statSync(p)
      if (st.isDirectory()) jars.push(...fs.readdirSync(p).filter((f) => f.endsWith('.jar')).sort().map((f) => path.join(p, f)))
      else if (p.endsWith('.jar')) jars.push(p)
    } catch (err) { debug(`packet-wire scan: skipping ${p} (${err.message})`) }
  }
  return jars
}

function entryText (buf, entry) { try { return zipEntryData(buf, entry).toString('utf8') } catch { return '' } }

// Nested jar entries a loader would load: fabric.mod.json "jars" / Forge
// META-INF/jarjar/metadata.json "jars", plus every *.jar under the two
// conventional folders (a manifest that forgot one is still walked).
function nestedJarEntries (entries, buf) {
  const named = new Set()
  const byName = new Map(entries.map((e) => [e.name, e]))
  const fmj = byName.get('fabric.mod.json')
  if (fmj) { try { for (const j of JSON.parse(entryText(buf, fmj)).jars || []) if (j && j.file) named.add(String(j.file)) } catch { /* not json */ } }
  const jj = byName.get('META-INF/jarjar/metadata.json')
  if (jj) { try { for (const j of JSON.parse(entryText(buf, jj)).jars || []) if (j && j.path) named.add(String(j.path)) } catch { /* not json */ } }
  return entries.filter((e) => e.name.endsWith('.jar') && (named.has(e.name) || /^META-INF\/(?:jars|jarjar)\//.test(e.name)))
}

// The mod identity a jar declares (data for receipts and copy; never a switch).
// Mod identity from the jar's OWN descriptors, loader-aware: a Forge/NeoForge
// descriptor (META-INF/mods.toml, META-INF/neoforge.mods.toml) first — its
// `${file.jarVersion}` resolved from META-INF/MANIFEST.MF Implementation-Version
// (the version the jar really carries) — then fabric.mod.json. A multi-loader
// jar can ship a stale fabric.mod.json next to its live toml (immersive-portals
// 3.0.7-all says "9.0" there; toml + manifest say 3.0.7): the version voiced in
// every receipt and abstain copy must be the jar's, so the toml wins when it is
// present and an unresolvable template is null, never the literal.
function modIdentity (entries, buf) {
  const byName = new Map(entries.map((e) => [e.name, e]))
  const manifest = byName.get('META-INF/MANIFEST.MF')
  const implVersion = manifest ? ((entryText(buf, manifest).replace(/\r/g, '').match(/^Implementation-Version:[ \t]*(\S+)/m) || [])[1] || null) : null
  const toml = byName.get('META-INF/mods.toml') || byName.get('META-INF/neoforge.mods.toml')
  if (toml) {
    const text = entryText(buf, toml)
    const id = text.match(/^\s*modId\s*=\s*"([^"]+)"/m)
    const name = text.match(/^\s*displayName\s*=\s*"([^"]+)"/m)
    const version = text.match(/^\s*version\s*=\s*"([^"]+)"/m)
    if (id) {
      let v = version ? version[1] : null
      if (v && /\$\{file\.jarVersion\}/.test(v)) v = implVersion ? v.replace(/\$\{file\.jarVersion\}/g, implVersion) : null
      if (v && /\$\{/.test(v)) v = null // another template this walk cannot resolve: no version, never the literal
      return { id: id[1], name: name ? name[1] : id[1], version: v, descriptor: toml.name }
    }
  }
  const fmj = byName.get('fabric.mod.json')
  if (fmj) { try { const j = JSON.parse(entryText(buf, fmj)); if (j.id) return { id: String(j.id), name: String(j.name || j.id), version: j.version ? String(j.version) : null, descriptor: 'fabric.mod.json' } } catch { /* not json */ } }
  return null
}

// One unit = one (possibly nested) jar: its entries + class index + refmap.
function collectUnits (jarPath) {
  const units = []
  const walk = (buf, nested, depth) => {
    const entries = zipCentralEntries(buf)
    const unit = { jarPath, nested, buf, entries, classes: new Map(), refmaps: [], mod: modIdentity(entries, buf) }
    for (const e of entries) {
      if (e.name.endsWith('.class')) unit.classes.set(e.name.slice(0, -6), e)
      else if (/refmap.*\.json$/i.test(e.name)) { try { unit.refmaps.push(JSON.parse(entryText(buf, e))) } catch { /* not json */ } }
    }
    units.push(unit)
    if (depth >= MAX_NESTED_DEPTH) return
    for (const e of nestedJarEntries(entries, buf)) {
      try { walk(zipEntryData(buf, e), nested ? `${nested}!${e.name}` : e.name, depth + 1) } catch (err) { debug(`packet-wire scan: unreadable nested jar ${e.name} in ${jarPath} (${err.message})`) }
    }
  }
  walk(readJar(jarPath), null, 0)
  return units
}

// ------------------------------------------------------------ refmap aliases

const classTokens = (s) => [...String(s).matchAll(/L([^;]+);/g)].map((m) => m[1])
function splitRef (s) {
  const m = String(s).match(/^(?:L([^;]+);)?([^(:]*)(\(.*)?$/)
  return { owner: m ? m[1] || null : null, name: m ? m[2] : '', desc: m ? m[3] || '' : '' }
}

// Refmap json (named → intermediary on Fabric, Mojang → searge on Forge):
// every key/value pair is aligned token by token, so the jar's OWN table
// says which intermediary class/method a Mojang name is — never recall.
function buildAliases (units) {
  const classes = new Map() // mapped class -> Mojang class
  const methods = new Map() // `${mappedOwner}.${mappedName}` -> Mojang name
  for (const unit of units) {
    for (const rm of unit.refmaps) {
      const tables = [rm.mappings || {}, ...Object.values(rm.data || {})]
      for (const table of tables) {
        for (const perClass of Object.values(table)) {
          for (const [k, v] of Object.entries(perClass || {})) {
            const kt = classTokens(k); const vt = classTokens(v)
            const kr = splitRef(k); const vr = splitRef(v)
            let vTokens = vt
            if (vt.length === kt.length + 1 && vr.owner && !kr.owner) vTokens = vt.slice(1)
            if (vTokens.length === kt.length) {
              for (let i = 0; i < kt.length; i++) if (kt[i] !== vTokens[i] && !classes.has(vTokens[i])) classes.set(vTokens[i], kt[i])
            }
            if (vr.owner && vr.name && kr.name && vr.name !== kr.name) methods.set(`${vr.owner}.${vr.name}`, kr.name)
          }
        }
      }
    }
  }
  return { classes, methods, resolveClass: (c) => classes.get(c) || c, resolveMethod: (owner, name) => methods.get(`${owner}.${name}`) || name }
}

// ----------------------------------------------------------- class helpers

function annsAt (parsed, ...offsets) {
  const out = []
  for (const at of offsets) {
    if (at == null) continue
    try { out.push(...readAnnotationsAttr(parsed.bytes, at, parsed.cp, { rich: true })) } catch { /* malformed table: tolerated */ }
  }
  return out
}

function codeOf (parsed, name, desc) { return parsed.codes.find((c) => c.method === name && c.desc === desc) }

function instructions (parsed, name, desc) {
  const code = codeOf(parsed, name, desc)
  if (!code) return null
  try { return decodeInstructions(code.code, parsed.cp) } catch { return null }
}

const isInvoke = (row) => row.ref && (row.op === 0xb6 || row.op === 0xb7 || row.op === 0xb8 || row.op === 0xb9)
const isGetStatic = (row) => row.op === 0xb2 && row.ref
const isPutStatic = (row) => row.op === 0xb3 && row.ref

function primOf (row, table) {
  const key = `${row.ref.name}:${row.ref.desc}`
  const hit = Object.keys(table).find((k) => key.startsWith(k))
  return hit ? table[hit] : null
}

// Lazily parse a class by internal name from any unit of one top-level jar.
function classLoader (units) {
  const cache = new Map()
  return (name) => {
    if (cache.has(name)) return cache.get(name)
    let parsed = null
    for (const unit of units) {
      const e = unit.classes.get(name)
      if (!e) continue
      try { parsed = parseClassFile(zipEntryData(unit.buf, e)); parsed.unit = unit } catch { parsed = null }
      break
    }
    cache.set(name, parsed)
    return parsed
  }
}

// Primitive buffer calls in a handler body, following calls into the jar's
// own classes up to MAX_CALL_HOPS (DimId.writeWorldId → writeInt). Returns
// the ordered prims + the first jar method that yielded them (the value
// source) + the calls seen before the first prim (guards).
function primsInDeep (parsed, name, desc, table, load) {
  const seen = new Set()
  const out = { fields: [], sources: [], source: null, preCalls: [], bufCalls: [], calls: [] }
  const walk = (cls, mName, mDesc, hops, via) => {
    const key = `${cls.className}.${mName}${mDesc}`
    if (seen.has(key)) return
    seen.add(key)
    const rows = instructions(cls, mName, mDesc)
    if (!rows) return
    for (const row of rows) {
      if (!isInvoke(row)) continue
      const prim = primOf(row, table)
      if (prim && (isBuf(row.ref.owner) || /^io\/netty\/buffer\//.test(row.ref.owner) || row.ref.owner === cls.className)) {
        out.fields.push(prim)
        out.sources.push(via || null)
        if (!out.source) out.source = via || { className: cls.className, method: mName, desc: mDesc }
        continue
      }
      if (hops === 0) out.calls.push({ owner: row.ref.owner, name: row.ref.name, desc: row.ref.desc, op: row.op, primsBefore: out.fields.length })
      if (isBuf(row.ref.owner)) { out.bufCalls.push(`${row.ref.name}${row.ref.desc}`); continue }
      if (!out.fields.length) out.preCalls.push({ owner: row.ref.owner, name: row.ref.name, desc: row.ref.desc, op: row.op })
      if (hops < MAX_CALL_HOPS) {
        const target = load(row.ref.owner)
        if (target) walk(target, row.ref.name, row.ref.desc, hops + 1, via || { className: row.ref.owner, method: row.ref.name, desc: row.ref.desc })
      }
    }
  }
  walk(parsed, name, desc, 0, null)
  return out
}

function methodNames (elements) {
  const v = elements.method
  const arr = Array.isArray(v) ? v : (v == null ? [] : [v])
  return arr.filter((s) => typeof s === 'string')
}

function anchorOf (elements) {
  const at = Array.isArray(elements.at) ? elements.at[0] : elements.at
  if (!at || typeof at !== 'object') return { anchor: null, value: null }
  const value = String(at.elements?.value || '')
  if (value === 'RETURN' || value === 'TAIL') return { anchor: 'tail', value }
  if (value === 'HEAD') return { anchor: 'head', value }
  return { anchor: null, value }
}

// The handler's own descriptor names the target's parameters (Mixin passes
// them through before the CallbackInfo) — used when the @Inject method
// string carries no descriptor.
function handlerParams (desc) {
  const m = String(desc).match(/^\(([^)]*)\)/)
  if (!m) return []
  const out = [...m[1].matchAll(/\[*(?:L[^;]+;|[BCDFIJSZ])/g)].map((t) => t[0])
  return out.filter((p) => !/CallbackInfo/.test(p))
}

// One @Mixin class -> its injections on packet (de)serializers.
function scanClass (parsed, aliases, unit, load) {
  const mixin = annsAt(parsed, parsed.classInvisibleAnnotationsAt, parsed.classAnnotationsAt).find((a) => a.type === MIXIN_ANN)
  if (!mixin) return null
  const targets = [].concat(mixin.elements.value || [], mixin.elements.targets || [])
    .filter((t) => typeof t === 'string').map((t) => t.replace(/^L|;$/g, '').replace(/\./g, '/'))
  const found = { className: parsed.className, targets, jar: path.basename(unit.jarPath), nested: unit.nested, mod: unit.mod, injections: [], payloadInjections: [], handles: [], unresolved: [] }
  for (const m of parsed.methods) {
    for (const a of annsAt(parsed, m.annotationsAt, m.invisibleAnnotationsAt)) {
      const inj = String(a.type).match(INJECTOR_RE)
      if (!inj || inj[1] !== 'Inject') continue
      for (const raw of methodNames(a.elements)) {
        const ref = splitRef(raw)
        const ownerRaw = ref.owner || targets[0] || null
        if (!ownerRaw) continue
        const owner = aliases.resolveClass(ownerRaw)
        const name = /^(?:method_\d+|m_\d+_)$/.test(ref.name) ? aliases.resolveMethod(ownerRaw, ref.name) : ref.name
        const params = ref.desc ? handlerParams(ref.desc) : handlerParams(m.desc)
        const bufParam = params.length === 1 && isBuf(params[0].replace(/^L|;$/g, ''))
        let side = null
        if (name === 'write' && bufParam) side = 'write'
        else if (name === 'read' && bufParam) side = 'read'
        else if (name === '<init>' && bufParam) side = 'read'
        if (name === 'handle' && ref.desc) { const lp = handlerParams(ref.desc)[0]; if (lp) found.handles.push(lp.replace(/^L|;$/g, '')) }
        if (!side) continue
        // The handler must touch the packet's OWN buffer (its first parameter,
        // local 1 of an instance handler): an injection that only reads or
        // writes a buffer held in a field (a custom payload's inner data) never
        // changes the packet body on the wire and is not an extension.
        const rows = instructions(parsed, m.name, m.desc) || []
        const bufLocal = (m.flags & 0x0008) !== 0 ? 0 : 1
        const touchesBuf = rows.some((r) => (r.op === 0x2a + bufLocal) || (r.op === 0x19 && r.aload === bufLocal))
        const { anchor, value } = anchorOf(a.elements)
        if (!touchesBuf) {
          const deep = primsInDeep(parsed, m.name, m.desc, READ_PRIMS, load)
          found.payloadInjections.push({ owner, resolved: !/^net\/minecraft\/class_\d+/.test(owner), target: name, handler: m.name, anchor, fields: deep.fields, sources: deep.sources, calls: deep.calls })
          continue
        }
        const deep = primsInDeep(parsed, m.name, m.desc, side === 'write' ? WRITE_PRIMS : READ_PRIMS, load)
        const row = {
          side,
          owner,
          ownerRaw,
          resolved: !/^net\/minecraft\/class_\d+/.test(owner),
          target: name,
          handler: m.name,
          handlerDesc: m.desc,
          anchor,
          at: value,
          fields: deep.fields,
          source: deep.source,
          preCalls: deep.preCalls,
          optional: side === 'read' && deep.bufCalls.some((c) => /^isReadable\(/.test(c))
        }
        if (!row.resolved) found.unresolved.push(row)
        found.injections.push(row)
      }
    }
  }
  return found.injections.length || found.payloadInjections.length ? found : null
}

// ------------------------------------------------------ redirect derivation

// A client-side injection at the RETURN of ClientboundCustomPayloadPacket's
// buffer ctor that, for one channel (a static predicate on the packet's id),
// reads a header off the PAYLOAD (the dimension through the provider's record
// + a packet id) and constructs a vanilla packet by id from the rest — the
// server then ships every world packet of the player's dimension wrapped that
// way once the client has shown it speaks the mod (Immersive Portals'
// imm_ptl:rd). The client must unwrap or it never sees a chunk.
const LISTENER_FAMILY = { 'net/minecraft/network/protocol/game/ClientGamePacketListener': { state: 'play', direction: 'toClient' } }

function deriveRedirect (mixins, load, provider) {
  const rows = mixins.flatMap((m) => m.payloadInjections.map((r) => ({ ...r, mixin: m })))
    .filter((r) => r.target === '<init>' && r.anchor === 'tail' && /\/ClientboundCustomPayloadPacket$/.test(r.owner))
  if (!rows.length) return { redirect: null }
  const abstain = (reason, detail) => ({ redirect: null, abstain: { reason, detail, mixins: rows.map((r) => `${r.mixin.className} in ${r.mixin.jar}${r.mixin.nested ? ` nested ${r.mixin.nested}` : ''}`) } })
  if (rows.some((r) => !r.resolved)) return abstain('no-refmap', 'a custom payload ctor injection targets an intermediary class no refmap maps')
  if (rows.length !== 1) return abstain('multiple-payload-mixins', `${rows.length} custom payload ctor injections — which wraps world packets is not derivable`)
  const [r] = rows
  const predicate = r.calls.find((c) => c.op === 0xb8 && /^\(L[^;]+;\)Z$/.test(c.desc) && isResLoc(c.desc.slice(2, c.desc.indexOf(';'))))
  if (!predicate) return abstain('redirect-channel-not-derivable', `${r.mixin.className} reads a payload but names no channel predicate this walk recognises`)
  const predCls = load(predicate.owner)
  const strsOf = (rowsI) => (rowsI || []).filter((x) => x.str != null).map((x) => x.str)
  let channel = null
  const predStrs = predCls ? strsOf(instructions(predCls, predicate.name, predicate.desc)) : []
  if (predStrs.length === 2) channel = `${predStrs[0]}:${predStrs[1]}`
  else if (predStrs.length === 1 && predStrs[0].includes(':')) channel = predStrs[0]
  if (!channel && predCls) {
    let strs = []
    for (const x of instructions(predCls, '<clinit>', '()V') || []) {
      if (x.str != null) strs.push(x.str)
      if (isPutStatic(x)) { if (isResLoc((x.ref.desc || '').replace(/^L|;$/g, '')) && strs.length >= 2) { channel = `${strs[strs.length - 2]}:${strs[strs.length - 1]}`; break } strs = [] }
    }
  }
  if (!channel) return abstain('redirect-channel-not-derivable', `${predicate.owner}.${predicate.name} compares the channel to no string constant this walk can read`)
  const ctor = r.calls.find((c) => c.op === 0xb8 && /^\(IL[^;]+;\)L[^;]+;$/.test(c.desc) && isBuf(c.desc.slice(3, c.desc.indexOf(';'))))
  if (!ctor) return abstain('redirect-inner-not-derivable', `${r.mixin.className} reads a payload header but constructs no packet by id from the rest`)
  const family = r.mixin.handles.map((h) => LISTENER_FAMILY[h]).find(Boolean)
  if (!family) return abstain('redirect-inner-not-derivable', `${r.mixin.className} hands the inner packet to no play listener this table knows (${r.mixin.handles.join(', ') || 'none'})`)
  const providerClass = provider && provider.source ? provider.source.split('.')[0] : null
  const header = r.fields.map((type, i) => {
    const via = r.sources[i]
    if (via && providerClass && via.className === providerClass) return { type, source: 'dimension' }
    if (!via && i === r.fields.length - 1 && ctor.primsBefore === r.fields.length) return { type, source: 'packetId' }
    return { type, source: 'unknown' }
  })
  if (!header.length || header.some((h) => h.source === 'unknown') || !header.some((h) => h.source === 'packetId')) return abstain('redirect-header-not-derivable', `the payload header [${r.fields.join(',')}] has a value this walk cannot source`)
  return { redirect: { channel, header, inner: family, predicate: `${predicate.owner}.${predicate.name}`, mixin: { className: r.mixin.className, jar: r.mixin.jar, nested: r.mixin.nested || null, handler: r.handler } } }
}

// ------------------------------------------------------- provider derivation

// The class+method that reads an NBT compound off a FriendlyByteBuf and hands
// it to the record's tag reader (MiscNetworking.processDimSync).
function findTransportReader (units, load, record, tagReader) {
  for (const unit of units) {
    for (const cname of unit.classes.keys()) {
      const cls = load(cname); if (!cls) continue
      for (const m of cls.methods) {
        const body = instructions(cls, m.name, m.desc); if (!body) continue
        const readsNbt = body.some((r) => isInvoke(r) && isBuf(r.ref.owner) && /^\(\)L[^;]+;$/.test(r.ref.desc) && isCompound(r.ref.desc.slice(3, -1)))
        const handsOver = body.some((r) => isInvoke(r) && r.ref.owner === record && r.ref.name === tagReader.name)
        if (readsNbt && handsOver) return { className: cname, method: m.name, desc: m.desc, cls }
      }
    }
  }
  return null
}

// The write side's source method (DimId.writeWorldId) → the record class whose
// int getter it calls → that class's NBT reader (compound key + value tag) →
// the class that reads the compound off a FriendlyByteBuf and hands it to
// the record (the transport reader) → the channel id compared right before
// that reader is invoked, resolved through <clinit>'s ldc pairs. Plus any
// loader transport the jar registers. Every hop is data; a missing hop is a
// named abstain.
function deriveProvider (source, load, units) {
  if (!source) return { provider: null, abstain: { reason: 'unknown-value-provider', detail: 'the write side calls no buffer primitive through a jar method this walk can follow' } }
  const srcCls = load(source.className)
  const rows = srcCls ? instructions(srcCls, source.method, source.desc) : null
  if (!rows) return { provider: null, abstain: { reason: 'unknown-value-provider', detail: `${source.className}.${source.method} is not readable` } }
  // the record: an owner in the jar whose method returns the primitive (I/J/S/B)
  let record = null; let getter = null
  for (const row of rows) {
    if (!isInvoke(row) || isBuf(row.ref.owner)) continue
    if (/\)[IJSB]$/.test(row.ref.desc) && load(row.ref.owner)) { record = row.ref.owner; getter = row.ref.name; break }
  }
  if (!record) return { provider: null, abstain: { reason: 'unknown-value-provider', detail: `${source.className}.${source.method} obtains its value from no record class in the jar` } }
  const recCls = load(record)
  // the record's NBT reader: a method taking a compound that calls getCompound(String) after an ldc key
  let compoundKey = null; let valueType = null; let tagReader = null
  for (const m of recCls.methods) {
    if (!/\(L[^;]+;\)L[^;]+;$/.test(m.desc) && !/\(L[^;]+;\)V$/.test(m.desc)) continue
    const params = handlerParams(m.desc)
    if (params.length !== 1 || !isCompound(params[0].replace(/^L|;$/g, ''))) continue
    const body = instructions(recCls, m.name, m.desc)
    if (!body) continue
    let lastStr = null
    for (const row of body) {
      if (row.str != null) lastStr = row.str
      if (isInvoke(row) && isCompound(row.ref.owner) && /^\(Ljava\/lang\/String;\)L[^;]+;$/.test(row.ref.desc) && isCompound(row.ref.desc.slice(row.ref.desc.indexOf(')L') + 2, -1)) && lastStr != null) {
        compoundKey = lastStr; tagReader = { name: m.name, desc: m.desc }
      }
    }
    if (tagReader) break
  }
  if (!tagReader) return { provider: null, abstain: { reason: 'unknown-value-provider', detail: `${record} has no NBT compound reader this walk recognises` } }
  // the value tag: how the record reads one entry (getInt / getLong / ...) anywhere in the record class (lambdas included)
  for (const m of recCls.methods) {
    const body = instructions(recCls, m.name, m.desc); if (!body) continue
    for (const row of body) {
      if (!isInvoke(row) || !isCompound(row.ref.owner)) continue
      const mm = row.ref.desc.match(/^\(Ljava\/lang\/String;\)([IJSB])$/) // a (String)Z is contains(), not a value getter
      if (mm) { valueType = { I: 'int', J: 'long', S: 'short', B: 'byte' }[mm[1]]; break }
    }
    if (valueType) break
  }
  if (!valueType) return { provider: null, abstain: { reason: 'unknown-value-provider', detail: `${record}'s "${compoundKey}" entries are read with no tag getter this walk recognises` } }
  // the transport reader: a class reading a compound off the buffer and passing it to the record's reader
  const reader = findTransportReader(units, load, record, tagReader)
  if (!reader) return { provider: null, abstain: { reason: 'unknown-value-provider', detail: `no class in the jar reads "${compoundKey}" off a packet buffer into ${record}` } }
  // the channel: nearest ResourceLocation static read before the reader is invoked, then <clinit>'s ldc pair
  const channels = []
  const clinit = instructions(reader.cls, '<clinit>', '()V') || []
  const constOf = (field) => {
    let strs = []
    for (const row of clinit) {
      if (row.str != null) strs.push(row.str)
      if (isPutStatic(row)) { if (row.ref.name === field) return strs.length >= 2 ? `${strs[strs.length - 2]}:${strs[strs.length - 1]}` : (strs.length === 1 ? strs[0] : null); strs = [] }
    }
    return null
  }
  for (const m of reader.cls.methods) {
    const body = instructions(reader.cls, m.name, m.desc); if (!body) continue
    for (let i = 0; i < body.length; i++) {
      const row = body[i]
      if (!(isInvoke(row) && row.ref.owner === reader.className && row.ref.name === reader.method)) continue
      for (let j = i - 1; j >= 0; j--) {
        const b = body[j]
        if (isGetStatic(b) && isResLoc((b.ref.desc || '').replace(/^L|;$/g, ''))) { const id = constOf(b.ref.name); if (id) channels.push({ id, framing: 'raw', from: `${reader.className}.<clinit> ${b.ref.name}` }); break }
        if (b.str != null && b.str.includes(':')) { channels.push({ id: b.str, framing: 'raw', from: `${reader.className}.${m.name}` }); break }
      }
    }
  }
  // loader transports registered by the jar
  for (const unit of units) {
    for (const cname of unit.classes.keys()) {
      const cls = load(cname); if (!cls) continue
      for (const m of cls.methods) {
        const body = instructions(cls, m.name, m.desc); if (!body) continue
        let strs = []
        for (const row of body) {
          if (row.str != null) strs.push(row.str)
          if (isInvoke(row) && LOADER_TRANSPORTS[row.ref.owner] && row.ref.name === 'named') {
            const id = strs.length >= 2 ? `${strs[strs.length - 2]}:${strs[strs.length - 1]}` : strs[0]
            if (id && !channels.some((c) => c.id === id)) channels.push({ id, framing: LOADER_TRANSPORTS[row.ref.owner].framing, loader: LOADER_TRANSPORTS[row.ref.owner].loader, from: `${cname}.${m.name}` })
            strs = []
          }
        }
      }
    }
  }
  if (!channels.length) return { provider: null, abstain: { reason: 'unknown-value-provider', detail: `${reader.className}.${reader.method} reads the record but no channel id could be derived for it` } }
  return {
    provider: {
      kind: 'nbt-int-map',
      record,
      getter,
      compoundKey,
      valueType,
      reader: `${reader.className}.${reader.method}`,
      source: `${source.className}.${source.method}`,
      channels
    }
  }
}

// ------------------------------------------------------------- pairing law

function where (row, m) { return `${m.className} (${row.target} of ${row.owner}) in ${m.jar}${m.nested ? ` nested ${m.nested}` : ''}` }

function deriveSpec (mixins, version) {
  const table = packetTableFor(version)
  const all = mixins.flatMap((m) => m.injections.map((r) => ({ ...r, mixin: m })))
  if (!all.length) return { exts: [], provider: null, abstain: null }
  const modOf = (m) => m.mod || m.mixin?.mod || null
  // the packets an abstain names, as data for the copy: owner class → table row (direction + nmp packet name) when tabled, the direction from
  // the vanilla class name otherwise, the injected sides; `wraps` = the jar also injects a payload ctor (world packets wrapped for mod clients)
  const wraps = mixins.some((m) => (m.payloadInjections || []).length > 0)
  const abstain = (reason, detail, rows) => ({ exts: [], provider: null, abstain: { reason, detail, mixins: rows.map((r) => where(r, r.mixin)), mod: rows.map((r) => modOf(r.mixin)).find(Boolean) || null, jar: rows[0]?.mixin?.jar || null, packets: abstainPackets(rows, table), wraps } })
  const unresolved = all.filter((r) => !r.resolved)
  if (unresolved.length) return abstain('no-refmap', `injection targets ${[...new Set(unresolved.map((r) => r.owner))].join(', ')} are intermediary names and no refmap in the jar maps them to packet classes`, all)
  const packetRows = all.filter((r) => /^net\/minecraft\/network\/protocol\//.test(r.owner))
  if (!packetRows.length) return { exts: [], provider: null, abstain: null }
  const byClass = new Map()
  for (const r of packetRows) { if (!byClass.has(r.owner)) byClass.set(r.owner, []); byClass.get(r.owner).push(r) }
  const exts = []
  for (const [cls, rows] of byClass) {
    const reads = rows.filter((r) => r.side === 'read'); const writes = rows.filter((r) => r.side === 'write')
    // direction from the vanilla class name (Serverbound* is read by the server, Clientbound* by the client)
    const dirByName = /\/Serverbound[^/]*$/.test(cls) ? 'toServer' : (/\/Clientbound[^/]*$/.test(cls) ? 'toClient' : null)
    if (!reads.length) continue // a lone write nobody reads: nothing on the wire changes
    if (!writes.length) {
      // the reader expects bytes nobody in the jar writes: on a serverbound packet the server WILL reject our vanilla shape
      if (dirByName === 'toServer') return abstain('unpaired-read', `the server reads extra bytes at the ${reads[0].anchor || '?'} of ${cls} but no client-side write in the jar produces them`, rows)
      continue // a client-side read of optional bytes the server never writes
    }
    if (!table[cls]) return abstain('packet-class-not-in-table', `${cls} is extended on the wire but this build's packet table has no row for it on ${version || 'this version'}`, rows)
    const [direction, packet] = table[cls]
    if (reads.length !== 1 || writes.length !== 1) return abstain('multiple-packet-wire-mixins', `${reads.length} read-side and ${writes.length} write-side injections on ${cls} — their order on the wire is not derivable`, rows)
    const [r] = reads; const [w] = writes
    if (!r.anchor || !w.anchor) return abstain('unknown-anchor', `injection point not understood (read at ${r.at || '?'}, write at ${w.at || '?'})`, rows)
    if (r.anchor !== w.anchor) return abstain('anchor-mismatch', `read side extends at ${r.anchor}, write side at ${w.anchor}`, rows)
    if (!r.fields.length || !w.fields.length) return abstain('no-primitives', 'the injection bodies write/read no buffer primitive this walk recognises', rows)
    if (r.fields.join(',') !== w.fields.join(',')) return abstain('field-mismatch', `read side [${r.fields.join(',')}] vs write side [${w.fields.join(',')}]`, rows)
    // the guard: a write conditioned on a jar flag ((){Z} before any primitive) armed by a clientbound read's (Z)V setter
    const guardCall = w.preCalls.find((c) => c.op === 0xb8 && /^\(\)Z$/.test(c.desc) && !isBuf(c.owner) && !/^(?:java|org\/apache|org\/spongepowered)\//.test(c.owner))
    exts.push({
      direction,
      packet,
      packetClass: cls,
      anchor: w.anchor,
      optional: direction === 'toClient' ? r.optional : false,
      fields: w.fields.map((t, i) => ({ name: `packetBodyWire${i}`, type: t, source: 'provider' })),
      source: direction === 'toServer' ? w.source : r.source,
      guard: guardCall ? { className: guardCall.owner, method: guardCall.name, armedBy: null } : null,
      mixin: { className: w.mixin.className, readClass: r.mixin.className, jar: w.mixin.jar, nested: w.mixin.nested || null, write: w.handler, read: r.handler }
    })
  }
  if (!exts.length) return { exts: [], provider: null, abstain: null }
  // guards are armed by a clientbound extension whose read side sets the same class's flag
  for (const ext of exts) {
    if (!ext.guard) continue
    const readRow = packetRows.find((r) => r.side === 'read' && r.owner !== ext.packetClass && r.optional && instructionsSet(r).has(`${ext.guard.className}.(Z)V`))
    if (readRow) { const armed = exts.find((o) => o.packetClass === readRow.owner); if (armed) ext.guard.armedBy = { direction: armed.direction, packet: armed.packet } }
    if (!ext.guard.armedBy) return abstain('guard-not-derivable', `${ext.packetClass}'s write is conditioned on ${ext.guard.className}.${ext.guard.method} and nothing in the jar this walk reads arms it`, packetRows.filter((r) => r.owner === ext.packetClass))
  }
  return { exts, provider: null, abstain: null }
}

// The packets a set of injection rows touches, one entry per owner class (jar-derived names only).
function abstainPackets (rows, table) {
  const out = new Map()
  for (const r of rows || []) {
    if (!r.owner) continue
    if (!out.has(r.owner)) {
      const t = table && table[r.owner]
      const direction = t ? t[0] : (/\/Serverbound[^/]*$/.test(r.owner) ? 'toServer' : (/\/Clientbound[^/]*$/.test(r.owner) ? 'toClient' : null))
      out.set(r.owner, { class: r.owner, direction, packet: t ? t[1] : null, sides: [] })
    }
    const e = out.get(r.owner)
    if (r.side && !e.sides.includes(r.side)) e.sides.push(r.side)
  }
  return [...out.values()]
}

// The same view for derived extensions (the scan-level abstains after pairing succeeded).
function extPackets (exts) { return (exts || []).map((e) => ({ class: e.packetClass, direction: e.direction, packet: e.packet, sides: ['read', 'write'] })) }

// The set of `${owner}.${desc}` setter calls a read handler makes (for guard arming).
function instructionsSet (row) {
  const out = new Set()
  for (const c of row.setterCalls || []) out.add(`${c.owner}.${c.desc}`)
  return out
}

// paths: mods folders and/or jar files. Returns { exts, provider, abstain, jars, mixins, mod }.
function scanPacketBodyWireExtensions (paths, { version } = {}) {
  const jars = listJars(paths)
  const receipts = { jars: jars.length, mixins: [] }
  let result = { exts: [], provider: null, redirect: null, abstain: null, mod: null }
  for (const jarPath of jars) {
    let units
    try { units = collectUnits(jarPath) } catch (err) { debug(`packet-wire scan: unreadable jar ${jarPath} (${err.message})`); continue }
    const aliases = buildAliases(units)
    const load = classLoader(units)
    const mixins = []
    for (const unit of units) {
      for (const e of unit.classes.values()) {
        let parsed
        try { parsed = parseClassFile(zipEntryData(unit.buf, e)) } catch { continue }
        if (!parsed) continue
        const found = scanClass(parsed, aliases, unit, load)
        if (!found) continue
        // setter calls of the read handlers (guard arming) — collected here where the class bytes are at hand
        for (const inj of found.injections) {
          if (inj.side !== 'read') continue
          const rows = instructions(parsed, inj.handler, inj.handlerDesc) || []
          inj.setterCalls = rows.filter((r) => isInvoke(r) && r.op === 0xb8 && /^\(Z\)V$/.test(r.ref.desc)).map((r) => ({ owner: r.ref.owner, name: r.ref.name, desc: r.ref.desc }))
        }
        mixins.push(found)
      }
    }
    if (!mixins.length) continue
    receipts.mixins.push(...mixins.map((m) => ({ className: m.className, jar: m.jar, nested: m.nested, mod: m.mod, injections: m.injections.length })))
    const spec = deriveSpec(mixins, version)
    if (spec.abstain) { result = { ...spec, mod: spec.abstain.mod }; break }
    if (!spec.exts.length) continue
    const wraps = mixins.some((m) => (m.payloadInjections || []).length > 0)
    if (result.exts.length) { result = { exts: [], provider: null, abstain: { reason: 'multiple-packet-wire-mods', detail: `${result.mod?.name || result.jar} and ${path.basename(jarPath)} both extend packet bodies — their order on the wire is not derivable`, packets: extPackets([...result.exts, ...spec.exts]), wraps: wraps || !!result.redirect, mixins: [] }, mod: result.mod }; break }
    const prov = deriveProvider(spec.exts.find((e) => e.direction === 'toServer')?.source || spec.exts[0].source, load, units)
    const mod = mixins.find((m) => m.injections.length && m.mod)?.mod || units[0].mod || null
    if (prov.abstain) { result = { exts: [], provider: null, abstain: { ...prov.abstain, mixins: mixins.map((m) => `${m.className} in ${m.jar}${m.nested ? ` nested ${m.nested}` : ''}`), mod, jar: path.basename(jarPath), packets: extPackets(spec.exts), wraps }, mod }; break }
    const rd = deriveRedirect(mixins, load, prov.provider)
    if (rd.abstain) { result = { exts: [], provider: null, abstain: { ...rd.abstain, mod, jar: path.basename(jarPath), packets: extPackets(spec.exts), wraps: true }, mod }; break }
    result = { exts: spec.exts, provider: prov.provider, redirect: rd.redirect, abstain: null, mod, jar: path.basename(jarPath), nested: spec.exts[0].mixin.nested }
  }
  return { ...result, ...receipts }
}

module.exports = { scanPacketBodyWireExtensions, packetTableFor, PACKET_CLASS_TABLE, LOADER_TRANSPORTS, buildAliases, collectUnits, splitRef, _internals: { scanClass, classLoader, deriveSpec, deriveProvider, deriveRedirect, primsInDeep, modIdentity, abstainPackets } }
