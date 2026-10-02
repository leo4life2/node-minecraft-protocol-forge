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

const { libJar, modJar, soloJar, MOD } = require('./helpers/hf73bJars')

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
})
