'use strict'

const debug = require('debug')('minecraft-protocol-forge')
const { extendSlotType } = require('./itemStackWireDerivation')

// HF41 — installs a jar-derived PACKET-BODY wire extension (see
// packetBodyWireDerivation) on one client, the HF35 way: the play-state
// serializer/deserializer get a protocol compiled from minecraft-data's own
// definition with the affected packet types extended at the derived anchor,
// swapped in by replacing the protodef `proto` behind nmp's stream objects
// (streams, pipes, nmp's error handling and its process-wide protocol cache
// untouched). An item-stack extension already installed on the client is
// carried into the same compiled protocol, so the two coexist.
//
// Outgoing: every affected serverbound packet this client writes (the
// movement packets mineflayer's physics emits) is completed with the value the
// derived PROVIDER answers — the current dimension's int id from the record
// the server synced on its own channel. The write is armed exactly the way the
// mod arms it (the derived guard: after the clientbound extension has been
// seen carrying the value); with no value to give, the vanilla shape is sent
// and the fact is counted (never a guessed 0). Incoming: the affected
// clientbound packet's trailing value parses (no unread bytes) and is kept on
// the packet + the receipt.

const compiled = new Map() // `${version}|${key}` -> protos

// Optional-tail primitives: written only when a value is given, read only
// when bytes remain (the mixin's own `if (buf.isReadable())`), so a packet
// without the value keeps the vanilla shape on both sides.
const FIXED = {
  i8: [1, (b, o) => b.readInt8(o), (v, b, o) => b.writeInt8(v, o)],
  u8: [1, (b, o) => b.readUInt8(o), (v, b, o) => b.writeUInt8(v, o)],
  i16: [2, (b, o) => b.readInt16BE(o), (v, b, o) => b.writeInt16BE(v, o)],
  u16: [2, (b, o) => b.readUInt16BE(o), (v, b, o) => b.writeUInt16BE(v, o)],
  i32: [4, (b, o) => b.readInt32BE(o), (v, b, o) => b.writeInt32BE(v, o)],
  u32: [4, (b, o) => b.readUInt32BE(o), (v, b, o) => b.writeUInt32BE(v, o)],
  i64: [8, (b, o) => b.readBigInt64BE(o), (v, b, o) => b.writeBigInt64BE(BigInt(v), o)],
  f32: [4, (b, o) => b.readFloatBE(o), (v, b, o) => b.writeFloatBE(v, o)],
  f64: [8, (b, o) => b.readDoubleBE(o), (v, b, o) => b.writeDoubleBE(v, o)],
  bool: [1, (b, o) => b.readUInt8(o) !== 0, (v, b, o) => b.writeUInt8(v ? 1 : 0, o)]
}
function varintRead (b, o) { let v = 0; let s = 0; let i = o; for (;;) { if (i >= b.length) return null; const x = b[i++]; v |= (x & 0x7f) << s; if (!(x & 0x80)) return { value: v, size: i - o }; s += 7; if (s > 35) return null } }
function varintSize (v) { let n = 0; v = v >>> 0; do { v >>>= 7; n++ } while (v); return n }
function varintWrite (v, b, o) { v = v >>> 0; do { let x = v & 0x7f; v >>>= 7; if (v) x |= 0x80; b[o++] = x } while (v); return o }

// HF77: the vanilla resource-key string — writeResourceKey(key) = writeResourceLocation(key.location()) =
// writeUtf(location.toString()): a varint byte length + the utf8 bytes (the value is the key string the client stands in).
function utf8Read (b, o) { const len = varintRead(b, o); if (!len || o + len.size + len.value > b.length) return null; return { value: b.toString('utf8', o + len.size, o + len.size + len.value), size: len.size + len.value } }
function utf8Write (v, b, o) { const bytes = Buffer.from(String(v), 'utf8'); o = varintWrite(bytes.length, b, o); bytes.copy(b, o); return o + bytes.length }
function utf8Size (v) { const n = Buffer.byteLength(String(v), 'utf8'); return varintSize(n) + n }
// a head-anchored field rides as the protocol's own type of the same encoding (minecraft's `string` = varint-counted utf8)
const HEAD_TYPES = { 'resource-key': 'string' }

function tailTypeName (type) { return `pbw_tail_${String(type).replace(/-/g, '_')}` } // a protodef type name is a JS identifier (resource-key -> resource_key)

function tailTypes (types) {
  const out = { Read: {}, Write: {}, SizeOf: {} }
  for (const type of new Set(types)) {
    const name = tailTypeName(type)
    if (FIXED[type]) {
      const [size, rd, wr] = FIXED[type]
      out.Read[name] = ['native', (buffer, offset) => (offset + size <= buffer.length ? { value: rd(buffer, offset), size } : { value: null, size: 0 })]
      out.Write[name] = ['native', (value, buffer, offset) => (value == null ? offset : (wr(value, buffer, offset), offset + size))]
      out.SizeOf[name] = ['native', (value) => (value == null ? 0 : size)]
    } else if (type === 'varint') {
      out.Read[name] = ['native', (buffer, offset) => (offset < buffer.length ? (varintRead(buffer, offset) || { value: null, size: 0 }) : { value: null, size: 0 })]
      out.Write[name] = ['native', (value, buffer, offset) => (value == null ? offset : varintWrite(value, buffer, offset))]
      out.SizeOf[name] = ['native', (value) => (value == null ? 0 : varintSize(value))]
    } else if (type === 'varint-array') {
      // HF112: FriendlyByteBuf.writeVarIntArray / readVarIntArray = a varint count then that many varints (protodef array{countType varint, type varint})
      out.Read[name] = ['native', (buffer, offset) => {
        if (offset >= buffer.length) return { value: null, size: 0 }
        const n = varintRead(buffer, offset); if (!n) return { value: null, size: 0 }
        const value = []; let o = offset + n.size
        for (let i = 0; i < n.value; i++) { const x = varintRead(buffer, o); if (!x) return { value: null, size: 0 }; value.push(x.value); o += x.size }
        return { value, size: o - offset }
      }]
      out.Write[name] = ['native', (value, buffer, offset) => { if (value == null) return offset; let o = varintWrite(value.length, buffer, offset); for (const v of value) o = varintWrite(v, buffer, o); return o }]
      out.SizeOf[name] = ['native', (value) => (value == null ? 0 : value.reduce((n, v) => n + varintSize(v), varintSize(value.length)))]
    } else if (type === 'resource-key') {
      out.Read[name] = ['native', (buffer, offset) => (offset < buffer.length ? (utf8Read(buffer, offset) || { value: null, size: 0 }) : { value: null, size: 0 })]
      out.Write[name] = ['native', (value, buffer, offset) => (value == null ? offset : utf8Write(value, buffer, offset))]
      out.SizeOf[name] = ['native', (value) => (value == null ? 0 : utf8Size(value))]
    } else {
      throw new Error(`packet-body wire: no optional-tail codec for ${type}`)
    }
  }
  return out
}

// The compiled play protocols for (version, extensions[, slot extension]).
function compileFor (version, exts, { slotExt = null } = {}) {
  const key = `${version}|${JSON.stringify(exts.map((e) => [e.direction, e.packet, e.anchor, e.fields]))}|${JSON.stringify(slotExt)}`
  if (compiled.has(key)) return compiled.get(key)
  const mcData = require('minecraft-data')(version)
  const protocol = JSON.parse(JSON.stringify(mcData.protocol))
  if (slotExt) {
    const slotName = protocol.types.slot ? 'slot' : (protocol.types.Slot ? 'Slot' : null)
    const extended = slotName ? extendSlotType(protocol.types[slotName], slotExt) : null
    if (extended) protocol.types[slotName] = extended
  }
  const outgoing = new Map(); const incoming = new Map()
  for (const ext of exts) {
    const typeName = `packet_${ext.packet}`
    const t = protocol.play && protocol.play[ext.direction] && protocol.play[ext.direction].types[typeName]
    if (!Array.isArray(t) || t[0] !== 'container' || !Array.isArray(t[1])) throw new Error(`packet-shape-unsupported: ${version} has no container type ${typeName} in play ${ext.direction}`)
    const add = ext.fields.map((f) => ({ name: f.name, type: ext.anchor === 'head' ? (HEAD_TYPES[f.type] || f.type) : tailTypeName(f.type) }))
    if (ext.anchor === 'head') t[1].unshift(...add); else t[1].push(...add)
    ;(ext.direction === 'toServer' ? outgoing : incoming).set(ext.packet, ext)
  }
  const { ProtoDefCompiler } = require('protodef').Compiler
  const nbt = require('prismarine-nbt')
  const minecraftTypes = require('minecraft-protocol/src/datatypes/compiler-minecraft')
  const extra = tailTypes(exts.flatMap((e) => e.fields.map((f) => f.type)))
  const build = (direction) => {
    const compiler = new ProtoDefCompiler()
    compiler.addTypes(minecraftTypes)
    compiler.addTypes(extra)
    compiler.addProtocol(protocol, ['play', direction])
    nbt.addTypesToCompiler('big', compiler)
    return compiler.compileProtoDefSync()
  }
  const idsOf = (direction) => { const m = protocol.play[direction].types.packet[1][0].type[1].mappings; const ids = {}; for (const [hex, name] of Object.entries(m)) ids[name] = parseInt(hex, 16); return ids }
  const out = { toServer: build('toServer'), toClient: build('toClient'), outgoing, incoming, toClientIds: idsOf('toClient') }
  compiled.set(key, out)
  return out
}

// The key the derived record is read by — `spec.keySource`, derived from the
// getter's parameter type. 'world-key' = the world this client is in (login /
// respawn worldName, the same ResourceKey<Level> string the record's map is
// keyed by). A source this table lacks installs nothing (the deriver already
// abstained by name); the installer never assumes the world name.
const KEY_SOURCES = {
  'world-key': (state, receipt, observer) => observer.onKey((key) => { state.dimension = key; receipt.provider.dimension = key })
}

// HF77: WHERE the world key rides in the clientbound login / respawn packet is
// read from the version's own protocol definition (minecraft-data), never
// assumed: the top-level `worldName` string (<= 1.20.4), or the string `name`
// beside `dimension` inside a container-typed field (SpawnInfo, 1.20.5+). The
// path is per version and per packet; a version without either shape yields
// null and the observer learns nothing (the value is never guessed).
const worldKeyPaths = new Map()
function worldKeyFieldOf (version, packet) {
  const key = `${version}|${packet}`
  if (worldKeyPaths.has(key)) return worldKeyPaths.get(key)
  let found = null
  try {
    const protocol = require('minecraft-data')(version).protocol
    const types = protocol.play.toClient.types
    const t = types[`packet_${packet}`]
    const fields = Array.isArray(t) && t[0] === 'container' ? t[1] : []
    found = worldKeyPathIn(fields, (name) => types[name] || (protocol.types || {})[name])
  } catch { found = null }
  worldKeyPaths.set(key, found)
  return found
}
function worldKeyPathIn (fields, typeOf) {
  const direct = fields.find((f) => f.type === 'string' && f.name === 'worldName')
  if (direct) return [direct.name]
  for (const f of fields) {
    const inner = typeof f.type === 'string' ? typeOf(f.type) : f.type
    if (!Array.isArray(inner) || inner[0] !== 'container' || !Array.isArray(inner[1])) continue
    const name = inner[1].find((g) => g.type === 'string' && g.name === 'name')
    if (name && inner[1].some((g) => g.name === 'dimension')) return [f.name, name.name]
  }
  return null
}
// the same two shapes read off the PARSED packet when the version's protocol is not at hand (a client without a version)
function worldKeyIn (data) {
  if (!data || typeof data !== 'object') return null
  if (typeof data.worldName === 'string') return { key: data.worldName, path: ['worldName'] }
  for (const [k, v] of Object.entries(data)) if (v && typeof v === 'object' && typeof v.name === 'string' && 'dimension' in v) return { key: v.name, path: [k, 'name'] }
  return null
}

// THE ONE observer of the world key this client stands in: the login / respawn
// packet's key string at the protocol-derived path — ONE per client, created
// by its first caller and reused by every later one (HF77 r2: the embedder's
// hook observes before login; the install runs after the off-loop scan settles,
// often past login, and reads the key already seen instead of waiting for a
// respawn). Both the int-record provider (its map is keyed by this string) and
// a resource-key field (its value IS this string) read it here; every receipt
// attached names the field and the key.
function createWorldKeyObserver (client, receipt = null) {
  let obs = client.minepalWorldKeyObserver
  if (!obs) {
    const state = { key: null, field: null, seen: 0 }
    const subs = []
    client.on('packet', (data, meta) => {
      if (!meta || (meta.name !== 'login' && meta.name !== 'respawn') || (meta.state && meta.state !== 'play') || !data) return
      const path = client.version ? worldKeyFieldOf(client.version, meta.name) : null
      let key = null; let at = null
      if (path) { let v = data; for (const p of path) v = v == null ? undefined : v[p]; if (typeof v === 'string') { key = v; at = path } } else { const w = worldKeyIn(data); if (w) { key = w.key; at = w.path } }
      if (key == null) return
      state.key = key; state.field = `${meta.name}.${at.join('.')}`; state.seen += 1
      for (const fn of subs) fn(key, state.field)
    })
    obs = {
      key: () => state.key,
      state,
      // a subscriber learns a key already observed at once (an install that runs after login)
      onKey: (fn) => { subs.push(fn); if (state.key != null) fn(state.key, state.field); return true },
      attach: (r) => { r.worldKey = { field: state.field, key: state.key, seen: state.seen }; subs.push((key, field) => Object.assign(r.worldKey, { field, key, seen: state.seen })); return r.worldKey }
    }
    client.minepalWorldKeyObserver = obs
  }
  if (receipt) obs.attach(receipt)
  return obs
}
// the embedder's early call (before login): the observer exists from here on; the install reuses it
function observeWorldKey (client) { return client && typeof client.on === 'function' ? createWorldKeyObserver(client) : null }

// the channel names a minecraft:register frame carries: node-minecraft-protocol's parser delivers string[]
// ('registerarr'); a raw Buffer is Fabric's NUL-separated identifiers
function registerNames (data) {
  if (Array.isArray(data)) return data.map(String).map((n) => n.trim()).filter(Boolean)
  if (Buffer.isBuffer(data)) return data.toString('utf8').split('\0').map((n) => n.trim()).filter(Boolean)
  return []
}
// the channels the server already registered before this install (the embedder's census: an iterable or a function returning one)
function announcedNames (src) {
  try { const v = typeof src === 'function' ? src() : src; return v && typeof v[Symbol.iterator] === 'function' ? [...v].map(String).map((n) => n.trim()).filter(Boolean) : [] } catch { return [] }
}

// The derived provider: parses the record the server syncs (an NBT compound
// with a `compoundKey` map of key -> value on one of the derived channels,
// with the channel's framing) and answers the value for THIS client's key,
// selected by the derived keySource.
function createProvider (client, spec, receipt, observer = null) {
  const state = { ids: null, dimension: null, channel: null, framing: null, index: null, rejected: 0, synced: 0 }
  receipt.provider = { kind: spec.kind, compoundKey: spec.compoundKey, valueType: spec.valueType, keySource: KEY_SOURCES[spec.keySource] ? spec.keySource : null, channels: spec.channels.map((c) => c.id), synced: 0, rejected: 0, channel: null, dimension: null, ids: null }
  const observeKey = KEY_SOURCES[spec.keySource] ? KEY_SOURCES[spec.keySource](state, receipt, observer || createWorldKeyObserver(client, receipt)) : null
  const byId = new Map(spec.channels.map((c) => [c.id, c]))
  const parse = (chan, data) => {
    if (!Buffer.isBuffer(data)) return
    const body = chan.framing === 'u8-index' ? data.subarray(1) : data
    let simplified
    try {
      const nbt = require('prismarine-nbt')
      const parsed = nbt.parseUncompressed(body, 'big')
      simplified = nbt.simplify(parsed)
    } catch { state.rejected += 1; receipt.provider.rejected = state.rejected; return }
    const map = simplified && simplified[spec.compoundKey]
    if (!map || typeof map !== 'object') { state.rejected += 1; receipt.provider.rejected = state.rejected; return }
    const ids = {}
    for (const [k, v] of Object.entries(map)) { const n = typeof v === 'bigint' ? Number(v) : Number(v); if (Number.isFinite(n)) ids[k] = n }
    state.ids = ids; state.channel = chan.id; state.framing = chan.framing; state.index = chan.framing === 'u8-index' ? data[0] : null; state.synced += 1
    Object.assign(receipt.provider, { synced: state.synced, channel: chan.id, framing: chan.framing, index: state.index, ids })
  }
  client.on('packet', (data, meta) => {
    if (!meta || (meta.state !== 'play' && meta.state !== 'configuration')) return
    if (meta.name === 'custom_payload' && data && byId.has(data.channel)) parse(byId.get(data.channel), data.data)
  })
  return {
    value: () => (observeKey && state.ids && state.dimension != null && Number.isFinite(state.ids[state.dimension]) ? state.ids[state.dimension] : null),
    state
  }
}

// Payload-wrapped packets (the derived redirect): a custom_payload frame on the
// redirect channel whose header names THIS client's dimension is replaced by
// the inner vanilla packet it carries before nmp parses it — exactly what the
// mod's mixin does at the packet's construction — so chunks, entities and
// block updates reach mineflayer as themselves. Frames for another dimension
// (portal views) stay custom_payload (mineflayer ignores them).
function redirectUnwrapper (redirect, protos, provider, receipt) {
  const cpId = protos.toClientIds.custom_payload
  const chan = Buffer.from(redirect.channel, 'utf8')
  const headerSize = redirect.header.reduce((n, h) => n + (FIXED[h.type] ? FIXED[h.type][0] : 0), 0)
  if (cpId == null || redirect.header.some((h) => !FIXED[h.type])) return null
  const rd = { unwrapped: 0, otherDimension: 0, unparsed: 0, noDimension: 0, names: {} }
  receipt.redirect = { channel: redirect.channel, header: redirect.header.map((h) => `${h.type}(${h.source})`), ...rd }
  return (buffer) => {
    if (buffer.length < 2 || buffer[0] !== cpId) return null // custom_payload ids < 128 are one varint byte
    let o = 1
    const len = varintRead(buffer, o); if (!len) return null
    o += len.size
    if (len.value !== chan.length || buffer.compare(chan, 0, chan.length, o, o + chan.length) !== 0) return null
    o += chan.length
    if (buffer.length < o + headerSize) return null
    let dimension = null; let packetId = null
    for (const h of redirect.header) {
      const [size, rd0] = FIXED[h.type]
      const v = rd0(buffer, o); o += size
      if (h.source === 'dimension') dimension = v; else if (h.source === 'packetId') packetId = v
    }
    const mine = provider.value()
    if (mine == null) { receipt.redirect.noDimension += 1; return null }
    if (dimension !== mine) { receipt.redirect.otherDimension += 1; return null }
    const idBuf = Buffer.alloc(varintSize(packetId)); varintWrite(packetId, idBuf, 0)
    return { frame: Buffer.concat([idBuf, buffer.subarray(o)]), packetId }
  }
}

// Returns the receipt ({ installed, reason }); idempotent per client.
function installPacketBodyWireExtension (client, spec, { log = debug, announcedChannels = null } = {}) {
  if (!client || !spec || !spec.exts || !spec.exts.length) return { installed: false, reason: 'no-extension' }
  if (client.minepalPacketBodyWire) return client.minepalPacketBodyWire
  const receipt = {
    installed: false,
    version: client.version,
    swaps: 0,
    armed: false,
    exts: spec.exts.map((e) => ({ direction: e.direction, packet: e.packet, packetClass: e.packetClass, anchor: e.anchor, optional: e.optional, fields: e.fields.map((f) => f.type), sources: e.fields.map((f) => f.source || 'provider'), keyEvidence: e.keyEvidence || null, guard: e.guard ? `${e.guard.className}.${e.guard.method} armed by ${armedByLabel(e.guard.armedBy)}` : null })),
    mixin: spec.exts[0].mixin,
    mod: spec.mod || null,
    jar: spec.jar || null,
    fills: 0,
    unfilled: 0,
    incoming: 0,
    lastIncoming: null
  }
  client.minepalPacketBodyWire = receipt
  // HF77: a field's VALUE SOURCE is data on the extension — 'provider' (the int record the server syncs) or 'world-key'
  // (the key string the client stands in); the record provider is required only where a field is sourced from it
  // HF112 (R3): the provider feeds the bytes this client writes - a clientbound-only extension is read off the wire and needs none
  const needsProvider = spec.exts.some((e) => e.direction === 'toServer') && spec.exts.some((e) => e.fields.some((f) => (f.source || 'provider') === 'provider'))
  const usesWorldKey = spec.exts.some((e) => e.fields.some((f) => f.source === 'world-key'))
  receipt.heldMoves = 0
  if (needsProvider && !spec.provider) { receipt.reason = 'no-value-provider'; return receipt }
  if (needsProvider && !KEY_SOURCES[spec.provider.keySource]) { receipt.reason = `unknown-value-key-source: ${spec.provider.keySource ?? 'none'} (${spec.provider.record || '?'}.${spec.provider.getter || '?'}${spec.provider.getterDesc || ''})`; return receipt }
  // the slot extension (HF35) is read at EVERY swap, not baked at install: on
  // 1.20.2+ this install runs in configuration, before the item-stack install
  // at play, so the play swap recompiles from the CURRENT slot extension and
  // never replaces the item hook's protocol with a slot-less one.
  const slotExtNow = () => (client.minepalItemStackWire?.installed ? client.minepalItemStackWire.ext : null)
  let bakedSlot = JSON.stringify(slotExtNow())
  let protos
  try { protos = compileFor(client.version, spec.exts, { slotExt: slotExtNow() }) } catch (err) {
    receipt.reason = `compile-failed: ${err.message}`
    log(`[packet-wire] extension from ${spec.exts[0].mixin?.className} (${spec.jar}) NOT installed: ${receipt.reason}`)
    return receipt
  }
  const observer = createWorldKeyObserver(client, receipt)
  const provider = needsProvider ? createProvider(client, spec.provider, receipt, observer) : null
  const guarded = spec.exts.filter((e) => e.direction === 'toServer' && e.guard && e.guard.armedBy)
  receipt.armed = guarded.length === 0
  const unwrap = spec.redirect && provider ? redirectUnwrapper(spec.redirect, protos, provider, receipt) : null
  const valueWords = () => (usesWorldKey ? `world key the client stands in${observer.state.field ? ` (${observer.state.field})` : ''}${observer.key() != null ? ` = ${observer.key()}` : ''}` : (spec.provider ? `${spec.provider.compoundKey} value` : 'bytes the server writes and this client reads'))
  // HF77: a guard the jar arms by a custom payload (the mod's own config handshake) is armed here by the same payload's
  // arrival, or by the server's register frame naming the handshake's channel (the server declares it runs the mod).
  // HF77 r2: the register frame rides the configuration phase and this install may run after it (the off-loop scan
  // settles late) — the channels the embedder already counted arm the guard at install; the listener covers later frames.
  const armingChannels = guarded.map((e) => e.guard.armedBy).filter((a) => a && a.channel)
  const registerArm = (names) => { const a = armingChannels.find((x) => names.includes(x.reply) || names.includes(x.channel)); return a ? `register ${names.includes(a.reply) ? a.reply : a.channel}` : null }
  const arm = (by, where) => {
    receipt.armed = true; receipt.armedBy = by
    log(`[packet-wire] armed: the server's ${by} (${where}) says it runs the mod; ${spec.exts.filter((e) => e.direction === 'toServer').map((e) => e.packet).join('/')} now carry the derived ${valueWords()}`)
  }
  if (armingChannels.length) {
    const known = announcedNames(announcedChannels)
    const early = known.length ? registerArm(known) : null
    if (early) arm(early, 'announced before this install')
    client.on('packet', (data, meta) => {
      if (receipt.armed || !meta || meta.name !== 'custom_payload' || !data || typeof data.channel !== 'string') return
      let by = armingChannels.some((a) => a.channel === data.channel) ? `payload ${data.channel}` : null
      if (!by && (data.channel === 'minecraft:register' || data.channel === 'REGISTER')) by = registerArm(registerNames(data.data))
      if (!by) return
      arm(by, meta.state)
    })
  }
  const wrapDeserializer = (des) => {
    if (!unwrap || des._pbwRedirect) return
    des._pbwRedirect = true
    const parse = des.parsePacketBuffer.bind(des)
    des.parsePacketBuffer = (buffer) => {
      const un = unwrap(buffer)
      if (!un) return parse(buffer)
      let parsed = null
      try { parsed = parse(un.frame) } catch { parsed = null }
      if (!parsed || !parsed.metadata || parsed.metadata.size !== un.frame.length) { receipt.redirect.unparsed += 1; return parse(buffer) }
      receipt.redirect.unwrapped += 1
      const name = parsed.data && parsed.data.name
      if (name && (receipt.redirect.names[name] != null || Object.keys(receipt.redirect.names).length < 64)) receipt.redirect.names[name] = (receipt.redirect.names[name] || 0) + 1
      parsed.metadata.size = buffer.length
      return parsed
    }
  }
  const swap = () => {
    if (client.state !== 'play' || !client.serializer || !client.deserializer) return
    const slotExt = slotExtNow(); const slotKey = JSON.stringify(slotExt)
    if (slotKey !== bakedSlot) {
      try { protos = compileFor(client.version, spec.exts, { slotExt }); bakedSlot = slotKey; receipt.recompiled = (receipt.recompiled || 0) + 1 } catch (err) {
        receipt.reason = `compile-failed: ${err.message}`
        log(`[packet-wire] extension from ${spec.exts[0].mixin?.className} (${spec.jar}) NOT re-installed with the slot extension: ${receipt.reason}`)
        return
      }
    }
    if (client.serializer.proto === protos.toServer) { wrapDeserializer(client.deserializer); return }
    if (receipt.installed) receipt.reasserted = (receipt.reasserted || 0) + 1 // another install swapped its own protocol in after ours: ours (which carries theirs) goes back
    client.serializer.proto = protos.toServer
    client.deserializer.proto = protos.toClient
    wrapDeserializer(client.deserializer)
    receipt.swaps += 1
    receipt.installed = true
    const names = (m) => [...m.keys()].join(',')
    log(`[packet-wire] play protocol extended: toServer {${names(protos.outgoing)}} toClient {${names(protos.incoming)}} += ${spec.exts[0].fields.map((f) => f.type).join(',')} at ${spec.exts[0].anchor} ` +
      `(derived from ${spec.mod?.name || spec.jar}: ${spec.exts[0].mixin?.className} in ${spec.jar}${spec.exts[0].mixin?.nested ? ` nested ${spec.exts[0].mixin.nested}` : ''}; value = ${provider ? `${spec.provider.compoundKey}[dimension] synced on ${spec.provider.channels.map((c) => c.id).join(' | ')}` : (usesWorldKey ? `the ${valueWords()} as the vanilla resource-key string` : valueWords())}` +
      (spec.redirect ? `; world packets wrapped in custom_payload ${spec.redirect.channel} [${spec.redirect.header.map((h) => h.source).join(',')}] are unwrapped for this dimension` : '') + ')')
  }
  client.on('state', swap)
  swap()
  let warnedUnfilled = false; let warnedHeld = false
  const write = client.write.bind(client)
  client.write = (name, params) => {
    if (client.state === 'play' && client.serializer && client.serializer.proto !== protos.toServer) swap() // a later swap by another install: re-assert the merged protocol before the bytes go out
    if (client.state === 'play' && protos.outgoing.has(name)) {
      const ext = protos.outgoing.get(name)
      const valueOf = (f) => (f.source === 'world-key' ? observer.key() : (provider ? provider.value() : null))
      const values = receipt.armed ? ext.fields.map(valueOf) : ext.fields.map(() => null)
      const missing = values.some((v) => v == null)
      if (missing && receipt.armed && ext.fields.some((f, i) => values[i] == null && f.source === 'world-key')) {
        // HF77: the shape needs the world key and login / respawn has not named it yet — the packet is HELD (dropped;
        // movement is periodic), never sent in a shape the server cannot read, never with a guessed key
        receipt.heldMoves += 1
        if (!warnedHeld) { warnedHeld = true; log(`[packet-wire] ${name} held: the world key is not known yet (no login / respawn carried it at ${worldKeyFieldOf(client.version, 'login')?.join('.') ?? 'a path this protocol names'})`) }
        return undefined
      }
      if (missing) {
        receipt.unfilled += 1
        if (!warnedUnfilled && receipt.armed) { warnedUnfilled = true; log(`[packet-wire] ${name} sent in the vanilla shape: the provider has no ${spec.provider.compoundKey} value for ${provider.state.dimension ?? 'an unknown dimension'} yet (synced ${provider.state.synced}x)`) }
      } else {
        params = { ...(params || {}) }
        ext.fields.forEach((f, i) => { params[f.name] = values[i] })
        receipt.fills += 1
        receipt.lastFill = { packet: name, value: values.length === 1 ? values[0] : values, dimension: provider ? provider.state.dimension : observer.key() }
      }
    }
    return write(name, params)
  }
  client.on('packet', (data, meta) => {
    if (meta && meta.state === 'play' && client.serializer && client.serializer.proto !== protos.toServer) swap()
    if (!meta || meta.state !== 'play' || !protos.incoming.has(meta.name)) return
    const ext = protos.incoming.get(meta.name)
    const v = data ? data[ext.fields[0].name] : null
    if (v == null) return
    receipt.incoming += 1
    receipt.lastIncoming = { packet: meta.name, value: v }
    if (!receipt.armed && guarded.some((e) => e.guard.armedBy.direction === 'toClient' && e.guard.armedBy.packet === meta.name)) {
      receipt.armed = true
      log(`[packet-wire] armed: the server's ${meta.name} carried the extension (value ${v}); ${spec.exts.filter((e) => e.direction === 'toServer').map((e) => e.packet).join('/')} now carry the derived ${valueWords()}`)
    }
  })
  receipt.value = () => (provider ? provider.value() : observer.key())
  // two bounded receipt lines (30 s and 120 s after install): what was filled, what was unwrapped, what was not
  for (const ms of [30000, 120000]) {
    const t = setTimeout(() => {
      const rd = receipt.redirect
      log(`[packet-wire] receipt +${ms / 1000}s: armed=${receipt.armed} fills=${receipt.fills} unfilled=${receipt.unfilled} held=${receipt.heldMoves} incoming=${receipt.incoming} ` + (provider ? `provider={synced:${provider.state.synced},dimension:${provider.state.dimension},value:${provider.value()}}` : `worldKey={field:${observer.state.field},key:${observer.key()}}`) +
        (rd ? ` redirect={unwrapped:${rd.unwrapped},otherDimension:${rd.otherDimension},unparsed:${rd.unparsed},noDimension:${rd.noDimension},top:${Object.entries(rd.names).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([n, c]) => n + ':' + c).join(',')}}` : ''))
    }, ms)
    if (t.unref) t.unref()
  }
  return receipt
}

// the guard's arming as a receipt word: a clientbound extension (direction/packet) or a payload channel (+ its reply)
function armedByLabel (a) { return a ? (a.direction ? `${a.direction}/${a.packet}` : `payload ${a.channel}${a.reply ? ` (reply ${a.reply})` : ''}`) : 'nothing' }

module.exports = { installPacketBodyWireExtension, compileFor, createProvider, createWorldKeyObserver, observeWorldKey, worldKeyFieldOf, tailTypes, redirectUnwrapper, KEY_SOURCES }
