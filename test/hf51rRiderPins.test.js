/* eslint-env mocha */
// HF51-rider — four walker seams pinned on synthetic jars (mechanism, no mod
// names; builders in helpers/hf51rJars.js):
//   MED-1 the mods.toml fallback receipt is TRUE: an unfoldable registrar(x)
//         argument is "registrar argument unresolved", never "unversioned"
//   MED-2 an incomplete superclass chain leaves instanceof undecided.
//         The registrar site reports the unresolved guard in both forms.
//   MED-3 a keyed store filled by put() counts and iterates its ENTRIES — an
//         upsert under one key is one element for size()/values()
//   LOW   a helper's own conditional never makes the caller's later
//         `.optional()` undecided (per-method flag; regression pin)
// RED on the lane commit: MED-1 (receipt says "registrar unversioned"),
// MED-2 body + guard and MED-3 size (all abstained "unresolved payload type
// id"); the plain / isEmpty / LOW pins are controls, green on both trees.
const assert = require('assert')
const fs = require('fs'); const os = require('os'); const path = require('path')
const J = require('./helpers/hf51rJars')
const { deriveNeoForgeComponents } = require('../src/client/neoForgePayloadDerivation')

const derive = (buildJar, form) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf51r-'))
  const jar = path.join(dir, 'fx.jar')
  fs.writeFileSync(jar, buildJar(form))
  const r = deriveNeoForgeComponents([jar])
  return { r, play: Object.fromEntries(r.components.play.map((c) => [c.id, c])), abstains: r.diagnostics.abstains }
}

describe('HF51-rider — MED-1: the mods.toml fallback receipt names the unresolved registrar argument', function () {
  it('event.registrar(<unfoldable String>) falls to the mods.toml version and receipts "registrar argument unresolved" — never "registrar unversioned"', () => {
    const { play, abstains } = derive(J.registrarArgumentUnresolvedJar)
    assert.ok(play['regarg:chan'], 'the channel is claimed: ' + abstains.join(' | '))
    assert.strictEqual(play['regarg:chan'].version, '9.9.9')
    assert.strictEqual(play['regarg:chan'].versionSource, 'mods.toml')
    assert.strictEqual(play['regarg:chan'].versionFrom, 'mods.toml-fallback (registrar argument unresolved)')
  })
})

describe('HF51-rider — MED-2: instanceof over an unindexed base leaves the registration undecided', function () {
  it('control: the deep walk itself derives the element (no instanceof test)', () => {
    const { play, abstains } = derive(J.instanceofUnindexedBaseJar, 'plain')
    assert.ok(play['inst:chan'], abstains.join(' | '))
  })
  for (const form of ['body', 'guard']) {
    it(`an unknown instanceof test withholds the conditional registration (${form})`, () => {
      const { r, play } = derive(J.instanceofUnindexedBaseJar, form)
      assert.deepStrictEqual(Object.keys(play), [])
      const sites = r.diagnostics.unresolvedSites || []
      assert.ok(sites.some(s => s.kind === 'unseen' && /on(Body|Guard)\(.*\)V@\d+$/.test(s.site)), JSON.stringify(sites))
    })
  }
})

describe('HF51-rider — MED-3: a keyed store counts its entries', function () {
  it('put() twice under ONE key: size() is 1 (entries), so `if (M.size() > 1) return` walks on and values() yields the one element', () => {
    const { r, play, abstains } = derive(J.keyedStoreSizeJar, 'size')
    assert.ok(play['store:mapped'], 'RED on the lane commit — size() read the two per-put items: ' + abstains.join(' | '))
    assert.strictEqual(r.components.play.filter((c) => c.id === 'store:mapped').length, 1)
  })
  it('control: `if (M.isEmpty()) return` over a put()-filled map walks on', () => {
    const { play, abstains } = derive(J.keyedStoreSizeJar, 'empty')
    assert.ok(play['store:mapped'], abstains.join(' | '))
  })
})

describe('HF51-rider — LOW: the undecided flag is per method', function () {
  it('a helper with its own conditional, called before the caller`s `.optional()`, leaves that optional PROVEN (safely unclaimed, not unresolved-required)', () => {
    const { play, abstains } = derive(J.helperConditionalLeakJar)
    assert.strictEqual(Object.keys(play).length, 0)
    const row = abstains.find((a) => a.startsWith('fx/hf51r/Leak: playToServer'))
    assert.ok(row, abstains.join(' | '))
    assert.ok(/safely unclaimed$/.test(row), row)
    assert.ok(!/unresolved-required/.test(row), row)
  })
})
