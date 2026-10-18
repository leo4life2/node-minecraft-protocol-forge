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
    assert.strictEqual(table.patterns.length, 1)
    for (const c of table.patterns[0].cited) assert.ok(/^[0-9a-f]{40}$/.test(c.sha1) && /^[0-9a-f]{40}$/.test(c.fixture_sha1) && c.jar && c.fixture, JSON.stringify(c))
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
