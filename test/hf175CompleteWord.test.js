/* eslint-env mocha */
// HF175 - the places where a reading still left NO row for something a server
// can refuse the pal for:
//   K1  a registration whose optional() the walk did not decide (it stands
//       under a condition, in the listener or in a caller of the helper that
//       makes the call) and whose version is not derivable said "safely
//       unclaimed" and handed over no row: in the listener's own registration
//       and in a registration several call sites share (the aggregator's row
//       did not carry whether optional was decided)
//   K2  an entry whose registrar never reaches a registration, a jar that
//       could not be read, a nested jar that could not be read and a jar in
//       which a class asks the event for a registrar in code no entry leads to
//       wrote a sentence (or nothing) and no row
// Each made jar has a TWIN that must stay as it is (optional() unconditional,
// its condition decided, the registrar reaching its registration): no row.
// The claims and the listen-only ids of every made jar are those of the commit
// before (fixtures/hf175/base-golden.json was made there): this change hands
// over rows and changes no claim.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const D = require('../src/client/neoForgePayloadDerivation')
const J = require('./helpers/hf175Jars')

const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hf175', 'base-golden.json'), 'utf8'))
const JARS = {
  'k-direct-undecided.jar': () => J.direct('undecided'),
  'k-direct-plain.jar': () => J.direct('plain'),
  'k-direct-decided.jar': () => J.direct('decided'),
  'k-direct-callee.jar': () => J.direct('callee'),
  'k-direct-calleeplain.jar': () => J.direct('calleePlain'),
  'k-direct-none.jar': () => J.direct('none'),
  'k-direct-claimed.jar': () => J.direct('none', { version: '7' }),
  'k-shared-undecided.jar': () => J.shared('undecided'),
  'k-shared-plain.jar': () => J.shared('plain'),
  'k-shared-decided.jar': () => J.shared('decided'),
  'k-shared-callee.jar': () => J.shared('callee'),
  'k-shared-calleeplain.jar': () => J.shared('calleePlain'),
  'k-shared-none.jar': () => J.shared('none'),
  'k-silent.jar': () => J.silent(),
  'k-late.jar': () => J.late('asks'),
  'k-late-lib.jar': () => J.late('lib'),
  'k-late-entry.jar': () => J.late('entry'),
  'k-garbage.jar': () => J.garbage(),
  'k-nested-bad.jar': () => J.nestedBad()
}

describe('HF175: the word of a reading, its remaining places', function () {
  this.timeout(60000)
  let dir
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf175-')) })
  after(() => { fs.rmSync(dir, { recursive: true, force: true }) })
  const read = (name) => { const p = path.join(dir, name); fs.writeFileSync(p, JARS[name]()); return D.deriveNeoForgeComponents([p]) }
  const rows = (r) => (r.diagnostics.unresolvedSites || [])
    .map((s) => [s.kind, s.jar, s.method, (s.protocols || []).join('+') || null, s.flow, s.version, s.id])
    .sort((x, y) => JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)
  const sentences = (r, re) => r.diagnostics.abstains.filter((a) => re.test(a)).length
  const noRow = (r) => assert.deepStrictEqual(r.diagnostics.unresolvedSites || [], [])
  const everyRowNamesItsSentence = (r) => assert.ok((r.diagnostics.unresolvedSites || []).every((s) => typeof s.says === 'string' && s.says !== ''), 'each row names its sentence')
  const SAFELY = /safely unclaimed$/

  it('G the claims and the listen-only ids of every made jar are those of the commit before (no claim row leaves, none is added, no tuple changes)', () => {
    for (const name of Object.keys(JARS)) {
      const r = read(name)
      assert.deepStrictEqual(r.components, GOLDEN[name].components, `${name}: the claims`)
      assert.deepStrictEqual(r.listenOnly || [], GOLDEN[name].listenOnly, `${name}: the listen-only ids`)
    }
    assert.strictEqual(Object.keys(GOLDEN).length, Object.keys(JARS).length)
  })

  describe('K1 the listener\'s own registration, its version not derivable', () => {
    it('D1 optional() under a condition the walk cannot decide: one row of kind version with the id, the method and the direction; no sentence says safely unclaimed', () => {
      const r = read('k-direct-undecided.jar')
      assert.deepStrictEqual(rows(r), [['version', 'k-direct-undecided.jar', 'playToClient', 'play', 'clientbound', null, 'kmod:direct']])
      assert.strictEqual(sentences(r, SAFELY), 0)
      assert.strictEqual(sentences(r, /^kmod:direct: .*NOT safely unclaimed/), 1)
      everyRowNamesItsSentence(r)
    })
    it('D1t the twin, optional() unconditional: proven optional, its sentence kept, no row', () => {
      const r = read('k-direct-plain.jar')
      noRow(r)
      assert.deepStrictEqual(r.diagnostics.abstains, GOLDEN['k-direct-plain.jar'].abstains)
      assert.strictEqual(sentences(r, /^kmod:direct: optional channel with unresolved version — safely unclaimed$/), 1)
    })
    it('D2 optional() inside a helper of the mod that is called under an undecided condition: one row of kind version', () => {
      const r = read('k-direct-callee.jar')
      assert.deepStrictEqual(rows(r), [['version', 'k-direct-callee.jar', 'playToClient', 'play', 'clientbound', null, 'kmod:direct']])
      assert.strictEqual(sentences(r, SAFELY), 0)
    })
    it('D2t the twin, the same helper called unconditionally: proven optional, no row', () => {
      const r = read('k-direct-calleeplain.jar')
      noRow(r)
      assert.deepStrictEqual(r.diagnostics.abstains, GOLDEN['k-direct-calleeplain.jar'].abstains)
    })
    it('D3 a required registration: one row of kind version, as before', () => {
      const r = read('k-direct-none.jar')
      assert.deepStrictEqual(rows(r), [['version', 'k-direct-none.jar', 'playToClient', 'play', 'clientbound', null, 'kmod:direct']])
      assert.deepStrictEqual(r.diagnostics.abstains, GOLDEN['k-direct-none.jar'].abstains)
    })
  })

  describe('K1 a registration several call sites share (the aggregator\'s row), its version not derivable', () => {
    it('A1 optionality undecided: a row of kind version for each id, in one jar, with the direction; no sentence says safely unclaimed', () => {
      const r = read('k-shared-undecided.jar')
      assert.deepStrictEqual(rows(r), [
        ['version', 'k-shared-undecided.jar', null, 'play', 'clientbound', null, 'kmod:one'],
        ['version', 'k-shared-undecided.jar', null, 'play', 'clientbound', null, 'kmod:two']
      ])
      assert.strictEqual(new Set(r.diagnostics.unresolvedSites.map((s) => s.jar)).size, 1)
      assert.strictEqual(sentences(r, SAFELY), 0)
      assert.strictEqual(sentences(r, /^kmod:(one|two): aggregated .*NOT safely unclaimed/), 2)
      everyRowNamesItsSentence(r)
    })
    it('A1t the twin, proven optional (the call unconditional): its sentences kept, no row', () => {
      const r = read('k-shared-plain.jar')
      noRow(r)
      assert.deepStrictEqual(r.diagnostics.abstains, GOLDEN['k-shared-plain.jar'].abstains)
      assert.strictEqual(sentences(r, /^kmod:(one|two): aggregated optional channel with unresolved version — safely unclaimed$/), 2)
    })
    it('A2t the twin, the condition decided (a constant): proven optional, no row', () => {
      const r = read('k-shared-decided.jar')
      noRow(r)
      assert.deepStrictEqual(r.diagnostics.abstains, GOLDEN['k-shared-decided.jar'].abstains)
    })
    it('A3 required: a row of kind version for each id, as before', () => {
      const r = read('k-shared-none.jar')
      assert.deepStrictEqual(rows(r), [
        ['version', 'k-shared-none.jar', null, 'play', 'clientbound', null, 'kmod:one'],
        ['version', 'k-shared-none.jar', null, 'play', 'clientbound', null, 'kmod:two']
      ])
      assert.deepStrictEqual(r.diagnostics.abstains, GOLDEN['k-shared-none.jar'].abstains)
    })
    it('A4 optional() inside a helper called under an undecided condition, the id not provable at the shared call: the registration is handed over, never safely unclaimed', () => {
      const r = read('k-shared-callee.jar')
      assert.ok(rows(r).length >= 1, 'at least one row')
      for (const row of rows(r)) assert.deepStrictEqual(row, ['registration', 'k-shared-callee.jar', 'playToClient', 'play', 'clientbound', null, null])
      assert.strictEqual(sentences(r, SAFELY), 0)
      assert.ok(sentences(r, /NOT safely unclaimed/) >= 1)
    })
    it('A4t the twin, the same helper called unconditionally: proven optional, its sentence kept, no row', () => {
      const r = read('k-shared-calleeplain.jar')
      noRow(r)
      assert.deepStrictEqual(r.diagnostics.abstains, GOLDEN['k-shared-calleeplain.jar'].abstains)
    })
  })

  describe('K2 nothing of a registration was seen', () => {
    it('S1 the registrar never reaches a registration: its sentence as before and ONE row of its jar (kind unseen, the entry)', () => {
      const r = read('k-silent.jar')
      assert.deepStrictEqual(r.diagnostics.abstains, GOLDEN['k-silent.jar'].abstains, 'the sentence is the one of before')
      assert.deepStrictEqual(rows(r), [['unseen', 'k-silent.jar', null, null, null, null, null]])
      assert.strictEqual(r.diagnostics.unresolvedSites[0].site, `${J.INIT}.onRegister`)
      assert.strictEqual(r.diagnostics.unresolvedSites[0].says, r.diagnostics.abstains[0])
    })
    it('S1t the twin, the registrar reaches its registration and the id and the version are constants: claimed, no row', () => {
      const r = read('k-direct-claimed.jar')
      noRow(r)
      assert.deepStrictEqual(r.components.play.map((c) => [c.id, c.version, c.flow, c.optional]), [['kmod:direct', '7', 'clientbound', false]])
    })
    it('J1 a jar whose class asks the event for a registrar in a method that does not take the event (no entry leads to it): the reading held nothing of it; now ONE row of the jar (kind unseen, the class)', () => {
      const r = read('k-late.jar')
      assert.deepStrictEqual(rows(r), [['unseen', 'k-late.jar', null, null, null, null, null]])
      assert.strictEqual(r.diagnostics.unresolvedSites[0].site, J.LATE)
      assert.strictEqual(r.diagnostics.abstains.length, 1)
      everyRowNamesItsSentence(r)
    })
    it('J1t the twin, a jar whose class only RECEIVES a registrar and that nothing hands one (a library nobody uses): no row, no sentence', () => {
      const r = read('k-late-lib.jar')
      noRow(r)
      assert.deepStrictEqual(r.diagnostics.abstains, [])
    })
    it('J2t the twin, that helper reached from a listener of the jar: claimed, no row, no sentence', () => {
      const r = read('k-late-entry.jar')
      noRow(r)
      assert.deepStrictEqual(r.diagnostics.abstains, [])
      assert.deepStrictEqual(r.components.play.map((c) => [c.id, c.version, c.flow]), [['kmod:late', '1', 'clientbound']])
    })
    it('U1 a jar that cannot be opened: ONE row of that jar (kind unseen)', () => {
      const r = D.deriveNeoForgeComponents([path.join(dir, 'k-missing.jar')])
      assert.deepStrictEqual(rows(r), [['unseen', 'k-missing.jar', null, null, null, null, null]])
      assert.strictEqual(r.diagnostics.errors.filter((e) => /^k-missing\.jar: unreadable/.test(e)).length, 1)
    })
    it('U2 a jar that is no zip: ONE row of that jar (kind unseen)', () => {
      const r = read('k-garbage.jar')
      assert.deepStrictEqual(rows(r), [['unseen', 'k-garbage.jar', null, null, null, null, null]])
      assert.strictEqual(r.diagnostics.errors.filter((e) => /^k-garbage\.jar: bad zip/.test(e)).length, 1)
    })
    it('U3 a nested jar that cannot be read: ONE row that names the outer jar and the nested one (kind unseen)', () => {
      const r = read('k-nested-bad.jar')
      assert.strictEqual(r.diagnostics.errors.filter((e) => /^k-nested-bad\.jar!.*nested jar unreadable/.test(e)).length, 1, JSON.stringify(r.diagnostics.errors))
      assert.strictEqual(rows(r).length, 1)
      assert.strictEqual(rows(r)[0][0], 'unseen')
      assert.ok(/^k-nested-bad\.jar!/.test(rows(r)[0][1]), rows(r)[0][1])
    })
    it('a unit result and the assembly carry the rows (a kept per-jar result keeps them)', () => {
      const p = path.join(dir, 'k-silent.jar'); fs.writeFileSync(p, JARS['k-silent.jar']())
      const { perJar, read: rd } = D.deriveNeoForgeComponentsPerJar([p])
      assert.deepStrictEqual(perJar.flatMap((u) => u.diagnostics.unresolvedSites || []).map((s) => [s.kind, s.jar]), [['unseen', 'k-silent.jar']])
      const kept = JSON.parse(JSON.stringify(perJar))
      const assembled = D.assembleNeoForgeComponents(rd, kept)
      assert.deepStrictEqual((assembled.diagnostics.unresolvedSites || []).map((s) => [s.kind, s.jar]), [['unseen', 'k-silent.jar']])
    })
  })
})
