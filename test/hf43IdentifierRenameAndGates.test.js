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
const fs = require('fs')
const path = require('path')
const os = require('os')
const { deriveNeoForgeComponents } = require('../src/client/neoForgePayloadDerivation')
const { mutateJar } = require('./helpers/jarMutate')

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
})
