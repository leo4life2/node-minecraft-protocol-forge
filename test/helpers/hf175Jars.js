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
//   'switchCase'    in the case arm of a switch on a value the walk does not know
//   'switchDefault' in the default arm of such a switch
//   'switchBoth'    in both arms of such a switch (the walk joins no arms)
//   'switchBefore'  unconditional, BEFORE such a switch (the twin that stays proven)
//   'lookupCase', 'lookupDefault'  the same two arms under a lookupswitch
//
//   beside()      a required registration with a version and an id made at run
//                 time, and beside it a registration with a constant id, no
//                 version and optional() under an undecided condition
//   thrown(bad)   two registrations inside lambdas handed to a deferred-work
//                 call (only the deep walk follows them); bad: a jump between
//                 the two lands on a byte the walk reads past the code's end,
//                 so the deep walk fails after it proved the first id; 'early':
//                 the jump stands before both, the walk fails with nothing met
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
  if (opt === 'switchBefore') optBlock(a)
  if (typeof opt === 'string' && (opt.startsWith('switch') || opt.startsWith('lookup'))) tableSwitch(a, opt)
  return a
}
const optBlock = (a) => a.aload(1).invokevirtual(REG, 'optional', `()L${REG};`).astore(1) // 5 bytes
// switch (Gone.mode()) with ONE case (1) and a default arm; the blocks that follow it:
//   switchCase     case 1: [optional()]            default: past it
//   switchDefault  case 1: past it                 default: [optional()]
//   switchBoth     case 1: [optional()] goto past  default: [optional()]
//   switchBefore   both arms: the next instruction (nothing stands under the switch)
function tableSwitch (a, opt) {
  a.invokestatic(GONE, 'mode', '()I')
  const pad = (4 - ((a.pc + 1) % 4)) % 4
  const L = 1 + pad + 16 // the offset of the first byte after the switch
  const i32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  const [def, c1] = { switchCase: [L + 5, L], switchDefault: [L, L + 5], switchBoth: [L + 8, L], switchBefore: [L, L], lookupCase: [L + 5, L], lookupDefault: [L, L + 5] }[opt]
  // tableswitch: default, low 1, high 1, the one offset; lookupswitch: default, one pair, the match 1, its offset - the same bytes after the opcode
  a.raw([opt.startsWith('lookup') ? 0xab : 0xaa, ...new Array(pad).fill(0), ...i32(def), ...i32(1), ...i32(1), ...i32(c1)])
  if (opt === 'switchBefore') return a
  optBlock(a)
  if (opt === 'switchBoth') optBlock(a.goto_(8))
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

function beside () {
  const init = listener((a) => {
    a.aload(0).ldcStr('7').invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`).astore(1)
    a.aload(1).invokestatic(GONE, 'type', `()L${TYPE};`).aconstNull().aconstNull().invokevirtual(REG, 'playToClient', REGDESC).pop()
    a.aload(0).invokestatic(GONE, 'version', '()Ljava/lang/String;').invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`).astore(2)
    a.invokestatic(GONE, 'flag', '()Z').ifeq(8).aload(2).invokevirtual(REG, 'optional', `()L${REG};`).astore(2)
    a.aload(2); newType(a, (x) => x.ldcStr('direct'))
    return a.aconstNull().aconstNull().invokevirtual(REG, 'playToClient', REGDESC).pop().ret()
  })
  return buildJar([toml(null), { name: `${INIT}.class`, data: init }])
}

function thrown (bad) {
  const lam = (name, id) => ({ name, desc: `(L${REG};)V`, flags: 0x100a, code: (a) => { a.aload(0); newType(a, (x) => x.ldcStr(id)); return a.aconstNull().aconstNull().invokevirtual(REG, 'playToClient', REGDESC).pop().ret() } })
  const defer = (a, i) => a.aload(1).invokedynamic(i, 'run', `(L${REG};)Ljava/lang/Runnable;`).invokestatic(GONE, 'enqueueWork', '(Ljava/lang/Runnable;)V')
  const init = buildClass({
    name: INIT,
    bootstrapMethods: [{ refKind: 6, owner: INIT, name: 'lambda$onRegister$0', desc: `(L${REG};)V` }, { refKind: 6, owner: INIT, name: 'lambda$onRegister$1', desc: `(L${REG};)V` }],
    methods: [lam('lambda$onRegister$0', 'one'), lam('lambda$onRegister$1', 'two'), {
      name: 'onRegister',
      desc: `(L${EVENT};)V`,
      flags: 0x0009,
      code: (a) => {
        a.aload(0).ldcStr('7').invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`).astore(1)
        if (bad !== 'early') defer(a, 0)
        if (!bad) return defer(a, 1).ret()
        // goto END; the registration(s) that follow; return; END: bipush 0xb6 - the jump lands on the 0xb6 (an invoke whose index lies past the code)
        const at = a.pc
        a.goto_(0)
        if (bad === 'early') defer(a, 0)
        defer(a, 1).ret()
        const off = (a.pc + 1) - at
        a.bytes[at + 1] = (off >> 8) & 255; a.bytes[at + 2] = off & 255
        return a.raw([0x10, 0xb6])
      }
    }]
  })
  return buildJar([toml(null), { name: `${INIT}.class`, data: init }])
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

module.exports = { direct, shared, silent, late, beside, thrown, garbage, nestedBad, INIT, HOLD, LATE }
