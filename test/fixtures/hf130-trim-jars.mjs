#!/usr/bin/env node
// HF130 fixture trimmer: builds the committed trimmed jars of the HF130 cases
// (test/hf105PlatformHelper.test.js: the static-forwarder message map;
// test/hf43IdentifierRenameAndGates.test.js: the handler-select ternary)
// from the ORIGINAL public jars, each pinned by its sha256 (a mismatch refuses).
// The originals (official Modrinth downloads):
//   pmw_plus-1.4.1-neoforge-1.21.1.jar
//     https://cdn.modrinth.com/data/6U4BOZu8/versions/2ISjztSw/pmw_plus-1.4.1-neoforge-1.21.1.jar
//     sha256 6688f6d863df7a2e0c16df965baf96c2d455e06d8bc4680153103a2fa26c0b40
//   pmwextra-0.1.7.jar
//     https://cdn.modrinth.com/data/EkOB83Jm/versions/ZyTr1sIc/pmwextra-0.1.7.jar
//     sha256 57548c120b1573b3272b0937b5454ba8391f135726bbb020f3937ce6ca3ff545
// Kept: the mod manifest, the mod root class (with its inner classes), and the
// classes the registration walk reads (the message classes / the networking
// class and the event subscriber). Usage: node test/fixtures/hf130-trim-jars.mjs <dir holding the original jars>
// Deterministic: the kept entries are extracted, stamped 1980-01-01 00:00 UTC,
// zipped sorted with zip -X -D; a re-run reproduces each fixture sha-equal.
// The jars are only read (unzip -p); nothing in them is executed.
import { execFileSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const FIXTURES = [
  {
    original: 'pmw_plus-1.4.1-neoforge-1.21.1.jar',
    sha256: '6688f6d863df7a2e0c16df965baf96c2d455e06d8bc4680153103a2fa26c0b40',
    url: 'https://cdn.modrinth.com/data/6U4BOZu8/versions/2ISjztSw/pmw_plus-1.4.1-neoforge-1.21.1.jar',
    fixture: 'hf130-pmw_plus-1.4.1-neoforge-1.21.1.trimmed.jar',
    keep: [/^META-INF\/neoforge\.mods\.toml$/, /^net\/mcreator\/pmwplus\/PmwPlusMod(\$[^/]+)?\.class$/, /^net\/mcreator\/pmwplus\/network\/[^/]+Message\.class$/]
  },
  {
    original: 'pmwextra-0.1.7.jar',
    sha256: '57548c120b1573b3272b0937b5454ba8391f135726bbb020f3937ce6ca3ff545',
    url: 'https://cdn.modrinth.com/data/EkOB83Jm/versions/ZyTr1sIc/pmwextra-0.1.7.jar',
    fixture: 'hf130-pmwextra-0.1.7.trimmed.jar',
    keep: [/^META-INF\/neoforge\.mods\.toml$/, /^net\/hezi\/pmwextra\/PMWExtra(\$[^/]+)?\.class$/, /^net\/hezi\/pmwextra\/networking\/ModNetworking(\$[^/]+)?\.class$/, /^net\/hezi\/pmwextra\/event\/ModBusEvents\.class$/]
  }
]

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const ENV = { ...process.env, TZ: 'UTC' }
function zipDir (dir, out) {
  const files = []
  const walk = (d) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else files.push(path.relative(dir, p)) } }
  walk(dir)
  files.sort()
  const stamp = new Date(Date.UTC(1980, 0, 1, 0, 0, 0))
  for (const f of files) fs.utimesSync(path.join(dir, f), stamp, stamp)
  fs.rmSync(out, { force: true })
  execFileSync('zip', ['-q', '-X', '-D', out, '-@'], { cwd: dir, input: files.join('\n') + '\n', env: ENV })
}

function main () {
  const src = process.argv[2]
  if (!src) { console.error('usage: hf130-trim-jars.mjs <dir holding the original jars>'); process.exit(2) }
  const manifest = {}
  for (const fx of FIXTURES) {
    const orig = path.join(src, fx.original)
    if (!fs.existsSync(orig)) { console.error(`missing original ${fx.original}`); process.exit(1) }
    const got = sha256(orig)
    if (got !== fx.sha256) { console.error(`REFUSED ${fx.original}: sha256 ${got} is not the pinned ${fx.sha256}`); process.exit(1) }
    const names = execFileSync('unzip', ['-Z1', orig], { env: ENV, maxBuffer: 1 << 26 }).toString('utf8').split('\n').filter((n) => n && !n.endsWith('/'))
    const kept = names.filter((n) => fx.keep.some((re) => re.test(n))).sort()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hf130-trim-'))
    for (const n of kept) {
      const dest = path.join(tmp, n)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, execFileSync('unzip', ['-p', orig, n], { env: ENV, maxBuffer: 1 << 26 }))
    }
    const out = path.join(HERE, fx.fixture)
    zipDir(tmp, out)
    fs.rmSync(tmp, { recursive: true, force: true })
    manifest[fx.fixture] = { original: fx.original, original_sha256: fx.sha256, url: fx.url, entries: kept.length, sha256: sha256(out) }
  }
  fs.writeFileSync(path.join(HERE, 'hf130-fixtures.json'), JSON.stringify(manifest, null, 2) + '\n')
  for (const [k, v] of Object.entries(manifest)) console.log(`${k} ${v.entries} entries ${v.sha256}`)
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main()
