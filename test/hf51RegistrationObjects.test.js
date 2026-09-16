/* eslint-env mocha */
// HF51 — REGISTRATION OBJECTS: a RegisterPayloadHandlersEvent listener that
// iterates a registration object / collection whose elements (payload type +
// codec + handler) were built elsewhere — by another mod through a library
// (a per-mod registration object keyed by mod id, created reflectively and
// subscribed to the mod's own bus), or reflectively from a message class —
// derives every element's id + flow + version under the mod-root walk:
//   * keyed stores by object identity (Map / guava Table get/put/row, entrySet)
//   * reflective construction (Class.getConstructor(..).newInstance(..))
//   * bus.register(object) subscribes its @SubscribeEvent lifecycle methods
//   * instanceof / equals / Set.contains decided on universe values
//   * the version claim = the registrar(...) / versioned(...) ARGUMENT (a
//     zero-argument String helper such as "v" + ModList version is a
//     constant), the mods.toml version only when the registrar is unversioned
//   * the walk's budget is per unit (root constructor / listener), named
//     when exhausted, never a silent stop
// Fixtures are the REAL jars of the 26.3 NeoForge pack trimmed to their
// registration classes (tools/trim-packet-wire-fixture.js) + one synthetic
// mutated class (synthJar) for the unresolved-required label.
const assert = require('assert')
const path = require('path')
const fs = require('fs'); const os = require('os')
const { buildClass, buildJar } = require('./helpers/synthJar')
const { deriveNeoForgeComponents } = require('../src/client/neoForgePayloadDerivation')
const FX = path.join(__dirname, 'fixtures')
const BALM = path.join(FX, 'hf51-balm-26.3.0.1.trimmed.jar')
const WAYSTONES = path.join(FX, 'hf51-waystones-26.3.0.1.trimmed.jar')
const CAR = path.join(FX, 'hf51-car-1.0.49.trimmed.jar')
const SC = path.join(FX, 'hf51-securitycraft-1.10.2.1.trimmed.jar')
const play = (r) => Object.fromEntries(r.components.play.map((c) => [c.id, c]))
const EVENT = 'net/neoforged/neoforge/network/event/RegisterPayloadHandlersEvent'
const REG = 'net/neoforged/neoforge/network/registration/PayloadRegistrar'
const TYPE = 'net/minecraft/network/protocol/common/custom/CustomPacketPayload$Type'
const CODEC = 'net/minecraft/network/codec/StreamCodec'
const HANDLER = 'net/neoforged/neoforge/network/handling/IPayloadHandler'

// the 32 channels the 26.3 server REQUIRED and refused as unclaimed (v263 lane-fresh1), with the flows it named (lane-fresh2)
const WAYSTONES_REQUIRED = {
  'waystones:edit_waystone': 'serverbound',
  'waystones:edit_waystone_group': 'serverbound',
  'waystones:epitaph_activation': 'clientbound',
  'waystones:inventory_button': 'serverbound',
  'waystones:known_waystones': 'clientbound',
  'waystones:personal_waystone_settings': 'serverbound',
  'waystones:remove_waystone': 'serverbound',
  'waystones:remove_waystone_group': 'serverbound',
  'waystones:request_edit_waystone': 'serverbound',
  'waystones:request_inventory_button': 'serverbound',
  'waystones:request_manage_waystone_modifiers': 'serverbound',
  'waystones:select_waystone': 'serverbound',
  'waystones:sort_waystone': 'serverbound',
  'waystones:sort_waystone_group': 'serverbound',
  'waystones:sorting_index': 'clientbound',
  'waystones:teleport_effect': 'clientbound',
  'waystones:update_waystone': 'clientbound',
  'waystones:waystone_groups': 'clientbound',
  'waystones:waystone_removed': 'clientbound'
}
// the 15 car channels and the flows the server named (lane-fresh2)
const CAR_REQUIRED = {
  'car:car_gui': 'serverbound',
  'car:car_horn': 'serverbound',
  'car:center_car': 'serverbound',
  'car:center_car_client': 'clientbound',
  'car:control_car': 'serverbound',
  'car:crash': 'serverbound',
  'car:edit_license_plate': 'serverbound',
  'car:edit_sign': 'serverbound',
  'car:gas_station_amount': 'serverbound',
  'car:open_car_workshop': 'serverbound',
  'car:repair_car': 'serverbound',
  'car:spawn_car': 'serverbound',
  'car:start_fuel': 'serverbound',
  'car:starting': 'serverbound',
  'car:sync_block_entity': 'clientbound'
}

describe('HF51 — registration objects iterated by the listener (real jars trimmed)', function () {
  this.timeout(60000)

  it('per-mod registration OBJECT through a library (Balm 26.3 + Waystones): 19 required channels, id + flow + the registrar(modId) version, none optional, receipt names the version source', () => {
    const r = deriveNeoForgeComponents([BALM, WAYSTONES])
    const p = play(r)
    for (const [id, flow] of Object.entries(WAYSTONES_REQUIRED)) {
      assert.ok(p[id], `${id} derived (have ${Object.keys(p).join(', ')}; abstains: ${r.diagnostics.abstains.join(' | ')})`)
      assert.strictEqual(p[id].flow, flow, `${id} flow`)
      assert.strictEqual(p[id].version, 'waystones', `${id} version = the registrar(modId) argument, not the mods.toml 26.3.0.1`)
      assert.strictEqual(p[id].optional, false, `${id} required (isClientOnly/isServerOnly decided by Set.contains)`)
      assert.strictEqual(p[id].versionFrom, 'registrar-argument')
    }
    assert.strictEqual(Object.keys(p).filter((id) => id.startsWith('waystones:')).length, 19)
    assert.ok(!r.diagnostics.abstains.some((a) => /waystones/.test(a)), r.diagnostics.abstains.join(' | '))
    assert.ok(!r.diagnostics.abstains.some((a) => /Registrations.*safely unclaimed/.test(a)), 'the entry-pass abstain on the registration object is covered by the walk: ' + r.diagnostics.abstains.join(' | '))
    assert.ok(Array.isArray(r.diagnostics.modRootCovered) && r.diagnostics.modRootCovered.length >= 1)
    const walk = r.diagnostics.modRoot
    assert.ok(walk.listenerSites.some((s) => /Registrations\.registerPayloadHandlers$/.test(s)), 'bus.register(object) subscribed the registration object: ' + walk.listenerSites.join(' ; '))
    assert.strictEqual(walk.budgetExhausted, false)
    assert.deepStrictEqual(walk.exhaustedUnits, [])
    assert.ok(walk.unitBudget > 0 && walk.totalBudget > walk.unitBudget)
  })

  it('reflective message instances (car 1.0.49: registerMessage(registrar, Class) -> getDeclaredConstructor().newInstance().type()/getExecutingSide()): 15 required channels, flow by the enum equals, version = versioned("0")', () => {
    const r = deriveNeoForgeComponents([CAR])
    const p = play(r)
    for (const [id, flow] of Object.entries(CAR_REQUIRED)) {
      assert.ok(p[id], `${id} derived (have ${Object.keys(p).join(', ')}; abstains: ${r.diagnostics.abstains.join(' | ')})`)
      assert.strictEqual(p[id].flow, flow, `${id} flow = the flow the server named`)
      assert.strictEqual(p[id].version, '0')
      assert.strictEqual(p[id].optional, false)
      assert.strictEqual(p[id].versionFrom, 'versioned-argument')
    }
    assert.ok(!r.diagnostics.abstains.some((a) => /CommonRegistry/.test(a)), r.diagnostics.abstains.join(' | '))
  })

  it('versioned(helper()) with a ZERO-argument String helper ("v" + ModList version, SecurityCraft 1.10.2.1): 47 channels at "v1.10.2.1-beta1" from the versioned argument, never the mods.toml "1.10.2.1-beta1"', () => {
    const r = deriveNeoForgeComponents([SC])
    const rows = r.components.play.filter((c) => c.id.startsWith('securitycraft:'))
    assert.strictEqual(rows.length, 47, r.diagnostics.abstains.join(' | '))
    assert.ok(rows.every((c) => c.version === 'v1.10.2.1-beta1'), rows.map((c) => `${c.id}@${c.version}`).slice(0, 3).join(', '))
    assert.ok(rows.every((c) => c.versionFrom === 'versioned-argument' && c.versionSource === 'constant'))
    assert.ok(rows.every((c) => c.optional === false))
  })

  it('the whole 26.3 pack (when the rig jars are present): every id the server refused in the v263 lanes is derived with its flow and version, first try', function () {
    const RIG = '/private/tmp/claude-501/-Users-nemossoftware-Desktop-Nemos-minepal-root-minepal-v0/7d543de9-8a73-4a9b-ad7b-62b5856980da/scratchpad/hf51/rig/nf263/mods'
    if (!fs.existsSync(RIG)) return this.skip()
    const jars = fs.readdirSync(RIG).filter((f) => f.endsWith('.jar')).map((f) => path.join(RIG, f))
    if (jars.length < 15) return this.skip()
    const r = deriveNeoForgeComponents(jars)
    const p = play(r)
    for (const id of [...Object.keys(WAYSTONES_REQUIRED), ...Object.keys(CAR_REQUIRED), 'cookingforblockheads:request_selection_recipes', 'spookydoors:door_state', 'securitycraft:toggle_option']) assert.ok(p[id] && !p[id].optional, `${id} claimed required`)
    assert.strictEqual(p['cookingforblockheads:request_selection_recipes'].version, 'cookingforblockheads')
    assert.strictEqual(p['spookydoors:door_state'].version, 'spookydoors')
    assert.strictEqual(p['securitycraft:toggle_option'].version, 'v1.10.2.1-beta1')
    assert.strictEqual(r.diagnostics.modRoot.budgetExhausted, false)
    assert.deepStrictEqual(r.diagnostics.modRoot.exhaustedUnits, [])
  })
})

describe('HF51 — the unresolved-required label and the walk budget (synthetic)', function () {
  it('an element the walk cannot resolve under an `.optional()` it could not decide is abstained as unresolved-required BY NAME — never "safely unclaimed"', () => {
    const name = 'fx/hf51/Mut'
    const cls = buildClass({
      name,
      fields: [{ name: 'CODEC', desc: `L${CODEC};` }],
      methods: [{
        name: 'onReg',
        desc: `(L${EVENT};)V`,
        flags: 0x0009,
        code: (a) => a
          .aload(0).ldcStr('1').invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`).astore(1)
          .invokestatic('fx/hf51/Gone', 'flag', '()Z').ifeq(8) // Gone is not in the jar: undecided
          .aload(1).invokevirtual(REG, 'optional', `()L${REG};`).astore(1)
          .aload(1).invokestatic('fx/hf51/Gone', 'type', `()L${TYPE};`).getstatic(name, 'CODEC', `L${CODEC};`).aconstNull()
          .invokevirtual(REG, 'playToServer', `(L${TYPE};L${CODEC};L${HANDLER};)L${REG};`).pop().ret()
      }]
    })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf51-mut-'))
    const jar = path.join(dir, 'mut.jar')
    fs.writeFileSync(jar, buildJar([{ name: `${name}.class`, data: cls }, { name: 'META-INF/neoforge.mods.toml', data: Buffer.from('modLoader="javafml"\nloaderVersion="[4,)"\nlicense="x"\n[[mods]]\nmodId="mut"\nversion="1.0"\n') }]))
    const r = deriveNeoForgeComponents([jar])
    assert.strictEqual(r.components.play.length, 0)
    const named = r.diagnostics.abstains.filter((a) => a.startsWith(`${name}: playToServer`))
    assert.strictEqual(named.length, 1, r.diagnostics.abstains.join(' | '))
    assert.ok(/unresolved-required/.test(named[0]) && /NOT safely unclaimed/.test(named[0]), named[0])
    assert.ok(!/safely unclaimed$/.test(named[0]))
  })
})
