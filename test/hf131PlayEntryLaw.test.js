/* eslint-env mocha */
// HF131 - THE PLAY-ENTRY LAW of the tolerant play parser (src/client/tolerantPlayParser.js).
// Synthetic clientbound 1.21.1 play frames built with the vanilla serializer, fed
// through a real minecraft-protocol Client (no socket) carrying the install. The
// shifted stream (every id >= 0x02 plus one: a mod injected its own packet type at
// id 2 of the clientbound template) is the recorded F68 join sequence.
const assert = require('assert')
const { Client, states } = require('minecraft-protocol')
const { createSerializer } = require('minecraft-protocol/src/transforms/serializer.js')
const installTolerantPlayParser = require('../src/client/tolerantPlayParser')

const ser = createSerializer({ isServer: true, version: '1.21.1', state: 'play', customPackets: {} })
const frame = (name, params) => ser.createPacketBuffer({ name, params })
const readVarInt = (buf) => { let v = 0; let n = 0; let b; do { b = buf[n]; v |= (b & 0x7f) << (7 * n); n++ } while (b & 0x80); return { value: v, size: n } }
const varint = (v) => { const out = []; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b) } while (v); return Buffer.from(out) }
const shift = (buf) => { const { value, size } = readVarInt(buf); return value >= 2 ? Buffer.concat([varint(value + 1), buf.subarray(size)]) : buf }

const F = {
  login: frame('login', { entityId: 1, isHardcore: false, worldNames: ['minecraft:overworld'], maxPlayers: 8, viewDistance: 10, simulationDistance: 10, reducedDebugInfo: false, enableRespawnScreen: true, doLimitedCrafting: false, worldState: { dimension: 0, name: 'minecraft:overworld', hashedSeed: [0, 0], gamemode: 0, previousGamemode: 255, isDebug: false, isFlat: false, death: undefined, portalCooldown: 0 }, enforcesSecureChat: false }),
  abilities: frame('abilities', { flags: 0, flyingSpeed: 0.05, walkingSpeed: 0.1 }),
  held_item_slot: frame('held_item_slot', { slot: 0 }),
  declare_recipes: frame('declare_recipes', { recipes: [] }),
  entity_status: frame('entity_status', { entityId: 1, entityStatus: 24 }),
  game_state_change: frame('game_state_change', { reason: 13, gameMode: 0 }),
  step_tick: frame('step_tick', { tick_steps: 0 }),
  advancements: frame('advancements', { reset: true, advancementMapping: [], identifiers: [], progressMapping: [] }),
  update_health: frame('update_health', { health: 20, food: 20, foodSaturation: 5 }),
  experience: frame('experience', { experienceBar: 0, level: 0, totalExperience: 0 }),
  set_slot: frame('set_slot', { windowId: 0, stateId: 1, slot: 36, item: { itemCount: 0 } }),
  custom_payload: frame('custom_payload', { channel: 'minecraft:brand', data: Buffer.from([5, 0x66, 0x61, 0x62, 0x72, 0x69]) }),
  bundle_delimiter: frame('bundle_delimiter', {})
}
const RECORDED = ['login', 'abilities', 'held_item_slot', 'declare_recipes', 'entity_status', 'game_state_change', 'step_tick', 'advancements', 'update_health', 'experience', 'set_slot']
const NORMAL = ['custom_payload', 'bundle_delimiter', 'bundle_delimiter', 'login', 'abilities', 'held_item_slot', 'update_health', 'experience', 'set_slot']
const TRUNCATED_SET_SLOT = Buffer.from([0x15, 0x00]) // set_slot cut after its window id: a degradable partial read

function harness ({ handler } = {}) {
  const client = new Client(false, '1.21.1', {}, true)
  const r = { client, emitted: [], errors: [], facts: [], handled: [], writes: [] }
  client.write = (name) => { r.writes.push(name) }
  client.on('packet', (data, meta) => { r.emitted.push(meta.name) })
  client.on('error', (err) => { r.errors.push(err) })
  client.on('play_table_mismatch', (fact) => { r.facts.push(fact) })
  installTolerantPlayParser(client, handler ? { onPlayTableMismatch: (fact, cause) => { r.handled.push({ fact, cause }) } } : {})
  client.state = states.PLAY
  r.feed = (frames) => { for (const b of frames) client.deserializer.write(b) }
  return r
}
const quietWarn = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn() } finally { console.warn = w } }

describe('HF131 the play-entry law: the first failing clientbound frame before login is the id table', function () {
  it('H131-fork-a: the shifted stream raises ONE typed fact from the FIRST frame (login read as map, a drop) and suspends the stream - no misread frame is emitted, nothing is written, the embedder handler owns the stop', () => {
    const r = harness({ handler: true })
    quietWarn(() => r.feed(RECORDED.map((k) => shift(F[k]))))
    assert.strictEqual(r.handled.length, 1, 'the handler once')
    assert.strictEqual(r.facts.length, 1, 'the event once')
    const fact = r.handled[0].fact
    assert.deepStrictEqual(fact, { phase: 'play_entry', first_id: 0x2c, read_as: 'map', outcome: 'drop', frames_before_login: 0 })
    assert.ok(r.handled[0].cause instanceof Error, 'the parser error travels as the cause (debug only)')
    assert.deepStrictEqual([...new Set(r.emitted)], ['forge_play_table_mismatch'], 'every frame from the first on is the suspended synthetic, never map / tags / cookie_request / update_health')
    assert.strictEqual(r.emitted.length, RECORDED.length)
    assert.strictEqual(r.errors.length, 0, 'the handler owns the stop: no client error from the parser')
    assert.deepStrictEqual(r.writes, [])
  })

  it('H131-fork-b: without an embedder handler the parser fails loudly AND typed (client error carrying the fact), still suspended', () => {
    const r = harness()
    quietWarn(() => r.feed(RECORDED.map((k) => shift(F[k]))))
    assert.strictEqual(r.errors.length, 1)
    assert.deepStrictEqual(r.errors[0].playTableMismatch, { phase: 'play_entry', first_id: 0x2c, read_as: 'map', outcome: 'drop', frames_before_login: 0 })
    assert.ok(!/Read error|PartialReadError/.test(r.errors[0].message), 'the typed error is not the protodef template')
    assert.deepStrictEqual([...new Set(r.emitted)], ['forge_play_table_mismatch'])
  })

  it('H131-fork-c: the normal stream (custom_payload and bundle_delimiter before login) trips nothing - every frame emitted, login seen, no fact, no error', () => {
    const r = harness({ handler: true })
    r.feed(NORMAL.map((k) => F[k]))
    assert.deepStrictEqual(r.emitted, NORMAL)
    assert.strictEqual(r.facts.length + r.handled.length + r.errors.length, 0)
    assert.strictEqual(r.client._forgePlayEntry.loginSeen, true)
    assert.strictEqual(r.client._forgePlayEntry.framesBeforeLogin, 3, 'the prelude frames counted, not tripped')
  })

  it('H131-fork-d: after login the base tolerance stands byte for byte - a degradable drop is a drop (forge_unparseable_packet + forge_inventory_unreliable), a session-critical failure is the base loud error, no fact either way', () => {
    const r = harness({ handler: true })
    let signal = null
    r.client.on('forge_inventory_unreliable', (d) => { signal = d })
    quietWarn(() => r.feed([...NORMAL.map((k) => F[k]), TRUNCATED_SET_SLOT]))
    assert.strictEqual(r.emitted[r.emitted.length - 1], 'forge_unparseable_packet')
    assert.strictEqual(signal && signal.packet, 'set_slot')
    assert.strictEqual(r.facts.length + r.handled.length + r.errors.length, 0)
    // a critical frame that cannot be read after login: the base path (a raw client error, rethrown), no table fact
    const bad = Buffer.concat([F.update_health.subarray(0, 3)])
    quietWarn(() => r.feed([bad]))
    assert.strictEqual(r.errors.length, 1)
    assert.strictEqual(r.errors[0].playTableMismatch, undefined)
    assert.strictEqual(r.handled.length, 0)
    assert.strictEqual(r.facts.length, 0)
  })

  it('H131-fork-e: a frame that reads only partly under a name other than login before login is the table too (outcome partial), and a loud-class first failure reports outcome throw', () => {
    const partial = harness({ handler: true })
    quietWarn(() => partial.feed([Buffer.concat([F.held_item_slot, Buffer.from([0x00, 0x00])]), F.login]))
    assert.strictEqual(partial.handled.length, 1)
    assert.strictEqual(partial.handled[0].fact.outcome, 'partial')
    assert.strictEqual(partial.handled[0].fact.read_as, 'held_item_slot')
    assert.deepStrictEqual([...new Set(partial.emitted)], ['forge_play_table_mismatch'], 'the login after it is never parsed: suspended')
    const loud = harness({ handler: true })
    quietWarn(() => loud.feed([Buffer.concat([F.update_health.subarray(0, 3)])]))
    assert.strictEqual(loud.handled.length, 1)
    assert.deepStrictEqual(loud.handled[0].fact, { phase: 'play_entry', first_id: 0x5d, read_as: 'update_health', outcome: 'throw', frames_before_login: 0 })
    assert.strictEqual(loud.errors.length, 0)
  })

  it('H131-fork-f: the install is idempotent and the first handler given wins', () => {
    const client = new Client(false, '1.21.1', {}, true)
    const calls = []
    installTolerantPlayParser(client)
    installTolerantPlayParser(client, { onPlayTableMismatch: () => calls.push('second') })
    installTolerantPlayParser(client, { onPlayTableMismatch: () => calls.push('third') })
    client.on('error', () => {})
    client.state = states.PLAY
    quietWarn(() => client.deserializer.write(shift(F.login)))
    assert.deepStrictEqual(calls, ['second'])
  })
})
