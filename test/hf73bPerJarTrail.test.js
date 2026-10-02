/* eslint-env mocha */
// HF73b — THE PER-JAR DERIVATION AND ITS TRAIL: a pack's derivation is the
// union of per-jar (unit) derivations over one shared class index; each
// unit records the OTHER units its resolution consulted (the trail) and the
// pack facts it read (deps: presence census, mods.toml versions, presence
// gates, mod-root verdicts). A caller caching per jar may reuse a unit's
// result while its jar, its trail jars and its deps are unchanged
// (unitDependenciesHold); the mod-root walk is a PACK pass (its registrations
// ride the pseudo-unit, never a per-jar slot). Pinned here on a synthetic
// library/mod pair (the mod's channel id is built by the library's helper) and
// on the real HF51 fixtures (registration objects through a library).
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { mutateJar } = require('./helpers/jarMutate')
const D = require('../src/client/neoForgePayloadDerivation')

const { libJar, modJar, soloJar, MOD, LIB } = require('./helpers/hf73bJars')
const { containerLibJar, populatorJar } = require('./helpers/hf73bAbsenceJars')

const claims = (r) => r.components.play.map((c) => [c.id, c.version, c.flow, c.optional]).sort()
const unitOf = (r, base) => r.perJar.find((u) => u.path && path.basename(u.path) === base)
const bases = (paths) => paths.map((p) => path.basename(p)).sort()
const strip = (u) => ({ ...u, ms: undefined })
const assembled = (r) => { const { components, diagnostics, ackContracts, ackUnprovable, syncContracts, listenOnly } = r; return { components, diagnostics, ackContracts, ackUnprovable, syncContracts, listenOnly } }

describe('HF73b — the per-jar derivation records, per jar, the jars its cross-jar resolution consulted', function () {
  let dir, lib, mod, solo
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf73b-trail-')); lib = libJar(dir); mod = modJar(dir); solo = soloJar(dir) })

  it('T1 a mod whose id is built by a library helper names the library on its trail; the self-contained mod and the library have empty trails; the pack unit names every jar', () => {
    const r = D.deriveNeoForgeComponentsPerJar([lib, mod, solo])
    assert.deepStrictEqual(claims(r), [['synthlib:ping', 'synthmod', 'serverbound', false], ['synthsolo:pong', 'synthsolo', 'serverbound', false]])
    assert.deepStrictEqual(bases(unitOf(r, 'mod.jar').trail), ['lib.jar'], 'the mod consulted the library')
    assert.deepStrictEqual(unitOf(r, 'solo.jar').trail, [], 'the control resolved from itself')
    assert.deepStrictEqual(unitOf(r, 'lib.jar').trail, [], 'the library walked nothing of the others')
    assert.strictEqual(r.perJar[0].pack, true); assert.strictEqual(r.perJar[0].label, D.PACK_UNIT_LABEL)
    assert.deepStrictEqual(bases(r.perJar[0].trail), ['lib.jar', 'mod.jar', 'solo.jar'], 'the mod-root walk is a pack fact')
    for (const u of r.perJar.slice(1)) { assert.match(u.sha1, /^[0-9a-f]{40}$/); assert.strictEqual(u.sha1, require('crypto').createHash('sha1').update(fs.readFileSync(u.path)).digest('hex'), 'the content sha1') }
    assert.strictEqual(unitOf(r, 'mod.jar').claims.length, 1); assert.strictEqual(unitOf(r, 'solo.jar').claims.length, 1); assert.strictEqual(unitOf(r, 'lib.jar').claims.length, 0)
  })

  it('T2 ORDER INDEPENDENCE: a unit derived on its own fresh state reads the same whichever units were derived before it (the cache may serve any subset)', () => {
    const read = D.readNeoForgeJarUnits([lib, mod, solo])
    const forward = read.units.map((u) => strip(D.deriveNeoForgeJarUnit(read, u)))
    const backward = [...read.units].reverse().map((u) => strip(D.deriveNeoForgeJarUnit(read, u))).reverse()
    assert.deepStrictEqual(backward, forward)
    const alone = D.deriveNeoForgeComponentsPerJar([solo])
    assert.deepStrictEqual(strip(unitOf(alone, 'solo.jar')).claims, strip(unitOf(D.deriveNeoForgeComponentsPerJar([lib, mod, solo]), 'solo.jar')).claims, 'the control claims the same alone and in the pack')
  })

  it('T3 unitDependenciesHold: a changed trail jar fails (by content, never by name), an unrelated change holds; a census / version / gate / mod-root dep that moved fails', () => {
    const r1 = D.deriveNeoForgeComponentsPerJar([lib, mod, solo])
    const libSha = unitOf(r1, 'lib.jar').sha1
    const modUnit = unitOf(r1, 'mod.jar'); const soloUnit = unitOf(r1, 'solo.jar')
    // the library updated: same classes, a new mods.toml line -> a new sha1
    const lib2 = path.join(dir, 'lib-updated.jar')
    fs.writeFileSync(lib2, mutateJar(fs.readFileSync(lib), { text: (p, t) => (/\.toml$/.test(p) ? t + 'description="x"\n' : undefined) }).buf)
    const read2 = D.readNeoForgeJarUnits([lib2, mod, solo])
    assert.notStrictEqual(unitOf({ perJar: read2.units }, 'lib-updated.jar').sha1, libSha)
    const modCheck = D.unitDependenciesHold(read2, { trailSha1s: [libSha], deps: modUnit.deps })
    assert.strictEqual(modCheck.ok, false); assert.match(modCheck.why, /trail jar [0-9a-f]{12} changed or gone/)
    assert.deepStrictEqual(D.unitDependenciesHold(read2, { trailSha1s: [], deps: soloUnit.deps }), { ok: true, why: null })
    // the library renamed but byte-identical: the trail holds (identity by content)
    const lib3 = path.join(dir, 'renamed-lib.jar'); fs.copyFileSync(lib, lib3)
    const read3 = D.readNeoForgeJarUnits([lib3, mod, solo])
    assert.strictEqual(D.unitDependenciesHold(read3, { trailSha1s: [libSha], deps: modUnit.deps }).ok, true)
    // the pack facts
    assert.match(D.unitDependenciesHold(read3, { deps: { present: { synthsolo: false } } }).why, /mod "synthsolo" now present/)
    assert.match(D.unitDependenciesHold(read3, { deps: { present: { gone: true } } }).why, /mod "gone" no longer present/)
    assert.strictEqual(D.unitDependenciesHold(read3, { deps: { present: { synthsolo: true, minecraft: true, nope: false } } }).ok, true)
    assert.match(D.unitDependenciesHold(read3, { deps: { versions: { synthlib: '9.9.9' } } }).why, /mods.toml version of "synthlib" changed/)
    assert.strictEqual(D.unitDependenciesHold(read3, { deps: { versions: { synthlib: '1.0.0', absent: null } } }).ok, true)
    assert.match(D.unitDependenciesHold(read3, { deps: { gates: { [MOD]: 'x|h|p|s' } } }).why, /presence gate of synth\/mod\/Handlers changed/)
    assert.strictEqual(D.unitDependenciesHold(read3, { deps: { gates: { [MOD]: null } } }).ok, true)
    assert.match(D.unitDependenciesHold(read3, { deps: { rootResolved: { 'a.b()V': true } } }).why, /mod-root walk verdict of a.b\(\)V changed/)
    assert.strictEqual(D.unitDependenciesHold(read3, { deps: { rootResolved: { 'a.b()V': false } } }).ok, true)
  })

  it('T4 THE REUSE LAW: the pack assembled from a fresh read + reused unit results (their deps hold) equals the pack derived fresh, byte for byte', () => {
    const r1 = D.deriveNeoForgeComponentsPerJar([lib, mod, solo])
    const fresh = D.deriveNeoForgeComponentsPerJar([lib, mod, solo])
    const read = fresh.read
    const reused = [D.derivePackUnit(read), ...read.units.map((u) => unitOf(r1, path.basename(u.path)))]
    assert.deepStrictEqual(D.assembleNeoForgeComponents(read, reused), assembled(fresh))
    assert.deepStrictEqual(assembled(fresh), D.deriveNeoForgeComponents([lib, mod, solo]), 'the legacy entry is the per-jar entry assembled')
  })

  it('T5 the legacy entry keeps its shape: no per-jar receipt, no path on a jar census row (the N8 law)', () => {
    const r = D.deriveNeoForgeComponents([lib, mod, solo])
    assert.deepStrictEqual(Object.keys(r).sort(), ['ackContracts', 'ackUnprovable', 'components', 'diagnostics', 'listenOnly', 'syncContracts'])
    for (const j of r.diagnostics.jars) assert.deepStrictEqual(Object.keys(j).sort(), ['label', 'modIds', 'modVersion'])
  })

  it('T6 the real HF51 shape (registration objects through a library): the claims ride the PACK unit (the mod-root walk), the pack equals the single walk', () => {
    const FX = path.join(__dirname, 'fixtures')
    const jars = [path.join(FX, 'hf51-balm-26.3.0.1.trimmed.jar'), path.join(FX, 'hf51-waystones-26.3.0.1.trimmed.jar')]
    const r = D.deriveNeoForgeComponentsPerJar(jars)
    assert.strictEqual(r.components.play.length, 20)
    assert.strictEqual(r.perJar[0].claims.filter((c) => c.id.startsWith('waystones:')).length, 19, 'the library listener iterated the mod\'s registration object under the pack pass')
    assert.strictEqual(unitOf(r, 'hf51-waystones-26.3.0.1.trimmed.jar').claims.length, 0)
    assert.deepStrictEqual(assembled(r), D.deriveNeoForgeComponents(jars))
  })

  // HF73b r2 THE ABSENCE LAW (verify r1 HIGH): a result depends on what was
  // NOT in the pack - a pack-wide scan holds only while the pack's class
  // census is the one it scanned; a lookup that missed holds only while the
  // class is still absent.
  it('T7 a library that registers what a MOD populates into its container is slotted alone (its population scan is pack-wide: deps.packCensus); the mod ADDED -> the slot does not hold (the census why), the re-derived pack equals the cold one; the stale unit assembled would have missed the id (the hole, closed)', () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hf73b-absence-')); const box = containerLibJar(d2); const cc = populatorJar(d2)
    const cold1 = D.deriveNeoForgeComponents([box]); const cold2 = D.deriveNeoForgeComponents([box, cc])
    assert.deepStrictEqual(cold1.listenOnly, [], 'alone: nothing populates the container (true)')
    assert.deepStrictEqual(cold2.listenOnly, ['synthcc:real_ping'], 'with the mod: its id')
    const read1 = D.readNeoForgeJarUnits([box]); const boxUnit = D.deriveNeoForgeJarUnit(read1, read1.units[0])
    assert.deepStrictEqual(boxUnit.trail, [], 'no other unit to consult')
    assert.strictEqual(boxUnit.deps.packCensus, D.packCensusOf(read1), 'the population scan is pack-wide: the census it scanned')
    assert.match(boxUnit.deps.packCensus, /^[0-9a-f]{40}$/)
    assert.deepStrictEqual(D.unitDependenciesHold(read1, { trailSha1s: [], deps: boxUnit.deps }), { ok: true, why: null }, 'holds on the pack it scanned')
    const read2 = D.readNeoForgeJarUnits([box, cc])
    const hold = D.unitDependenciesHold(read2, { trailSha1s: [], deps: boxUnit.deps })
    assert.strictEqual(hold.ok, false)
    assert.strictEqual(hold.why, 'the pack\'s class census changed (a jar added, removed or re-shaped) - this unit\'s resolution scanned the whole pack')
    const ccUnit = D.deriveNeoForgeJarUnit(read2, read2.units[1])
    const stale = D.assembleNeoForgeComponents(read2, [D.derivePackUnit(read2), boxUnit, ccUnit])
    assert.deepStrictEqual(stale.listenOnly, [], 'the hole as it was: the stale unit served misses the id')
    const fresh = D.assembleNeoForgeComponents(read2, [D.derivePackUnit(read2), D.deriveNeoForgeJarUnit(read2, read2.units[0]), ccUnit])
    assert.deepStrictEqual(fresh.listenOnly, cold2.listenOnly, 're-derived: the cold answer')
    assert.deepStrictEqual(assembled(D.deriveNeoForgeComponentsPerJar([box, cc])), cold2, 'the per-jar entry equals the legacy one')
  })

  it('T8 CONTROL: a self-contained unit (no pack-wide scan, no missed class that appears) holds after unrelated jars are added; every missed name it records is absent from the pack', () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hf73b-absence-')); const box = containerLibJar(d2); const cc = populatorJar(d2)
    const read1 = D.readNeoForgeJarUnits([solo]); const soloUnit = D.deriveNeoForgeJarUnit(read1, read1.units[0])
    assert.strictEqual(soloUnit.deps.packCensus, null, 'the control scanned nothing pack-wide')
    for (const name of soloUnit.deps.missed) assert.strictEqual(read1.index.raw.has(name), false, `missed ${name} is absent`)
    const read2 = D.readNeoForgeJarUnits([solo, box, cc, lib, mod])
    assert.deepStrictEqual(D.unitDependenciesHold(read2, { trailSha1s: [], deps: soloUnit.deps }), { ok: true, why: null }, 'unrelated jars added: the control holds')
    assert.deepStrictEqual(D.assembleNeoForgeComponents(read2, [D.derivePackUnit(read2), soloUnit, ...read2.units.slice(1).map((u) => D.deriveNeoForgeJarUnit(read2, u))]).components, D.deriveNeoForgeComponents([solo, box, cc, lib, mod]).components, 'served, the answer is the cold one')
  })

  it('T9 a lookup that MISSED is recorded: the mod derived without its library names the helper class in deps.missed (0 claims, true for that pack); the library added -> the slot does not hold ("class ... now present"), never a stale 0-claim unit', () => {
    const read1 = D.readNeoForgeJarUnits([mod]); const modUnit = D.deriveNeoForgeJarUnit(read1, read1.units[0])
    assert.strictEqual(modUnit.claims.length, 0, 'the helper is absent: nothing derivable')
    assert.ok(modUnit.deps.missed.includes(LIB), `deps.missed names ${LIB}: ${JSON.stringify(modUnit.deps.missed)}`)
    assert.deepStrictEqual(modUnit.deps.missed, [...modUnit.deps.missed].sort(), 'sorted (a stable slot)')
    assert.deepStrictEqual(D.unitDependenciesHold(read1, { trailSha1s: [], deps: modUnit.deps }), { ok: true, why: null })
    const read2 = D.readNeoForgeJarUnits([lib, mod])
    const hold = D.unitDependenciesHold(read2, { trailSha1s: [], deps: modUnit.deps })
    assert.strictEqual(hold.ok, false); assert.strictEqual(hold.why, `class ${LIB} now present (a lookup that missed when derived)`)
    assert.strictEqual(D.deriveNeoForgeJarUnit(read2, read2.units[1]).claims.length, 1, 're-derived: the claim')
  })

  it('T10 packCensusOf is the sorted class-name census of the read: order-free, name-free (a renamed byte-identical jar), cached on the read, changed by a class added or removed', () => {
    const a = D.readNeoForgeJarUnits([lib, mod, solo]); const b = D.readNeoForgeJarUnits([solo, lib, mod])
    assert.strictEqual(D.packCensusOf(a), D.packCensusOf(b), 'order-free')
    assert.strictEqual(D.packCensusOf(a), a.packCensusSha1, 'cached on the read')
    const renamed = path.join(dir, 'renamed-solo.jar'); fs.copyFileSync(solo, renamed)
    assert.strictEqual(D.packCensusOf(D.readNeoForgeJarUnits([lib, mod, renamed])), D.packCensusOf(a), 'identity by class names, never by file name')
    assert.notStrictEqual(D.packCensusOf(D.readNeoForgeJarUnits([lib, mod])), D.packCensusOf(a), 'a jar removed')
    assert.notStrictEqual(D.packCensusOf(D.readNeoForgeJarUnits([lib, mod, solo, containerLibJar(fs.mkdtempSync(path.join(os.tmpdir(), 'hf73b-absence-')))])), D.packCensusOf(a), 'a jar added')
  })
})
