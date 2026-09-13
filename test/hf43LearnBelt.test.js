/* eslint-env mocha */
// HF43 — the LEARN BELT's lib half: the server's own neoforge:register query
// decoded (its component sets), the negotiator's failure rows read as typed
// verdicts (the rule key sits INSIDE failure.mod's arguments; flow/version
// rules carry their expected value as arguments), and learned rows riding
// the claim STAMPED learned with their payloads received-and-dropped.
const assert = require('assert')
const { EventEmitter } = require('events')
const {
  installNeoForgeConfigNegotiation, encodeNetworkQuery, decodeNetworkQuery, negotiationDelta,
  classifyNegotiationFailure, writeVarInt, writeString
} = require('../src/client/neoForgeConfig')

function makeClient () {
  const c = new EventEmitter()
  c.state = 'configuration'
  c.writes = []
  c.write = (name, params) => { c.writes.push({ name, params }) }
  return c
}
const meta = { state: 'configuration', name: 'custom_payload' }
const MOD = (inner) => ({ translate: 'neoforge.network.negotiation.failure.mod', with: ['somemod', inner] })

describe('HF43 learn belt (lib)', function () {
  it('decodeNetworkQuery is the inverse of encodeNetworkQuery (flows, optional flags, both protocols; the empty 26.1 query decodes to no rows)', () => {
    const comps = { configuration: [{ id: 'a:b', version: '1', flow: null, optional: false }], play: [{ id: 'c:d', version: '2.0', flow: 'clientbound', optional: true }, { id: 'e:f', version: '3', flow: 'serverbound', optional: false }] }
    assert.deepStrictEqual(decodeNetworkQuery(encodeNetworkQuery(comps)), comps)
    assert.deepStrictEqual(decodeNetworkQuery(Buffer.from([0])), {})
  })

  it('negotiationDelta names the required server rows a claim lacks and the required claims the server lacks (optional rows never fail either way)', () => {
    const server = { configuration: [{ id: 'a:b', version: '1', flow: null, optional: false }, { id: 'opt:x', version: '1', flow: null, optional: true }], play: [{ id: 'c:d', version: '2', flow: 'clientbound', optional: false }] }
    const d = negotiationDelta(server, { configuration: [{ id: 'a:b', version: '1', optional: false }, { id: 'mine:y', version: '1', optional: false }, { id: 'mine:opt', version: '1', optional: true }], play: [] })
    assert.deepStrictEqual(d.missingOnClient.map((r) => r.id), ['c:d'])
    assert.deepStrictEqual(d.extraOnClient.map((r) => r.id), ['mine:y'])
  })

  it('classifyNegotiationFailure reads the rule key nested in failure.mod and lifts flow / version arguments', () => {
    const rows = classifyNegotiationFailure({
      'm:main/0': MOD({ translate: 'neoforge.network.negotiation.failure.missing.server.client' }),
      'm:main/1': MOD({ translate: 'neoforge.network.negotiation.failure.missing.client.server' }),
      'm:main/2': MOD({ translate: 'neoforge.network.negotiation.failure.flow.client.missing', with: ['CLIENTBOUND'] }),
      'm:main/3': MOD({ translate: 'neoforge.network.negotiation.failure.version.mismatch', with: ['1.5.0', ''] }),
      'm:main/4': 'plain text'
    }, { play: [{ id: 'm:main/0', version: '7', flow: 'serverbound', optional: false }] })
    const by = Object.fromEntries(rows.map((r) => [r.id, r]))
    assert.strictEqual(by['m:main/0'].kind, 'missing_on_client')
    assert.deepStrictEqual(by['m:main/0'].server, { protocol: 'play', id: 'm:main/0', version: '7', flow: 'serverbound', optional: false })
    assert.strictEqual(by['m:main/1'].kind, 'missing_on_server')
    assert.strictEqual(by['m:main/2'].kind, 'flow_missing')
    assert.strictEqual(by['m:main/2'].flow, 'clientbound')
    assert.strictEqual(by['m:main/3'].kind, 'version_mismatch')
    assert.deepStrictEqual(by['m:main/3'].versions, ['1.5.0', ''])
    assert.strictEqual(by['m:main/4'].kind, 'other')
  })

  it('learned rows ride the claim STAMPED learned (never as derived), are receipted, and their payloads are dropped and counted', () => {
    const c = makeClient()
    installNeoForgeConfigNegotiation(c, {
      components: { configuration: [{ id: 'derived:cfg', version: '1', flow: null, optional: false }], play: [] },
      learnedComponents: {
        configuration: [{ id: 'learned:cfg', version: '', flow: null, optional: true, learnedFrom: 'named_missing' }],
        play: [{ id: 'learned:play', version: '2', flow: 'clientbound', optional: true, learnedFrom: 'named_missing' }, { id: 'neoforge:evil', version: '1' }, { id: 'derived:cfg', version: '9' }]
      },
      pongHoldMs: 20
    })
    c.emit('packet', { channel: 'neoforge:register', data: Buffer.from([0]) }, meta)
    const reply = c.writes.find((w) => w.name === 'custom_payload' && w.params.channel === 'neoforge:register')
    assert.ok(reply, 'claim answered')
    const decoded = decodeNetworkQuery(reply.params.data)
    assert.deepStrictEqual(decoded.configuration.map((r) => r.id), ['derived:cfg', 'learned:cfg'])
    assert.deepStrictEqual(decoded.play.map((r) => r.id), ['learned:play', 'derived:cfg'], 'built-ins never enter; de-duplication is per protocol (a derived configuration id may still be a learned play row)')
    assert.deepStrictEqual(c.neoForgeConfig.learned, { configuration: ['learned:cfg'], play: ['learned:play', 'derived:cfg'] })
    assert.strictEqual(c.neoForgeConfig.queryAnswer.learnedConfiguration, 1)
    assert.strictEqual(c.neoForgeConfig.queryAnswer.learnedPlay, 2)
    assert.deepStrictEqual(c.neoForgeConfig.serverQuery, {})
    assert.deepStrictEqual(c.neoForgeConfig.serverDelta, { missingOnClient: [], extraOnClient: [{ protocol: 'configuration', id: 'derived:cfg', version: '1' }] })
    const before = c.writes.length
    c.emit('packet', { channel: 'learned:cfg', data: Buffer.from([1, 2, 3]) }, meta)
    assert.strictEqual(c.writes.length, before, 'nothing sent back on a learned channel')
    assert.deepStrictEqual(c.neoForgeConfig.learnedDropped, { 'learned:cfg': 1 })
    assert.ok(!c.neoForgeConfig.unhandled.includes('learned:cfg'))
    c.emit('packet', { channel: 'learned:play', data: Buffer.alloc(0) }, { state: 'play', name: 'custom_payload' })
    assert.strictEqual(c.neoForgeConfig.learnedDropped['learned:play'], 1)
  })

  it('the server query, when it lists rows, is decoded into the state and its delta emitted', () => {
    const c = makeClient()
    const seen = []
    c.on('neoForgeServerQuery', (e) => seen.push(e))
    installNeoForgeConfigNegotiation(c, { components: { configuration: [], play: [] }, pongHoldMs: 20 })
    const q = Buffer.concat([writeVarInt(1), writeVarInt(1), writeVarInt(1), writeString('srv:req'), writeString('4'), Buffer.from([1]), writeVarInt(1), Buffer.from([0])])
    c.emit('packet', { channel: 'neoforge:register', data: q }, meta)
    assert.deepStrictEqual(c.neoForgeConfig.serverQuery, { play: [{ id: 'srv:req', version: '4', flow: 'clientbound', optional: false }] })
    assert.strictEqual(seen.length, 1)
    assert.deepStrictEqual(seen[0].delta.missingOnClient, [{ protocol: 'play', id: 'srv:req', version: '4', flow: 'clientbound', optional: false }])
  })
})
