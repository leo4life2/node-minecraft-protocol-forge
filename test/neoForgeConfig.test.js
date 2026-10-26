/* eslint-env mocha */
// NeoForge 1.20.5+ config-phase negotiation: wire codecs + derivation rules.
// The byte layouts assert against the decompiled 21.1.248 STREAM_CODECs
// (see neoForgeConfig.js header). The derivation ground-truth leg is
// env-gated on the modknowledge rig corpus (MODKNOW_NEOFORGE_MODS +
// MODKNOW_NEOFORGE_JAR) — the tuples it asserts are the exact ones a live
// 21.1.248 negotiator ACCEPTED on 2026-08-06 (3/3 product joins).
const assert = require('assert')
const {
  encodeNetworkQuery,
  decodeNetworkSetup,
  decodeFrozenStart,
  decodeFrozenRegistry,
  decodeKnownDataMaps,
  encodeKnownDataMapsReply,
  writeVarInt,
  writeString
} = require('../src/client/neoForgeConfig')
const { deriveNeoForgeComponents } = require('../src/client/neoForgePayloadDerivation')

describe('neoforge:register reply encoding (ModdedNetworkQueryPayload)', function () {
  it('empty component sets encode as the empty map (the server sends exactly 0x00)', () => {
    assert.deepStrictEqual(encodeNetworkQuery({ configuration: [], play: [] }), Buffer.from([0]))
  })

  it('components carry id, version, optional flow ordinal and optional flag', () => {
    const buf = encodeNetworkQuery({
      configuration: [{ id: 'mekanism:batch_security', version: '10.7.19', flow: 'clientbound', optional: false }],
      play: []
    })
    const expected = Buffer.concat([
      writeVarInt(1), // one protocol map entry
      writeVarInt(4), // ConnectionProtocol.CONFIGURATION ordinal
      writeVarInt(1), // one component
      writeString('mekanism:batch_security'),
      writeString('10.7.19'),
      Buffer.from([1]), writeVarInt(1), // Optional.of(CLIENTBOUND=1)
      Buffer.from([0]) // optional=false
    ])
    assert.deepStrictEqual(buf, expected)
  })

  it('bidirectional components encode flow as Optional.empty', () => {
    const buf = encodeNetworkQuery({
      configuration: [{ id: 'neoforge:frozen_registry_sync_completed', version: '1', flow: null, optional: true }],
      play: []
    })
    const expected = Buffer.concat([
      writeVarInt(1), writeVarInt(4), writeVarInt(1),
      writeString('neoforge:frozen_registry_sync_completed'),
      writeString('1'),
      Buffer.from([0]), // Optional.empty
      Buffer.from([1]) // optional=true
    ])
    assert.deepStrictEqual(buf, expected)
  })
})

describe('clientbound payload decoding', function () {
  it('NetworkPayloadSetup: per-protocol negotiated channel maps', () => {
    const buf = Buffer.concat([
      writeVarInt(1), writeVarInt(1), // PLAY
      writeVarInt(1),
      writeString('create:knockback'), // map key
      writeString('create:knockback'), // NetworkChannel.id
      writeString('6.0.10') // NetworkChannel.version
    ])
    const setup = decodeNetworkSetup(buf)
    assert.deepStrictEqual(setup, { play: { 'create:knockback': { id: 'create:knockback', version: '6.0.10' } } })
  })

  it('FrozenRegistrySyncStartPayload: registry name list', () => {
    const buf = Buffer.concat([writeVarInt(2), writeString('minecraft:item'), writeString('minecraft:block')])
    assert.deepStrictEqual(decodeFrozenStart(buf), ['minecraft:item', 'minecraft:block'])
  })

  it('FrozenRegistryPayload: RegistrySnapshot id + alias maps', () => {
    const buf = Buffer.concat([
      writeString('minecraft:item'),
      writeVarInt(2),
      writeVarInt(0), writeString('minecraft:air'),
      writeVarInt(2721), writeString('mekanism:jetpack'),
      writeVarInt(1),
      writeString('mekanism:old_name'), writeString('mekanism:jetpack')
    ])
    const reg = decodeFrozenRegistry(buf)
    assert.strictEqual(reg.name, 'minecraft:item')
    assert.strictEqual(reg.ids.get(2721), 'mekanism:jetpack')
    assert.strictEqual(reg.ids.get(0), 'minecraft:air')
    assert.strictEqual(reg.aliases.get('mekanism:old_name'), 'mekanism:jetpack')
  })

  it('KnownRegistryDataMapsPayload round-trips into the reply the server expects', () => {
    const buf = Buffer.concat([
      writeVarInt(1),
      writeString('minecraft:item'),
      writeVarInt(2),
      writeString('neoforge:oil'), Buffer.from([1]),
      writeString('mekanism:mek_data'), Buffer.from([0])
    ])
    const maps = decodeKnownDataMaps(buf)
    assert.deepStrictEqual(maps, [{
      registry: 'minecraft:item',
      entries: [{ id: 'neoforge:oil', mandatory: true }, { id: 'mekanism:mek_data', mandatory: false }]
    }])
    const reply = encodeKnownDataMapsReply(maps)
    assert.deepStrictEqual(reply, Buffer.concat([
      writeVarInt(1), writeString('minecraft:item'),
      writeVarInt(2), writeString('neoforge:oil'), writeString('mekanism:mek_data')
    ]))
  })
})

// GROUND TRUTH (env-gated): the rig corpus jars must derive the exact tuples
// the live 21.1.248 negotiator accepted. Enable with:
//   MODKNOW_NEOFORGE_MODS=/private/tmp/modknowledge-rigs/neoforge/mods \
//   MODKNOW_NEOFORGE_JAR=.../neoforge-21.1.248-universal.jar npx mocha test/neoForgeConfig.test.js
describe('derivation ground truth (rig corpus, env-gated)', function () {
  const modsDir = process.env.MODKNOW_NEOFORGE_MODS
  const loaderJar = process.env.MODKNOW_NEOFORGE_JAR
  const enabled = modsDir && require('fs').existsSync(modsDir)
  ;(enabled ? it : it.skip)('reproduces the live-accepted component tuples', function () {
    this.timeout(30000)
    const fs = require('fs')
    const path = require('path')
    const jars = fs.readdirSync(modsDir).filter((f) => f.endsWith('.jar')).map((f) => path.join(modsDir, f))
    if (loaderJar) jars.push(loaderJar)
    const { components } = deriveNeoForgeComponents(jars)
    const play = new Map(components.play.map((c) => [c.id, c]))
    const cfg = new Map(components.configuration.map((c) => [c.id, c]))
    // registrar(modVersion) idiom via wrapper dispatch (Mekanism)
    assert.deepStrictEqual(
      { version: cfg.get('mekanism:batch_security').version, flow: cfg.get('mekanism:batch_security').flow },
      { version: '10.7.19', flow: 'clientbound' })
    assert.strictEqual(play.get('mekanism:qio_take').flow, 'serverbound')
    // enum-registry shape with a static String field version (Create/catnip)
    assert.deepStrictEqual(
      { version: play.get('create:knockback').version, flow: play.get('create:knockback').flow },
      { version: '6.0.10', flow: 'clientbound' })
    assert.strictEqual(play.get('create:c_configure_train').flow, 'serverbound')
    // enum-registry with int version (Ponder/catnip)
    assert.deepStrictEqual(
      { version: play.get('ponder:clientbound_config').version, flow: play.get('ponder:clientbound_config').flow },
      { version: '1', flow: 'clientbound' })
    // direct shape (FarmersDelight)
    assert.deepStrictEqual(
      { version: play.get('farmersdelight:flip_skillet').version, flow: play.get('farmersdelight:flip_skillet').flow },
      { version: '1', flow: 'serverbound' })
    // optional channels with runtime versions ABSTAIN instead of guessing (JEI)
    assert.strictEqual(play.get('jei:give_item_stack'), undefined)
    if (loaderJar) {
      // NeoForge built-ins: registrar("1").optional() in NetworkInitialization
      assert.deepStrictEqual(
        { version: cfg.get('neoforge:frozen_registry').version, optional: cfg.get('neoforge:frozen_registry').optional },
        { version: '1', optional: true })
      assert.strictEqual(cfg.get('neoforge:frozen_registry_sync_completed').flow, null)
    }
  })
})

// CTOR-BODY shape (HF-R2, deterministic synthetic jars): a mod that receives
// the registrar as a CONSTRUCTOR argument and registers its channels directly
// inside the <init> body (new Networking(event.registrar("3")) with
// registrar.playToClient(...) in the ctor). Same silent-miss family as the
// landed HELPER shape: before the ctor-body dispatch, handleInvoke returned
// at <init> before the helper dispatch, so this shape derived ZERO channels
// with ZERO abstains — invisible to the honesty layer. Also pins that the
// cycle guard terminates a self-recursive ctor and still lands its
// registration.
describe('derivation CTOR-BODY shape (synthetic jars, deterministic)', function () {
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const { buildClass, buildJar } = require('./helpers/synthJar')

  const EVENT = 'net/neoforged/neoforge/network/event/RegisterPayloadHandlersEvent'
  const REG = 'net/neoforged/neoforge/network/registration/PayloadRegistrar'
  const TYPE = 'net/minecraft/network/protocol/common/custom/CustomPacketPayload$Type'
  const RL = 'net/minecraft/resources/ResourceLocation'

  function payloadClass (name, ns, pathStr) {
    // <clinit>: TYPE = new Type(ResourceLocation.fromNamespaceAndPath(ns, path))
    return buildClass({
      name,
      methods: [{
        name: '<clinit>',
        desc: '()V',
        flags: 0x0008,
        code: (a) => a
          .new_(TYPE).dup()
          .ldcStr(ns).ldcStr(pathStr)
          .invokestatic(RL, 'fromNamespaceAndPath', `(Ljava/lang/String;Ljava/lang/String;)L${RL};`)
          .invokespecial(TYPE, '<init>', `(L${RL};)V`)
          .putstatic(name, 'TYPE', `L${TYPE};`)
          .ret()
      }]
    })
  }

  function register (a, regMethod, payloadOwner) {
    // registrar on stack top expected as local 1: aload(1) done by caller
    return a
      .getstatic(payloadOwner, 'TYPE', `L${TYPE};`)
      .iconst(0).iconst(0) // codec + handler placeholders
      .invokevirtual(REG, regMethod, `(L${TYPE};Ljava/lang/Object;Ljava/lang/Object;)L${REG};`)
      .pop()
  }

  function synthCtorMod () {
    const entry = 'synth/ctor/ModInit'
    const net = 'synth/ctor/Networking'
    const rec = 'synth/ctor/RecNet'
    const ping = 'synth/ctor/PingPacket'
    const state = 'synth/ctor/StatePacket'
    const recp = 'synth/ctor/RecPacket'
    const entryCls = buildClass({
      name: entry,
      methods: [{
        name: 'onRegister',
        desc: `(L${EVENT};)V`,
        flags: 0x0009,
        code: (a) => a
          // new Networking(event.registrar("3"))
          .new_(net).dup()
          .aload(0).ldcStr('3')
          .invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`)
          .invokespecial(net, '<init>', `(L${REG};)V`)
          .pop()
          // new RecNet(event.registrar("7")) — self-recursive ctor
          .new_(rec).dup()
          .aload(0).ldcStr('7')
          .invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`)
          .invokespecial(rec, '<init>', `(L${REG};)V`)
          .pop()
          .ret()
      }]
    })
    const netCls = buildClass({
      name: net,
      methods: [{
        name: '<init>',
        desc: `(L${REG};)V`,
        flags: 0x0001,
        code: (a) => {
          a.aload(1)
          register(a, 'playToClient', ping)
          a.aload(1)
          register(a, 'configurationToClient', state)
          return a.ret()
        }
      }]
    })
    const recCls = buildClass({
      name: rec,
      methods: [{
        name: '<init>',
        desc: `(L${REG};)V`,
        flags: 0x0001,
        code: (a) => {
          // pathological self-recursion: new RecNet(registrar) inside own ctor
          a.new_(rec).dup().aload(1)
            .invokespecial(rec, '<init>', `(L${REG};)V`)
            .pop()
          a.aload(1)
          register(a, 'playToServer', recp)
          return a.ret()
        }
      }]
    })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthjar-ctorbody-'))
    const jar = path.join(dir, 'ctorbody.jar')
    fs.writeFileSync(jar, buildJar([
      { name: `${entry}.class`, data: entryCls },
      { name: `${net}.class`, data: netCls },
      { name: `${rec}.class`, data: recCls },
      { name: `${ping}.class`, data: payloadClass(ping, 'synthctor', 'ping') },
      { name: `${state}.class`, data: payloadClass(state, 'synthctor', 'state') },
      { name: `${recp}.class`, data: payloadClass(recp, 'synthctor', 'rec') }
    ]))
    return jar
  }

  it('derives channels registered inside a constructor body that received the registrar', () => {
    const jar = synthCtorMod()
    const { components, diagnostics } = deriveNeoForgeComponents([jar])
    assert.strictEqual(diagnostics.abstains.length, 0, `no abstains expected, got: ${diagnostics.abstains.join(' | ')}`)
    const play = new Map(components.play.map((c) => [c.id, c]))
    const cfg = new Map(components.configuration.map((c) => [c.id, c]))
    const ping = play.get('synthctor:ping')
    assert.ok(ping, 'ctor-body playToClient registration must be derived')
    assert.deepStrictEqual(
      { version: ping.version, flow: ping.flow, optional: ping.optional, versionSource: ping.versionSource },
      { version: '3', flow: 'clientbound', optional: false, versionSource: 'constant' })
    const state = cfg.get('synthctor:state')
    assert.ok(state, 'ctor-body configurationToClient registration must be derived')
    assert.deepStrictEqual({ version: state.version, flow: state.flow }, { version: '3', flow: 'clientbound' })
  })

  it('cycle guard terminates a self-recursive ctor and still lands its registration', () => {
    const jar = synthCtorMod()
    const { components } = deriveNeoForgeComponents([jar])
    const rec = components.play.find((c) => c.id === 'synthctor:rec')
    assert.ok(rec, 'self-recursive ctor registration must still be derived (guard skips only the re-entry)')
    assert.deepStrictEqual({ version: rec.version, flow: rec.flow }, { version: '7', flow: 'serverbound' })
  })
})

// CATEGORY-2 argument modeling (HF-R3, deterministic synthetic jars): a long
// or double argument occupies TWO JVM local slots, so a registrar positioned
// AFTER a J/D arg in the descriptor sits at a HIGHER slot than its argument
// index. Before HF-R3 the helper/ctor dispatches seeded callee locals PACKED
// (one slot per arg), so the callee's aload read one slot low and the
// registration silently missed with ZERO abstains (verifier probe P8; P8c
// proved the identical miss on the pre-R3 baseline through the landed
// static-helper shape). Also pins that wide const/load opcodes
// (lconst/dconst/lload_n/dload_n) inside a registration body model as ONE
// abstract push (matching ldc2_w) so the abstract stack stays coherent.
describe('derivation category-2 (long/double) argument modeling (HF-R3, synthetic jars)', function () {
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const { buildClass, buildJar } = require('./helpers/synthJar')

  const EVENT = 'net/neoforged/neoforge/network/event/RegisterPayloadHandlersEvent'
  const REG = 'net/neoforged/neoforge/network/registration/PayloadRegistrar'
  const TYPE = 'net/minecraft/network/protocol/common/custom/CustomPacketPayload$Type'
  const RL = 'net/minecraft/resources/ResourceLocation'

  function payloadClass (name, ns, pathStr) {
    return buildClass({
      name,
      methods: [{
        name: '<clinit>',
        desc: '()V',
        flags: 0x0008,
        code: (a) => a
          .new_(TYPE).dup()
          .ldcStr(ns).ldcStr(pathStr)
          .invokestatic(RL, 'fromNamespaceAndPath', `(Ljava/lang/String;Ljava/lang/String;)L${RL};`)
          .invokespecial(TYPE, '<init>', `(L${RL};)V`)
          .putstatic(name, 'TYPE', `L${TYPE};`)
          .ret()
      }]
    })
  }

  function synthCat2Mod () {
    const entry = 'synth/cat2/ModInit'
    const helpers = 'synth/cat2/Helpers'
    const lnet = 'synth/cat2/LNet'
    const dnet = 'synth/cat2/DNet'
    const pPing = 'synth/cat2/PingPacket' // helper AFTER long
    const pPong = 'synth/cat2/PongPacket' // helper AFTER double
    const pWideJ = 'synth/cat2/WideJPacket' // lconst coherence
    const pWideD = 'synth/cat2/WideDPacket' // dconst coherence
    const pLNet = 'synth/cat2/LNetPacket' // ctor AFTER long
    const pDNet = 'synth/cat2/DNetPacket' // ctor AFTER double
    // an "eat" owner deliberately ABSENT from the jar: consumes exactly its
    // descriptor's argument count and returns nothing derivable
    const EAT = 'synth/cat2/Eat'

    const entryCls = buildClass({
      name: entry,
      methods: [{
        name: 'onRegister',
        desc: `(L${EVENT};)V`,
        flags: 0x0009,
        code: (a) => a
          // reg = event.registrar("11")
          .aload(0).ldcStr('11')
          .invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`)
          .astore(1)
          // HELPER, registrar AFTER a long: clientboundL(1L, reg, PING.TYPE)
          // (ldc2_w call site — already one abstract push on the landed tree,
          // so the RED here isolates the callee LOCALS seeding)
          .ldc2Long(1)
          .aload(1)
          .getstatic(pPing, 'TYPE', `L${TYPE};`)
          .invokestatic(helpers, 'clientboundL', `(JL${REG};L${TYPE};)V`)
          // HELPER, registrar AFTER a double: serverboundD(2.5, reg, PONG.TYPE)
          .ldc2Double(2.5)
          .aload(1)
          .getstatic(pPong, 'TYPE', `L${TYPE};`)
          .invokestatic(helpers, 'serverboundD', `(DL${REG};L${TYPE};)V`)
          // WIDE-CONST coherence: registrar at slot 0, lconst/dconst inline
          .aload(1)
          .getstatic(pWideJ, 'TYPE', `L${TYPE};`)
          .invokestatic(helpers, 'wideJ', `(L${REG};L${TYPE};)V`)
          .aload(1)
          .getstatic(pWideD, 'TYPE', `L${TYPE};`)
          .invokestatic(helpers, 'wideD', `(L${REG};L${TYPE};)V`)
          // CTOR, registrar AFTER a long: new LNet(9L, event.registrar("9"))
          .new_(lnet).dup()
          .ldc2Long(9)
          .aload(0).ldcStr('9')
          .invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`)
          .invokespecial(lnet, '<init>', `(JL${REG};)V`)
          .pop()
          // CTOR, registrar AFTER a double: new DNet(2.5, event.registrar("13"))
          .new_(dnet).dup()
          .ldc2Double(2.5)
          .aload(0).ldcStr('13')
          .invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`)
          .invokespecial(dnet, '<init>', `(DL${REG};)V`)
          .pop()
          .ret()
      }]
    })

    const helpersCls = buildClass({
      name: helpers,
      methods: [
        {
          // slots: 0-1 long, 2 registrar, 3 type — aload(2)/aload(3) are the
          // REAL javac slot numbers; packed seeding reads them one low
          name: 'clientboundL',
          desc: `(JL${REG};L${TYPE};)V`,
          flags: 0x0009,
          code: (a) => a
            .lload(0) // lload_0: the long arg, one abstract push
            .invokestatic(EAT, 'eatJ', '(J)V')
            .aload(2)
            .aload(3)
            .iconst(0).iconst(0)
            .invokevirtual(REG, 'playToClient', `(L${TYPE};Ljava/lang/Object;Ljava/lang/Object;)L${REG};`)
            .pop()
            .ret()
        },
        {
          // slots: 0-1 double, 2 registrar, 3 type
          name: 'serverboundD',
          desc: `(DL${REG};L${TYPE};)V`,
          flags: 0x0009,
          code: (a) => a
            .dload(0) // dload_0
            .invokestatic(EAT, 'eatD', '(D)V')
            .aload(2)
            .aload(3)
            .iconst(0).iconst(0)
            .invokevirtual(REG, 'playToServer', `(L${TYPE};Ljava/lang/Object;Ljava/lang/Object;)L${REG};`)
            .pop()
            .ret()
        },
        {
          // registrar at slot 0 — RED here comes ONLY from lconst_1 pushing
          // nothing: the codec-factory call then eats the TYPE below it and
          // the registrar itself becomes the factory's argument
          name: 'wideJ',
          desc: `(L${REG};L${TYPE};)V`,
          flags: 0x0009,
          code: (a) => a
            .aload(0)
            .aload(1)
            .lconst(1)
            .invokestatic(EAT, 'codecJ', '(J)Ljava/lang/Object;')
            .iconst(0)
            .invokevirtual(REG, 'configurationToClient', `(L${TYPE};Ljava/lang/Object;Ljava/lang/Object;)L${REG};`)
            .pop()
            .ret()
        },
        {
          name: 'wideD',
          desc: `(L${REG};L${TYPE};)V`,
          flags: 0x0009,
          code: (a) => a
            .aload(0)
            .aload(1)
            .dconst(1)
            .invokestatic(EAT, 'codecD', '(D)Ljava/lang/Object;')
            .iconst(0)
            .invokevirtual(REG, 'playToServer', `(L${TYPE};Ljava/lang/Object;Ljava/lang/Object;)L${REG};`)
            .pop()
            .ret()
        }
      ]
    })

    const lnetCls = buildClass({
      name: lnet,
      methods: [{
        // slots: 0 this, 1-2 long, 3 registrar
        name: '<init>',
        desc: `(JL${REG};)V`,
        flags: 0x0001,
        code: (a) => a
          .lload(1) // lload_1: the long ctor arg
          .invokestatic('synth/cat2/Eat', 'eatJ', '(J)V')
          .aload(3)
          .getstatic(pLNet, 'TYPE', `L${TYPE};`)
          .iconst(0).iconst(0)
          .invokevirtual(REG, 'playToClient', `(L${TYPE};Ljava/lang/Object;Ljava/lang/Object;)L${REG};`)
          .pop()
          .ret()
      }]
    })

    const dnetCls = buildClass({
      name: dnet,
      methods: [{
        // slots: 0 this, 1-2 double, 3 registrar
        name: '<init>',
        desc: `(DL${REG};)V`,
        flags: 0x0001,
        code: (a) => a
          .dload(1) // dload_1: the double ctor arg
          .invokestatic('synth/cat2/Eat', 'eatD', '(D)V')
          .aload(3)
          .getstatic(pDNet, 'TYPE', `L${TYPE};`)
          .iconst(0).iconst(0)
          .invokevirtual(REG, 'playToServer', `(L${TYPE};Ljava/lang/Object;Ljava/lang/Object;)L${REG};`)
          .pop()
          .ret()
      }]
    })

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthjar-cat2-'))
    const jar = path.join(dir, 'cat2.jar')
    fs.writeFileSync(jar, buildJar([
      { name: `${entry}.class`, data: entryCls },
      { name: `${helpers}.class`, data: helpersCls },
      { name: `${lnet}.class`, data: lnetCls },
      { name: `${dnet}.class`, data: dnetCls },
      { name: `${pPing}.class`, data: payloadClass(pPing, 'synthcat2', 'ping') },
      { name: `${pPong}.class`, data: payloadClass(pPong, 'synthcat2', 'pong') },
      { name: `${pWideJ}.class`, data: payloadClass(pWideJ, 'synthcat2', 'widej') },
      { name: `${pWideD}.class`, data: payloadClass(pWideD, 'synthcat2', 'wided') },
      { name: `${pLNet}.class`, data: payloadClass(pLNet, 'synthcat2', 'lnet') },
      { name: `${pDNet}.class`, data: payloadClass(pDNet, 'synthcat2', 'dnet') }
    ]))
    return jar
  }

  it('derives helper registrations whose registrar sits AFTER a long and AFTER a double arg', () => {
    const { components, diagnostics } = deriveNeoForgeComponents([synthCat2Mod()])
    assert.strictEqual(diagnostics.abstains.length, 0, `no abstains expected, got: ${diagnostics.abstains.join(' | ')}`)
    const play = new Map(components.play.map((c) => [c.id, c]))
    const ping = play.get('synthcat2:ping')
    assert.ok(ping, 'registrar AFTER long arg (helper shape) must be derived')
    assert.deepStrictEqual(
      { version: ping.version, flow: ping.flow, optional: ping.optional, versionSource: ping.versionSource },
      { version: '11', flow: 'clientbound', optional: false, versionSource: 'constant' })
    const pong = play.get('synthcat2:pong')
    assert.ok(pong, 'registrar AFTER double arg (helper shape) must be derived')
    assert.deepStrictEqual({ version: pong.version, flow: pong.flow }, { version: '11', flow: 'serverbound' })
  })

  it('derives ctor-body registrations whose registrar sits AFTER a long and AFTER a double ctor arg', () => {
    const { components, diagnostics } = deriveNeoForgeComponents([synthCat2Mod()])
    assert.strictEqual(diagnostics.abstains.length, 0, `no abstains expected, got: ${diagnostics.abstains.join(' | ')}`)
    const play = new Map(components.play.map((c) => [c.id, c]))
    const l = play.get('synthcat2:lnet')
    assert.ok(l, 'registrar AFTER long ctor arg must be derived')
    assert.deepStrictEqual({ version: l.version, flow: l.flow }, { version: '9', flow: 'clientbound' })
    const d = play.get('synthcat2:dnet')
    assert.ok(d, 'registrar AFTER double ctor arg must be derived')
    assert.deepStrictEqual({ version: d.version, flow: d.flow }, { version: '13', flow: 'serverbound' })
  })

  it('keeps the abstract stack coherent through lconst/dconst in a registration body', () => {
    const { components, diagnostics } = deriveNeoForgeComponents([synthCat2Mod()])
    assert.strictEqual(diagnostics.abstains.length, 0, `no abstains expected, got: ${diagnostics.abstains.join(' | ')}`)
    const cfg = new Map(components.configuration.map((c) => [c.id, c]))
    const play = new Map(components.play.map((c) => [c.id, c]))
    const wj = cfg.get('synthcat2:widej')
    assert.ok(wj, 'registration after an inline lconst_1 codec argument must be derived')
    assert.deepStrictEqual({ version: wj.version, flow: wj.flow }, { version: '11', flow: 'clientbound' })
    const wd = play.get('synthcat2:wided')
    assert.ok(wd, 'registration after an inline dconst_1 codec argument must be derived')
    assert.deepStrictEqual({ version: wd.version, flow: wd.flow }, { version: '11', flow: 'serverbound' })
  })

  it('derives all six category-2 channels with zero abstains (silent-miss family closed)', () => {
    const { components, diagnostics } = deriveNeoForgeComponents([synthCat2Mod()])
    const ids = [...components.configuration, ...components.play].map((c) => c.id).filter((id) => id.startsWith('synthcat2:')).sort()
    assert.deepStrictEqual(ids, ['synthcat2:dnet', 'synthcat2:lnet', 'synthcat2:ping', 'synthcat2:pong', 'synthcat2:wided', 'synthcat2:widej'])
    assert.strictEqual(diagnostics.abstains.length, 0)
  })

  // Category-1 FLOAT short forms (fconst_0/1/2, fload_n) are the same
  // missing-push family: a float is ONE slot so LOCALS seeding was never
  // wrong, but an unmodeled fconst/fload inside or feeding a registration
  // body ate the value beneath it and the registration silently missed
  // (HF-R3 verify MEDIUM-1, probes VR1/VR2 — RED pre-settlement with the
  // exact P8 signature: derived=false, zero abstains).
  function synthFloatMod () {
    const entry = 'synth/flt/ModInit'
    const helpers = 'synth/flt/Helpers'
    const pFC = 'synth/flt/FloatCPacket' // fconst inline codec arg
    const pFA = 'synth/flt/FloatAPacket' // float call-site arg + fload in body
    const EAT = 'synth/flt/Eat' // absent from the jar: opaque codec factory

    const entryCls = buildClass({
      name: entry,
      methods: [{
        name: 'onRegister',
        desc: `(L${EVENT};)V`,
        flags: 0x0009,
        code: (a) => a
          .aload(0).ldcStr('21')
          .invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`)
          .astore(1)
          // registrar at slot 0 of wideF-analog: fconst_1 inline codec arg
          .aload(1)
          .getstatic(pFC, 'TYPE', `L${TYPE};`)
          .invokestatic(helpers, 'floatC', `(L${REG};L${TYPE};)V`)
          // float CALL-SITE arg: fconst_0 pushes the F, registrar follows it
          .fconst(0)
          .aload(1)
          .getstatic(pFA, 'TYPE', `L${TYPE};`)
          .invokestatic(helpers, 'floatA', `(FL${REG};L${TYPE};)V`)
          .ret()
      }]
    })

    const helpersCls = buildClass({
      name: helpers,
      methods: [{
        // fconst_1 as inline codec-factory argument — same shape as wideJ
        // with a float literal: pre-settlement the missing push made codecF
        // eat TYPE and the registration vanish with zero abstains
        name: 'floatC',
        desc: `(L${REG};L${TYPE};)V`,
        flags: 0x0009,
        code: (a) => a
          .aload(0)
          .aload(1)
          .fconst(1)
          .invokestatic(EAT, 'codecF', '(F)Ljava/lang/Object;')
          .iconst(0)
          .invokevirtual(REG, 'configurationToClient', `(L${TYPE};Ljava/lang/Object;Ljava/lang/Object;)L${REG};`)
          .pop()
          .ret()
      },
      {
        // float ARG (slot 0, ONE slot — registrar at slot 1 needs no filler)
        // reloaded via fload_0 as the codec argument inside the body
        name: 'floatA',
        desc: `(FL${REG};L${TYPE};)V`,
        flags: 0x0009,
        code: (a) => a
          .aload(1)
          .aload(2)
          .fload(0)
          .invokestatic(EAT, 'codecF', '(F)Ljava/lang/Object;')
          .iconst(0)
          .invokevirtual(REG, 'playToServer', `(L${TYPE};Ljava/lang/Object;Ljava/lang/Object;)L${REG};`)
          .pop()
          .ret()
      }]
    })

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthjar-flt-'))
    const jar = path.join(dir, 'flt.jar')
    fs.writeFileSync(jar, buildJar([
      { name: `${entry}.class`, data: entryCls },
      { name: `${helpers}.class`, data: helpersCls },
      { name: `${pFC}.class`, data: payloadClass(pFC, 'synthflt', 'floatc') },
      { name: `${pFA}.class`, data: payloadClass(pFA, 'synthflt', 'floata') }
    ]))
    return jar
  }

  it('keeps the abstract stack coherent through fconst/fload_n (category-1 float short forms)', () => {
    const { components, diagnostics } = deriveNeoForgeComponents([synthFloatMod()])
    assert.strictEqual(diagnostics.abstains.length, 0, `no abstains expected, got: ${diagnostics.abstains.join(' | ')}`)
    const cfg = new Map(components.configuration.map((c) => [c.id, c]))
    const play = new Map(components.play.map((c) => [c.id, c]))
    const fc = cfg.get('synthflt:floatc')
    assert.ok(fc, 'registration after an inline fconst_1 codec argument must be derived')
    assert.deepStrictEqual({ version: fc.version, flow: fc.flow }, { version: '21', flow: 'clientbound' })
    const fa = play.get('synthflt:floata')
    assert.ok(fa, 'registration with a float call-site arg + fload_0 codec argument must be derived')
    assert.deepStrictEqual({ version: fa.version, flow: fa.flow }, { version: '21', flow: 'serverbound' })
  })
})

// GROUND TRUTH (fixture-gated): the HELPER registration shape (HF-NEOFORGE
// lane). AE2 19.2.17 registers every channel through private static helpers
// (InitNetwork.clientbound(registrar, TYPE, CODEC) -> registrar.playToClient)
// and builds each TYPE through a static factory on an interface
// (CustomAppEngPayload.createType(String) -> new Type(AppEng.makeId(name))),
// including ONE empty-string path (GuiDataSyncPacket = createType("") -> id
// "ae2:"). Before the helper/TYPE-factory dispatch + the cpUtf8 empty-string
// fix, this pack derived ZERO ae2 channels with zero abstains and the live
// 21.1.248 server kicked "Incompatible client! Please use NeoForge 21.1.248".
// Expected values decompiled (CFR) from the rig's exact jars.
describe('derivation ground truth (AE2 helper shape, fixture-gated)', function () {
  const fs = require('fs')
  const path = require('path')
  const root = process.env.MODKNOW_AE2_FIXTURE || '/Users/leoli/minepal-coop/modknowledge/jars/neoforge-21.1.248-ae2'
  const enabled = fs.existsSync(path.join(root, 'mods'))
  ;(enabled ? it : it.skip)('derives all 34 ae2 channels through static helpers, TYPE factories, and the empty-path id', function () {
    this.timeout(30000)
    const jars = fs.readdirSync(path.join(root, 'mods')).filter((f) => f.endsWith('.jar')).map((f) => path.join(root, 'mods', f))
    const loaderJar = path.join(root, 'libraries/net/neoforged/neoforge/21.1.248/neoforge-21.1.248-universal.jar')
    if (fs.existsSync(loaderJar)) jars.push(loaderJar)
    const { components, diagnostics } = deriveNeoForgeComponents(jars)
    assert.strictEqual(diagnostics.abstains.length, 0, `no abstains expected, got: ${diagnostics.abstains.join(' | ')}`)
    const ae2 = components.play.filter((c) => c.id.startsWith('ae2:'))
    assert.strictEqual(ae2.length, 34)
    const flows = ae2.reduce((m, c) => { const k = c.flow ?? 'bidirectional'; m[k] = (m[k] || 0) + 1; return m }, {})
    assert.deepStrictEqual(flows, { clientbound: 17, serverbound: 16, bidirectional: 1 })
    assert.ok(ae2.every((c) => c.version === 'ae2' && c.optional === false))
    const empty = ae2.find((c) => c.id === 'ae2:')
    assert.ok(empty, 'empty-path channel "ae2:" (GuiDataSyncPacket createType("")) must be derived')
    assert.strictEqual(empty.flow, 'clientbound')
    const gm = components.play.find((c) => c.id === 'guideme:open_guide')
    assert.deepStrictEqual({ version: gm.version, flow: gm.flow, optional: gm.optional }, { version: '1.0', flow: 'clientbound', optional: false })
  })
})

describe('HF6 M1 — list==switch mechanical pin (declared contract vs handler cases)', function () {
  it('HANDLED_CLIENTBOUND_CONFIG_CHANNELS exactly equals the channel switch\'s handled case set', () => {
    const fs = require('fs')
    const { HANDLED_CLIENTBOUND_CONFIG_CHANNELS } = require('../src/client/neoForgeConfig')
    const src = fs.readFileSync(require.resolve('../src/client/neoForgeConfig'), 'utf8')
    const at = src.indexOf('switch (channel)')
    assert.ok(at !== -1, 'neoForgeConfig.js must contain the configuration channel switch')
    const cases = [...src.slice(at).matchAll(/case '([^']+)':/g)].map((m) => m[1])
    assert.strictEqual(new Set(cases).size, cases.length, 'duplicate case labels in the channel switch')
    // The negotiation wire itself (query / answer / failure) is the machinery
    // that CREATES the contract, not part of it: the switch handles these
    // three, but they are neither declared over minecraft:register nor
    // claimable components.
    const NEGOTIATION_WIRE = ['neoforge:register', 'neoforge:network', 'neoforge:modded_network_setup_failed']
    for (const ch of NEGOTIATION_WIRE) {
      assert.ok(cases.includes(ch), `negotiation wire channel ${ch} lost its handler case`)
      assert.ok(!HANDLED_CLIENTBOUND_CONFIG_CHANNELS.includes(ch), `${ch} is negotiation machinery — it must not ride the declared list`)
    }
    // EXACT set equality, both directions:
    // - a list entry WITHOUT a handler case is the declared-but-wedging
    //   direction: we invite a payload we then cannot answer, and a blocking
    //   configuration task would wedge the phase — FAIL.
    // - a handler case MISSING from the list is undeclared-but-handled: the
    //   server's send-path guard kills its own send before our handler ever
    //   runs (the HF6 receipt class) — FAIL.
    const handledBySwitch = cases.filter((c) => !NEGOTIATION_WIRE.includes(c)).sort()
    assert.deepStrictEqual([...HANDLED_CLIENTBOUND_CONFIG_CHANNELS].sort(), handledBySwitch)
  })
})

describe('HF113 - the built-in contract resolver (jar / table / pinned) and the source word', function () {
  const fs = require('fs')
  const path = require('path')
  const crypto = require('crypto')
  const { EventEmitter } = require('events')
  const { installNeoForgeConfigNegotiation, resolveBuiltinContract, DECLARED_SOURCES, NEOFORGE_BUILTIN_COLUMNS, HANDLED_CLIENTBOUND_CONFIG_CHANNELS, TOLERATED_CLIENTBOUND_PLAY_CHANNELS } = require('../src/client/neoForgeConfig')
  const { deriveNeoForgeComponents } = require('../src/client/neoForgePayloadDerivation')
  const sha256 = (a) => crypto.createHash('sha256').update(a.join('\n')).digest('hex')
  // the sorted pinned 14 (HANDLED + TOLERATED), b2 of the HF113 baseline
  const PINNED_14_SHA256 = '1ba5ae0f16381a3e9cca8f34122419c7269a902a0da19109e7143b2ee8869ff5'
  const TRIMMED_26_1_2 = path.join(__dirname, 'fixtures', 'hf113-neoforge-26.1.2.124.trimmed.jar')
  const TRIMMED_21_11 = path.join(__dirname, 'fixtures', 'hf113-neoforge-21.11.45.trimmed.jar')
  const fakeClient = (version) => { const c = new EventEmitter(); c.written = []; c.version = version; c.write = (name, params) => c.written.push({ name, params }); return c }
  const declare = (client, options) => {
    installNeoForgeConfigNegotiation(client, options)
    client.emit('packet', { channel: 'neoforge:register', data: Buffer.alloc(0) }, { state: 'configuration', name: 'custom_payload' })
    const frame = client.written.find((w) => w.params.channel === 'minecraft:register')
    return frame ? frame.params.data.toString('utf8').split('\u0000').filter(Boolean) : []
  }
  const EMPTY = { configuration: [], play: [] }

  it('the enum is closed (jar, table, pinned) and the pinned set is the 14 constants, sha-equal to the baseline literal', () => {
    assert.deepStrictEqual(DECLARED_SOURCES, ['jar', 'table', 'pinned'])
    assert.strictEqual(sha256([...HANDLED_CLIENTBOUND_CONFIG_CHANNELS, ...TOLERATED_CLIENTBOUND_PLAY_CHANNELS].slice().sort()), PINNED_14_SHA256)
    const r = resolveBuiltinContract({ components: EMPTY, mcVersion: '1.19.4' })
    assert.strictEqual(r.source, 'pinned')
    assert.deepStrictEqual(r.configuration, [...HANDLED_CLIENTBOUND_CONFIG_CHANNELS])
    assert.deepStrictEqual(r.play, [...TOLERATED_CLIENTBOUND_PLAY_CHANNELS])
    assert.strictEqual(resolveBuiltinContract({ components: EMPTY, mcVersion: null }).source, 'pinned', 'no game version: pinned, never a guess')
    assert.strictEqual(resolveBuiltinContract({}).source, 'pinned')
  })
  it('no jar + game version 26.1.2 -> the table\'s 26.1.2 column: recipe content declared, custom_time_packet (gone at 26.x) not declared, the handler configuration contract kept, source table; the same for 1.21.11 (21.11) and 26.3', () => {
    for (const [mc, line] of [['26.1.2', '26.1.2'], ['1.21.11', '21.11'], ['26.3', '26.3'], ['26.1', '26.1']]) {
      const r = resolveBuiltinContract({ components: EMPTY, mcVersion: mc })
      assert.strictEqual(r.source, 'table', mc)
      assert.strictEqual(r.line, line, mc)
      assert.ok(r.play.includes('neoforge:recipe_content'), `${mc}: recipe content`)
      assert.ok(!r.play.includes('neoforge:split'), `${mc}: split never declared`)
      assert.deepStrictEqual(r.configuration, [...HANDLED_CLIENTBOUND_CONFIG_CHANNELS], `${mc}: the configuration contract is the handler set`)
      const expected = NEOFORGE_BUILTIN_COLUMNS[line].play.filter((x) => x.flow !== 'serverbound' && x.id !== 'neoforge:split').map((x) => x.id)
      assert.deepStrictEqual(r.play, expected, `${mc}: the column's clientbound play ids, in the column's order`)
    }
    assert.ok(!resolveBuiltinContract({ components: EMPTY, mcVersion: '26.1.2' }).play.includes('neoforge:custom_time_packet'))
    const c = fakeClient('26.1.2')
    const declared = declare(c, { components: EMPTY })
    assert.ok(declared.includes('neoforge:recipe_content'), 'declared over minecraft:register from the table')
    assert.strictEqual(c.neoForgeConfig.declaredSource, 'table')
    assert.strictEqual(c.neoForgeConfig.declaredListening.length, declared.length)
    // the option outranks the client's version fact for a caller that holds a truer word
    const c2 = fakeClient('26.1')
    declare(c2, { components: EMPTY, mcVersion: '1.19.4' })
    assert.strictEqual(c2.neoForgeConfig.declaredSource, 'pinned')
  })
  it('no jar + a game version without a column -> the pinned set (sha-equal to the baseline literal), source pinned; the 21.1 column equals the constants', () => {
    const c = fakeClient('1.19.4')
    const declared = declare(c, { components: EMPTY })
    assert.strictEqual(sha256(declared.slice().sort()), PINNED_14_SHA256)
    assert.strictEqual(c.neoForgeConfig.declaredSource, 'pinned')
    const col = NEOFORGE_BUILTIN_COLUMNS['21.1']
    const clientbound = (rows) => rows.filter((r) => r.flow !== 'serverbound' && r.id !== 'neoforge:split').map((r) => r.id).sort()
    assert.deepStrictEqual(clientbound(col.play), [...TOLERATED_CLIENTBOUND_PLAY_CHANNELS].sort())
    assert.deepStrictEqual(clientbound(col.configuration), [...HANDLED_CLIENTBOUND_CONFIG_CHANNELS].sort())
    // 1.21.1 itself resolves to the 21.1 column: byte-identical declaration to the pinned one
    const c3 = fakeClient('1.21.1')
    const d3 = declare(c3, { components: EMPTY })
    assert.strictEqual(sha256(d3.slice().sort()), PINNED_14_SHA256, 'the 21.1 column declares exactly the pinned 14')
    assert.strictEqual(c3.neoForgeConfig.declaredSource, 'table')
  })
  it('the trimmed 26.1.2.124 fixture read through the runtime reader -> the declared set carries recipe content and the source says jar; a jar whose build differs from the column wins (21.11.45 under a 26.1.2 word still declares its own set)', function () {
    this.timeout(30000)
    assert.ok(fs.existsSync(TRIMMED_26_1_2) && fs.statSync(TRIMMED_26_1_2).size < 300 * 1024, 'the trimmed fixture, well under 300 KB')
    assert.ok(fs.existsSync(TRIMMED_21_11) && fs.statSync(TRIMMED_21_11).size < 300 * 1024)
    const run = deriveNeoForgeComponents([TRIMMED_26_1_2])
    assert.ok(run.components.play.some((x) => x.id === 'neoforge:recipe_content' && x.flow === 'clientbound'), 'the fixture registers recipe content playToClient')
    const c = fakeClient('26.1.2')
    const declared = declare(c, { components: run.components })
    assert.ok(declared.includes('neoforge:recipe_content'))
    assert.strictEqual(c.neoForgeConfig.declaredSource, 'jar')
    assert.ok(c.neoForgeConfig.toleratedDerived.includes('neoforge:recipe_content'), 'the HF43 extras carry it')
    assert.ok(!declared.includes('neoforge:split'))
    // the jar wins over the column: the 21.11.45 fixture under a 26.1.2 word declares the 21.11 set (custom_time_packet still registered there), source jar
    const run2 = deriveNeoForgeComponents([TRIMMED_21_11])
    const c2 = fakeClient('26.1.2')
    const d2 = declare(c2, { components: run2.components })
    assert.strictEqual(c2.neoForgeConfig.declaredSource, 'jar')
    assert.ok(d2.includes('neoforge:recipe_content') && d2.includes('neoforge:custom_time_packet'))
    // the trimmed fixture pins the SAME set as the full jar (the stop rule): the full jar's sorted neoforge:* set, HF113_JAR_DIR when present
    const full = process.env.HF113_JAR_DIR ? path.join(process.env.HF113_JAR_DIR, 'neoforge-26.1.2.124-universal.jar') : null
    if (full && fs.existsSync(full)) {
      const key = (r) => [...r.components.configuration, ...r.components.play].filter((x) => x.id.startsWith('neoforge:')).map((x) => `${x.id}|${x.flow}|${x.version}`).sort()
      assert.deepStrictEqual(key(run), key(deriveNeoForgeComponents([full])), 'trimmed == full')
    }
  })
})
