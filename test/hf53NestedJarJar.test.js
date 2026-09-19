/* eslint-env mocha */
'use strict'
// HF53 — ONE nested-jar rule: the login-ack corroboration reads Forge JarJar
// nesting (META-INF/jarjar/ + metadata.json) the way it reads Fabric's
// META-INF/jars/, and the receipt names the parent that carried the owner.
// Fixture: the public Origins Forge 1.20.1-1.10.0.9 -all jar trimmed to its
// JarJar metadata + the nested login-channel classes (real class bytes).
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { assessLoginChannel, deriveLoginAck } = require('../src/client/loginAckDerivation')
const { zipCentralEntries, zipEntryData } = require('../src/client/jarAnalysis')
const { NESTED_JAR_RE, MAX_NESTED_DEPTH, MAX_NESTED_FOLDER_DEPTH, readNestedManifest, nestedArtifactLabel, nestedRelPath, nestedJarEntriesOf } = require('../src/client/nestedJars')
const forgeHandshake3 = require('../src/client/forgeHandshake3')
const { buildJar } = require('./helpers/synthJar')
const { writeVarInt } = forgeHandshake3

const FIXTURE = path.join(__dirname, 'fixtures', 'hf53-origins-forge-1.20.1-1.10.0.9.trimmed.jar')
const NESTED = 'META-INF/jarjar/calio-forge-1.20.1-1.11.0.5.jar'
const CHANNEL = 'calio:channel'
const ACK_CLASS = 'io/github/edwinmindcraft/calio/common/network/packet/C2SAcknowledgePacket'

function tmpDir (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `hf53-${tag}-`)) }
function entriesOf (buf) { return zipCentralEntries(buf).map((e) => ({ name: e.name, data: zipEntryData(buf, e) })) }
function rebuild (buf, map) { return buildJar(map(entriesOf(buf))) }
function str (s) { const u = Buffer.from(s, 'utf8'); return Buffer.concat([writeVarInt(u.length), u]) }
function wrap (channel, payload) { return Buffer.concat([str(channel), writeVarInt(payload.length), payload]) }
const drain = () => new Promise((resolve) => setImmediate(() => setImmediate(() => setImmediate(resolve))))
function fml3Client () {
  const client = new EventEmitter()
  client.state = 'login'
  client.written = []
  client.endedReasons = []
  client.write = (name, params) => client.written.push({ name, params })
  client.end = (reason) => { client.endedReasons.push(reason); client.emit('end', reason) }
  client.on('login_plugin_request', function () {})
  // the server's announced reality (FML3 mod list + ping versions)
  client.forgeModList = { mods: ['minecraft', 'forge', 'origins', 'calio', 'apoli'], channels: [{ name: CHANNEL, marker: '1.2' }], registries: [] }
  client.forgePingMods = [{ id: 'origins', version: '1.20.1-1.10.0.9' }, { id: 'calio', version: '1.20.1-1.11.0.5' }]
  return client
}
async function query (client, messageId = 7) {
  client.emit('login_plugin_request', { messageId, channel: 'fml:loginwrapper', data: wrap(CHANNEL, Buffer.concat([writeVarInt(0), Buffer.from([0x01])])) })
  await drain()
  return client.written.filter((w) => w.name === 'login_plugin_response' && w.params.messageId === messageId)
}
function captureWarn (fn) {
  const lines = []; const orig = console.warn; const origLog = console.log
  console.warn = (m) => lines.push(String(m)); console.log = (m) => lines.push(String(m))
  return Promise.resolve().then(fn).then((r) => { console.warn = orig; console.log = origLog; return { r, lines } }, (e) => { console.warn = orig; console.log = origLog; throw e })
}

describe('HF53 - nested JarJar login-channel corroboration', function () {
  this.timeout(20000)
  const buf = fs.readFileSync(FIXTURE)

  it('N1 the JarJar-nested login channel derives its ack through the nested walk; the receipt names parent -> nested artifact', () => {
    const r = assessLoginChannel(CHANNEL, [FIXTURE])
    assert.strictEqual(r.verdict, 'ack')
    assert.strictEqual(r.index, 0)
    assert.deepStrictEqual(r.reply, Buffer.from([0x00]))
    assert.strictEqual(r.msgClass, ACK_CLASS)
    assert.strictEqual(r.corroboration, 'corroborated-by-nested-jar')
    assert.strictEqual(r.jarName, path.basename(FIXTURE))
    assert.deepStrictEqual(r.nestedChain, [NESTED])
    assert.strictEqual(r.nestedArtifact, 'calio@1.20.1-1.11.0.5')
    assert.match(r.evidence, /corroborated-by-nested-jar: hf53-origins-forge-1\.20\.1-1\.10\.0\.9\.trimmed\.jar -> calio@1\.20\.1-1\.11\.0\.5/)
    // a directory of jars reads the same
    const dir = tmpDir('dir'); fs.copyFileSync(FIXTURE, path.join(dir, 'origins-all.jar'))
    const d = deriveLoginAck(CHANNEL, [dir])
    assert.ok(d && d.index === 0 && d.jarName === 'origins-all.jar')
  })

  it('N2 the same parent with the nested owner REMOVED is honestly unknown (the absence is not papered over)', () => {
    const dir = tmpDir('stripped')
    const stripped = path.join(dir, 'origins-stripped.jar')
    fs.writeFileSync(stripped, rebuild(buf, (es) => es.filter((e) => e.name !== NESTED)))
    assert.deepStrictEqual(assessLoginChannel(CHANNEL, [stripped]), { verdict: 'unknown' })
  })

  it('N3 Fabric nesting (META-INF/jars/, no manifest) derives identically; the artifact label is the file name', () => {
    const dir = tmpDir('fabric')
    const nested = entriesOf(buf).find((e) => e.name === NESTED).data
    const p = path.join(dir, 'fabric-parent.jar')
    fs.writeFileSync(p, buildJar([{ name: 'META-INF/jars/calio.jar', data: nested }]))
    const r = assessLoginChannel(CHANNEL, [p])
    assert.strictEqual(r.verdict, 'ack'); assert.strictEqual(r.index, 0)
    assert.strictEqual(r.corroboration, 'corroborated-by-nested-jar')
    assert.deepStrictEqual(r.nestedChain, ['META-INF/jars/calio.jar'])
    assert.strictEqual(r.nestedArtifact, 'calio.jar')
  })

  it('N4 the manifest names the nested artifacts; the one rule accepts both spellings, subfolders under either root (bounded), and nothing else', () => {
    const m = readNestedManifest(buf, zipCentralEntries(buf))
    assert.strictEqual(m.size, 3)
    assert.deepStrictEqual(m.get(NESTED), { group: 'io.github.edwinmindcraft', artifact: 'calio', artifactVersion: '1.20.1-1.11.0.5', path: NESTED })
    assert.strictEqual(nestedArtifactLabel(NESTED, m), 'calio@1.20.1-1.11.0.5')
    assert.strictEqual(nestedArtifactLabel('META-INF/jars/x.jar', m), 'x.jar')
    assert.ok(NESTED_JAR_RE.test('META-INF/jars/a.jar') && NESTED_JAR_RE.test('META-INF/jarjar/b.jar'))
    // HF53 rider: a nested jar in a subfolder under either root IS a nested jar, named by its path under the root
    assert.ok(NESTED_JAR_RE.test('META-INF/jarjar/deep/d.jar') && NESTED_JAR_RE.test('META-INF/jars/io/github/e.jar'))
    assert.strictEqual(nestedArtifactLabel('META-INF/jarjar/deep/d.jar', m), 'deep/d.jar')
    assert.strictEqual(nestedRelPath('META-INF/jars/io/github/e.jar'), 'io/github/e.jar')
    assert.strictEqual(MAX_NESTED_FOLDER_DEPTH, 4)
    assert.ok(NESTED_JAR_RE.test('META-INF/jarjar/' + 'f/'.repeat(MAX_NESTED_FOLDER_DEPTH) + 'g.jar'))
    assert.ok(!NESTED_JAR_RE.test('META-INF/jarjar/' + 'f/'.repeat(MAX_NESTED_FOLDER_DEPTH + 1) + 'g.jar'), 'the folder depth is bounded')
    assert.ok(!NESTED_JAR_RE.test('META-INF/jarjar/metadata.json') && !NESTED_JAR_RE.test('lib/c.jar') && !NESTED_JAR_RE.test('META-INF/jarjar/deep/') && !NESTED_JAR_RE.test('META-INF/jarsx/a.jar'))
    assert.strictEqual(MAX_NESTED_DEPTH, 2)
    // the loader manifest's own rows are nested jars too (fabric.mod.json "jars" may path outside the roots)
    const fmj = buildJar([
      { name: 'fabric.mod.json', data: Buffer.from(JSON.stringify({ id: 'p', jars: [{ file: 'lib/inner.jar' }] })) },
      { name: 'lib/inner.jar', data: buildJar([]) }, { name: 'lib/other.jar', data: buildJar([]) }
    ])
    assert.deepStrictEqual(nestedJarEntriesOf(fmj, zipCentralEntries(fmj)).map((n) => [n.entry.name, n.artifact]), [['lib/inner.jar', 'lib/inner.jar']])
    // NO deriver under src/client holds a private spelling of the rule any more: every one reads nested jars through nestedJars.js
    const clientDir = path.join(__dirname, '..', 'src', 'client')
    const readers = []
    for (const f of fs.readdirSync(clientDir).filter((f) => f.endsWith('.js') && f !== 'nestedJars.js')) {
      const src = fs.readFileSync(path.join(clientDir, f), 'utf8')
      assert.ok(!src.includes('META-INF/jar'), `${f} must not spell the nested-jar rule privately`)
      assert.ok(!/META-INF\\\/\(\??:?jars\|jarjar\)/.test(src), `${f} must use the shared rule`)
      if (src.includes("require('./nestedJars')")) readers.push(f)
    }
    for (const f of ['blockShapeDerivation.js', 'commandArgumentTypeDerivation.js', 'loginAckDerivation.js', 'packetBodyWireDerivation.js', 'neoForgePayloadDerivation.js', 'owoHandshake.js', 'itemStackWireDerivation.js']) {
      assert.ok(readers.includes(f), `${f} imports the shared rule`)
    }
    // the app's own jar readers (when this lib sits at libs/ inside the app tree) take the rule from here as well
    const appSrc = path.join(__dirname, '..', '..', '..', 'src')
    for (const f of ['utils/vanillaInflationScan.js', 'knowledge/jarKnowledge.js']) {
      if (!fs.existsSync(path.join(appSrc, f))) continue
      const src = fs.readFileSync(path.join(appSrc, f), 'utf8')
      assert.ok(!src.includes('META-INF/jar'), `app ${f} must not spell the nested-jar rule privately`)
      assert.ok(src.includes('minecraft-protocol-forge/src/client/nestedJars.js'), `app ${f} imports the shared rule`)
    }
  })

  it('N7 (rider) a nested jar in a SUBFOLDER under either root derives the ack; the chain and the artifact name it by its path, the manifest by its artifact', () => {
    const dir = tmpDir('subfolder')
    const nested = entriesOf(buf).find((e) => e.name === NESTED).data
    const cases = [
      ['jarjar-sub.jar', 'META-INF/jarjar/io/github/calio.jar', 'io/github/calio.jar', null],
      ['jars-sub.jar', 'META-INF/jars/deep/calio.jar', 'deep/calio.jar', null],
      ['jarjar-sub-manifest.jar', 'META-INF/jarjar/io/github/calio.jar', 'calio@1.20.1-1.11.0.5',
        JSON.stringify({ jars: [{ identifier: { group: 'io.github.edwinmindcraft', artifact: 'calio' }, version: { artifactVersion: '1.20.1-1.11.0.5' }, path: 'META-INF/jarjar/io/github/calio.jar' }] })]
    ]
    for (const [file, entry, label, manifest] of cases) {
      const p = path.join(dir, file)
      const entries = [{ name: entry, data: nested }]
      if (manifest) entries.unshift({ name: 'META-INF/jarjar/metadata.json', data: Buffer.from(manifest) })
      fs.writeFileSync(p, buildJar(entries))
      const r = assessLoginChannel(CHANNEL, [p])
      assert.strictEqual(r.verdict, 'ack', `${file}: ack`); assert.strictEqual(r.index, 0)
      assert.strictEqual(r.corroboration, 'corroborated-by-nested-jar')
      assert.deepStrictEqual(r.nestedChain, [entry])
      assert.strictEqual(r.nestedArtifact, label)
    }
  })

  it('N8 (rider) every deriver claims the SAME from a jar nested in a subfolder as from one nested at the root (labels differ by the path only)', () => {
    const dir = tmpDir('derivers')
    const fixtures = fs.readdirSync(path.join(__dirname, 'fixtures')).filter((f) => f.endsWith('.jar')).sort()
    const derivers = {
      blockShape: (j) => require('../src/client/blockShapeDerivation').deriveBlockShapes([j]),
      cmdArg: (j) => require('../src/client/commandArgumentTypeDerivation').deriveCommandArgumentTypes([j]),
      itemStack: (j) => require('../src/client/itemStackWireDerivation').scanItemStackWireExtensions([j]),
      packetBody: (j) => require('../src/client/packetBodyWireDerivation').scanPacketBodyWireExtensions([j]),
      owo: (j) => require('../src/client/owoHandshake').owoFingerprintsFor([j]),
      loginAck: (j) => deriveLoginAck([j]),
      neoforge: (j) => require('../src/client/neoForgePayloadDerivation').deriveNeoForgeComponents([j])
    }
    const norm = (v, sub) => JSON.stringify(v, (k, x) => (k === 'ms' || typeof x === 'function') ? undefined : (x && x.type === 'Buffer' ? `<buf ${x.data.length}>` : x)).split(sub).join('').split(dir).join('<dir>')
    let nonEmpty = 0
    for (const fx of fixtures) {
      const inner = fs.readFileSync(path.join(__dirname, 'fixtures', fx))
      const root = path.join(dir, `root-${fx}`); const sub = path.join(dir, `sub-${fx}`)
      fs.writeFileSync(root, buildJar([{ name: `META-INF/jarjar/${fx}`, data: inner }]))
      fs.writeFileSync(sub, buildJar([{ name: `META-INF/jarjar/a/b/${fx}`, data: inner }]))
      for (const [name, derive] of Object.entries(derivers)) {
        const a = norm(derive(root), 'root-'); const b = norm(derive(sub), 'a/b/').split('sub-').join('')
        assert.strictEqual(b, a, `${name} on ${fx}: the subfolder claim differs from the root claim`)
        if (a.length > 200) nonEmpty++
      }
    }
    assert.ok(nonEmpty >= 20, `the pin is not vacuous: ${nonEmpty} non-trivial claims compared`)
  })

  it('N5 depth bound: a jar nested two levels down is read, three levels is not', () => {
    const dir = tmpDir('depth')
    const nested = entriesOf(buf).find((e) => e.name === NESTED).data
    const two = buildJar([{ name: 'META-INF/jarjar/mid.jar', data: buildJar([{ name: 'META-INF/jarjar/calio.jar', data: nested }]) }])
    const three = buildJar([{ name: 'META-INF/jarjar/outer.jar', data: two }])
    fs.writeFileSync(path.join(dir, 'two.jar'), two); fs.writeFileSync(path.join(dir, 'three.jar'), three)
    const r2 = assessLoginChannel(CHANNEL, [path.join(dir, 'two.jar')])
    assert.strictEqual(r2.verdict, 'ack'); assert.deepStrictEqual(r2.nestedChain, ['META-INF/jarjar/mid.jar', 'META-INF/jarjar/calio.jar'])
    assert.deepStrictEqual(assessLoginChannel(CHANNEL, [path.join(dir, 'three.jar')]), { verdict: 'unknown' })
  })

  it('N6 FML3 responder: the wrapped query on the nested channel is answered 0x00 and the corroboration receipt names the parent', async () => {
    const client = fml3Client()
    forgeHandshake3(client, { modsPaths: [FIXTURE] })
    const { lines, r } = await captureWarn(() => query(client))
    assert.strictEqual(r.length, 1)
    assert.deepStrictEqual(r[0].params.data, wrap(CHANNEL, Buffer.from([0x00])))
    const c = client.forgeLoginCorroboration[0]
    assert.strictEqual(c.via, 'jar-derived-ack'); assert.strictEqual(c.corroboration, 'corroborated-by-nested-jar')
    assert.strictEqual(c.jar, path.basename(FIXTURE)); assert.strictEqual(c.nestedArtifact, 'calio@1.20.1-1.11.0.5')
    assert.strictEqual(c.ownerMod, 'calio'); assert.strictEqual(c.ownerVersion, '1.20.1-1.11.0.5')
    assert.ok(lines.some((l) => /answered from a NESTED jar: .*trimmed\.jar carries calio@1\.20\.1-1\.11\.0\.5/.test(l)))
    assert.ok(!client.forgeDeclinedLoginChannels)
  })

  it('N7 KNOWN-FATAL truth: with no jar the decline is receipted known-fatal and the copy names channel, owner and why (never a socket story)', async () => {
    const client = fml3Client()
    forgeHandshake3(client, { modsPaths: [] })
    const { lines, r } = await captureWarn(() => query(client))
    assert.strictEqual(r.length, 1); assert.strictEqual(r[0].params.data, undefined)
    const d = client.forgeDeclinedLoginChannels[0]
    assert.strictEqual(d.reason, 'uncorroborated-by-local-jars')
    assert.deepStrictEqual(d.knownFatalDecline, { basis: 'fml3-login-message-needs-response', why: 'no-jar-seen' })
    assert.strictEqual(d.ownerMod, 'calio'); assert.strictEqual(d.ownerVersion, '1.20.1-1.11.0.5'); assert.strictEqual(d.parent, null)
    const copy = lines.find((l) => l.includes('not-understood decline'))
    assert.ok(copy, lines.join('\n'))
    assert.match(copy, /channel "calio:channel"/)
    assert.match(copy, /calio@1\.20\.1-1\.11\.0\.5/)
    assert.match(copy, /ENDS THE LOGIN whenever the message needs a reply/)
    assert.match(copy, /no local mod jar was given to read/)
    assert.doesNotMatch(copy, /socket|dropped/i)
  })

  it('N8 KNOWN-FATAL after a registry miss: the why says the registry does not list a nested-only mod and how many jars were searched', async () => {
    const client = fml3Client()
    const acquire = async () => ({ ok: false, outcome: 'registry-miss', jarPaths: [], receipt: { registry: 'modrinth', nestedSearch: { scanned: 3, hit: null } } })
    forgeHandshake3(client, { modsPaths: [], announcedModAcquisition: { acquire, budgetMs: 2000 } })
    const { lines, r } = await captureWarn(() => query(client))
    assert.strictEqual(r.length, 1); assert.strictEqual(r[0].params.data, undefined)
    const d = client.forgeDeclinedLoginChannels[0]
    assert.deepStrictEqual(d.knownFatalDecline, { basis: 'fml3-login-message-needs-response', why: 'registry-miss' })
    assert.deepStrictEqual(d.acquisition.nestedSearch, { scanned: 3, hit: null })
    const copy = lines.find((l) => l.includes('not-understood decline'))
    assert.match(copy, /has no project by that mod id \(a mod that ships nested inside another mod's jar is not listed on its own\) and none of the 3 local or cached jar\(s\)/)
  })

  it('N9 the announced PARENT answers: an acquisition that resolves the parent jar derives the nested ack, receipted as acquired + nested, naming the parent', async () => {
    const client = fml3Client()
    const parent = { fileName: path.basename(FIXTURE), modId: 'origins', version: '1.20.1-1.10.0.9', nestedPath: NESTED, announced: true, versionMatch: true }
    const acquire = async () => ({ ok: true, outcome: 'nested-in-announced-parent', jarPaths: [FIXTURE], receipt: { registry: 'modrinth', parent } })
    forgeHandshake3(client, { modsPaths: [], announcedModAcquisition: { acquire, budgetMs: 2000 } })
    const { lines, r } = await captureWarn(() => query(client))
    assert.strictEqual(r.length, 1)
    assert.deepStrictEqual(r[0].params.data, wrap(CHANNEL, Buffer.from([0x00])))
    const c = client.forgeLoginCorroboration[0]
    assert.strictEqual(c.via, 'jar-derived-ack (acquired)'); assert.strictEqual(c.corroboration, 'corroborated-by-nested-jar')
    assert.deepStrictEqual(c.acquisition.parent, parent)
    assert.ok(lines.some((l) => /from the announced parent hf53-origins-forge-1\.20\.1-1\.10\.0\.9\.trimmed\.jar \(origins@1\.20\.1-1\.10\.0\.9\) that nests calio@1\.20\.1-1\.11\.0\.5/.test(l)), lines.join('\n'))
    assert.ok(!client.forgeDeclinedLoginChannels)
  })
})
