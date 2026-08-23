/* eslint-env mocha */
// NeoForge 1.20.5+ config-phase negotiation: wire codecs + derivation rules.
// The byte layouts assert against the decompiled 21.1.248 STREAM_CODECs
// (see neoForgeConfig.js header). The derivation ground-truth leg is
// env-gated on the modknowledge rig corpus (MODKNOW_NEOFORGE_MODS +
// MODKNOW_NEOFORGE_JAR) — the tuples it asserts are the exact ones a live
// 21.1.248 negotiator ACCEPTED on 2026-08-06 (3/3 product joins).
const assert = require('assert')
const {
  encodeNetworkQuery,
  decodeNetworkSetup,
  decodeFrozenStart,
  decodeFrozenRegistry,
  decodeKnownDataMaps,
  encodeKnownDataMapsReply,
  writeVarInt,
  writeString
} = require('../src/client/neoForgeConfig')
const { deriveNeoForgeComponents } = require('../src/client/neoForgePayloadDerivation')

describe('neoforge:register reply encoding (ModdedNetworkQueryPayload)', function () {
  it('empty component sets encode as the empty map (the server sends exactly 0x00)', () => {
    assert.deepStrictEqual(encodeNetworkQuery({ configuration: [], play: [] }), Buffer.from([0]))
  })

  it('components carry id, version, optional flow ordinal and optional flag', () => {
    const buf = encodeNetworkQuery({
      configuration: [{ id: 'mekanism:batch_security', version: '10.7.19', flow: 'clientbound', optional: false }],
      play: []
    })
    const expected = Buffer.concat([
      writeVarInt(1), // one protocol map entry
      writeVarInt(4), // ConnectionProtocol.CONFIGURATION ordinal
      writeVarInt(1), // one component
      writeString('mekanism:batch_security'),
      writeString('10.7.19'),
      Buffer.from([1]), writeVarInt(1), // Optional.of(CLIENTBOUND=1)
      Buffer.from([0]) // optional=false
    ])
    assert.deepStrictEqual(buf, expected)
  })

  it('bidirectional components encode flow as Optional.empty', () => {
    const buf = encodeNetworkQuery({
      configuration: [{ id: 'neoforge:frozen_registry_sync_completed', version: '1', flow: null, optional: true }],
      play: []
    })
    const expected = Buffer.concat([
      writeVarInt(1), writeVarInt(4), writeVarInt(1),
      writeString('neoforge:frozen_registry_sync_completed'),
      writeString('1'),
      Buffer.from([0]), // Optional.empty
      Buffer.from([1]) // optional=true
    ])
    assert.deepStrictEqual(buf, expected)
  })
})

describe('clientbound payload decoding', function () {
  it('NetworkPayloadSetup: per-protocol negotiated channel maps', () => {
    const buf = Buffer.concat([
      writeVarInt(1), writeVarInt(1), // PLAY
      writeVarInt(1),
      writeString('create:knockback'), // map key
      writeString('create:knockback'), // NetworkChannel.id
      writeString('6.0.10') // NetworkChannel.version
    ])
    const setup = decodeNetworkSetup(buf)
    assert.deepStrictEqual(setup, { play: { 'create:knockback': { id: 'create:knockback', version: '6.0.10' } } })
  })

  it('FrozenRegistrySyncStartPayload: registry name list', () => {
    const buf = Buffer.concat([writeVarInt(2), writeString('minecraft:item'), writeString('minecraft:block')])
    assert.deepStrictEqual(decodeFrozenStart(buf), ['minecraft:item', 'minecraft:block'])
  })

  it('FrozenRegistryPayload: RegistrySnapshot id + alias maps', () => {
    const buf = Buffer.concat([
      writeString('minecraft:item'),
      writeVarInt(2),
      writeVarInt(0), writeString('minecraft:air'),
      writeVarInt(2721), writeString('mekanism:jetpack'),
      writeVarInt(1),
      writeString('mekanism:old_name'), writeString('mekanism:jetpack')
    ])
    const reg = decodeFrozenRegistry(buf)
    assert.strictEqual(reg.name, 'minecraft:item')
    assert.strictEqual(reg.ids.get(2721), 'mekanism:jetpack')
    assert.strictEqual(reg.ids.get(0), 'minecraft:air')
    assert.strictEqual(reg.aliases.get('mekanism:old_name'), 'mekanism:jetpack')
  })

  it('KnownRegistryDataMapsPayload round-trips into the reply the server expects', () => {
    const buf = Buffer.concat([
      writeVarInt(1),
      writeString('minecraft:item'),
      writeVarInt(2),
      writeString('neoforge:oil'), Buffer.from([1]),
      writeString('mekanism:mek_data'), Buffer.from([0])
    ])
    const maps = decodeKnownDataMaps(buf)
    assert.deepStrictEqual(maps, [{
      registry: 'minecraft:item',
      entries: [{ id: 'neoforge:oil', mandatory: true }, { id: 'mekanism:mek_data', mandatory: false }]
    }])
    const reply = encodeKnownDataMapsReply(maps)
    assert.deepStrictEqual(reply, Buffer.concat([
      writeVarInt(1), writeString('minecraft:item'),
      writeVarInt(2), writeString('neoforge:oil'), writeString('mekanism:mek_data')
    ]))
  })
})

// GROUND TRUTH (env-gated): the rig corpus jars must derive the exact tuples
// the live 21.1.248 negotiator accepted. Enable with:
//   MODKNOW_NEOFORGE_MODS=/private/tmp/modknowledge-rigs/neoforge/mods \
//   MODKNOW_NEOFORGE_JAR=.../neoforge-21.1.248-universal.jar npx mocha test/neoForgeConfig.test.js
describe('derivation ground truth (rig corpus, env-gated)', function () {
  const modsDir = process.env.MODKNOW_NEOFORGE_MODS
  const loaderJar = process.env.MODKNOW_NEOFORGE_JAR
  const enabled = modsDir && require('fs').existsSync(modsDir)
  ;(enabled ? it : it.skip)('reproduces the live-accepted component tuples', function () {
    this.timeout(30000)
    const fs = require('fs')
    const path = require('path')
    const jars = fs.readdirSync(modsDir).filter((f) => f.endsWith('.jar')).map((f) => path.join(modsDir, f))
    if (loaderJar) jars.push(loaderJar)
    const { components } = deriveNeoForgeComponents(jars)
    const play = new Map(components.play.map((c) => [c.id, c]))
    const cfg = new Map(components.configuration.map((c) => [c.id, c]))
    // registrar(modVersion) idiom via wrapper dispatch (Mekanism)
    assert.deepStrictEqual(
      { version: cfg.get('mekanism:batch_security').version, flow: cfg.get('mekanism:batch_security').flow },
      { version: '10.7.19', flow: 'clientbound' })
    assert.strictEqual(play.get('mekanism:qio_take').flow, 'serverbound')
    // enum-registry shape with a static String field version (Create/catnip)
    assert.deepStrictEqual(
      { version: play.get('create:knockback').version, flow: play.get('create:knockback').flow },
      { version: '6.0.10', flow: 'clientbound' })
    assert.strictEqual(play.get('create:c_configure_train').flow, 'serverbound')
    // enum-registry with int version (Ponder/catnip)
    assert.deepStrictEqual(
      { version: play.get('ponder:clientbound_config').version, flow: play.get('ponder:clientbound_config').flow },
      { version: '1', flow: 'clientbound' })
    // direct shape (FarmersDelight)
    assert.deepStrictEqual(
      { version: play.get('farmersdelight:flip_skillet').version, flow: play.get('farmersdelight:flip_skillet').flow },
      { version: '1', flow: 'serverbound' })
    // optional channels with runtime versions ABSTAIN instead of guessing (JEI)
    assert.strictEqual(play.get('jei:give_item_stack'), undefined)
    if (loaderJar) {
      // NeoForge built-ins: registrar("1").optional() in NetworkInitialization
      assert.deepStrictEqual(
        { version: cfg.get('neoforge:frozen_registry').version, optional: cfg.get('neoforge:frozen_registry').optional },
        { version: '1', optional: true })
      assert.strictEqual(cfg.get('neoforge:frozen_registry_sync_completed').flow, null)
    }
  })
})

// GROUND TRUTH (fixture-gated): the HELPER registration shape (HF-NEOFORGE
// lane). AE2 19.2.17 registers every channel through private static helpers
// (InitNetwork.clientbound(registrar, TYPE, CODEC) -> registrar.playToClient)
// and builds each TYPE through a static factory on an interface
// (CustomAppEngPayload.createType(String) -> new Type(AppEng.makeId(name))),
// including ONE empty-string path (GuiDataSyncPacket = createType("") -> id
// "ae2:"). Before the helper/TYPE-factory dispatch + the cpUtf8 empty-string
// fix, this pack derived ZERO ae2 channels with zero abstains and the live
// 21.1.248 server kicked "Incompatible client! Please use NeoForge 21.1.248".
// Expected values decompiled (CFR) from the rig's exact jars.
describe('derivation ground truth (AE2 helper shape, fixture-gated)', function () {
  const fs = require('fs')
  const path = require('path')
  const root = process.env.MODKNOW_AE2_FIXTURE || '/Users/leoli/minepal-coop/modknowledge/jars/neoforge-21.1.248-ae2'
  const enabled = fs.existsSync(path.join(root, 'mods'))
  ;(enabled ? it : it.skip)('derives all 34 ae2 channels through static helpers, TYPE factories, and the empty-path id', function () {
    this.timeout(30000)
    const jars = fs.readdirSync(path.join(root, 'mods')).filter((f) => f.endsWith('.jar')).map((f) => path.join(root, 'mods', f))
    const loaderJar = path.join(root, 'libraries/net/neoforged/neoforge/21.1.248/neoforge-21.1.248-universal.jar')
    if (fs.existsSync(loaderJar)) jars.push(loaderJar)
    const { components, diagnostics } = deriveNeoForgeComponents(jars)
    assert.strictEqual(diagnostics.abstains.length, 0, `no abstains expected, got: ${diagnostics.abstains.join(' | ')}`)
    const ae2 = components.play.filter((c) => c.id.startsWith('ae2:'))
    assert.strictEqual(ae2.length, 34)
    const flows = ae2.reduce((m, c) => { const k = c.flow ?? 'bidirectional'; m[k] = (m[k] || 0) + 1; return m }, {})
    assert.deepStrictEqual(flows, { clientbound: 17, serverbound: 16, bidirectional: 1 })
    assert.ok(ae2.every((c) => c.version === 'ae2' && c.optional === false))
    const empty = ae2.find((c) => c.id === 'ae2:')
    assert.ok(empty, 'empty-path channel "ae2:" (GuiDataSyncPacket createType("")) must be derived')
    assert.strictEqual(empty.flow, 'clientbound')
    const gm = components.play.find((c) => c.id === 'guideme:open_guide')
    assert.deepStrictEqual({ version: gm.version, flow: gm.flow, optional: gm.optional }, { version: '1.0', flow: 'clientbound', optional: false })
  })
})
