'use strict'

// Shared static-analysis primitives for reading mod jars: a minimal ZIP
// (jar) reader, a minimal Java .class parser (constant pool + per-method
// code), and a JVM bytecode walker. Extracted from the owo fingerprint
// scanner (forgeHandshake3.js) so the SimpleChannel login-ack derivation
// (loginAckDerivation.js) shares one implementation.
//
// DESIGN LAWS (owner-ratified; enforced by the embedding app's
// privacy-laws test battery):
//   - READ-ONLY, JARS-ONLY: these helpers read bytes from local files and
//     parse them. Nothing is ever classloaded, executed, written, or sent
//     anywhere; this module requires only zlib (inflate).
//   - PURPOSE-LIMITED: consumers extract network-registration signatures
//     (channel ids, message registration indices/fingerprints) only.

const zlib = require('zlib')

// - minimal ZIP (jar) reader: central directory walk + per-entry inflate -
function zipCentralEntries (buf) {
  let eocd = -1
  for (let i = buf.length - 22, min = Math.max(0, buf.length - 65557); i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('no zip end-of-central-directory')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break
    const nameLen = buf.readUInt16LE(off + 28)
    entries.push({
      name: buf.toString('utf8', off + 46, off + 46 + nameLen),
      method: buf.readUInt16LE(off + 10),
      csize: buf.readUInt32LE(off + 20),
      localOff: buf.readUInt32LE(off + 42)
    })
    off += 46 + nameLen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32)
  }
  return entries
}

function zipEntryData (buf, entry) {
  const off = entry.localOff
  if (buf.readUInt32LE(off) !== 0x04034b50) throw new Error('bad zip local header')
  const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28)
  const raw = buf.slice(start, start + entry.csize)
  return entry.method === 0 ? raw : zlib.inflateRawSync(raw)
}

// - minimal .class parser: constant pool + per-method flags/descriptor/Code -
function parseClassFile (b) {
  if (b.length < 10 || b.readUInt32BE(0) !== 0xCAFEBABE) return null
  const cpCount = b.readUInt16BE(8)
  const cp = new Array(cpCount)
  let o = 10
  for (let i = 1; i < cpCount; i++) {
    const tag = b[o]
    switch (tag) {
      case 1: { const len = b.readUInt16BE(o + 1); cp[i] = { tag, str: b.toString('utf8', o + 3, o + 3 + len) }; o += 3 + len; break }
      case 7: cp[i] = { tag, nameIndex: b.readUInt16BE(o + 1) }; o += 3; break
      case 8: cp[i] = { tag, strIndex: b.readUInt16BE(o + 1) }; o += 3; break
      case 16: case 19: case 20: o += 3; break
      case 15: o += 4; break
      case 3: cp[i] = { tag, int: b.readInt32BE(o + 1) }; o += 5; break
      case 4: o += 5; break
      case 9: case 10: case 11: cp[i] = { tag, classIndex: b.readUInt16BE(o + 1), natIndex: b.readUInt16BE(o + 3) }; o += 5; break
      case 12: cp[i] = { tag, nameIndex: b.readUInt16BE(o + 1), descIndex: b.readUInt16BE(o + 3) }; o += 5; break
      case 17: case 18: o += 5; break
      case 5: case 6: o += 9; i++; break // long/double take two slots
      default: return null // unknown tag: not a class file we can read
    }
  }
  const className = cp[cp[b.readUInt16BE(o + 2)].nameIndex].str
  o += 6 // access_flags, this_class, super_class
  o += 2 + b.readUInt16BE(o) * 2 // interfaces
  const readMembers = () => {
    const n = b.readUInt16BE(o); o += 2
    const out = []
    for (let i = 0; i < n; i++) {
      const flags = b.readUInt16BE(o)
      const nameIndex = b.readUInt16BE(o + 2)
      const descIndex = b.readUInt16BE(o + 4)
      const attrCount = b.readUInt16BE(o + 6); o += 8
      const attrs = []
      for (let a = 0; a < attrCount; a++) {
        const attr = { name: cp[b.readUInt16BE(o)].str, start: o + 6, len: b.readUInt32BE(o + 2) }
        attrs.push(attr)
        o += 6 + attr.len
      }
      out.push({
        flags,
        name: cp[nameIndex] ? cp[nameIndex].str : '?',
        desc: cp[descIndex] ? cp[descIndex].str : '?',
        attrs
      })
    }
    return out
  }
  readMembers() // fields (skipped)
  const codes = []
  for (const m of readMembers()) {
    const code = m.attrs.find((a) => a.name === 'Code')
    if (!code) continue
    const codeLen = b.readUInt32BE(code.start + 4)
    codes.push({ method: m.name, desc: m.desc, flags: m.flags, code: b.slice(code.start + 8, code.start + 8 + codeLen) })
  }
  return { className, cp, codes }
}

// JVM bytecode walk: fixed instruction lengths, with the four variable-length
// forms (tableswitch/lookupswitch/wide) handled inline.
const JVM_OP_LEN = (() => {
  const t = new Uint8Array(256).fill(1)
  for (const op of [0x10, 0x12, 0x15, 0x16, 0x17, 0x18, 0x19, 0x36, 0x37, 0x38, 0x39, 0x3a, 0xbc, 0xa9]) t[op] = 2
  for (const op of [0x11, 0x13, 0x14, 0x84, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xbb, 0xbd, 0xc0, 0xc1, 0xc6, 0xc7,
    0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8]) t[op] = 3
  t[0xc5] = 4
  for (const op of [0xb9, 0xba, 0xc8, 0xc9]) t[op] = 5
  return t
})()

function walkBytecode (code, visit) {
  let pc = 0
  while (pc < code.length) {
    const op = code[pc]
    let len = JVM_OP_LEN[op]
    if (op === 0xaa) { // tableswitch
      const p = (pc + 4) & ~3
      len = (p - pc) + 12 + (code.readInt32BE(p + 8) - code.readInt32BE(p + 4) + 1) * 4
    } else if (op === 0xab) { // lookupswitch
      const p = (pc + 4) & ~3
      len = (p - pc) + 8 + code.readInt32BE(p + 4) * 8
    } else if (op === 0xc4) { // wide
      len = code[pc + 1] === 0x84 ? 6 : 4
    }
    visit(op, pc)
    pc += len
  }
}

// - constant-pool convenience shared by the scanners -
function cpUtf8 (cp, i) { return (cp[i] && cp[i].str) || null }
function cpClassName (cp, i) { return (cp[i] && cp[i].tag === 7 ? cpUtf8(cp, cp[i].nameIndex) : null) }
// Field/Method/InterfaceMethod ref -> {owner, name, desc}
function cpRef (cp, i) {
  const c = cp[i]
  if (!c || !c.classIndex) return null
  const nat = cp[c.natIndex]
  if (!nat) return null
  return { owner: cpClassName(cp, c.classIndex), name: cpUtf8(cp, nat.nameIndex), desc: cpUtf8(cp, nat.descIndex) }
}

// Java's String.hashCode in 32-bit int arithmetic.
function javaStringHash (s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return h
}

module.exports = {
  zipCentralEntries,
  zipEntryData,
  parseClassFile,
  walkBytecode,
  JVM_OP_LEN,
  cpUtf8,
  cpClassName,
  cpRef,
  javaStringHash
}
