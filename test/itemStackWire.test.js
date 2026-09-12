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

// ---------------------------------------------------------------------------
// HF34 — family 2 of the SAME mechanism: trailing fields around the stack from
// @Inject on readItem/writeItem at RETURN/TAIL/HEAD. Ground truth: the rig
// fixture jar (javac-compiled against Forge 47.3.22 SRG + mixin 0.8.5, the
// exact class that produced the field kick on the HF34 rig) and 33 javac
// variants of the same class (test/fixtures/hf34-injector-variants.json).
describe('HF34 - trailer family (readItem/writeItem @Inject at RETURN/TAIL/HEAD)', function () {
  const os = require('os')
  const { buildJar } = require('./helpers/synthJar')
  const { installItemStackWireRefusal, slotBearingPackets } = require('../src/client/itemStackWireInstall')
  const { sideLayout, describePlacement } = require('../src/client/itemStackWireDerivation')
  const RIG_FIXTURE = path.join(__dirname, 'fixtures', 'hf34fixture-1.0.0.jar')
  const VARIANTS = require('./fixtures/hf34-injector-variants.json').variants
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hf34-wire-'))
  const TOML = 'modLoader="javafml"\nloaderVersion="[47,)"\nlicense="MIT"\n[[mods]]\nmodId="hf34fixture"\nversion="1.0.0"\n'
  const variantJar = (name) => {
    const p = path.join(tmp, `${name}.jar`)
    fs.writeFileSync(p, buildJar([{ name: 'META-INF/mods.toml', data: Buffer.from(TOML) }, { name: 'hf34/fixture/mixin/FriendlyByteBufMixin.class', data: Buffer.from(VARIANTS[name].classB64, 'base64') }]))
    return p
  }
  const FAMILY_TYPE = { boolean: 'bool', byte: 'i8', varint: 'varint', i32: 'i32' }
  const PLACE = { present: { before: false, onAbsent: false, onPresent: true }, absent: { before: false, onAbsent: true, onPresent: false }, both: { before: false, onAbsent: true, onPresent: true }, before: { before: true, onAbsent: false, onPresent: false } }
  const layoutOf = (placement, type = 'bool', width = 1) => {
    const anchor = placement.before ? 'head' : placement.onAbsent && placement.onPresent ? 'tail' : placement.onPresent ? 'presentTail' : 'absentTail'
    const scope = anchor === 'presentTail' ? 'present' : anchor === 'absentTail' ? 'absent' : 'slot'
    return { anchor, placement, width, fields: Array.from({ length: width }, (_, i) => ({ name: `itemStackWire${i}`, type, source: 'trailer', scope })), mixin: { className: 'x', jar: 'y' } }
  }
  const trailerExt = ({ serverbound = null, clientbound = null }) => ({ family: 'trailer', serverbound, clientbound, mixin: { className: 'hf34/fixture/mixin/FriendlyByteBufMixin', jar: 'hf34fixture-1.0.0.jar' } })

  it('the REAL rig fixture (Forge SRG names, RETURN + isEmpty guard on cir.getReturnValue) derives serverbound bool x1 after every present stack, nothing clientbound; stacc stays family 1', () => {
    const r = scanItemStackWireExtensions([RIG_FIXTURE])
    assert.strictEqual(r.abstain, undefined, r.abstain && r.abstain.reason)
    assert.strictEqual(r.ext.family, 'trailer')
    assert.deepStrictEqual(r.ext.serverbound.placement, PLACE.present)
    assert.deepStrictEqual(r.ext.serverbound.fields.map((f) => [f.type, f.source, f.scope]), [['bool', 'trailer', 'present']])
    assert.strictEqual(r.ext.serverbound.anchor, 'presentTail')
    assert.deepStrictEqual(r.ext.serverbound.at, { value: 'RETURN', ordinal: -1 })
    assert.strictEqual(r.ext.clientbound, null)
    assert.strictEqual(r.ext.mixin.jar, 'hf34fixture-1.0.0.jar')
    const stacc = scanItemStackWireExtensions([STACC])
    assert.strictEqual(stacc.ext.family, undefined); assert.strictEqual(stacc.ext.anchor, 'beforeNbt'); assert.strictEqual(stacc.ext.fields[0].source, 'count')
  })

  it('both families in one folder is an honest abstain (never a guess at their order)', () => {
    const r = scanItemStackWireExtensions([RIG_FIXTURE, STACC])
    assert.ok(r.abstain, 'expected abstain'); assert.strictEqual(r.ext, null); assert.strictEqual(r.abstain.serverbound, true)
  })

  describe('placement + width rule per injector (@At x the guard region x the guard receiver), real javac bytes', () => {
    for (const [name, v] of Object.entries(VARIANTS)) {
      const e = v.expect
      it(`${name}: ${e.stop ? 'honest stop /' + e.stop + '/' : `${e.side} ${(e.types || [FAMILY_TYPE[e.family]]).join(',')}${e.width > 1 ? ' x' + e.width : ''} ${describePlacement(e.placement)}`}`, () => {
        const r = scanItemStackWireExtensions([variantJar(name)])
        if (e.stop) {
          assert.ok(r.abstain, 'expected an honest stop'); assert.strictEqual(r.ext, null)
          assert.match(`${r.abstain.reason}: ${r.abstain.detail}`, new RegExp(e.stop))
          assert.ok(r.abstain.mixins[0].startsWith('hf34/fixture/mixin/FriendlyByteBufMixin in '), r.abstain.mixins[0])
        } else {
          assert.strictEqual(r.abstain, undefined, r.abstain && `${r.abstain.reason}: ${r.abstain.detail}`)
          assert.strictEqual(r.ext.family, 'trailer')
          const side = r.ext[e.side]
          assert.ok(side, `no ${e.side} layout`)
          assert.deepStrictEqual(side.placement, e.placement)
          assert.strictEqual(side.width, e.width || 1, 'width = the count of primitive reads under the one condition')
          assert.deepStrictEqual(side.fields.map((f) => f.type), e.types || Array.from({ length: e.width || 1 }, () => FAMILY_TYPE[e.family]))
          assert.ok(side.fields.every((f) => f.source === 'trailer'))
          assert.strictEqual(r.ext[e.side === 'serverbound' ? 'clientbound' : 'serverbound'], null)
        }
      })
    }
  })

  it('the abstain names the side it endangers: a read-side stop is serverbound (clicks would be kicked), a write-side stop is not', () => {
    const a10 = scanItemStackWireExtensions([variantJar('a10_guard_on_EMPTY_not_return_stop')])
    assert.strictEqual(a10.abstain.serverbound, true); assert.strictEqual(a10.abstain.clientbound, false)
    const v13 = scanItemStackWireExtensions([variantJar('v13_writeItem_HEAD_guarded_stop')])
    assert.strictEqual(v13.abstain.serverbound, false); assert.strictEqual(v13.abstain.clientbound, true)
    const v18 = scanItemStackWireExtensions([variantJar('v18_click_packet_ctor_stop')])
    assert.strictEqual(v18.abstain.reason, 'click-packet-mixin'); assert.strictEqual(v18.abstain.serverbound, true)
  })

  describe('exact bytes, 1.20.1 play (the 16-byte vanilla click: absent changed slot @10, present cursor stack @11)', () => {
    const mc = require('minecraft-protocol')
    const vanilla = mc.createSerializer({ state: 'play', isServer: false, version: '1.20.1' })
    const click16 = { windowId: 0, stateId: 12, slot: 38, mouseButton: 0, mode: 0, changedSlots: [{ location: 38, item: { present: false } }], cursorItem: { present: true, itemId: 1255, itemCount: 1, nbtData: undefined } }
    const v = vanilla.createPacketBuffer({ name: 'window_click', params: click16 }).toString('hex')
    assert.strictEqual(v.length, 32)
    const at = (i) => v.slice(i * 2, i * 2 + 2)
    const expected = { present: v + '00', absent: v.slice(0, 22) + '00' + v.slice(22), both: v.slice(0, 22) + '00' + v.slice(22) + '00', before: v.slice(0, 20) + '00' + at(10) + '00' + v.slice(22) }
    const outBytes = (ext, name, params) => compileFor('1.20.1', ext).toServer.createPacketBuffer('packet', { name, params: fillOutgoing(JSON.parse(JSON.stringify(params)), compileFor('1.20.1', ext).fields.toServer) }).toString('hex')
    for (const [name, placement] of Object.entries(PLACE)) {
      it(`serverbound bool ${describePlacement(placement)}: ${expected[name].length / 2} B from 16, zero trailer, clientbound direction untouched`, () => {
        const ext = trailerExt({ serverbound: layoutOf(placement) })
        assert.strictEqual(outBytes(ext, 'window_click', click16), expected[name])
        assert.strictEqual(sideLayout(ext, 'toClient'), null)
        assert.strictEqual(compileFor('1.20.1', ext).fields.toClient.length, 0)
      })
    }
    it('width 2 (a8: two readBoolean under one guard) = 18 B with two zero bytes after the present stack; bool+varint sequence (v19) = 18 B', () => {
      assert.strictEqual(outBytes(trailerExt({ serverbound: layoutOf(PLACE.present, 'bool', 2) }), 'window_click', click16), v + '0000')
      const a8 = scanItemStackWireExtensions([variantJar('a8_RETURN_readBoolean_twice_present')]).ext
      assert.strictEqual(outBytes(a8, 'window_click', click16), v + '0000')
      const v19 = scanItemStackWireExtensions([variantJar('v19_two_families_stop')]).ext
      assert.strictEqual(outBytes(v19, 'window_click', click16), v + '0000')
    })
    it('the field receipt sizes: a no-item click stays 16 B under a present-only trailer; the rig fixture ext writes 17', () => {
      const ext = scanItemStackWireExtensions([RIG_FIXTURE]).ext
      const noItem = { ...click16, cursorItem: { present: false } }
      assert.strictEqual(outBytes(ext, 'window_click', noItem).length / 2, vanilla.createPacketBuffer({ name: 'window_click', params: noItem }).length)
      assert.strictEqual(outBytes(ext, 'window_click', click16).length / 2, 17)
      assert.strictEqual(vanilla.createPacketBuffer({ name: 'window_click', params: click16 }).length, 16, 'nmp\'s shared protocol untouched')
    })
    const mcData = require('minecraft-data')('1.20.1')
    const setSlotId = parseInt(Object.entries(mcData.protocol.play.toClient.types.packet[1][0].type[1].mappings).find(([, n]) => n === 'set_slot')[0], 16)
    const setSlot = (hexBody) => { const b = Buffer.from('00' + hexBody, 'hex'); b[0] = setSlotId; return b }
    const cases = {
      present: { present: '00' + '0c' + '0026' + '01' + 'e709' + '04' + '00' + '01', absent: '00' + '0c' + '0026' + '00' },
      absent: { present: '00' + '0c' + '0026' + '01' + 'e709' + '04' + '00', absent: '00' + '0c' + '0026' + '00' + '01' },
      both: { present: '00' + '0c' + '0026' + '01' + 'e709' + '04' + '00' + '01', absent: '00' + '0c' + '0026' + '00' + '01' },
      before: { present: '00' + '0c' + '0026' + '01' + '01' + 'e709' + '04' + '00', absent: '00' + '0c' + '0026' + '01' + '00' }
    }
    for (const [name, placement] of Object.entries(PLACE)) {
      it(`clientbound bool ${describePlacement(placement)}: set_slot parses present and absent stacks exactly, the trailer value stays on the item, a missing trailer is a PartialReadError`, () => {
        const protos = compileFor('1.20.1', trailerExt({ clientbound: layoutOf(placement) }))
        const des = protos.toClient
        const p = des.parsePacketBuffer('packet', setSlot(cases[name].present))
        assert.strictEqual(p.data.name, 'set_slot'); assert.strictEqual(p.data.params.item.itemId, 1255); assert.strictEqual(p.data.params.item.present, true)
        assert.strictEqual(p.metadata.size, cases[name].present.length / 2 + 1)
        if (placement.onPresent) assert.strictEqual(p.data.params.item.itemStackWire0, true)
        const a = des.parsePacketBuffer('packet', setSlot(cases[name].absent))
        assert.strictEqual(a.data.params.item.present, false); assert.strictEqual(a.metadata.size, cases[name].absent.length / 2 + 1)
        const trailed = name === 'absent' ? cases[name].absent : cases[name].present
        assert.throws(() => des.parsePacketBuffer('packet', setSlot(trailed).subarray(0, -1)), (err) => err.partialReadError === true)
        assert.strictEqual(protos.fields.toServer.length, 0, 'serverbound direction untouched')
      })
    }
    it('clientbound varint x2 (a8d): both trailer values parse as two fields', () => {
      const ext = scanItemStackWireExtensions([variantJar('a8d_writeItem_TAIL_writeVarInt_twice_clientbound')]).ext
      assert.strictEqual(ext.serverbound, null); assert.strictEqual(ext.clientbound.width, 2)
      const p = compileFor('1.20.1', ext).toClient.parsePacketBuffer('packet', setSlot('00' + '0c' + '0026' + '01' + 'e709' + '04' + '00' + '05' + '8001'))
      assert.strictEqual(p.data.params.item.itemStackWire0, 5); assert.strictEqual(p.data.params.item.itemStackWire1, 128)
    })
  })

  describe('install on a REAL minecraft-protocol Client (the r2 deaf-client defect stays closed)', () => {
    const mc = require('minecraft-protocol')
    const keepAlive = () => mc.createSerializer({ state: 'play', isServer: true, version: '1.20.1' }).createPacketBuffer({ name: 'keep_alive', params: { keepAliveId: 42 } })
    const realClient = () => {
      const c = new mc.Client(false, '1.20.1'); c.hideErrors = true; c.state = 'play'
      c.packets = []; c.errors = []
      c.on('packet', (data, meta) => c.packets.push({ name: meta.name, data })); c.on('error', (e) => c.errors.push(e))
      return c
    }
    const cases = {
      serverboundOnly: trailerExt({ serverbound: layoutOf(PLACE.present) }),
      clientboundOnly: trailerExt({ clientbound: layoutOf(PLACE.present, 'varint') }),
      both: trailerExt({ serverbound: layoutOf(PLACE.present, 'bool', 2), clientbound: layoutOf(PLACE.both, 'i8') }),
      rig: scanItemStackWireExtensions([RIG_FIXTURE]).ext
    }
    it('NOT DEAF: a framed keep_alive fires "packet" after every layout is installed; nmp\'s streams and listener counts are exactly its own', () => {
      const bare = realClient()
      const baseline = { desData: bare.deserializer.listenerCount('data'), desError: bare.deserializer.listenerCount('error'), serError: bare.serializer.listenerCount('error') }
      for (const [name, ext] of Object.entries(cases)) {
        const c = realClient(); const ser = c.serializer; const des = c.deserializer
        const receipt = installItemStackWireExtension(c, ext, { log: () => {} })
        assert.strictEqual(receipt.installed, true, name)
        c.deserializer.write(keepAlive())
        assert.strictEqual(c.packets.length, 1, `${name}: keep_alive must reach "packet"`); assert.strictEqual(c.packets[0].name, 'keep_alive')
        assert.strictEqual(c.errors.length, 0, name)
        assert.strictEqual(c.deserializer.listenerCount('data'), baseline.desData, name); assert.strictEqual(c.deserializer.listenerCount('error'), baseline.desError, name); assert.strictEqual(c.serializer.listenerCount('error'), baseline.serError, name)
        assert.strictEqual(c.serializer, ser, name); assert.strictEqual(c.deserializer, des, name)
        assert.strictEqual(receipt.slotPackets.toServer > 0 && receipt.slotPackets.toClient > 0, true)
      }
    })
    it('the live serializer writes the rig trailer (16 -> 17 B window_click); a fresh vanilla client still writes 16', () => {
      const c = realClient(); installItemStackWireExtension(c, cases.rig, { log: () => {} })
      const click16 = { windowId: 0, stateId: 12, slot: 38, mouseButton: 0, mode: 0, changedSlots: [{ location: 38, item: { present: false } }], cursorItem: { present: true, itemId: 1255, itemCount: 1, nbtData: undefined } }
      const chunks = []; c.serializer.on('data', (b) => chunks.push(b))
      c.serializer.write({ name: 'window_click', params: fillOutgoing(click16, cases.rig.serverbound.fields) })
      assert.strictEqual(chunks.length, 1); assert.strictEqual(chunks[0].length, 17) // nmp's serializer emits the unframed packet
      assert.strictEqual(mc.createSerializer({ state: 'play', isServer: false, version: '1.20.1' }).createPacketBuffer({ name: 'window_click', params: click16 }).length, 16)
    })
    it('honest stop => REFUSAL: slot-bearing serverbound packets throw a typed error (never sent), the event fires once per packet, every other packet flows, incoming stays live', () => {
      const c = realClient(); const sent = []; c.write = (name, params) => sent.push(name)
      const abstain = scanItemStackWireExtensions([variantJar('a10_guard_on_EMPTY_not_return_stop')]).abstain
      const refusedEvents = []; c.on('forge_container_click_refused', (e) => refusedEvents.push(e))
      const logs = []
      const receipt = installItemStackWireRefusal(c, abstain, { log: (m) => logs.push(m) })
      assert.strictEqual(receipt.refused, true)
      const vanillaOut = slotBearingPackets(require('minecraft-data')('1.20.1').protocol, 'toServer', 'slot')
      assert.deepStrictEqual(new Set(receipt.packets), vanillaOut); assert.ok(vanillaOut.has('window_click') && vanillaOut.has('set_creative_slot'))
      assert.throws(() => c.write('window_click', {}), (err) => err.code === 'EITEMWIRE_REFUSED' && err.packet === 'window_click' && /other than the one on the wire/.test(err.reason))
      assert.throws(() => c.write('window_click', {}), (err) => err.code === 'EITEMWIRE_REFUSED')
      assert.throws(() => c.write('set_creative_slot', {}), (err) => err.code === 'EITEMWIRE_REFUSED')
      assert.deepStrictEqual(refusedEvents.map((e) => e.packet), ['window_click', 'set_creative_slot'], 'once per packet name')
      c.write('keep_alive', { keepAliveId: 1 }); c.write('chat_message', { message: 'x' })
      assert.deepStrictEqual(sent, ['keep_alive', 'chat_message'])
      assert.strictEqual(receipt.refusals, 3)
      c.deserializer.write(keepAlive()); assert.strictEqual(c.packets.length, 1, 'incoming still parses')
      assert.strictEqual(installItemStackWireRefusal(c, abstain), receipt, 'idempotent')
      assert.ok(logs[0].includes('REFUSED') && logs[0].includes('window_click') && logs[0].includes('other than the one on the wire'))
    })
  })
})
