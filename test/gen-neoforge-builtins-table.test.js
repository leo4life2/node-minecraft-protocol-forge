/* eslint-env mocha */
'use strict'
// HF113: the per-line NeoForge built-in column generator (tools/gen-neoforge-builtins-table.js, dev-time) and the
// data it commits (src/client/data/neoForgeBuiltins.json + .sources.json). A column is never typed: it is the
// runtime's own jar reader over the published universal jar of the line's latest build. This suite pins (1) a
// column (or a recorded verdict) for every line the settled axis reaches, (2) the shape of every column, (3) the
// 21.1 column == the pinned constants, (4) byte-for-byte reproduction of the committed 26.1.2 column from the
// local jar named by HF113_JAR_DIR (SKIPPED with the fact when absent; the committed column's sha256 pinned always).
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const gen = require('../tools/gen-neoforge-builtins-table')
const { neoForgeBuildMatchesGameVersion, neoForgeBuildGameAxis } = require('../src/client/neoForgeLoaderLocator')
const { HANDLED_CLIENTBOUND_CONFIG_CHANNELS, TOLERATED_CLIENTBOUND_PLAY_CHANNELS, NEOFORGE_BUILTIN_COLUMNS } = require('../src/client/neoForgeConfig')
const DATA = path.join(__dirname, '..', 'src', 'client', 'data', 'neoForgeBuiltins.json')
const SOURCES = path.join(__dirname, '..', 'src', 'client', 'data', 'neoForgeBuiltins.sources.json')
const data = JSON.parse(fs.readFileSync(DATA, 'utf8'))
const sources = JSON.parse(fs.readFileSync(SOURCES, 'utf8'))
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
// the committed columns, serialised as the generator writes them (gen.canon)
const COLUMN_26_1_2_SHA256 = '8e557f42d7a76b77b5e2abd2d720190014a0630a1a61c22e2ea1c923ab09d3c4'
const COLUMN_21_1_SHA256 = '84c526508909ca0e0d99601a3d290d12db3cc6005864aacc00968c1d974852c6'
const ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/
const JAR_DIR = process.env.HF113_JAR_DIR || null
const LOCAL_26_1_2 = JAR_DIR ? path.join(JAR_DIR, 'neoforge-26.1.2.124-universal.jar') : null

describe('HF113 built-in columns: the data file + the generator', function () {
  it('the line of a build is its HF100 game axis (21.1.248 -> 21.1, 26.1.2.124 -> 26.1.2, 26.3.0.95 -> 26.3, 20.4.253 -> 20.4; an unparsable name has none)', () => {
    assert.strictEqual(gen.lineOf('21.1.248'), '21.1')
    assert.strictEqual(gen.lineOf('26.1.2.124'), '26.1.2')
    assert.strictEqual(gen.lineOf('26.3.0.95'), '26.3')
    assert.strictEqual(gen.lineOf('20.4.253'), '20.4')
    assert.strictEqual(gen.lineOf('26.1.0.19-beta'), '26.1')
    assert.strictEqual(gen.lineOf('0.25w14craftmine.3-beta'), null)
    const { lines, unparsed } = gen.linesOf(['21.1.247', '21.1.248', '26.1.2.124', 'universal'])
    assert.deepStrictEqual([...lines.keys()], ['21.1', '26.1.2'])
    assert.strictEqual(gen.latestBuild(lines.get('21.1')), '21.1.248')
    assert.deepStrictEqual(unparsed, ['universal'])
    assert.strictEqual(gen.latestBuild(['26.1.0.9-beta', '26.1.0.19-beta', '26.1.0.10-beta']), '26.1.0.19-beta', 'numeric-aware, not lexical')
  })

  it('the axis: every release game version from the oldest a line reaches has a verdict from the closed set; a column iff the verdict says column; every column is keyed by a line whose build reaches its game versions', () => {
    assert.ok(Object.keys(sources.versions).length >= 20, `axis versions recorded: ${Object.keys(sources.versions).length}`)
    const axis = gen.releaseGameVersions()
    for (const [v, row] of Object.entries(sources.versions)) {
      assert.ok(axis.includes(v), `${v} outside the release axis`)
      assert.ok(gen.VERSION_VERDICTS.includes(row.verdict), `${v}: verdict ${row.verdict} outside the closed set`)
      if (row.verdict === 'column') {
        assert.ok(data.columns[row.line], `${v}: verdict column but no ${row.line} column`)
        assert.ok(neoForgeBuildMatchesGameVersion(data.columns[row.line].build, v), `${v}: the ${row.line} column's build does not reach it`)
      } else {
        assert.ok(!Object.values(data.columns).some((c) => neoForgeBuildMatchesGameVersion(c.build, v)), `${v}: verdict ${row.verdict} but a column reaches it`)
      }
    }
    for (const [line, col] of Object.entries(data.columns)) {
      assert.strictEqual(gen.lineOf(col.build), line, `${line}: column keyed off its build's line`)
      assert.deepStrictEqual(neoForgeBuildGameAxis(col.build).join('.'), line)
      const src = sources.lines[line]
      assert.ok(src && src.verdict === 'column' && src.build === col.build, `${line}: sources record names the column's build`)
      assert.match(src.sha256, /^[0-9a-f]{64}$/)
      assert.ok(src.url.startsWith('https://maven.neoforged.net/releases/net/neoforged/neoforge/') && src.url.endsWith(`neoforge-${col.build}-universal.jar`), `${line}: the publisher URL`)
      assert.ok(Array.isArray(src.buildsRead) && src.buildsRead.some((b) => b.build === col.build), `${line}: the column's build is among the builds read`)
      assert.ok(src.gameVersions.length >= 1 && src.gameVersions.every((v) => sources.versions[v]?.line === line))
    }
    for (const [line, src] of Object.entries(sources.lines)) {
      assert.ok(gen.LINE_VERDICTS.includes(src.verdict), `${line}: line verdict ${src.verdict}`)
      assert.strictEqual(!!data.columns[line], src.verdict === 'column', `${line}: column presence vs verdict`)
    }
    // the rows of F48: every game version of the class has a column that carries recipe content
    for (const v of ['1.21.11', '26.1.2', '26.3']) {
      const line = sources.versions[v]?.line
      assert.ok(line && data.columns[line], `${v} has a column`)
      assert.ok(data.columns[line].play.some((r) => r.id === 'neoforge:recipe_content' && r.flow === 'clientbound'), `${v}: recipe content is a clientbound play built-in of its line`)
    }
    assert.ok(!data.columns['21.1'].play.some((r) => r.id === 'neoforge:recipe_content'), 'the 21.1 line has no recipe content')
  })

  it('every column is well-formed: build string, ids in the namespace:path shape under neoforge:, flow from the closed set, rows sorted by id with no duplicate, serialised as the generator canon does', () => {
    for (const [line, col] of Object.entries(data.columns)) {
      assert.deepStrictEqual(Object.keys(col).sort(), ['build', 'configuration', 'play'], line)
      assert.match(col.build, /^\d+(\.\d+){2,3}(-[a-z0-9.]+)?$/, `${line}: build ${col.build}`)
      for (const phase of ['configuration', 'play']) {
        const rows = col[phase]
        assert.ok(Array.isArray(rows) && rows.length > 0, `${line}/${phase}: rows`)
        const keys = rows.map((r) => `${r.id} ${r.flow}`)
        assert.deepStrictEqual(keys, [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), `${line}/${phase}: sorted`)
        assert.strictEqual(new Set(keys).size, keys.length, `${line}/${phase}: duplicates`)
        for (const r of rows) {
          assert.deepStrictEqual(Object.keys(r).sort(), ['flow', 'id'])
          assert.match(r.id, ID, `${line}/${phase}: id ${r.id}`)
          assert.ok(r.id.startsWith('neoforge:'), `${line}/${phase}: ${r.id} outside the loader namespace`)
          assert.ok(gen.FLOWS.includes(r.flow), `${line}/${phase}: flow ${r.flow}`)
        }
      }
    }
    assert.strictEqual(fs.readFileSync(DATA, 'utf8'), gen.canon(data), 'the data file is its own canon (sorted keys, two-space indent, trailing newline)')
    assert.strictEqual(fs.readFileSync(SOURCES, 'utf8'), gen.canon(sources), 'the sources record likewise')
    assert.strictEqual(data.schema, gen.SCHEMA)
    assert.deepStrictEqual(NEOFORGE_BUILTIN_COLUMNS, data.columns, 'neoForgeConfig reads this very data file')
  })

  it('the 21.1 column equals the pinned constants (the clientbound play built-ins minus split == TOLERATED; the clientbound configuration built-ins minus split == HANDLED) and the committed 26.1.2 / 21.1 columns carry their pinned sha256', () => {
    const col = data.columns['21.1']
    const clientbound = (rows) => rows.filter((r) => r.flow !== 'serverbound' && r.id !== 'neoforge:split').map((r) => r.id).sort()
    assert.deepStrictEqual(clientbound(col.play), [...TOLERATED_CLIENTBOUND_PLAY_CHANNELS].sort())
    assert.deepStrictEqual(clientbound(col.configuration), [...HANDLED_CLIENTBOUND_CONFIG_CHANNELS].sort())
    assert.strictEqual(sha256(gen.canon(col)), COLUMN_21_1_SHA256)
    assert.strictEqual(sha256(gen.canon(data.columns['26.1.2'])), COLUMN_26_1_2_SHA256)
  })

  it('the sources record names the one publisher and no local path; the data file carries no path, host or URL', () => {
    const text = fs.readFileSync(SOURCES, 'utf8')
    assert.ok(!/\/Users\/|\/private\/|\/Volumes\/|~\/|C:\\\\/.test(text), 'a local path in the sources record')
    const urls = [...text.matchAll(/https?:\/\/([^/"]+)/g)].map((m) => m[1])
    assert.ok(urls.length > 0 && urls.every((h) => h === 'maven.neoforged.net'), `hosts: ${[...new Set(urls)].join(', ')}`)
    const dataText = fs.readFileSync(DATA, 'utf8')
    assert.ok(!/https?:|\/Users\/|\/private\/|\/Volumes\/|\.(com|net|org)\b/.test(dataText), 'a path, host or url in the data file')
  })

  it('the generator REPRODUCES the committed 26.1.2 column byte for byte from the local jar (HF113_JAR_DIR/neoforge-26.1.2.124-universal.jar)', function () {
    if (!LOCAL_26_1_2 || !fs.existsSync(LOCAL_26_1_2)) {
      this.test.title += ` - SKIPPED: ${LOCAL_26_1_2 ? `${LOCAL_26_1_2} absent` : 'HF113_JAR_DIR unset'} (the committed column's sha256 is pinned above)`
      return this.skip()
    }
    this.timeout(60000)
    const bytes = fs.readFileSync(LOCAL_26_1_2)
    assert.strictEqual(sha256(bytes), sources.lines['26.1.2'].sha256, 'the local jar is the recorded publisher artifact')
    const column = gen.columnOf(LOCAL_26_1_2, '26.1.2.124')
    assert.strictEqual(gen.canon(column), gen.canon(data.columns['26.1.2']))
    assert.strictEqual(sha256(gen.canon(column)), COLUMN_26_1_2_SHA256)
  })

  it('the generator is never required from src/', () => {
    const src = path.join(__dirname, '..', 'src')
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
    for (const f of walk(src).filter((f) => f.endsWith('.js'))) {
      assert.ok(!/require\(\s*['"][^'"]*tools\//.test(fs.readFileSync(f, 'utf8')), `${path.relative(src, f)} requires tools/`)
    }
  })
})
