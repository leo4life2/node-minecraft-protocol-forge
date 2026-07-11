const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const debug = require('debug')('minecraft-protocol-forge')

// FML3 login handshake (Forge for Minecraft 1.18 - 1.20.1, fmlNetworkVersion 3).
//
// The server drives the handshake through vanilla login_plugin_request packets on
// the 'fml:loginwrapper' channel. Each wrapped payload is an 'fml:handshake'
// message: a one-byte discriminator followed by the message body
// (net.minecraftforge.network.HandshakeMessages):
//
//   1  S2CModList            -> reply 2 C2SModListReply (mirror mods/channels/registries)
//   3  S2CRegistry           -> reply 99 C2SAcknowledge
//   4  S2CConfigData         -> reply 99 C2SAcknowledge
//   5  S2CModData            -> informational (server expects no specific reply)
//   6  S2CChannelMismatchData-> only sent while rejecting us; parsed (names the
//                               rejected channels) and re-emitted as the
//                               'forgeChannelMismatch' client event
//   99 C2SAcknowledge        -> clientbound never
//
// We never apply registry/config payloads - we only acknowledge them so the login
// completes. Message bodies other than ModList are deliberately not parsed: their
// exact layout has changed between Forge versions (e.g. registry snapshots) and
// parsing them is not needed to get through the handshake.
//
// fml:handshake is NOT the only login gate. Individual mods (and, through
// Sinytra Connector, Fabric mods) run their OWN login sub-protocols on the same
// vanilla login_plugin_request lane — either wrapped in fml:loginwrapper (Forge
// SimpleChannel login messages) or on the mod's raw channel (Fabric login
// networking). Each decodes replies in its OWN discriminator space, so the FML
// acknowledge byte 99 is not a universal answer: on a channel that doesn't
// register index 99 it's an invalid discriminator (instant
// "unexpected query response" kick), and on one that does, an empty body can
// under-read and kick too. See WRAPPED_LOGIN_PROTOCOLS / RAW_LOGIN_PROTOCOLS.

const DISCRIMINATOR = {
  MOD_LIST: 1,
  MOD_LIST_REPLY: 2,
  SERVER_REGISTRY: 3,
  CHANNEL_MISMATCH: 6,
  ACKNOWLEDGEMENT: 99
}

// Forge registries whose id->name snapshot is worth keeping so the bot can name
// modded content the vanilla protocol reports as `unknown`. Maps the on-wire
// registry name to the short key stashed on client.forgeRegistries.
const SNAPSHOT_REGISTRIES = {
  'minecraft:item': 'item',
  'minecraft:block': 'block',
  'minecraft:entity_type': 'entity_type'
}

// --- FriendlyByteBuf-compatible primitives ---

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

// --- fml:loginwrapper framing: string channel + varint-length-prefixed payload ---

function parseLoginWrapper (buffer) {
  let offset = 0
  const channel = readString(buffer, offset)
  offset += channel.size
  const len = readVarInt(buffer, offset)
  offset += len.size
  return { channel: channel.value, data: buffer.slice(offset, offset + len.value) }
}

function wrapLoginPayload (channel, payload) {
  return Buffer.concat([writeString(channel), writeVarInt(payload.length), payload])
}

// --- fml:handshake messages ---

// S2CModList: mods (string list), channels (name+version pairs), registries
// (name list) and, on 1.19+, dataPackRegistries (name list). The trailing field
// is parsed only if bytes remain, so both layouts work.
function parseModList (buffer, offset) {
  const readList = (reader) => {
    const count = readVarInt(buffer, offset)
    offset += count.size
    const out = []
    for (let i = 0; i < count.value; i++) out.push(reader())
    return out
  }
  const readStr = () => {
    const s = readString(buffer, offset)
    offset += s.size
    return s.value
  }

  const mods = readList(readStr)
  const channels = readList(() => {
    const name = readStr()
    const marker = readStr()
    return { name, marker }
  })
  const registries = readList(readStr)
  const dataPackRegistries = offset < buffer.length ? readList(readStr) : []
  return { mods, channels, registries, dataPackRegistries }
}

function encodeModListReply (reply) {
  const parts = [writeVarInt(DISCRIMINATOR.MOD_LIST_REPLY)]
  parts.push(writeVarInt(reply.mods.length))
  for (const mod of reply.mods) parts.push(writeString(mod))
  parts.push(writeVarInt(reply.channels.length))
  for (const channel of reply.channels) {
    parts.push(writeString(channel.name), writeString(channel.marker))
  }
  parts.push(writeVarInt(reply.registries.length))
  for (const registry of reply.registries) {
    parts.push(writeString(registry.name), writeString(registry.marker))
  }
  return Buffer.concat(parts)
}

function encodeAcknowledgement () {
  return writeVarInt(DISCRIMINATOR.ACKNOWLEDGEMENT)
}

// --- mod login sub-protocols ---
//
// The builders below are keyed by channel id. A channel id names a mod/
// library-level PROTOCOL (the same on every server and pack that carries the
// library), never a specific server. Replies verified against the mods'
// bytecode and a live Forge 1.20.1 + Sinytra Connector hybrid server.

// Wrapped (fml:loginwrapper) mod login messages: builder(disc, body) returns
// the reply payload for the SAME inner channel, or null to fall through to
// the FML acknowledge. Unknown wrapped channels keep getting the FML ack 99:
// mods that copy FML's HandshakeMessages convention register their
// acknowledge at login index 99, so it stays the least-bad default.
const WRAPPED_LOGIN_PROTOCOLS = {
  // TACZ (tacz:handshake): NetworkHandler seeds HANDSHAKE_ID_COUNT at 1, so
  // its Acknowledge login message is index 1 with an empty body. The server
  // sends ServerMessageSyncedEntityDataMapping (index 2) and waits for that
  // Acknowledge; byte 99 is an invalid discriminator in tacz's index space
  // ("Received invalid discriminator byte 99" -> unexpected_query_response).
  'tacz:handshake': () => Buffer.from([0x01]),
  // Zeta (zeta:main, the library behind Quark): the server sends S2CLoginFlag
  // (index 98) carrying a flags BitSet + expectedLength + expectedHash, and
  // SyncedFlagHandler validates that C2SLoginFlag (index 99) carries the SAME
  // body - echo it back verbatim. A bare index-99 byte under-reads ("Error at
  // reading message ...C2SLoginFlag") and kicks.
  'zeta:main': (disc, body) => disc === 98 ? Buffer.concat([writeVarInt(99), body]) : null
}

// --- owo-lib login fingerprints (owo:handshake) ---
//
// owo-lib (Fabric, reaches Forge servers via Sinytra Connector) gates the
// login with a query on the raw owo:handshake channel. Wire format, verified
// against OwoHandshake bytecode (owo-lib 0.11.2) AND captured live:
//
//   S2C LoginQueryRequest payload (OwoHandshake#queryStart):
//     Map<Identifier,int> - hashes of the server's OPTIONAL owo channels ONLY
//     (captured live: a single byte 0x00 = empty map when there are none).
//     The server's REQUIRED channel/controller hashes NEVER cross the wire,
//     so they cannot simply be echoed back - the client must produce them.
//
//   C2S LoginQueryResponse payload (OwoHandshake#syncClient):
//     Map<Identifier,int> requiredChannelHashes
//     Map<Identifier,int> controllerHashes
//     Map<Identifier,int> optionalChannelHashes
//   (each map: varint size, then size x (string "ns:path", varint value);
//   values are Java int hash codes - negatives take the 5-byte varint form).
//
//   Server verification (OwoHandshake#syncServer -> verifyReceivedHashes):
//   the reply's required-channel and controller key SETS must EQUAL the
//   server's own and every value must equal the server's hash, else the login
//   is rejected ("client is missing channels/controllers: ..." / "channels
//   with mismatched hashes: ..."). The third map only feeds
//   filterOptionalServices, which never rejects - so the server's advertised
//   optional map is echoed back verbatim and matches by construction.
//
// The required hashes are content fingerprints of the owning mod's registered
// packet records and particle systems:
//   hashChannel    = 31*idHash + sum(+/-index*31 + recordClass.getName().hashCode())
//   hashController = 31*idHash + sum(indices 0..k-1) = 31*idHash + k*(k-1)/2
// The record CLASS NAMES never appear on the wire, so the only generalizable
// source is the mod jars themselves. scanOwoFingerprints() below derives every
// owo channel/controller fingerprint statically from the modpack's mods folder
// (options.owoModsPaths or the MINEPAL_FORGE_MODS_DIR env var) - no per-pack
// or per-mod constants. It reads each jar (plus META-INF/jars/*.jar nested
// mods), parses the classes that reference owo, and replays the registration
// bytecode patterns javac emits for OwoNetChannel.create/createOptional,
// registerServerbound/registerClientbound(Deferred) and
// ParticleSystemController register/registerDeferred.
//
// Known limits (all fail towards an honest, channel-naming server kick):
// mods that relocate/shade owo, compute identifiers through string concat
// helpers, or spread one direction's registrations across multiple methods in
// an order that differs from runtime init order. Without a configured mods
// folder the reply carries empty maps: servers that don't REQUIRE the owo
// handshake still accept, and gating servers reject naming the channels the
// client is missing.

// FriendlyByteBuf map: varint size, then size x (string id, varint value).
// Values may be negative (Java int hash codes) - writeVarInt handles the
// 5-byte two's-complement form the same way FriendlyByteBuf#writeVarInt does.
function encodeIdHashMap (map) {
  const entries = Object.entries(map)
  const parts = [writeVarInt(entries.length)]
  for (const [id, hash] of entries) parts.push(writeString(id), writeVarInt(hash))
  return Buffer.concat(parts)
}

// Java's String.hashCode / Identifier.hashCode (31*ns.hashCode()+path.hashCode()),
// in 32-bit int arithmetic.
function javaStringHash (s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return h
}
function owoIdentifierHash (ns, p) { return (Math.imul(31, javaStringHash(ns)) + javaStringHash(p)) | 0 }

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

// - minimal .class parser: constant pool + per-method Code bytes -
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
      case 3: case 4: o += 5; break
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
      const nameIndex = b.readUInt16BE(o + 2)
      const attrCount = b.readUInt16BE(o + 6); o += 8
      const attrs = []
      for (let a = 0; a < attrCount; a++) {
        const attr = { name: cp[b.readUInt16BE(o)].str, start: o + 6, len: b.readUInt32BE(o + 2) }
        attrs.push(attr)
        o += 6 + attr.len
      }
      out.push({ name: cp[nameIndex] ? cp[nameIndex].str : '?', attrs })
    }
    return out
  }
  readMembers() // fields (skipped)
  const codes = []
  for (const m of readMembers()) {
    const code = m.attrs.find((a) => a.name === 'Code')
    if (!code) continue
    const codeLen = b.readUInt32BE(code.start + 4)
    codes.push({ method: m.name, code: b.slice(code.start + 8, code.start + 8 + codeLen) })
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

const OWO_IDENTIFIER_CLASSES = new Set([
  'net/minecraft/class_2960', // intermediary (shipped Fabric jars)
  'net/minecraft/util/Identifier', // yarn (dev jars)
  'net/minecraft/resources/ResourceLocation' // mojmap/srg (Connector-remapped)
])
const OWO_CHANNEL_CLASS = 'io/wispforest/owo/network/OwoNetChannel'
const OWO_CONTROLLER_CLASS = 'io/wispforest/owo/particles/systems/ParticleSystemController'

// Replays one class's bytecode against the registration patterns javac emits,
// collecting channel/controller creations, register calls and static
// Identifier fields into `facts`. Attribution is a peephole over the constants
// each call site loads (getstatic receiver, ldc class/string operands) - exact
// for the straight-line static-init code owo mods use.
function scanOwoClass (parsed, facts) {
  if (facts.scannedClasses.has(parsed.className)) return
  facts.scannedClasses.add(parsed.className)
  const { className, cp, codes } = parsed
  const utf8 = (i) => (cp[i] && cp[i].str) || null
  const constClass = (i) => (cp[i] && cp[i].tag === 7 ? utf8(cp[i].nameIndex) : null)
  const ref = (i) => {
    const c = cp[i]
    if (!c || !c.classIndex) return null
    const nat = cp[c.natIndex]
    if (!nat) return null
    return { owner: constClass(c.classIndex), name: utf8(nat.nameIndex), desc: utf8(nat.descIndex) }
  }

  for (const { method, code } of codes) {
    const lastStrings = [] // rolling window of the last two ldc'd strings
    let lastClassConst = null // last ldc'd Class constant
    let lastIdentifier = null // {ns,path} | {helper,path} | {fieldRef}
    let lastReceiverField = null // 'owner.field' of last channel/controller getstatic
    let lastChannel = null // channel created in THIS method (fluent/putstatic target)
    let lastController = null
    let pendingNewController = false
    walkBytecode(code, (op, pc) => {
      if (op === 0x12 || op === 0x13) { // ldc / ldc_w
        const c = cp[op === 0x12 ? code[pc + 1] : code.readUInt16BE(pc + 1)]
        if (c && c.tag === 8) { lastStrings.push(utf8(c.strIndex)); if (lastStrings.length > 2) lastStrings.shift() }
        else if (c && c.tag === 7) lastClassConst = utf8(c.nameIndex)
      } else if (op === 0xbb) { // new
        if (constClass(code.readUInt16BE(pc + 1)) === OWO_CONTROLLER_CLASS) pendingNewController = true
      } else if (op === 0xb2) { // getstatic
        const r = ref(code.readUInt16BE(pc + 1))
        if (!r || !r.desc) return
        if (r.desc === `L${OWO_CHANNEL_CLASS};` || r.desc === `L${OWO_CONTROLLER_CLASS};`) {
          lastReceiverField = `${r.owner}.${r.name}`
        } else if (r.desc[0] === 'L' && OWO_IDENTIFIER_CLASSES.has(r.desc.slice(1, -1))) {
          lastIdentifier = { fieldRef: `${r.owner}.${r.name}` }
        }
      } else if (op === 0xb3) { // putstatic
        const r = ref(code.readUInt16BE(pc + 1))
        if (!r || !r.desc) return
        const key = `${r.owner}.${r.name}`
        if (r.desc === `L${OWO_CHANNEL_CLASS};` && lastChannel) { facts.channelFields.set(key, lastChannel); lastChannel = null }
        else if (r.desc === `L${OWO_CONTROLLER_CLASS};` && lastController) { facts.controllerFields.set(key, lastController); lastController = null }
        else if (r.desc[0] === 'L' && OWO_IDENTIFIER_CLASSES.has(r.desc.slice(1, -1)) && lastIdentifier) facts.identifierFields.set(key, lastIdentifier)
      } else if (op === 0xb8) { // invokestatic
        const r = ref(code.readUInt16BE(pc + 1))
        if (!r || !r.desc) return
        const helper = r.desc.match(/^\(Ljava\/lang\/String;\)L([^;]+);$/)
        if (helper && OWO_IDENTIFIER_CLASSES.has(helper[1])) {
          // MyMod.id("path") convention: namespace is an ldc inside the helper
          lastIdentifier = { helper: { owner: r.owner, name: r.name }, path: lastStrings[lastStrings.length - 1] }
        } else if (r.owner === OWO_CHANNEL_CLASS && (r.name === 'create' || r.name === 'createOptional')) {
          lastChannel = {
            id: lastIdentifier,
            optional: r.name === 'createOptional',
            serverbound: [],
            clientbound: [],
            site: `${className}#${method}`
          }
          facts.channels.push(lastChannel)
          lastIdentifier = null
          lastReceiverField = null
        }
      } else if (op === 0xb7) { // invokespecial
        const r = ref(code.readUInt16BE(pc + 1))
        if (!r || r.name !== '<init>') return
        if (OWO_IDENTIFIER_CLASSES.has(r.owner)) {
          if (r.desc === '(Ljava/lang/String;Ljava/lang/String;)V' && lastStrings.length >= 2) {
            lastIdentifier = { ns: lastStrings[lastStrings.length - 2], path: lastStrings[lastStrings.length - 1] }
          } else if (r.desc === '(Ljava/lang/String;)V' && lastStrings.length >= 1) {
            const s = lastStrings[lastStrings.length - 1]
            const ix = s.indexOf(':')
            lastIdentifier = ix >= 0 ? { ns: s.slice(0, ix), path: s.slice(ix + 1) } : { ns: 'minecraft', path: s }
          }
        } else if (r.owner === OWO_CONTROLLER_CLASS && pendingNewController) {
          lastController = { id: lastIdentifier, count: 0, site: `${className}#${method}` }
          facts.controllers.push(lastController)
          pendingNewController = false
          lastIdentifier = null
          lastReceiverField = null
        }
      } else if (op === 0xb6) { // invokevirtual
        const r = ref(code.readUInt16BE(pc + 1))
        if (!r) return
        if (r.owner === OWO_CHANNEL_CLASS && /^register(Serverbound|Clientbound|ClientboundDeferred)$/.test(r.name)) {
          facts.registrations.push({
            kind: r.name,
            className: lastClassConst,
            channel: lastReceiverField ? null : lastChannel,
            field: lastReceiverField,
            site: `${className}#${method}`
          })
          lastClassConst = null
        } else if (r.owner === OWO_CONTROLLER_CLASS && (r.name === 'register' || r.name === 'registerDeferred')) {
          facts.systemRegs.push({ controller: lastReceiverField ? null : lastController, field: lastReceiverField })
        }
      }
    })
  }
}

// Scans one jar buffer: classes referencing owo are parsed and scanned, every
// class is indexed for lazy resolution, nested META-INF/jars/*.jar (Fabric
// jar-in-jar) recurse.
function scanOwoJar (buf, source, facts, depth) {
  let entries
  try { entries = zipCentralEntries(buf) } catch (err) {
    debug(`owo scan: unreadable jar ${source.jarPath} (${err.message})`)
    return
  }
  for (const entry of entries) {
    if (entry.name.endsWith('.jar') && entry.name.startsWith('META-INF/jars/') && depth < 2) {
      try {
        scanOwoJar(zipEntryData(buf, entry), { jarPath: source.jarPath, chain: [...source.chain, entry.name] }, facts, depth + 1)
      } catch (err) {
        debug(`owo scan: unreadable nested jar ${entry.name} in ${source.jarPath} (${err.message})`)
      }
      continue
    }
    if (!entry.name.endsWith('.class') || entry.name.startsWith('META-INF/')) continue
    const className = entry.name.slice(0, -6)
    if (!facts.classIndex.has(className)) facts.classIndex.set(className, { ...source, entryName: entry.name })
    let data
    try { data = zipEntryData(buf, entry) } catch { continue }
    if (!data.includes('io/wispforest/owo/')) continue // cheap pre-filter
    const parsed = parseClassFile(data)
    if (!parsed) continue
    facts.parsedClasses.set(parsed.className, parsed)
    scanOwoClass(parsed, facts)
  }
}

// Lazily parses a class that the owo pre-filter skipped (id helpers and
// Identifier constant holders often live in classes that never mention owo).
function lazyClassFor (facts, className) {
  const cached = facts.parsedClasses.get(className)
  if (cached) return cached
  const loc = facts.classIndex.get(className)
  if (!loc) return null
  try {
    let buf = fs.readFileSync(loc.jarPath)
    for (const link of loc.chain) {
      buf = zipEntryData(buf, zipCentralEntries(buf).find((e) => e.name === link))
    }
    const entry = zipCentralEntries(buf).find((e) => e.name === loc.entryName)
    const parsed = entry && parseClassFile(zipEntryData(buf, entry))
    if (parsed) facts.parsedClasses.set(parsed.className, parsed)
    return parsed || null
  } catch (err) {
    debug(`owo scan: failed to lazily read ${className} (${err.message})`)
    return null
  }
}

// Resolves a tracked identifier value to {ns, path}: literal, static-field
// indirection, or a (String)->Identifier helper whose body ldc's the namespace.
function resolveOwoIdentifier (facts, id, depth) {
  if (!id || (depth || 0) > 4) return null
  if (id.ns) return id
  if (id.fieldRef) {
    if (!facts.identifierFields.has(id.fieldRef)) {
      // the holder class may not reference owo at all - scan it on demand
      const owner = lazyClassFor(facts, id.fieldRef.slice(0, id.fieldRef.lastIndexOf('.')))
      if (owner) scanOwoClass(owner, facts)
    }
    const v = facts.identifierFields.get(id.fieldRef)
    return v && v !== id ? resolveOwoIdentifier(facts, v, (depth || 0) + 1) : null
  }
  if (id.helper) {
    if (typeof id.path !== 'string') return null
    const parsed = lazyClassFor(facts, id.helper.owner)
    if (!parsed) return null
    for (const { method, code } of parsed.codes) {
      if (method !== id.helper.name) continue
      const strs = []
      walkBytecode(code, (op, pc) => {
        if (op !== 0x12 && op !== 0x13) return
        const c = parsed.cp[op === 0x12 ? code[pc + 1] : code.readUInt16BE(pc + 1)]
        if (c && c.tag === 8) strs.push(parsed.cp[c.strIndex].str)
      })
      // new Identifier(ldc <ns>, arg) - exactly one string constant in the body
      if (strs.length === 1) return { ns: strs[0], path: id.path }
    }
    return null
  }
  return null
}

/**
 * Derives every owo-lib channel/controller login fingerprint from a set of
 * mod jars, mirroring what OwoHandshake computes over the server's runtime
 * registrations. Pure static analysis - no per-pack constants.
 *
 * @param {Array.<string>} paths jar files and/or directories of jars
 * @returns {{channels: Object, controllers: Object, optional: Object}}
 *   maps of "ns:path" -> int hash (required channels, particle controllers,
 *   optional channels)
 */
function scanOwoFingerprints (paths) {
  const facts = {
    channels: [],
    controllers: [],
    registrations: [],
    systemRegs: [],
    channelFields: new Map(),
    controllerFields: new Map(),
    identifierFields: new Map(),
    parsedClasses: new Map(),
    scannedClasses: new Set(),
    classIndex: new Map()
  }
  for (const p of paths) {
    let jars = []
    try {
      jars = fs.statSync(p).isDirectory()
        ? fs.readdirSync(p).filter((f) => f.endsWith('.jar')).map((f) => path.join(p, f))
        : [p]
    } catch (err) {
      console.warn(`[forge] owo fingerprint source ${p} unreadable (${err.message})`)
      continue
    }
    for (const jar of jars) {
      try {
        scanOwoJar(fs.readFileSync(jar), { jarPath: jar, chain: [] }, facts, 0)
      } catch (err) {
        debug(`owo scan: skipping ${jar} (${err.message})`)
      }
    }
  }

  // attach register calls to their channels/controllers, replaying owo's index
  // bookkeeping: per direction, indices count up from 1 in registration order;
  // registerClientbound after registerClientboundDeferred of the same class
  // only fills the handler in, so it must not claim a second index.
  for (const reg of facts.registrations) {
    const ch = reg.channel || (reg.field && facts.channelFields.get(reg.field))
    if (!ch || !reg.className) continue
    if (reg.kind === 'registerServerbound') ch.serverbound.push(reg.className)
    else if (!ch.clientbound.includes(reg.className)) ch.clientbound.push(reg.className)
  }
  for (const reg of facts.systemRegs) {
    const ctl = reg.controller || (reg.field && facts.controllerFields.get(reg.field))
    if (ctl) ctl.count++
  }

  const out = { channels: {}, controllers: {}, optional: {} }
  for (const ch of facts.channels) {
    const id = resolveOwoIdentifier(facts, ch.id, 0)
    if (!id) {
      console.warn(`[forge] owo channel created at ${ch.site} has an unresolvable identifier - skipping (the server will name it if it gates the join)`)
      continue
    }
    let sum = 0
    ch.serverbound.forEach((cls, i) => { sum = (sum + Math.imul(i + 1, 31) + javaStringHash(cls.replace(/\//g, '.'))) | 0 })
    ch.clientbound.forEach((cls, i) => { sum = (sum + Math.imul(-(i + 1), 31) + javaStringHash(cls.replace(/\//g, '.'))) | 0 })
    const key = `${id.ns}:${id.path}`
    const hash = (Math.imul(31, owoIdentifierHash(id.ns, id.path)) + sum) | 0
    ;(ch.optional ? out.optional : out.channels)[key] = hash
    debug(`owo fingerprint: ${ch.optional ? 'optional ' : ''}channel ${key} = ${hash} ` +
      `(${ch.serverbound.length} serverbound, ${ch.clientbound.length} clientbound; ${ch.site})`)
  }
  for (const ctl of facts.controllers) {
    const id = resolveOwoIdentifier(facts, ctl.id, 0)
    if (!id) {
      console.warn(`[forge] owo particle controller created at ${ctl.site} has an unresolvable identifier - skipping`)
      continue
    }
    const key = `${id.ns}:${id.path}`
    const hash = (Math.imul(31, owoIdentifierHash(id.ns, id.path)) + (ctl.count * (ctl.count - 1)) / 2) | 0
    out.controllers[key] = hash
    debug(`owo fingerprint: controller ${key} = ${hash} (${ctl.count} systems; ${ctl.site})`)
  }
  return out
}

// One scan per source list per process: the scan is synchronous (it runs
// inside the login handler while the server waits) and reconnects reuse it.
const owoFingerprintCache = new Map()
function owoFingerprintsFor (options) {
  const raw = (options && options.owoModsPaths) || process.env.MINEPAL_FORGE_MODS_DIR || ''
  const paths = (Array.isArray(raw) ? raw : String(raw).split(path.delimiter))
    .map((s) => s.trim()).filter(Boolean)
  const key = paths.join('|')
  if (owoFingerprintCache.has(key)) return owoFingerprintCache.get(key)
  let fingerprints = { channels: {}, controllers: {}, optional: {} }
  if (paths.length === 0) {
    console.warn('[forge] owo:handshake query received but no mods folder is configured - ' +
      'replying with empty fingerprint maps. Servers that REQUIRE owo channels will reject the ' +
      'join (naming the missing channels); set MINEPAL_FORGE_MODS_DIR to the modpack\'s mods folder to derive them.')
  } else {
    const started = Date.now()
    try {
      fingerprints = scanOwoFingerprints(paths)
      const n = (m) => Object.keys(m).length
      console.log(`[forge] derived owo fingerprints from ${paths.join(', ')}: ` +
        `${n(fingerprints.channels)} channels, ${n(fingerprints.controllers)} controllers, ` +
        `${n(fingerprints.optional)} optional (${Date.now() - started}ms)`)
    } catch (err) {
      console.warn(`[forge] owo fingerprint scan failed (${err.message}) - replying with empty maps`)
    }
  }
  owoFingerprintCache.set(key, fingerprints)
  return fingerprints
}

// Raw (non-loginwrapper) login channels: builder(data, options) returns the
// login_plugin_response payload (an "understood" reply), or null for the
// vanilla not-understood response - which is correct for non-gating queries
// like fabric_networking_api_v1:early_registration.
const RAW_LOGIN_PROTOCOLS = {
  // owo:handshake reply (layout above): required-channel hashes and controller
  // hashes derived from the modpack jars, then the request payload - the
  // server's own optional-channel hash map - echoed back verbatim (it is the
  // one map the server does advertise, and echoing it always matches).
  'owo:handshake': (data, options) => {
    const fingerprints = owoFingerprintsFor(options)
    return Buffer.concat([
      encodeIdHashMap(fingerprints.channels),
      encodeIdHashMap(fingerprints.controllers),
      data && data.length > 0 ? data : encodeIdHashMap(fingerprints.optional)
    ])
  }
}

// S2CChannelMismatchData (disc 6) body: a FriendlyByteBuf map — varint count,
// then count x (string channelName, string reason) — of the channels
// NetworkRegistry.validateServerChannels rejected. The server sends it ONLY
// while rejecting us, and on 1.20.1 then closes the socket RAW
// (Connection#disconnect during login sends no login-disconnect packet), so
// the client otherwise sees nothing but ECONNRESET. This message is the one
// record of WHY the join failed.
function parseChannelMismatch (buffer, offset) {
  const count = readVarInt(buffer, offset)
  offset += count.size
  // every entry costs >= 2 bytes (two 1-byte string length prefixes); a count
  // the buffer can't hold is malformed — reject before looping (same rationale
  // as readRegistryIdMap: this runs synchronously inside the packet handler)
  if (count.value < 0 || count.value * 2 > buffer.length - offset) {
    throw new Error(`channel mismatch count ${count.value} exceeds buffer at ${offset}`)
  }
  const mismatched = {}
  for (let i = 0; i < count.value; i++) {
    const name = readString(buffer, offset)
    offset += name.size
    const reason = readString(buffer, offset)
    offset += reason.size
    mismatched[name.value] = reason.value
  }
  return mismatched
}

// Leading `ids` map of a ForgeRegistry.Snapshot: varint count, then count x
// (string name, varint id). That's enough to name modded content; the trailing
// aliases/overrides/blocked lists are not needed. Same inner layout on FML3
// (login) and 1.20.2+ (config-phase) registry messages.
function readRegistryIdMap (buffer, offset) {
  const count = readVarInt(buffer, offset)
  let size = count.size
  // every entry costs >= 2 bytes (1-byte string length + 1-byte id), so a
  // count the buffer can't possibly hold is malformed; reject it up front
  // instead of iterating - this parse runs synchronously inside the packet
  // handler, where a spun loop freezes the whole event loop (no timer or
  // watchdog can preempt it)
  if (count.value < 0 || count.value * 2 > buffer.length - offset - size) {
    throw new Error(`registry id map count ${count.value} exceeds buffer at ${offset}`)
  }
  const ids = new Map()
  for (let i = 0; i < count.value; i++) {
    const entryName = readString(buffer, offset + size)
    size += entryName.size
    const id = readVarInt(buffer, offset + size)
    size += id.size
    ids.set(id.value, entryName.value)
  }
  return { value: ids, size }
}

// S2CRegistry (disc 3) body: registryName (string), hasSnapshot (bool), then a
// ForgeRegistry.Snapshot whose leading ids map is kept. (There is no `dummied`
// field on the wire, despite older protodef schemas.) The parsed id->name Map
// is stashed on client.forgeRegistries[key]. Best-effort: callers wrap this so
// a parse failure just falls through to a plain ack.
function parseServerRegistry (client, buffer, offset) {
  const name = readString(buffer, offset)
  offset += name.size
  const key = SNAPSHOT_REGISTRIES[name.value]
  if (!key) return // not a registry we name from
  const hasSnapshot = buffer[offset] !== 0
  offset += 1
  if (!hasSnapshot) return

  const ids = readRegistryIdMap(buffer, offset)
  client.forgeRegistries = client.forgeRegistries || {}
  client.forgeRegistries[key] = ids.value
  debug(`parsed ${name.value} registry snapshot: ${ids.value.size} ids`)
}

/**
 * Installs the FML3 handshake responder on a connecting client, so a modless
 * protocol client can log into a Forge 1.18-1.20.1 server by mirroring the
 * server's own mod list back at it.
 *
 * @param {import('minecraft-protocol').Client} client client that is connecting to the server.
 * @param {{
 *  forgeMods: Array.<string> | undefined,      // override mod ids sent in the reply
 *  channels: Object.<string, string> | undefined,  // override channel name -> version
 *  registries: Object.<string, string> | undefined, // override registry name -> marker
 *  pingModVersions: Object.<string, string> | undefined // mod id -> version, for the forgeMods event
 * }} options
 */
module.exports = function (client, options) {
  options = options || {}

  // passed to src/client/setProtocol.js; marks the connection as a Forge FML3
  // client in the set_protocol server address field
  client.tagHost = '\0FML3\0'
  debug('FML3 handshake handler installed')

  // remove nmp's default login_plugin_request listener, which would answer
  // everything with "not understood" and get us kicked
  const nmpListener = client.listeners('login_plugin_request').find((fn) => fn.name === 'onLoginPluginRequest')
  if (nmpListener) client.removeListener('login_plugin_request', nmpListener)

  function respond (messageId, data) {
    client.write('login_plugin_response', { messageId, data })
  }

  client.on('login_plugin_request', (packet) => {
    if (packet.channel !== 'fml:loginwrapper') {
      // a mod talking on its own raw login channel (Fabric login networking,
      // possibly through Connector): answer it if we speak its protocol
      let reply = null
      if (RAW_LOGIN_PROTOCOLS[packet.channel]) {
        try {
          reply = RAW_LOGIN_PROTOCOLS[packet.channel](packet.data, options)
        } catch (err) {
          debug(`failed to build ${packet.channel} reply (${err.message}), replying not-understood`)
        }
      }
      if (reply) {
        debug(`answering raw login channel ${packet.channel} (${reply.length} bytes)`)
        client.write('login_plugin_response', { messageId: packet.messageId, data: reply })
      } else {
        // we can't speak it, so give the vanilla "not understood" response
        debug(`unknown login channel ${packet.channel}, replying not-understood`)
        client.write('login_plugin_response', { messageId: packet.messageId })
      }
      return
    }

    let wrapper
    try {
      wrapper = parseLoginWrapper(packet.data)
      const disc = readVarInt(wrapper.data, 0)

      // A mod's own login message riding the loginwrapper: it gates the join
      // exactly like fml:handshake does, but decodes replies in ITS index
      // space, so answer in the channel's own sub-protocol when we speak it.
      // (Channels without a builder fall through to the FML ack below.)
      if (wrapper.channel !== 'fml:handshake' && WRAPPED_LOGIN_PROTOCOLS[wrapper.channel]) {
        const reply = WRAPPED_LOGIN_PROTOCOLS[wrapper.channel](disc.value, wrapper.data.slice(disc.size))
        if (reply) {
          debug(`answering ${wrapper.channel} login message disc=${disc.value} in its own index space (${reply.length} bytes)`)
          respond(packet.messageId, wrapLoginPayload(wrapper.channel, reply))
          return
        }
      }

      if (wrapper.channel === 'fml:handshake' && disc.value === DISCRIMINATOR.MOD_LIST) {
        const modList = parseModList(wrapper.data, disc.size)
        debug(`server ModList: ${modList.mods.length} mods, ${modList.channels.length} channels, ${modList.registries.length} registries`)
        client.forgeModList = modList

        const pingVersions = options.pingModVersions || {}
        client.emit('forgeMods', modList.mods.map((id) =>
          pingVersions[id] ? { modid: id, version: pingVersions[id] } : id
        ))

        // Mirror the server's own mods, channels and registries back at it so
        // NetworkRegistry.validateClientChannels finds nothing to complain about.
        const reply = {
          mods: options.forgeMods || modList.mods,
          channels: options.channels
            ? Object.entries(options.channels).map(([name, marker]) => ({ name, marker }))
            : modList.channels,
          registries: options.registries
            ? Object.entries(options.registries).map(([name, marker]) => ({ name, marker }))
            : modList.registries.map((name) => ({ name, marker: '1.0' }))
        }
        respond(packet.messageId, wrapLoginPayload('fml:handshake', encodeModListReply(reply)))
        return
      }

      // ServerRegistry (disc 3): keep the id->name snapshot for item/block/
      // entity registries so the bot can name modded content, then still ack.
      // Parsing is best-effort - never let it break the handshake.
      if (wrapper.channel === 'fml:handshake' && disc.value === DISCRIMINATOR.SERVER_REGISTRY) {
        try {
          parseServerRegistry(client, wrapper.data, disc.size)
        } catch (err) {
          debug(`failed to parse ServerRegistry snapshot (${err.message}), acking anyway`)
        }
      }

      // ChannelMismatchData (disc 6): the server is REJECTING us and this is
      // the only packet that names the offending channels — log it and hand it
      // to the embedding app before the raw socket close erases the evidence.
      // Parsing is best-effort; we still fall through to the ack either way
      // (the server disconnects regardless, an ack is harmless).
      if (wrapper.channel === 'fml:handshake' && disc.value === DISCRIMINATOR.CHANNEL_MISMATCH) {
        try {
          const mismatched = parseChannelMismatch(wrapper.data, disc.size)
          const names = Object.keys(mismatched)
          console.warn(`[forge] server rejected our mod channels (${names.length}): ` +
            names.map((n) => (mismatched[n] ? `${n} (${mismatched[n]})` : n)).join(', '))
          client.forgeChannelMismatch = mismatched
          client.emit('forgeChannelMismatch', mismatched)
        } catch (err) {
          debug(`failed to parse S2CChannelMismatchData (${err.message})`)
        }
      }

      // Registry snapshots, config data, mod data, unknown fml:handshake
      // messages and mod login payloads wrapped in the loginwrapper: just
      // acknowledge so the negotiation keeps moving. The ack goes back in the
      // ORIGINATING inner channel: the server-side LoginWrapper routes the
      // reply to whichever channel the response names, so wrapping a mod
      // channel's reply in fml:handshake would deliver it to the FML handshake
      // handler ("unexpected index") while the real channel waits forever.
      debug(`acknowledging loginwrapper message channel=${wrapper.channel} discriminator=${disc.value} length=${wrapper.data.length}`)
      respond(packet.messageId, wrapLoginPayload(wrapper.channel, encodeAcknowledgement()))
    } catch (err) {
      // A request left unanswered hangs the login until the server times us
      // out, so an acknowledgement is always the least-bad answer. If even the
      // outer wrapper failed to parse there is no originating channel to name,
      // so fall back to fml:handshake.
      debug(`failed to handle loginwrapper payload (${err.message}), acknowledging anyway`)
      respond(packet.messageId, wrapLoginPayload(wrapper ? wrapper.channel : 'fml:handshake', encodeAcknowledgement()))
    }
  })
}

// FriendlyByteBuf primitives and registry-snapshot helpers, shared with the
// config-phase handshake (1.20.2+)
module.exports.readVarInt = readVarInt
module.exports.writeVarInt = writeVarInt
module.exports.readString = readString
module.exports.writeString = writeString
module.exports.readRegistryIdMap = readRegistryIdMap
module.exports.SNAPSHOT_REGISTRIES = SNAPSHOT_REGISTRIES
