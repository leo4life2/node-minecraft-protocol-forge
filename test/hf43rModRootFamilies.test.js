/* eslint-env mocha */
// HF43-r — two payload-id families only readable in the loader's own order:
//   registry-COUNTER ids   "<ns>:main" + "/" + AtomicInteger.getAndIncrement()
//                          (or an int field `next++`), one per registration in
//                          class-init order, version = the channel string
//   version-prefixed ids   "<ns>:<path>/v<N>" + "/" + the packet's own
//                          namespace/path (or its class simple name), the
//                          registrar version "v<N>" from an int constant
// Both are born in a @Mod constructor's call chain (services files, static
// initializers on first touch, Optional, lambdas, the mod's own event bus)
// and registered when the loader fires its lifecycle events in the order
// javap'd from CommonModLoader.load (common setup -> sided setup -> payload
// registration). The MOD-ROOT walk replays exactly that; a counter advanced
// by two independent listeners has no provable order and is refused BY NAME.
// Fixtures are real javac bytecode (test/fixtures/src/hf43r, build.sh);
// the real jars pin when present on this machine.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { deriveNeoForgeComponents } = require('../src/client/neoForgePayloadDerivation')
const FX = path.join(__dirname, 'fixtures')
const COUNTER = path.join(FX, 'hf43r-counter-ids.jar')
const VERSIONED = path.join(FX, 'hf43r-versioned-ids.jar')
const RIG = '/private/tmp/claude-501/-Users-leoli-Desktop-Nemos-minepal-root-minepal-v0/7d543de9-8a73-4a9b-ad7b-62b5856980da/scratchpad/v261/rig/neoforge'
const play = (r) => Object.fromEntries(r.components.play.map((c) => [c.id, c]))

describe('HF43-r — registry-counter and version-prefixed payload ids (mod-root walk)', function () {
  this.timeout(30000)

  it('counter ids (javac fixture): AtomicInteger and int-field counters yield /0../N in class-init order with the channel string as version; flows follow the registrar method', () => {
    const r = deriveNeoForgeComponents([COUNTER])
    const p = play(r)
    for (const [id, flow] of [['alpha:main/0', 'clientbound'], ['alpha:main/1', 'clientbound'], ['alpha:main/2', 'serverbound']]) {
      assert.ok(p[id], `${id} derived (have ${Object.keys(p).join(', ')}; abstains ${r.diagnostics.abstains.join(' | ')})`)
      assert.strictEqual(p[id].version, 'alpha:main')
      assert.strictEqual(p[id].flow, flow)
      assert.strictEqual(p[id].optional, false)
    }
    for (const id of ['beta:main/0', 'beta:main/1']) {
      assert.ok(p[id], `${id} derived from the int-field counter`)
      assert.strictEqual(p[id].version, 'beta:main')
    }
    assert.ok(!p['alpha:main/3'] && !p['beta:main/2'], 'no phantom ids past the registrations')
    assert.strictEqual(r.diagnostics.modRoot.droppedUnprovenOrder, 2)
  })

  it('counter ids: one counter advanced by two independent listeners is refused BY NAME (order not provable) — no gamma row, a named abstain', () => {
    const r = deriveNeoForgeComponents([COUNTER])
    assert.ok(!Object.keys(play(r)).some((id) => id.startsWith('gamma:')), 'no gamma channel claimed')
    const named = r.diagnostics.abstains.filter((a) => /registry-counter ids \(gamma:main\/[01]\).*advanced by 2 independent listeners.*order is not provable, unclaimed/.test(a))
    assert.strictEqual(named.length, 2, r.diagnostics.abstains.join(' | '))
  })

  it('version-prefixed ids (javac fixture): "<ns>:<path>/v<N>/<ns>/<packet>" @v<N> through a services-file network service, static initializers on first touch and the mod\'s own setup event; the class-name variant derives from the ldc class constant', () => {
    const r = deriveNeoForgeComponents([VERSIONED])
    const p = play(r)
    assert.ok(p['delta:networking/v1/delta/sync_packet'], `derived: ${Object.keys(p).join(', ')} abstains: ${r.diagnostics.abstains.join(' | ')}`)
    assert.strictEqual(p['delta:networking/v1/delta/sync_packet'].version, 'v1')
    assert.strictEqual(p['delta:networking/v1/delta/sync_packet'].flow, 'clientbound')
    assert.strictEqual(p['delta:networking/v1/delta/anim_packet'].flow, 'serverbound')
    assert.strictEqual(p['delta:networking/v1/delta/anim_packet'].version, 'v1')
    assert.strictEqual(p['epsilon:net/v3/epacket'].version, 'v3')
    assert.strictEqual(p['epsilon:net/v3/epacket'].flow, 'clientbound')
  })

  it('version-prefixed ids: a runtime class reference (Class.forName) cannot name the id — no zeta row, a named abstain', () => {
    const r = deriveNeoForgeComponents([VERSIONED])
    assert.ok(!Object.keys(play(r)).some((id) => id.startsWith('zeta:')), 'no zeta channel claimed')
    assert.ok(r.diagnostics.abstains.some((a) => /NeoNetworking\.playToClient \(via fx\/ver\/lib\/NeoNetworking\.setupNetwork\): the mod-root walk reached this registration without a provable id/.test(a)), r.diagnostics.abstains.join(' | '))
  })

  it('the lifecycle order is the loader\'s: common-setup listeners (and their enqueueWork) run before the payload event, so a network built in common setup still registers', () => {
    const r = deriveNeoForgeComponents([VERSIONED])
    const phases = r.diagnostics.modRoot.phases
    assert.deepStrictEqual(phases.map((x) => x.event), ['FMLConstructModEvent', 'FMLCommonSetupEvent', 'FMLDedicatedServerSetupEvent', 'RegisterPayloadHandlersEvent'])
    assert.strictEqual(phases[1].listeners, 1, 'the eta common-setup listener')
    assert.strictEqual(phases[3].listeners, 1, 'one shared setupNetwork method reference (identical captures dedupe)')
    const p = play(r)
    assert.ok(p['eta:net/v2/etapacket'], `the network built in common setup registers: ${Object.keys(p).join(', ')}`)
    assert.strictEqual(p['eta:net/v2/etapacket'].version, 'v2')
  })

  describe('real jars, when present on this machine (NeoForge 26.1.2.109 rig)', () => {
    const mods = fs.existsSync(path.join(RIG, 'mods')) ? fs.readdirSync(path.join(RIG, 'mods')).filter((f) => f.endsWith('.jar')).map((f) => path.join(RIG, 'mods', f)) : []
    const puz = mods.find((f) => /PuzzlesLib/.test(f)); const mm = mods.find((f) => /MutantMonsters/.test(f))
    const rl = mods.find((f) => /ResourcefulLib/.test(f)); const faf = mods.find((f) => /friendsandfoes/.test(f))
    const loader = path.join(RIG, 'libraries/net/neoforged/neoforge/26.1.2.109/neoforge-26.1.2.109-universal.jar')
    const itIf = (cond) => (cond ? it : it.skip)
    itIf(puz && mm)('PuzzlesLib 26.1.14 + MutantMonsters 26.1.3: mutantmonsters:main/0..5 @"mutantmonsters:main", 0-3 clientbound, 4-5 serverbound (the live 26.1.2 server list, 2026-09-13)', () => {
      const r = deriveNeoForgeComponents([puz, mm])
      const p = play(r)
      for (let i = 0; i < 6; i++) {
        const row = p[`mutantmonsters:main/${i}`]
        assert.ok(row, `mutantmonsters:main/${i} (have ${Object.keys(p).join(', ')})`)
        assert.strictEqual(row.version, 'mutantmonsters:main')
        assert.strictEqual(row.flow, i < 4 ? 'clientbound' : 'serverbound')
      }
      assert.ok(!p['mutantmonsters:main/6'])
      assert.ok(!r.diagnostics.abstains.some((a) => /NeoForgeModConstructor\.lambda\$construct\$2: the registrar never reaches/.test(a)), 'the resolved listener no longer abstains')
    })
    itIf(rl && faf)('ResourcefulLib 4.0.1 + FriendsAndFoes 4.0.27: three friendsandfoes:networking/v1/friendsandfoes/<packet> ids @v1 clientbound, built in the common-setup listener', () => {
      const r = deriveNeoForgeComponents([rl, faf])
      const p = play(r)
      for (const n of ['moobloom_variants_sync_packet', 'entity_animations_sync_packet', 'totem_effect_packet']) {
        const row = p[`friendsandfoes:networking/v1/friendsandfoes/${n}`]
        assert.ok(row, `${n} (have ${Object.keys(p).join(', ')})`)
        assert.strictEqual(row.version, 'v1')
        assert.strictEqual(row.flow, 'clientbound')
      }
    })
    itIf(mods.length >= 13 && fs.existsSync(loader))('the 13-mod pack + loader jar: both families ride alongside the r2 rows (glitchcore configuration, loader built-ins incl. neoforge:recipe_content) with no dropped order', () => {
      const r = deriveNeoForgeComponents([...mods, loader])
      const p = play(r)
      assert.ok(p['mutantmonsters:main/5'] && p['friendsandfoes:networking/v1/friendsandfoes/totem_effect_packet'])
      assert.ok(p['neoforge:recipe_content'], 'loader built-in still claimed')
      assert.ok(r.components.configuration.find((c) => c.id === 'glitchcore:sync_config'))
      assert.strictEqual(r.diagnostics.modRoot.droppedUnprovenOrder, 0)
      assert.strictEqual(r.diagnostics.modRoot.budgetExhausted, false)
    })
  })
})
