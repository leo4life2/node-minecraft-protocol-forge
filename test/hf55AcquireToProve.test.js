/* eslint-env mocha */
// HF55 — ACQUIRE-TO-PROVE: a configuration-phase mod payload no proven
// contract covers is proven from a jar the embedder OBTAINS (or its per-host
// contract cache), the proven empty ack is sent and the phase continues; a
// miss that leaves the phase parked is surfaced as neoForgeConfigTaskUnprovable
// — never a silent stall. Field row: NeoForge 21.1.249 + tacz on a bare
// client (HF54 verify MED-3): negotiation passes on the learn belt, then the
// join parks on tacz:server_synced_entity_data_mapping forever.
// Fixture: the public tacz-neoforge-1.21.1-1.1.8-hotfix-r6.jar (Modrinth,
// sha1 c70e8f63…) trimmed to META-INF + the NetworkHandler / handshake
// classes (tools/trim-packet-wire-fixture.js) — REAL class bytes.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { installNeoForgeConfigNegotiation, encodeNetworkQuery, CONFIG_PROOF_BUDGET_MS, PARKED_GRACE_MS, HOLD_TICK_MS } = require('../src/client/neoForgeConfig')
const { deriveNeoForgeComponents, deriveAckContracts } = require('../src/client/neoForgePayloadDerivation')
const { mutateJar } = require('./helpers/jarMutate')

const FIXTURE = path.join(__dirname, 'fixtures', 'hf55-tacz-neoforge-1.21.1-1.1.8-hotfix-r6.trimmed.jar')
const TRIGGER = 'tacz:server_synced_entity_data_mapping'
const ACK = 'tacz:acknowledge'
const meta = { state: 'configuration', name: 'custom_payload' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeClient () {
  const c = new EventEmitter()
  c.state = 'configuration'
  c.writes = []
  c.write = (name, params) => { c.writes.push({ name, params }) }
  c.progress = []
  c.on('minepalConfigProgress', (d) => c.progress.push(d))
  c.extends = []
  c.minepalJoinWatchdogExtend = (why) => c.extends.push(why)
  return c
}
const learnedTrigger = { configuration: [{ id: TRIGGER, version: '1.0.5', flow: 'clientbound', optional: false, learnedFrom: 'named_missing' }], play: [] }
const serverQueryWith = (ids) => encodeNetworkQuery({ configuration: ids.map((id) => ({ id, version: '1.0.5', flow: id === ACK ? 'serverbound' : 'clientbound', optional: false })), play: [] })
const acks = (c) => c.writes.filter((w) => w.name === 'custom_payload' && w.params.channel === ACK)
const proven = () => deriveNeoForgeComponents([FIXTURE])

describe('HF55 acquire-to-prove: the blocking-task contract from an obtained jar', function () {
  this.timeout(10000)

  it('P1 the trimmed real jar proves the contract (trigger -> unit ack -> finishCurrentTask) and refuses nothing', () => {
    const r = proven()
    assert.deepStrictEqual(r.ackContracts, [{ trigger: TRIGGER, ack: ACK, task: 'com/tacz/guns/network/NetworkHandler$Task', source: 'com/tacz/guns/network/message/handshake/Acknowledge' }])
    assert.deepStrictEqual(r.ackUnprovable, [])
    assert.deepStrictEqual(r.components.configuration.map((c) => `${c.id}@${c.version}/${c.flow}`).sort(), [`${ACK}@1.0.5/serverbound`, `${TRIGGER}@1.0.5/clientbound`])
  })

  it('P2 a task whose ack codec is NOT unit is REFUSED and named (ack-has-body) — never guessed; the plain call keeps its return', () => {
    const m = mutateJar(fs.readFileSync(FIXTURE), { rewrite: (p, s) => (/handshake\/Acknowledge\.class$/.test(p) && s === 'unit' ? 'unix' : undefined) })
    assert.ok(m.changed > 0, 'the unit codec call was rewritten')
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hf55-')), 'bodied.jar')
    fs.writeFileSync(p, m.buf)
    const r = deriveNeoForgeComponents([p])
    assert.deepStrictEqual(r.ackContracts, [])
    assert.deepStrictEqual(r.ackUnprovable, [{ trigger: TRIGGER, ack: ACK, task: 'com/tacz/guns/network/NetworkHandler$Task', source: 'com/tacz/guns/network/message/handshake/Acknowledge', reason: 'ack-has-body' }])
    assert.ok(Array.isArray(deriveAckContracts(require('../src/client/neoForgePayloadDerivation').__index ? null : { get: () => null, rawBytes: () => null }, { allClassNames: [] })), 'collect is optional')
  })

  it('P3 e2e-dry: a learned trigger on a bare client -> the prover is asked once, the phase is HELD, the proven empty ack is sent with source acquired-jar', async () => {
    const c = makeClient()
    const asked = []
    installNeoForgeConfigNegotiation(c, {
      components: { configuration: [], play: [] },
      learnedComponents: learnedTrigger,
      pongHoldMs: 20,
      proveAckContract: async (req) => { asked.push(req); await sleep(20); return { contracts: proven().ackContracts, source: 'acquired-jar', owner: { modId: 'tacz', version: '1.1.8-hotfix-r6' } } }
    })
    c.emit('packet', { channel: 'neoforge:register', data: serverQueryWith([TRIGGER, ACK]) }, meta)
    c.emit('packet', { channel: TRIGGER, data: Buffer.alloc(399) }, meta)
    assert.strictEqual(asked.length, 1)
    assert.strictEqual(asked[0].channel, TRIGGER)
    assert.strictEqual(asked[0].namespace, 'tacz')
    assert.strictEqual(asked[0].learned, true)
    assert.strictEqual(asked[0].bytes, 399)
    assert.strictEqual(asked[0].serverQuery.configuration.length, 2)
    assert.ok(c.progress.length >= 1 && /tacz:server_synced_entity_data_mapping/.test(c.progress[0]), 'the fabric watchdog is fed at once')
    assert.ok(c.extends.length >= 1, 'the join window is restarted')
    assert.strictEqual(c.neoForgeConfig.proofs[TRIGGER].status, 'pending')
    assert.strictEqual(acks(c).length, 0, 'nothing invented while the proof is in flight')
    await sleep(60)
    assert.strictEqual(acks(c).length, 1)
    assert.strictEqual(acks(c)[0].params.data.length, 0, 'the ack is the proven EMPTY body')
    assert.deepStrictEqual(c.neoForgeConfig.acked, [{ trigger: TRIGGER, ack: ACK, source: 'acquired-jar' }])
    const p = c.neoForgeConfig.proofs[TRIGGER]
    assert.strictEqual(p.status, 'proven')
    assert.strictEqual(p.source, 'acquired-jar')
    assert.deepStrictEqual(p.owner, { modId: 'tacz', version: '1.1.8-hotfix-r6' })
    assert.strictEqual(c.neoForgeConfig.learnedDropped[TRIGGER], 1, 'the learned drop receipt still counts the payload')
    assert.strictEqual(c.neoForgeConfig.holds.length, 1)
    assert.ok(c.neoForgeConfig.holds[0].until >= c.neoForgeConfig.holds[0].since, 'the hold is released')
    assert.deepStrictEqual(c.neoForgeConfig.unprovable, [])
    // a second trigger of the same task later in the phase is answered at once from the now-proven map
    c.emit('packet', { channel: TRIGGER, data: Buffer.alloc(1) }, meta)
    assert.strictEqual(acks(c).length, 2)
  })

  it('P4 the honest miss: no contract and the phase PARKED -> neoForgeConfigTaskUnprovable names channel, owner and why; a phase that moved on is never called parked', async () => {
    const c = makeClient()
    const events = []
    c.on('neoForgeConfigTaskUnprovable', (e) => events.push(e))
    installNeoForgeConfigNegotiation(c, {
      components: { configuration: [], play: [] },
      learnedComponents: learnedTrigger,
      pongHoldMs: 20,
      parkedGraceMs: 30,
      proveAckContract: async () => ({ contracts: [], source: null, owner: { modId: 'tacz', version: null }, reason: 'no local jar and the registry lookup missed (registry-miss)' })
    })
    c.emit('packet', { channel: TRIGGER, data: Buffer.alloc(5) }, meta)
    await sleep(80)
    assert.strictEqual(acks(c).length, 0)
    assert.strictEqual(events.length, 1)
    assert.strictEqual(events[0].channel, TRIGGER)
    assert.strictEqual(events[0].namespace, 'tacz')
    assert.deepStrictEqual(events[0].owner, { modId: 'tacz', version: null })
    assert.strictEqual(events[0].status, 'unprovable')
    assert.strictEqual(events[0].reason, 'no local jar and the registry lookup missed (registry-miss)')
    assert.strictEqual(c.neoForgeConfig.proofs[TRIGGER].parked, true)
    assert.strictEqual(c.neoForgeConfig.unprovable.length, 1)
    // moved on: another configuration packet inside the grace = not a blocking task
    const c2 = makeClient()
    const events2 = []
    c2.on('neoForgeConfigTaskUnprovable', (e) => events2.push(e))
    installNeoForgeConfigNegotiation(c2, { components: { configuration: [], play: [] }, learnedComponents: learnedTrigger, pongHoldMs: 20, parkedGraceMs: 30, proveAckContract: async () => ({ contracts: [] }) })
    c2.emit('packet', { channel: TRIGGER, data: Buffer.alloc(5) }, meta)
    await sleep(10)
    c2.emit('packet', { channel: 'neoforge:config_file', data: Buffer.alloc(0) }, meta)
    await sleep(60)
    assert.strictEqual(events2.length, 0)
    assert.strictEqual(c2.neoForgeConfig.proofs[TRIGGER].parked, false)
    assert.strictEqual(c2.neoForgeConfig.proofs[TRIGGER].status, 'unprovable')
    assert.strictEqual(c2.neoForgeConfig.proofs[TRIGGER].reason, 'the jar proves no blocking-task contract for this channel')
  })

  it('P5 a refused row (ack-has-body) reaches the fact; a proven ack the server never declared is uncorroborated and never sent', async () => {
    const c = makeClient()
    const events = []
    c.on('neoForgeConfigTaskUnprovable', (e) => events.push(e))
    installNeoForgeConfigNegotiation(c, {
      components: { configuration: [], play: [] },
      learnedComponents: learnedTrigger,
      pongHoldMs: 20,
      parkedGraceMs: 30,
      proveAckContract: async () => ({ contracts: [], unprovable: [{ trigger: TRIGGER, ack: ACK, reason: 'ack-has-body' }], source: 'acquired-jar', owner: { modId: 'tacz', version: '1.1.8-hotfix-r6' } })
    })
    c.emit('packet', { channel: TRIGGER, data: Buffer.alloc(5) }, meta)
    await sleep(80)
    assert.strictEqual(events.length, 1)
    assert.deepStrictEqual(events[0].refused, { ack: ACK, reason: 'ack-has-body' })
    assert.ok(/not an empty body \(ack-has-body\)/.test(events[0].reason), events[0].reason)
    // uncorroborated: the server's query names the trigger but NOT the ack
    const c2 = makeClient()
    const events2 = []
    c2.on('neoForgeConfigTaskUnprovable', (e) => events2.push(e))
    installNeoForgeConfigNegotiation(c2, { components: { configuration: [], play: [] }, learnedComponents: learnedTrigger, pongHoldMs: 20, parkedGraceMs: 30, proveAckContract: async () => ({ contracts: proven().ackContracts, source: 'acquired-jar' }) })
    c2.emit('packet', { channel: 'neoforge:register', data: serverQueryWith([TRIGGER]) }, meta)
    c2.emit('packet', { channel: TRIGGER, data: Buffer.alloc(5) }, meta)
    await sleep(80)
    assert.strictEqual(acks(c2).length, 0, 'an ack the server never declared is not sent')
    assert.deepStrictEqual(c2.neoForgeConfig.proofs[TRIGGER].uncorroborated, [ACK])
    assert.strictEqual(events2.length, 1)
    assert.ok(/not a channel this server declared/.test(events2[0].reason), events2[0].reason)
  })

  it('P6 the budget: a proof that never settles is abandoned at configProofBudgetMs, the hold released, the parked fact surfaced', async () => {
    const c = makeClient()
    const events = []
    c.on('neoForgeConfigTaskUnprovable', (e) => events.push(e))
    installNeoForgeConfigNegotiation(c, { components: { configuration: [], play: [] }, learnedComponents: learnedTrigger, pongHoldMs: 20, parkedGraceMs: 20, configProofBudgetMs: 40, proveAckContract: () => new Promise(() => {}) })
    c.emit('packet', { channel: TRIGGER, data: Buffer.alloc(5) }, meta)
    await sleep(120)
    assert.strictEqual(events.length, 1)
    assert.ok(/inside its budget \(40 ms\)/.test(events[0].reason), events[0].reason)
    assert.ok(c.neoForgeConfig.holds[0].until != null, 'hold released at the budget')
    assert.ok(CONFIG_PROOF_BUDGET_MS >= 120000 && PARKED_GRACE_MS >= 2000 && HOLD_TICK_MS < 20000, 'the defaults: patient proof, honest grace, a tick inside the 20 s fabric watchdog')
  })

  it('P7 once per channel, one proof per namespace: a repeat payload counts, a sibling channel of the same namespace rides the same proof and is answered from it', async () => {
    const c = makeClient()
    let asked = 0
    installNeoForgeConfigNegotiation(c, {
      components: { configuration: [], play: [] },
      learnedComponents: { configuration: [{ id: TRIGGER, version: '1.0.5', flow: 'clientbound', optional: false, learnedFrom: 'named_missing' }, { id: 'tacz:other_task', version: '1.0.5', flow: 'clientbound', optional: false, learnedFrom: 'named_missing' }, { id: ACK, version: '1.0.5', flow: 'serverbound', optional: false, learnedFrom: 'named_missing' }, { id: 'tacz:other_ack', version: '1.0.5', flow: 'serverbound', optional: false, learnedFrom: 'named_missing' }], play: [] }, // HF55-R: the server names its serverbound acks too (nf211 live: configuration:tacz:acknowledge@1.0.5 in the named list)
      pongHoldMs: 20,
      proveAckContract: async () => { asked++; await sleep(20); return { contracts: [{ trigger: TRIGGER, ack: ACK }, { trigger: 'tacz:other_task', ack: 'tacz:other_ack' }], source: 'contract-cache' } }
    })
    c.emit('packet', { channel: TRIGGER, data: Buffer.alloc(5) }, meta)
    c.emit('packet', { channel: TRIGGER, data: Buffer.alloc(6) }, meta)
    c.emit('packet', { channel: 'tacz:other_task', data: Buffer.alloc(7) }, meta)
    assert.strictEqual(asked, 1)
    assert.strictEqual(c.neoForgeConfig.proofs[TRIGGER].payloads, 2)
    await sleep(60)
    assert.deepStrictEqual(c.neoForgeConfig.acked, [{ trigger: TRIGGER, ack: ACK, source: 'contract-cache' }, { trigger: 'tacz:other_task', ack: 'tacz:other_ack', source: 'contract-cache' }])
  })

  it('P8 the pre-HF55 shapes hold: a local-jar HF11 row answers with the exact {trigger, ack} receipt; a cached row rides options.ackContracts with its source; no prover = the learned drop, no proof receipt', () => {
    const c = makeClient()
    const events = []
    c.on('neoForgeConfigAck', (e) => events.push(e))
    installNeoForgeConfigNegotiation(c, { components: { configuration: [{ id: TRIGGER, version: '1.0.5', flow: 'clientbound', optional: false }], play: [] }, ackContracts: [{ trigger: TRIGGER, ack: ACK }, { trigger: 'x:cached', ack: 'x:cached_ack', source: 'contract-cache' }], learnedComponents: { configuration: [{ id: 'x:cached', version: '', flow: null, optional: true, learnedFrom: 'named_missing' }, { id: 'x:cached_ack', version: '', flow: null, optional: true, learnedFrom: 'named_missing' }, { id: 'x:plain', version: '', flow: null, optional: true, learnedFrom: 'named_missing' }], play: [] }, pongHoldMs: 20 })
    c.emit('packet', { channel: TRIGGER, data: Buffer.alloc(3) }, meta)
    assert.deepStrictEqual(events, [{ trigger: TRIGGER, ack: ACK }])
    assert.deepStrictEqual(c.neoForgeConfig.acked, [{ trigger: TRIGGER, ack: ACK }])
    c.emit('packet', { channel: 'x:cached', data: Buffer.alloc(3) }, meta)
    assert.deepStrictEqual(events[1], { trigger: 'x:cached', ack: 'x:cached_ack', source: 'contract-cache' })
    assert.strictEqual(c.neoForgeConfig.learnedDropped['x:cached'], undefined, 'a cached contract answers BEFORE the learned drop')
    c.emit('packet', { channel: 'x:plain', data: Buffer.alloc(3) }, meta)
    assert.strictEqual(c.neoForgeConfig.learnedDropped['x:plain'], 1)
    assert.deepStrictEqual(c.neoForgeConfig.proofs, {}, 'no prover wired: no proof receipt, the pre-HF55 posture')
    assert.strictEqual(c.writes.filter((w) => w.name === 'custom_payload').length, 2)
  })
  it('P9 (HF55-R MED-2) a remembered row whose ack this server did not declare is refused at the trigger — receipted with host + channel, no ack sent, proveOrPark reached; a declared one answers as before; the fact carries the owner corroboration', async () => {
    const c = makeClient()
    const refused = []
    c.on('neoForgeConfigCacheRefused', (e) => refused.push(e))
    const asked = []
    installNeoForgeConfigNegotiation(c, {
      components: { configuration: [], play: [] },
      learnedComponents: learnedTrigger,
      pongHoldMs: 20,
      ackContracts: [{ trigger: TRIGGER, ack: 'tacz:stale_ack', source: 'contract-cache', host: 'rig:swap' }, { trigger: 'tacz:other_trigger', ack: ACK, source: 'contract-cache', host: 'rig:swap' }],
      proveAckContract: async (req) => { asked.push(req); await sleep(20); return { contracts: proven().ackContracts, source: 'acquired-jar', owner: { modId: 'tacz', version: null, corroboration: 'channel-only' } } }
    })
    c.emit('packet', { channel: 'neoforge:register', data: serverQueryWith([TRIGGER, ACK, 'tacz:other_trigger']) }, meta)
    c.emit('packet', { channel: TRIGGER, data: Buffer.alloc(5) }, meta)
    assert.strictEqual(c.writes.filter((w) => w.name === 'custom_payload' && w.params.channel === 'tacz:stale_ack').length, 0, 'the remembered ack is never sent')
    assert.deepStrictEqual(refused, [{ trigger: TRIGGER, ack: 'tacz:stale_ack', host: 'rig:swap', reason: 'ack-not-declared' }])
    assert.deepStrictEqual(c.neoForgeConfig.cacheRefused, refused)
    assert.strictEqual(asked.length, 1, 'proveOrPark reached exactly as if no row existed')
    assert.strictEqual(c.neoForgeConfig.proofs[TRIGGER].status, 'pending')
    assert.strictEqual(c.neoForgeConfig.learnedDropped[TRIGGER], 1)
    // a remembered row whose ack the server DID declare answers as before
    c.emit('packet', { channel: 'tacz:other_trigger', data: Buffer.alloc(5) }, meta)
    assert.deepStrictEqual(c.neoForgeConfig.acked, [{ trigger: 'tacz:other_trigger', ack: ACK, source: 'contract-cache' }])
    assert.strictEqual(refused.length, 1)
    await sleep(60)
    assert.strictEqual(c.neoForgeConfig.proofs[TRIGGER].status, 'proven')
    assert.deepStrictEqual(c.neoForgeConfig.proofs[TRIGGER].owner, { modId: 'tacz', version: null, corroboration: 'channel-only' })
    assert.deepStrictEqual(c.neoForgeConfig.acked[1], { trigger: TRIGGER, ack: ACK, source: 'acquired-jar' })
    // an UNKNOWN query (none) has nothing to check against: the remembered row answers as before (P8's posture)
    const u = makeClient()
    installNeoForgeConfigNegotiation(u, { components: { configuration: [], play: [] }, ackContracts: [{ trigger: 'x:cached', ack: 'x:cached_ack', source: 'contract-cache', host: 'rig:u' }] })
    u.emit('packet', { channel: 'x:cached', data: Buffer.alloc(3) }, meta)
    assert.deepStrictEqual(u.neoForgeConfig.acked, [{ trigger: 'x:cached', ack: 'x:cached_ack', source: 'contract-cache' }])
    assert.deepStrictEqual(u.neoForgeConfig.cacheRefused, [])
    // the live wire (nf211): the server's query is EMPTY and its declaration is the rows it NAMED through refusals (the learn belt) — a stale remembered ack is refused against THOSE, a named one answers
    const named = { configuration: [{ id: TRIGGER, version: '1.0.5', flow: 'clientbound', optional: false, learnedFrom: 'named_missing' }, { id: ACK, version: '1.0.5', flow: 'serverbound', optional: false, learnedFrom: 'named_missing' }, { id: 'tacz:other_trigger', version: '1.0.5', flow: 'clientbound', optional: false, learnedFrom: 'named_missing' }], play: [] }
    const l = makeClient()
    const askedL = []
    installNeoForgeConfigNegotiation(l, { components: { configuration: [], play: [] }, learnedComponents: named, pongHoldMs: 20, ackContracts: [{ trigger: TRIGGER, ack: 'tacz:stale_ack', source: 'contract-cache', host: 'rig:swap' }, { trigger: 'tacz:other_trigger', ack: ACK, source: 'contract-cache', host: 'rig:swap' }], proveAckContract: async (req) => { askedL.push(req); return { contracts: [], source: null, owner: null, reason: 'x' } } })
    l.emit('packet', { channel: 'neoforge:register', data: encodeNetworkQuery({ configuration: [], play: [] }) }, meta)
    l.emit('packet', { channel: TRIGGER, data: Buffer.alloc(5) }, meta)
    l.emit('packet', { channel: 'tacz:other_trigger', data: Buffer.alloc(5) }, meta)
    assert.deepStrictEqual(l.neoForgeConfig.cacheRefused, [{ trigger: TRIGGER, ack: 'tacz:stale_ack', host: 'rig:swap', reason: 'ack-not-declared' }])
    assert.strictEqual(askedL.length, 1)
    assert.deepStrictEqual(l.neoForgeConfig.acked, [{ trigger: 'tacz:other_trigger', ack: ACK, source: 'contract-cache' }])
  })
})
