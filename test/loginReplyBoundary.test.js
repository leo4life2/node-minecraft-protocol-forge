/* eslint-env mocha */
'use strict'
// HF36 + HF38 unified login-reply boundary (2026-09-06): one pending-id
// ledger keyed by id AND open-order, the login-window budget, and the bounded
// post-compression deferral — pinned on stub clients driving the REAL organs.
//
// Receipts: hf38 rig ledger-v1cold.json (Kilt 20.1.14: ids 0/1 name the FML
// S2CModData/ModList queries at ~30/60 ms AND the raw Fabric API queries
// fabric-networking-api-v1:early_registration / fabric:custom_ingredient_sync
// at ~1.2 s — Fabric's counter restarts at 0 after the Forge handshake);
// hf38 verify-r1 MED-2 (byId overwrite settled the wrong twin) and MED-4 (a
// two-hop deferral could drain a reply into PLAY after set_compression).
const assert = require('assert')
const { EventEmitter } = require('events')
const forgeHandshake3 = require('../src/client/forgeHandshake3')
const loginWindow = require('../src/client/loginWindow')
const { writeLoginReplyNow, writeLoginReplyDeferred, registerLoginQuery, POST_COMPRESSION_HOLD_MS } = require('../src/client/loginReplyBoundary')
const { LOGIN_ACK_DERIVATION_VERSION } = require('../src/client/loginAckDerivation')

const drain = () => new Promise((resolve) => setImmediate(() => setImmediate(() => setImmediate(resolve))))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function makeClient (windowOpts) {
  const c = new EventEmitter()
  c.setMaxListeners(50)
  c.written = []
  c.state = 'login'
  c.ended = false
  c.compressor = null
  c.write = (name, params) => { if (name === 'login_plugin_response') c.written.push(params) }
  c.registerChannel = () => {}
  c.end = () => { c.ended = true; c.emit('end') }
  c.on('login_plugin_request', function onLoginPluginRequest () {})
  if (windowOpts !== false) loginWindow.installLoginWindow(c, windowOpts || {})
  return c
}
const RAW = (id, channel) => ({ messageId: id, channel, data: Buffer.from([0x05, 1, 2, 3, 4, 5]) })
const count = (c, id) => c.written.filter((p) => p.messageId === id).length
let warn, log, error
beforeEach(() => { warn = console.warn; log = console.log; error = console.error; console.warn = () => {}; console.log = () => {}; console.error = () => {} })
afterEach(() => { console.warn = warn; console.log = log; console.error = error })

describe('unified login-reply boundary (HF36 ledger + HF38 window)', function () {
  it('MED-2 Kilt sequence: an id closed early (S2CModData no-reply / ModList answered) is reused by a raw Fabric API query later — the twin is a NEW open entry and gets its own reply, never a duplicate refusal', async () => {
    const c = makeClient()
    forgeHandshake3(c, { modsPaths: [], pingModVersions: {} })
    // the early Forge-handshake twins, filed as the organ files them (the
    // lockstep bodies themselves are pinned by the fml:handshake suites)
    loginWindow.noteQuery(c, { messageId: 0, channel: 'fml:loginwrapper' })
    loginWindow.noteStop(c, 0, 'no-reply-expected', 'S2CModData: the reference client sends nothing')
    loginWindow.noteQuery(c, { messageId: 1, channel: 'fml:loginwrapper' })
    assert.strictEqual(writeLoginReplyNow(c, { messageId: 1, data: Buffer.from([9]) }, { channel: 'fml:handshake', kind: 'ModListReply' }), true)
    // ... 1.2 s later Fabric's counter restarts at 0: the REAL raw-channel organ answers both
    c.emit('login_plugin_request', RAW(0, 'fabric-networking-api-v1:early_registration'))
    c.emit('login_plugin_request', RAW(1, 'fabric:custom_ingredient_sync'))
    await drain()
    assert.strictEqual(count(c, 0), 1, 'the raw id-0 twin was declined on the wire')
    assert.strictEqual(count(c, 1), 2, 'ModListReply + the raw id-1 twin decline')
    const s = loginWindow.loginWindowSummary(c)
    assert.deepStrictEqual([s.counts.answered, s.counts.declined, s.counts.noReply, s.counts.refused, s.counts.dropped], [1, 2, 1, 0, 0])
    assert.deepStrictEqual(s.queries.map((q) => `${q.messageId}:${q.outcome}`), ['0:no-reply-expected', '1:answered', '0:declined', '1:declined'])
    assert.strictEqual((c.forgeDroppedLoginReplies || []).length, 0)
  })

  it('MED-2 both twins OPEN: a reply settles the most recent open entry with its id, the next reply settles the older one, a third is refused (never a second verdict on either)', async () => {
    const c = makeClient()
    c.emit('login_plugin_request', RAW(7, 'a:first'))
    c.emit('login_plugin_request', RAW(7, 'b:second'))
    assert.strictEqual(writeLoginReplyNow(c, { messageId: 7, data: Buffer.from([1]) }, { channel: 'b:second', kind: 'reply' }), true)
    assert.strictEqual(writeLoginReplyNow(c, { messageId: 7 }, { channel: 'a:first', kind: 'decline' }), true)
    assert.strictEqual(writeLoginReplyNow(c, { messageId: 7 }, { channel: 'a:first', kind: 'late rung' }), false)
    const s = loginWindow.loginWindowSummary(c)
    assert.deepStrictEqual(s.queries.map((q) => `${q.channel}:${q.outcome}`), ['a:first:declined', 'b:second:answered'])
    assert.strictEqual(s.counts.refused, 1)
    assert.ok(/^duplicate-reply: already-closed-answered/.test(s.refused[0].why), s.refused[0].why) // the most recent id-7 entry is the answered twin
    assert.strictEqual(c.written.length, 2)
  })

  it('MED-2 the budget stop closes ITS OWN entry under a duplicated id (context.entry), not the newer twin', async () => {
    const c = makeClient({ loginQueryBudgetMs: 40, loginWindowSafetyMs: 10 })
    c.emit('login_plugin_request', RAW(3, 'old:raw'))
    await sleep(20)
    c.emit('login_plugin_request', RAW(3, 'new:raw'))
    await sleep(300)
    const s = loginWindow.loginWindowSummary(c)
    assert.strictEqual(s.queries[0].outcome, 'budget-declined')
    assert.strictEqual(s.queries[0].channel, 'old:raw')
    assert.strictEqual(s.queries[1].outcome, 'budget-declined')
    assert.strictEqual(count(c, 3), 2)
  })

  it('P4 (HF36): unknown ids and post-close replies are refused with a receipt; the query verdicts stand; no ledger fails open', async () => {
    const c = makeClient()
    c.emit('login_plugin_request', RAW(5, 'x:y'))
    assert.strictEqual(writeLoginReplyNow(c, { messageId: 5 }, { channel: 'x:y', kind: 'decline' }), true)
    assert.strictEqual(writeLoginReplyNow(c, { messageId: 5 }, { channel: 'x:y', kind: 'second organ' }), false)
    assert.strictEqual(writeLoginReplyNow(c, { messageId: 77 }, { channel: 'x:y', kind: 'stray' }), false)
    assert.deepStrictEqual(c.forgeDroppedLoginReplies.map((d) => d.why.split(' ')[0]), ['duplicate-reply:', 'unknown-transaction'])
    registerLoginQuery(c, 8, { channel: 'a:b' })
    assert.strictEqual(writeLoginReplyNow(c, { messageId: 8 }, { channel: 'a:b', kind: 'x' }), true)
    c.emit('login_plugin_request', RAW(6, 'z:z'))
    c.emit('success'); c.state = 'play'
    assert.strictEqual(writeLoginReplyNow(c, { messageId: 6 }, { channel: 'z:z', kind: 'late' }), false)
    const s = loginWindow.loginWindowSummary(c)
    assert.strictEqual(s.counts.refused, 2, 'a late reply to a query the close filed unanswered is not a refusal')
    assert.strictEqual(s.counts.dropped, 1, 'the late reply is the dropped query')
    assert.strictEqual(s.counts.unanswered, 0)
    assert.strictEqual(s.queries.find((q) => q.messageId === 6).outcome, 'dropped')
    assert.match(c.forgeDroppedLoginReplies[2].why, /^late-reply: window closed \(endedBy=login-success\)$/)
    const bare = makeClient(false)
    assert.strictEqual(writeLoginReplyNow(bare, { messageId: 1 }, { kind: 'embedder' }), true)
  })

  it('MED-4: after set_compression a deferred reply is HELD — login success arriving before the bound drops it (never a PLAY-state 0x02), a silent server gets it at the bound, an unarmed client after the two hops', async () => {
    // (a) success races the deferred reply: dropped, not written into PLAY
    const a = makeClient()
    a.emit('login_plugin_request', RAW(1, 'tacz:handshake'))
    a.compressor = { compressionThreshold: 256 }
    writeLoginReplyDeferred(a, { messageId: 1 }, { channel: 'tacz:handshake', kind: 'wrapped decline' })
    await drain()
    assert.strictEqual(a.written.length, 0, 'held after the two hops')
    // nmp emits 'packet' then the named event in one synchronous frame; play.js sets state there
    a.emit('packet', {}, { name: 'success' }); a.state = 'play'; a.emit('success')
    await drain()
    assert.strictEqual(a.written.length, 0, 'a reply drained after success is dropped, never written')
    // the window closed on success before the reply was ready: a LATE reply, receipted as such (never duplicate-reply), the query's one verdict = dropped
    assert.match(a.forgeDroppedLoginReplies[0].why, /^late-reply: window closed \(endedBy=(login-success|state-play)\)$/)
    const sa = loginWindow.loginWindowSummary(a)
    assert.strictEqual(sa.counts.unanswered, 0)
    assert.strictEqual(sa.counts.dropped, 1)
    assert.strictEqual(sa.counts.refused, 0)
    assert.deepStrictEqual(sa.queries.map((q) => q.outcome), ['dropped'])
    assert.strictEqual(sa.queries[0].channel, 'tacz:handshake')
    // (b) the server is blocked on us (an awaited post-compression Fabric query): written at the bound
    const b = makeClient()
    b.emit('login_plugin_request', RAW(2, 'fabric:custom_ingredient_sync'))
    b.compressor = { compressionThreshold: 256 }
    const t0 = Date.now()
    writeLoginReplyDeferred(b, { messageId: 2 }, { channel: 'fabric:custom_ingredient_sync', kind: 'raw-channel not-understood' })
    await drain()
    assert.strictEqual(b.written.length, 0)
    await sleep(POST_COMPRESSION_HOLD_MS + 40)
    assert.strictEqual(b.written.length, 1, 'written at the bound')
    assert.ok(Date.now() - t0 >= POST_COMPRESSION_HOLD_MS - 5)
    // (c) a further login query arriving proves the server is still in login: written right after it
    const d = makeClient()
    d.emit('login_plugin_request', RAW(3, 'p:q'))
    d.compressor = { compressionThreshold: 256 }
    writeLoginReplyDeferred(d, { messageId: 3 }, { channel: 'p:q', kind: 'raw-channel reply' })
    await drain()
    d.emit('packet', RAW(4, 'p:r'), { name: 'login_plugin_request' }); d.emit('login_plugin_request', RAW(4, 'p:r'))
    await drain()
    assert.strictEqual(d.written.length, 1)
    // (d) not armed: the pre-existing two-hop deferral
    const e = makeClient()
    e.emit('login_plugin_request', RAW(9, 'p:q'))
    writeLoginReplyDeferred(e, { messageId: 9 }, { channel: 'p:q', kind: 'raw-channel reply' })
    await drain()
    assert.strictEqual(e.written.length, 1)
  })

  it('HF38 rider (one breath: query + set_compression + success): the deferred reply is late, receipted "late-reply: window closed", the query is dropped (one verdict) — never duplicate-reply, nothing written after success', async () => {
    const c = makeClient()
    c.emit('login_plugin_request', RAW(0, 'stubmod:hello'))
    writeLoginReplyDeferred(c, { messageId: 0 }, { channel: 'stubmod:hello', kind: 'raw-channel not-understood' })
    c.compressor = { compressionThreshold: 256 }
    c.emit('packet', {}, { name: 'success' }); c.state = 'play'; c.emit('success')
    await drain()
    await new Promise((r) => setTimeout(r, POST_COMPRESSION_HOLD_MS + 50))
    assert.strictEqual(c.written.length, 0, '0 post-success frames')
    assert.strictEqual(c.forgeDroppedLoginReplies.length, 1)
    assert.match(c.forgeDroppedLoginReplies[0].why, /^late-reply: window closed \(endedBy=(login-success|state-play)\)$/) // the fake client closes on 'success'; nmp's real client flips state first (P2 stub: state-play)
    assert.ok(!/duplicate-reply/.test(c.forgeDroppedLoginReplies[0].why))
    const s = loginWindow.loginWindowSummary(c)
    assert.deepStrictEqual({ dropped: s.counts.dropped, refused: s.counts.refused, unanswered: s.counts.unanswered }, { dropped: 1, refused: 0, unanswered: 0 })
    assert.strictEqual(s.queries.length, 1)
    assert.strictEqual(s.queries[0].why, c.forgeDroppedLoginReplies[0].why)
    assert.strictEqual(s.unansweredAtClose.length, 0)
  })

  it('MED-3: the lib exports its derivation version for the embedder\'s persistent cache key', () => {
    assert.ok(Number.isInteger(LOGIN_ACK_DERIVATION_VERSION) && LOGIN_ACK_DERIVATION_VERSION >= 2)
  })
})
