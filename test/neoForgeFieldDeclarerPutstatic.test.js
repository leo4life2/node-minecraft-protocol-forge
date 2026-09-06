'use strict'
/* eslint-env mocha */

// HF16-R rider — putstatic keys the recorded value by the DECLARING class,
// symmetric with getstatic (JVMS §5.4.3.2 resolves both the same way). javac
// qualifies an inherited static written from a subclass body by the SUBCLASS
// (JLS §13.1: `static { TYPE_W = ... }` inside Sub emits putstatic Sub.TYPE_W
// even though Base declares it). Pre-rider the write landed under
// `Sub.TYPE_W` while a read through the declarer looked up `Base.TYPE_W`,
// simulated Base's own initializer, found nothing, and abstained the
// registration. Unknown classes still fall back to the use-site owner on
// BOTH sides, so writes and reads of a vanished class still meet.

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
const BASE = 'synth/put/BasePayload'
const SUB = 'synth/put/SubPayload'
const GONE = 'synth/put/Vanished' // never in the jar
const ENTRY = 'synth/put/ModInit'

function register (a, regMethod, owner, field) {
  return a
    .getstatic(owner, field, `L${TYPE};`)
    .iconst(0).iconst(0)
    .invokevirtual(REG, regMethod, `(L${TYPE};Ljava/lang/Object;Ljava/lang/Object;)L${REG};`)
    .pop()
}
function newType (a, ns, p) {
  return a.new_(TYPE).dup().ldcStr(ns).ldcStr(p)
    .invokestatic(RL, 'fromNamespaceAndPath', `(Ljava/lang/String;Ljava/lang/String;)L${RL};`)
    .invokespecial(TYPE, '<init>', `(L${RL};)V`)
}

function synthJar () {
  // Base DECLARES TYPE_W but its own initializer never writes it.
  const baseCls = buildClass({
    name: BASE,
    fields: [{ name: 'TYPE_W', desc: `L${TYPE};` }, { name: 'CODEC', desc: 'Ljava/lang/Object;' }],
    methods: [{
      name: '<clinit>',
      desc: '()V',
      flags: 0x0008,
      code: (a) => a.aconstNull().putstatic(BASE, 'CODEC', 'Ljava/lang/Object;').ret()
    }]
  })
  // Sub writes the inherited TYPE_W through ITS OWN qualifier (javac shape),
  // plus its own OWN constant, plus a write through a class not in the jar.
  const subCls = buildClass({
    name: SUB,
    superName: BASE,
    fields: [{ name: 'OWN', desc: `L${TYPE};` }],
    methods: [{
      name: '<clinit>',
      desc: '()V',
      flags: 0x0008,
      code: (a) => {
        newType(a, 'synthput', 'own_state').putstatic(SUB, 'OWN', `L${TYPE};`)
        newType(a, 'synthput', 'inherited_state').putstatic(SUB, 'TYPE_W', `L${TYPE};`)
        newType(a, 'synthput', 'gone_state').putstatic(GONE, 'TYPE_GONE', `L${TYPE};`)
        return a.ret()
      }
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
        a.aload(1); register(a, 'playToServer', SUB, 'OWN') // Sub's own constant (initializes Sub)
        a.aload(1); register(a, 'playToClient', BASE, 'TYPE_W') // read through the DECLARER
        a.aload(1); register(a, 'playToClient', GONE, 'TYPE_GONE') // unknown class: use-site fallback both sides
        return a.ret()
      }
    }]
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthjar-hf16r-put-'))
  const jar = path.join(dir, 'put.jar')
  fs.writeFileSync(jar, buildJar([
    { name: 'META-INF/neoforge.mods.toml', data: Buffer.from('modId="synthput"\nversion="1.0.0"\n') },
    { name: `${ENTRY}.class`, data: entryCls },
    { name: `${BASE}.class`, data: baseCls },
    { name: `${SUB}.class`, data: subCls }
  ]))
  return jar
}

describe('HF16-R rider: putstatic keys by the field declarer (symmetry with getstatic)', function () {
  it('a static written through the subclass qualifier and read through the declarer derives', () => {
    const { components, diagnostics } = deriveNeoForgeComponents([synthJar()])
    assert.strictEqual(diagnostics.abstains.length, 0, `no abstains expected, got: ${diagnostics.abstains.join(' | ')}`)
    const play = new Map(components.play.map((c) => [c.id, c]))
    const w = play.get('synthput:inherited_state')
    assert.ok(w, 'declarer-read / subclass-written constant must derive')
    assert.deepStrictEqual({ version: w.version, flow: w.flow, optional: w.optional }, { version: '1', flow: 'clientbound', optional: false })
    assert.strictEqual(play.get('synthput:own_state').flow, 'serverbound')
    assert.strictEqual(components.play.length, 3)
  })

  it('an unknown class falls back to the use-site owner on both the write and the read', () => {
    const { components } = deriveNeoForgeComponents([synthJar()])
    const g = components.play.find((c) => c.id === 'synthput:gone_state')
    assert.ok(g, 'vanished-class write and read still meet under the use-site key')
    assert.strictEqual(g.flow, 'clientbound')
  })
})
