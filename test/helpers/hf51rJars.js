'use strict'
// HF51-rider synthetic jars (mechanism pins, no mod names): each builder
// returns the entries of a one-mod jar whose registration listener exercises
// one walker seam — the registrar(argument) fallback receipt, an instanceof
// over a chain the index cannot finish, a keyed store's size()/isEmpty(),
// and the per-method undecided flag.
const { buildClass, buildJar } = require('./synthJar')
const EVENT = 'net/neoforged/neoforge/network/event/RegisterPayloadHandlersEvent'
const REG = 'net/neoforged/neoforge/network/registration/PayloadRegistrar'
const TYPE = 'net/minecraft/network/protocol/common/custom/CustomPacketPayload$Type'
const CODEC = 'net/minecraft/network/codec/StreamCodec'
const HANDLER = 'net/neoforged/neoforge/network/handling/IPayloadHandler'
const RL = 'net/minecraft/resources/ResourceLocation'
const REGISTRAR_DESC = `(Ljava/lang/String;)L${REG};`
const PLAY_DESC = `(L${TYPE};L${CODEC};L${HANDLER};)L${REG};`
const toml = (id) => Buffer.from(`modLoader="javafml"\nloaderVersion="[4,)"\nlicense="x"\n[[mods]]\nmodId="${id}"\nversion="9.9.9"\n`)
const codecField = { name: 'CODEC', desc: `L${CODEC};` }
// a forward conditional jump patched to land at the pc where `land` is called
const newType = (a, ns, p) => a.new_(TYPE).dup().ldcStr(ns).ldcStr(p).invokestatic(RL, 'fromNamespaceAndPath', `(Ljava/lang/String;Ljava/lang/String;)L${RL};`).invokespecial(TYPE, '<init>', `(L${RL};)V`)
const playType = (a, holder, ns, p) => { a.aload(1); newType(a, ns, p); return a.getstatic(holder, 'CODEC', `L${CODEC};`).aconstNull().invokevirtual(REG, 'playToServer', PLAY_DESC).pop() }
const instanceOf = (a, cls) => { a.bytes.push(0xc1); a._u16(a.cp.cls(cls)); return a }

// MED-1: event.registrar(<a String no walk can fold>) — an argument EXISTS but is unresolved
function registrarArgumentUnresolvedJar () {
  const name = 'fx/hf51r/RegArg'
  const cls = buildClass({
    name,
    fields: [codecField],
    methods: [{
      name: 'onReg',
      desc: `(L${EVENT};)V`,
      flags: 0x0009,
      code: (a) => { a.aload(0).invokestatic('fx/hf51r/Gone', 'ver', '()Ljava/lang/String;').invokevirtual(EVENT, 'registrar', REGISTRAR_DESC).astore(1); playType(a, name, 'regarg', 'chan').ret() }
    }]
  })
  return buildJar([{ name: `${name}.class`, data: cls }, { name: 'META-INF/neoforge.mods.toml', data: toml('regarg') }])
}

// The deep-pass entry shape (HF16-R2): a static registry on the entry's OWN
// class, populated in <clinit>, iterated by the listener — the linear walk
// reaches no id, so the branch-following evaluator walks the entry.
const ITER = 'java/util/Iterator'
const ELEM = 'fx/hf51r/Elem'
// Elem extends a base the jar does NOT carry (a library class); its id is a
// constructor argument bound in a field, so only the element's own identity
// (the deep walk over the real elements) proves the type() id — the linear
// walk sees an unbound field
const elemClass = (ns) => buildClass({
  name: ELEM,
  superName: 'fx/hf51r/LibBase',
  fields: [{ name: 'id', desc: 'Ljava/lang/String;', flags: 0x0012 }],
  methods: [
    { name: '<init>', desc: '(Ljava/lang/String;)V', flags: 0x0001, code: (a) => a.aload(0).invokespecial('fx/hf51r/LibBase', '<init>', '()V').aload(0).aload(1).putfield(ELEM, 'id', 'Ljava/lang/String;').ret() },
    { name: 'type', desc: `()L${TYPE};`, flags: 0x0001, code: (a) => a.new_(TYPE).dup().ldcStr(ns).aload(0).getfield(ELEM, 'id', 'Ljava/lang/String;').invokestatic(RL, 'fromNamespaceAndPath', `(Ljava/lang/String;Ljava/lang/String;)L${RL};`).invokespecial(TYPE, '<init>', `(L${RL};)V`).areturn() }
  ]
})
const newElem = (a, p) => a.new_(ELEM).dup().ldcStr(p).invokespecial(ELEM, '<init>', '(Ljava/lang/String;)V')
const branch = (a, opcode) => { const at = a.pc; a.bytes.push(opcode, 0, 0); return () => { const off = a.pc - at; a.bytes[at + 1] = (off >> 8) & 0xff; a.bytes[at + 2] = off & 0xff } }
const IFEQ = 0x99; const IFNE = 0x9a; const IF_ICMPLE = 0xa4
// iterate `holder.field` (a List or a Map's values()) into local 2; body(a) runs with the element (Object) in local 3
const forEachElement = (a, holder, field, desc, map, body) => {
  a.getstatic(holder, field, desc)
  if (map) a.invokeinterface('java/util/Map', 'values', '()Ljava/util/Collection;', 1).invokeinterface('java/util/Collection', 'iterator', `()L${ITER};`, 1)
  else a.invokeinterface('java/util/List', 'iterator', `()L${ITER};`, 1)
  a.astore(2)
  const loop = a.pc
  a.aload(2).invokeinterface(ITER, 'hasNext', '()Z', 1)
  const end = branch(a, IFEQ)
  a.aload(2).invokeinterface(ITER, 'next', '()Ljava/lang/Object;', 1).astore(3)
  body(a)
  a.goto_(loop - a.pc)
  end()
}
const registerElem = (a, holder) => a.aload(1).aload(3).checkcast(ELEM).invokevirtual(ELEM, 'type', `()L${TYPE};`).getstatic(holder, 'CODEC', `L${CODEC};`).aconstNull().invokevirtual(REG, 'playToServer', PLAY_DESC).pop()
const registrarInto1 = (a) => a.aload(0).ldcStr('1').invokevirtual(EVENT, 'registrar', REGISTRAR_DESC).astore(1)

// MED-2: the listener tests each element against an interface only the
// unindexed base implements — `if (e instanceof IReg) register(e)` and the
// guard form `if (!(e instanceof IReg)) continue; register(e)`; the 'plain'
// form (no test) is the control proving the deep walk itself
function instanceofUnindexedBaseJar (form = 'body') {
  const name = 'fx/hf51r/Inst'
  const entry = (a) => {
    registrarInto1(a)
    forEachElement(a, name, 'pending', 'Ljava/util/List;', false, (b) => {
      if (form === 'plain') { registerElem(b, name); return }
      instanceOf(b.aload(3), 'fx/hf51r/IReg')
      if (form === 'guard') { const body = branch(b, IFNE); const skip = branch(b, 0xa7); body(); registerElem(b, name); skip() } else { const skip = branch(b, IFEQ); registerElem(b, name); skip() }
    })
    a.ret()
  }
  const cls = buildClass({
    name,
    fields: [codecField, { name: 'pending', desc: 'Ljava/util/List;', flags: 0x0019 }],
    methods: [
      { name: '<clinit>', desc: '()V', flags: 0x0008, code: (a) => { a.new_('java/util/ArrayList').dup().invokespecial('java/util/ArrayList', '<init>', '()V').putstatic(name, 'pending', 'Ljava/util/List;').getstatic(name, 'pending', 'Ljava/util/List;'); newElem(a, 'chan'); a.invokeinterface('java/util/List', 'add', '(Ljava/lang/Object;)Z', 2).pop().ret() } },
      { name: 'on' + form[0].toUpperCase() + form.slice(1), desc: `(L${EVENT};)V`, flags: 0x0009, code: entry }
    ]
  })
  return buildJar([{ name: `${ELEM}.class`, data: elemClass('inst') }, { name: `${name}.class`, data: cls }, { name: 'META-INF/neoforge.mods.toml', data: toml('inst') }])
}

// MED-3: a static Map filled by put() under ONE key twice (an upsert); the
// listener returns unless size() <= 1 / iterates values(), and a second
// listener returns on isEmpty()
function keyedStoreSizeJar (form = 'size') {
  const name = 'fx/hf51r/Store'
  const putElem = (a) => { a.getstatic(name, 'M', 'Ljava/util/Map;').ldcStr('k'); newElem(a, 'mapped'); a.invokeinterface('java/util/Map', 'put', '(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;', 3).pop() }
  const cls = buildClass({
    name,
    fields: [codecField, { name: 'M', desc: 'Ljava/util/Map;', flags: 0x0019 }],
    methods: [
      { name: '<clinit>', desc: '()V', flags: 0x0008, code: (a) => { a.new_('java/util/HashMap').dup().invokespecial('java/util/HashMap', '<init>', '()V').putstatic(name, 'M', 'Ljava/util/Map;'); putElem(a); putElem(a); a.ret() } },
      form === 'empty'
        ? { name: 'onEmpty', desc: `(L${EVENT};)V`, flags: 0x0009, code: (a) => { registrarInto1(a); a.getstatic(name, 'M', 'Ljava/util/Map;').invokeinterface('java/util/Map', 'isEmpty', '()Z', 1); const go = branch(a, IFEQ); a.ret(); go(); forEachElement(a, name, 'M', 'Ljava/util/Map;', true, (b) => registerElem(b, name)); a.ret() } }
        : { name: 'onSize', desc: `(L${EVENT};)V`, flags: 0x0009, code: (a) => { registrarInto1(a); a.getstatic(name, 'M', 'Ljava/util/Map;').invokeinterface('java/util/Map', 'size', '()I', 1).iconst(1); const go = branch(a, IF_ICMPLE); a.ret(); go(); forEachElement(a, name, 'M', 'Ljava/util/Map;', true, (b) => registerElem(b, name)); a.ret() } }
    ]
  })
  return buildJar([{ name: `${ELEM}.class`, data: elemClass('store') }, { name: `${name}.class`, data: cls }, { name: 'META-INF/neoforge.mods.toml', data: toml('store') }])
}

// LOW: a helper's own conditional must not make the CALLER's later `.optional()` undecided
function helperConditionalLeakJar () {
  const name = 'fx/hf51r/Leak'
  const helper = buildClass({ name: 'fx/hf51r/Helper', methods: [{ name: 'touch', desc: `(L${REG};)V`, flags: 0x0009, code: (a) => { a.invokestatic('fx/hf51r/Gone', 'flag', '()Z'); const l = branch(a, IFEQ); a.ret(); l(); a.ret() } }] })
  const cls = buildClass({
    name,
    fields: [codecField],
    methods: [{
      name: 'onReg',
      desc: `(L${EVENT};)V`,
      flags: 0x0009,
      code: (a) => a
        .aload(0).ldcStr('1').invokevirtual(EVENT, 'registrar', REGISTRAR_DESC).astore(1)
        .aload(1).invokestatic('fx/hf51r/Helper', 'touch', `(L${REG};)V`)
        .aload(1).invokevirtual(REG, 'optional', `()L${REG};`).astore(1)
        .aload(1).invokestatic('fx/hf51r/Gone', 'type', `()L${TYPE};`).getstatic(name, 'CODEC', `L${CODEC};`).aconstNull()
        .invokevirtual(REG, 'playToServer', PLAY_DESC).pop().ret()
    }]
  })
  return buildJar([{ name: `${name}.class`, data: cls }, { name: 'fx/hf51r/Helper.class', data: helper }, { name: 'META-INF/neoforge.mods.toml', data: toml('leak') }])
}

module.exports = { registrarArgumentUnresolvedJar, instanceofUnindexedBaseJar, keyedStoreSizeJar, helperConditionalLeakJar }
