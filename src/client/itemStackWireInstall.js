'use strict'

const debug = require('debug')('minecraft-protocol-forge')
const { extendSlotType } = require('./itemStackWireDerivation')

// HF35 r2 — installs a jar-derived ItemStack wire extension (see
// itemStackWireDerivation) on one client: the play-state serializer and
// deserializer get a protocol compiled from minecraft-data's own definition
// with the `slot` type extended at the derived anchor, so every slot-bearing
// packet in both directions carries the extra bytes the server's mixin
// expects (set_creative_slot is no longer kicked at the server's decoder;
// window_items parses again). Compiled per (version, spec) and swapped in by
// replacing the protodef `proto` behind nmp's stream objects on the play
// state — the streams, pipes and nmp's own error handling stay untouched, and
// nmp's process-wide protocol cache is never poisoned for other connections.
//
// Outgoing: an item this client writes (mineflayer's toNotch shape: present,
// itemId, itemCount, nbtData) is completed with the extension's 'count'
// fields from its own itemCount before serialization. Incoming: a wide count
// that disagrees with the i8 count (a stack above 127) replaces it, so the
// inventory truth is the mod's, not the overflowed byte.

const compiled = new Map() // `${version}|${specKey}` -> { toServer, toClient }

function compileFor (version, ext) {
  const key = `${version}|${JSON.stringify(ext)}`
  if (compiled.has(key)) return compiled.get(key)
  const mcData = require('minecraft-data')(version)
  const slotName = mcData.protocol.types.slot ? 'slot' : (mcData.protocol.types.Slot ? 'Slot' : null)
  const extended = slotName ? extendSlotType(mcData.protocol.types[slotName], ext) : null
  if (!extended) { compiled.set(key, null); return null }
  const protocol = JSON.parse(JSON.stringify(mcData.protocol))
  protocol.types[slotName] = extended
  const { ProtoDefCompiler } = require('protodef').Compiler
  const nbt = require('prismarine-nbt')
  const minecraftTypes = require('minecraft-protocol/src/datatypes/compiler-minecraft')
  const build = (direction) => {
    const compiler = new ProtoDefCompiler()
    compiler.addTypes(minecraftTypes)
    compiler.addProtocol(protocol, ['play', direction])
    nbt.addTypesToCompiler('big', compiler)
    return compiler.compileProtoDefSync()
  }
  const out = {
    toServer: build('toServer'),
    toClient: build('toClient'),
    slotName,
    // the packet names (per direction) whose type tree reaches the slot type:
    // the ONLY packets the fill/reconcile walks ever look at
    slotPackets: { toServer: slotBearingPackets(protocol, 'toServer', slotName), toClient: slotBearingPackets(protocol, 'toClient', slotName) }
  }
  compiled.set(key, out)
  return out
}

// Derive, from the (extended) protocol JSON, the set of play packet names in
// `direction` whose type tree transitively contains `slotName`. A protodef
// type expression is either a bare string (a type reference) or
// [typeName, args]; inside args only the `type`/`countType`/`default` values,
// the values of a switch's `fields`, and an `option`'s bare argument are type
// references - field NAMES (a `slot` varint field is not a `slot` item) and
// compareTo/mappings strings are not, so the walk is structural, not textual.
function slotBearingPackets (protocol, direction, slotName) {
  const local = protocol.play[direction].types
  const named = (n) => (Object.prototype.hasOwnProperty.call(local, n) ? local[n] : protocol.types[n])
  const reach = new Map() // type name -> boolean (reaches slotName)
  const TYPE_KEYS = new Set(['type', 'countType', 'default'])
  const refs = (node, acc, isType) => {
    if (typeof node === 'string') { if (isType) acc.add(node); return acc }
    if (Array.isArray(node)) {
      if (node.length === 2 && typeof node[0] === 'string') { acc.add(node[0]); return refs(node[1], acc, true) }
      for (const v of node) refs(v, acc, false)
      return acc
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (TYPE_KEYS.has(k)) refs(v, acc, true)
        else if (k === 'fields' && v && typeof v === 'object' && !Array.isArray(v)) for (const t of Object.values(v)) refs(t, acc, true)
        else refs(v, acc, false)
      }
    }
    return acc
  }
  const reaches = (name, seen) => {
    if (name === slotName) return true
    if (reach.has(name)) return reach.get(name)
    if (seen.has(name)) return false
    seen.add(name)
    const def = named(name)
    let hit = false
    if (def !== undefined && def !== 'native') {
      for (const r of refs(def, new Set(), true)) if (reaches(r, seen)) { hit = true; break }
    }
    reach.set(name, hit)
    return hit
  }
  const out = new Set()
  const mapper = local.packet && local.packet[1] && local.packet[1].find((f) => f.name === 'params')
  const cases = mapper && mapper.type && mapper.type[1] && mapper.type[1].fields
  for (const [packetName, typeName] of Object.entries(cases || {})) {
    if (reaches(typeName, new Set())) out.add(packetName)
  }
  return out
}

function isItem (o) { return o && typeof o === 'object' && o.present === true && o.itemId != null && o.itemCount != null }

function fillOutgoing (value, fields, depth = 0) {
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || depth > 8) return value
  if (Array.isArray(value)) { for (const v of value) fillOutgoing(v, fields, depth + 1); return value }
  if (isItem(value)) {
    for (const f of fields) if (value[f.name] == null && f.source === 'count') value[f.name] = value.itemCount
  }
  for (const k of Object.keys(value)) fillOutgoing(value[k], fields, depth + 1)
  return value
}

function reconcileIncoming (value, fields, depth = 0) {
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || depth > 8) return
  if (Array.isArray(value)) { for (const v of value) reconcileIncoming(v, fields, depth + 1); return }
  if (isItem(value)) {
    for (const f of fields) {
      if (f.source === 'count' && typeof value[f.name] === 'number' && value[f.name] !== value.itemCount) value.itemCount = value[f.name]
    }
  }
  for (const k of Object.keys(value)) reconcileIncoming(value[k], fields, depth + 1)
}

// Returns the receipt ({ installed, reason }); idempotent per client.
function installItemStackWireExtension (client, ext, { log = debug } = {}) {
  if (!client || !ext) return { installed: false, reason: 'no-extension' }
  if (client.minepalItemStackWire) return client.minepalItemStackWire
  const receipt = { installed: false, ext, version: client.version, swaps: 0, walks: { outgoing: 0, incoming: 0 } }
  client.minepalItemStackWire = receipt
  let protos
  try { protos = compileFor(client.version, ext) } catch (err) {
    receipt.reason = `compile-failed: ${err.message}`
    log(`[item-wire] extension from ${ext.mixin?.className} (${ext.mixin?.jar}) NOT installed: ${receipt.reason}`)
    return receipt
  }
  if (!protos) {
    receipt.reason = `slot-shape-unsupported: ${client.version}'s slot type has no nbt field to anchor the ${ext.anchor} extension`
    log(`[item-wire] extension from ${ext.mixin?.className} (${ext.mixin?.jar}) NOT installed: ${receipt.reason}`)
    return receipt
  }
  const swap = () => {
    if (client.state !== 'play' || !client.serializer || !client.deserializer) return
    if (client.serializer.proto === protos.toServer) return
    client.serializer.proto = protos.toServer
    client.deserializer.proto = protos.toClient
    receipt.swaps += 1
    receipt.installed = true
    log(`[item-wire] play protocol extended: slot += ${ext.fields.map((f) => `${f.type}(${f.source})`).join(',')} ${ext.anchor} ` +
      `(derived from ${ext.mixin?.className} in ${ext.mixin?.jar}${ext.mixin?.nested ? ` nested ${ext.mixin.nested}` : ''})`)
  }
  client.on('state', swap)
  swap()
  // Only slot-bearing packets (derived at compile time from the protocol) are
  // walked; keep_alive / position / chat ... pass through untouched.
  const { toServer: slotOut, toClient: slotIn } = protos.slotPackets
  receipt.slotPackets = { toServer: slotOut.size, toClient: slotIn.size }
  const write = client.write.bind(client)
  client.write = (name, params) => {
    if (client.state === 'play' && slotOut.has(name)) { receipt.walks.outgoing += 1; params = fillOutgoing(params, ext.fields) }
    return write(name, params)
  }
  client.on('packet', (data, meta) => {
    if (meta && meta.state === 'play' && slotIn.has(meta.name)) { receipt.walks.incoming += 1; reconcileIncoming(data, ext.fields) }
  })
  return receipt
}

module.exports = { installItemStackWireExtension, compileFor, fillOutgoing, reconcileIncoming, slotBearingPackets }
