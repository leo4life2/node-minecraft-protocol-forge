const debug = require('debug')('minecraft-protocol-forge')

/**
 * Decodes the optimized FML3 data format used in Minecraft 1.18+
 * Direct port of Forge's decodeOptimized method from:
 * https://github.com/MinecraftForge/MinecraftForge/blob/cb12df41e13da576b781be695f80728b9594c25f/src/main/java/net/minecraftforge/network/ServerStatusPing.java
 * 
 * @param {string} encodedData The encoded data string from forgeData["d"]
 * @returns {Array<{id: string, version: string}>} Array of mod IDs and versions
 */
function decodeOptimized(encodedData) {
  try {
    debug(`Decoding data of length ${encodedData.length}`);
    
    // First decode the binary data according to Forge's algorithm
    const buffer = decodeOptimizedBinary(encodedData);
    debug(`Decoded binary data of length ${buffer.length}`);
    
    // Now parse the mod data from the buffer
    let offset = 0;
    const mods = [];
    
    try {
      // Read truncated boolean (ignored)
      const truncated = buffer[offset] !== 0;
      offset += 1;
      debug(`Truncated: ${truncated}`);
      
      // Read mod size as unsigned short (2 bytes)
      const modSize = (buffer[offset] << 8) | buffer[offset + 1];
      offset += 2;
      debug(`Mod size: ${modSize}`);
      
      // For each mod
      for (let i = 0; i < modSize; i++) {
        try {
          // Read channel size and version flag as varint
          const { value: channelSizeAndVersionFlag, bytesRead: varIntBytes } = readVarInt(buffer, offset);
          offset += varIntBytes;
          
          // Extract channel size (right shift by 1)
          const channelSize = channelSizeAndVersionFlag >> 1;
          // Check version flag (bit 0)
          const isIgnoreServerOnly = (channelSizeAndVersionFlag & 0x1) !== 0;
          debug(`Channel size: ${channelSize}, isIgnoreServerOnly: ${isIgnoreServerOnly}`);
          
          // Read mod ID as string
          const { value: modId, bytesRead: modIdBytes } = readString(buffer, offset);
          offset += modIdBytes;
          
          // Read mod version as string (if version flag is 0)
          let modVersion = 'IGNORED';
          if (!isIgnoreServerOnly) {
            const { value: version, bytesRead: versionBytes } = readString(buffer, offset);
            modVersion = version;
            offset += versionBytes;
          }
          debug(`Mod: ${modId}@${modVersion}`);
          
          // Skip channel list data
          for (let j = 0; j < channelSize; j++) {
            // Skip channel name
            const { bytesRead: channelNameBytes } = readString(buffer, offset);
            offset += channelNameBytes;
            
            // Skip channel version
            const { bytesRead: channelVersionBytes } = readString(buffer, offset);
            offset += channelVersionBytes;
            
            // Skip required flag
            offset += 1; // Boolean is 1 byte
          }
          
          mods.push({ id: modId, version: modVersion });
        } catch (err) {
          debug(`Error processing mod ${i}: ${err.message}`);
          break;
        }
      }
    } catch (err) {
      debug(`Error during decoding: ${err.message}`);
    }
    
    debug(`Decoded ${mods.length} mods`);
    return mods;
  } catch (err) {
    debug(`Fatal error in decodeOptimized: ${err.message}`);
    return [];
  }
}

/**
 * Decodes the string to binary data according to Forge's decodeOptimized algorithm
 * @param {string} s The encoded string
 * @returns {Buffer} The decoded binary data
 */
function decodeOptimizedBinary(s) {
  // Extract the size from the first two characters
  const size0 = s.charCodeAt(0);
  const size1 = s.charCodeAt(1);
  const size = size0 | (size1 << 15);
  
  debug(`Binary data size: ${size}`);
  
  const buf = Buffer.alloc(size);
  let bufIndex = 0;
  
  let stringIndex = 2;
  let buffer = 0;
  let bitsInBuf = 0;
  
  while (stringIndex < s.length) {
    // Extract a byte from the buffer when we have enough bits
    while (bitsInBuf >= 8) {
      buf[bufIndex++] = buffer & 0xFF;
      buffer >>>= 8;
      bitsInBuf -= 8;
    }
    
    // Read the next 15 bits from the string
    const c = s.charCodeAt(stringIndex);
    buffer |= (c & 0x7FFF) << bitsInBuf;
    bitsInBuf += 15;
    stringIndex++;
  }
  
  // Write any leftover bits
  while (bufIndex < size) {
    buf[bufIndex++] = buffer & 0xFF;
    buffer >>>= 8;
    bitsInBuf -= 8;
  }
  
  return buf;
}

/**
 * Read a VarInt from a buffer
 * @param {Buffer} buffer The buffer to read from
 * @param {number} offset The offset to start reading from
 * @returns {{value: number, bytesRead: number}} The value and number of bytes read
 */
function readVarInt(buffer, offset) {
  let result = 0;
  let bytesRead = 0;
  let currentByte;
  
  do {
    if (offset + bytesRead >= buffer.length) {
      throw new Error(`Buffer overflow reading VarInt at offset ${offset}`);
    }
    
    currentByte = buffer[offset + bytesRead];
    result |= (currentByte & 0x7F) << (7 * bytesRead);
    bytesRead++;
    
    if (bytesRead > 5) {
      throw new Error('VarInt is too big');
    }
  } while ((currentByte & 0x80) !== 0);
  
  return { value: result, bytesRead };
}

/**
 * Read a string from a buffer
 * @param {Buffer} buffer The buffer to read from
 * @param {number} offset The offset to start reading from
 * @returns {{value: string, bytesRead: number}} The string and number of bytes read
 */
function readString(buffer, offset) {
  // Read string length as VarInt
  const { value: length, bytesRead: lengthBytes } = readVarInt(buffer, offset);
  offset += lengthBytes;
  
  if (offset + length > buffer.length) {
    throw new Error(`Buffer overflow reading string of length ${length} at offset ${offset}`);
  }
  
  const value = buffer.toString('utf8', offset, offset + length);
  return { value, bytesRead: lengthBytes + length };
}

module.exports = decodeOptimized 