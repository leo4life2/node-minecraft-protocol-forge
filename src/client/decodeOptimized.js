const debug = require('debug')('minecraft-protocol-forge')

/**
 * Decodes the optimized FML3 status-ping data used by Forge on Minecraft 1.18+.
 * Port of Forge's ServerStatusPing.decodeOptimized / deserializeOptimized:
 * https://github.com/MinecraftForge/MinecraftForge/blob/1.20.1/src/main/java/net/minecraftforge/network/ServerStatusPing.java
 *
 * Layout of the decoded binary:
 *   boolean truncated
 *   unsigned short modCount
 *   modCount x {
 *     varint  channelSizeAndVersionFlag   // channelCount << 1 | ignoreServerOnly
 *     string  modId
 *     string  modVersion                  // only if !ignoreServerOnly
 *     channelCount x { string channelPath ; string channelVersion ; boolean required }
 *   }
 *   varint nonModChannelCount
 *   nonModChannelCount x { string channelName ; string channelVersion ; boolean required }
 *
 * @param {string} encodedData The encoded string from forgeData["d"]
 * @param {{ varIntChannelVersions?: boolean }} [options] On 1.20.2+ (protocol
 *   >= 764) Forge writes each channel version as a VarInt instead of a string;
 *   set varIntChannelVersions to read it that way (otherwise it reads a string).
 * @returns {{
 *   truncated: boolean,
 *   mods: Array<{id: string, version: string}>,
 *   channels: Array<{name: string, version: string, required: boolean}>
 * }}
 */
function decodeOptimized (encodedData, { varIntChannelVersions = false } = {}) {
  const buffer = decodeOptimizedBinary(encodedData)
  debug(`decoded ${encodedData.length} chars into ${buffer.length} bytes of ping data`)

  // 1.20.2+ encodes per-channel versions as VarInt; earlier builds use strings.
  const readChannelVersion = (buf, off) => {
    if (varIntChannelVersions) {
      const { value, bytesRead } = readVarInt(buf, off)
      return { value: String(value), bytesRead }
    }
    return readString(buf, off)
  }

  let offset = 0
  const mods = []
  const channels = []

  const truncated = buffer[offset] !== 0
  offset += 1

  const modCount = (buffer[offset] << 8) | buffer[offset + 1]
  offset += 2

  for (let i = 0; i < modCount; i++) {
    const { value: channelSizeAndVersionFlag, bytesRead: flagBytes } = readVarInt(buffer, offset)
    offset += flagBytes
    const channelCount = channelSizeAndVersionFlag >>> 1
    const isIgnoreServerOnly = (channelSizeAndVersionFlag & 0x1) !== 0

    const { value: modId, bytesRead: modIdBytes } = readString(buffer, offset)
    offset += modIdBytes

    let modVersion = 'SERVER_ONLY'
    if (!isIgnoreServerOnly) {
      const { value: version, bytesRead: versionBytes } = readString(buffer, offset)
      modVersion = version
      offset += versionBytes
    }

    // channels registered by this mod are written with their path only; the
    // namespace is implicitly the mod id
    for (let j = 0; j < channelCount; j++) {
      const { value: channelPath, bytesRead: pathBytes } = readString(buffer, offset)
      offset += pathBytes
      const { value: channelVersion, bytesRead: chVersionBytes } = readChannelVersion(buffer, offset)
      offset += chVersionBytes
      const required = buffer[offset] !== 0
      offset += 1
      channels.push({ name: `${modId}:${channelPath}`, version: channelVersion, required })
    }

    mods.push({ id: modId, version: modVersion })
  }

  // channels whose namespace is not a mod id (e.g. fml:*, minecraft:*) follow
  // the mod list with their full name
  if (offset < buffer.length) {
    const { value: extraCount, bytesRead: extraBytes } = readVarInt(buffer, offset)
    offset += extraBytes
    for (let i = 0; i < extraCount; i++) {
      const { value: channelName, bytesRead: nameBytes } = readString(buffer, offset)
      offset += nameBytes
      const { value: channelVersion, bytesRead: chVersionBytes } = readChannelVersion(buffer, offset)
      offset += chVersionBytes
      const required = buffer[offset] !== 0
      offset += 1
      channels.push({ name: channelName, version: channelVersion, required })
    }
  }

  debug(`decoded ping: truncated=${truncated} mods=${mods.length} channels=${channels.length}`)
  return { truncated, mods, channels }
}

/**
 * Decodes the string to binary data according to Forge's decodeOptimized algorithm:
 * chars 0-1 hold the byte length, every following UTF-16 code unit carries 15 bits.
 * @param {string} s The encoded string
 * @returns {Buffer} The decoded binary data
 */
function decodeOptimizedBinary (s) {
  const size0 = s.charCodeAt(0)
  const size1 = s.charCodeAt(1)
  const size = size0 | (size1 << 15)

  const buf = Buffer.alloc(size)
  let bufIndex = 0

  let stringIndex = 2
  let buffer = 0
  let bitsInBuf = 0

  while (stringIndex < s.length) {
    while (bitsInBuf >= 8) {
      buf[bufIndex++] = buffer & 0xFF
      buffer >>>= 8
      bitsInBuf -= 8
    }

    const c = s.charCodeAt(stringIndex)
    buffer |= (c & 0x7FFF) << bitsInBuf
    bitsInBuf += 15
    stringIndex++
  }

  while (bufIndex < size) {
    buf[bufIndex++] = buffer & 0xFF
    buffer >>>= 8
    bitsInBuf -= 8
  }

  return buf
}

function readVarInt (buffer, offset) {
  let result = 0
  let bytesRead = 0
  let currentByte

  do {
    if (offset + bytesRead >= buffer.length) {
      throw new Error(`Buffer overflow reading VarInt at offset ${offset}`)
    }

    currentByte = buffer[offset + bytesRead]
    result |= (currentByte & 0x7F) << (7 * bytesRead)
    bytesRead++

    if (bytesRead > 5) {
      throw new Error('VarInt is too big')
    }
  } while ((currentByte & 0x80) !== 0)

  return { value: result, bytesRead }
}

function readString (buffer, offset) {
  const { value: length, bytesRead: lengthBytes } = readVarInt(buffer, offset)
  offset += lengthBytes

  if (offset + length > buffer.length) {
    throw new Error(`Buffer overflow reading string of length ${length} at offset ${offset}`)
  }

  const value = buffer.toString('utf8', offset, offset + length)
  return { value, bytesRead: lengthBytes + length }
}

module.exports = decodeOptimized
