#!/usr/bin/env node
// HF131 fixture trimmer: builds the committed trimmed jar of the HF131 case
// (test/hf105PlatformHelper.test.js H131d: the jar whose mixin injects a packet
// type into the clientbound play template) from the ORIGINAL public jar, pinned
// by its sha256 (a mismatch refuses).
// The original (official Modrinth download, looked up by its hash):
//   levelz-2.0.12.jar
//     https://cdn.modrinth.com/data/EFtixeiF/versions/40CB7XX2/levelz-2.0.12.jar
//     sha256 7d4b004e3cc053e16b0b91141f8b6be2a147d7c2a42564d1fa1df4baed30df6b
// Kept: the mod manifest, the mixin config, the mixin class the culprit read
// binds (its @Mixin target, its injector's method and the add-packet method
// reference) and the packet-type holder it references. Usage:
//   node test/fixtures/hf131-trim-jars.mjs <dir holding the original jar>
// Deterministic: the kept entries are extracted, stamped 1980-01-01 00:00 UTC,
// zipped sorted with zip -X -D; a re-run reproduces the fixture sha-equal.
// The jar is only read (unzip -p); nothing in it is executed.
import { execFileSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const FIXTURES = [
  {
    original: 'levelz-2.0.12.jar',
    sha256: '7d4b004e3cc053e16b0b91141f8b6be2a147d7c2a42564d1fa1df4baed30df6b',
    url: 'https://cdn.modrinth.com/data/EFtixeiF/versions/40CB7XX2/levelz-2.0.12.jar',
    fixture: 'hf131-levelz-2.0.12.trimmed.jar',
    keep: [/^fabric\.mod\.json$/, /^levelz\.mixins\.json$/, /^net\/levelz\/mixin\/network\/PlayStateFactoriesMixin\.class$/, /^net\/levelz\/network\/LevelServerPacket\.class$/]
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
  if (!src) { console.error('usage: hf131-trim-jars.mjs <dir holding the original jar>'); process.exit(2) }
  const manifest = {}
  for (const fx of FIXTURES) {
    const orig = path.join(src, fx.original)
    if (!fs.existsSync(orig)) { console.error(`missing original ${fx.original}`); process.exit(1) }
    const got = sha256(orig)
    if (got !== fx.sha256) { console.error(`REFUSED ${fx.original}: sha256 ${got} is not the pinned ${fx.sha256}`); process.exit(1) }
    const names = execFileSync('unzip', ['-Z1', orig], { env: ENV, maxBuffer: 1 << 26 }).toString('utf8').split('\n').filter((n) => n && !n.endsWith('/'))
    const kept = names.filter((n) => fx.keep.some((re) => re.test(n))).sort()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hf131-trim-'))
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
  fs.writeFileSync(path.join(HERE, 'hf131-fixtures.json'), JSON.stringify(manifest, null, 2) + '\n')
  for (const [k, v] of Object.entries(manifest)) console.log(`${k} ${v.entries} entries ${v.sha256}`)
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main()
