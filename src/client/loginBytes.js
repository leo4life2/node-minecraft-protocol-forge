// FriendlyByteBuf-compatible primitives shared by the login-phase reply
// builders (forgeHandshake3.js FML3 lane, owoHandshake.js shared owo lane).
// Moved verbatim out of forgeHandshake3.js (HF35) so the owo derivation can
// be one implementation used by both the Forge fork and the Fabric lib.

function readVarInt (buffer, offset) {
  let result = 0
  let bytesRead = 0
  let currentByte
  do {
    if (offset + bytesRead >= buffer.length) throw new Error(`buffer ended while reading VarInt at ${offset}`)
    currentByte = buffer[offset + bytesRead]
    result |= (currentByte & 0x7F) << (7 * bytesRead)
    bytesRead++
    if (bytesRead > 5) throw new Error('VarInt too big')
  } while ((currentByte & 0x80) !== 0)
  return { value: result, size: bytesRead }
}

function writeVarInt (value) {
  const bytes = []
  do {
    let b = value & 0x7F
    value >>>= 7
    if (value !== 0) b |= 0x80
    bytes.push(b)
  } while (value !== 0)
  return Buffer.from(bytes)
}

function readString (buffer, offset) {
  const len = readVarInt(buffer, offset)
  // a 5-byte varint can decode negative; accepting it would move the read
  // cursor BACKWARD (size = len.size + len.value), letting a malformed packet
  // loop over the same bytes forever without ever hitting the bounds check
  if (len.value < 0) throw new Error(`negative string length at ${offset}`)
  const start = offset + len.size
  if (start + len.value > buffer.length) throw new Error(`buffer ended while reading string at ${offset}`)
  return { value: buffer.toString('utf8', start, start + len.value), size: len.size + len.value }
}

function writeString (str) {
  const utf8 = Buffer.from(str, 'utf8')
  return Buffer.concat([writeVarInt(utf8.length), utf8])
}

module.exports = { readVarInt, writeVarInt, readString, writeString }
