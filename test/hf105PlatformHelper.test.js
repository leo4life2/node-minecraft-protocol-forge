/* eslint-env mocha */
// HF105 item B - THE PLATFORM HELPER (src/client/platformHelperDerivation.js,
// data/platformHelperPatterns.json): a library registers at runtime from the
// list each mod hands it (Moonlight's NetworkHelper: Supplementaries, Moonlight
// itself). The F39 Case B server named 53 ids, none in the claim: the walks
// reached the helper's registrar with an unresolved payload type. Fixtures: the
// REAL jars of that receipt, trimmed to the helper, the consumers and the
// message classes (tools/trim-packet-wire-fixture.js); the currency mod of the
// receipt is not obtainable (its 6 ids stay with the belt).
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { deriveNeoForgeComponents } = require('../src/client/neoForgePayloadDerivation')
const FX = path.join(__dirname, 'fixtures')
const MOONLIGHT = path.join(FX, 'hf105-moonlight-1.21.1-3.7.2-neoforge.trimmed.jar')
const SUPP = path.join(FX, 'hf105-supplementaries-1.21.1-4.0.1-neoforge.trimmed.jar')
// b-missing.txt of the F39 receipt minus the currency namespace: 47 ids (moonlight 10, supplementaries 37)
const B_MISSING = ['moonlight:bidi_sync_configs', 'moonlight:c2s_item_left_click', 'moonlight:s2c_finalize_fluids', 'moonlight:s2c_on_piston_moved_block', 'moonlight:s2c_open_config_screen', 'moonlight:s2c_open_screen', 'moonlight:s2c_particle', 'moonlight:s2c_send_login', 'moonlight:s2c_sync_world_data', 'moonlight:s2c_update_box_block', 'supplementaries:c2s_cycle_selectable_container_item', 'supplementaries:c2s_request_config_reload', 'supplementaries:c2s_request_map_data', 'supplementaries:c2s_request_open_cannon_gui', 'supplementaries:c2s_select_merchant_trade', 'supplementaries:c2s_set_blackboard', 'supplementaries:c2s_set_present', 'supplementaries:c2s_set_speaker', 'supplementaries:c2s_set_text_holder', 'supplementaries:c2s_set_trapped_present', 'supplementaries:pickle', 'supplementaries:s2c_cannon_particle', 'supplementaries:s2c_cannonball', 'supplementaries:s2c_control_cannon', 'supplementaries:s2c_flute_parrots', 'supplementaries:s2c_launch_cannon_rider', 'supplementaries:s2c_open_configs', 'supplementaries:s2c_particle', 'supplementaries:s2c_piston_cooperators', 'supplementaries:s2c_play_song_notes', 'supplementaries:s2c_play_speaker_message', 'supplementaries:s2c_pulley_attempt', 'supplementaries:s2c_send_knockback', 'supplementaries:s2c_send_login', 'supplementaries:s2c_set_sliding_block_entity', 'supplementaries:s2c_set_song', 'supplementaries:s2c_sync_ambient_light', 'supplementaries:s2c_sync_antique_ink', 'supplementaries:s2c_sync_cannon_boat', 'supplementaries:s2c_sync_captured_mobs', 'supplementaries:s2c_sync_trades', 'supplementaries:show_time', 'supplementaries:sync_books', 'supplementaries:sync_cannon', 'supplementaries:sync_equipped_quiver', 'supplementaries:sync_hourglass', 'supplementaries:sync_party_creeper']

describe('HF105 item B: the platform-helper pattern row derives the runtime-list registrations', function () {
  this.timeout(60000)

  it('claims the 47 server-named ids on the FIRST pass: set equality, the version from each call site (10 / 5), the flow from the registrar method, the source word', () => {
    const r = deriveNeoForgeComponents([MOONLIGHT, SUPP])
    const play = new Map(r.components.play.map((c) => [c.id, c]))
    assert.deepStrictEqual([...play.keys()].sort(), [...B_MISSING].sort())
    for (const id of B_MISSING) {
      const c = play.get(id)
      assert.strictEqual(c.version, id.startsWith('moonlight:') ? '10' : '5', `${id} version ${c.version}`)
      assert.strictEqual(c.versionSource, 'platform-helper', `${id} versionSource`)
      assert.ok(/^platform-helper /.test(c.source), c.source)
      assert.strictEqual(c.optional, false)
    }
    assert.strictEqual(play.get('moonlight:s2c_send_login').flow, 'clientbound')
    assert.strictEqual(play.get('moonlight:c2s_item_left_click').flow, 'serverbound')
    assert.strictEqual(play.get('moonlight:bidi_sync_configs').flow, null) // registerBidirectional -> playBidirectional
    assert.strictEqual(play.get('supplementaries:c2s_set_text_holder').flow, 'serverbound')
    assert.strictEqual(play.get('supplementaries:s2c_send_login').flow, 'clientbound')
    assert.deepStrictEqual(r.components.configuration, [])
    // the helper's own registrar sites are resolved: no unresolved-id / never-reaches abstain on them anywhere in the pack
    assert.deepStrictEqual(r.diagnostics.abstains.filter((a) => /NetworkHelperImpl/.test(a)), [])
    assert.deepStrictEqual(r.diagnostics.errors, [])
  })

  it('RED control: the pattern row removed from the table -> 0 ids claimed and the helper abstains return', () => {
    const dataPath = path.join(__dirname, '..', 'src', 'client', 'data', 'platformHelperPatterns.json')
    const table = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
    const consumerRow = table.patterns.find((p) => p.shape === 'consumer-registrar') // HF127: the table holds one row per shape
    assert.ok(consumerRow, 'the consumer-registrar row')
    for (const c of consumerRow.cited) assert.ok(/^[0-9a-f]{40}$/.test(c.sha1) && /^[0-9a-f]{40}$/.test(c.fixture_sha1) && c.jar && c.fixture, JSON.stringify(c))
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hf105-red-'))
    const copy = path.join(tmp, 'platformHelperPatterns.json')
    fs.writeFileSync(copy, JSON.stringify({ ...table, patterns: [] }))
    const modPath = require.resolve('../src/client/platformHelperDerivation')
    const dataKey = require.resolve(dataPath)
    const mainPath = require.resolve('../src/client/neoForgePayloadDerivation')
    const saved = { mod: require.cache[modPath], data: require.cache[dataKey], main: require.cache[mainPath] }
    try {
      delete require.cache[modPath]; delete require.cache[mainPath]
      require.cache[dataKey] = { id: dataKey, filename: dataKey, loaded: true, exports: JSON.parse(fs.readFileSync(copy, 'utf8')) }
      const red = require('../src/client/neoForgePayloadDerivation').deriveNeoForgeComponents([MOONLIGHT, SUPP])
      assert.deepStrictEqual(red.components.play, [])
      // the helper's sites abstain again (the site lines are cut at the abstain length cap: the '(via <entry>' head names them)
      assert.ok(red.diagnostics.abstains.some((a) => /NetworkHelperImpl\$1\.(playToClient|playToServer|playBidirectional) \(via /.test(a)), red.diagnostics.abstains.join(' | '))
      assert.ok(red.diagnostics.abstains.some((a) => /NetworkHelperImpl/.test(a) && /never reaches a registration/.test(a)), red.diagnostics.abstains.join(' | '))
    } finally {
      require.cache[modPath] = saved.mod; require.cache[dataKey] = saved.data; require.cache[mainPath] = saved.main
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

// HF127 (R1 + R3): two more rows of the same table, each proven on the REAL
// jars of the f67 read through trimmed fixtures (test/fixtures/hf127-trim-jars.mjs
// builds them from the sha256-pinned originals; hf127-fixtures.json records both
// hashes). R1: a mod's listener loops over a static list provider at a constant
// registrar version (8 ids the host required). R3: a library numbers each mod's
// messages through its channel builder (<modid>:play/<n>).
const crypto = require('crypto')
const FX127 = (n) => path.join(FX, n)
const SCHOLAR = FX127('hf127-scholar-neoforge-1.21.1-1.2.10.trimmed.jar')
const PUZZLES = FX127('hf127-puzzleslib-v21.1.66-mc1.21.1+neoforge.trimmed.jar')
const EASYMAGIC = FX127('hf127-EasyMagic-v21.1.4-1.21.1-NeoForge.trimmed.jar')
const EASYANVILS = FX127('hf127-EasyAnvils-v21.1.0-1.21.1-NeoForge.trimmed.jar')
const SCHOLAR_IDS = ['lectern_edit_book', 'set_bookmark', 'set_custom_author_in_hand', 'set_custom_author_on_lectern', 'set_golden_skin_in_hand', 'set_golden_skin_on_lectern', 'started_reading_in_hand', 'stopped_reading_in_hand'].map((p) => `scholar:${p}`)
const rowsOf = (r, ns) => r.components.play.filter((c) => c.id.startsWith(`${ns}:`)).map((c) => [c.id, c.flow, c.version, !!c.optional]).sort((a, b) => (a[0] < b[0] ? -1 : 1))
function withTable (mutate, fn) {
  const dataPath = path.join(__dirname, '..', 'src', 'client', 'data', 'platformHelperPatterns.json')
  const table = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
  const modPath = require.resolve('../src/client/platformHelperDerivation')
  const dataKey = require.resolve(dataPath)
  const mainPath = require.resolve('../src/client/neoForgePayloadDerivation')
  const saved = { mod: require.cache[modPath], data: require.cache[dataKey], main: require.cache[mainPath] }
  try {
    delete require.cache[modPath]; delete require.cache[mainPath]
    require.cache[dataKey] = { id: dataKey, filename: dataKey, loaded: true, exports: mutate(table) }
    return fn(require('../src/client/neoForgePayloadDerivation').deriveNeoForgeComponents)
  } finally {
    require.cache[modPath] = saved.mod; require.cache[dataKey] = saved.data; require.cache[mainPath] = saved.main
  }
}

describe('HF127: the list-provider loop and the numbered-id builder rows', function () {
  this.timeout(60000)

  it('the trimmed fixtures are the pinned originals trimmed: each fixture sha256 and each original sha256 cited by its row', () => {
    const manifest = JSON.parse(fs.readFileSync(FX127('hf127-fixtures.json'), 'utf8'))
    const table = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'data', 'platformHelperPatterns.json'), 'utf8'))
    const cited = new Map(table.patterns.flatMap((p) => p.cited || []).filter((c) => c.sha256).map((c) => [c.fixture, c.sha256]))
    for (const [fixture, m] of Object.entries(manifest)) {
      assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(FX127(fixture))).digest('hex'), m.sha256, fixture)
      if (cited.has(fixture)) assert.strictEqual(cited.get(fixture), m.original_sha256, `${fixture} original`)
    }
    for (const f of [SCHOLAR, PUZZLES, EASYMAGIC, EASYANVILS]) assert.ok(cited.has(path.basename(f)), `${path.basename(f)} is cited by a row`)
  })

  it('R1: the static list-provider loop claims the eight serverbound ids at the registrar version, required, and leaves no unresolved line on the loop entry', () => {
    const r = deriveNeoForgeComponents([SCHOLAR])
    assert.deepStrictEqual(rowsOf(r, 'scholar'), SCHOLAR_IDS.map((id) => [id, 'serverbound', '1', false]))
    for (const c of r.components.play) assert.ok(/^list-provider /.test(c.source) && c.versionSource === 'platform-helper', `${c.id} ${c.source}`)
    assert.deepStrictEqual(r.diagnostics.abstains.filter((a) => /NeoForgeCommonEvents/.test(a)), [])
    assert.deepStrictEqual(r.diagnostics.errors, [])
  })

  it('R1 RED control: the list-provider row removed -> no scholar id and the loop entry abstains as before', () => {
    const red = withTable((t) => ({ ...t, patterns: t.patterns.filter((p) => p.shape !== 'list-provider') }), (derive) => derive([SCHOLAR]))
    assert.deepStrictEqual(rowsOf(red, 'scholar'), [])
    assert.ok(red.diagnostics.abstains.some((a) => /NeoForgeCommonEvents: playToServer with unresolved payload type id/.test(a)), red.diagnostics.abstains.join(' | '))
  })

  it('R3: the numbered-id builder claims each mod in its own channel - the library first-party id optional, the consumer ids required, bidirectional, at the channel language key', () => {
    const r = deriveNeoForgeComponents([PUZZLES, EASYMAGIC])
    assert.deepStrictEqual(rowsOf(r, 'easymagic'), [['easymagic:play/0', null, 'easymagic.play', false]])
    assert.deepStrictEqual(rowsOf(r, 'puzzleslib'), [['puzzleslib:play/0', null, 'puzzleslib.play', true]])
    for (const c of r.components.play) assert.ok(/^builder-counter /.test(c.source), c.source)
    assert.deepStrictEqual(r.diagnostics.errors, [])
  })

  it('R3 generality: a second consumer with legacy overloads is numbered clientbound first, in chain order inside each kind (the host named play/2)', () => {
    const r = deriveNeoForgeComponents([PUZZLES, EASYANVILS])
    assert.deepStrictEqual(rowsOf(r, 'easyanvils'), [0, 1, 2, 3].map((n) => [`easyanvils:play/${n}`, null, 'easyanvils.play', false]))
  })

  it('R3: a consumer without its library claims nothing numbered; the builder-counter row removed claims nothing', () => {
    assert.deepStrictEqual(rowsOf(deriveNeoForgeComponents([EASYMAGIC]), 'easymagic'), [])
    const red = withTable((t) => ({ ...t, patterns: t.patterns.filter((p) => p.shape !== 'builder-counter') }), (derive) => derive([PUZZLES, EASYMAGIC]))
    assert.deepStrictEqual(rowsOf(red, 'easymagic'), [])
    assert.deepStrictEqual(rowsOf(red, 'puzzleslib'), [])
  })
})

// --- HF130 R1: the static forwarder feeding a message map ------------------
// Sweep #88 (a same-computer NeoForge 1.21.1 world carrying an MCreator-built
// mod): the mod root holds a static message Map; a static forwarder
// `addNetworkMessage(Type, codec, handler)` puts its PARAMETER into the map
// from each message class's registerMessage (its own <clinit> TYPE); the
// registrar callback `registrar(modId)` + `MESSAGES.forEach((type, msg) ->
// registrar.playBidirectional(type, ..))` registers each entry. The reader
// abstained "unresolved payload type id": the map key arrived as another
// class's static-field placeholder and the BiConsumer forEach handed the
// VALUE alone to the lambda. One rule covers every MCreator NeoForge 1.21 mod
// (identical generated code).
const FX130 = (n) => path.join(FX, n)
const PMW_PLUS = FX130('hf130-pmw_plus-1.4.1-neoforge-1.21.1.trimmed.jar')
const PMW_IDS = ['dev_console_buttons', 'guistate_update', 'key_main_open', 'main_2_buttons', 'main_3_buttons', 'main_4_buttons', 'main_5_buttons', 'main_buttons', 'play_player_animation'].map((p) => `pmw_plus:${p}`)

describe('HF130 R1: the static forwarder feeding a message map a registrar callback registers', function () {
  this.timeout(60000)

  it('the trimmed fixtures are the pinned originals trimmed: each fixture sha256 and each original sha256 recorded by the trim script', () => {
    const manifest = JSON.parse(fs.readFileSync(FX130('hf130-fixtures.json'), 'utf8'))
    const originals = {
      'hf130-pmw_plus-1.4.1-neoforge-1.21.1.trimmed.jar': '6688f6d863df7a2e0c16df965baf96c2d455e06d8bc4680153103a2fa26c0b40',
      'hf130-pmwextra-0.1.7.trimmed.jar': '57548c120b1573b3272b0937b5454ba8391f135726bbb020f3937ce6ca3ff545'
    }
    assert.deepStrictEqual(Object.keys(manifest).sort(), Object.keys(originals).sort())
    for (const [fixture, m] of Object.entries(manifest)) {
      assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(FX130(fixture))).digest('hex'), m.sha256, fixture)
      assert.strictEqual(m.original_sha256, originals[fixture], `${fixture} original`)
      assert.ok(/^https:\/\/cdn\.modrinth\.com\//.test(m.url), m.url)
    }
  })

  it('the nine message ids bound at the forwarder call sites are claimed bidirectional, required, at the registrar string (the mod id, never the mods.toml version), with no unresolved line', () => {
    const r = deriveNeoForgeComponents([PMW_PLUS])
    const rows = r.components.play.filter((c) => c.id.startsWith('pmw_plus:')).map((c) => [c.id, c.flow ?? null, c.version, !!c.optional]).sort((a, b) => (a[0] < b[0] ? -1 : 1))
    assert.deepStrictEqual(rows, PMW_IDS.map((id) => [id, null, 'pmw_plus', false]))
    assert.deepStrictEqual(r.components.configuration.filter((c) => c.id.startsWith('pmw_plus:')), [])
    assert.ok(!r.diagnostics.abstains.some((a) => /unresolved payload type id/.test(a)), r.diagnostics.abstains.join(' | '))
  })
})

// HF131 - THE CULPRIT FROM THE BYTES (src/client/playTableInjectionDerivation.js
// over the per-version row of data/playTableInjectionPatterns.json): the jar of a
// pack whose class bytes carry the add-packet reference into the CLIENTBOUND play
// template. Fixture: test/fixtures/hf131-levelz-2.0.12.trimmed.jar, built by
// test/fixtures/hf131-trim-jars.mjs from the sha256-pinned original.
const { derivePlayTableInjection, CULPRIT_BASIS } = require('../src/client/playTableInjectionDerivation')
const FX131 = (n) => path.join(FX, n)
const LEVELZ = FX131('hf131-levelz-2.0.12.trimmed.jar')

describe('HF131 R2: the culprit of a play-entry table mismatch is read from the jar bytes, never from a mod list', function () {
  this.timeout(60000)

  it('the trimmed fixture is the pinned original trimmed: the fixture sha256, the original sha256 and the official download URL recorded by the trim script', () => {
    const manifest = JSON.parse(fs.readFileSync(FX131('hf131-fixtures.json'), 'utf8'))
    assert.deepStrictEqual(Object.keys(manifest), ['hf131-levelz-2.0.12.trimmed.jar'])
    const m = manifest['hf131-levelz-2.0.12.trimmed.jar']
    assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(LEVELZ)).digest('hex'), m.sha256)
    assert.strictEqual(m.original_sha256, '7d4b004e3cc053e16b0b91141f8b6be2a147d7c2a42564d1fa1df4baed30df6b')
    assert.strictEqual(m.entries, 4)
    assert.ok(/^https:\/\/cdn\.modrinth\.com\//.test(m.url), m.url)
  })

  it('H131d: the jar whose mixin injects a packet type into the clientbound builder is named with add_packet_reference, its mod name from the manifest, the class and namespace as evidence', () => {
    const r = derivePlayTableInjection({ paths: [LEVELZ], version: '1.21.1' })
    assert.strictEqual(r.culprit_jar, 'hf131-levelz-2.0.12.trimmed.jar')
    assert.strictEqual(r.culprit_basis, 'add_packet_reference')
    assert.deepStrictEqual(r.culprit_mod, { id: 'levelz', name: 'LevelZ', version: '2.0.12' })
    assert.strictEqual(r.matches.length, 1)
    assert.strictEqual(r.matches[0].className, 'net/levelz/mixin/network/PlayStateFactoriesMixin')
    assert.strictEqual(r.matches[0].namespace, 'intermediary')
    assert.deepStrictEqual(r.abstained, [])
    assert.strictEqual(r.jars, 1)
    assert.ok(CULPRIT_BASIS.includes(r.culprit_basis))
    // a folder path reads the same jar
    const viaDir = derivePlayTableInjection({ paths: [FX], version: '1.21.1' })
    assert.strictEqual(viaDir.culprit_jar, 'hf131-levelz-2.0.12.trimmed.jar', 'the one jar of the fixtures folder that carries the reference')
    assert.strictEqual(viaDir.matches.length, 1, 'no other fixture jar of the earlier lanes is claimed')
  })

  it('H131d: the no-jar cases name no mod and say why - no_jar_matched (a pack without the reference), no_pack (nothing readable), no_version_data (a version without a row)', () => {
    const none = derivePlayTableInjection({ paths: [FX131('hf127-presence-stub.jar'), FX131('hf130-pmwextra-0.1.7.trimmed.jar')], version: '1.21.1' })
    assert.deepStrictEqual([none.culprit_jar, none.culprit_basis, none.culprit_mod, none.matches.length, none.jars], [null, 'no_jar_matched', null, 0, 2])
    const empty = derivePlayTableInjection({ paths: [], version: '1.21.1' })
    assert.deepStrictEqual([empty.culprit_jar, empty.culprit_basis, empty.culprit_mod, empty.jars], [null, 'no_pack', null, 0])
    const missing = derivePlayTableInjection({ paths: [FX131('no-such-folder')], version: '1.21.1' })
    assert.deepStrictEqual([missing.culprit_jar, missing.culprit_basis], [null, 'no_pack'])
    const noRow = derivePlayTableInjection({ paths: [LEVELZ], version: '1.8' })
    assert.deepStrictEqual([noRow.culprit_jar, noRow.culprit_basis, noRow.culprit_mod, noRow.jars], [null, 'no_version_data', null, 1])
    const noVersion = derivePlayTableInjection({ paths: [LEVELZ] })
    assert.strictEqual(noVersion.culprit_basis, 'no_version_data')
  })

  it('H131d: the row is data - every version row names the five members per namespace and no code path holds a mod name', () => {
    const rows = require('../src/client/data/playTableInjectionPatterns.json')
    for (const [version, namespaces] of Object.entries(rows.versions)) {
      assert.ok(/^\d+\.\d+(\.\d+)?$/.test(version), version)
      for (const [ns, names] of Object.entries(namespaces)) {
        for (const k of ['gameProtocols', 'protocolInfoBuilder', 'packetType', 'addPacket', 'clientboundBuilder']) assert.ok(typeof names[k] === 'string' && names[k], `${version}/${ns}/${k}`)
      }
    }
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'playTableInjectionDerivation.js'), 'utf8')
    assert.ok(!/levelz|class_9\d+|method_5\d+/i.test(src), 'the reader carries no mod name and no mapped member literal; the row does')
  })
})
