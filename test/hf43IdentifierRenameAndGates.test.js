/* eslint-env mocha */
// HF43 — NeoForge 26.1.2.109 rig (13 mods) derived 0 configuration + 0 play
// components: Minecraft 26.1 renamed net.minecraft.resources.ResourceLocation
// to net.minecraft.resources.Identifier and every id-factory comparison in the
// deriver was pinned to ONE spelling. Two more shapes surfaced once the ids
// resolved: a (String)->String helper chain feeding Identifier.parse
// (sophisticatedcore getRegistryName = "ns:" + path) and a MOD-PRESENCE GATE
// (a compat table keyed by CompatInfo("create") whose isLoaded() decides
// whether the class that registers three REQUIRED channels is ever built).
// Pinned on the real jars (GlitchCore 26.1.2.0.2 whole, sophisticatedcore
// 1.5.0 trimmed to its network + compat classes) and on jarMutate bends.
const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { deriveNeoForgeComponents, readNeoForgeJarUnits } = require('../src/client/neoForgePayloadDerivation')
const { zipCentralEntries, zipEntryData } = require('../src/client/jarAnalysis')
const { mutateJar } = require('./helpers/jarMutate')
const { buildJar } = require('./helpers/synthJar')

const FX = path.join(__dirname, 'fixtures')
const GLITCH = path.join(FX, 'glitchcore-26.1.2.0.2-neoforge.jar')
const SCORE = path.join(FX, 'sophisticatedcore-1.5.0-mc26.1.2.trimmed.jar')

function tmpJar (name, buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf43-'))
  const p = path.join(dir, name)
  fs.writeFileSync(p, buf)
  return p
}
const ids = (r) => [...r.components.configuration, ...r.components.play].map((c) => c.id)

describe('HF43 — 26.1 Identifier rename + string-helper chains + mod-presence gates', function () {
  this.timeout(20000)

  it('GlitchCore 26.1.2 (Identifier spelling, runtime id through MixinPacketHandler): glitchcore:sync_config is derived as a configuration component', () => {
    const r = deriveNeoForgeComponents([GLITCH])
    const row = r.components.configuration.find((c) => c.id === 'glitchcore:sync_config')
    assert.ok(row, `derived: ${JSON.stringify(ids(r))} abstains: ${r.diagnostics.abstains.join(' | ')}`)
    assert.strictEqual(row.optional, false)
    assert.ok(!r.diagnostics.abstains.some((a) => /MixinPacketHandler.*unresolved payload type id/.test(a)), 'the incident abstain is gone')
  })

  it('sophisticatedcore 26.1 (Identifier.parse(getRegistryName(p)) helper chain): every ModPayloads channel resolves with the mods.toml version', () => {
    const r = deriveNeoForgeComponents([SCORE])
    const sc = r.components.play.filter((c) => c.id.startsWith('sophisticatedcore:'))
    assert.ok(sc.length >= 19, `expected the ModPayloads channels, got ${sc.length}: ${sc.map((c) => c.id).join(',')}`)
    assert.ok(sc.every((c) => c.version === '1.5.0'), 'version = mods.toml 1.5.0 (registrar(modId).versioned(runtime) idiom)')
    assert.ok(sc.some((c) => c.id === 'sophisticatedcore:sync_container_client_data' && c.flow === 'serverbound'))
    assert.ok(!r.diagnostics.abstains.some((a) => /init\/ModPayloads: playTo\w+ with unresolved payload type id/.test(a)), 'no unresolved-id abstain on ModPayloads')
  })

  it('MOD-PRESENCE GATE: CreateCompat/JeiCompat (CompatInfo("create"/"jei").isLoaded -> ModList) are NOT claimed on a pack without those mods — named abstain + receipt', () => {
    const r = deriveNeoForgeComponents([SCORE])
    assert.ok(!ids(r).some((id) => /mounted_storage/.test(id)), 'the Create-gated required channels stay unclaimed')
    const gates = r.diagnostics.presenceGates
    assert.deepStrictEqual(gates.map((g) => [g.modId, g.present]).sort(), [['create', false], ['jei', false]])
    assert.ok(gates.every((g) => g.holder.endsWith('/CompatInfo') && /ModList\.getModContainerById/.test(g.probe)))
    const named = r.diagnostics.abstains.filter((a) => /gated on mod presence/.test(a))
    assert.strictEqual(named.length, 2)
    assert.ok(named.some((a) => /CreateCompat\.registerPayloads/.test(a) && /"create" is not in the jar census/.test(a)), named.join(' | '))
  })

  it('MOD-PRESENCE GATE, mutated: the same jar with the gate key bent onto a PRESENT mod id claims the gated channels (present=true)', () => {
    const m = mutateJar(fs.readFileSync(SCORE), { rewrite: (p, s) => (/init\/ModCompat\.class$/.test(p) && s === 'create' ? 'sophisticatedcore' : undefined) })
    assert.ok(m.changed > 0, 'the gate key was rewritten')
    const r = deriveNeoForgeComponents([tmpJar('sc-present.jar', m.buf)])
    const mounted = r.components.play.filter((c) => /mounted_storage/.test(c.id))
    assert.strictEqual(mounted.length, 3, JSON.stringify(ids(r)))
    assert.ok(mounted.every((c) => c.version === '1.5.0' && c.flow === 'clientbound' && c.optional === false))
    const g = r.diagnostics.presenceGates.find((x) => x.site.endsWith('CreateCompat.registerPayloads'))
    assert.ok(g && g.present === true && g.modId === 'sophisticatedcore')
  })

  it('the id class is a SET: the same bytes with Identifier spelled ResourceLocation derive the same channels', () => {
    const m = mutateJar(fs.readFileSync(SCORE), { rewrite: (p, s) => (s.includes('net/minecraft/resources/Identifier') ? s.split('net/minecraft/resources/Identifier').join('net/minecraft/resources/ResourceLocation') : undefined) })
    assert.ok(m.changed > 0)
    const a = deriveNeoForgeComponents([SCORE])
    const b = deriveNeoForgeComponents([tmpJar('sc-resloc.jar', m.buf)])
    assert.deepStrictEqual(ids(b).sort(), ids(a).sort())
  })

  it('the whole rig pair together: 1 configuration (glitchcore) + the sophisticatedcore play set, no errors', () => {
    const r = deriveNeoForgeComponents([GLITCH, SCORE])
    assert.strictEqual(r.components.configuration.length, 1)
    assert.ok(r.components.play.length >= 19)
    assert.deepStrictEqual(r.diagnostics.errors, [])
  })

  // ---------- HF106: the JVM-flag presence gate (F41: a rendering mod's game-test registry) ----------
  // The real jar (embeddium-1.0.15+mc1.21.1.jar, sha1 56063839172a000d079272794bad366f2ad4cbbd) trimmed to the
  // mod root + the game-test package; the mod root subscribes the test registry ONLY under
  // "true".equals(System.getProperty(<flag>)) -> bus.register(Class.forName(<registry>)), and the registry's
  // static registerPayloads(RegisterPayloadHandlersEvent) registers one required clientbound play channel.
  const EMB = path.join(FX, 'hf106-embeddium-1.0.15+mc1.21.1.trimmed.jar')
  const EMB_TWIN = path.join(FX, 'hf106-embeddium-1.0.15+mc1.21.1.twin-noguard.jar') // the same bytes, the guard's `ifeq` -> `pop nop nop`
  const PROBES = require('../src/client/data/jvmFlagProbes.json')
  const claimSha = (r) => crypto.createHash('sha256').update([...r.components.configuration.map((c) => ['configuration', c]), ...r.components.play.map((c) => ['play', c])].map(([p, c]) => `${p}|${c.id}|${c.version}|${c.flow}|${c.optional}`).sort().join('\n')).digest('hex').slice(0, 16)
  it('HF106 JVM-FLAG GATE: the test registry subscribed only under a System.getProperty flag is NOT claimed — the named abstain (jvm_property + the probe, never the key) and the presenceGates receipt', () => {
    const r = deriveNeoForgeComponents([EMB])
    assert.deepStrictEqual(ids(r), [], JSON.stringify(ids(r)))
    assert.deepStrictEqual(r.diagnostics.errors, [])
    const g = r.diagnostics.presenceGates
    assert.strictEqual(g.length, 1, JSON.stringify(g))
    assert.strictEqual(g[0].kind, 'jvm_property')
    assert.strictEqual(g[0].present, false)
    assert.strictEqual(g[0].probe, 'System.getProperty/String.equals')
    assert.ok(g[0].site.endsWith('TestRegistry.registerPayloads') && g[0].gateSite.endsWith('Embeddium.<init>'), JSON.stringify(g))
    assert.ok(!('key' in g[0]) && !('modId' in g[0]), 'no key value, no mod id on a jvm gate row')
    const named = r.diagnostics.abstains.filter((a) => /gated on a JVM flag/.test(a))
    assert.strictEqual(named.length, 1, r.diagnostics.abstains.join(' | '))
    assert.ok(/TestRegistry\.registerPayloads/.test(named[0]) && /jvm_property/.test(named[0]) && /System\.getProperty\/String\.equals/.test(named[0]), named[0])
    assert.ok(!/enableGameTest/.test(named[0]) && !/enableGameTest/.test(JSON.stringify(g)), 'the key value never leaves the evaluator')
  })
  it('HF106 twin: the same bytes with the guard neutralised subscribe the registry unconditionally and claim the channel (play, version 1, clientbound, required)', () => {
    const r = deriveNeoForgeComponents([EMB_TWIN])
    assert.deepStrictEqual(r.components.play.map((c) => [c.id, c.version, c.flow, c.optional]), [['embeddium:test_barrier', '1', 'clientbound', false]])
    assert.deepStrictEqual(r.diagnostics.presenceGates, [])
    assert.ok(!r.diagnostics.abstains.some((a) => /JVM flag/.test(a)), r.diagnostics.abstains.join(' | '))
  })
  it('HF106 RED control: the property_string row dropped from the probe table -> the guard is unread and the channel is claimed again (the table is the mechanism)', () => {
    const r = deriveNeoForgeComponents([EMB], { jvmFlagProbes: PROBES.rows.filter((row) => row.shape !== 'property_string') })
    assert.deepStrictEqual(r.components.play.map((c) => c.id), ['embeddium:test_barrier'])
    assert.deepStrictEqual(r.diagnostics.presenceGates, [])
  })
  // HF106 r2 (the verifier's HIGH-1): the guard's polarity. Bends of the trimmed jar's guard bytes at
  // Embeddium.<init> (:57 `ifeq 84` = jump when the flag is unset, :60 `aload_1` = the first op of the
  // register arm), written at test time - no more jars shipped (jarMutate's doctrine).
  const GUARD = Buffer.from([0xb8, 0x00, 0x41, 0xb6, 0x00, 0x47, 0x99, 0x00, 0x1b, 0x2b]) // invokestatic getProperty; invokevirtual equals; ifeq +27; aload_1
  const bendGuard = (name, patch) => {
    const buf = fs.readFileSync(EMB); const entries = []; let edits = 0
    for (const e of zipCentralEntries(buf)) {
      let data = zipEntryData(buf, e)
      if (e.name === 'org/embeddedt/embeddium/impl/Embeddium.class') { const i = data.indexOf(GUARD); assert.ok(i > 0, 'the guard bytes'); data = Buffer.from(data); patch(data, i); edits++ }
      entries.push({ name: e.name, data })
    }
    assert.strictEqual(edits, 1)
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hf106-r2-')), `hf106-embeddium-1.0.15+mc1.21.1.${name}.jar`)
    fs.writeFileSync(out, buildJar(entries)); return out
  }
  const gatesOf = (read) => [...read.gates.entries()].map(([k, g]) => `${k.replace(/^org\/embeddedt\/embeddium\/impl\//, '')}->${g.kind}/${g.probe}`)
  it('HF106 r2 the ifne twin (ONE byte, the guard\'s ifeq -> ifne = `if (!flag) bus.register(..)`): the register arm is the player\'s path and is walked (the registry resolved, the channel claimed as the noguard twin) and the listener subscribed after the join point is NOT gated', () => {
    const jar = bendGuard('twin-ifne', (d, i) => { d[i + 6] = 0x9a })
    const r = deriveNeoForgeComponents([jar])
    assert.deepStrictEqual(r.components.play.map((c) => [c.id, c.version, c.flow, c.optional]), [['embeddium:test_barrier', '1', 'clientbound', false]])
    assert.deepStrictEqual(r.diagnostics.presenceGates, [])
    assert.ok(!r.diagnostics.abstains.some((a) => /JVM flag/.test(a)), r.diagnostics.abstains.join(' | '))
    const read = readNeoForgeJarUnits([jar])
    assert.deepStrictEqual(gatesOf(read), [], 'no gate on the listener past the join point')
    assert.ok([...read.modRootResolved].some((k) => /TestRegistry\.registerPayloads/.test(k)), 'the fallthrough register walked: ' + [...read.modRootResolved].join(','))
    assert.strictEqual(read.rootRegistrations.length, 1)
  })
  it('HF106 r2 `if (!flag) return;` (ifne, the fallthrough a return): the continuation past the target is exclusively the flag\'s - the listener subscribed there is gated under the probe', () => {
    const read = readNeoForgeJarUnits([bendGuard('twin-ifne-return', (d, i) => { d[i + 6] = 0x9a; d[i + 9] = 0xb1 })])
    assert.deepStrictEqual(gatesOf(read), ['Embeddium#onClientSetup(Lnet/neoforged/fml/event/lifecycle/FMLClientSetupEvent;)V->jvm_property/System.getProperty/String.equals'])
    assert.deepStrictEqual([...read.modRootResolved], [])
  })
  it('HF106 r2 `if (flag) return;` (ifeq, the true arm a return): the player\'s path is the target - no gate, no abstain, the claim set of the noguard twin', () => {
    const jar = bendGuard('twin-ifeq-return', (d, i) => { d[i + 9] = 0xb1 })
    const r = deriveNeoForgeComponents([jar])
    assert.deepStrictEqual(r.components.play.map((c) => c.id), ['embeddium:test_barrier'])
    assert.deepStrictEqual(r.diagnostics.presenceGates, [])
    assert.ok(!r.diagnostics.abstains.some((a) => /JVM flag/.test(a)), r.diagnostics.abstains.join(' | '))
    assert.deepStrictEqual(gatesOf(readNeoForgeJarUnits([jar])), [])
  })
  it('HF106 bar: the wired static entries of the existing fixtures keep their claim set byte for byte (the base tree\'s shas)', () => {
    assert.strictEqual(claimSha(deriveNeoForgeComponents([path.join(FX, 'hf105-tfmg-1.2.0.trimmed.jar'), path.join(FX, 'hf105-createdieselgenerators-1.21.1-1.3.15.trimmed.jar'), path.join(FX, 'hf105-create-1.21.1-6.0.10.trimmed.jar')])), '24f4d6515451db0e')
    assert.strictEqual(claimSha(deriveNeoForgeComponents([path.join(FX, 'hf105-moonlight-1.21.1-3.7.2-neoforge.trimmed.jar'), path.join(FX, 'hf105-supplementaries-1.21.1-4.0.1-neoforge.trimmed.jar')])), '8708040ef0f8db9d')
    assert.strictEqual(claimSha(deriveNeoForgeComponents([path.join(FX, 'hf51-securitycraft-1.10.2.1.trimmed.jar')])), 'c83b535ded0e0b66')
  })
})
