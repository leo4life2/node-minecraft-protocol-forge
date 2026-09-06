/* eslint-env mocha */
// HF37 — the configuration pong is HELD until the negotiation verdict.
// Field: 20/20 silent config-phase closes (0.10.3→0.11.0) were win32; the
// same server gave setup_failed→ECONNRESET and a full named kick 30 s apart.
// Mechanism (rig-proven, RFC 2525 §2.17): our pong lands unread in the
// server's receive buffer while it negotiates; a close with unread bytes is
// an RST, and Windows discards the receive buffer on RST — the named verdict
// vanishes. Holding the pong keeps that buffer empty: FIN, verdict read.
const assert = require('assert')
const { EventEmitter } = require('events')
const { installNeoForgeConfigNegotiation, writeVarInt, writeString } = require('../src/client/neoForgeConfig')

function makeClient () {
  const c = new EventEmitter()
  c.state = 'configuration'
  c.writes = []
  c.write = (name, params) => { c.writes.push({ name, params }) }
  return c
}
const components = { configuration: [], play: [{ id: 'synth:hello', version: '1', flow: 'serverbound', optional: false }] }
const meta = { state: 'configuration', name: 'custom_payload' }
const query = (c) => c.emit('packet', { channel: 'neoforge:register', data: Buffer.alloc(1) }, meta)
const setupOk = Buffer.concat([writeVarInt(1), writeVarInt(1), writeVarInt(1), writeString('synth:hello'), writeString('synth:hello'), writeString('1')])
const pongs = (c) => c.writes.filter((w) => w.name === 'pong')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe('HF37 configuration pong hold', function () {
  it('a pong answered after our claim is held; the neoforge:network verdict releases it (in order, once)', () => {
    const c = makeClient()
    installNeoForgeConfigNegotiation(c, { components, pongHoldMs: 5000 })
    query(c)
    assert.ok(c.writes.some((w) => w.name === 'custom_payload' && w.params.channel === 'neoforge:register'), 'claim answered')
    c.write('pong', { id: 0 })
    assert.strictEqual(pongs(c).length, 0, 'pong held while the verdict is pending')
    c.emit('packet', { channel: 'neoforge:network', data: setupOk }, meta)
    assert.strictEqual(pongs(c).length, 1, 'released exactly once on the verdict')
    assert.deepStrictEqual(pongs(c)[0].params, { id: 0 })
    assert.strictEqual(c.neoForgeConfig.pongHold.outcome, 'verdict neoforge:network')
    assert.ok(c.neoForgeConfig.pongHold.heldMs >= 0)
    c.write('pong', { id: 1 })
    assert.strictEqual(pongs(c).length, 2, 'later pongs pass straight through once negotiated')
  })

  it('a failure verdict DROPS the held pong for good — nothing of ours sits unread in the closing server\'s buffer', () => {
    const c = makeClient()
    installNeoForgeConfigNegotiation(c, { components, pongHoldMs: 5000 })
    query(c)
    c.write('pong', { id: 0 })
    c.emit('packet', { channel: 'neoforge:modded_network_setup_failed', data: Buffer.from([0]) }, meta)
    assert.strictEqual(pongs(c).length, 0, 'dropped')
    assert.strictEqual(c.neoForgeConfig.pongHold.outcome, 'verdict modded_network_setup_failed')
    c.emit('end')
    assert.strictEqual(pongs(c).length, 0)
  })

  it('no verdict: the bounded fallback releases the pong (the login window is never risked)', async () => {
    const c = makeClient()
    installNeoForgeConfigNegotiation(c, { components, pongHoldMs: 20 })
    query(c)
    c.write('pong', { id: 0 })
    assert.strictEqual(pongs(c).length, 0)
    await sleep(60)
    assert.strictEqual(pongs(c).length, 1, 'released by the fallback')
    assert.strictEqual(c.neoForgeConfig.pongHold.outcome, 'fallback timeout')
  })

  it('a pong BEFORE our claim (vanilla ordering) and outside the configuration state is never held', () => {
    const c = makeClient()
    installNeoForgeConfigNegotiation(c, { components, pongHoldMs: 5000 })
    c.write('pong', { id: 7 })
    assert.strictEqual(pongs(c).length, 1, 'no claim yet: pass-through')
    c.state = 'play'
    query(c) // ignored (meta says configuration but the client is in play — the claim path still answers; the hold gate reads client.state)
    c.write('pong', { id: 8 })
    assert.strictEqual(pongs(c).length, 2, 'not in configuration: pass-through')
  })
})
