#!/usr/bin/env node
// HF127 fixture trimmer: builds the committed trimmed jars of the HF127 suites
// (test/hf105PlatformHelper.test.js, test/hf43IdentifierRenameAndGates.test.js)
// from the ORIGINAL public jars, each pinned by its sha256 (a mismatch refuses).
// The originals (official Modrinth downloads):
//   scholar-neoforge-1.21.1-1.2.10.jar
//     https://cdn.modrinth.com/data/fX4dIQCo/versions/ZIsoNOTJ/scholar-neoforge-1.21.1-1.2.10.jar
//     sha256 dd904e9cb225caad879962576af167129ae92a4b92305e48081387717be82c7d
//   elytraslot-neoforge-9.0.2+1.21.1.jar
//     https://cdn.modrinth.com/data/mSQF1NpT/versions/RX6A02W1/elytraslot-neoforge-9.0.2%2B1.21.1.jar
//     sha256 d86adf384390c40b144a296ef4fc11b72fd81e2780b264bd9ceb7b5ab9147399
//   puzzleslib-v21.1.66-mc1.21.1+neoforge.jar
//     https://cdn.modrinth.com/data/QAGBst4M/versions/kmN5PWk9/puzzleslib-v21.1.66-mc1.21.1%2Bneoforge.jar
//     sha256 cb02de7e1d4a133746ec7b43a64eddc2cb621122cdc49e134a15272f456c31f2
//   EasyMagic-v21.1.4-1.21.1-NeoForge.jar
//     https://cdn.modrinth.com/data/9hx3AbJM/versions/MxbfrOEv/EasyMagic-v21.1.4-1.21.1-NeoForge.jar
//     sha256 e641a83dcd0dd1a66c545069a706349df94f5b64dc5a252944596439009a699f
//   EasyAnvils-v21.1.0-1.21.1-NeoForge.jar
//     https://cdn.modrinth.com/data/OZBR5JT5/versions/fSQSKhdF/EasyAnvils-v21.1.0-1.21.1-NeoForge.jar
//     sha256 dcd0e562710a639b4fdd60a7500dc9404c6fbd1007215a088248ce1c57ccc6dc
// plus the manifest-only presence stub (a mods.toml naming one mod id, no classes).
// Usage: node test/fixtures/hf127-trim-jars.mjs <dir holding the original jars>
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
  { original: 'scholar-neoforge-1.21.1-1.2.10.jar', sha256: 'dd904e9cb225caad879962576af167129ae92a4b92305e48081387717be82c7d', url: 'https://cdn.modrinth.com/data/fX4dIQCo/versions/ZIsoNOTJ/scholar-neoforge-1.21.1-1.2.10.jar', fixture: 'hf127-scholar-neoforge-1.21.1-1.2.10.trimmed.jar', keep: [/^META-INF\/neoforge\.mods\.toml$/, /^io\/github\/mortuusars\/scholar\/Scholar\.class$/, /^io\/github\/mortuusars\/scholar\/neoforge\/event\/NeoForgeCommonEvents\.class$/, /^io\/github\/mortuusars\/scholar\/network\/packet\/(C2S|S2C|Common)Packets\.class$/, /^io\/github\/mortuusars\/scholar\/network\/packet\/serverbound\/[A-Za-z]+C2SP\.class$/] },
  { original: 'elytraslot-neoforge-9.0.2+1.21.1.jar', sha256: 'd86adf384390c40b144a296ef4fc11b72fd81e2780b264bd9ceb7b5ab9147399', url: 'https://cdn.modrinth.com/data/mSQF1NpT/versions/RX6A02W1/elytraslot-neoforge-9.0.2%2B1.21.1.jar', fixture: 'hf127-elytraslot-neoforge-9.0.2+1.21.1.trimmed.jar', keep: [/^META-INF\/neoforge\.mods\.toml$/, /^META-INF\/services\/com\.illusivesoulworks\.elytraslot\.platform\.services\.IPlatform$/, /^com\/illusivesoulworks\/elytraslot\/ElytraSlotNeoForgeMod\.class$/, /^com\/illusivesoulworks\/elytraslot\/platform\/(Services|NeoForgePlatform)\.class$/, /^com\/illusivesoulworks\/elytraslot\/platform\/services\/IPlatform\.class$/, /^com\/illusivesoulworks\/elytraslot\/common\/integration\/deeperdarker\/(DeeperDarkerPlugin|SoulElytraBoostPayload)\.class$/] },
  { original: 'puzzleslib-v21.1.66-mc1.21.1+neoforge.jar', sha256: 'cb02de7e1d4a133746ec7b43a64eddc2cb621122cdc49e134a15272f456c31f2', url: 'https://cdn.modrinth.com/data/QAGBst4M/versions/kmN5PWk9/puzzleslib-v21.1.66-mc1.21.1%2Bneoforge.jar', fixture: 'hf127-puzzleslib-v21.1.66-mc1.21.1+neoforge.trimmed.jar', keep: [/^META-INF\/neoforge\.mods\.toml$/, /^fuzs\/puzzleslib\/impl\/network\/NetworkHandlerRegistryImpl\.class$/, /^fuzs\/puzzleslib\/neoforge\/impl\/network\/NeoForgeNetworkHandler\.class$/, /^fuzs\/puzzleslib\/api\/network\/v3\/NetworkHandler(\$Builder)?\.class$/, /^fuzs\/puzzleslib\/impl\/PuzzlesLibMod\.class$/] },
  { original: 'EasyMagic-v21.1.4-1.21.1-NeoForge.jar', sha256: 'e641a83dcd0dd1a66c545069a706349df94f5b64dc5a252944596439009a699f', url: 'https://cdn.modrinth.com/data/9hx3AbJM/versions/MxbfrOEv/EasyMagic-v21.1.4-1.21.1-NeoForge.jar', fixture: 'hf127-EasyMagic-v21.1.4-1.21.1-NeoForge.trimmed.jar', keep: [/^META-INF\/neoforge\.mods\.toml$/, /^fuzs\/easymagic\/EasyMagic\.class$/, /^fuzs\/easymagic\/network\/[A-Za-z]+\.class$/] },
  { original: 'EasyAnvils-v21.1.0-1.21.1-NeoForge.jar', sha256: 'dcd0e562710a639b4fdd60a7500dc9404c6fbd1007215a088248ce1c57ccc6dc', url: 'https://cdn.modrinth.com/data/OZBR5JT5/versions/fSQSKhdF/EasyAnvils-v21.1.0-1.21.1-NeoForge.jar', fixture: 'hf127-EasyAnvils-v21.1.0-1.21.1-NeoForge.trimmed.jar', keep: [/^META-INF\/neoforge\.mods\.toml$/, /^fuzs\/easyanvils\/EasyAnvils\.class$/, /^fuzs\/easyanvils\/network\/(client\/)?[A-Za-z]+\.class$/] }
]
export const STUB = { fixture: 'hf127-presence-stub.jar', modId: 'deeperdarker' }

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
  if (!src) { console.error('usage: hf127-trim-jars.mjs <dir holding the original jars>'); process.exit(2) }
  const manifest = {}
  for (const fx of FIXTURES) {
    const orig = path.join(src, fx.original)
    if (!fs.existsSync(orig)) { console.error(`missing original ${fx.original}`); process.exit(1) }
    const got = sha256(orig)
    if (got !== fx.sha256) { console.error(`REFUSED ${fx.original}: sha256 ${got} is not the pinned ${fx.sha256}`); process.exit(1) }
    const names = execFileSync('unzip', ['-Z1', orig], { env: ENV, maxBuffer: 1 << 26 }).toString('utf8').split('\n').filter((n) => n && !n.endsWith('/'))
    const kept = names.filter((n) => fx.keep.some((re) => re.test(n))).sort()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hf127-trim-'))
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hf127-stub-'))
  fs.mkdirSync(path.join(tmp, 'META-INF'))
  fs.writeFileSync(path.join(tmp, 'META-INF', 'neoforge.mods.toml'), `modLoader="javafml"\nloaderVersion="[1,)"\nlicense="test fixture"\n[[mods]]\nmodId="${STUB.modId}"\nversion="0.0.0"\n`)
  const stubOut = path.join(HERE, STUB.fixture)
  zipDir(tmp, stubOut)
  fs.rmSync(tmp, { recursive: true, force: true })
  manifest[STUB.fixture] = { original: null, original_sha256: null, url: null, entries: 1, sha256: sha256(stubOut) }
  fs.writeFileSync(path.join(HERE, 'hf127-fixtures.json'), JSON.stringify(manifest, null, 2) + '\n')
  for (const [k, v] of Object.entries(manifest)) console.log(`${k} ${v.entries} entries ${v.sha256}`)
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main()
