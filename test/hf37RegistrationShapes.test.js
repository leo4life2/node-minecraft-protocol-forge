/* eslint-env mocha */
// HF37 — registration shapes read from the ec066f43 pack (javap-verified):
//   HOLDER  a static factory (modId, name) builds the registration object
//           into a static holder field of the payload class; the entry
//           registers through the holder (ldtteam blockui PlayMessageType:
//           minecolonies 132 + structurize 23 required channels — the
//           whole ldtteam family derived as ZERO before this lane).
//   ModList the runtime version idiom ModList.get().getModContainerById("id")
//           ...getVersion().toString() resolves to THAT mod's mods.toml
//           version (a library-hosted site must not carry the library's
//           version — blockui 1.0.211 was claimed for minecolonies 1.1.1376).
//   SILENT  an entry whose registrar never reaches a registration is
//           reported, never a silent zero.
// The real-jar leg (HF37_JARS=<dir with the 25 rig jars>) pins the whole
// pack: the builder/lambda/forEach family (MrCrayfish framework) included.
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
const PMT = 'synth/hold/PlayMessageType'
const HELLO = 'synth/hold/HelloMessage'
const WORLD = 'synth/hold/WorldMessage'
const INIT = 'synth/hold/ModInit'
const GONE = 'synth/hold/GoneHelper'

const newOp = (a, cls) => { const i = a.cp.cls(cls); return a.raw([0xbb, (i >> 8) & 0xff, i & 0xff]) }

function holderJar ({ modListVersion = true, silentEntry = false } = {}) {
  const pmt = buildClass({
    name: PMT,
    fields: [{ name: 'id', desc: `L${TYPE};` }],
    methods: [
      { name: '<init>', desc: `(L${TYPE};)V`, flags: 0x0001, code: (a) => a.aload(0).invokespecial('java/lang/Object', '<init>', '()V').aload(0).aload(1).putfield(PMT, 'id', `L${TYPE};`).ret() },
      {
        name: 'forServer',
        desc: `(Ljava/lang/String;Ljava/lang/String;)L${PMT};`,
        flags: 0x0009,
        code: (a) => {
          newOp(a, PMT).dup()
          newOp(a, TYPE).dup().aload(0).aload(1).invokestatic(RL, 'fromNamespaceAndPath', `(Ljava/lang/String;Ljava/lang/String;)L${RL};`)
          a.invokespecial(TYPE, '<init>', `(L${RL};)V`).invokespecial(PMT, '<init>', `(L${TYPE};)V`)
          return a.areturnOp()
        }
      },
      { name: 'register', desc: `(L${REG};)V`, flags: 0x0001, code: (a) => a.aload(1).aload(0).getfield(PMT, 'id', `L${TYPE};`).aconstNull().aconstNull().invokevirtual(REG, 'playToServer', `(L${TYPE};Ljava/lang/Object;Ljava/lang/Object;)L${REG};`).pop().ret() }
    ]
  })
  const holder = (name, id) => buildClass({
    name,
    fields: [{ name: 'TYPE', desc: `L${PMT};`, flags: 0x0019 }],
    methods: [{ name: '<clinit>', desc: '()V', flags: 0x0008, code: (a) => a.ldcStr('synthhold').ldcStr(id).invokestatic(PMT, 'forServer', `(Ljava/lang/String;Ljava/lang/String;)L${PMT};`).putstatic(name, 'TYPE', `L${PMT};`).ret() }]
  })
  const init = buildClass({
    name: INIT,
    methods: [{
      name: 'onRegister',
      desc: `(L${EVENT};)V`,
      flags: 0x0009,
      code: (a) => {
        a.aload(0).ldcStr('synthhold').invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`)
        if (modListVersion) {
          a.invokestatic('net/neoforged/fml/ModList', 'get', '()Lnet/neoforged/fml/ModList;')
            .ldcStr('synthhold').invokevirtual('net/neoforged/fml/ModList', 'getModContainerById', '(Ljava/lang/String;)Ljava/util/Optional;')
            .invokevirtual('java/util/Optional', 'get', '()Ljava/lang/Object;').checkcast('net/neoforged/fml/ModContainer')
            .invokevirtual('net/neoforged/fml/ModContainer', 'getModInfo', '()Lnet/neoforged/neoforgespi/language/IModInfo;')
            .invokeinterface('net/neoforged/neoforgespi/language/IModInfo', 'getVersion', '()Lorg/apache/maven/artifact/versioning/ArtifactVersion;', 1)
            .invokeinterface('org/apache/maven/artifact/versioning/ArtifactVersion', 'toString', '()Ljava/lang/String;', 1)
            .invokevirtual(REG, 'versioned', `(Ljava/lang/String;)L${REG};`)
        }
        a.astore(1)
        if (silentEntry) {
          // the registrar disappears into a helper that is not in the jar
          return a.aload(1).invokestatic(GONE, 'consume', `(L${REG};)V`).ret()
        }
        a.getstatic(HELLO, 'TYPE', `L${PMT};`).aload(1).invokevirtual(PMT, 'register', `(L${REG};)V`)
        a.getstatic(WORLD, 'TYPE', `L${PMT};`).aload(1).invokevirtual(PMT, 'register', `(L${REG};)V`)
        return a.ret()
      }
    }]
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthjar-hf37-'))
  const jar = path.join(dir, 'hold.jar')
  fs.writeFileSync(jar, buildJar([
    // the [[mods]] table declares THIS jar's id; a dependency table's modId names another mod
    { name: 'META-INF/neoforge.mods.toml', data: Buffer.from('[[mods]]\nmodId="synthhold"\nversion="3.1.4"\n[[dependencies.synthhold]]\nmodId="minecraft"\nversionRange="[1.21.1]"\n') },
    { name: `${PMT}.class`, data: pmt },
    { name: `${HELLO}.class`, data: holder(HELLO, 'hello') },
    { name: `${WORLD}.class`, data: holder(WORLD, 'world') },
    { name: `${INIT}.class`, data: init }
  ]))
  return jar
}

describe('HF37 registration shapes', function () {
  it('HOLDER: factory-built registration objects registered through static holder fields derive every channel with the holder\'s own Type and the call site\'s registrar', () => {
    const r = deriveNeoForgeComponents([holderJar()])
    const play = r.components.play.map((c) => [c.id, c.version, c.flow, c.optional]).sort()
    assert.deepStrictEqual(play, [['synthhold:hello', '3.1.4', 'serverbound', false], ['synthhold:world', '3.1.4', 'serverbound', false]])
    assert.deepStrictEqual(r.diagnostics.abstains, [])
  })

  it('ModList version idiom: the version is the NAMED mod\'s mods.toml version; a [[dependencies]] modId never binds it', () => {
    const r = deriveNeoForgeComponents([holderJar({ modListVersion: true })])
    assert.ok(r.components.play.every((c) => c.version === '3.1.4'))
    assert.deepStrictEqual(r.diagnostics.jars[0].modIds, ['synthhold'])
  })

  it('runtime version without the idiom: the registrar NAMESPACE selects the fallback mods.toml (versionSource mods.toml)', () => {
    const r = deriveNeoForgeComponents([holderJar({ modListVersion: false })])
    // registrar("synthhold") without versioned(): the namespace IS the version (NeoForge semantics) — constant
    assert.ok(r.components.play.every((c) => c.version === 'synthhold'), JSON.stringify(r.components.play))
  })

  it('SILENT entry: a registrar that never reaches a registration is REPORTED, never a silent zero', () => {
    const r = deriveNeoForgeComponents([holderJar({ silentEntry: true })])
    assert.deepStrictEqual(r.components.play, [])
    assert.ok(r.diagnostics.abstains.some((a) => a.includes(`${INIT}.onRegister`) && a.includes('never reaches a registration')), JSON.stringify(r.diagnostics.abstains))
  })

  const jarsDir = process.env.HF37_JARS
  ;(jarsDir ? it : it.skip)('real-jar leg (HF37_JARS): the ec066f43 pack claims every channel the 21.1.249 rig named missing, framework\'s optional configuration channels included', function () {
    this.timeout(120000)
    const jars = fs.readdirSync(jarsDir).filter((f) => f.endsWith('.jar')).map((f) => path.join(jarsDir, f))
    const r = deriveNeoForgeComponents(jars)
    const by = (ns) => r.components.play.filter((c) => c.id.startsWith(`${ns}:`))
    assert.ok(by('minecolonies').length >= 132, `minecolonies ${by('minecolonies').length}`)
    assert.ok(by('structurize').length >= 23, `structurize ${by('structurize').length}`)
    assert.ok(by('refurbished_furniture').length >= 26, `refurbished ${by('refurbished_furniture').length}`)
    assert.strictEqual(by('createcolonies').length, 1)
    assert.ok(by('minecolonies').every((c) => c.version === '1.1.1376-1.21.1-snapshot' && c.flow !== undefined))
    assert.ok(by('structurize').every((c) => c.version === '1.0.832-1.21.1'))
    const cfg = r.components.configuration.map((c) => [c.id, c.optional]).sort()
    assert.deepStrictEqual(cfg, [['framework:configuration/ack', true], ['framework:configuration/config_data', true], ['framework:configuration/synced_entity_data', true]])
    assert.ok(!r.diagnostics.abstains.some((a) => a.includes('ldtteam') || a.includes('never reaches')), r.diagnostics.abstains.join(' | '))
  })
})

// HF105 item A - THE DIRECTION TABLE (src/client/data/payloadDirectionRules.json):
// an enum packet registry (Create/catnip) whose payload classes implement a
// marker ANOTHER jar's helper names (TFMG + createdieselgenerators: catnip's
// markers live in Create's nested ponder jar, the payload supers in Create's
// own classes) derives every row WITH a direction through the pack-scope
// marker rule; a jar whose own unit discovers the markers (Create, the hf51
// securitycraft fixture) keeps its claim set byte for byte (rule 0 unchanged).
// Fixtures: the REAL jars of the F39 Case A receipt, trimmed (tools/trim-packet-wire-fixture.js).
describe('HF105 item A: enum-registry direction decided by the pack-scope marker rule', function () {
  this.timeout(60000)
  const crypto = require('crypto')
  const FX = path.join(__dirname, 'fixtures')
  const TFMG = path.join(FX, 'hf105-tfmg-1.2.0.trimmed.jar')
  const DIESEL = path.join(FX, 'hf105-createdieselgenerators-1.21.1-1.3.15.trimmed.jar')
  const CREATE = path.join(FX, 'hf105-create-1.21.1-6.0.10.trimmed.jar')
  const SC = path.join(FX, 'hf51-securitycraft-1.10.2.1.trimmed.jar')
  // a-missing.txt of the F39 receipt: the 12 ids the 21.1.255 server named missing.server.client
  const A_MISSING = ['create:cable_place_packet', 'create:coke_oven_packet', 'create:distillation_packet', 'create:electricians_wrench_packet', 'create:engine_controller_input', 'create:engine_controller_stop_control', 'create:engine_start', 'create:engine_transmission_packet', 'create:transmission_remove', 'create:update_in_front_packet', 'create:vat_evaluation', 'createdieselgenerators:entity_filter_screen']
  // the claim-set line format of the lane's baseline driver (bV-claim.sha): "<protocol> <id> v=<version> flow=<flow> opt=<optional> src=<source word>", sorted
  const claimSha = (r) => crypto.createHash('sha256').update(
    [...r.components.play.map((c) => ['play', c]), ...r.components.configuration.map((c) => ['configuration', c])]
      .map(([p, c]) => `${p} ${c.id} v=${c.version} flow=${c.flow} opt=${c.optional} src=${String(c.source).split(' ')[0]}`).sort().join('\n')).digest('hex')

  it('claims the 12 server-named ids with a direction and version 1 (the registry construction), 0 "no flow marker" abstains', () => {
    const r = deriveNeoForgeComponents([TFMG, DIESEL, CREATE])
    const play = new Map(r.components.play.map((c) => [c.id, c]))
    for (const id of A_MISSING) {
      const c = play.get(id)
      assert.ok(c, `${id} claimed`)
      assert.strictEqual(c.version, '1', `${id} version`)
      assert.ok(c.flow === 'serverbound' || c.flow === 'clientbound', `${id} flow ${c.flow}`)
      assert.strictEqual(c.optional, false)
      assert.ok(/^enum-registry /.test(c.source) && /direction: marker-hierarchy\/pack/.test(c.source), c.source)
    }
    assert.strictEqual(play.get('create:engine_start').flow, 'serverbound') // EngineControllerPacketBase implements ServerboundPacketPayload
    assert.strictEqual(play.get('create:cable_place_packet').flow, 'clientbound') // extends Create's BlockEntityDataPacket (clientbound)
    assert.strictEqual(play.get('createdieselgenerators:entity_filter_screen').flow, 'serverbound')
    assert.deepStrictEqual(r.diagnostics.abstains.filter((a) => /no flow marker/.test(a)), [])
    // the pack-scope read is a pack-wide scan: the addon unit records the pack census + Create's jar on its trail
    const { readNeoForgeJarUnits, deriveNeoForgeJarUnit } = require('../src/client/neoForgePayloadDerivation')
    const read = readNeoForgeJarUnits([TFMG, DIESEL, CREATE])
    const tfmgUnit = deriveNeoForgeJarUnit(read, read.units.find((u) => u.path === TFMG))
    assert.ok(tfmgUnit.deps.packCensus, 'pack census dependency recorded')
    assert.ok(tfmgUnit.trail.includes(CREATE), `trail ${JSON.stringify(tfmgUnit.trail)}`)
  })

  it('control: a jar whose own unit discovers the markers keeps its claim set byte for byte (bV sha of the baseline)', () => {
    const r = deriveNeoForgeComponents([SC, CREATE])
    assert.strictEqual(claimSha(r), 'a32114e162102b1c83cf96684e99a52f3e668ac751f79a00ef5e2c449b09305a')
    assert.ok(r.components.play.every((c) => !/direction: marker-hierarchy\/pack/.test(c.source)), 'no row needed the pack rule')
  })

  it('the table is the mechanism (M1): the pack-scope row removed from the data file -> the 12 named ids abstain "no flow marker" again', () => {
    const dataPath = path.join(__dirname, '..', 'src', 'client', 'data', 'payloadDirectionRules.json')
    const rules = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
    assert.deepStrictEqual(rules.rules.map((x) => `${x.rule}/${x.scope}`), ['marker-hierarchy/unit', 'marker-hierarchy/pack'])
    for (const rule of rules.rules) for (const c of rule.cited) assert.ok(/^[0-9a-f]{40}$/.test(c.sha1) && /^[0-9a-f]{40}$/.test(c.fixture_sha1) && c.jar && c.fixture && c.class, JSON.stringify(c))
    const dataKey = require.resolve(dataPath)
    const mainPath = require.resolve('../src/client/neoForgePayloadDerivation')
    const phPath = require.resolve('../src/client/platformHelperDerivation')
    const saved = { data: require.cache[dataKey], main: require.cache[mainPath], ph: require.cache[phPath] }
    try {
      delete require.cache[mainPath]; delete require.cache[phPath]
      require.cache[dataKey] = { id: dataKey, filename: dataKey, loaded: true, exports: { ...rules, rules: rules.rules.filter((x) => x.scope !== 'pack') } }
      const red = require('../src/client/neoForgePayloadDerivation').deriveNeoForgeComponents([TFMG, DIESEL, CREATE])
      const play = new Map(red.components.play.map((c) => [c.id, c]))
      for (const id of A_MISSING) {
        assert.strictEqual(play.get(id), undefined, `${id} must not be claimed without the pack row`)
        assert.ok(red.diagnostics.abstains.some((a) => a.startsWith(`${id}: no flow marker on `)), `${id} abstains`)
      }
    } finally {
      require.cache[dataKey] = saved.data; require.cache[mainPath] = saved.main; require.cache[phPath] = saved.ph
    }
  })
})
