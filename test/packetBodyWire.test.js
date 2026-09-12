/* eslint-env mocha */
'use strict'
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { EventEmitter } = require('events')
const { scanPacketBodyWireExtensions, packetTableFor, PACKET_CLASS_TABLE, buildAliases, collectUnits } = require('../src/client/packetBodyWireDerivation')
const { installPacketBodyWireExtension, compileFor, createProvider, tailTypes } = require('../src/client/packetBodyWireInstall')
const { scanItemStackWireExtensions } = require('../src/client/itemStackWireDerivation')
const { installItemStackWireExtension } = require('../src/client/itemStackWireInstall')
const { zipCentralEntries, zipEntryData } = require('../src/client/jarAnalysis')
const { buildJar } = require('./helpers/synthJar')

// Ground truth: Immersive Portals — Fabric 5.2.0 (mc1.20.1; imm_ptl_core +
// q_misc_util nested under META-INF/jars/, intermediary @Mixin targets +
// refmaps) and Forge 3.0.7-all (Mojang names, SimpleChannel transport).
// Both fixtures are the REAL jars trimmed to the entries the walk reads
// (tools/trim-packet-wire-fixture.js): manifests, mixin configs, refmaps,
// the packet mixin classes and the provider classes they reach. The full
// jars derive byte-identically (hf41 receipts).
const FABRIC = path.join(__dirname, 'fixtures', 'immersive-portals-5.2.0-mc1.20.1-fabric.trimmed.jar')
const FORGE = path.join(__dirname, 'fixtures', 'immersive-portals-3.0.7-forge.trimmed.jar')
const STACC = path.join(__dirname, 'fixtures', 'stacc-api-1.7.0.jar')

const MOVES = ['position', 'position_look', 'look', 'flying']

function expectDerived (r, jar) {
  assert.equal(r.abstain, null, JSON.stringify(r.abstain))
  assert.equal(r.exts.length, 5, 'four serverbound move packets + the clientbound position')
  const toServer = r.exts.filter((e) => e.direction === 'toServer').map((e) => e.packet).sort()
  assert.deepEqual(toServer, [...MOVES].sort())
  for (const e of r.exts) {
    assert.equal(e.anchor, 'tail')
    assert.deepEqual(e.fields.map((f) => f.type), ['i32'])
    assert.equal(e.fields[0].source, 'provider')
  }
  const s2c = r.exts.find((e) => e.direction === 'toClient')
  assert.equal(s2c.packet, 'position')
  assert.equal(s2c.optional, true, 'the client ctor reads the int only when bytes remain (isReadable)')
  assert.equal(s2c.packetClass, 'net/minecraft/network/protocol/game/ClientboundPlayerPositionPacket')
  for (const e of r.exts.filter((x) => x.direction === 'toServer')) {
    assert.equal(e.optional, false)
    assert.ok(e.guard, 'the client write is guarded by doesServerHasIP')
    assert.deepEqual(e.guard.armedBy, { direction: 'toClient', packet: 'position' }, 'armed by the clientbound position carrying the value')
  }
  assert.equal(r.provider.kind, 'nbt-int-map')
  assert.equal(r.provider.compoundKey, 'intids')
  assert.equal(r.provider.valueType, 'int')
  assert.equal(r.provider.record, 'qouteall/q_misc_util/dimension/DimensionIdRecord')
  assert.equal(r.provider.source, 'qouteall/q_misc_util/dimension/DimId.writeWorldId')
  assert.equal(r.provider.reader, 'qouteall/q_misc_util/MiscNetworking.processDimSync')
  assert.ok(r.provider.channels.some((c) => c.id === 'imm_ptl:dim_sync' && c.framing === 'raw'), JSON.stringify(r.provider.channels))
  assert.equal(r.jar, path.basename(jar))
}

describe('HF41 packet-body wire derivation (Immersive Portals, real trimmed jars)', function () {
  it('Fabric 5.2.0: nested jar-in-jar walked, intermediary targets resolved through the refmap, 4 serverbound + 1 clientbound i32 tail extensions + the dim_sync provider', function () {
    const r = scanPacketBodyWireExtensions([FABRIC], { version: '1.20.1' })
    expectDerived(r, FABRIC)
    assert.equal(r.nested, 'META-INF/jars/imm_ptl_core-5.2.0.jar', 'found INSIDE the nested imm_ptl_core jar')
    assert.equal(r.mod.id, 'imm_ptl_core')
    assert.deepEqual(r.provider.channels.map((c) => c.id), ['imm_ptl:dim_sync'], 'Fabric: the custom payload channel only')
    const s2c = r.exts.find((e) => e.direction === 'toClient')
    assert.equal(s2c.mixin.readClass, 'qouteall/imm_ptl/core/mixin/client/sync/MixinClientboundPlayerPositionPacket')
    const pos = r.exts.find((e) => e.packet === 'position_look')
    assert.equal(pos.mixin.readClass, 'qouteall/imm_ptl/core/mixin/common/position_sync/MixinServerboundMovePlayerPacketPosRot')
    assert.equal(pos.mixin.nested, 'META-INF/jars/imm_ptl_core-5.2.0.jar')
  })

  it('Forge 3.0.7: Mojang-named targets in the flat jar, the same five extensions, plus the SimpleChannel transport (iputil:messages, u8-index framing) as a provider channel', function () {
    const r = scanPacketBodyWireExtensions([FORGE], { version: '1.20.1' })
    expectDerived(r, FORGE)
    assert.equal(r.nested, null)
    assert.equal(r.mod.id, 'immersive_portals')
    const simple = r.provider.channels.find((c) => c.id === 'iputil:messages')
    assert.ok(simple, JSON.stringify(r.provider.channels))
    assert.equal(simple.framing, 'u8-index')
    assert.equal(simple.loader, 'forge-simplechannel')
    assert.match(simple.from, /forge\/networking\/Message\.register$/)
  })

  it('one mechanism: the Fabric and Forge derivations agree on every packet, field, anchor, guard and provider record', function () {
    const norm = (r) => JSON.stringify(r.exts.map((e) => [e.direction, e.packet, e.anchor, e.optional, e.fields, e.guard && e.guard.armedBy]).sort()) + '|' + JSON.stringify([r.provider.compoundKey, r.provider.valueType, r.provider.record, r.provider.source])
    assert.equal(norm(scanPacketBodyWireExtensions([FABRIC], { version: '1.20.1' })), norm(scanPacketBodyWireExtensions([FORGE], { version: '1.20.1' })))
  })

  it('a mods FOLDER: the extension is found among unrelated jars (stacc-api is an item-stack mixin, not a packet-body one) and a jar-less folder derives nothing', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf41-folder-'))
    fs.copyFileSync(STACC, path.join(dir, 'stacc-api-1.7.0.jar'))
    fs.copyFileSync(FABRIC, path.join(dir, 'immersive-portals.jar'))
    const r = scanPacketBodyWireExtensions([dir], { version: '1.20.1' })
    assert.equal(r.jars, 2)
    assert.equal(r.abstain, null)
    assert.equal(r.exts.length, 5)
    const empty = scanPacketBodyWireExtensions([fs.mkdtempSync(path.join(os.tmpdir(), 'hf41-empty-'))], { version: '1.20.1' })
    assert.deepEqual({ exts: empty.exts, abstain: empty.abstain, provider: empty.provider, jars: empty.jars }, { exts: [], abstain: null, provider: null, jars: 0 })
    const stacc = scanPacketBodyWireExtensions([STACC], { version: '1.20.1' })
    assert.deepEqual({ exts: stacc.exts, abstain: stacc.abstain, mixins: stacc.mixins.length }, { exts: [], abstain: null, mixins: 0 })
  })

  it('refmap resolution: the jar\'s own refmap aligns intermediary classes/methods to Mojang names (class_2828$class_2830 → ServerboundMovePlayerPacket$PosRot, method_11052 → write)', function () {
    const units = collectUnits(FABRIC)
    const al = buildAliases(units)
    assert.equal(al.resolveClass('net/minecraft/class_2828$class_2830'), 'net/minecraft/network/protocol/game/ServerboundMovePlayerPacket$PosRot')
    assert.equal(al.resolveClass('net/minecraft/class_2708'), 'net/minecraft/network/protocol/game/ClientboundPlayerPositionPacket')
    assert.equal(al.resolveMethod('net/minecraft/class_2828$class_2830', 'method_11052'), 'write')
    assert.equal(al.resolveClass('net/minecraft/class_999999'), 'net/minecraft/class_999999', 'unknown stays unknown, never guessed')
  })

  // --- abstains: the fixture with one thing removed, re-zipped (real bytes otherwise) ---
  function rezip (jarPath, dropRe) {
    const rebuild = (buf, depth) => {
      const out = []
      for (const e of zipCentralEntries(buf)) {
        if (dropRe.test(e.name)) continue
        const data = zipEntryData(buf, e)
        if (e.name.endsWith('.jar') && depth < 3) out.push({ name: e.name, data: buildJar(rebuild(data, depth + 1)) })
        else out.push({ name: e.name, data })
      }
      return out
    }
    const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hf41-abstain-')), path.basename(jarPath))
    fs.writeFileSync(outPath, buildJar(rebuild(fs.readFileSync(jarPath), 0)))
    return outPath
  }

  it('abstain (no refmap): the Fabric jar without its refmaps names the intermediary targets it cannot map — nothing installed, never a guess', function () {
    const r = scanPacketBodyWireExtensions([rezip(FABRIC, /refmap.*\.json$/)], { version: '1.20.1' })
    assert.equal(r.exts.length, 0)
    assert.equal(r.abstain.reason, 'no-refmap')
    assert.match(r.abstain.detail, /class_2708/, 'the ctor-injected ClientboundPlayerPositionPacket target is only nameable through the refmap (the move mixins name their Mojang owner in the injector string)')
    assert.equal(r.abstain.mod.id, 'imm_ptl_core', 'the abstain names the mod')
    assert.ok(r.abstain.mixins.length >= 1)
  })

  it('abstain (unpaired read): the server reads a tail int nobody in the jar writes (client write mixins removed) — an honest named stop', function () {
    const r = scanPacketBodyWireExtensions([rezip(FORGE, /mixin\/client\/sync\/MixinServer(b|B)oundMovePlayerPacket(Pos|PosRot|Rot|StatusOnly)\.class$/)], { version: '1.20.1' })
    assert.equal(r.exts.length, 0)
    assert.equal(r.abstain.reason, 'unpaired-read')
    assert.match(r.abstain.detail, /ServerboundMovePlayerPacket\$/)
    assert.equal(r.abstain.mod.id, 'immersive_portals')
  })

  it('abstain (unknown provider): the value source is derived but the record\'s transport reader is gone (MiscNetworking removed) — no channel, no guessed 0', function () {
    const r = scanPacketBodyWireExtensions([rezip(FORGE, /q_misc_util\/MiscNetworking\.class$/)], { version: '1.20.1' })
    assert.equal(r.exts.length, 0)
    assert.equal(r.abstain.reason, 'unknown-value-provider')
    assert.match(r.abstain.detail, /intids/)
    assert.equal(r.abstain.mod.id, 'immersive_portals')
  })

  it('abstain (no provider record at all): DimId removed — the write side calls no primitive the walk can follow', function () {
    const r = scanPacketBodyWireExtensions([rezip(FORGE, /q_misc_util\/dimension\/DimId\.class$/)], { version: '1.20.1' })
    assert.equal(r.exts.length, 0)
    assert.ok(r.abstain, 'abstained')
    assert.ok(['no-primitives', 'unknown-value-provider'].includes(r.abstain.reason), r.abstain.reason)
  })

  it('the packet table is version keyed data: 1.17+ carries the Mojang move/position rows, a pre-1.17 version has none (→ packet-class-not-in-table abstain), and every row names a packet minecraft-data knows', function () {
    const t = packetTableFor('1.20.1')
    assert.deepEqual(t['net/minecraft/network/protocol/game/ServerboundMovePlayerPacket$PosRot'], ['toServer', 'position_look'])
    assert.deepEqual(t['net/minecraft/network/protocol/game/ClientboundPlayerPositionPacket'], ['toClient', 'position'])
    assert.deepEqual(packetTableFor('1.16.5'), {})
    for (const row of PACKET_CLASS_TABLE) {
      for (const [cls, [dir, name]] of Object.entries(row.classes)) {
        const proto = require('minecraft-data')('1.20.1').protocol.play[dir].types
        assert.ok(proto[`packet_${name}`], `${cls} → ${dir}/${name} exists in 1.20.1`)
      }
    }
    const r = scanPacketBodyWireExtensions([FORGE], { version: '1.16.5' })
    assert.equal(r.abstain.reason, 'packet-class-not-in-table')
  })
})

describe('HF41 packet-body wire install (fake client, real protodef compile)', function () {
  const mc = require('minecraft-protocol')
  const nbt = require('prismarine-nbt')
  const S2C_POSITION_39 = Buffer.from('3c401a000000000000c04e00000000000040040000000000000000000000000000000100000000', 'hex') // tapped: vanilla 35 B + int32 0
  const dimSync = (framing) => {
    const body = nbt.writeUncompressed({ type: 'compound', name: '', value: { intids: { type: 'compound', value: { 'minecraft:overworld': { type: 'int', value: 0 }, 'minecraft:the_nether': { type: 'int', value: 1 }, 'minecraft:the_end': { type: 'int', value: 2 } } } } }, 'big')
    return framing === 'u8-index' ? Buffer.concat([Buffer.from([0]), body]) : body
  }
  const mkClient = () => {
    const c = new EventEmitter()
    c.version = '1.20.1'; c.state = 'play'
    c.serializer = mc.createSerializer({ state: 'play', isServer: false, version: '1.20.1' })
    c.deserializer = mc.createDeserializer({ state: 'play', isServer: false, version: '1.20.1' })
    c.writes = []; c.write = (name, params) => c.writes.push({ name, params })
    c.bytes = (i) => c.serializer.proto.createPacketBuffer('packet', c.writes[i])
    c.parse = (buf) => c.deserializer.proto.parsePacketBuffer('packet', buf)
    return c
  }

  for (const [label, fixture, channel, framing] of [['Fabric', FABRIC, 'imm_ptl:dim_sync', 'raw'], ['Forge', FORGE, 'iputil:messages', 'u8-index']]) {
    it(`${label}: the write wrap fills the derived id once armed by the server's extended position; 34→38 B moves; the incoming tail int parses; respawn switches the id; unrelated packets untouched`, function () {
      const spec = scanPacketBodyWireExtensions([fixture], { version: '1.20.1' })
      const c = mkClient(); const logs = []
      const r = installPacketBodyWireExtension(c, spec, { log: (m) => logs.push(m) })
      assert.equal(r.installed, true)
      assert.equal(r.armed, false, 'guarded until the server shows the extension')
      assert.equal(r.swaps, 1)
      c.emit('packet', { channel, data: dimSync(framing) }, { state: 'play', name: 'custom_payload' })
      c.emit('packet', { worldName: 'minecraft:the_nether' }, { state: 'play', name: 'login' })
      assert.equal(r.provider.synced, 1)
      assert.equal(r.provider.channel, channel)
      assert.equal(r.value(), 1)
      // unarmed: vanilla shape, counted
      c.write('position_look', { x: 1, y: 2, z: 3, yaw: 0, pitch: 0, onGround: true })
      assert.equal(c.writes[0].params.packetBodyWire0, undefined)
      assert.equal(c.bytes(0).length, 34)
      assert.equal(r.unfilled, 1)
      // the server's extended position parses (no unread bytes) and arms the write
      const parsed = c.parse(S2C_POSITION_39)
      assert.equal(parsed.metadata.size, 39)
      assert.equal(parsed.data.params.packetBodyWire0, 0)
      c.emit('packet', parsed.data.params, { state: 'play', name: 'position' })
      assert.equal(r.armed, true)
      assert.equal(r.incoming, 1)
      // a vanilla 35 B position still parses (optional tail)
      const vanilla = c.parse(S2C_POSITION_39.subarray(0, 35))
      assert.equal(vanilla.metadata.size, 35)
      assert.equal(vanilla.data.params.packetBodyWire0, null)
      // armed: every move packet carries the id
      c.write('position_look', { x: 1, y: 2, z: 3, yaw: 0, pitch: 0, onGround: true })
      assert.equal(c.writes[1].params.packetBodyWire0, 1)
      const b = c.bytes(1)
      assert.equal(b.length, 38)
      assert.equal(b.subarray(34).toString('hex'), '00000001')
      c.write('flying', { onGround: true })
      assert.equal(c.bytes(2).toString('hex'), '170100000001')
      c.write('position', { x: 1, y: 2, z: 3, onGround: false })
      assert.equal(c.bytes(3).length, 1 + 24 + 1 + 4)
      c.write('look', { yaw: 1, pitch: 2, onGround: false })
      assert.equal(c.bytes(4).length, 1 + 8 + 1 + 4)
      // dimension change → the provider answers the new id
      c.emit('packet', { worldName: 'minecraft:the_end' }, { state: 'play', name: 'respawn' })
      c.write('position_look', { x: 1, y: 2, z: 3, yaw: 0, pitch: 0, onGround: true })
      assert.equal(c.writes[5].params.packetBodyWire0, 2)
      // untouched packets
      c.write('keep_alive', { keepAliveId: 5 })
      assert.deepEqual(c.writes[6].params, { keepAliveId: 5 })
      assert.equal(c.bytes(6).length, 9)
      assert.equal(r.fills, 5)
      assert.match(logs.join('\n'), /play protocol extended: toServer \{position_look,position,look,flying\} toClient \{position\}/)
      assert.match(logs.join('\n'), /armed: the server's position carried the extension/)
      // the receipt names the mod, the jar, the packets and the provider
      assert.equal(r.mod.id, label === 'Fabric' ? 'imm_ptl_core' : 'immersive_portals')
      assert.deepEqual(r.exts.map((e) => `${e.direction}/${e.packet}`).sort(), ['toClient/position', 'toServer/flying', 'toServer/look', 'toServer/position', 'toServer/position_look'])
      // idempotent
      assert.strictEqual(installPacketBodyWireExtension(c, spec), r)
    })
  }

  it('an unknown dimension never becomes a guessed 0: the record lacks the world → vanilla shape + unfilled count + one log line', function () {
    const spec = scanPacketBodyWireExtensions([FABRIC], { version: '1.20.1' })
    const c = mkClient(); const logs = []
    const r = installPacketBodyWireExtension(c, spec, { log: (m) => logs.push(m) })
    c.emit('packet', { channel: 'imm_ptl:dim_sync', data: dimSync('raw') }, { state: 'play', name: 'custom_payload' })
    c.emit('packet', { worldName: 'somemod:unlisted' }, { state: 'play', name: 'login' })
    c.emit('packet', c.parse(S2C_POSITION_39).data.params, { state: 'play', name: 'position' })
    assert.equal(r.armed, true)
    c.write('position_look', { x: 1, y: 2, z: 3, yaw: 0, pitch: 0, onGround: true })
    c.write('position_look', { x: 1, y: 2, z: 3, yaw: 0, pitch: 0, onGround: true })
    assert.equal(c.bytes(0).length, 34)
    assert.equal(r.fills, 0)
    assert.equal(r.unfilled, 2)
    assert.equal(logs.filter((l) => /vanilla shape/.test(l)).length, 1)
  })

  it('a payload on the derived channel that is not the record (another SimpleChannel message) is rejected, not misread', function () {
    const spec = scanPacketBodyWireExtensions([FORGE], { version: '1.20.1' })
    const c = mkClient()
    const r = installPacketBodyWireExtension(c, spec)
    c.emit('packet', { channel: 'iputil:messages', data: Buffer.from([3, 0xde, 0xad, 0xbe, 0xef]) }, { state: 'play', name: 'custom_payload' })
    c.emit('packet', { channel: 'iputil:messages', data: Buffer.concat([Buffer.from([1]), nbt.writeUncompressed({ type: 'compound', name: '', value: { other: { type: 'int', value: 7 } } }, 'big')]) }, { state: 'play', name: 'custom_payload' })
    assert.equal(r.provider.rejected, 2)
    assert.equal(r.provider.synced, 0)
    assert.equal(r.value(), null)
  })

  it('coexists with the HF35 item-stack extension: both compiled into ONE play protocol; set_creative_slot keeps its HF35 bytes, position_look gains the tail', function () {
    const c = mkClient()
    const item = scanItemStackWireExtensions([STACC])
    const ir = installItemStackWireExtension(c, item.ext)
    assert.equal(ir.installed, true)
    const spec = scanPacketBodyWireExtensions([FABRIC], { version: '1.20.1' })
    const r = installPacketBodyWireExtension(c, spec)
    assert.equal(r.installed, true)
    c.emit('packet', { channel: 'imm_ptl:dim_sync', data: dimSync('raw') }, { state: 'play', name: 'custom_payload' })
    c.emit('packet', { worldName: 'minecraft:overworld' }, { state: 'play', name: 'login' })
    c.emit('packet', c.parse(S2C_POSITION_39).data.params, { state: 'play', name: 'position' })
    c.write('set_creative_slot', { slot: 36, item: { present: true, itemId: 1, itemCount: 1 } })
    assert.equal(c.bytes(0).toString('hex'), '2b0024010101' + '00000001' + '00', 'HF35 bytes unchanged')
    c.write('position_look', { x: 1, y: 2, z: 3, yaw: 0, pitch: 0, onGround: true })
    assert.equal(c.bytes(1).length, 38)
    assert.equal(ir.walks.outgoing, 1, 'the item walk still only sees slot packets')
  })

  it('compileFor: an unsupported version/packet shape throws a named error the installer turns into a receipt; the optional-tail codec covers every primitive the walk emits', function () {
    assert.throws(() => compileFor('1.20.1', [{ direction: 'toServer', packet: 'no_such_packet', anchor: 'tail', fields: [{ name: 'x', type: 'i32' }] }]), /packet-shape-unsupported/)
    const t = tailTypes(['i8', 'i16', 'i32', 'i64', 'f32', 'f64', 'bool', 'varint'])
    assert.equal(Object.keys(t.Read).length, 8)
    const b = Buffer.alloc(8)
    assert.equal(t.Write.pbw_tail_varint[1](300, b, 0), 2)
    assert.deepEqual(t.Read.pbw_tail_varint[1](b, 0), { value: 300, size: 2 })
    assert.deepEqual(t.Read.pbw_tail_i32[1](Buffer.alloc(2), 0), { value: null, size: 0 })
    assert.throws(() => tailTypes(['string']), /no optional-tail codec/)
    const c = mkClient()
    const r = installPacketBodyWireExtension(c, { exts: [{ direction: 'toServer', packet: 'nope', anchor: 'tail', fields: [{ name: 'x', type: 'i32' }], mixin: {} }], provider: { kind: 'nbt-int-map', keySource: 'world-key', compoundKey: 'k', valueType: 'int', channels: [{ id: 'a:b', framing: 'raw' }] } })
    assert.equal(r.installed, false)
    assert.match(r.reason, /compile-failed: packet-shape-unsupported/)
    const p = createProvider(new EventEmitter(), { kind: 'nbt-int-map', compoundKey: 'k', valueType: 'int', channels: [] }, {})
    assert.equal(p.value(), null)
  })
})

describe('HF41 payload redirect (Immersive Portals imm_ptl:rd — world packets wrapped in custom_payload)', function () {
  const mc = require('minecraft-protocol')
  const nbt = require('prismarine-nbt')
  const S2C_POSITION_39 = Buffer.from('3c401a000000000000c04e00000000000040040000000000000000000000000000000100000000', 'hex')
  const dimSync = () => nbt.writeUncompressed({ type: 'compound', name: '', value: { intids: { type: 'compound', value: { 'minecraft:overworld': { type: 'int', value: 0 }, 'minecraft:the_nether': { type: 'int', value: -1 } } } } }, 'big')
  const wrap = (dim, packetId, body) => {
    const chan = Buffer.from('imm_ptl:rd')
    const head = Buffer.alloc(8); head.writeInt32BE(dim, 0); head.writeInt32BE(packetId, 4)
    return Buffer.concat([Buffer.from([0x17, chan.length]), chan, head, body])
  }

  for (const [label, fixture] of [['Fabric', FABRIC], ['Forge', FORGE]]) {
    it(`${label}: the redirect is derived — channel imm_ptl:rd from the predicate's constants, header [i32 dimension via the provider record, i32 packet id], inner = a play clientbound packet by id (handed to ClientGamePacketListener)`, function () {
      const r = scanPacketBodyWireExtensions([fixture], { version: '1.20.1' })
      assert.ok(r.redirect, 'redirect derived')
      assert.equal(r.redirect.channel, 'imm_ptl:rd')
      assert.deepEqual(r.redirect.header, [{ type: 'i32', source: 'dimension' }, { type: 'i32', source: 'packetId' }])
      assert.deepEqual(r.redirect.inner, { state: 'play', direction: 'toClient' })
      assert.equal(r.redirect.predicate, 'qouteall/imm_ptl/core/network/PacketRedirection.isPacketIdOfRedirection')
      assert.equal(r.redirect.mixin.className, 'qouteall/imm_ptl/core/mixin/common/networking/MixinClientboundCustomPayloadPacket')
    })
  }

  it('abstain: the redirect predicate class removed → the wrapped world packets could not be followed, so the whole extension abstains by name (a client that moves but never sees a chunk is worse than none)', function () {
    const { zipCentralEntries, zipEntryData } = require('../src/client/jarAnalysis')
    const rebuild = (buf, depth) => zipCentralEntries(buf).filter((e) => !/network\/PacketRedirection\.class$/.test(e.name)).map((e) => ({ name: e.name, data: e.name.endsWith('.jar') && depth < 3 ? buildJar(rebuild(zipEntryData(buf, e), depth + 1)) : zipEntryData(buf, e) }))
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hf41-rd-')), 'ip.jar')
    fs.writeFileSync(out, buildJar(rebuild(fs.readFileSync(FORGE), 0)))
    const r = scanPacketBodyWireExtensions([out], { version: '1.20.1' })
    assert.equal(r.exts.length, 0)
    assert.equal(r.abstain.reason, 'redirect-channel-not-derivable')
    assert.equal(r.abstain.mod.id, 'immersive_portals')
  })

  it('install: a wrapped frame for THIS dimension is parsed as the inner packet (update_time) before nmp sees it; another dimension\'s frame stays custom_payload; the id follows a respawn; counters in the receipt', function () {
    const spec = scanPacketBodyWireExtensions([FORGE], { version: '1.20.1' })
    const c = new EventEmitter()
    c.version = '1.20.1'; c.state = 'play'
    c.serializer = mc.createSerializer({ state: 'play', isServer: false, version: '1.20.1' })
    c.deserializer = mc.createDeserializer({ state: 'play', isServer: false, version: '1.20.1' })
    c.write = () => {}
    const r = installPacketBodyWireExtension(c, spec)
    assert.equal(r.installed, true)
    assert.equal(r.redirect.channel, 'imm_ptl:rd')
    const parse = (b) => c.deserializer.parsePacketBuffer(b)
    const ser = mc.createSerializer({ state: 'play', isServer: true, version: '1.20.1' })
    const timeBody = ser.createPacketBuffer({ name: 'update_time', params: { age: [0, 5], time: [0, 6000] } }).subarray(1) // body without the id
    const UPDATE_TIME = require('minecraft-data')('1.20.1').protocol.play.toClient.types.packet[1][0].type[1].mappings
    const idOf = (name) => parseInt(Object.entries(UPDATE_TIME).find(([, n]) => n === name)[0], 16)
    // no dimension known yet → left as custom_payload
    let p = parse(wrap(0, idOf('update_time'), timeBody))
    assert.equal(p.data.name, 'custom_payload')
    assert.equal(r.redirect.noDimension, 1)
    c.emit('packet', { channel: 'iputil:messages', data: Buffer.concat([Buffer.from([0]), dimSync()]) }, { state: 'play', name: 'custom_payload' })
    c.emit('packet', { worldName: 'minecraft:overworld' }, { state: 'play', name: 'login' })
    p = parse(wrap(0, idOf('update_time'), timeBody))
    assert.equal(p.data.name, 'update_time')
    assert.deepEqual(p.data.params, { age: [0, 5], time: [0, 6000] })
    assert.equal(p.metadata.size, wrap(0, idOf('update_time'), timeBody).length, 'sized as the frame nmp handed over (no partial-packet noise)')
    p = parse(wrap(-1, idOf('update_time'), timeBody))
    assert.equal(p.data.name, 'custom_payload', 'the nether\'s packet is not ours')
    assert.equal(r.redirect.otherDimension, 1)
    // a wrapped position (the mixed clientbound packet) parses through the SAME extended proto: the tail int is read
    p = parse(wrap(0, idOf('position'), S2C_POSITION_39.subarray(1)))
    assert.equal(p.data.name, 'position')
    assert.equal(p.data.params.packetBodyWire0, 0)
    // respawn into the nether → the nether's frames unwrap now
    c.emit('packet', { worldName: 'minecraft:the_nether' }, { state: 'play', name: 'respawn' })
    p = parse(wrap(-1, idOf('update_time'), timeBody))
    assert.equal(p.data.name, 'update_time')
    // an unparseable inner packet (garbage body) stays custom_payload and is counted, never thrown
    p = parse(wrap(-1, idOf('update_time'), Buffer.from([1, 2, 3])))
    assert.equal(p.data.name, 'custom_payload')
    assert.equal(r.redirect.unparsed, 1)
    // an ordinary custom_payload on another channel is untouched
    const other = ser.createPacketBuffer({ name: 'custom_payload', params: { channel: 'minecraft:brand', data: Buffer.from([5, 104, 101, 108, 108, 111]) } })
    assert.equal(parse(other).data.name, 'custom_payload')
    assert.equal(r.redirect.unwrapped, 3)
    assert.deepEqual(r.redirect.names, { update_time: 2, position: 1 })
    // a state change hands nmp a fresh deserializer: the swap re-wraps it
    c.deserializer = mc.createDeserializer({ state: 'play', isServer: false, version: '1.20.1' })
    c.serializer = mc.createSerializer({ state: 'play', isServer: false, version: '1.20.1' })
    c.emit('state', 'play')
    assert.equal(parse(wrap(-1, idOf('update_time'), timeBody)).data.name, 'update_time')
    assert.equal(r.swaps, 2)
  })
})

describe('HF41 r2: identity, abstain rows as data, and the 1.20.2+ install order', function () {
  const { mutateJar, CHAT } = require('./helpers/jarMutate')
  const bend = (name, src, rules) => { const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hf41-r2-')), name); fs.writeFileSync(p, mutateJar(fs.readFileSync(src), rules).buf); return p }

  it('mod identity is loader-aware and the jar\'s own: Forge = mods.toml with the file.jarVersion template resolved from MANIFEST Implementation-Version (3.0.7, never the stale fabric.mod.json 9.0); Fabric = the nested unit\'s fabric.mod.json (5.2.0); no manifest = no version, never a template literal', function () {
    const forge = scanPacketBodyWireExtensions([FORGE], { version: '1.20.1' })
    assert.deepEqual(forge.mod, { id: 'immersive_portals', name: 'Immersive Portals', version: '3.0.7', descriptor: 'META-INF/mods.toml' })
    const fabric = scanPacketBodyWireExtensions([FABRIC], { version: '1.20.1' })
    assert.deepEqual(fabric.mod, { id: 'imm_ptl_core', name: 'Immersive Portals Core', version: '5.2.0', descriptor: 'fabric.mod.json' })
    const noManifest = scanPacketBodyWireExtensions([bend('immersive-portals-nomanifest.jar', FORGE, { drop: (p) => p === 'META-INF/MANIFEST.MF' })], { version: '1.20.1' })
    assert.deepEqual(noManifest.mod, { id: 'immersive_portals', name: 'Immersive Portals', version: null, descriptor: 'META-INF/mods.toml' })
    assert.equal(noManifest.exts.length, 5, 'the derivation itself does not need the manifest')
  })

  it('an abstain carries its rows as data (owner class → table direction/packet, injected sides) + whether the jar wraps world packets: chat unpaired, chat paired (untabled), moves unpaired, no refmap', function () {
    const C = scanPacketBodyWireExtensions([bend('C-chat-unpaired-forge.jar', FORGE, CHAT.unpaired)], { version: '1.20.1' })
    assert.equal(C.abstain.reason, 'unpaired-read')
    assert.deepEqual(C.abstain.packets, [{ class: 'net/minecraft/network/protocol/game/ServerboundChatPacket', direction: 'toServer', packet: null, sides: ['read'] }])
    assert.equal(C.abstain.wraps, true)
    assert.equal(C.abstain.mod.version, '3.0.7')
    const C2 = scanPacketBodyWireExtensions([bend('C2-chat-paired-forge.jar', FORGE, CHAT.paired)], { version: '1.20.1' })
    assert.equal(C2.abstain.reason, 'packet-class-not-in-table')
    assert.deepEqual(C2.abstain.packets.map((p) => [p.direction, p.packet, p.sides.sort().join('+')]), [['toServer', null, 'read+write']])
    const U = scanPacketBodyWireExtensions([bend('unpaired.jar', FORGE, { drop: (p) => /mixin\/client\/sync\/MixinServer(b|B)oundMovePlayerPacket(Pos|PosRot|Rot|StatusOnly)\.class$/.test(p) })], { version: '1.20.1' })
    assert.equal(U.abstain.reason, 'unpaired-read')
    assert.deepEqual(U.abstain.packets, [{ class: 'net/minecraft/network/protocol/game/ServerboundMovePlayerPacket$Pos', direction: 'toServer', packet: 'position', sides: ['read'] }])
    const E = scanPacketBodyWireExtensions([bend('norefmap.jar', FABRIC, { drop: (p) => /refmap.*\.json$/.test(p) })], { version: '1.20.1' })
    assert.equal(E.abstain.reason, 'no-refmap')
    const byDir = (d) => E.abstain.packets.filter((p) => p.direction === d).map((p) => p.packet).sort()
    assert.deepEqual(byDir('toServer'), ['flying', 'look', 'position', 'position_look'], 'the resolved move rows ride along')
    assert.deepEqual(E.abstain.packets.filter((p) => !p.direction).map((p) => p.class).sort(), ['net/minecraft/class_2658', 'net/minecraft/class_2708'], 'the intermediary classes the refmap would name')
    assert.equal(E.abstain.wraps, true)
  })

  it('1.20.2+ order: installed in CONFIGURATION (before the item-stack install at play) the play swap recompiles from the CURRENT slot extension — set_creative_slot keeps its HF35 bytes, position_look gains the tail; a later item swap is re-asserted on the next write', function () {
    const mc = require('minecraft-protocol')
    const mkClient = () => {
      const c = new EventEmitter()
      c.version = '1.20.1'; c.state = 'play'
      c.serializer = mc.createSerializer({ state: 'play', isServer: false, version: '1.20.1' })
      c.deserializer = mc.createDeserializer({ state: 'play', isServer: false, version: '1.20.1' })
      c.writes = []; c.write = (name, params) => c.writes.push({ name, params })
      c.bytes = (i) => c.serializer.proto.createPacketBuffer('packet', c.writes[i])
      c.parse = (buf) => c.deserializer.proto.parsePacketBuffer('packet', buf)
      // arm the provider the way the server does: the dimension record on imm_ptl:dim_sync, the login world, the extended s2c position
      c.arm = () => {
        const nbt = require('prismarine-nbt')
        const body = nbt.writeUncompressed({ type: 'compound', name: '', value: { intids: { type: 'compound', value: { 'minecraft:overworld': { type: 'int', value: 0 } } } } })
        c.emit('packet', { channel: 'imm_ptl:dim_sync', data: body }, { state: 'play', name: 'custom_payload' })
        c.emit('packet', { worldName: 'minecraft:overworld' }, { state: 'play', name: 'login' })
        c.emit('packet', c.parse(Buffer.from('3c401a000000000000c04e00000000000040040000000000000000000000000000000100000000', 'hex')).data.params, { state: 'play', name: 'position' })
      }
      return c
    }
    const item = scanItemStackWireExtensions([STACC])
    const spec = scanPacketBodyWireExtensions([FABRIC], { version: '1.20.1' })
    const mk = () => { const c = mkClient(); c.state = 'configuration'; return c }
    // configuration-first (the hook order: item listener registered first, both fire on the play transition)
    const c = mk(); let ir = null
    c.on('state', (s) => { if (s === 'play' && !ir) ir = installItemStackWireExtension(c, item.ext) })
    const r = installPacketBodyWireExtension(c, spec)
    assert.equal(r.installed, false, 'no play protocol yet')
    c.state = 'play'; c.emit('state', 'play')
    assert.equal(ir.installed, true); assert.equal(r.installed, true); assert.equal(r.recompiled, 1, 'compiled once more with the slot extension that landed after the install')
    c.arm()
    c.write('set_creative_slot', { slot: 36, item: { present: true, itemId: 1, itemCount: 1 } })
    assert.equal(c.bytes(0).toString('hex'), '2b0024010101' + '00000001' + '00', 'HF35 bytes kept')
    c.write('position_look', { x: 1, y: 2, z: 3, yaw: 0, pitch: 0, onGround: true })
    assert.equal(c.bytes(1).length, 38)
    assert.equal(ir.walks.outgoing, 1)
    // play-first with a LATE item install (the item hook swapping after ours): the next write re-asserts the merged protocol
    const d = mkClient()
    const r2 = installPacketBodyWireExtension(d, spec)
    assert.equal(r2.installed, true)
    const ir2 = installItemStackWireExtension(d, item.ext)
    assert.equal(ir2.installed, true)
    d.arm()
    d.write('set_creative_slot', { slot: 36, item: { present: true, itemId: 1, itemCount: 1 } })
    d.write('position_look', { x: 1, y: 2, z: 3, yaw: 0, pitch: 0, onGround: true })
    assert.equal(d.bytes(0).toString('hex'), '2b0024010101' + '00000001' + '00', 'HF35 bytes kept after the late item swap')
    assert.equal(d.bytes(1).length, 38, 'the tail kept after the late item swap')
    assert.ok(r2.reasserted >= 1, 'the re-assert is counted in the receipt')
    assert.equal(r2.recompiled, 1)
  })
})

describe('HF41-r: the value key is derived, StreamCodec-era buffer members and non-law injections abstain by name, 1.21.x evidence pinned', function () {
  const { mutateJar } = require('./helpers/jarMutate')
  const { KEY_SOURCES } = require('../src/client/packetBodyWireInstall')
  const FABRIC_121 = path.join(__dirname, 'fixtures', 'immersive-portals-6.0.6-mc1.21.1-fabric.trimmed.jar')
  const bend = (name, src, rules) => { const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hf41-r-')), name); fs.writeFileSync(p, mutateJar(fs.readFileSync(src), rules).buf); return p }

  it('keySource: both 1.20.1 jars derive the getter keyed by ResourceKey<Level> (descriptor + generic Signature) → world-key; the getter descriptor rides the provider spec', function () {
    for (const [f, desc] of [[FABRIC, '(Lnet/minecraft/class_5321;)I'], [FORGE, '(Lnet/minecraft/resources/ResourceKey;)I']]) {
      const r = scanPacketBodyWireExtensions([f], { version: '1.20.1' })
      assert.equal(r.abstain, null)
      assert.equal(r.provider.keySource, 'world-key')
      assert.equal(r.provider.getter, 'getIntId')
      assert.equal(r.provider.getterDesc, desc)
    }
  })

  it('abstain (unknown-value-key): the getter descriptor bent to a String key (record + caller) → a named stop carrying the descriptor; the stale generic Signature never speaks for the changed descriptor', function () {
    const p = bend('immersive-portals-5.2.0-mc1.20.1-fabric.jar', FABRIC, { rewrite: (f, s) => (/q_misc_util\/dimension\/(DimId|DimensionIdRecord)\.class$/.test(f) && s === '(Lnet/minecraft/class_5321;)I' ? '(Ljava/lang/String;)I' : undefined) })
    const r = scanPacketBodyWireExtensions([p], { version: '1.20.1' })
    assert.equal(r.exts.length, 0)
    assert.equal(r.provider, null)
    assert.equal(r.abstain.reason, 'unknown-value-key')
    assert.match(r.abstain.detail, /DimensionIdRecord\.getIntId\(Ljava\/lang\/String;\)I is keyed by String \(signature \(Lnet\/minecraft\/class_5321<Lnet\/minecraft\/class_1937;>;\)I\), not the world the client is in/)
    assert.deepEqual(r.abstain.packets.map((x) => `${x.direction}/${x.packet}`).sort(), ['toClient/position', 'toServer/flying', 'toServer/look', 'toServer/position', 'toServer/position_look'])
    assert.equal(r.abstain.mod.version, '5.2.0')
  })

  it('abstain (unknown-value-key): the same descriptor but a Signature keyed by another registry (ResourceKey<class_1959>) → named, the signature in the receipt', function () {
    const p = bend('immersive-portals-5.2.0-mc1.20.1-fabric.jar', FABRIC, { rewrite: (f, s) => (/DimensionIdRecord\.class$/.test(f) && s === '(Lnet/minecraft/class_5321<Lnet/minecraft/class_1937;>;)I' ? '(Lnet/minecraft/class_5321<Lnet/minecraft/class_1959;>;)I' : undefined) })
    const r = scanPacketBodyWireExtensions([p], { version: '1.20.1' })
    assert.equal(r.abstain.reason, 'unknown-value-key')
    assert.match(r.abstain.detail, /is keyed by ResourceKey<class_1959> \(signature \(Lnet\/minecraft\/class_5321<Lnet\/minecraft\/class_1959;>;\)I\)/)
  })

  it('install: the provider selects the key by the derived keySource and never assumes the world name — a spec without a known keySource installs nothing (named reason); world-key answers after login/respawn', function () {
    const spec = { kind: 'nbt-int-map', compoundKey: 'k', valueType: 'int', channels: [] }
    const nbt = require('prismarine-nbt')
    const body = nbt.writeUncompressed({ type: 'compound', name: '', value: { k: { type: 'compound', value: { 'minecraft:overworld': { type: 'int', value: 4 } } } } }, 'big')
    for (const [keySource, expect] of [['world-key', 4], [undefined, null], ['entity-id', null]]) {
      const c = new EventEmitter(); const receipt = {}
      const p = createProvider(c, { ...spec, keySource, channels: [{ id: 'a:b', framing: 'raw' }] }, receipt)
      c.emit('packet', { channel: 'a:b', data: body }, { state: 'play', name: 'custom_payload' })
      c.emit('packet', { worldName: 'minecraft:overworld' }, { state: 'play', name: 'login' })
      assert.equal(p.value(), expect, `keySource ${keySource}`)
      assert.equal(receipt.provider.keySource, expect == null ? null : 'world-key')
    }
    assert.deepEqual(Object.keys(KEY_SOURCES), ['world-key'])
    const r = installPacketBodyWireExtension(new EventEmitter(), { exts: [{ direction: 'toServer', packet: 'position', anchor: 'tail', fields: [{ name: 'x', type: 'i32' }], mixin: {} }], provider: { ...spec, keySource: 'entity-id', record: 'a/B', getter: 'g', getterDesc: '(I)I' }, version: '1.20.1' })
    assert.equal(r.installed, false)
    assert.equal(r.reason, 'unknown-value-key-source: entity-id (a/B.g(I)I)')
  })

  it('1.21.1 evidence (Immersive Portals 6.0.6, real trimmed jar): the refmap resolves to the tabled classes, the injections ARE the read/write/ctor law, but the buffer members are ResourceKey read/write (method_44112 / method_44116) — a NAMED stop with the members, never a silent vanilla shape', function () {
    const r = scanPacketBodyWireExtensions([FABRIC_121], { version: '1.21.1' })
    assert.equal(r.exts.length, 0)
    assert.equal(r.provider, null)
    assert.equal(r.abstain.reason, 'buffer-member-not-derivable')
    assert.equal(r.abstain.detail, 'ClientboundPlayerPositionPacket: the read side calls FriendlyByteBuf.method_44112(ResourceKey) on the packet buffer; the write side calls FriendlyByteBuf.method_44116(ResourceKey) on the packet buffer — not a wire primitive this build can follow')
    assert.deepEqual(r.abstain.packets, [{ class: 'net/minecraft/network/protocol/game/ClientboundPlayerPositionPacket', direction: 'toClient', packet: 'position', sides: ['read', 'write'] }])
    assert.deepEqual(r.abstain.mod, { id: 'immersive_portals', name: 'Immersive Portals', version: '6.0.6', descriptor: 'fabric.mod.json' })
    assert.equal(r.abstain.mixins.length, 2)
    assert.ok(r.abstain.mixins.every((m) => /ClientboundPlayerPositionPacket\)/.test(m)), r.abstain.mixins.join(' | '))
    // the serverbound move mixins of the same jar are resolved table classes with law targets (the walk got there; the stop is the members, not the table)
    const units = collectUnits(FABRIC_121); const aliases = buildAliases(units); const load = require('../src/client/packetBodyWireDerivation')._internals.classLoader(units)
    const { scanClass } = require('../src/client/packetBodyWireDerivation')._internals
    const { parseClassFile } = require('../src/client/jarAnalysis')
    const owners = new Set()
    for (const u of units) for (const e of u.classes.values()) { let p; try { p = parseClassFile(zipEntryData(u.buf, e)) } catch { continue } const f = p && scanClass(p, aliases, u, load); if (f) for (const i of f.injections) owners.add(`${i.owner.split('/').pop()}.${i.target}`) }
    for (const o of ['ServerboundMovePlayerPacket$Pos.write', 'ServerboundMovePlayerPacket$Pos.read', 'ServerboundMovePlayerPacket$PosRot.write', 'ServerboundMovePlayerPacket$StatusOnly.read']) assert.ok(owners.has(o), o)
  })

  it('abstain (packet-target-not-derivable): a tabled packet class whose only injections are outside the law (Pos write/read renamed to a codec member) → named with the member and injector; the jar with no injection into any tabled class stays exts=[]', function () {
    const p = bend('immersive-portals-3.0.7-all.jar', FORGE, { rewrite: (f, s) => (/ServerboundMovePlayerPacket\$Pos;(write|read)\(/.test(s) ? s.replace(/;(write|read)\(/, ';codec(') : undefined) })
    const r = scanPacketBodyWireExtensions([p], { version: '1.20.1' })
    assert.equal(r.exts.length, 0)
    assert.equal(r.abstain.reason, 'packet-target-not-derivable')
    assert.match(r.abstain.detail, /^ServerboundMovePlayerPacket\$Pos\.codec\(Lnet\/minecraft\/network\/FriendlyByteBuf;\)V receives a @Inject from qouteall\/imm_ptl\/core\/mixin\/client\/sync\/MixinServerboundMovePlayerPacketPos; ServerboundMovePlayerPacket\$Pos\.codec\(/)
    assert.match(r.abstain.detail, /not the read\/write\/ctor law this build follows/)
    assert.deepEqual(r.abstain.packets, [{ class: 'net/minecraft/network/protocol/game/ServerboundMovePlayerPacket$Pos', direction: 'toServer', packet: 'position', sides: [] }])
    assert.equal(r.abstain.mod.version, '3.0.7')
    const stacc = scanPacketBodyWireExtensions([STACC], { version: '1.20.1' })
    assert.deepEqual({ exts: stacc.exts, abstain: stacc.abstain }, { exts: [], abstain: null })
  })
})
