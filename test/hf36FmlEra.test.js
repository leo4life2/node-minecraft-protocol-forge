/* eslint-env mocha */
'use strict'

// HF36 — FML2 login-era law + the pending-transaction ledger (rig receipt:
// Forge 1.16.5 + OpenTerrainGenerator, otg:login). FML2 cannot accept the
// vanilla not-understood decline (FMLLoginWrapper routes a null payload to
// fml:handshake -> "Received empty payload" -> unexpected_query_response), so
// the ladder never returns {declined} on that era: convention ack, receipted
// as a guess. FML3+ keeps the HF8/HF13 decline. Every login query is owed
// exactly one reply: duplicates and unknown ids never reach the wire.

const assert = require('assert')
const { EventEmitter } = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')
const forgeHandshake2 = require('../src/client/forgeHandshake2')
const forgeHandshake3 = require('../src/client/forgeHandshake3')
const { wrapLoginPayload, encodeAcknowledgement } = forgeHandshake3
const { writeLoginReplyNow, registerLoginQuery } = require('../src/client/loginReplyBoundary')
const { assessLoginChannel } = require('../src/client/loginAckDerivation')
const { buildClass, buildJar } = require('./helpers/synthJar')

const drain = () => new Promise((resolve) => setImmediate(() => setImmediate(() => setImmediate(resolve))))
function makeClient () {
  const c = new EventEmitter()
  c.written = []
  c.state = 'login'
  c.ended = false
  c.compressor = null
  c.write = (name, params) => { c.written.push({ name, params }) }
  c.registerChannel = () => {}
  c.end = () => { c.ended = true }
  c.on('login_plugin_request', function onLoginPluginRequest () {})
  return c
}
const QUERY = (id) => ({ messageId: id, channel: 'fml:loginwrapper', data: wrapLoginPayload('otg:login', Buffer.concat([Buffer.from([0x00]), Buffer.alloc(8, 0x7f)])) })
const ACK = wrapLoginPayload('otg:login', encodeAcknowledgement())
let warn, log
beforeEach(() => { warn = console.warn; log = console.log; console.warn = () => {}; console.log = () => {} })
afterEach(() => { console.warn = warn; console.log = log })

describe('HF36 FML2 login-era law', function () {
  it('FML2: announced-but-unheld channel -> convention ack receipted as a guess, never the decline', async () => {
    const client = makeClient()
    forgeHandshake2(client, { modsPaths: [], pingModVersions: { otg: '1.16.5-0.1.10' } })
    client.emit('login_plugin_request', QUERY(0))
    await drain()
    assert.strictEqual(client.written.length, 1)
    assert.deepStrictEqual(client.written[0].params.data, ACK)
    assert.strictEqual(client.forgeDeclinedLoginChannels, undefined)
    assert.strictEqual(client.forgeGuessedLoginAcks[0].era, 'fml2')
    assert.strictEqual(client.forgeGuessedLoginAcks[0].ownerMod, 'otg')
  })

  it('FML3: the same query keeps the HF13 decline byte-for-byte', async () => {
    const client = makeClient()
    forgeHandshake3(client, { modsPaths: [], pingModVersions: { otg: '1.16.5-0.1.10' } })
    client.emit('login_plugin_request', QUERY(1))
    await drain()
    assert.strictEqual(client.written.length, 1)
    assert.strictEqual(client.written[0].params.data, undefined)
    assert.strictEqual(client.forgeDeclinedLoginChannels[0].reason, 'uncorroborated-by-local-jars')
    assert.strictEqual(client.forgeGuessedLoginAcks, undefined)
  })

  it('ledger: one reply per pending id — duplicate and unknown ids are dropped with a receipt; no ledger fails open', async () => {
    const client = makeClient()
    forgeHandshake2(client, { modsPaths: [], pingModVersions: {} })
    client.emit('login_plugin_request', QUERY(5))
    await drain()
    assert.strictEqual(client.written.length, 1)
    assert.strictEqual(writeLoginReplyNow(client, { messageId: 5 }, { channel: 'otg:login', kind: 'second organ' }), false)
    assert.strictEqual(writeLoginReplyNow(client, { messageId: 77, data: ACK }, { channel: 'otg:login', kind: 'stray' }), false)
    assert.strictEqual(client.written.length, 1)
    assert.ok(/^duplicate-reply/.test(client.forgeDroppedLoginReplies[0].why))
    assert.strictEqual(client.forgeDroppedLoginReplies[1].why, 'unknown-transaction')
    registerLoginQuery(client, 8, { channel: 'a:b' })
    assert.strictEqual(writeLoginReplyNow(client, { messageId: 8 }, { channel: 'a:b', kind: 'x' }), true)
    assert.strictEqual(writeLoginReplyNow(client, { messageId: 8 }, { channel: 'a:b', kind: 'y' }), false)
    const bare = makeClient()
    assert.strictEqual(writeLoginReplyNow(bare, { messageId: 1 }, { kind: 'embedder' }), true)
  })

  it('R1: net/minecraft/util/ResourceLocation (Forge 1.13-1.16 MCP/SRG) is a channel-naming class for the derivation', () => {
    const RL = 'net/minecraft/util/ResourceLocation'
    const SC = 'net/minecraftforge/fml/network/simple/SimpleChannel'
    const MB = 'net/minecraftforge/fml/network/simple/SimpleChannel$MessageBuilder'
    const NR = 'net/minecraftforge/fml/network/NetworkRegistry'
    const PB = 'net/minecraft/network/PacketBuffer'
    const AI = 'java/util/concurrent/atomic/AtomicInteger'
    const owner = 'synth/hf36/Net'
    const ack = 'synth/hf36/Ack'
    const reg = (a, cls) => a.getstatic(owner, 'CHANNEL', `L${SC};`).ldcCls(cls).getstatic(owner, 'COUNT', `L${AI};`)
      .invokevirtual(AI, 'getAndIncrement', '()I').invokevirtual(SC, 'messageBuilder', `(Ljava/lang/Class;I)L${MB};`)
      .invokevirtual(MB, 'loginIndex', `(Ljava/util/function/Function;Ljava/util/function/BiConsumer;)L${MB};`).invokevirtual(MB, 'add', '()V')
    const net = buildClass({
      name: owner,
      methods: [
        { name: '<clinit>', desc: '()V', flags: 0x0008, code: (a) => a.new_(RL).dup().ldcStr('hf36').ldcStr('login').invokespecial(RL, '<init>', '(Ljava/lang/String;Ljava/lang/String;)V').invokestatic(NR, 'newSimpleChannel', `(L${RL};)L${SC};`).putstatic(owner, 'CHANNEL', `L${SC};`).new_(AI).dup().iconst(99).invokespecial(AI, '<init>', '(I)V').putstatic(owner, 'COUNT', `L${AI};`).ret() },
        { name: 'init', desc: '()V', code: (a) => { reg(a, ack); return a.ret() } }
      ]
    })
    const enc = buildClass({ name: ack, methods: [{ name: 'encode', desc: `(L${ack};L${PB};)V`, code: (a) => a.ret() }] })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf36-lib-'))
    fs.writeFileSync(path.join(dir, 'hf36.jar'), buildJar([{ name: `${owner}.class`, data: net }, { name: `${ack}.class`, data: enc }]))
    const assessed = assessLoginChannel('hf36:login', [dir])
    assert.strictEqual(assessed.verdict, 'ack', `${assessed.verdict} ${assessed.reason || ''}`)
    assert.strictEqual(assessed.index, 99)
  })
})
