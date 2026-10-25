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
  it('HF112: the varint-array primitive pairs write (writeVarIntArray([I)) and read (readVarIntArray()[I) under one protodef type; the Mojang spellings only (a runtime spelling is column data at scan time)', () => {
    const { WRITE_PRIMS, READ_PRIMS } = require('../src/client/itemStackWireDerivation')
    assert.equal(WRITE_PRIMS['writeVarIntArray:([I)'], 'varint-array')
    assert.equal(READ_PRIMS['readVarIntArray:()[I'], 'varint-array')
    assert.ok(!Object.keys(WRITE_PRIMS).concat(Object.keys(READ_PRIMS)).some((k) => /VarIntArray/.test(k) && /^method_/.test(k)), 'no hardcoded runtime method number for the new primitive')
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

// HF49 — the count REPLACE shape. Ground truth: Bigger Stacks 1.20.1-2026.06.17
// (Forge; sha1 22b4aa9d792413b2597a9aeb6ec55b21b31534cf), whose
// portb.biggerstacks.mixin.vanilla.FriendlyByteBufMixin @Redirects writeByte
// in writeItemStack to writeInt(count), @Redirects readByte in readItem to a
// constant 0 (no buffer read) and @ModifyVariable(STORE, ordinal 0)s the count
// with readInt(). Wire: bool present, varint id, i32 count (REPLACING the i8),
// nbt. The trimmed fixture keeps that mixin class + the jar's own refmap /
// mixin config / manifest. The bent shapes come from a javac fixture
// (test/fixtures/src/hf49): one class per bend, isolated by dropping the rest;
// CtorPin (HF49-r) is the one green javac shape: the ctor-@ModifyArg count pin.
const BIGGER = path.join(__dirname, 'fixtures', 'biggerstacks-1.20.1-2026.06.17.trimmed.jar')
const SHAPES = path.join(__dirname, 'fixtures', 'hf49-count-replace-shapes.jar')
const { mutateJar } = require('./helpers/jarMutate')

describe('HF49 - ItemStack count REPLACE shape (a widened count in place of the i8)', function () {
  const only = (cls) => {
    const { buf } = mutateJar(fs.readFileSync(SHAPES), { drop: (p) => /^fx\/hf49\//.test(p) && p !== `fx/hf49/${cls}.class` })
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hf49-shape-'))
    const jar = path.join(dir, `${cls}.jar`); fs.writeFileSync(jar, buf)
    return jar
  }
  it('derives the i8 -> i32 count replacement from the Bigger Stacks jar (write redirect + read skip + STORE-0 count pin = one pair)', () => {
    const r = scanItemStackWireExtensions([BIGGER])
    assert.ok(r.ext, JSON.stringify(r))
    assert.strictEqual(r.ext.shape, 'replace')
    assert.strictEqual(r.ext.anchor, 'count')
    assert.strictEqual(r.ext.replaces, 'i8')
    assert.deepStrictEqual(r.ext.fields, [{ name: 'itemCount', type: 'i32', source: 'count' }])
    assert.deepStrictEqual(r.ext.mixin, { className: 'portb/biggerstacks/mixin/vanilla/FriendlyByteBufMixin', jar: 'biggerstacks-1.20.1-2026.06.17.trimmed.jar', nested: null, write: 'writeBiggerStackCount', read: 'readStackItemCount', skip: 'doNothing' })
    assert.deepStrictEqual(r.mixins.map((m) => [m.writes, m.reads]), [[1, 2]], 'the skip and the pin are two rows but ONE read half')
  })
  it('the APPEND shape (stacc-api) is untouched: same anchor, fields and mixin, now labelled shape=append', () => {
    const r = scanItemStackWireExtensions([STACC])
    assert.strictEqual(r.ext.shape, 'append')
    assert.strictEqual(r.ext.anchor, 'beforeNbt')
    assert.strictEqual(r.ext.replaces, undefined)
    assert.deepStrictEqual(r.ext.fields, [{ name: 'itemStackWire0', type: 'i32', source: 'count' }])
  })
  it('both jars in one folder = two write halves -> the named multiplicity abstain (never a guessed order)', () => {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hf49-both-'))
    fs.copyFileSync(BIGGER, path.join(dir, 'a.jar')); fs.copyFileSync(STACC, path.join(dir, 'b.jar'))
    const r = scanItemStackWireExtensions([dir])
    assert.strictEqual(r.ext, null)
    assert.strictEqual(r.abstain.reason, 'multiple-item-wire-mixins')
  })
  it('swaps the slot count primitive in place on 1.20.1 (name and position kept); 1.21.1 carries a varint count -> null (honest unsupported)', () => {
    const { ext } = scanItemStackWireExtensions([BIGGER])
    const s = extendSlotType(require('minecraft-data')('1.20.1').protocol.types.slot, ext)
    assert.deepStrictEqual(s[1][1].type[1].fields.true[1].map((f) => [f.name, f.type]), [['itemId', 'varint'], ['itemCount', 'i32'], ['nbtData', 'optionalNbt']])
    const t121 = require('minecraft-data')('1.21.1').protocol.types
    assert.strictEqual(extendSlotType(t121.Slot || t121.slot, ext), null)
  })
  it('the compiled play protocol writes the 9-byte set_creative_slot (i32 count where the i8 was) and parses window_items / set_slot with i32 counts above 127', () => {
    const { ext } = scanItemStackWireExtensions([BIGGER])
    const p = compileFor('1.20.1', ext)
    const item = fillOutgoing({ slot: 36, item: { present: true, itemId: 1, itemCount: 1 } }, ext.fields)
    const buf = p.toServer.createPacketBuffer('packet', { name: 'set_creative_slot', params: item })
    assert.strictEqual(buf.toString('hex'), '2b0024' + '01' + '01' + '00000001' + '00')
    assert.strictEqual(buf.length - 1, 9, 'packet id + a 9-byte body for item id 1 (vanilla 6; the field kick read 7 vs 9 with a 2-byte item id)')
    assert.strictEqual(fillOutgoing({ slot: 36, item: { present: true, itemId: 1, itemCount: 1 } }, ext.fields).item.itemStackWire0, undefined, 'no extra field is ever added')
    const wi = p.toClient.createPacketBuffer('packet', { name: 'window_items', params: { windowId: 0, stateId: 1, items: [{ present: true, itemId: 5, itemCount: 200 }, { present: false }], carriedItem: { present: true, itemId: 6, itemCount: 100000 } } })
    const parsed = p.toClient.parsePacketBuffer('packet', wi)
    reconcileIncoming(parsed.data.params, ext.fields)
    assert.strictEqual(parsed.data.params.items[0].itemCount, 200)
    assert.strictEqual(parsed.data.params.items[1].present, false)
    assert.strictEqual(parsed.data.params.carriedItem.itemCount, 100000)
    const ss = p.toClient.createPacketBuffer('packet', { name: 'set_slot', params: { windowId: 0, stateId: 1, slot: 36, item: { present: true, itemId: 5, itemCount: 4096 } } })
    assert.strictEqual(p.toClient.parsePacketBuffer('packet', ss).data.params.item.itemCount, 4096)
    // the vanilla 7-byte shape is NOT accepted by the replaced parser (exact, not tolerant)
    const vanilla = require('minecraft-protocol').createDeserializer({ state: 'play', isServer: false, version: '1.20.1' })
    assert.throws(() => p.toClient.parsePacketBuffer('packet', vanilla.proto.createPacketBuffer('packet', { name: 'window_items', params: { windowId: 0, stateId: 1, items: [{ present: true, itemId: 5, itemCount: 1 }], carriedItem: { present: false } } })))
  })
  it('installs per client (receipt shape=replace, the log names the swap), the shared nmp protocol cache untouched; 1.21.1 = slot-shape-unsupported naming the replaced primitive', () => {
    const { ext } = scanItemStackWireExtensions([BIGGER])
    const EventEmitter = require('events')
    const mc = require('minecraft-protocol')
    const client = new EventEmitter()
    client.version = '1.20.1'; client.state = 'play'
    client.serializer = mc.createSerializer({ state: 'play', isServer: false, version: '1.20.1' })
    client.deserializer = mc.createDeserializer({ state: 'play', isServer: false, version: '1.20.1' })
    const seen = []
    client.write = (name, params) => seen.push({ name, params })
    const logs = []
    const receipt = installItemStackWireExtension(client, ext, { log: (m) => logs.push(m) })
    assert.strictEqual(receipt.installed, true)
    assert.strictEqual(receipt.shape, 'replace')
    assert.ok(logs.some((l) => /slot itemCount i8 -> i32 \(shape=replace\).*FriendlyByteBufMixin/.test(l)), logs.join('\n'))
    const vanillaPlay = mc.createSerializer({ state: 'play', isServer: false, version: '1.20.1' })
    assert.notStrictEqual(client.serializer.proto, vanillaPlay.proto)
    assert.strictEqual(client.serializer.proto.createPacketBuffer('packet', { name: 'set_creative_slot', params: { slot: 36, item: { present: true, itemId: 1, itemCount: 300 } } }).length - 1, 9)
    const c2 = new EventEmitter(); c2.version = '1.21.1'; c2.state = 'play'
    c2.serializer = mc.createSerializer({ state: 'play', isServer: false, version: '1.21.1' }); c2.deserializer = mc.createDeserializer({ state: 'play', isServer: false, version: '1.21.1' }); c2.write = () => {}
    const r2 = installItemStackWireExtension(c2, ext, { log: () => {} })
    assert.strictEqual(r2.installed, false)
    assert.match(r2.reason, /slot-shape-unsupported: 1\.21\.1's slot type does not carry its count as i8/)
  })
  const bends = [
    ['TwoPrimWrite', 'replace-multi-primitive', /writes 2 primitive\(s\) \[i16,i32\] in place of one i8/],
    ['ReadingRedirect', 'replace-read-not-skipped', /reads is not a provable skip of the i8 — its body is not a constant return \(reads \[i32\]\)/],
    ['HelperRedirect', 'replace-read-not-skipped', /skip is not a provable skip of the i8 — its body is not a constant return \(no recognised primitive read; other ops present\)/],
    ['MismatchedTypes', 'field-mismatch', /write side \[i32\] vs read side \[i16\]/],
    ['NonCountTarget', 'replace-non-count-target', /redirects a bool buffer write/],
    ['WriteOnly', 'multiple-item-wire-mixins', /1 write-side injection\(s\), 0 read-side primitive redirect\(s\) and 0 read-side value injection\(s\)/],
    ['SecondStore', 'replace-non-count-target', /ModifyVariable count \(\(I\)I\) does not pin the stack count \(accepted pins: a @ModifyVariable STORE ordinal-0 \(I\)I handler, or a @ModifyArg on the ItemStack ctor's int argument/]
  ]
  it('HF49-r: the ItemStack ctor @ModifyArg count pin (the HF35 pin) closes the replace pair too -> derives i8 -> i32 (CtorPin)', () => {
    const r = scanItemStackWireExtensions([only('CtorPin')])
    assert.ok(r.ext, JSON.stringify(r))
    assert.strictEqual(r.ext.shape, 'replace')
    assert.strictEqual(r.ext.replaces, 'i8')
    assert.deepStrictEqual(r.ext.fields, [{ name: 'itemCount', type: 'i32', source: 'count' }])
    assert.deepStrictEqual(r.ext.mixin, { className: 'fx/hf49/CtorPin', jar: 'CtorPin.jar', nested: null, write: 'wide', read: 'count', skip: 'skip' })
    const slot = extendSlotType(require('minecraft-data')('1.20.1').protocol.types.slot, r.ext)
    assert.deepStrictEqual(slot[1][1].type[1].fields.true[1].map((f) => [f.name, f.type]), [['itemId', 'varint'], ['itemCount', 'i32'], ['nbtData', 'optionalNbt']])
  })
  for (const [cls, reason, detail] of bends) {
    it(`bent shape ${cls} -> honest named abstain ${reason}`, () => {
      const r = scanItemStackWireExtensions([only(cls)])
      assert.strictEqual(r.ext, null, JSON.stringify(r))
      assert.strictEqual(r.abstain.reason, reason, JSON.stringify(r.abstain))
      assert.match(r.abstain.detail, detail)
      assert.ok(r.abstain.mixins.every((m) => m.startsWith(`fx/hf49/${cls} in ${cls}.jar`)), r.abstain.mixins.join(','))
    })
  }
  it('the real jar bent by the constant pool (readInt -> readShort on the count pin) -> field-mismatch, never a guessed width', () => {
    const { buf } = mutateJar(fs.readFileSync(BIGGER), { rewrite: (p, s) => (/FriendlyByteBufMixin\.class$/.test(p) && s === 'readInt' ? 'readShort' : (/FriendlyByteBufMixin\.class$/.test(p) && s === '()I' ? '()S' : undefined)) })
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hf49-bent-'))
    const jar = path.join(dir, 'bent.jar'); fs.writeFileSync(jar, buf)
    const r = scanItemStackWireExtensions([jar])
    assert.strictEqual(r.ext, null)
    assert.strictEqual(r.abstain.reason, 'field-mismatch')
  })
})

// HF92 — identical mixins collapse to one before the pairing law. Ground
// truth: a 428-mod Forge 1.20.1 (Connector) pack whose mods folder holds
// stacc-api 1.7.0 standalone AND nested inside numismatic-overhaul
// (META-INF/jars/stacc-api-1.7.0.jar; the DesyncFixin class bytes are
// identical, sha256 equal) — the loader loads ONE copy, the HF35 walk saw
// two and abstained (multiple-item-wire-mixins), the vanilla slot went out
// and the server kicked at window_click ("readerIndex(14) + length(4)
// exceeds writerIndex(15)"). The wrapper jar is built here from the
// standalone fixture (the nesting is the only difference).
const { buildJar } = require('./helpers/synthJar')
describe('HF92 - identical item-wire mixins collapse to one (a jar and its nested copy)', function () {
  const sha = (o) => require('crypto').createHash('sha256').update(JSON.stringify(o)).digest('hex')
  const wrapperJar = (dir, name, inner, innerName = 'stacc-api-1.7.0.jar') => {
    const buf = buildJar([
      { name: 'fabric.mod.json', data: Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'wrapper', version: '1.0.0', jars: [{ file: `META-INF/jars/${innerName}` }] })) },
      { name: `META-INF/jars/${innerName}`, data: fs.readFileSync(inner) }
    ])
    const p = path.join(dir, name); fs.writeFileSync(p, buf); return p
  }
  it('d1: the standalone jar + a wrapper nesting the same jar derive the standalone spec (RED on the base: the multiplicity abstain); the receipt names the duplicate', () => {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hf92-two-'))
    fs.copyFileSync(STACC, path.join(dir, 'stacc-api-1.7.0.jar'))
    wrapperJar(dir, 'wrapper-0.2.19.jar', STACC)
    const r = scanItemStackWireExtensions([dir])
    assert.ok(r.ext, JSON.stringify(r.abstain))
    const alone = scanItemStackWireExtensions([STACC])
    const { duplicates, ...mixin } = r.ext.mixin
    assert.deepStrictEqual({ ...r.ext, mixin }, alone.ext, 'the derived spec equals the standalone fixture\'s spec')
    assert.deepStrictEqual(duplicates, [{ jar: 'wrapper-0.2.19.jar', nested: 'META-INF/jars/stacc-api-1.7.0.jar' }])
    assert.deepStrictEqual(r.duplicates, ['net/devtech/stacc/mixin/DesyncFixin in wrapper-0.2.19.jar (nested META-INF/jars/stacc-api-1.7.0.jar) = stacc-api-1.7.0.jar'])
    assert.strictEqual(r.jars, 2)
    assert.deepStrictEqual(r.mixins.map((m) => [m.jar, m.nested, m.duplicate]).sort(), [['stacc-api-1.7.0.jar', null, false], ['wrapper-0.2.19.jar', 'META-INF/jars/stacc-api-1.7.0.jar', true]])
    // the install log names the duplicate; the compiled wire is the standalone one (the 19-byte pickup window_click the server reads)
    const EventEmitter = require('events'); const mc = require('minecraft-protocol')
    const client = new EventEmitter(); client.version = '1.20.1'; client.state = 'play'
    client.serializer = mc.createSerializer({ state: 'play', isServer: false, version: '1.20.1' }); client.deserializer = mc.createDeserializer({ state: 'play', isServer: false, version: '1.20.1' })
    const seen = []; client.write = (name, params) => seen.push({ name, params }); const logs = []
    assert.strictEqual(installItemStackWireExtension(client, r.ext, { log: (m) => logs.push(m) }).installed, true)
    assert.ok(logs.some((l) => /derived from net\/devtech\/stacc\/mixin\/DesyncFixin in stacc-api-1\.7\.0\.jar \(duplicate in wrapper-0\.2\.19\.jar \(nested META-INF\/jars\/stacc-api-1\.7\.0\.jar\)\)/.test(l)), logs.join('\n'))
    client.write('window_click', { windowId: 0, stateId: 1, slot: 36, mouseButton: 0, mode: 0, changedSlots: [{ location: 36, item: { present: false } }], cursorItem: { present: true, itemId: 300, itemCount: 1 } })
    const bytes = client.serializer.proto.createPacketBuffer('packet', seen[0])
    assert.strictEqual(bytes.toString('hex'), '0b0001002400000100240001ac02010000000100')
    assert.strictEqual(bytes.length - 1, 19, 'the vanilla body is 15 (the field kick: readerIndex(14) + length(4) exceeds writerIndex(15)); the derived one carries the i32')
  })
  it('d1 (nested only): the wrapper alone derives too, naming the nested copy as the source (no duplicates key)', () => {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hf92-nested-'))
    wrapperJar(dir, 'wrapper-0.2.19.jar', STACC)
    const r = scanItemStackWireExtensions([dir])
    assert.ok(r.ext, JSON.stringify(r.abstain))
    assert.deepStrictEqual(r.ext.mixin, { ...scanItemStackWireExtensions([STACC]).ext.mixin, jar: 'wrapper-0.2.19.jar', nested: 'META-INF/jars/stacc-api-1.7.0.jar' })
    assert.deepStrictEqual(r.duplicates, [])
  })
  it('d2 CONTROL: two DIFFERENT injections still abstain multiple-item-wire-mixins by name — the same class name with different bytes (a bent copy), and two different mods', () => {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hf92-bent-'))
    fs.copyFileSync(STACC, path.join(dir, 'stacc-api-1.7.0.jar'))
    const { buf } = mutateJar(fs.readFileSync(STACC), { rewrite: (p, s) => (/DesyncFixin\.class$/.test(p) && s === 'readInt' ? 'readShort' : (/DesyncFixin\.class$/.test(p) && s === '()I' ? '()S' : undefined)) })
    const bentDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hf92-bentjar-')); const bent = path.join(bentDir, 'bent.jar'); fs.writeFileSync(bent, buf)
    wrapperJar(dir, 'wrapper-bent.jar', bent)
    const r = scanItemStackWireExtensions([dir])
    assert.strictEqual(r.ext, null)
    assert.strictEqual(r.abstain.reason, 'multiple-item-wire-mixins')
    assert.deepStrictEqual(r.abstain.mixins.slice().sort(), ['net/devtech/stacc/mixin/DesyncFixin in stacc-api-1.7.0.jar', 'net/devtech/stacc/mixin/DesyncFixin in stacc-api-1.7.0.jar', 'net/devtech/stacc/mixin/DesyncFixin in wrapper-bent.jar (nested META-INF/jars/stacc-api-1.7.0.jar)', 'net/devtech/stacc/mixin/DesyncFixin in wrapper-bent.jar (nested META-INF/jars/stacc-api-1.7.0.jar)'])
    assert.deepStrictEqual(r.duplicates, [])
    const two = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hf92-twomods-'))
    fs.copyFileSync(BIGGER, path.join(two, 'a.jar')); fs.copyFileSync(STACC, path.join(two, 'b.jar'))
    assert.strictEqual(scanItemStackWireExtensions([two]).abstain.reason, 'multiple-item-wire-mixins')
  })
  it('d3: the existing fixtures derive byte-identical specs (sha256 of the derived JSON pinned on the base e956c914)', () => {
    assert.strictEqual(sha(scanItemStackWireExtensions([STACC]).ext), '0c3a300cb196228fb9e2b30c2318b038ffbbbdb982e9d0424f8b88b1810bb3f0')
    assert.strictEqual(sha(scanItemStackWireExtensions([BIGGER]).ext), 'aeb5a333829def26a185b1cd12f527475bb8e84727cba6e8f4c2807d90bc76d3')
  })
  it('the vanilla slot-bearing serverbound packets are read from the protocol JSON per version (the refusal seat\'s list; 1.20.1 and 1.21.1 both: window_click + set_creative_slot)', () => {
    const { vanillaSlotBearingPackets } = require('../src/client/itemStackWireInstall')
    for (const v of ['1.20.1', '1.21.1']) {
      const p = vanillaSlotBearingPackets(v)
      assert.deepStrictEqual([...p.toServer].sort(), ['set_creative_slot', 'window_click'], v)
      assert.ok(p.toClient.has('window_items') && p.toClient.has('set_slot'), v)
    }
    assert.strictEqual(vanillaSlotBearingPackets('0.0.0'), null)
  })
})
