/* eslint-env mocha */
// HF48-P3 — the declare_commands HOLD. THE CLASS: Forge 1.21.11 + a 10-jar
// pack (the HF48 census): the server sends declare_commands at play entry
// while the argument-type table is still being derived in the play-entry
// scan worker; the boundary parsed the frame against NO table, met the
// loader's parser ids (63,58,62) and DROPPED the tree for the session
// ("119/193 nodes, derived table: none") — every server command gone
// (tellraw grant withdrawn, /config, mod commands, tab completion). The fix:
// a table that is pending ({derived:false, pendingSource, whenSettled})
// holds the raw frame; the parse runs when the table settles or the budget
// elapses and is delivered through the deserializer's own 'data' path.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const { installDeclareCommandsBoundary, DEFAULT_COMMAND_TREE_HOLD_MS } = require('../src/client/declareCommandsBoundary')

const FRAME = Buffer.from(fs.readFileSync(path.join(__dirname, 'fixtures', 'hf45-declare-commands-neoforge-26.2.hex'), 'utf8').trim(), 'hex')
const MODDED_EXT = { parsers: [{ id: 62, name: 'neoforge:enum', fields: [{ name: 'utf0', type: 'string' }] }, { id: 63, name: 'neoforge:modid', fields: [] }] }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeClient (version = '26.2') {
  const c = new EventEmitter()
  c.version = version
  c.state = 'play'
  c.passthrough = 0
  const des = new EventEmitter()
  des.parsePacketBuffer = (buf) => { c.passthrough++; return { data: { name: 'other', params: {} }, metadata: { size: buf.length }, buffer: buf, fullBuffer: buf } }
  c.deserializer = des
  c.delivered = []
  des.on('data', (p) => c.delivered.push(p))
  return c
}

/** A table whose derivation is in flight: settle(extension) lands the table, then runs the boundary's waiters. */
function pendingTable (source = 'forge-registry-snapshot') {
  const waiters = []
  const table = { derived: false, source: null, registrySize: 0, extension: null, receipt: null, pendingSource: source, whenSettled: (cb) => waiters.push(cb) }
  table.settle = (extension) => {
    if (extension) { table.derived = true; table.source = source; table.registrySize = 64; table.extension = extension; table.receipt = { abstains: [] } } else table.receipt = { error: 'derivation failed', abstains: [] }
    table.pendingSource = null; table.whenSettled = null
    for (const cb of waiters.splice(0)) cb(table)
  }
  table.waiters = waiters
  return table
}

describe('HF48-P3 declareCommandsBoundary — the hold while the argument-type table is in flight', function () {
  it('the default hold budget equals the play-entry scan budget (120 s): the scheduler settles the table at its own budget, the boundary only backstops a scheduler that never answers', () => {
    assert.strictEqual(DEFAULT_COMMAND_TREE_HOLD_MS, 120000)
  })

  it('GREEN — a pending table HOLDS the frame (nothing reaches nmp, the hold is logged); the settle releases it: parsed with the extension, 41/41 nodes, 0 unknown ids, delivered on the deserializer data path, receipt held_ms + released_by=scan-settled', async () => {
    const c = fakeClient()
    const logs = []
    installDeclareCommandsBoundary(c, { log: (m) => logs.push(m) })
    const table = pendingTable()
    c.minepalCommandArgumentTypes = table
    const out = c.deserializer.parsePacketBuffer(FRAME)
    assert.strictEqual(out.data.name, 'declare_commands_held'); assert.strictEqual(out.data.params.source, 'forge-registry-snapshot'); assert.strictEqual(out.metadata.size, FRAME.length)
    const st = c._hf45DeclareCommandsBoundary
    assert.strictEqual(st.held, 1); assert.ok(st.hold, 'hold active'); assert.strictEqual(st.frames, 0); assert.strictEqual(c.minepalCommandTree, undefined)
    assert.strictEqual(logs.length, 1); assert.ok(/HELD/.test(logs[0]) && /forge-registry-snapshot/.test(logs[0]) && /120000 ms/.test(logs[0]), logs[0])
    assert.strictEqual(table.waiters.length, 1)
    assert.deepStrictEqual(c.delivered, [])
    await sleep(15)
    table.settle(MODDED_EXT)
    assert.strictEqual(st.hold, null); assert.strictEqual(st.frames, 1); assert.strictEqual(st.parsed, 1); assert.strictEqual(st.drops, 0)
    assert.strictEqual(c.delivered.length, 1)
    const d = c.delivered[0]
    assert.strictEqual(d.data.name, 'declare_commands'); assert.strictEqual(d.data.params.nodes.length, 41); assert.strictEqual(d.data.params.rootIndex, 0)
    assert.strictEqual(d.buffer, FRAME); assert.strictEqual(d.fullBuffer, FRAME); assert.strictEqual(d.metadata.size, FRAME.length)
    const t = c.minepalCommandTree
    assert.strictEqual(t.parsed, true); assert.deepStrictEqual(t.unknown_parser_ids, []); assert.deepStrictEqual([...t.extended_parser_ids].sort(), [62, 63]); assert.strictEqual(t.bytes_unconsumed, 0)
    assert.ok(t.held_ms >= 10, `held_ms ${t.held_ms}`); assert.strictEqual(t.released_by, 'scan-settled'); assert.strictEqual(t.table.derived, true); assert.deepStrictEqual(t.table.derived_ids, [62, 63])
    assert.strictEqual(logs.length, 2); assert.ok(/parsed: 41\/41/.test(logs[1]) && /after a \d+ ms hold/.test(logs[1]) && /released by scan-settled/.test(logs[1]), logs[1])
  })

  it('the budget path: the table never settles -> at holdMs the frame is parsed with whatever exists (today: dropped naming 62,63), delivered as declare_commands_dropped, command_tree_dropped emitted, released_by=hold-budget — the frame is never lost', async () => {
    const c = fakeClient()
    const logs = []
    installDeclareCommandsBoundary(c, { log: (m) => logs.push(m), holdMs: 40 })
    c.minepalCommandArgumentTypes = pendingTable('fabric-registry-sync')
    let dropped = null
    c.on('command_tree_dropped', (r) => { dropped = r })
    assert.strictEqual(c.deserializer.parsePacketBuffer(FRAME).data.name, 'declare_commands_held')
    await sleep(20)
    assert.ok(c._hf45DeclareCommandsBoundary.hold, 'still held before the budget'); assert.strictEqual(dropped, null)
    await sleep(80)
    assert.strictEqual(c._hf45DeclareCommandsBoundary.hold, null)
    assert.strictEqual(c.delivered.length, 1); assert.strictEqual(c.delivered[0].data.name, 'declare_commands_dropped')
    assert.ok(dropped); assert.deepStrictEqual([...dropped.unknown_parser_ids].sort(), [62, 63]); assert.strictEqual(dropped.released_by, 'hold-budget'); assert.ok(dropped.held_ms >= 40, `held_ms ${dropped.held_ms}`)
    assert.strictEqual(dropped.table.derived, false); assert.strictEqual(dropped.table.source, null)
    assert.ok(/DROPPED/.test(logs[1]) && /derived table: none/.test(logs[1]) && /released by hold-budget/.test(logs[1]), logs[1])
  })

  it('no derivation pending = no hold, byte-identical to HF45: no table -> immediate drop; a settled table -> immediate parse; a pending source WITHOUT whenSettled -> immediate (the contract is the pair); receipts say released_by=no-derivation, held_ms 0', () => {
    const a = fakeClient()
    installDeclareCommandsBoundary(a, { log: () => {} })
    assert.strictEqual(a.deserializer.parsePacketBuffer(FRAME).data.name, 'declare_commands_dropped')
    assert.strictEqual(a._hf45DeclareCommandsBoundary.held, 0); assert.strictEqual(a.minepalCommandTree.held_ms, 0); assert.strictEqual(a.minepalCommandTree.released_by, 'no-derivation'); assert.deepStrictEqual(a.delivered, [])
    const b = fakeClient()
    installDeclareCommandsBoundary(b, { log: () => {} })
    b.minepalCommandArgumentTypes = { derived: true, source: 'neoforge-frozen-registry', registrySize: 64, extension: MODDED_EXT, receipt: { abstains: [] }, pendingSource: null, whenSettled: null }
    const out = b.deserializer.parsePacketBuffer(FRAME)
    assert.strictEqual(out.data.name, 'declare_commands'); assert.strictEqual(out.data.params.nodes.length, 41)
    assert.strictEqual(b._hf45DeclareCommandsBoundary.held, 0); assert.strictEqual(b.minepalCommandTree.released_by, 'no-derivation'); assert.deepStrictEqual(b.delivered, [])
    const d = fakeClient()
    installDeclareCommandsBoundary(d, { log: () => {} })
    d.minepalCommandArgumentTypes = { derived: false, pendingSource: 'forge-registry-snapshot' }
    assert.strictEqual(d.deserializer.parsePacketBuffer(FRAME).data.name, 'declare_commands_dropped'); assert.strictEqual(d._hf45DeclareCommandsBoundary.held, 0)
  })

  it('a second copy of the tree while the first waits supersedes it (the newest frame is parsed once at release, counted); other packets pass through the whole time', () => {
    const c = fakeClient()
    installDeclareCommandsBoundary(c, { log: () => {} })
    const table = pendingTable()
    c.minepalCommandArgumentTypes = table
    c.deserializer.parsePacketBuffer(Buffer.concat([FRAME.subarray(0, 1), Buffer.from([0x00])])) // a truncated copy first
    c.deserializer.parsePacketBuffer(Buffer.from([0x27, 0x00]))
    const second = c.deserializer.parsePacketBuffer(FRAME)
    assert.strictEqual(second.data.name, 'declare_commands_held'); assert.strictEqual(second.data.params.superseded, 1)
    assert.strictEqual(c.passthrough, 1); assert.strictEqual(c._hf45DeclareCommandsBoundary.held, 1)
    table.settle(MODDED_EXT)
    assert.strictEqual(c.delivered.length, 1); assert.strictEqual(c.delivered[0].data.name, 'declare_commands'); assert.strictEqual(c.delivered[0].data.params.nodes.length, 41)
    assert.strictEqual(c._hf45DeclareCommandsBoundary.frames, 1)
  })

  it('settled inside the hold call (whenSettled runs the callback at once): the frame is parsed in place and returned, nothing is delivered twice', () => {
    const c = fakeClient()
    installDeclareCommandsBoundary(c, { log: () => {} })
    c.minepalCommandArgumentTypes = { derived: false, pendingSource: 'forge-registry-snapshot', whenSettled: (cb) => { c.minepalCommandArgumentTypes.derived = true; c.minepalCommandArgumentTypes.extension = MODDED_EXT; c.minepalCommandArgumentTypes.source = 'forge-registry-snapshot'; cb() } }
    const out = c.deserializer.parsePacketBuffer(FRAME)
    assert.strictEqual(out.data.name, 'declare_commands'); assert.strictEqual(out.data.params.nodes.length, 41)
    assert.strictEqual(c.minepalCommandTree.released_by, 'scan-settled'); assert.deepStrictEqual(c.delivered, []); assert.strictEqual(c._hf45DeclareCommandsBoundary.hold, null)
  })

  it('the client left play before the release (nmp swapped the deserializer): the stale frame is not delivered into the wrong state, counted as holdLost, logged', () => {
    const c = fakeClient()
    const logs = []
    installDeclareCommandsBoundary(c, { log: (m) => logs.push(m) })
    const table = pendingTable()
    c.minepalCommandArgumentTypes = table
    c.deserializer.parsePacketBuffer(FRAME)
    const old = c.deserializer
    c.state = 'configuration'; c.deserializer = new EventEmitter()
    table.settle(MODDED_EXT)
    assert.strictEqual(c._hf45DeclareCommandsBoundary.holdLost, 1); assert.strictEqual(c._hf45DeclareCommandsBoundary.frames, 0)
    assert.deepStrictEqual(c.delivered, []); assert.strictEqual(c.minepalCommandTree, undefined)
    assert.ok(/left play/.test(logs[1]), logs[1]); assert.strictEqual(old.listenerCount('data'), 1)
  })

  it('r2 HIGH — a play RE-ENTRY while the frame waits (configuration state, a new deserializer, play again): the stale hold is dropped on leaving play (holdLost 1, timer cleared, logged), the fresh tree on the NEW deserializer is held on its own and delivered EXACTLY ONCE at the settle (41/41), never counted as a re-sent copy', async () => {
    const c = fakeClient()
    const logs = []
    installDeclareCommandsBoundary(c, { log: (m) => logs.push(m) })
    const table = pendingTable()
    c.minepalCommandArgumentTypes = table
    const des1 = c.deserializer
    c.deserializer.parsePacketBuffer(FRAME)
    const st = c._hf45DeclareCommandsBoundary
    const h1 = st.hold
    assert.ok(h1 && h1.des === des1 && h1.timer)
    c.state = 'configuration'; c.emit('state', 'configuration', 'play')
    assert.strictEqual(st.hold, null); assert.strictEqual(st.holdLost, 1); assert.ok(/left play \(state configuration\)/.test(logs[1]), logs[1])
    const des2 = new EventEmitter()
    des2.parsePacketBuffer = () => { throw new Error('should not reach the inner parser') }
    c.deserializer = des2; c.state = 'play'; c.emit('state', 'play', 'configuration')
    des2.on('data', (p) => c.delivered.push(p))
    const r2 = des2.parsePacketBuffer(FRAME)
    assert.strictEqual(r2.data.name, 'declare_commands_held'); assert.strictEqual(r2.data.params.superseded, undefined)
    assert.ok(st.hold && st.hold.des === des2 && st.hold !== h1); assert.strictEqual(st.held, 2)
    table.settle(MODDED_EXT)
    await sleep(5)
    assert.strictEqual(c.delivered.length, 1); assert.strictEqual(c.delivered[0].data.name, 'declare_commands')
    assert.strictEqual(c.minepalCommandTree.nodes_read, 41); assert.strictEqual(c.minepalCommandTree.nodes_declared, 41); assert.strictEqual(c.minepalCommandTree.released_by, 'scan-settled')
    assert.strictEqual(st.frames, 1); assert.strictEqual(st.parsed, 1); assert.strictEqual(st.holdLost, 1); assert.strictEqual(st.hold, null)
    assert.strictEqual(des1.listenerCount('data'), 1) // no delivery on the old deserializer
  })

  it('r2 HIGH — the same re-entry WITHOUT a state event (the deserializer swapped under the hold): the frame on the new deserializer is not mistaken for a re-sent copy — the stale hold is dropped at parse time and the fresh frame holds and delivers once', async () => {
    const c = fakeClient()
    const logs = []
    installDeclareCommandsBoundary(c, { log: (m) => logs.push(m) })
    const table = pendingTable()
    c.minepalCommandArgumentTypes = table
    c.deserializer.parsePacketBuffer(FRAME)
    const st = c._hf45DeclareCommandsBoundary
    const des2 = new EventEmitter()
    des2.parsePacketBuffer = () => { throw new Error('should not reach the inner parser') }
    c.deserializer = des2; c.emit('state', 'play', 'play')
    des2.on('data', (p) => c.delivered.push(p))
    const r2 = des2.parsePacketBuffer(FRAME)
    assert.strictEqual(r2.data.name, 'declare_commands_held'); assert.strictEqual(r2.data.params.superseded, undefined)
    assert.strictEqual(st.holdLost, 1); assert.ok(/re-entered play on a new deserializer/.test(logs[1]), logs[1])
    table.settle(MODDED_EXT)
    await sleep(5)
    assert.strictEqual(c.delivered.length, 1); assert.strictEqual(c.delivered[0].data.name, 'declare_commands'); assert.strictEqual(st.parsed, 1)
  })

  it('r2 MED — the client ENDS while the frame waits: the hold is dropped at once (timer cleared, holdLost 1, logged), nothing is parsed or delivered into the ended client at the budget or at a late settle', async () => {
    const c = fakeClient()
    const logs = []
    installDeclareCommandsBoundary(c, { log: (m) => logs.push(m), holdMs: 40 })
    const table = pendingTable()
    c.minepalCommandArgumentTypes = table
    c.deserializer.parsePacketBuffer(FRAME)
    const st = c._hf45DeclareCommandsBoundary
    const h = st.hold
    c.emit('end')
    assert.strictEqual(st.hold, null); assert.strictEqual(st.holdLost, 1); assert.ok(/client ended while it waited/.test(logs[1]), logs[1])
    assert.strictEqual(typeof h.timer.hasRef === 'function' ? h.timer.hasRef() : false, false)
    await sleep(80)
    table.settle(MODDED_EXT)
    await sleep(5)
    assert.deepStrictEqual(c.delivered, []); assert.strictEqual(st.frames, 0); assert.strictEqual(c.minepalCommandTree, undefined)
    assert.strictEqual(logs.length, 2)
  })
})
