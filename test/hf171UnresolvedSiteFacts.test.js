/* eslint-env mocha */
// HF171 — a give-up of the payload reader hands its facts over beside its
// sentence. Until now an unresolved registration left only a sentence in
// diagnostics.abstains; what the walk SAW there (the registration method, so
// the phase and the direction; the registrar's version; the jar) was dropped.
// Now each give-up a server can refuse for also writes one row into
// diagnostics.unresolvedSites. The sentences and the claims are unchanged
// (pinned against a golden made on the commit before this change).
//
// Fixtures (test/fixtures/hf171, four small made mods, 23 KB in all):
//   control  one play payload to the client, version 7, a constant id
//   a        the same, its id built from a counter two listeners advance
//   a2       the same, its id made from a class's name at run time
//   b        a plus a set-up task with two set-up payloads on run-time ids
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const D = require('../src/client/neoForgePayloadDerivation')
const os = require('os')
const { mutateJar } = require('./helpers/jarMutate')
const { buildContentModJar } = require('./helpers/hf171AnnotationJar')

const FIX = path.join(__dirname, 'fixtures', 'hf171')
const GOLDEN = JSON.parse(fs.readFileSync(path.join(FIX, 'base-golden.json'), 'utf8'))
const read = (name) => D.deriveNeoForgeComponents([path.join(FIX, name)])
const rowsOf = (r) => (r.diagnostics.unresolvedSites || [])
  .map((s) => [s.kind, s.jar, s.method, (s.protocols || []).join('+') || null, s.flow, s.version, s.id])
  .sort((x, y) => JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)

describe('HF171: an unresolved registration hands over what the walk saw', () => {
  it('the sentences and the claims of the four jars are those of the commit before', () => {
    for (const name of Object.keys(GOLDEN)) {
      const r = read(name)
      assert.deepStrictEqual(r.diagnostics.abstains, GOLDEN[name].abstains, `${name}: the sentences`)
      assert.deepStrictEqual(r.components, GOLDEN[name].components, `${name}: the claims`)
    }
    assert.strictEqual(Object.keys(GOLDEN).length, 4)
  })

  it('a constant id: the claim stands and no site is unresolved', () => {
    const r = read('hf171control-3.2.1.jar')
    assert.deepStrictEqual(r.components.play.map((c) => [c.id, c.version, c.flow, c.optional]), [['hf171control:notice', '7', 'clientbound', false]])
    assert.deepStrictEqual(r.diagnostics.unresolvedSites || [], [])
  })

  it('an id from a counter two listeners advance: the registration is handed over with its method, direction and version; the listener that registers nothing is not an unresolved registration', () => {
    const r = read('hf171a-3.2.1.jar')
    assert.deepStrictEqual(rowsOf(r), [
      ['registration', 'hf171a-3.2.1.jar', 'playToClient', 'play', 'clientbound', '7', null]
    ])
    assert.strictEqual(r.diagnostics.abstains.length, 2, 'the listener that registers nothing keeps its sentence and writes no row')
    assert.ok(r.diagnostics.unresolvedSites.every((s) => typeof s.says === 'string' && r.diagnostics.abstains.includes(s.says)), 'each row names its sentence')
  })

  it('an id made from a class name at run time: both walks that met the registration hand over the same facts', () => {
    const r = read('hf171a2-3.2.1.jar')
    assert.deepStrictEqual(rowsOf(r), [
      ['registration', 'hf171a2-3.2.1.jar', 'playToClient', 'play', 'clientbound', '7', null],
      ['registration', 'hf171a2-3.2.1.jar', 'playToClient', 'play', 'clientbound', '7', null]
    ])
  })

  it('a mod with unresolved payloads in both phases: every site with its own phase and direction, one version', () => {
    const r = read('hf171b-3.2.1.jar')
    assert.deepStrictEqual(rowsOf(r), [
      ['registration', 'hf171b-3.2.1.jar', 'configurationToClient', 'configuration', 'clientbound', '7', null],
      ['registration', 'hf171b-3.2.1.jar', 'configurationToClient', 'configuration', 'clientbound', '7', null],
      ['registration', 'hf171b-3.2.1.jar', 'configurationToServer', 'configuration', 'serverbound', '7', null],
      ['registration', 'hf171b-3.2.1.jar', 'configurationToServer', 'configuration', 'serverbound', '7', null],
      ['registration', 'hf171b-3.2.1.jar', 'playToClient', 'play', 'clientbound', '7', null]
    ])
  })

  it('the rows ride a unit result and the assembly (a kept per-jar result keeps them)', () => {
    const jar = path.join(FIX, 'hf171a2-3.2.1.jar')
    const { perJar, read: rd } = D.deriveNeoForgeComponentsPerJar([jar])
    const again = D.assembleNeoForgeComponents(rd, JSON.parse(JSON.stringify(perJar)))
    assert.strictEqual((again.diagnostics.unresolvedSites || []).length, 2)
    assert.deepStrictEqual(again.diagnostics.abstains, GOLDEN['hf171a2-3.2.1.jar'].abstains)
  })
})

// ---- the mend round (the desk's rulings after the first check) ----
const FX = path.join(__dirname, 'fixtures')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hf171-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true })) // a root hook: after the last case of the run
let made = 0
const readBytes = (buf, name) => {
  const dir = path.join(tmp, String(made++))
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, name), buf)
  return D.deriveNeoForgeComponents([path.join(dir, name)])
}
const bend = (buf, cls, from, to) => {
  const m = mutateJar(buf, { rewrite: (p, str) => (cls.test(p) && str === from ? to : undefined) })
  assert.ok(m.changed > 0, `the bend of ${from} changed nothing`)
  return m.buf
}
// the rows of the sentences that match, each row beside a sentence the reading wrote
const rowsSaying = (r, re) => {
  const rows = (r.diagnostics.unresolvedSites || []).filter((row) => re.test(row.says))
  assert.ok(rows.every((row) => r.diagnostics.abstains.includes(row.says)), 'each row names its sentence')
  return rows.map((row) => [row.kind, row.jar, row.site, row.method, row.flow, row.version, row.id])
}
const sentences = (r, re) => r.diagnostics.abstains.filter((a) => re.test(a)).length

describe('HF171 mend: a give-up that can leave a required registration unseen is a row beside its sentence', function () {
  this.timeout(60000)

  it('a listener subscribed only while another mod is loaded, that mod not in the pack: the skipped entry is a row of kind unread in its jar', () => {
    const name = 'hf127-elytraslot-neoforge-9.0.2+1.21.1.trimmed.jar'
    const r = D.deriveNeoForgeComponents([path.join(FX, name)])
    const gates = r.diagnostics.presenceGates.filter((g) => g.kind === 'mod_presence' && g.claimed === false)
    assert.strictEqual(gates.length, 1)
    assert.deepStrictEqual(rowsSaying(r, /registrations gated on mod presence — .* subscribes it only when /), gates.map((g) => ['unread', name, g.site, null, null, null, null]))
  })

  it('a listener subscribed only under a launch flag: the skipped entry is a row of kind unread in its jar', () => {
    const name = 'hf106-embeddium-1.0.15+mc1.21.1.trimmed.jar'
    const r = D.deriveNeoForgeComponents([path.join(FX, name)])
    const gates = r.diagnostics.presenceGates.filter((g) => g.kind === 'jvm_property')
    assert.strictEqual(gates.length, 1)
    assert.deepStrictEqual(rowsSaying(r, /registrations gated on a JVM flag — /), gates.map((g) => ['unread', name, g.site, null, null, null, null]))
  })

  it('an entry built only while another mod is in the pack, that mod absent: each skipped entry is a row of kind unread in its jar', () => {
    const name = 'sophisticatedcore-1.5.0-mc26.1.2.trimmed.jar'
    const r = D.deriveNeoForgeComponents([path.join(FX, name)])
    const gates = r.diagnostics.presenceGates.filter((g) => !g.kind && g.present === false)
    assert.strictEqual(gates.length, 2)
    assert.deepStrictEqual(rowsSaying(r, /registrations gated on mod presence — .* decides construction, /), gates.map((g) => ['unread', name, g.site, null, null, null, null]))
  })

  // the registry that lists its payloads by an annotation (a made jar): each proof the reader can lose
  const REG = 'hf171reg-1.0.jar'
  const SITE = 'synth/reg/ContentRegistry.registerPacket'
  const registry = buildContentModJar()
  const required = (buf) => bend(buf, /ContentRegistry\.class$/, 'optional', 'optionax') // the registrar no longer asks for optional
  const noRows = (r) => assert.deepStrictEqual(r.diagnostics.unresolvedSites || [], [])

  it('the annotation registry read whole, optional or required: its payloads are claimed and no row is written', () => {
    for (const buf of [registry, required(registry)]) {
      const r = readBytes(buf, REG)
      assert.strictEqual(r.components.configuration.length + r.components.play.length, 5)
      noRows(r)
    }
  })

  it('the annotation class is not provable: the registry is a row of kind unread', () => {
    const r = readBytes(buildContentModJar({ annotationConst: false }), REG)
    assert.deepStrictEqual(rowsSaying(r, /annotation-registry idiom without a provable annotation class$/), [['unread', REG, SITE, null, null, null, null]])
    assert.strictEqual((r.diagnostics.unresolvedSites || []).length, 1)
  })

  it('the helper that makes the ids does not prove a namespace: the registry is a row of kind unread', () => {
    const r = readBytes(bend(registry, /Ids\.class$/, 'toLowerCase', 'toUpperCase'), REG)
    assert.deepStrictEqual(rowsSaying(r, /id-formula helper did not prove a namespace \+ lowercase transform$/), [['unread', REG, SITE, null, null, null, null]])
    assert.strictEqual((r.diagnostics.unresolvedSites || []).length, 1)
  })

  it('the switch over the directions proves no mapping: the registry is a row of kind unread', () => {
    const r = readBytes(bend(registry, /ContentRegistry\$1\.class$/, 'ordinal', 'ordinax'), REG)
    assert.deepStrictEqual(rowsSaying(r, /direction switch did not prove an enum->registrar mapping$/), [['unread', REG, SITE, null, null, null, null]])
    assert.strictEqual((r.diagnostics.unresolvedSites || []).length, 1)
  })

  it('the version of the registrar is not derivable: a required registry is a row of kind unread, a registry proven optional keeps its sentence and writes none', () => {
    const r = readBytes(required(buildContentModJar({ versionConst: false })), REG)
    assert.deepStrictEqual(rowsSaying(r, /annotation registry with no derivable registrar version$/), [['unread', REG, SITE, null, null, null, null]])
    const optional = readBytes(buildContentModJar({ versionConst: false }), REG)
    assert.strictEqual(sentences(optional, /annotation registry with no derivable registrar version$/), 1)
    noRows(optional)
  })

  it('no class provably carries the annotation: a required registry is a row of kind unread, a registry proven optional keeps its sentence and writes none', () => {
    const empty = bend(registry, /\/pk\//, 'Lsynth/reg/Ann;', 'Lsynth/reg/Anx;')
    const r = readBytes(required(empty), REG)
    assert.deepStrictEqual(rowsSaying(r, /annotation registry with an empty provable census$/), [['unread', REG, SITE, null, null, null, null]])
    assert.strictEqual((r.diagnostics.unresolvedSites || []).length, 1)
    const optional = readBytes(empty, REG)
    assert.strictEqual(sentences(optional, /annotation registry with an empty provable census$/), 1)
    noRows(optional)
  })

  it('one payload names a direction the switch does not map: a required registry hands over that id with the version of the registry and no direction, a registry proven optional keeps its sentence and writes none', () => {
    const odd = bend(registry, /DeltaActionPacket\.class$/, 'PLAY_TO_SERVER', 'PLAY_TO_NOBODY')
    const r = readBytes(required(odd), REG)
    assert.deepStrictEqual(rowsSaying(r, /^contentmod:deltaactionpacket: direction PLAY_TO_NOBODY has no proven registrar mapping/), [['undecided', REG, SITE, null, null, '2.7.0', 'contentmod:deltaactionpacket']])
    assert.strictEqual((r.diagnostics.unresolvedSites || []).length, 1)
    assert.strictEqual(r.components.configuration.length + r.components.play.length, 4, 'the other four payloads stay claimed')
    const optional = readBytes(odd, REG)
    assert.strictEqual(sentences(optional, /direction PLAY_TO_NOBODY has no proven registrar mapping/), 1)
    noRows(optional)
  })
})

describe('HF171 mend: a registration proven optional is no unresolved site', function () {
  this.timeout(60000)
  const OPT = 'hf171opt-3.2.1.jar'
  const jar = fs.readFileSync(path.join(FIX, OPT))
  const claims = (r) => r.components.play.map((c) => [c.id, c.version, c.flow, c.optional])
  const STEADY = [['hf171opt:steady', '7', 'clientbound', false]]

  it('the made jar (a required payload under a constant id, an optional payload under an id from a counter two listeners advance, an optional payload under a version made at run time): no row, the required payload claimed, each sentence kept', () => {
    const r = read(OPT)
    assert.deepStrictEqual(r.diagnostics.unresolvedSites || [], [])
    assert.deepStrictEqual(claims(r), STEADY)
    assert.strictEqual(sentences(r, /registry-counter ids \(hf171opt:p1\) .* the registration order is not provable, unclaimed$/), 1)
    assert.ok(sentences(r, /^hf171opt:late: optional channel with unresolved version — safely unclaimed$/) >= 1)
    assert.deepStrictEqual(r.listenOnly, ['hf171opt:late'])
  })

  it('the same jar, the id of the optional payload made by a call the walk does not fold: no row, its sentence kept', () => {
    const r = readBytes(bend(jar, /Numbered\.class$/, 'withSuffix', 'withTail'), OPT)
    assert.deepStrictEqual(r.diagnostics.unresolvedSites || [], [])
    assert.deepStrictEqual(claims(r), STEADY)
    assert.strictEqual(sentences(r, /the mod-root walk reached this registration without a provable id/), 1)
  })

  it('the same jar read without its mod class (the entry pass meets the registration alone): no row, its sentence says safely unclaimed', () => {
    const r = readBytes(bend(jar, /RigMod\.class$/, 'Lnet/neoforged/fml/common/Mod;', 'Lnet/neoforged/fml/common/Mox;'), OPT)
    assert.deepStrictEqual(r.diagnostics.unresolvedSites || [], [])
    assert.deepStrictEqual(claims(r), STEADY)
    assert.strictEqual(sentences(r, /playToClient optional registration with unresolved payload type id — safely unclaimed$/), 1)
  })

  it('the control: the same registrations with the request for optional taken away are a row each way (the cases above can see a row)', () => {
    const required = bend(jar, /RigMod\.class$/, 'optional', 'optionax')
    assert.deepStrictEqual(rowsOf(readBytes(required, OPT)), [['registration', OPT, 'playToClient', 'play', 'clientbound', '7', null]])
    assert.deepStrictEqual(rowsOf(readBytes(bend(required, /Numbered\.class$/, 'withSuffix', 'withTail'), OPT)), [['registration', OPT, 'playToClient', 'play', 'clientbound', '7', null]])
  })
})
