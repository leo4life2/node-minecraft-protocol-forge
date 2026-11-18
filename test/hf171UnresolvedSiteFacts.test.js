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
