/* eslint-env mocha */
// PRIVACY LAWS AS CODE (owner-ratified design laws for the jar-derivation path).
// These are executable assertions, not documentation: a change that makes the
// analyzer phone home, classload/execute mod code, or reach beyond
// network-registration signatures fails this suite.
//
//   LAW 1  LOCAL-ONLY   - the derivation performs ZERO network I/O. Proven by
//                         arming every Node network primitive to throw, then
//                         running a full derivation: it must still succeed.
//   LAW 2  READ-ONLY,   - static bytecode parsing only. Proven by source
//          JARS-ONLY      audit: no child_process/exec/eval/vm/Module load
//                         APIs anywhere in the derivation modules, and no
//                         filesystem WRITES (only read/stat/readdir).
//   LAW 3  PURPOSE-      - the analyzer depends on nothing but fs/path/zlib/
//          LIMITED        debug; it cannot import a backend/telemetry client.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('net')
const tls = require('tls')
const http = require('http')
const https = require('https')
const dgram = require('dgram')

const { buildClass, buildJar } = require('./helpers/synthJar')

const MODULES = ['jarAnalysis.js', 'loginAckDerivation.js', 'forgeHandshake3.js',
  'neoForgePayloadDerivation.js', 'neoForgeConfig.js', 'blockShapeDerivation.js',
  'loginReplyBoundary.js', 'annotationRegistryDerivation.js', 'listenOnlyDerivation.js',
  // D3: the loader custom-spawn codec derivation + decoder (local loader jar only)
  'loaderSpawnDerivation.js', 'loaderSpawnDecoder.js', 'neoForgeLoaderLocator.js']
const SRC = path.join(__dirname, '..', 'src', 'client')

// build a synthetic mod that DOES derive, so the network-spy test exercises
// the real read+parse+bytecode-walk path end to end
function synthDerivableJar () {
  const RL = 'net/minecraft/resources/ResourceLocation'
  const SC = 'net/minecraftforge/network/simple/SimpleChannel'
  const MB = 'net/minecraftforge/network/simple/SimpleChannel$MessageBuilder'
  const AI = 'java/util/concurrent/atomic/AtomicInteger'
  const NR = 'net/minecraftforge/network/NetworkRegistry'
  const FBB = 'net/minecraft/network/FriendlyByteBuf'
  const owner = 'synth/priv/Net'
  const ack = 'synth/priv/Ack'
  const net_ = buildClass({
    name: owner,
    methods: [
      {
        name: '<clinit>',
        desc: '()V',
        flags: 0x0008,
        code: (a) => a
          .new_(RL).dup().ldcStr('priv').ldcStr('handshake')
          .invokespecial(RL, '<init>', '(Ljava/lang/String;Ljava/lang/String;)V')
          .invokestatic(NR, 'newSimpleChannel', `(L${RL};)L${SC};`)
          .putstatic(owner, 'CHANNEL', `L${SC};`)
          .new_(AI).dup().iconst(1).invokespecial(AI, '<init>', '(I)V')
          .putstatic(owner, 'COUNT', `L${AI};`).ret()
      },
      {
        name: 'init',
        desc: '()V',
        code: (a) => a
          .getstatic(owner, 'CHANNEL', `L${SC};`).ldcCls(ack)
          .getstatic(owner, 'COUNT', `L${AI};`).invokevirtual(AI, 'getAndIncrement', '()I')
          .invokevirtual(SC, 'messageBuilder', `(Ljava/lang/Class;I)L${MB};`)
          .invokevirtual(MB, 'loginIndex', `(Ljava/util/function/Function;Ljava/util/function/BiConsumer;)L${MB};`)
          .invokevirtual(MB, 'add', '()V').ret()
      }
    ]
  })
  const ackCls = buildClass({ name: ack, methods: [{ name: 'encode', desc: `(L${ack};L${FBB};)V`, code: (a) => a.ret() }] })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'privlaw-'))
  fs.writeFileSync(path.join(dir, 'priv.jar'), buildJar([
    { name: `${owner}.class`, data: net_ },
    { name: `${ack}.class`, data: ackCls }
  ]))
  return dir
}

// minimal shape-derivable mod jar (DeferredRegister + noCollission plant),
// so the block-shape derivation's full read+parse+walk path runs under the
// armed spies too
function synthShapeJar () {
  const DR = 'net/minecraftforge/registries/DeferredRegister'
  const RO = 'net/minecraftforge/registries/RegistryObject'
  const PROPS = 'net/minecraft/world/level/block/state/BlockBehaviour$Properties'
  const BLOCK = 'net/minecraft/world/level/block/Block'
  const owner = 'privsynth/ShapeBlocks'
  const reg = buildClass({
    name: owner,
    bootstrapMethods: [{ refKind: 6, owner, name: 'lambda$static$0', desc: `()L${BLOCK};` }],
    methods: [
      {
        name: '<clinit>',
        desc: '()V',
        flags: 0x0008,
        code: (a) => a
          .ldcStr('privshapes')
          .invokestatic(DR, 'create', `(Ljava/lang/String;)L${DR};`)
          .putstatic(owner, 'BLOCKS', `L${DR};`)
          .getstatic(owner, 'BLOCKS', `L${DR};`)
          .ldcStr('ghost_plant')
          .invokedynamic(0, 'get', '()Ljava/util/function/Supplier;')
          .invokevirtual(DR, 'register', `(Ljava/lang/String;Ljava/util/function/Supplier;)L${RO};`)
          .pop().ret()
      },
      {
        name: 'lambda$static$0',
        desc: `()L${BLOCK};`,
        flags: 0x000a,
        code: (a) => a
          .new_('privsynth/GhostPlant').dup()
          .invokestatic(PROPS, 'm_284310_', `()L${PROPS};`)
          .invokevirtual(PROPS, 'm_60910_', `()L${PROPS};`)
          .invokespecial('privsynth/GhostPlant', '<init>', `(L${PROPS};)V`)
          .areturn()
      }
    ]
  })
  const plant = buildClass({
    name: 'privsynth/GhostPlant',
    superName: 'net/minecraft/world/level/block/FlowerBlock',
    methods: [{ name: '<init>', desc: `(L${PROPS};)V`, flags: 0x0001, code: (a) => a.ret() }]
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'privlaw-shapes-'))
  const jar = path.join(dir, 'privshapes.jar')
  fs.writeFileSync(jar, buildJar([
    { name: 'privsynth/ShapeBlocks.class', data: reg },
    { name: 'privsynth/GhostPlant.class', data: plant }
  ]))
  return jar
}

describe('PRIVACY LAW 1 - local-only (no network I/O)', function () {
  it('a full derivation makes ZERO network calls', () => {
    const calls = []
    const patched = []
    const arm = (obj, name) => {
      const orig = obj[name]
      if (typeof orig !== 'function') return
      obj[name] = function (...args) { calls.push(`${name}`); throw new Error(`network call blocked: ${name}`) }
      patched.push(() => { obj[name] = orig })
    }
    // every primitive a covert exfiltration could use
    arm(net, 'connect'); arm(net, 'createConnection'); arm(net.Socket.prototype, 'connect')
    arm(tls, 'connect')
    arm(http, 'request'); arm(http, 'get')
    arm(https, 'request'); arm(https, 'get')
    arm(dgram, 'createSocket')
    const origFetch = global.fetch
    global.fetch = () => { calls.push('fetch'); throw new Error('network call blocked: fetch') }

    try {
      // fresh module instance so the derive-cache does not short-circuit
      const modPath = require.resolve('../src/client/loginAckDerivation')
      delete require.cache[modPath]
      const { deriveLoginAck } = require('../src/client/loginAckDerivation')
      const dir = synthDerivableJar()
      const r = deriveLoginAck('priv:handshake', [dir])
      assert.ok(r, 'derivation must succeed with network armed to throw')
      assert.strictEqual(r.index, 1)
    } finally {
      for (const undo of patched) undo()
      global.fetch = origFetch
    }
    assert.deepStrictEqual(calls, [], `no network primitive may be invoked, saw: ${calls.join(', ')}`)
  })

  it('a full block-shape derivation makes ZERO network calls', () => {
    const jar = synthShapeJar()
    const calls = []
    const patched = []
    const arm = (obj, name) => {
      const orig = obj[name]
      if (typeof orig !== 'function') return
      obj[name] = function (...args) { calls.push(`${name}`); throw new Error(`network call blocked: ${name}`) }
      patched.push(() => { obj[name] = orig })
    }
    arm(net, 'connect'); arm(net, 'createConnection'); arm(net.Socket.prototype, 'connect')
    arm(tls, 'connect'); arm(http, 'request'); arm(http, 'get')
    arm(https, 'request'); arm(https, 'get'); arm(dgram, 'createSocket')
    const origFetch = global.fetch
    global.fetch = (...a) => { calls.push('fetch'); throw new Error('network call blocked: fetch') }
    try {
      const { deriveBlockShapes } = require('../src/client/blockShapeDerivation')
      const r = deriveBlockShapes([jar])
      assert.strictEqual(r.blocks.get('privshapes:ghost_plant').shape, 'nonsolid',
        'derivation must fully succeed with network armed to throw')
    } finally {
      for (const undo of patched) undo()
      global.fetch = origFetch
    }
    assert.deepStrictEqual(calls, [], `no network primitive may be invoked, saw: ${calls.join(', ')}`)
  })

  it('Registrate + consumer-helper derivations (real Create/BOP jars) run with network AND fs-writes armed', function () {
    // the framework-linkage code paths (registrate builder chains, BiConsumer
    // sink helpers, dynamic-body factor counting) must obey the same laws as
    // the direct idioms - exercised on the real jars when present
    const LANE = '/Users/leoli/minepal-coop/modded-block-shapes/registrate/jars'
    const jars = [`${LANE}/create-1.20.1-6.0.8.jar`, `${LANE}/BiomesOPlenty-forge-1.20.1-19.0.0.96.jar`]
    if (!jars.every((j) => fs.existsSync(j))) return this.skip()
    const calls = []
    const patched = []
    const arm = (obj, name) => {
      const orig = obj[name]
      if (typeof orig !== 'function') return
      obj[name] = function (...args) { calls.push(`${name}`); throw new Error(`blocked: ${name}`) }
      patched.push(() => { obj[name] = orig })
    }
    arm(net, 'connect'); arm(net, 'createConnection'); arm(net.Socket.prototype, 'connect')
    arm(tls, 'connect'); arm(http, 'request'); arm(http, 'get')
    arm(https, 'request'); arm(https, 'get'); arm(dgram, 'createSocket')
    const writeApis = ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'mkdir', 'mkdirSync', 'rename', 'renameSync', 'unlink', 'unlinkSync', 'rm', 'rmSync', 'copyFile', 'copyFileSync']
    for (const name of writeApis) arm(fs, name)
    const origFetch = global.fetch
    global.fetch = (...a) => { calls.push('fetch'); throw new Error('blocked: fetch') }
    try {
      const { deriveBlockShapes } = require('../src/client/blockShapeDerivation')
      const r = deriveBlockShapes(jars)
      assert.ok(r.blocks.size >= 600, `both frameworks must derive under armed laws (got ${r.blocks.size})`)
      assert.strictEqual(r.blocks.get('biomesoplenty:barnacles').stateCount, 128, 'factor counting works under armed laws')
    } finally {
      for (const undo of patched) undo()
      global.fetch = origFetch
    }
    assert.deepStrictEqual(calls, [], `no network/write primitive may be invoked, saw: ${calls.join(', ')}`)
  })
})

describe('PRIVACY LAW 2 - read-only, jars-only (parse, never execute)', function () {
  const forbidden = [
    { re: /require\(\s*['"]child_process['"]\s*\)/, why: 'child_process (would execute code)' },
    { re: /\bexec(Sync|File|FileSync)?\s*\(/, why: 'exec* (process execution)' },
    { re: /\bspawn(Sync)?\s*\(/, why: 'spawn* (process execution)' },
    { re: /\beval\s*\(/, why: 'eval (dynamic code execution)' },
    { re: /new\s+Function\s*\(/, why: 'new Function (dynamic code execution)' },
    { re: /require\(\s*['"]vm['"]\s*\)/, why: 'vm (sandboxed execution is still execution)' },
    { re: /createRequire|Module\._(load|compile)/, why: 'module loading of scanned code' }
  ]
  for (const mod of MODULES) {
    it(`${mod} contains no classloading/execution API`, () => {
      const src = fs.readFileSync(path.join(SRC, mod), 'utf8')
      // strip line and block comments so prose ("never executed") does not trip the audit
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
      for (const f of forbidden) assert.ok(!f.re.test(code), `${mod} must not use ${f.why}`)
    })
  }

  it('the derivation writes NOTHING to disk (fs write APIs never called)', () => {
    // build the fixture jar BEFORE arming the write spies (the analyzer is
    // what must not write; the test fixture legitimately does)
    const dir = synthDerivableJar()
    const writeApis = ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'mkdir', 'mkdirSync', 'rename', 'renameSync', 'unlink', 'unlinkSync', 'rmdir', 'rmdirSync', 'rm', 'rmSync', 'copyFile', 'copyFileSync', 'writev']
    const calls = []
    const undo = []
    for (const name of writeApis) {
      if (typeof fs[name] !== 'function') continue
      const orig = fs[name]
      fs[name] = function (...a) { calls.push(name); throw new Error(`fs write blocked: ${name}`) }
      undo.push(() => { fs[name] = orig })
    }
    try {
      const modPath = require.resolve('../src/client/loginAckDerivation')
      delete require.cache[modPath]
      const { deriveLoginAck } = require('../src/client/loginAckDerivation')
      const r = deriveLoginAck('priv:handshake', [dir])
      assert.ok(r)
    } finally {
      for (const u of undo) u()
    }
    assert.deepStrictEqual(calls, [], `derivation must not write to disk, saw: ${calls.join(', ')}`)
  })

  it('the block-shape derivation writes NOTHING to disk', () => {
    const jar = synthShapeJar()
    const writeApis = ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'mkdir', 'mkdirSync', 'rename', 'renameSync', 'unlink', 'unlinkSync', 'rmdir', 'rmdirSync', 'rm', 'rmSync', 'copyFile', 'copyFileSync', 'writev']
    const calls = []
    const undo = []
    for (const name of writeApis) {
      if (typeof fs[name] !== 'function') continue
      const orig = fs[name]
      fs[name] = function (...a) { calls.push(name); throw new Error(`fs write blocked: ${name}`) }
      undo.push(() => { fs[name] = orig })
    }
    try {
      const { deriveBlockShapes } = require('../src/client/blockShapeDerivation')
      const r = deriveBlockShapes([jar])
      assert.strictEqual(r.blocks.size, 1)
    } finally {
      for (const u of undo) u()
    }
    assert.deepStrictEqual(calls, [], `derivation must not write to disk, saw: ${calls.join(', ')}`)
  })
})

describe('PRIVACY LAW 3 - purpose-limited (no backend/telemetry deps)', function () {
  for (const mod of MODULES.concat(['jarAnalysis.js'])) {
    it(`${mod} imports only local parsing deps`, () => {
      const src = fs.readFileSync(path.join(SRC, mod), 'utf8')
      const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
      // HF12: loginReplyBoundary is a pure local write-boundary mechanism
      // (no requires at all) — same purpose-limited class as the parsers
      // HF9 (fixed forward at HF11 landing): annotationRegistryDerivation is a
      // pure local bytecode-walk parser, same purpose-limited class — audited
      // by these laws itself via MODULES above
      // HF15 (fixed forward at landing): listenOnlyDerivation is a pure local
      // bytecode-walk parser (requires only ../../debug + ./jarAnalysis) —
      // audited by these laws itself via MODULES above
      const allowed = new Set(['fs', 'path', 'zlib', 'debug', '../../debug', './jarAnalysis', './loginAckDerivation',
        './loginReplyBoundary', './annotationRegistryDerivation', './listenOnlyDerivation', './data/blockShapeTables.json',
        // D3: loader-spawn codec derivation (jar bytes → codec spec) + its decoder + the loader-jar locator (local fs walk)
        './loaderSpawnDerivation', './loaderSpawnDecoder', './neoForgeLoaderLocator'])
      for (const r of requires) {
        assert.ok(allowed.has(r), `${mod} requires '${r}', which is not an allowed local-parsing dependency`)
      }
    })
  }
})
