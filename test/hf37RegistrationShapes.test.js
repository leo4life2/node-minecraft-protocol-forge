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
