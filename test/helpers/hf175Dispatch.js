// Small mod jars for calls that pass a registrar through a runtime receiver.
const { buildClass, buildJar } = require('./synthJar')

const event = 'net/neoforged/neoforge/network/event/RegisterPayloadHandlersEvent'
const registrar = 'net/neoforged/neoforge/network/registration/PayloadRegistrar'
const type = 'net/minecraft/network/protocol/common/custom/CustomPacketPayload$Type'
const id = 'net/minecraft/resources/ResourceLocation'
const bus = 'net/neoforged/bus/api/IEventBus'
const string = 'Ljava/lang/String;'
const object = 'java/lang/Object'
const entry = 'fixture/Signals'
const api = 'fixture/Installer'
const first = 'fixture/First'
const second = 'fixture/Second'
const reg = '(L' + registrar + ';)V'
const listener = '(L' + event + ';)V'
const install = (a) => a.invokeinterface(api, 'install', reg, 2)
const ctor = { name: '<init>', desc: '()V', flags: 1, code: a => a.aload(0).invokespecial(object, '<init>', '()V').ret() }
const construct = (a, cls) => a.new_(cls).dup().invokespecial(cls, '<init>', '()V')

function emit (a, name) {
  a.new_(type).dup().ldcStr('fixture')
  if (typeof name === 'function') name(a)
  else if (name) a.ldcStr(name)
  else a.ldcStr('fixture.path').invokestatic('java/lang/System', 'getProperty', '(' + string + ')' + string)
  a.invokestatic(id, 'fromNamespaceAndPath', '(' + string + string + ')L' + id + ';')
    .invokespecial(type, '<init>', '(L' + id + ';)V').aconstNull().aconstNull()
  const offset = a.bytes.length
  a.invokevirtual(registrar, 'playToClient', '(L' + type + ';Ljava/lang/Object;Ljava/lang/Object;)L' + registrar + ';').pop()
  return offset
}

function dispatchJar (shape) {
  const files = []
  const sites = {}
  const add = spec => files.push({ name: spec.name + '.class', data: buildClass(spec) })
  const methods = []
  const bootstrapMethods = [{ owner: entry, name: 'read', desc: listener }]
  const ask = (a, version) => {
    a.aload(0).ldcStr(version)
    sites[version] = entry + '.read' + listener + '@' + a.bytes.length
    a.invokevirtual(event, 'registrar', '(' + string + ')L' + registrar + ';')
  }
  const service = ['missing provider', 'first only', 'two providers', 'one provider'].includes(shape)
  const dispatch = service || ['unknown override', 'abstract alternatives', 'known receiver', 'branch receiver', 'earlier receiver', 'unrelated service', 'specific default', 'factory bound'].includes(shape)
  if (dispatch) {
    const installMethod = ids => ({
      name: 'install', desc: reg, flags: 1,
      code (a) { for (const name of ids) emit(a.aload(1), name); a.ret() }
    })
    const withDefault = ['unknown override', 'specific default', 'factory bound'].includes(shape)
    const factoryBound = shape === 'factory bound'
    const declaration = withDefault ? installMethod(['default']) : { name: 'install', desc: reg, flags: 0x401 }
    add({ name: api, flags: factoryBound ? 0x21 : 0x601, methods: factoryBound ? [ctor, declaration] : [declaration] })
    const parents = factoryBound ? { superName: api } : { interfaces: [api] }
    const init = factoryBound ? { ...ctor, code: a => a.aload(0).invokespecial(api, '<init>', '()V').ret() } : ctor
    add({ name: first, ...parents, methods: withDefault ? [init] : [init, installMethod(['first'])] })
    if (shape === 'specific default') {
      const child = 'fixture/ChildInstaller'
      add({ name: child, flags: 0x601, interfaces: [api], methods: [installMethod(['child'])] })
      add({ name: second, interfaces: [api, child], methods: [ctor] })
    } else if (!service || shape === 'two providers') add({ name: second, ...parents, methods: [init, installMethod(['second', 'extra'])] })
    if (service || shape === 'unrelated service') {
      const providers = ['one provider', 'unrelated service'].includes(shape) ? [first] : [first, second]
      files.push({ name: 'META-INF/services/fixture.Installer', data: Buffer.from(providers.map(p => p.replace('/', '.')).join('\n') + '\n') })
    }
  }
  methods.push({
    name: '<init>', desc: '(L' + bus + ';)V', flags: 1,
    code: a => a.aload(0).invokespecial(object, '<init>', '()V').aload(1)
      .invokedynamic(0, 'accept', '()Ljava/util/function/Consumer;')
      .invokeinterface(bus, 'addListener', '(Ljava/util/function/Consumer;)V', 2).ret()
  })
  const route = '([Ljava/lang/Object;)V'
  if (shape === 'unknown override') {
    methods.push({
      name: 'route', desc: route,
      code (a) {
        const loadRegistrar = () => a.aload(0).iconst(0).aaload().checkcast(registrar)
        emit(loadRegistrar(), 'base')
        const holder = 'java/util/concurrent/atomic/AtomicReference'
        construct(a.new_(holder).dup(), second)
        a.invokespecial(holder, '<init>', '(Ljava/lang/Object;)V').invokevirtual(holder, 'get', '()Ljava/lang/Object;').checkcast(api)
        install(loadRegistrar()).ret()
      }
    })
  }
  if (shape === 'runtime id') {
    methods.push({ name: 'knownTarget', desc: reg, code (a) {
      emit(a.aload(0), 'base')
      sites.id = entry + '.knownTarget' + reg + '@' + emit(a.aload(0), null)
      a.ret()
    } })
  }
  if (shape === 'field') {
    add({ name: 'fixture/Box', fields: [{ name: 'active', desc: 'L' + registrar + ';', flags: 9 }], methods: [{
      name: 'replace', desc: reg, code: a => a.aload(0).ldcStr('2').invokevirtual(registrar, 'versioned', '(' + string + ')L' + registrar + ';')
        .putstatic('fixture/Box', 'active', 'L' + registrar + ';').ret()
    }] })
  }
  if (shape === 'capture') {
    bootstrapMethods.push({ owner: entry, name: 'later', desc: reg })
    methods.push({ name: 'later', desc: reg, code (a) { emit(a.aload(0), 'later'); a.ret() } })
  }
  methods.push({
    name: 'read', desc: listener,
    code (a) {
      if (shape === 'earlier receiver') {
        construct(a, first).astore(2).ldcStr('fixture.second').invokestatic('java/lang/Boolean', 'getBoolean', '(' + string + ')Z').ifeq(11)
        construct(a, second).astore(2)
      }
      ask(a, '1')
      a.astore(1)
      if (shape === 'unknown override') {
        const cls = a.cp.cls(object)
        a.iconst(1).raw([0xbd, cls >> 8, cls]).dup().iconst(0).aload(1).raw([0x53]).invokestatic(entry, 'route', route)
      } else if (service) {
        emit(a.aload(1), 'base')
        const cls = a.cp.cls(api)
        a.raw([0x13, cls >> 8, cls]).invokestatic('java/util/ServiceLoader', 'load', '(Ljava/lang/Class;)Ljava/util/ServiceLoader;')
        if (shape === 'first only') {
          a.invokevirtual('java/util/ServiceLoader', 'findFirst', '()Ljava/util/Optional;')
            .invokevirtual('java/util/Optional', 'orElseThrow', '()Ljava/lang/Object;').checkcast(api)
          install(a.aload(1)).ret()
          return
        }
        a.invokevirtual('java/util/ServiceLoader', 'iterator', '()Ljava/util/Iterator;').astore(2)
        const calls = shape === 'one provider' ? 1 : 2
        for (let i = 0; i < calls; i++) install(a.aload(2).invokeinterface('java/util/Iterator', 'next', '()Ljava/lang/Object;', 1).checkcast(api).aload(1))
      } else if (shape === 'abstract alternatives' || shape === 'unrelated service') {
        emit(a.aload(1), 'base')
        const cls = a.cp.cls(api)
        a.iconst(2).raw([0xbd, cls >> 8, cls])
        construct(a.dup().iconst(0), first).raw([0x53])
        construct(a.dup().iconst(1), second).raw([0x53]).ldcStr('fixture.second')
          .invokestatic('java/lang/Boolean', 'getBoolean', '(' + string + ')Z').aaload()
        install(a.aload(1))
      } else if (shape === 'branch calls' || shape === 'branch receiver') {
        emit(a.aload(1), 'base')
        a.ldcStr('fixture.second').invokestatic('java/lang/Boolean', 'getBoolean', '(' + string + ')Z')
        const branch = a.bytes.length
        a.ifeq(0)
        if (shape === 'branch calls') emit(a.aload(1), 'left')
        else construct(a, first)
        const jump = a.bytes.length
        a.goto_(0)
        const other = a.bytes.length
        if (shape === 'branch calls') emit(a.aload(1), 'right')
        else construct(a, second)
        const join = a.bytes.length
        a.bytes.splice(branch + 1, 2, (other - branch) >> 8, (other - branch) & 255)
        a.bytes.splice(jump + 1, 2, (join - jump) >> 8, (join - jump) & 255)
        if (shape === 'branch receiver') install(a.aload(1))
      } else if (shape === 'factory bound') {
        emit(a.aload(1), 'base')
        a.invokestatic('outside/Factory', 'get', '()L' + api + ';').aload(1).invokevirtual(api, 'install', reg)
      } else if (shape === 'earlier receiver') {
        emit(a.aload(1), 'base')
        install(a.aload(2).aload(1))
      } else if (shape === 'known receiver' || shape === 'specific default') {
        install(construct(a, second).aload(1))
      } else if (shape === 'field') {
        const field = ['fixture/Box', 'active', 'L' + registrar + ';']
        a.aload(1).putstatic(...field)
        emit(a.getstatic(...field), 'first')
        a.aload(1).invokestatic('fixture/Box', 'replace', reg)
        emit(a.getstatic(...field), 'second')
      } else if (shape === 'runtime id') {
        a.aload(1).invokestatic(entry, 'knownTarget', reg)
      } else {
        emit(a.aload(1), 'base')
        if (shape === 'capture') a.aload(1).invokedynamic(1, 'run', '(L' + registrar + ';)Ljava/lang/Runnable;')
          .invokestatic('java/util/concurrent/Executors', 'callable', '(Ljava/lang/Runnable;)Ljava/util/concurrent/Callable;')
          .invokeinterface('java/util/concurrent/Callable', 'call', '()Ljava/lang/Object;', 1).pop()
        if (shape === 'second ask') { ask(a, '2'); a.invokestatic('outside/Channels', 'install', reg) }
      }
      a.ret()
    }
  })
  add({ name: entry, annotations: [{ type: 'Lnet/neoforged/fml/common/Mod;', elements: [{ name: 'value', string: 'fixture' }] }], methods, bootstrapMethods })
  files.push({ name: 'META-INF/neoforge.mods.toml', data: Buffer.from('[[mods]]\nmodId="fixture"\nversion="1"\n') })
  return { jar: buildJar(files), sites }
}

// A subscribed method with an unconditional prefix, followed by one possible
// registration. Only its id, version or control flow changes between cases.
function registrationSignJar (shape) {
  const handlers = []
  const methods = []
  const external = (a, name, result) => a.invokestatic('outside/Values', name, '()' + result)
  const ask = (a, version) => {
    a.aload(0)
    if (typeof version === 'function') version(a)
    else a.ldcStr(version)
    return a.invokevirtual(event, 'registrar', '(' + string + ')L' + registrar + ';')
  }
  const read = { name: 'read', desc: listener, annotations: [{ type: 'Lnet/neoforged/bus/api/SubscribeEvent;' }], handlers, code (a) {
    emit(ask(a, '1'), 'base')
    if (shape === 'guarded registration' || shape === 'switched registration') {
      external(a, 'mode', 'I')
      const at = a.pc
      if (shape === 'guarded registration') a.ifeq(0)
      else {
        a.raw([0xab])
        while (a.pc % 4) a.raw([0])
        const after = a.pc + 16 - at
        a.raw([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, after])
      }
      emit(ask(a, '2'), 'late')
      const delta = a.pc - at
      const offset = shape === 'guarded registration' ? at + 2 : ((at + 4) & ~3) + 3
      a.bytes[offset] = delta
    } else if (shape === 'catch local') {
      a.ldcStr('before').astore(1)
      const start = a.pc
      external(a, 'log', 'V')
      const end = a.pc
      a.goto_(7)
      handlers.push({ start, end, target: a.pc, type: 'java/lang/Exception' })
      a.pop().ldcStr('caught').astore(1)
      emit(ask(a, '1'), a => a.aload(1))
    } else if (shape === 'catch' || shape === 'unrelated catch') {
      const start = a.pc
      external(a, 'log', 'V')
      const end = a.pc
      const jump = a.pc
      a.goto_(0)
      handlers.push({ start, end, target: a.pc, type: 'java/lang/Exception' })
      a.pop()
      if (shape === 'catch') emit(ask(a, '1'), 'fallback')
      else external(a, 'warn', 'V')
      const delta = a.pc - jump
      a.bytes.splice(jump + 1, 2, delta >> 8, delta & 255)
      if (shape === 'unrelated catch') emit(ask(a, '1'), 'late')
    } else if (shape === 'erased call') {
      emit(ask(a, a => external(a, 'value', 'Ljava/lang/Object;').checkcast('java/lang/String')), 'late')
    } else if (shape === 'call registrar') {
      emit(external(a, 'registrar', 'L' + registrar + ';'), 'late')
    } else if (shape === 'call id') {
      emit(ask(a, '1'), a => external(a, 'id', string))
    } else if (shape === 'call version') {
      emit(ask(a, a => external(a, 'version', string)), 'late')
    } else if (shape === 'unused call') {
      external(a, 'version', string).pop()
      emit(ask(a, '1'), 'late')
    } else if (shape === 'text' || shape === 'bad text') {
      emit(ask(a, 'text000'), 'late')
    } else {
      emit(ask(a, a => a.invokestatic(entry, 'version', '()' + string)), 'late')
    }
    a.ret()
  } }
  methods.push(read)
  if (['branch', 'switch', 'decided'].includes(shape)) {
    methods.push({ name: 'version', desc: '()' + string, code (a) {
      if (shape === 'decided') a.raw([0x04])
      else external(a, 'mode', 'I')
      if (shape === 'switch') {
        // lookupswitch with one key. Both destinations return a version.
        const start = a.pc
        a.raw([0xab])
        while (a.pc % 4) a.raw([0])
        const first = a.pc + 16 - start
        a.raw([0, 0, 0, first + 3, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, first])
      } else a.ifeq(6)
      a.ldcStr('A').areturn().ldcStr('B').areturn()
    } })
  }
  const data = buildClass({ name: entry, annotations: [{ type: 'Lnet/neoforged/fml/common/EventBusSubscriber;' }], methods })
  if (shape === 'text' || shape === 'bad text') {
    // Seven class-file bytes: "1" and two UTF-16 surrogate code units.
    Buffer.from(shape === 'text' ? '31eda0bdedb880' : '31ff6162636465', 'hex').copy(data, data.indexOf('text000'))
  }
  return buildJar([{ name: entry + '.class', data }])
}

module.exports = { dispatchJar, registrationSignJar }
