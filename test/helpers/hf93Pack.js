'use strict'
// HF93 fixture helper: a SYNTHETIC large pack - many small DEFLATED jars
// (a mods.toml each + padding classes whose inflated bytes make the
// login-ack jar walk measurably long) plus one jar that NESTS the queried
// channel's owner (the hf53 trimmed fixture under META-INF/jarjar, the
// field shape). Never a real pack; every byte is built here.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const OWNER_FIXTURE = path.join(__dirname, '..', 'fixtures', 'hf53-origins-forge-1.20.1-1.10.0.9.trimmed.jar')
const OWNER_CHANNEL = 'calio:channel'
const OWNER_NESTED = 'META-INF/jarjar/calio-forge-1.20.1-1.11.0.5.jar'

function u16 (n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
function u32 (n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b }

/** A DEFLATED (method 8) jar: [{ name, data }] -> Buffer (the STORE writer in synthJar stays as it is). */
function deflatedJar (entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data)
    // the same bytes deflate once (a pack repeats its padding class)
    const packed = e.packed || zlib.deflateRawSync(raw)
    const crc = e.crc != null ? e.crc : zlib.crc32(raw)
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0), u32(crc), u32(packed.length), u32(raw.length), u16(name.length), u16(0), name, packed])
    centrals.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(crc), u32(packed.length), u32(raw.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]))
    locals.push(local)
    offset += local.length
  }
  const central = Buffer.concat(centrals)
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(central.length), u32(offset), u16(0)])
  return Buffer.concat([...locals, central, end])
}

/** A minimal valid class file carrying one unknown attribute of `paddingBytes` zero bytes (never hot: no channel bytes). */
function paddingClass (name, paddingBytes) {
  const utf8 = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([Buffer.from([1]), u16be(b.length), b]) }
  const u16be = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b }
  const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b }
  const cp = [utf8(name), Buffer.concat([Buffer.from([7]), u16be(1)]), utf8('java/lang/Object'), Buffer.concat([Buffer.from([7]), u16be(3)]), utf8('Padding')]
  return Buffer.concat([
    u32be(0xcafebabe), u16be(0), u16be(52), u16be(cp.length + 1), ...cp,
    u16be(0x0021), u16be(2), u16be(4), u16be(0), u16be(0), u16be(0),
    u16be(1), u16be(5), u32be(paddingBytes), Buffer.alloc(paddingBytes)
  ])
}

function modsToml (modId) {
  return `modLoader="javafml"\nloaderVersion="[47,)"\nlicense="synthetic"\n[[mods]]\nmodId="${modId}"\nversion="1.0.0"\n`
}

/**
 * Builds the pack under `dir`: `jars` padding jars (each `classesPerJar`
 * classes of `paddingBytes`) and the nested-owner jar. Returns the facts the
 * tests assert on. Deterministic: the same arguments build the same bytes.
 */
function buildSyntheticPack (dir, { jars = 300, classesPerJar = 4, paddingBytes = 1 << 20, ownerName = 'origins-all.jar' } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const classBytes = paddingClass('pad/P', paddingBytes)
  const packed = zlib.deflateRawSync(classBytes)
  const crc = zlib.crc32(classBytes)
  let inflated = 0
  for (let i = 0; i < jars; i++) {
    const entries = [{ name: 'META-INF/mods.toml', data: modsToml(`pad${i}`) }]
    for (let j = 0; j < classesPerJar; j++) { entries.push({ name: `pad${i}/C${j}.class`, data: classBytes, packed, crc }); inflated += classBytes.length }
    fs.writeFileSync(path.join(dir, `pad-${String(i).padStart(4, '0')}.jar`), deflatedJar(entries))
  }
  fs.copyFileSync(OWNER_FIXTURE, path.join(dir, ownerName))
  return { dir, jars: jars + 1, inflatedBytes: inflated, channel: OWNER_CHANNEL, ownerJar: path.join(dir, ownerName), nested: OWNER_NESTED }
}

module.exports = { deflatedJar, paddingClass, modsToml, buildSyntheticPack, OWNER_FIXTURE, OWNER_CHANNEL, OWNER_NESTED }
