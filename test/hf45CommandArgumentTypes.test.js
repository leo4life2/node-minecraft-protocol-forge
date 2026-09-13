/* eslint-env mocha */
'use strict'

// HF45 — declare_commands boundary + derived command argument-type table.
// THE CLASS (NeoForge 26.2.0.88, bare AND modded): `/config showfile
// <mod: neoforge:modid> <type: neoforge:enum>` puts loader argument types
// numbered after the 57 vanilla parsers into declare_commands; neoforge:enum
// carries a UTF string (the enum class name). The vanilla schema under-reads
// the frame by 72 bytes with no error, rootIndex reads 71 of 41 nodes, and
// minecraft-protocol's chat.js ends the client ("impossible command tree")
// 0.3 s after "joined the game". Rig-captured frame: test/fixtures/
// hf45-declare-commands-neoforge-26.2.hex (492 bytes, modded rig: enum=62,
// modid=63; the bare rig numbers them 57/58).
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const { parseCommandTree, vanillaParserTable, validateStructure } = require('../src/client/commandTreeParser')
const { deriveCommandArgumentTypes } = require('../src/client/commandArgumentTypeDerivation')
const { installCommandArgumentTypes } = require('../src/client/commandArgumentTypeInstall')
const { installDeclareCommandsBoundary, declareCommandsId } = require('../src/client/declareCommandsBoundary')

const FX = path.join(__dirname, 'fixtures')
const FRAME = Buffer.from(fs.readFileSync(path.join(FX, 'hf45-declare-commands-neoforge-26.2.hex'), 'utf8').trim(), 'hex')
const RIG = '/private/tmp/claude-501/-Users-leoli-Desktop-Nemos-minepal-root-minepal-v0/7d543de9-8a73-4a9b-ad7b-62b5856980da/scratchpad/v262/rig/neoforge'
const UNIVERSAL = path.join(RIG, 'libraries/net/neoforged/neoforge/26.2.0.88/neoforge-26.2.0.88-universal.jar')
const itIf = (cond) => (cond ? it : it.skip)
const MODDED_EXT = { parsers: [{ id: 62, name: 'neoforge:enum', fields: [{ name: 'utf0', type: 'string' }] }, { id: 63, name: 'neoforge:modid', fields: [] }] }

function fakeClient (version = '26.2') {
  const c = new EventEmitter()
  c.version = version
  c.state = 'play'
  c.passthrough = 0
  c.deserializer = { parsePacketBuffer: (buf) => { c.passthrough++; return { data: { name: 'other', params: {} }, metadata: { size: buf.length }, buffer: buf, fullBuffer: buf } } }
  return c
}

describe('HF45 commandTreeParser — exact byte accounting', function () {
  it('the 26.2 schema table: 57 vanilla parsers (0..56), properties keyed by parser name', () => {
    const t = vanillaParserTable('26.2')
    assert.strictEqual(t.rows.length, 57); assert.strictEqual(t.maxId, 56); assert.strictEqual(t.keyedByName, true)
    assert.ok(t.names.has('minecraft:message') && t.names.has('brigadier:string'))
  })
  it('the captured NeoForge frame is declare_commands (play 0x10 on 26.2), 492 bytes', () => {
    assert.strictEqual(FRAME.length, 492); assert.strictEqual(FRAME[0], declareCommandsId('26.2'))
  })
  it('RED — vanilla table only: 41/41 nodes read, 72 bytes unconsumed, unknown parser ids 62 + 63, garbage rootIndex 71 -> NOT ok', () => {
    const r = parseCommandTree(FRAME.subarray(1), '26.2', null)
    assert.strictEqual(r.ok, false); assert.strictEqual(r.packet, null)
    assert.strictEqual(r.receipt.nodes_declared, 41); assert.strictEqual(r.receipt.nodes_read, 41)
    assert.strictEqual(r.receipt.bytes_unconsumed, 72); assert.deepStrictEqual([...r.receipt.unknown_parser_ids].sort(), [62, 63])
    assert.strictEqual(r.receipt.root_index, 71); assert.strictEqual(r.receipt.error, null)
  })
  it('GREEN — with the derived table (62 enum -> string, 63 modid -> none): 41/41 nodes, 0 bytes unconsumed, root 0, the enum class name read as the property', () => {
    const r = parseCommandTree(FRAME.subarray(1), '26.2', MODDED_EXT)
    assert.strictEqual(r.ok, true); assert.strictEqual(r.receipt.bytes_unconsumed, 0); assert.strictEqual(r.receipt.root_index, 0)
    assert.deepStrictEqual(r.receipt.unknown_parser_ids, []); assert.deepStrictEqual([...r.receipt.extended_parser_ids].sort(), [62, 63])
    const nodes = r.packet.nodes
    const names = nodes[r.packet.rootIndex].children.map((i) => nodes[i].extraNodeData.name)
    assert.ok(names.includes('config') && names.includes('neoforge') && names.includes('help'), names.join(' '))
    const en = nodes.find((n) => n.extraNodeData && n.extraNodeData.parser === 'neoforge:enum')
    assert.strictEqual(en.extraNodeData.properties.utf0, 'net.neoforged.neoforge.server.command.ConfigCommand$ServerModConfigType')
    assert.strictEqual(nodes.find((n) => n.extraNodeData && n.extraNodeData.parser === 'neoforge:modid').extraNodeData.name, 'mod')
  })
  it('a wrong layout is caught, never trusted: enum declared as void -> unconsumed bytes -> NOT ok (no silent garbage)', () => {
    const r = parseCommandTree(FRAME.subarray(1), '26.2', { parsers: [{ id: 62, name: 'neoforge:enum', fields: [] }, { id: 63, name: 'neoforge:modid', fields: [] }] })
    assert.strictEqual(r.ok, false); assert.ok(r.receipt.bytes_unconsumed !== 0 || r.receipt.error || r.receipt.structure)
  })
  it('a truncated frame is a read failure with nodes_read counted, not a throw', () => {
    const r = parseCommandTree(FRAME.subarray(1, 200), '26.2', MODDED_EXT)
    assert.strictEqual(r.ok, false); assert.ok(/read-failed/.test(r.receipt.error)); assert.ok(r.receipt.nodes_read > 0 && r.receipt.nodes_read < 41)
  })
  it('structure: the same acceptance as minecraft-protocol chat.js (root in range, child cycles rejected)', () => {
    assert.strictEqual(validateStructure([{ children: [1] }, { children: [] }], 0), null)
    assert.ok(/root-index/.test(validateStructure([{ children: [] }], 71)))
    assert.ok(/child-cycle/.test(validateStructure([{ children: [1] }, { children: [0] }], 0)))
    assert.ok(/out-of-range/.test(validateStructure([{ children: [5] }], 0)))
  })
  for (const version of ['26.2', '1.21.1']) {
    it(`vanilla ${version} tree: the boundary parse is byte-identical to minecraft-protocol's own parse (same schema, same shape)`, () => {
      const mc = require('minecraft-protocol')
      const ser = mc.createSerializer({ state: 'play', isServer: true, version, customPackets: {} })
      const des = mc.createDeserializer({ state: 'play', isServer: false, version, customPackets: {} })
      const tree = {
        nodes: [
          { flags: { unused: 0, allows_restricted: 0, has_custom_suggestions: 0, has_redirect_node: 0, has_command: 0, command_node_type: 0 }, children: [1, 3], redirectNode: undefined, extraNodeData: undefined },
          { flags: { unused: 0, allows_restricted: 0, has_custom_suggestions: 0, has_redirect_node: 0, has_command: 0, command_node_type: 1 }, children: [2], redirectNode: undefined, extraNodeData: { name: 'tellraw' } },
          { flags: { unused: 0, allows_restricted: 0, has_custom_suggestions: 0, has_redirect_node: 0, has_command: 1, command_node_type: 2 }, children: [], redirectNode: undefined, extraNodeData: { name: 'message', parser: 'minecraft:message', properties: undefined, suggestionType: undefined } },
          { flags: { unused: 0, allows_restricted: 0, has_custom_suggestions: 0, has_redirect_node: 0, has_command: 1, command_node_type: 2 }, children: [], redirectNode: undefined, extraNodeData: { name: 'n', parser: 'brigadier:integer', properties: { flags: { unused: 0, max_present: 1, min_present: 1 }, min: 1, max: 9 }, suggestionType: undefined } }
        ],
        rootIndex: 0
      }
      const frame = ser.createPacketBuffer({ name: 'declare_commands', params: tree })
      const standard = des.parsePacketBuffer(frame)
      const ours = parseCommandTree(frame.subarray(1), version, null)
      assert.strictEqual(ours.ok, true)
      assert.deepStrictEqual(JSON.parse(JSON.stringify(ours.packet)), JSON.parse(JSON.stringify(standard.data.params)))
      assert.strictEqual(ours.receipt.bytes_unconsumed, 0)
    })
  }
})

describe('HF45 commandArgumentTypeDerivation — layouts from the jars, ids from the wire', function () {
  const FIX = path.join(FX, 'hf45-argument-types.jar')
  itIf(fs.existsSync(UNIVERSAL))('the REAL neoforge 26.2.0.88 universal jar: neoforge:enum -> string (EnumArgument$Info.serializeToNetwork writeUtf), neoforge:modid -> none (SingletonArgumentInfo)', () => {
    const vt = vanillaParserTable('26.2')
    const registry = new Map(vt.rows.map((r) => [r.id, r.name])); registry.set(57, 'neoforge:enum'); registry.set(58, 'neoforge:modid')
    const r = deriveCommandArgumentTypes({ registry, vanillaNames: vt.names, jars: [UNIVERSAL] })
    assert.strictEqual(r.vanilla, 57); assert.deepStrictEqual(r.abstains, [])
    const en = r.derived.find((d) => d.name === 'neoforge:enum'); const mod = r.derived.find((d) => d.name === 'neoforge:modid')
    assert.strictEqual(en.id, 57); assert.deepStrictEqual(en.fields.map((f) => f.type), ['string']); assert.deepStrictEqual(en.source.writes, ['writeUtf'])
    assert.strictEqual(en.source.serializer, 'net/neoforged/neoforge/server/command/EnumArgument$Info'); assert.strictEqual(en.source.evidence, 'namespace')
    assert.strictEqual(mod.id, 58); assert.deepStrictEqual(mod.fields, []); assert.strictEqual(mod.source.kind, 'vanilla-api-no-properties')
    assert.deepStrictEqual(r.extension.parsers.map((p) => p.id), [57, 58])
  })
  it('javac fixture (real bytecode): varint+utf serializer derived, SingletonArgumentInfo -> none, writeNullable -> non-derivable, a branching serializer -> non-derivable, unknown name -> no registration site, a vanilla-namespaced name the schema lacks -> abstained', () => {
    const registry = new Map([[57, 'hf45mod:varint_thing'], [58, 'hf45mod:nullable_thing'], [59, 'hf45mod:branch_thing'], [60, 'hf45mod:plain_thing'], [61, 'nowhere:thing'], [62, 'minecraft:new_vanilla'], [0, 'brigadier:bool']])
    const r = deriveCommandArgumentTypes({ registry, vanillaNames: new Set(['brigadier:bool']), jars: [FIX] })
    assert.strictEqual(r.vanilla, 1)
    const v = r.derived.find((d) => d.id === 57)
    assert.deepStrictEqual(v.fields.map((f) => f.type), ['varint', 'string']); assert.deepStrictEqual(v.source.writes, ['writeVarInt', 'writeUtf'])
    assert.strictEqual(v.source.serializer, 'com/example/hf45mod/VarintArgument$Info'); assert.strictEqual(v.source.evidence, 'namespace'); assert.strictEqual(v.source.jar, 'hf45-argument-types.jar')
    assert.deepStrictEqual(r.derived.find((d) => d.id === 60).fields, [])
    const reasons = Object.fromEntries(r.abstains.map((a) => [a.id, a.reason]))
    assert.strictEqual(reasons[58], 'serializer-non-derivable:lambda-in-serializer')
    assert.strictEqual(reasons[59], 'serializer-non-derivable:conditional-write')
    assert.strictEqual(reasons[61], 'no-registration-site')
    assert.strictEqual(reasons[62], 'vanilla-type-unmodelled-by-schema')
    assert.deepStrictEqual(r.extension.parsers.map((p) => p.id), [57, 60])
  })
  it('no non-vanilla ids -> no jar is even opened; an unreadable jar is reported, never thrown', () => {
    const r = deriveCommandArgumentTypes({ registry: new Map([[0, 'brigadier:bool']]), vanillaNames: new Set(['brigadier:bool']), jars: ['/nonexistent.jar'] })
    assert.strictEqual(r.extension, null); assert.deepStrictEqual(r.jars, [])
    const r2 = deriveCommandArgumentTypes({ registry: new Map([[57, 'x:y']]), vanillaNames: new Set(), jars: ['/nonexistent.jar'] })
    assert.strictEqual(r2.unreadable.length, 1); assert.strictEqual(r2.abstains[0].reason, 'no-registration-site')
  })
})

describe('HF45 declareCommandsBoundary — per client, never fatal', function () {
  it('without a table: the modded frame is DROPPED as declare_commands_dropped with the receipt; other packets pass through untouched', () => {
    const c = fakeClient()
    const logs = []
    installDeclareCommandsBoundary(c, { log: (m) => logs.push(m) })
    let dropped = null
    c.on('command_tree_dropped', (r) => { dropped = r })
    const out = c.deserializer.parsePacketBuffer(FRAME)
    assert.strictEqual(out.data.name, 'declare_commands_dropped'); assert.strictEqual(out.metadata.size, FRAME.length)
    assert.strictEqual(dropped.dropped, true); assert.deepStrictEqual([...dropped.unknown_parser_ids].sort(), [62, 63])
    assert.strictEqual(dropped.bytes_unconsumed, 72); assert.strictEqual(dropped.nodes_read, 41); assert.strictEqual(dropped.nodes_declared, 41)
    assert.strictEqual(c.minepalCommandTree.dropped, true); assert.strictEqual(c.minepalCommandTree.table, null)
    assert.strictEqual(logs.length, 1); assert.ok(/DROPPED/.test(logs[0]) && /unknown parser ids 62,63|unknown parser ids 63,62/.test(logs[0]) && /ABSENT/.test(logs[0]))
    c.deserializer.parsePacketBuffer(FRAME) // second drop: no second log line
    assert.strictEqual(logs.length, 1)
    c.deserializer.parsePacketBuffer(Buffer.from([0x27, 0x00]))
    assert.strictEqual(c.passthrough, 1)
  })
  it('with the derived table on the client: the same frame parses fully and reaches nmp as a normal declare_commands', () => {
    const c = fakeClient()
    installDeclareCommandsBoundary(c, { log: () => {} })
    c.minepalCommandArgumentTypes = { derived: true, source: 'neoforge-frozen-registry', registrySize: 64, extension: MODDED_EXT, receipt: { abstains: [] } }
    const out = c.deserializer.parsePacketBuffer(FRAME)
    assert.strictEqual(out.data.name, 'declare_commands'); assert.strictEqual(out.data.params.nodes.length, 41); assert.strictEqual(out.data.params.rootIndex, 0)
    assert.strictEqual(c.minepalCommandTree.parsed, true); assert.deepStrictEqual(c.minepalCommandTree.table.derived_ids, [62, 63])
  })
  it('installed before play: wraps the deserializer at the state change (nmp swaps deserializers per state); idempotent', () => {
    const c = fakeClient(); c.state = 'configuration'
    const s1 = installDeclareCommandsBoundary(c, { log: () => {} }); const s2 = installDeclareCommandsBoundary(c, { log: () => {} })
    assert.strictEqual(s1, s2); assert.strictEqual(c.deserializer._hf45CommandTree, undefined)
    c.state = 'play'; c.emit('state', 'play')
    assert.strictEqual(c.deserializer._hf45CommandTree, true)
  })
  it('auto-detected version (the live 1.21.1 lane): the packet id is resolved at PLAY entry from the version the client has THEN, not at install (nmp default 26.2 -> 0x10; real 1.21.1 -> 0x11)', () => {
    const c = fakeClient(); c.version = '26.2'; c.state = 'login' // nmp's default before the status ping
    const st = installDeclareCommandsBoundary(c, { log: () => {} })
    assert.strictEqual(st.installed, false); assert.strictEqual(st.packetId, null)
    c.version = '1.21.1'; c.state = 'play'; c.emit('state', 'play')
    assert.strictEqual(st.installed, true); assert.strictEqual(st.packetId, declareCommandsId('1.21.1')); assert.strictEqual(st.version, '1.21.1')
    assert.notStrictEqual(declareCommandsId('1.21.1'), declareCommandsId('26.2'))
    // a 1.21.1 frame with an unknown parser id is intercepted and dropped
    const { compileReader } = require('../src/client/commandTreeParser')
    const proto = compileReader('1.21.1', { parsers: [{ id: 56, name: 'neoforge:enum', fields: [{ name: 'utf0', type: 'string' }] }] })
    const f = (t, cmd) => ({ unused: 0, has_custom_suggestions: 0, has_redirect_node: 0, has_command: cmd, command_node_type: t })
    const body = proto.createPacketBuffer('packet_declare_commands', { nodes: [{ flags: f(0, 0), children: [1] }, { flags: f(1, 0), children: [2], extraNodeData: { name: 'config' } }, { flags: f(2, 1), children: [], extraNodeData: { name: 'type', parser: 'neoforge:enum', properties: { utf0: 'x.y.Z$E' } } }], rootIndex: 0 })
    const frame = Buffer.concat([Buffer.from([declareCommandsId('1.21.1')]), body])
    const out = c.deserializer.parsePacketBuffer(frame)
    assert.strictEqual(out.data.name, 'declare_commands_dropped'); assert.deepStrictEqual(out.data.params.unknown_parser_ids, [56])
    // and with the table it parses on 1.21.1 too
    c.minepalCommandArgumentTypes = { derived: true, extension: { parsers: [{ id: 56, name: 'neoforge:enum', fields: [{ name: 'utf0', type: 'string' }] }] }, receipt: { abstains: [] } }
    assert.strictEqual(c.deserializer.parsePacketBuffer(frame).data.name, 'declare_commands')
  })
  it('the table installer derives from the wire registry when neoForgeRegistries fires (jars resolved lazily, once)', () => {
    const c = fakeClient()
    let resolved = 0
    const logs = []
    installCommandArgumentTypes(c, { resolveJars: () => { resolved++; return [path.join(FX, 'hf45-argument-types.jar')] }, log: (m) => logs.push(m) })
    const vt = vanillaParserTable('26.2')
    const registry = new Map(vt.rows.map((r) => [r.id, r.name])); registry.set(57, 'hf45mod:varint_thing'); registry.set(58, 'hf45mod:branch_thing')
    c.forgeRegistries = { command_argument_type: registry }
    c.emit('neoForgeRegistries', c.forgeRegistries)
    const t = c.minepalCommandArgumentTypes
    assert.strictEqual(resolved, 1); assert.strictEqual(t.derived, true); assert.strictEqual(t.source, 'neoforge-frozen-registry')
    assert.deepStrictEqual(t.extension.parsers.map((p) => `${p.id}=${p.name}:${p.fields.map((f) => f.type)}`), ['57=hf45mod:varint_thing:varint,string'])
    assert.strictEqual(t.receipt.abstains[0].id, 58); assert.ok(/57=hf45mod:varint_thing:varint,string/.test(logs[0]) && /NOT derivable \[58=hf45mod:branch_thing/.test(logs[0]))
  })
})
