'use strict'
// A generic Function1 with many overrides. A statically unknown field can
// hold any implementation. An allocated receiver can forward its Object
// argument through one or more relays to the registrar checkcast.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildClass, buildJar } = require('./helpers/synthJar')
const { deriveNeoForgeComponents } = require('../src/client/neoForgePayloadDerivation')

const EVENT = 'net/neoforged/neoforge/network/event/RegisterPayloadHandlersEvent'
const REG = 'net/neoforged/neoforge/network/registration/PayloadRegistrar'
const TYPE = 'net/minecraft/network/protocol/common/custom/CustomPacketPayload$Type'
const RL = 'net/minecraft/resources/ResourceLocation'
const CODEC = 'net/minecraft/network/codec/StreamCodec'
const HANDLER = 'net/neoforged/neoforge/network/handling/IPayloadHandler'
const REG_DESC = `(L${TYPE};L${CODEC};L${HANDLER};)L${REG};`
const F1 = 'kotlin/jvm/functions/Function1'
const KLAMBDA = 'kotlin/jvm/internal/Lambda'
const OBJ = 'java/lang/Object'
const OO = '(Ljava/lang/Object;)Ljava/lang/Object;'
const NOISE = 13 // > the 12-override bound on its own

const objInit = (a, sup = OBJ) => a.aload(0).invokespecial(sup, '<init>', '()V').ret()
const lambdaInit = (a) => a.aload(0).iconst(1).invokespecial(KLAMBDA, '<init>', '(I)V').ret()

function packets (P, ids) { // static TYPE per packet, built in <clinit> from a constant id
  return ids.map(([cls, id]) => ({
    name: `${cls}.class`,
    data: buildClass({
      name: cls,
      fields: [{ name: 'TYPE', desc: `L${TYPE};`, flags: 0x0019 }],
      methods: [
        { name: '<clinit>', desc: '()V', flags: 0x0008, code: (a) => a.new_(TYPE).dup().ldcStr('synthfo').ldcStr(id).invokestatic(RL, 'fromNamespaceAndPath', `(Ljava/lang/String;Ljava/lang/String;)L${RL};`).invokespecial(TYPE, '<init>', `(L${RL};)V`).putstatic(cls, 'TYPE', `L${TYPE};`).ret() }
      ]
    })
  }))
}

// registers `pkt` on the registrar already on the stack
const register = (a, P, pkt) => a.getstatic(pkt, 'TYPE', `L${TYPE};`).aconstNull().aconstNull().invokevirtual(REG, 'playToServer', REG_DESC).pop()

function jar (P, { hops, allocated = false }) {
  const net = `${P}/Net`
  const entries = [{ name: 'META-INF/neoforge.mods.toml', data: Buffer.from('[[mods]]\nmodId="synthfo"\nversion="2.0.0"\n') }]
  // the entry: event.registrar("3") handed to a Function1 held in a static field
  entries.push({
    name: `${net}.class`,
    data: buildClass({
      name: net,
      fields: [{ name: 'fn', desc: `L${F1};`, flags: 0x000a }],
      methods: [
        { name: '<init>', desc: '()V', flags: 0x0002, code: (a) => objInit(a) },
        {
          name: 'onRegister', desc: `(L${EVENT};)V`, flags: 0x0019,
          code (a) {
            a.aload(0).ldcStr('3').invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`).astore(1)
            if (allocated) {
              for (const cls of [`${P}/Fwd`, `${P}/Carrier`]) {
                a.new_(cls).dup().invokespecial(cls, '<init>', '()V').aload(1).invokeinterface(F1, 'invoke', OO, 2).pop()
              }
            } else a.getstatic(net, 'fn', `L${F1};`).aload(1).invokeinterface(F1, 'invoke', OO, 2).pop()
            a.ret()
          }
        }
      ]
    })
  })
  entries.push(...packets(P, [[`${P}/OnePacket`, 'one'], [`${P}/TwoPacket`, 'two']]))
  // 13 noise implementors: no registrar anywhere near them
  for (let i = 0; i < NOISE; i++) {
    const n = `${P}/Noise${i}`
    entries.push({
      name: `${n}.class`,
      data: buildClass({
        name: n,
        superName: KLAMBDA,
        interfaces: [F1],
        methods: [
          { name: '<init>', desc: '()V', flags: 0x0001, code: lambdaInit },
          { name: 'invoke', desc: OO, flags: 0x1041, code: (a) => a.aload(1).areturn() }
        ]
      })
    })
  }
  // the carrying sibling: checkcast in its own bridge, registers TwoPacket
  const carrier = `${P}/Carrier`
  entries.push({
    name: `${carrier}.class`,
    data: buildClass({
      name: carrier,
      superName: KLAMBDA,
      interfaces: [F1],
      methods: [
        { name: '<init>', desc: '()V', flags: 0x0001, code: lambdaInit },
        { name: 'invoke', desc: OO, flags: 0x1041, code: (a) => { a.aload(1).checkcast(REG).astore(2).aload(2); return register(a, P, `${P}/TwoPacket`).aconstNull().areturn() } }
      ]
    })
  })
  // the forwarded override: hands its Object argument to Helper.reg(Object)
  // through `hops` relays; the checkcast lives in Helper only
  const helper = `${P}/Helper`
  let nextOwner = helper
  for (let i = hops; i >= 1; i--) {
    const r = `${P}/Relay${i}`; const o = nextOwner
    entries.push({ name: `${r}.class`, data: buildClass({ name: r, methods: [{ name: 'reg', desc: '(Ljava/lang/Object;)V', flags: 0x0009, code: (a) => a.aload(0).invokestatic(o, 'reg', '(Ljava/lang/Object;)V').ret() }] }) })
    nextOwner = r
  }
  const first = nextOwner
  entries.push({ name: `${helper}.class`, data: buildClass({ name: helper, methods: [{ name: 'reg', desc: '(Ljava/lang/Object;)V', flags: 0x0009, code: (a) => { a.aload(0).checkcast(REG).astore(1).aload(1); return register(a, P, `${P}/OnePacket`).ret() } }] }) })
  const fwd = `${P}/Fwd`
  entries.push({
    name: `${fwd}.class`,
    data: buildClass({
      name: fwd,
      superName: KLAMBDA,
      interfaces: [F1],
      methods: [
        { name: '<init>', desc: '()V', flags: 0x0001, code: lambdaInit },
        { name: 'invoke', desc: OO, flags: 0x1041, code: (a) => a.aload(1).invokestatic(first, 'reg', '(Ljava/lang/Object;)V').aconstNull().areturn() }
      ]
    })
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthjar-hf16r2-fo-'))
  const j = path.join(dir, 'fo.jar')
  fs.writeFileSync(j, buildJar(entries))
  return j
}

const claims = (r) => r.components.play.map((c) => c.id).sort()

describe('HF16-R2 forwarded-as-Object registrar overrides', function () {
  for (const hops of [0, 1]) {
    it(`an unknown receiver among 15 alternatives remains unread with ${hops} extra relays`, () => {
      const r = deriveNeoForgeComponents([jar('synth/fo', { hops })])
      assert.deepStrictEqual(claims(r), [])
      assert.ok(r.diagnostics.unresolvedSites.some(s => s.kind === 'unseen' && s.site === `synth/fo/Net.onRegister(L${EVENT};)V@3`), JSON.stringify(r.diagnostics.unresolvedSites))
    })
    it(`two allocated receivers both register through ${hops} extra relays`, () => {
      const r = deriveNeoForgeComponents([jar('synth/fo', { hops, allocated: true })])
      assert.deepStrictEqual(claims(r), ['synthfo:one', 'synthfo:two'])
      assert.deepStrictEqual(r.diagnostics.unresolvedSites || [], [])
    })
  }
})
