/* eslint-env mocha */
'use strict'
// HF81 — configuration-task contracts beyond the HF11/HF55 shape (a payload
// class's own (IPayloadContext)V handler + a unit ack). Field F18 (NeoForge
// 26.1.2, 2026-10-05): Combat Roll 3.0.1 parks the phase on
// combat_roll:config_sync; its finishing handler is a LAMBDA handed to the
// registrar through invokedynamic, the ack is a one-String record
// (writeUtf), the client replies a jar CONSTANT (the task's ID) and the
// server finishes only when String.equals meets that constant. Better Combat
// 3.2.2 (the same author) finishes TWO tasks from one lambda, each under its
// own guard. Fixtures = the public jars trimmed to their handshake classes
// (sha1 of the full jars: combat_roll 47cb66b8…, bettercombat 6ac51a01…).
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { installNeoForgeConfigNegotiation, encodeNetworkQuery } = require('../src/client/neoForgeConfig')
const { deriveNeoForgeComponents } = require('../src/client/neoForgePayloadDerivation')
const { mutateJar } = require('./helpers/jarMutate')

const CR = path.join(__dirname, 'fixtures', 'hf81-combat_roll-neoforge-3.0.1+26.1.2.trimmed.jar')
const BC = path.join(__dirname, 'fixtures', 'hf81-bettercombat-neoforge-3.2.2+26.1.2.trimmed.jar')
const TACZ = path.join(__dirname, 'fixtures', 'hf55-tacz-neoforge-1.21.1-1.1.8-hotfix-r6.trimmed.jar')
const meta = { state: 'configuration', name: 'custom_payload' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const utf = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([Buffer.from([b.length]), b]) } // VarInt length (< 128) + UTF-8

const CR_ROW = {
  trigger: 'combat_roll:config_sync',
  ack: 'combat_roll:ack',
  task: 'net/combat_roll/neoforge/network/NetworkEvents$ConfigurationTask',
  source: 'net/combat_roll/neoforge/network/NetworkEvents',
  body: [{ field: 'code', kind: 'utf', value: 'combat_roll:config' }],
  proof: {
    handler: 'net/combat_roll/neoforge/network/NetworkEvents.lambda$register$0',
    registration: 'invokedynamic@net/combat_roll/neoforge/network/NetworkEvents.register',
    finish: 'guard:code=combat_roll:config',
    codec: 'ofMember:net/combat_roll/network/Packets$Ack.write',
    reply: 'net/combat_roll/neoforge/network/NetworkEvents.lambda$register$2 (invokedynamic@net/combat_roll/neoforge/network/NetworkEvents.register)'
  }
}
const bcRow = (trigger, task, value, replyLambda) => ({
  trigger,
  ack: 'bettercombat:ack',
  task: `net/bettercombat/neoforge/network/NetworkEvents$${task}`,
  source: 'net/bettercombat/neoforge/network/NetworkEvents',
  body: [{ field: 'code', kind: 'utf', value }],
  proof: {
    handler: 'net/bettercombat/neoforge/network/NetworkEvents.lambda$register$0',
    registration: 'invokedynamic@net/bettercombat/neoforge/network/NetworkEvents.register',
    finish: `guard:code=${value}`,
    codec: 'ofMember:net/bettercombat/network/Packets$Ack.write',
    reply: `net/bettercombat/neoforge/network/NetworkEvents.${replyLambda} (invokedynamic@net/bettercombat/neoforge/network/NetworkEvents.register)`
  }
})

function makeClient () {
  const c = new EventEmitter()
  c.state = 'configuration'
  c.writes = []
  c.write = (name, params) => { c.writes.push({ name, params }) }
  c.minepalJoinWatchdogExtend = () => {}
  return c
}
const acks = (c, ack) => c.writes.filter((w) => w.name === 'custom_payload' && w.params.channel === ack)
const mutated = (fixture, rules, name) => {
  const m = mutateJar(fs.readFileSync(fixture), rules)
  assert.ok(m.changed > 0, `${name}: the mutation rewrote something`)
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hf81-')), `${name}.jar`)
  fs.writeFileSync(p, m.buf)
  return p
}

describe('HF81 configuration-task contracts: invokedynamic handlers, guarded finishes, constant-bodied replies', function () {
  this.timeout(20000)

  it('Q1 Combat Roll (the F18 field jar): the lambda handler is followed through invokedynamic, the one-String body is read from writeUtf, the reply constant is the task ID, the guard is met — ONE contract with its whole trail, nothing refused', () => {
    const r = deriveNeoForgeComponents([CR])
    assert.deepStrictEqual(r.ackContracts, [CR_ROW])
    assert.deepStrictEqual(r.ackUnprovable, [])
    assert.deepStrictEqual(r.components.configuration.map((c) => `${c.id}/${c.flow}`).sort(), ['combat_roll:ack/serverbound', 'combat_roll:config_sync/clientbound'])
  })

  it('Q2 Better Combat: one lambda finishes TWO tasks under two string guards; each task\'s trigger gets its own contract with the reply constant its own client handler sends', () => {
    const r = deriveNeoForgeComponents([BC])
    assert.deepStrictEqual(r.ackContracts, [
      bcRow('bettercombat:config_sync', 'ConfigurationTask', 'bettercombat:config', 'lambda$register$5'),
      bcRow('bettercombat:weapon_registry', 'WeaponRegistrySyncTask', 'bettercombat:weapon_registry', 'lambda$register$6')
    ])
    assert.deepStrictEqual(r.ackUnprovable, [])
  })

  it('Q3 the HF55 shape is byte-identical: the tacz row carries no body and no proof (the own-method unit ack as HF11 pinned it)', () => {
    const r = deriveNeoForgeComponents([TACZ])
    assert.strictEqual(r.ackContracts.length, 1)
    assert.deepStrictEqual(Object.keys(r.ackContracts[0]).sort(), ['ack', 'source', 'task', 'trigger'])
  })

  it('Q4 a shape the jar does not prove is REFUSED with the exact reason: a write this responder cannot encode; a reply site that is gone; a guard the reply would not meet — no contract, never a guess', () => {
    const base = { trigger: 'combat_roll:config_sync', ack: 'combat_roll:ack', task: CR_ROW.task, source: CR_ROW.source }
    const w = deriveNeoForgeComponents([mutated(CR, { rewrite: (p, s) => (/Packets\$Ack\.class$/.test(p) && s === 'writeUtf' ? 'writeInt' : undefined) }, 'writeint')])
    assert.deepStrictEqual(w.ackContracts, [])
    assert.deepStrictEqual(w.ackUnprovable, [{ ...base, reason: 'ack-body-unprovable:write:writeInt' }])
    const r = deriveNeoForgeComponents([mutated(CR, { rewrite: (p, s) => (/NetworkEvents\.class$/.test(p) && s === 'reply' ? 'repl_' : undefined) }, 'noreply')])
    assert.deepStrictEqual(r.ackContracts, [])
    assert.deepStrictEqual(r.ackUnprovable, [{ ...base, reason: 'ack-reply-unproven:no-reply-site' }])
    const g = deriveNeoForgeComponents([mutated(CR, { rewrite: (p, s) => (/NetworkEvents\.class$/.test(p) && s === 'code' ? 'kode' : undefined) }, 'guard')])
    assert.deepStrictEqual(g.ackContracts, [])
    assert.deepStrictEqual(g.ackUnprovable, [{ ...base, reason: 'ack-guard-mismatch:kode' }])
  })

  it('Q5 the replay: a fake configuration server parks on combat_roll:config_sync; the responder answers the derived bodied ack (VarInt length + "combat_roll:config") from the proof — the phase moves; a local-jar row with a body answers the same bytes; a body of a kind this responder cannot encode is no contract', async () => {
    const proven = deriveNeoForgeComponents([CR]).ackContracts
    const query = encodeNetworkQuery({ configuration: [{ id: 'combat_roll:config_sync', version: '1', flow: 'clientbound', optional: false }, { id: 'combat_roll:ack', version: '1', flow: 'serverbound', optional: false }], play: [] })
    const learned = { configuration: [{ id: 'combat_roll:config_sync', version: '1', flow: 'clientbound', optional: false, learnedFrom: 'named_missing' }], play: [] }
    const c = makeClient()
    const asked = []
    installNeoForgeConfigNegotiation(c, {
      components: { configuration: [], play: [] },
      learnedComponents: learned,
      pongHoldMs: 20,
      proveAckContract: async (req) => { asked.push(req); await sleep(10); return { contracts: proven, source: 'acquired-jar', owner: { modId: 'combat_roll', version: '3.0.1+26.1.2' } } }
    })
    c.emit('packet', { channel: 'neoforge:register', data: query }, meta)
    c.emit('packet', { channel: 'combat_roll:config_sync', data: Buffer.alloc(1200) }, meta)
    assert.strictEqual(asked.length, 1)
    assert.strictEqual(acks(c, 'combat_roll:ack').length, 0, 'nothing sent while the proof is in flight')
    await sleep(60)
    const sent = acks(c, 'combat_roll:ack')
    assert.strictEqual(sent.length, 1)
    assert.deepStrictEqual(sent[0].params.data, utf('combat_roll:config'), 'the ack body is the proven constant, writeUtf-encoded')
    assert.deepStrictEqual(c.neoForgeConfig.acked, [{ trigger: 'combat_roll:config_sync', ack: 'combat_roll:ack', source: 'acquired-jar', bodyBytes: 19 }])
    assert.strictEqual(c.neoForgeConfig.proofs['combat_roll:config_sync'].status, 'proven')
    assert.deepStrictEqual(c.neoForgeConfig.unprovable, [])
    // the local-jar row (HF11 path: options.ackContracts) carries the body and answers at once with the same bytes
    const l = makeClient()
    installNeoForgeConfigNegotiation(l, { components: { configuration: [], play: [] }, learnedComponents: learned, ackContracts: proven.map((r) => ({ trigger: r.trigger, ack: r.ack, body: r.body })) })
    l.emit('packet', { channel: 'neoforge:register', data: query }, meta)
    l.emit('packet', { channel: 'combat_roll:config_sync', data: Buffer.alloc(5) }, meta)
    assert.deepStrictEqual(acks(l, 'combat_roll:ack').map((w) => w.params.data), [utf('combat_roll:config')])
    assert.deepStrictEqual(l.neoForgeConfig.acked, [{ trigger: 'combat_roll:config_sync', ack: 'combat_roll:ack', bodyBytes: 19 }])
    // a body of an unknown wire kind is not a contract: nothing is sent for it
    const u = makeClient()
    installNeoForgeConfigNegotiation(u, { components: { configuration: [], play: [] }, learnedComponents: learned, ackContracts: [{ trigger: 'combat_roll:config_sync', ack: 'combat_roll:ack', body: [{ field: 'code', kind: 'int', value: '1' }] }] })
    u.emit('packet', { channel: 'combat_roll:config_sync', data: Buffer.alloc(5) }, meta)
    assert.strictEqual(acks(u, 'combat_roll:ack').length, 0)
    assert.deepStrictEqual(u.neoForgeConfig.acked, [])
  })

  it('Q6 the refusal words at the responder name the derivation\'s reason for a read shape and keep HF55\'s words for a hidden body', async () => {
    const learned = { configuration: [{ id: 'combat_roll:config_sync', version: '1', flow: 'clientbound', optional: false, learnedFrom: 'named_missing' }], play: [] }
    const words = async (unprovable) => {
      const c = makeClient()
      installNeoForgeConfigNegotiation(c, { components: { configuration: [], play: [] }, learnedComponents: learned, pongHoldMs: 20, parkedGraceMs: 40, proveAckContract: async () => ({ contracts: [], unprovable, source: 'acquired-jar', owner: { modId: 'combat_roll', version: null } }) })
      c.emit('packet', { channel: 'combat_roll:config_sync', data: Buffer.alloc(5) }, meta)
      await sleep(30)
      return c.neoForgeConfig.proofs['combat_roll:config_sync'].reason
    }
    assert.strictEqual(await words([{ trigger: 'combat_roll:config_sync', ack: 'combat_roll:ack', reason: 'ack-body-unprovable:write:writeInt' }]), 'the jar proves a blocking task on this channel whose ack combat_roll:ack carries a reply this client could not derive from the mod\'s code (ack-body-unprovable:write:writeInt) — nothing is guessed')
    assert.strictEqual(await words([{ trigger: 'combat_roll:config_sync', ack: 'combat_roll:ack', reason: 'ack-has-body' }]), 'the jar proves a blocking task on this channel whose ack combat_roll:ack is not an empty body (ack-has-body) — a reply this client cannot invent')
  })
})
