'use strict'
/* eslint-env mocha */

// HF16-R — JVMS §5.4.3.2 static-field resolution in the NeoForge payload
// derivation, pinned on a synthesized jar shaped like Epic Fight 21.17.3.1:
//   interface ManagedPayload { Type CLIENT_BOUND_X = registerPayloadType(...) }
//   record SPRemoteSkill implements ManagedPayload { static STREAM_CODEC ... }
//   registrar.playToClient(SPRemoteSkill.CLIENT_BOUND_X, ...)  <- use-site owner
//                                                                is the RECORD
// Field receipt 2026-09-05: the one registration whose constant-pool owner was
// the implementing record abstained ("unresolved payload type id"), a REQUIRED
// server channel went unclaimed and NeoForge 21.1.249's negotiator kicked with
// neoforge.network.negotiation.failure.missing.server.client (x11 sessions).
//
// Also pins the negotiator's comparison rule itself, transcribed from the
// NeoForge 21.1.249 jar (javap of
// net/neoforged/neoforge/network/negotiation/NetworkComponentNegotiator,
// scratchpad hf16r/nf/Negotiator.javap) — so "the claim joins" is asserted
// against the server's real rule, not a remembered one.

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildClass, buildJar } = require('./helpers/synthJar')
const { deriveNeoForgeComponents } = require('../src/client/neoForgePayloadDerivation')
const { encodeNetworkQuery } = require('../src/client/neoForgeConfig')

const EVENT = 'net/neoforged/neoforge/network/event/RegisterPayloadHandlersEvent'
const REG = 'net/neoforged/neoforge/network/registration/PayloadRegistrar'
const TYPE = 'net/minecraft/network/protocol/common/custom/CustomPacketPayload$Type'
const RL = 'net/minecraft/resources/ResourceLocation'
const IFC = 'synth/ifc/ManagedPayload'
const REC = 'synth/ifc/SPRemoteSkill'
const ABS = 'synth/ifc/SPAbsorption'
const BASE = 'synth/ifc/BasePayload'
const SUB = 'synth/ifc/SubPayload'
const GONE = 'synth/ifc/Vanished' // never in the jar
const ENTRY = 'synth/ifc/ModInit'
const HELPER_DESC = `(Ljava/lang/Class;Ljava/lang/String;Ljava/lang/String;)L${TYPE};`

function register (a, regMethod, owner, field) {
  return a
    .getstatic(owner, field, `L${TYPE};`)
    .iconst(0).iconst(0)
    .invokevirtual(REG, regMethod, `(L${TYPE};Ljava/lang/Object;Ljava/lang/Object;)L${REG};`)
    .pop()
}

// A record-shaped payload whose own <clinit> stores only its STREAM_CODEC —
// exactly SPSetRemotePlayerSkill (SP.javap: one putstatic, STREAM_CODEC).
function codecOnlyClass (name, superName, interfaces) {
  return buildClass({
    name,
    superName,
    interfaces,
    fields: [{ name: 'STREAM_CODEC', desc: 'Ljava/lang/Object;' }],
    methods: [{
      name: '<clinit>',
      desc: '()V',
      flags: 0x0008,
      code: (a) => a.aconstNull().putstatic(name, 'STREAM_CODEC', 'Ljava/lang/Object;').ret()
    }]
  })
}

// interfaceUseSite: getstatic owner for the remote-skill registration
//   REC  -> the field receipt shape (declared on IFC, referenced through REC)
//   IFC  -> the declaring class itself (control)
function synthJar ({ withVanished = true } = {}) {
  const ifcCls = buildClass({
    name: IFC,
    fields: [
      { name: 'PAYLOAD_TYPES', desc: 'Ljava/util/Map;' },
      { name: 'CLIENT_BOUND_REMOTE_SKILL', desc: `L${TYPE};` },
      { name: 'CLIENT_BOUND_ABSORPTION', desc: `L${TYPE};` }
    ],
    methods: [{
      // static interface helper: new Type(ResourceLocation.fromNamespaceAndPath(ns, path))
      name: 'registerPayloadType',
      desc: HELPER_DESC,
      flags: 0x0009,
      code: (a) => a
        .new_(TYPE).dup().aload(1).aload(2)
        .invokestatic(RL, 'fromNamespaceAndPath', `(Ljava/lang/String;Ljava/lang/String;)L${RL};`)
        .invokespecial(TYPE, '<init>', `(L${RL};)V`)
        .areturn()
    }, {
      name: '<clinit>',
      desc: '()V',
      flags: 0x0008,
      code: (a) => a
        .aconstNull().putstatic(IFC, 'PAYLOAD_TYPES', 'Ljava/util/Map;')
        .ldcCls(REC).ldcStr('synthifc').ldcStr('remote_skill')
        .invokestaticItf(IFC, 'registerPayloadType', HELPER_DESC)
        .putstatic(IFC, 'CLIENT_BOUND_REMOTE_SKILL', `L${TYPE};`)
        .ldcCls(ABS).ldcStr('synthifc').ldcStr('absorption')
        .invokestaticItf(IFC, 'registerPayloadType', HELPER_DESC)
        .putstatic(IFC, 'CLIENT_BOUND_ABSORPTION', `L${TYPE};`)
        .ret()
    }]
  })
  const baseCls = buildClass({
    name: BASE,
    fields: [{ name: 'TYPE_BASE', desc: `L${TYPE};` }],
    methods: [{
      name: '<clinit>',
      desc: '()V',
      flags: 0x0008,
      code: (a) => a
        .new_(TYPE).dup().ldcStr('synthifc').ldcStr('base_state')
        .invokestatic(RL, 'fromNamespaceAndPath', `(Ljava/lang/String;Ljava/lang/String;)L${RL};`)
        .invokespecial(TYPE, '<init>', `(L${RL};)V`)
        .putstatic(BASE, 'TYPE_BASE', `L${TYPE};`)
        .ret()
    }]
  })
  const entryCls = buildClass({
    name: ENTRY,
    methods: [{
      name: 'onRegister',
      desc: `(L${EVENT};)V`,
      flags: 0x0009,
      code: (a) => {
        a.aload(0).ldcStr('1').invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`).astore(1)
        a.aload(1); register(a, 'playToClient', REC, 'CLIENT_BOUND_REMOTE_SKILL') // through the record
        a.aload(1); register(a, 'playToClient', IFC, 'CLIENT_BOUND_ABSORPTION') // through the declarer
        a.aload(1); register(a, 'playToServer', SUB, 'TYPE_BASE') // through the subclass (superclass chain)
        if (withVanished) { a.aload(1); register(a, 'playToClient', GONE, 'TYPE_GONE') } // unknown owner
        return a.ret()
      }
    }]
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthjar-hf16r-'))
  const jar = path.join(dir, 'ifc.jar')
  fs.writeFileSync(jar, buildJar([
    { name: 'META-INF/neoforge.mods.toml', data: Buffer.from('modId="synthifc"\nversion="1.0.0"\n') },
    { name: `${ENTRY}.class`, data: entryCls },
    { name: `${IFC}.class`, data: ifcCls },
    { name: `${REC}.class`, data: codecOnlyClass(REC, 'java/lang/Record', [IFC]) },
    { name: `${ABS}.class`, data: codecOnlyClass(ABS, 'java/lang/Record', [IFC]) },
    { name: `${BASE}.class`, data: baseCls },
    { name: `${SUB}.class`, data: codecOnlyClass(SUB, BASE, []) }
  ]))
  return jar
}

// ---- NeoForge 21.1.249 NetworkComponentNegotiator.negotiate, transcribed ----
// (javap offsets in hf16r/nf/Negotiator.javap)
//  20/36  buildDisabledOptionalComponents(x, y): x's OPTIONAL components whose
//         id has no ResourceLocation.equals match in y (lambda$9/$10) -> removed
//  50-77  Table<id, side, component> paired by id equality (lambda$0/$1); then
//         removeIf(!containsRow) on both lists (lambda$2/$3)
//  98-141 leftover server components -> "missing.server.client" per id, FAIL
// 143-186 leftover client components -> "missing.client.server" per id, FAIL
// 207-522 per paired cell: validateComponent(server, client, "client") then
//         validateComponent(client, server, "server"); each failure keyed by id
// validateComponent (255-360): a.flow present -> b.flow empty => flow.%s.missing;
//         a.flow !== b.flow (reference compare of the enum) => flow.%s.mismatch;
//         then !a.version.equals(b.version) => version.mismatch; else OK
// 525-559 failures empty -> SUCCESS with [(id, version)] else FAIL(map)
const F = 'neoforge.network.negotiation.failure.'
function validateComponent (a, b, side) {
  if (a.flow != null) {
    if (b.flow == null) return `${F}flow.${side}.missing`
    if (a.flow !== b.flow) return `${F}flow.${side}.mismatch`
  }
  if (a.version !== b.version) return `${F}version.mismatch`
  return null
}
function negotiate (serverIn, clientIn) {
  const disabled = (x, y) => x.filter((c) => c.optional && !y.some((o) => o.id === c.id))
  const server = serverIn.filter((c) => !disabled(serverIn, clientIn).includes(c))
  const client = clientIn.filter((c) => !disabled(clientIn, serverIn).includes(c))
  const table = new Map()
  for (const s of server) for (const c of client) if (c.id === s.id) table.set(s.id, { server: s, client: c })
  const failures = {}
  const missingOnClient = server.filter((s) => !table.has(s.id))
  if (missingOnClient.length) {
    for (const s of missingOnClient) failures[s.id] = `${F}missing.server.client`
    return { success: false, components: [], failures }
  }
  const missingOnServer = client.filter((c) => !table.has(c.id))
  if (missingOnServer.length) {
    for (const c of missingOnServer) failures[c.id] = `${F}missing.client.server`
    return { success: false, components: [], failures }
  }
  const components = []
  for (const [id, cell] of table) {
    const r1 = validateComponent(cell.server, cell.client, 'client')
    if (r1) { failures[id] = r1; continue }
    const r2 = validateComponent(cell.client, cell.server, 'server')
    if (r2) { failures[id] = r2; continue }
    components.push({ id, version: cell.server.version })
  }
  return Object.keys(failures).length ? { success: false, components: [], failures } : { success: true, components, failures }
}

// What the fixture's server registers (PayloadRegistrar semantics: playToClient
// = CLIENTBOUND flow, playToServer = SERVERBOUND, registrar("1") versions all).
const SERVER_SET = [
  { id: 'synthifc:remote_skill', version: '1', flow: 'clientbound', optional: false },
  { id: 'synthifc:absorption', version: '1', flow: 'clientbound', optional: false },
  { id: 'synthifc:base_state', version: '1', flow: 'serverbound', optional: false }
]
const claimOf = (components) => components.play.map((c) => ({ id: c.id, version: c.version, flow: c.flow, optional: c.optional }))

describe('HF16-R static-field resolution follows JVMS 5.4.3.2 (declarer, not use-site owner)', function () {
  it('an interface-declared Type constant referenced through the implementing record derives (Epic Fight shape)', () => {
    const { components, diagnostics } = deriveNeoForgeComponents([synthJar({ withVanished: false })])
    assert.strictEqual(diagnostics.abstains.length, 0, `no abstains expected, got: ${diagnostics.abstains.join(' | ')}`)
    const play = new Map(components.play.map((c) => [c.id, c]))
    const rs = play.get('synthifc:remote_skill')
    assert.ok(rs, 'record-referenced interface constant must derive')
    assert.deepStrictEqual({ version: rs.version, flow: rs.flow, optional: rs.optional }, { version: '1', flow: 'clientbound', optional: false })
    assert.ok(play.get('synthifc:absorption'), 'declarer-referenced constant (control) must derive')
    const bs = play.get('synthifc:base_state')
    assert.ok(bs, 'superclass-declared constant referenced through the subclass must derive')
    assert.strictEqual(bs.flow, 'serverbound')
    assert.strictEqual(components.play.length, 3)
  })

  it('an unknown use-site owner still abstains honestly (claims never widen)', () => {
    const { components, diagnostics } = deriveNeoForgeComponents([synthJar({ withVanished: true })])
    assert.strictEqual(components.play.length, 3, 'the three resolvable channels still derive')
    assert.strictEqual(diagnostics.abstains.length, 1, `exactly one abstain expected, got: ${diagnostics.abstains.join(' | ')}`)
    assert.ok(/unresolved payload type id/.test(diagnostics.abstains[0]), diagnostics.abstains[0])
    assert.ok(diagnostics.abstains[0].includes(ENTRY), 'the abstain names the registration site')
    assert.ok(!components.play.some((c) => c.id.includes('gone')), 'nothing invented for the vanished owner')
  })

  it('the derived claim passes the NeoForge 21.1.249 negotiator rule; the pre-fix claim fails missing.server.client on the abstained channel', () => {
    const { components } = deriveNeoForgeComponents([synthJar({ withVanished: false })])
    const claim = claimOf(components)
    const ok = negotiate(SERVER_SET, claim)
    assert.strictEqual(ok.success, true, JSON.stringify(ok.failures))
    assert.deepStrictEqual(ok.components.map((c) => c.id).sort(), SERVER_SET.map((c) => c.id).sort())
    // pre-fix shape: the record-referenced registration abstained -> unclaimed
    const preFix = claim.filter((c) => c.id !== 'synthifc:remote_skill')
    const red = negotiate(SERVER_SET, preFix)
    assert.strictEqual(red.success, false)
    assert.deepStrictEqual(red.failures, { 'synthifc:remote_skill': `${F}missing.server.client` })
    // the wire answer carries the channel (claim bytes bind to the derivation)
    const reply = encodeNetworkQuery(components)
    assert.ok(reply.includes(Buffer.from('synthifc:remote_skill')), 'neoforge:register answer must carry the channel')
  })

  it('negotiator rule pins (from the jar): optional drop, version.mismatch, missing.client.server, flow mismatch', () => {
    const base = [{ id: 'm:a', version: '1', flow: 'clientbound', optional: false }]
    // optional server component absent on the client is dropped, not fatal
    assert.strictEqual(negotiate([...base, { id: 'm:opt', version: '1', flow: 'clientbound', optional: true }], base).success, true)
    // required server component absent on the client is fatal
    assert.deepStrictEqual(negotiate([...base, { id: 'm:req', version: '1', flow: 'clientbound', optional: false }], base).failures, { 'm:req': `${F}missing.server.client` })
    // extra required client component is fatal the other way
    assert.deepStrictEqual(negotiate(base, [...base, { id: 'm:x', version: '1', flow: 'clientbound', optional: false }]).failures, { 'm:x': `${F}missing.client.server` })
    // version compares by String.equals
    assert.deepStrictEqual(negotiate(base, [{ ...base[0], version: '2' }]).failures, { 'm:a': `${F}version.mismatch` })
    // flow: server-present/client-empty => flow.client.missing; both present and different => flow.client.mismatch; server-empty skips the flow check
    assert.deepStrictEqual(negotiate(base, [{ ...base[0], flow: null }]).failures, { 'm:a': `${F}flow.client.missing` })
    assert.deepStrictEqual(negotiate(base, [{ ...base[0], flow: 'serverbound' }]).failures, { 'm:a': `${F}flow.client.mismatch` })
    assert.strictEqual(negotiate([{ ...base[0], flow: null }], [{ ...base[0], flow: null }]).success, true)
  })
})
