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

function tailTypeName (type) { return `pbw_tail_${type}` }

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
    const add = ext.fields.map((f) => ({ name: f.name, type: ext.anchor === 'head' ? f.type : tailTypeName(f.type) }))
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

// The derived provider: parses the record the server syncs (an NBT compound
// with a `compoundKey` map of dimension name -> value on one of the derived
// channels, with the channel's framing) and answers the value for the
// dimension this client is in (login / respawn world name).
function createProvider (client, spec, receipt) {
  const state = { ids: null, dimension: null, channel: null, framing: null, index: null, rejected: 0, synced: 0 }
  receipt.provider = { kind: spec.kind, compoundKey: spec.compoundKey, valueType: spec.valueType, channels: spec.channels.map((c) => c.id), synced: 0, rejected: 0, channel: null, dimension: null, ids: null }
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
    else if ((meta.name === 'login' || meta.name === 'respawn') && data && typeof data.worldName === 'string') { state.dimension = data.worldName; receipt.provider.dimension = data.worldName }
  })
  return {
    value: () => (state.ids && state.dimension != null && Number.isFinite(state.ids[state.dimension]) ? state.ids[state.dimension] : null),
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
function installPacketBodyWireExtension (client, spec, { log = debug } = {}) {
  if (!client || !spec || !spec.exts || !spec.exts.length) return { installed: false, reason: 'no-extension' }
  if (client.minepalPacketBodyWire) return client.minepalPacketBodyWire
  const receipt = {
    installed: false,
    version: client.version,
    swaps: 0,
    armed: false,
    exts: spec.exts.map((e) => ({ direction: e.direction, packet: e.packet, packetClass: e.packetClass, anchor: e.anchor, optional: e.optional, fields: e.fields.map((f) => f.type), guard: e.guard ? `${e.guard.className}.${e.guard.method} armed by ${e.guard.armedBy.direction}/${e.guard.armedBy.packet}` : null })),
    mixin: spec.exts[0].mixin,
    mod: spec.mod || null,
    jar: spec.jar || null,
    fills: 0,
    unfilled: 0,
    incoming: 0,
    lastIncoming: null
  }
  client.minepalPacketBodyWire = receipt
  if (!spec.provider) { receipt.reason = 'no-value-provider'; return receipt }
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
  const provider = createProvider(client, spec.provider, receipt)
  const guarded = spec.exts.filter((e) => e.direction === 'toServer' && e.guard && e.guard.armedBy)
  receipt.armed = guarded.length === 0
  const unwrap = spec.redirect ? redirectUnwrapper(spec.redirect, protos, provider, receipt) : null
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
      `(derived from ${spec.mod?.name || spec.jar}: ${spec.exts[0].mixin?.className} in ${spec.jar}${spec.exts[0].mixin?.nested ? ` nested ${spec.exts[0].mixin.nested}` : ''}; value = ${spec.provider.compoundKey}[dimension] synced on ${spec.provider.channels.map((c) => c.id).join(' | ')}` +
      (spec.redirect ? `; world packets wrapped in custom_payload ${spec.redirect.channel} [${spec.redirect.header.map((h) => h.source).join(',')}] are unwrapped for this dimension` : '') + ')')
  }
  client.on('state', swap)
  swap()
  let warnedUnfilled = false
  const write = client.write.bind(client)
  client.write = (name, params) => {
    if (client.state === 'play' && client.serializer && client.serializer.proto !== protos.toServer) swap() // a later swap by another install: re-assert the merged protocol before the bytes go out
    if (client.state === 'play' && protos.outgoing.has(name)) {
      const ext = protos.outgoing.get(name)
      const v = receipt.armed ? provider.value() : null
      if (v == null) {
        receipt.unfilled += 1
        if (!warnedUnfilled && receipt.armed) { warnedUnfilled = true; log(`[packet-wire] ${name} sent in the vanilla shape: the provider has no ${spec.provider.compoundKey} value for ${provider.state.dimension ?? 'an unknown dimension'} yet (synced ${provider.state.synced}x)`) }
      } else {
        params = { ...(params || {}) }
        for (const f of ext.fields) params[f.name] = v
        receipt.fills += 1
        receipt.lastFill = { packet: name, value: v, dimension: provider.state.dimension }
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
      log(`[packet-wire] armed: the server's ${meta.name} carried the extension (value ${v}); movement packets now carry the derived ${spec.provider.compoundKey} value`)
    }
  })
  receipt.value = () => provider.value()
  // two bounded receipt lines (30 s and 120 s after install): what was filled, what was unwrapped, what was not
  for (const ms of [30000, 120000]) {
    const t = setTimeout(() => {
      const rd = receipt.redirect
      log(`[packet-wire] receipt +${ms / 1000}s: armed=${receipt.armed} fills=${receipt.fills} unfilled=${receipt.unfilled} incoming=${receipt.incoming} provider={synced:${provider.state.synced},dimension:${provider.state.dimension},value:${provider.value()}}` +
        (rd ? ` redirect={unwrapped:${rd.unwrapped},otherDimension:${rd.otherDimension},unparsed:${rd.unparsed},noDimension:${rd.noDimension},top:${Object.entries(rd.names).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([n, c]) => n + ':' + c).join(',')}}` : ''))
    }, ms)
    if (t.unref) t.unref()
  }
  return receipt
}

module.exports = { installPacketBodyWireExtension, compileFor, createProvider, tailTypes, redirectUnwrapper }
