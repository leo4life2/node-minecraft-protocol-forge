'use strict'
// HF175 - MADE jars for the word of a reading (test only; no published mod's
// bytes). Every jar is one small mod `kmod` whose listener opens a registrar
// with a version the walk cannot fold (a call into a class that is not in the
// jar), so no version is derivable and mods.toml declares none.
//
//   direct(opt)   ONE registration in the listener itself, a constant id
//   shared(opt)   ONE registration call (Holder.register, the id from the
//                 holder's own field) that two holder objects share: the
//                 aggregator's row
//   silent()      the registrar is handed to a method outside the jar: the
//                 walk never reaches a registration
//   late(shape)   'asks': a class asks the event for a registrar in a method no
//                 entry leads to; 'lib': a class only receives a registrar and
//                 nobody hands it one; 'entry': that helper reached from a listener
//   garbage()     bytes that are no zip
//   nestedBad()   a jar that nests a jar whose entry cannot be inflated
//
// opt, the call of optional():
//   'none'        no call: a required registration
//   'plain'       unconditional
//   'undecided'   under a condition the walk cannot decide (a call out of the jar)
//   'decided'     under a condition the walk decides (a constant)
//   'callee'      inside a helper of the mod that is called under an undecided condition
//   'calleePlain' inside the same helper, called unconditionally
const { buildClass, buildJar } = require('./synthJar')

const EVENT = 'net/neoforged/neoforge/network/event/RegisterPayloadHandlersEvent'
const REG = 'net/neoforged/neoforge/network/registration/PayloadRegistrar'
const TYPE = 'net/minecraft/network/protocol/common/custom/CustomPacketPayload$Type'
const RL = 'net/minecraft/resources/ResourceLocation'
const GONE = 'synth/k/Gone' // never in the jar: a call into it is unknown to the walk
const INIT = 'synth/k/Init'
const HOLD = 'synth/k/Holder'
const ONE = 'synth/k/One'
const TWO = 'synth/k/Two'
const LATE = 'synth/k/Late'
const REGDESC = `(L${TYPE};Ljava/lang/Object;Ljava/lang/Object;)L${REG};`
const toml = (version) => ({ name: 'META-INF/neoforge.mods.toml', data: Buffer.from(`modLoader="javafml"\nloaderVersion="[4,)"\nlicense="x"\n[[mods]]\nmodId="kmod"\n${version ? `version="${version}"\n` : ''}`) })

function openRegistrar (a, opt, version) {
  a.aload(0)
  if (version) a.ldcStr(version); else a.invokestatic(GONE, 'version', '()Ljava/lang/String;')
  a.invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`).astore(1)
  if (opt === 'undecided') a.invokestatic(GONE, 'flag', '()Z').ifeq(8)
  if (opt === 'decided') a.iconst(1).ifeq(8)
  if (opt === 'undecided' || opt === 'decided' || opt === 'plain') a.aload(1).invokevirtual(REG, 'optional', `()L${REG};`).astore(1)
  if (opt === 'callee') a.invokestatic(GONE, 'flag', '()Z').ifeq(8)
  if (opt === 'callee' || opt === 'calleePlain') a.aload(1).invokestatic(INIT, 'opt', `(L${REG};)L${REG};`).astore(1)
  return a
}
const optHelper = { name: 'opt', desc: `(L${REG};)L${REG};`, flags: 0x0009, code: (a) => a.aload(0).invokevirtual(REG, 'optional', `()L${REG};`).areturnOp() }
const newType = (a, pushPath) => { a.new_(TYPE).dup().ldcStr('kmod'); pushPath(a); return a.invokestatic(RL, 'fromNamespaceAndPath', `(Ljava/lang/String;Ljava/lang/String;)L${RL};`).invokespecial(TYPE, '<init>', `(L${RL};)V`) }
const listener = (code) => buildClass({ name: INIT, methods: [optHelper, { name: 'onRegister', desc: `(L${EVENT};)V`, flags: 0x0009, code }] })

function direct (opt, { version = null, modVersion = null } = {}) {
  const init = listener((a) => { openRegistrar(a, opt, version).aload(1); newType(a, (x) => x.ldcStr('direct')); return a.aconstNull().aconstNull().invokevirtual(REG, 'playToClient', REGDESC).pop().ret() })
  return buildJar([toml(modVersion), { name: `${INIT}.class`, data: init }])
}

function shared (opt, { version = null, modVersion = null } = {}) {
  const hold = buildClass({
    name: HOLD,
    fields: [{ name: 'id', desc: `L${TYPE};` }],
    methods: [
      { name: '<init>', desc: `(L${TYPE};)V`, flags: 0x0001, code: (a) => a.aload(0).invokespecial('java/lang/Object', '<init>', '()V').aload(0).aload(1).putfield(HOLD, 'id', `L${TYPE};`).ret() },
      { name: 'of', desc: `(Ljava/lang/String;)L${HOLD};`, flags: 0x0009, code: (a) => { a.new_(HOLD).dup(); newType(a, (x) => x.aload(0)); return a.invokespecial(HOLD, '<init>', `(L${TYPE};)V`).areturnOp() } },
      { name: 'register', desc: `(L${REG};)V`, flags: 0x0001, code: (a) => a.aload(1).aload(0).getfield(HOLD, 'id', `L${TYPE};`).aconstNull().aconstNull().invokevirtual(REG, 'playToClient', REGDESC).pop().ret() }
    ]
  })
  const holder = (name, id) => buildClass({
    name,
    fields: [{ name: 'IT', desc: `L${HOLD};`, flags: 0x0019 }],
    methods: [{ name: '<clinit>', desc: '()V', flags: 0x0008, code: (a) => a.ldcStr(id).invokestatic(HOLD, 'of', `(Ljava/lang/String;)L${HOLD};`).putstatic(name, 'IT', `L${HOLD};`).ret() }]
  })
  const init = listener((a) => openRegistrar(a, opt, version)
    .getstatic(ONE, 'IT', `L${HOLD};`).aload(1).invokevirtual(HOLD, 'register', `(L${REG};)V`)
    .getstatic(TWO, 'IT', `L${HOLD};`).aload(1).invokevirtual(HOLD, 'register', `(L${REG};)V`).ret())
  return buildJar([toml(modVersion), { name: `${HOLD}.class`, data: hold }, { name: `${ONE}.class`, data: holder(ONE, 'one') }, { name: `${TWO}.class`, data: holder(TWO, 'two') }, { name: `${INIT}.class`, data: init }])
}

function silent () {
  const init = listener((a) => a.aload(0).ldcStr('1').invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`).astore(1).aload(1).invokestatic(GONE, 'consume', `(L${REG};)V`).ret())
  return buildJar([toml('3.2.1'), { name: `${INIT}.class`, data: init }])
}

function late (shape) {
  // 'asks'  a class asks the event for a registrar inside a method that does not take the event (accept(Object)): no entry leads to it
  // 'lib'   a class only RECEIVES a registrar (a library's helper) and nothing in the jar hands it one
  // 'entry' the same helper, reached from a listener of the jar
  const register = (a) => { newType(a, (x) => x.ldcStr('late')); return a.aconstNull().aconstNull().invokevirtual(REG, 'playToClient', REGDESC).pop().ret() }
  const cls = buildClass({
    name: LATE,
    methods: shape === 'asks'
      ? [{ name: 'accept', desc: '(Ljava/lang/Object;)V', flags: 0x0009, code: (a) => register(a.aload(0).checkcast(EVENT).ldcStr('1').invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`)) }]
      : [{ name: 'go', desc: `(L${REG};)V`, flags: 0x0009, code: (a) => register(a.aload(0)) }]
  })
  const entries = [toml('3.2.1'), { name: `${LATE}.class`, data: cls }]
  if (shape === 'entry') entries.push({ name: `${INIT}.class`, data: listener((a) => a.aload(0).ldcStr('1').invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`).invokestatic(LATE, 'go', `(L${REG};)V`).ret()) })
  return buildJar(entries)
}

const garbage = () => Buffer.from('this file is no zip and holds no class\n'.repeat(8))

// a jar whose nested jar entry says it is deflated and holds bytes that are no deflate stream
function nestedBad () {
  const name = 'META-INF/jarjar/inner-1.0.jar'
  const meta = { name: 'META-INF/jarjar/metadata.json', data: Buffer.from(JSON.stringify({ jars: [{ identifier: { group: 'synth', artifact: 'inner' }, version: { range: '[1.0,)', artifactVersion: '1.0' }, path: name, isObfuscated: false }] })) }
  const buf = buildJar([{ name, data: Buffer.alloc(64, 0xff) }, toml('3.2.1'), meta])
  buf.writeUInt16LE(8, 8) // the local header of the first entry: method deflate
  const central = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  buf.writeUInt16LE(8, central + 10)
  return buf
}

module.exports = { direct, shared, silent, late, garbage, nestedBad, INIT, HOLD, LATE }
