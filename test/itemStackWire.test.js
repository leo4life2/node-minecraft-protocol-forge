/* eslint-env mocha */
'use strict'
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const { scanItemStackWireExtensions, extendSlotType } = require('../src/client/itemStackWireDerivation')
const { compileFor, fillOutgoing, reconcileIncoming, installItemStackWireExtension } = require('../src/client/itemStackWireInstall')

// Ground truth: stacc-api 1.7.0 (nested in numismatic-overhaul 0.2.18+1.20),
// whose DesyncFixin @Mixin(PacketByteBuf) injects writeInt(count) before
// writeNbt in writeItemStack and @ModifyArg's the ItemStack ctor count with
// readInt() in readItemStack. sha1 e644ef01d03ccb14e8097f2de71808b8e3ada5a7.
const STACC = path.join(__dirname, 'fixtures', 'stacc-api-1.7.0.jar')

describe('HF35 r2 - ItemStack wire-shape derivation', function () {
  it('derives stacc-api\'s i32 count before the nbt from the jar (write+read paired, count pinned by the ctor ModifyArg)', () => {
    const r = scanItemStackWireExtensions([STACC])
    assert.ok(r.ext, JSON.stringify(r))
    assert.strictEqual(r.ext.anchor, 'beforeNbt')
    assert.deepStrictEqual(r.ext.fields.map((f) => [f.type, f.source]), [['i32', 'count']])
    assert.strictEqual(r.ext.mixin.className, 'net/devtech/stacc/mixin/DesyncFixin')
    assert.strictEqual(r.ext.mixin.jar, 'stacc-api-1.7.0.jar')
  })
  it('a mods folder without an item (de)serializer mixin yields NO extension (nothing recalled)', () => {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hf35-nowire-'))
    const r = scanItemStackWireExtensions([dir])
    assert.strictEqual(r.ext, null)
    assert.strictEqual(r.abstain, undefined)
  })
  it('splices the field into 1.20.1\'s slot before nbtData; 1.21.1 (components, no nbt field) -> null', () => {
    const { ext } = scanItemStackWireExtensions([STACC])
    const s = extendSlotType(require('minecraft-data')('1.20.1').protocol.types.slot, ext)
    const inner = s[1][1].type[1].fields.true[1].map((f) => f.name)
    assert.deepStrictEqual(inner, ['itemId', 'itemCount', 'itemStackWire0', 'nbtData'])
    const t121 = require('minecraft-data')('1.21.1').protocol.types
    assert.strictEqual(extendSlotType(t121.Slot || t121.slot, ext), null)
  })
  it('the compiled play protocol writes set_creative_slot with the i32 count (the exact bytes the stacc server decodes) and parses window_items back', () => {
    const { ext } = scanItemStackWireExtensions([STACC])
    const p = compileFor('1.20.1', ext)
    const item = fillOutgoing({ slot: 36, item: { present: true, itemId: 1, itemCount: 1 } }, ext.fields)
    const buf = p.toServer.createPacketBuffer('packet', { name: 'set_creative_slot', params: item })
    assert.strictEqual(buf.toString('hex'), '2b00240101' + '01' + '00000001' + '00')
    const wi = p.toClient.createPacketBuffer('packet', { name: 'window_items', params: { windowId: 0, stateId: 1, items: [{ present: true, itemId: 5, itemCount: -56, itemStackWire0: 200 }], carriedItem: { present: false } } })
    const parsed = p.toClient.parsePacketBuffer('packet', wi)
    reconcileIncoming(parsed.data.params, ext.fields)
    assert.strictEqual(parsed.data.params.items[0].itemCount, 200)
    // vanilla bytes (no i32) are NOT accepted by the extended parser: the lane is exact, not tolerant
    const vanilla = require('minecraft-protocol').createDeserializer({ state: 'play', isServer: false, version: '1.20.1' })
    assert.throws(() => p.toClient.parsePacketBuffer('packet', vanilla.proto.createPacketBuffer('packet', { name: 'window_items', params: { windowId: 0, stateId: 1, items: [{ present: true, itemId: 5, itemCount: 1 }], carriedItem: { present: false } } })))
  })
  it('installs on a client only in the play state, swaps the proto behind nmp\'s streams, never poisons the shared protocol cache', () => {
    const { ext } = scanItemStackWireExtensions([STACC])
    const EventEmitter = require('events')
    const mc = require('minecraft-protocol')
    const client = new EventEmitter()
    client.version = '1.20.1'; client.state = 'login'
    client.serializer = mc.createSerializer({ state: 'login', isServer: false, version: '1.20.1' })
    client.deserializer = mc.createDeserializer({ state: 'login', isServer: false, version: '1.20.1' })
    const seen = []
    client.write = (name, params) => seen.push({ name, params })
    const logs = []
    const receipt = installItemStackWireExtension(client, ext, { log: (m) => logs.push(m) })
    assert.strictEqual(receipt.installed, false)
    const vanillaPlay = mc.createSerializer({ state: 'play', isServer: false, version: '1.20.1' })
    client.state = 'play'
    client.serializer = mc.createSerializer({ state: 'play', isServer: false, version: '1.20.1' })
    client.deserializer = mc.createDeserializer({ state: 'play', isServer: false, version: '1.20.1' })
    client.emit('state', 'play', 'login')
    assert.strictEqual(receipt.installed, true)
    assert.notStrictEqual(client.serializer.proto, vanillaPlay.proto)
    assert.strictEqual(mc.createSerializer({ state: 'play', isServer: false, version: '1.20.1' }).proto, vanillaPlay.proto, 'nmp cache untouched')
    client.write('set_creative_slot', { slot: 36, item: { present: true, itemId: 1, itemCount: 3 } })
    assert.strictEqual(seen[0].params.item.itemStackWire0, 3)
    assert.ok(logs.some((l) => /DesyncFixin/.test(l)))
    assert.strictEqual(installItemStackWireExtension(client, ext), receipt, 'idempotent')
  })

  // HF35 rider (verify-r2 MED-2): the fill/reconcile walks are gated on the
  // slot-bearing packet set derived from the protocol at compile time
  it('derives the slot-bearing packet set structurally (type refs only; a `slot` FIELD NAME is not a slot item)', () => {
    const { ext } = scanItemStackWireExtensions([STACC])
    const p = compileFor('1.20.1', ext)
    assert.deepStrictEqual([...p.slotPackets.toServer].sort(), ['set_creative_slot', 'window_click'])
    assert.deepStrictEqual([...p.slotPackets.toClient].sort(), ['advancements', 'declare_recipes', 'entity_equipment', 'entity_metadata', 'set_slot', 'trade_list', 'window_items', 'world_particles'])
    for (const n of ['pick_item', 'held_item_slot', 'keep_alive', 'position', 'chat_message']) {
      assert.ok(!p.slotPackets.toServer.has(n) && !p.slotPackets.toClient.has(n), `${n} must not be walked`)
    }
  })
  it('walks ONLY slot-bearing packets in both directions (keep_alive/position/chat never enter the walk)', () => {
    const { ext } = scanItemStackWireExtensions([STACC])
    const EventEmitter = require('events')
    const mc = require('minecraft-protocol')
    const client = new EventEmitter()
    client.version = '1.20.1'; client.state = 'play'
    client.serializer = mc.createSerializer({ state: 'play', isServer: false, version: '1.20.1' })
    client.deserializer = mc.createDeserializer({ state: 'play', isServer: false, version: '1.20.1' })
    const seen = []
    client.write = (name, params) => seen.push({ name, params })
    const receipt = installItemStackWireExtension(client, ext, { log: () => {} })
    assert.strictEqual(receipt.installed, true)
    assert.deepStrictEqual(receipt.slotPackets, { toServer: 2, toClient: 8 })
    const ka = { keepAliveId: 42 }
    client.write('keep_alive', ka)
    client.write('position', { x: 1, y: 2, z: 3, onGround: true })
    client.write('chat_message', { message: 'hi', timestamp: 0n, salt: 0n, offset: 0, acknowledged: Buffer.alloc(3) })
    assert.deepStrictEqual(receipt.walks, { outgoing: 0, incoming: 0 })
    assert.strictEqual(seen[0].params, ka, 'slot-free params pass through by identity')
    client.write('set_creative_slot', { slot: 36, item: { present: true, itemId: 1, itemCount: 3 } })
    assert.strictEqual(receipt.walks.outgoing, 1)
    assert.strictEqual(seen[3].params.item.itemStackWire0, 3)
    client.emit('packet', { keepAliveId: 42 }, { state: 'play', name: 'keep_alive' })
    client.emit('packet', { x: 0, y: 0, z: 0 }, { state: 'play', name: 'position' })
    assert.strictEqual(receipt.walks.incoming, 0)
    const wi = { windowId: 0, stateId: 1, items: [{ present: true, itemId: 5, itemCount: -56, itemStackWire0: 200 }], carriedItem: { present: false } }
    client.emit('packet', wi, { state: 'play', name: 'window_items' })
    assert.strictEqual(receipt.walks.incoming, 1)
    assert.strictEqual(wi.items[0].itemCount, 200)
    // login-state traffic is never walked either
    client.state = 'login'
    client.write('set_creative_slot', { slot: 1, item: { present: true, itemId: 1, itemCount: 1 } })
    assert.strictEqual(receipt.walks.outgoing, 1)
  })
})
