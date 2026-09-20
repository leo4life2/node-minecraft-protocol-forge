'use strict'

// HF58b test helper: build a ZIP64 archive in memory (stored entries, no
// compression) whose classic end-of-central-directory record carries the
// SATURATED 16-bit entry count (0xFFFF) and 32-bit directory offset
// (0xFFFFFFFF), the way every ZIP64 writer emits an archive past 65,535
// entries - the true values live in the ZIP64 EOCD record behind the
// locator (APPNOTE 4.3.14 / 4.3.15). Generated at test time, never committed.
function buildZip64 (entries) {
  const locals = []
  const centrals = []
  let off = 0
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4) // version needed
    lh.writeUInt16LE(0, 6) // flags
    lh.writeUInt16LE(0, 8) // stored
    lh.writeUInt32LE(0, 14) // crc (unused by the reader under test)
    lh.writeUInt32LE(body.length, 18)
    lh.writeUInt32LE(body.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(45, 4) // made by (zip64)
    ch.writeUInt16LE(45, 6) // needed
    ch.writeUInt16LE(0, 10) // stored
    ch.writeUInt32LE(body.length, 20)
    ch.writeUInt32LE(body.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt16LE(0, 30) // extra
    ch.writeUInt16LE(0, 32) // comment
    ch.writeUInt32LE(off, 42) // local header offset (all archives here stay under 4 GiB)
    locals.push(lh, nameBuf, body)
    centrals.push(ch, nameBuf)
    off += lh.length + nameBuf.length + body.length
  }
  const cdOffset = off
  const cd = Buffer.concat(centrals)
  const rec64 = Buffer.alloc(56)
  rec64.writeUInt32LE(0x06064b50, 0)
  rec64.writeBigUInt64LE(BigInt(44), 4) // size of the remaining record
  rec64.writeUInt16LE(45, 12)
  rec64.writeUInt16LE(45, 14)
  rec64.writeUInt32LE(0, 16)
  rec64.writeUInt32LE(0, 20)
  rec64.writeBigUInt64LE(BigInt(entries.length), 24) // entries on this disk
  rec64.writeBigUInt64LE(BigInt(entries.length), 32) // total entries
  rec64.writeBigUInt64LE(BigInt(cd.length), 40)
  rec64.writeBigUInt64LE(BigInt(cdOffset), 48)
  const loc = Buffer.alloc(20)
  loc.writeUInt32LE(0x07064b50, 0)
  loc.writeUInt32LE(0, 4)
  loc.writeBigUInt64LE(BigInt(cdOffset + cd.length), 8) // where the ZIP64 EOCD record starts
  loc.writeUInt32LE(1, 16)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0xFFFF, 8)
  eocd.writeUInt16LE(0xFFFF, 10)
  eocd.writeUInt32LE(0xFFFFFFFF, 12)
  eocd.writeUInt32LE(0xFFFFFFFF, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, cd, rec64, loc, eocd])
}

module.exports = { buildZip64 }
