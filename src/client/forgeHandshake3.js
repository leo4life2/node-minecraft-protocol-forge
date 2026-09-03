const fs = require('fs')
const path = require('path')
const debug = require('debug')('minecraft-protocol-forge')
const { zipCentralEntries, zipEntryData, parseClassFile, walkBytecode, javaStringHash } = require('./jarAnalysis')
const { assessLoginChannel } = require('./loginAckDerivation')
const { writeLoginReplyNow, writeLoginReplyDeferred } = require('./loginReplyBoundary')

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
  MOD_DATA: 5,
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

// S2CModData (disc 5, Forge 1.19.x+; HandshakeMessages.S2CModData.encode on
// the 1.20.1-47.2.0 branch, CFR-read 2026-09-03): a FriendlyByteBuf map of
// modId (utf ≤256) -> (displayName utf ≤256, version utf ≤256), built from
// ModList.get().getMods() with IModInfo::getVersion().toString() — the
// server's own mod VERSIONS on the login wire, sent whether or not the ping
// carried them. HF23-R1: on a wire whose status ping hides the mod list (a
// proxy/front stripping forgeData — receipt 7b63c3ed), this message is the
// ONLY in-protocol source of the announced modid@version the HF23
// acquisition rung needs; NetworkInitialization registers it BEFORE
// S2CModList (builder order 5 then 1), so it lands before any mod's own
// login query. Parsing is best-effort (a truncated body throws; the caller
// records nothing and the reference client's silence still stands).
function parseModData (buffer, offset) {
  const count = readVarInt(buffer, offset)
  offset += count.size
  const mods = {}
  for (let i = 0; i < count.value; i++) {
    const id = readString(buffer, offset)
    offset += id.size
    const displayName = readString(buffer, offset)
    offset += displayName.size
    const version = readString(buffer, offset)
    offset += version.size
    mods[id.value] = { displayName: displayName.value, version: version.value }
  }
  return { mods, count: count.value }
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
// the FML acknowledge. Channels with NO local knowledge (not in this table,
// not created by any local jar) fall to the HF13 corroboration gate: when the
// server's own announcement attributes the channel to a mod, the answer is
// the vanilla not-understood decline (the ack-99 guess is a proven kick in a
// modern mod's own index space — see announcedChannelAttribution); only
// channels NEITHER the jars NOR the announcement know keep the FML ack 99
// (mods that copy FML's HandshakeMessages convention register their
// acknowledge at login index 99, so it stays the least-bad default there).
// Channels a local jar DOES create resolve through assessLoginChannel
// instead — derived ack, or an honest join stop when no correct reply is
// provable (see resolveWrappedModLogin below).
const WRAPPED_LOGIN_PROTOCOLS = {
  // TACZ (tacz:handshake): NetworkHandler seeds HANDSHAKE_ID_COUNT at 1, so
  // its Acknowledge login message is index 1 with an empty body. The server
  // sends ServerMessageSyncedEntityDataMapping (index 2) and waits for that
  // Acknowledge; byte 99 is an invalid discriminator in tacz's index space
  // ("Received invalid discriminator byte 99" -> unexpected_query_response).
  'tacz:handshake': () => Buffer.from([0x01]),
  // MrCrayfish Framework (framework:handshake, the library behind the
  // Refurbished Furniture ecosystem): ForgeNetworkBuilder#build resets
  // idCount to 1 and registers Acknowledge FIRST — index 1, empty body
  // (S2CLoginData=2, S2CLoginConfigData=3), so the correct reply to every
  // Framework login message is the single byte 0x01. The FML byte 99 is an
  // invalid discriminator in Framework's IndexedMessageCodec ("Received
  // invalid discriminator byte 99 on channel framework:handshake" ->
  // "Unexpected custom data from client" kick). Verified against
  // framework-forge-1.20.1-0.7.15 bytecode and live (Liminal Industries).
  'framework:handshake': () => Buffer.from([0x01]),
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

// Java's Identifier.hashCode (31*ns.hashCode()+path.hashCode()), in 32-bit
// int arithmetic. ZIP/classfile/bytecode primitives live in jarAnalysis.js,
// shared with the SimpleChannel login-ack derivation.
function owoIdentifierHash (ns, p) { return (Math.imul(31, javaStringHash(ns)) + javaStringHash(p)) | 0 }

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

// The local mods folder(s) every jar-derived reply draws from: the general
// `modsPaths` option (resolved by the embedding app — see MinePal's
// src/utils/modsDirResolver.js), its historical owo-specific alias
// `owoModsPaths`, then the MINEPAL_FORGE_MODS_DIR env var.
function modsPathsFor (options) {
  const raw = (options && (options.modsPaths || options.owoModsPaths)) ||
    process.env.MINEPAL_FORGE_MODS_DIR || ''
  return (Array.isArray(raw) ? raw : String(raw).split(path.delimiter))
    .map((s) => s.trim()).filter(Boolean)
}

// One scan per source list per process: the scan is synchronous (it runs
// inside the login handler while the server waits) and reconnects reuse it.
const owoFingerprintCache = new Map()
function owoFingerprintsFor (options) {
  const paths = modsPathsFor(options)
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

// --- wrapped mod-channel login resolution (shared by FML2 and FML3) ---------
//
// One rule for the whole CLASS of login-wrapped mod channels (receipt case:
// Calio's calio:channel on Forge 1.20.1):
//   1. hand-verified table override (WRAPPED_LOGIN_PROTOCOLS — includes
//      non-ack shapes like zeta's echo),
//   2. jar-DERIVED verdict (loginAckDerivation.assessLoginChannel over the
//      local mods folder):
//        'ack'         -> the mod's own acknowledge, exact wire bytes
//                         (IndexedMessageCodec: one index byte + empty body),
//        'underivable' -> split by WHAT the jars prove (HF8):
//          reason 'substantive-reply' -> HONEST JOIN STOP. The jars PROVE
//                         the channel's login reply must carry data this
//                         client cannot reconstruct — the protocol demands
//                         an answer no decline can satisfy, so the join
//                         fails HERE, naming the channel, instead of dying
//                         with the server's generic kick.
//          reason 'no-derivable-ack' -> PROTOCOL-CORRECT DECLINE (HF8, the
//                         tacztweaks:handshake receipt). The reference
//                         client's own behavior for a login query it cannot
//                         dispatch is the vanilla "not understood" response
//                         (Forge 1.20.1 ClientHandshakePacketListenerImpl
//                         patch: `new ServerboundCustomQueryPacket(id,
//                         (FriendlyByteBuf)null)`), and the SERVER models
//                         it (IndexedMessageCodec.consume: a null/empty
//                         payload is accepted — setPacketHandled(true) —
//                         whenever HandshakeHandler.packetNeedsResponse is
//                         false, and otherwise yields the server's own
//                         unexpected_query_response kick). A decline is not
//                         a claim: no guessed bytes ride the wire, mods
//                         that tolerate a vanilla-shaped answer let the
//                         join proceed, and mods that demand the reply kick
//                         with THEIR named copy (surfaced, with our decline
//                         receipt attached). Aborting here — the pre-HF8
//                         behavior — forfeited every tolerant server.
//        'unknown'     -> HF13 CORROBORATION LAW (the half-matching-instance
//                         kill shot, 2026-08-31, deterministic 6/6): before
//                         falling back to the FML convention acknowledge,
//                         the guess is corroborated against the server's OWN
//                         ANNOUNCED REALITY (the FML ModList it sent us this
//                         login + the ping's mod list). When the announcement
//                         attributes the queried channel to a mod — the
//                         channel appears in the announced channel list, or
//                         its namespace names an announced mod id — and the
//                         local jars carry NO knowledge of it, the convention
//                         byte 99 is an UNCORROBORATED CLAIM in a message
//                         space the server just told us belongs to a mod we
//                         provably do not hold. The live receipt for what
//                         that claim does: Leo's half-matching Modrinth
//                         instance (3/6 server mods, tacztweaks jars absent)
//                         sent ack-99 on tacztweaks:handshake; the server
//                         dispatched it into tacztweaks's IndexedMessageCodec,
//                         found no message at index 99, logged "Unexpected
//                         custom data from client" and kicked with
//                         multiplayer.disconnect.unexpected_query_response
//                         (one attempt raced the handshake iteration into a
//                         server-side ConcurrentModificationException). The
//                         reference client WITHOUT that mod answers exactly
//                         the vanilla not-understood decline (same primary
//                         sources as HF8 above), so that is what we send —
//                         receipted, naming the announced owner mod@version
//                         and the instance remedy. Channels the announcement
//                         does NOT attribute (bare/exotic flows, infra
//                         namespaces fml/forge/minecraft) keep the legacy
//                         99 floor byte-for-byte:
//                         null -> caller falls back to the FML convention
//                         acknowledge byte 99 on the ORIGINATING channel
//                         (mods that copy FML's HandshakeMessages register
//                         their acknowledge at index 99 — the least-bad
//                         default when NEITHER the local jars NOR the
//                         server's announcement know the channel).
//
// Returns { reply, via } (inner payload for the SAME channel), { failed:
// true } (join already stopped honestly), { declined: true } (vanilla
// not-understood decline — HF8 jar-proven or HF13 uncorroborated), or null
// (use the 99 convention).

// --- HF13: the server's announced reality, as attribution evidence ---------
//
// Sources, all in-protocol BEFORE any wrapped mod-channel query is answered:
//   - client.forgeModList: the FML3 S2CModList this login (mods: id strings,
//     channels: {name, marker}) — the server's own gathered login payloads
//     put ModList first (HandshakeHandler's ordered "ticking packet info"
//     queue), so it is stashed before mod-channel queries arrive. The FML2
//     responder stashes the same shape from its ModList case.
//   - client.forgePingMods / options.pingModVersions: the ping's forgeData
//     mod list ({id, version}), available before the connection even starts.
// Returns null when nothing announced attributes the channel (the legacy
// floor stands), else { channel, announcedChannel, ownerMod, ownerVersion }.
const INFRA_NAMESPACES = new Set(['fml', 'forge', 'minecraft'])
function announcedChannelAttribution (client, options, channel) {
  const colon = typeof channel === 'string' ? channel.indexOf(':') : -1
  if (colon <= 0) return null
  const ns = channel.slice(0, colon).toLowerCase()
  // Infra namespaces never HF13-convert: they are the loader's own lanes,
  // not a mod's message space (same filter as warmLoginAssessments).
  if (INFRA_NAMESPACES.has(ns)) return null

  const mods = new Map() // announced mod id (lowercase) -> version | null
  const noteMod = (id, version) => {
    if (id == null) return
    const key = String(id).trim().toLowerCase()
    if (!key) return
    if (!mods.has(key) || (mods.get(key) == null && version != null)) mods.set(key, version ?? null)
  }
  const pingVersions = (options && options.pingModVersions) || {}
  for (const id of Object.keys(pingVersions)) noteMod(id, pingVersions[id])
  if (client && Array.isArray(client.forgePingMods)) {
    for (const m of client.forgePingMods) { if (m) noteMod(m.id, m.version) }
  }
  // HF23-R1: the server's S2CModData (this login) names modid -> version
  // even when the ping hid the mod list — the same announced pair the ping
  // would have carried (both read IModInfo on the server), so it feeds the
  // corroboration + acquisition rungs with equal standing. The ping keeps
  // precedence when both exist (noteMod never downgrades a known version).
  const modData = client && client.forgeModData && client.forgeModData.mods
  if (modData && typeof modData === 'object') {
    for (const id of Object.keys(modData)) noteMod(id, modData[id] && modData[id].version)
  }
  const modList = client && client.forgeModList
  if (modList && Array.isArray(modList.mods)) {
    for (const id of modList.mods) noteMod(id, null)
  }
  let announcedChannel = false
  if (modList && Array.isArray(modList.channels)) {
    announcedChannel = modList.channels.some((ch) => ch && ch.name === channel)
  }
  const ownerMod = mods.has(ns) ? ns : null
  if (!announcedChannel && ownerMod == null) return null
  return { channel, announcedChannel, ownerMod, ownerVersion: ownerMod != null ? (mods.get(ownerMod) ?? null) : null }
}
function resolveWrappedModLogin (client, channel, disc, body, options) {
  if (WRAPPED_LOGIN_PROTOCOLS[channel]) {
    try {
      const reply = WRAPPED_LOGIN_PROTOCOLS[channel](disc, body)
      if (reply) return { reply, via: 'table' }
    } catch (err) {
      debug(`table reply for ${channel} failed (${err.message})`)
    }
    return null // table channel declining this message: FML 99 convention
  }
  let assessed = null
  try {
    assessed = assessLoginChannel(channel, modsPathsFor(options))
  } catch (err) {
    debug(`assessment for ${channel} failed (${err.message})`)
    return null
  }
  if (assessed.verdict === 'ack') {
    // HF13 corroboration receipt: record the announced owner facts NEXT TO
    // the jar evidence, so a version-mismatched-but-present jar is visible
    // in every following kick's classification (P6). The wire answer stays
    // the bytecode-proven ack — reference-faithful: a real client running
    // this exact instance sends its own mod's ack (converting mismatch into
    // a decline would re-break the HF2 founding case, tacz 1.1.7 on a
    // 1.1.8 server: the derived index is version-stable, the decline kicks).
    try {
      const attribution = announcedChannelAttribution(client, options, channel)
      if (attribution && client) {
        if (!Array.isArray(client.forgeLoginCorroboration)) client.forgeLoginCorroboration = []
        client.forgeLoginCorroboration.push({
          channel,
          via: 'jar-derived-ack',
          index: assessed.index,
          jarEvidence: assessed.evidence,
          announcedChannel: attribution.announcedChannel,
          ownerMod: attribution.ownerMod,
          ownerVersion: attribution.ownerVersion
        })
      }
    } catch { /* receipts never break the reply path */ }
    return { reply: assessed.reply, via: `jar-derived ack index ${assessed.index}` }
  }
  if (assessed.verdict === 'underivable') {
    if (assessed.reason === 'substantive-reply') {
      // Jar-proven mandatory-and-unanswerable: the reply must carry data we
      // cannot reconstruct — no decline can satisfy it. Honest stop.
      failWrappedLoginHonestly(client, channel, assessed)
      return { failed: true }
    }
    // 'no-derivable-ack': the requirement itself is unproven — send the
    // protocol's own "not understood" decline and let the server decide
    // (HF8; primary sources in the header above). The caller writes the
    // empty login_plugin_response; this records the receipt.
    declineWrappedLoginHonestly(client, channel, assessed)
    return { declined: true, assessed }
  }
  // verdict 'unknown' (no local jar creates this channel, or no jars are
  // configured): HF13 — corroborate the convention-99 guess against the
  // server's own announced reality before letting it ride the wire.
  const attribution = announcedChannelAttribution(client, options, channel)
  if (attribution) {
    // HF23 — ANNOUNCED-MOD ACQUISITION (the P2 growth path realized). The
    // decline below is a deterministic kick whenever the queried message
    // needsResponse (IndexedMessageCodec.consume marks a null payload
    // handled ONLY when !HandshakeHandler.packetNeedsResponse; every
    // needsResponse message sits in sentMessages until answered, and an
    // unhandled reply makes NetworkHooks.onCustomPayload return false →
    // ServerLoginPacketListenerImpl disconnects with
    // unexpected_query_response — or the same close seen as ECONNRESET
    // when the disconnect packet loses the socket race). The server just
    // told us WHICH mod at WHICH version owns the channel; when the
    // embedding app injects an acquisition accessor (this lib stays
    // local-only by construction — it never does network I/O itself) and
    // the announced version is real (never ANY / SERVER_ONLY), the answer
    // is deferred: obtain the jar, run the SAME derivation over it, and
    // dispatch exactly as the synchronous ladder would. Lazy by design:
    // the server WAITS for a needsResponse reply (HandshakeHandler.tickServer
    // keeps sending the remaining login messages and completes only when
    // sentMessages is empty), and the HF12 boundary guard's "negotiation
    // over" criterion stays false while we hold — the late reply is legal.
    // A fire-and-forget query the server completes without is dropped by
    // the same guard with a receipt (never a stream-corrupting late write).
    const acq = options && options.announcedModAcquisition
    if (acq && typeof acq.acquire === 'function' && attribution.ownerMod && isAcquirableVersion(attribution.ownerVersion)) {
      return { pending: acquireThenResolve(client, channel, options, attribution, acq) }
    }
    declineUncorroboratedLogin(client, channel, attribution)
    return { declined: true, assessed: { verdict: 'unknown', reason: 'uncorroborated-by-local-jars', attribution } }
  }
  return null
}

// HF23: versions the server announces for mods that are not acquirable —
// Forge's own placeholder markers, never a registry version.
const NON_ACQUIRABLE_VERSIONS = /^(any|server_only|server-only|client_only|client-only)$/i
function isAcquirableVersion (version) {
  if (version == null) return false
  const s = String(version).trim()
  return !!s && !NON_ACQUIRABLE_VERSIONS.test(s)
}

// HF23: plain words for the honest-stop copy (P5) — mirrors the app organ's
// table; the lib keeps its own so the copy never depends on the embedder.
function acquisitionOutcomeWords (outcome) {
  const o = String(outcome == null ? '' : outcome)
  if (o.startsWith('negative-cached:')) return `a recent lookup already ended "${o.slice('negative-cached:'.length)}", so it was not retried yet`
  switch (o) {
    case 'registry-miss': return 'the registry has no project by that id (CurseForge lookup is not available in this build)'
    case 'version-miss': return 'the registry has the project but no file for exactly that version, loader and Minecraft version (nothing "closest" is ever substituted)'
    case 'hash-mismatch': return 'the downloaded file did not match the registry\'s own hashes and was discarded'
    case 'jar-proof-mismatch': return 'the registry\'s file does not declare that mod id and version in its own metadata, so it was discarded'
    case 'registry-unreachable': return 'the registry could not be reached (no network, or the registry is down)'
    case 'registry-error': return 'the registry answered with an error'
    case 'cap-exceeded': return 'its file exceeds the per-file size cap'
    case 'join-cap-exceeded': return 'this join already reached the acquisition cap'
    case 'budget-exceeded': return 'the registry lookup did not finish inside the login window'
    case 'download-failed': return 'the download failed'
    case 'download-tries-exhausted': return 'the download attempts were used up'
    case 'acquired-jar-holds-no-channel': return 'the obtained jar does not create that login channel'
    case 'disabled': return 'automatic acquisition is disabled in this environment'
    case 'acquisition-error': return 'the acquisition step failed'
    default: return o || 'unknown outcome'
  }
}

// HF23: the deferred half of the resolution ladder — obtain the announced
// owner's jar through the injected accessor, then assess EXACTLY as the
// synchronous ladder does (same assessLoginChannel, same dispatch shapes).
// Resolves to { reply, via } | { declined: true } | { failed: true } |
// { silent: true } (the deadline law ended the connection) — never null.
async function acquireThenResolve (client, channel, options, attribution, acq) {
  const modId = attribution.ownerMod
  const version = String(attribution.ownerVersion)
  const budgetMs = Number.isFinite(acq.budgetMs) ? acq.budgetMs : 18000
  const started = Date.now()
  console.log(`[forge] the modded login check on channel "${channel}" belongs to server-announced mod "${modId}" (announced version ${version}) and no local jar carries it — obtaining that mod@version from a public registry before answering (budget ${budgetMs}ms; the server waits for this reply)`)
  try { if (client && typeof client.minepalJoinWatchdogExtend === 'function') client.minepalJoinWatchdogExtend('announced-mod acquisition in flight') } catch { /* never break the reply path */ }
  let result = null
  try {
    result = await acq.acquire({ modId, version, channel, loader: 'forge', mcVersion: (client && client.version) || options.mcVersion || null, budgetMs })
  } catch (err) {
    result = { ok: false, outcome: 'acquisition-error', error: err && err.message }
  }
  const receipt = result && result.receipt
  const acquisition = {
    outcome: (result && result.outcome) || 'acquisition-error',
    registry: (receipt && receipt.registry) || 'modrinth',
    projectId: receipt ? receipt.projectId : null,
    versionId: receipt ? receipt.versionId : null,
    cached: !!(receipt && receipt.cached),
    ms: Date.now() - started
  }
  if (result && result.ok && Array.isArray(result.jarPaths) && result.jarPaths.length > 0) {
    const paths = modsPathsFor(options).concat(result.jarPaths)
    let assessed = { verdict: 'unknown' }
    try {
      assessed = assessLoginChannel(channel, paths)
    } catch (err) {
      debug(`assessment for ${channel} over the acquired jar failed (${err.message})`)
    }
    if (assessed.verdict === 'ack') {
      if (receipt) receipt.derived = `ack-index-${assessed.index}`
      try {
        if (!Array.isArray(client.forgeLoginCorroboration)) client.forgeLoginCorroboration = []
        client.forgeLoginCorroboration.push({ channel, via: 'jar-derived-ack (acquired)', index: assessed.index, jarEvidence: assessed.evidence, announcedChannel: attribution.announcedChannel, ownerMod: modId, ownerVersion: version, acquisition })
      } catch { /* receipts never break the reply path */ }
      console.log(`[forge] answering the modded login check on channel "${channel}" from the ACQUIRED ${modId}@${version} jar: derived ack index ${assessed.index} (${assessed.msgClass}; ${assessed.evidence}; acquisition ${acquisition.outcome} in ${acquisition.ms}ms)`)
      return { reply: assessed.reply, via: `jar-derived ack index ${assessed.index} (acquired ${modId}@${version})`, acquired: true }
    }
    if (assessed.verdict === 'underivable') {
      if (receipt) receipt.derived = `underivable:${assessed.reason}`
      if (assessed.reason === 'substantive-reply') {
        failWrappedLoginHonestly(client, channel, Object.assign({}, assessed, { acquisition }))
        return { failed: true }
      }
      declineWrappedLoginHonestly(client, channel, Object.assign({}, assessed, { acquisition }))
      return { declined: true, assessed, acquired: true }
    }
    if (receipt) receipt.derived = 'no-channel'
    acquisition.outcome = 'acquired-jar-holds-no-channel'
  }
  if (result && result.outcome === 'in-progress') {
    // THE DEADLINE LAW (HF20's shape): the download outran the login budget
    // — NO decline is sent (a decline here is the deterministic kick). We
    // end the connection OURSELVES with a typed retryable fact; the download
    // continues in this process, the app's exit path waits a bounded window
    // for it to land, and the reconnect derives from the cache at ping time.
    const progress = result.progress || {}
    const fact = {
      verdict: 'acquisition-in-progress',
      modId,
      version,
      channel,
      bytesDone: Number(progress.bytesDone) || 0,
      bytesTotal: Number.isFinite(Number(progress.bytesTotal)) ? Number(progress.bytesTotal) : null,
      etaMs: Number.isFinite(Number(progress.etaMs)) ? Number(progress.etaMs) : null,
      budgetMs,
      elapsedMs: Date.now() - started
    }
    client.minepalAnnouncedModAcquisition = fact
    client.minepalAnnouncedModAcquisitionBackground = {
      promise: Promise.resolve(result.background).then((fin) => { fact.finished = true; fact.ok = !!(fin && fin.ok); fact.finalOutcome = fin && fin.outcome; return fin }).catch(() => null),
      waitCapMs: Number.isFinite(result.waitCapMs) ? result.waitCapMs : Math.min(240000, Math.max(15000, (fact.etaMs || 60000) + 5000))
    }
    console.warn(`[forge] ${modId}@${version} (for login channel "${channel}") cannot be obtained inside the login window (${fact.bytesDone}/${fact.bytesTotal == null ? '?' : fact.bytesTotal} bytes after ${fact.elapsedMs}ms${fact.etaMs != null ? `, ~${Math.round(fact.etaMs / 1000)}s to go` : ''}) — disconnecting on purpose instead of sending the decline the server would kick; the download continues and MinePal reconnects when it lands`)
    try { client.emit('forgeAnnouncedModAcquisitionInProgress', fact) } catch { /* receipts never break the path */ }
    try { if (typeof client.end === 'function') client.end('announced mod acquisition in progress') } catch (err) { debug(`ending the connection failed (${err.message})`) }
    return { silent: true }
  }
  declineUncorroboratedLogin(client, channel, attribution, acquisition)
  return { declined: true, assessed: { verdict: 'unknown', reason: 'uncorroborated-by-local-jars', attribution, acquisition }, acquired: true }
}

// The honest failure: no guessed bytes are ever sent for a channel we KNOW
// we cannot answer. The copy names the channel; ending the connection rides
// the existing surfacing rails (the app's join watchdog turns a pre-login
// 'end' into a typed error carrying this reason, and join-diagnostics
// records it as the disconnect reason).
function failWrappedLoginHonestly (client, channel, assessed) {
  const detail = assessed.reason === 'substantive-reply'
    ? `its login reply (${assessed.msgClass}) must carry data this client cannot reconstruct`
    : 'no provable acknowledgement reply exists in the local mod jars'
  const message = `Cannot answer the modded login check on channel "${channel}": ${detail}. ` +
    'Join stopped honestly instead of sending a wrong acknowledgement (the server would kick it as an unexpected query response).'
  console.error(`[forge] ${message}`)
  client.forgeUnanswerableLoginChannel = { channel, verdict: assessed.verdict, reason: assessed.reason, msgClass: assessed.msgClass, evidence: assessed.evidence, acquisition: assessed.acquisition || null }
  client.emit('forgeLoginUnanswerable', client.forgeUnanswerableLoginChannel)
  try {
    if (typeof client.end === 'function') client.end(message)
  } catch (err) {
    debug(`ending the connection failed (${err.message}) — the socket may already be down`)
  }
}

// The protocol-correct decline (HF8): the login check stays UNANSWERED in
// the mod's own index space — we send the vanilla "not understood"
// login_plugin_response (successful=false, no payload), exactly what the
// reference Forge client sends for a query it cannot dispatch. No claim is
// made; the server's IndexedMessageCodec accepts the decline for messages
// registered without needsResponse and kicks with its own named copy for
// the rest — either way the outcome is the SERVER's decision, recorded here
// so a following kick is classified with this channel attached.
function declineWrappedLoginHonestly (client, channel, assessed) {
  const message = `Answering the modded login check on channel "${channel}" with the protocol's not-understood decline: ` +
    'no provable acknowledgement reply exists in the local mod jars, and a decline (unlike a guessed acknowledgement) is not a claim. ' +
    'The server now decides — mods that tolerate a vanilla-shaped answer continue the login; mods that require the reply will kick with their own message.'
  console.warn(`[forge] ${message}`)
  if (!Array.isArray(client.forgeDeclinedLoginChannels)) client.forgeDeclinedLoginChannels = []
  client.forgeDeclinedLoginChannels.push({ channel, verdict: assessed.verdict, reason: assessed.reason, evidence: assessed.evidence, acquisition: assessed.acquisition || null })
  client.emit('forgeLoginDeclined', { channel, reason: assessed.reason, evidence: assessed.evidence, acquisition: assessed.acquisition || null })
}

// The HF13 decline: same wire bytes as the HF8 decline (the vanilla
// not-understood login_plugin_response — successful=false, no payload), for
// the class where the LOCAL JARS know nothing but the SERVER'S OWN
// ANNOUNCEMENT proves the channel belongs to a mod we do not hold. The old
// behavior — the FML convention acknowledge byte 99 — is then an
// uncorroborated claim in that mod's own IndexedMessageCodec space, and the
// live receipt for it is a deterministic kick ("Unexpected custom data from
// client" -> multiplayer.disconnect.unexpected_query_response; one attempt
// raced into a server-side ConcurrentModificationException). The reference
// Forge client WITHOUT the mod sends exactly this decline
// (ClientHandshakePacketListenerImpl patch), so a half-matching or absent
// local instance now answers as the real client it is honest about being —
// never worse than no instance at all, and join-viable on every server whose
// message tolerates the vanilla-shaped answer (proven live: tacztweaks
// accepts it).
function declineUncorroboratedLogin (client, channel, attribution, acquisition) {
  const owner = attribution.ownerMod
    ? `mod "${attribution.ownerMod}"${attribution.ownerVersion ? ` (announced version ${attribution.ownerVersion})` : ''}`
    : 'one of its mods'
  // HF23: the acquisition outcome rides the receipt AND the copy — the
  // honest stop names the announced mod@version and why it could not be
  // obtained (P5), so even the RST variant of the kill names the mod.
  const acquired = acquisition
    ? ` MinePal tried to obtain ${attribution.ownerMod}@${attribution.ownerVersion} (announced by the server for this channel) from ${acquisition.registry || 'the public registry'}: ${acquisitionOutcomeWords(acquisition.outcome)}; the answer could not be derived, so`
    : ''
  const evidence = `server-announced channel${attribution.announcedChannel ? ' (in the FML ModList)' : ''} attributed to ${owner}; no local jar carries it${acquisition ? `; acquisition ${acquisition.outcome}` : ''}`
  const message = `Answering the modded login check on channel "${channel}" with the protocol's not-understood decline: ` +
    `the server itself announced this channel belongs to ${owner}, and the local mod jars carry no knowledge of it${acquired ? ` —${acquired}` : ' —'} ` +
    'the legacy FML convention acknowledgement (index 99) would be an uncorroborated claim in that mod\'s own message space ' +
    '(live receipt: the server dispatches it, finds no message registered at 99, logs "Unexpected custom data from client" ' +
    'and kicks with multiplayer.disconnect.unexpected_query_response). A decline is not a claim — it is byte-identical to ' +
    'what a real Forge client without this mod answers. The server now decides: mods that tolerate a vanilla-shaped answer ' +
    'continue the login; mods that require the reply kick with their own message. If this join fails, pointing MinePal at ' +
    'the server\'s own modpack instance (its mods folder) gives the derivation the jars it needs for a real answer.'
  console.warn(`[forge] ${message}`)
  if (!Array.isArray(client.forgeDeclinedLoginChannels)) client.forgeDeclinedLoginChannels = []
  client.forgeDeclinedLoginChannels.push({
    channel,
    verdict: 'unknown',
    reason: 'uncorroborated-by-local-jars',
    evidence,
    ownerMod: attribution.ownerMod,
    ownerVersion: attribution.ownerVersion,
    announcedChannel: attribution.announcedChannel,
    acquisition: acquisition || null
  })
  client.emit('forgeLoginDeclined', { channel, reason: 'uncorroborated-by-local-jars', evidence, acquisition: acquisition || null })
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

  // HF12 boundary law (loginReplyBoundary.js): fml:handshake lockstep rounds
  // are awaited by the server (its HandshakeHandler blocks on them — live-log
  // receipt: "Sending ticking packet info ... sequence N" strictly alternates
  // with "Received client indexed reply N") and are written synchronously
  // through the guard; wrapped-MOD-channel and raw-channel replies belong to
  // the fire-and-forget-capable class the server may complete negotiation
  // without, so they are deferred one event-loop turn and dropped with a
  // receipt when the negotiation is observably over — a late raw reply
  // crossing the server's compression arming is the HF12 kill-shot
  // ("Badly compressed packet - size of 2 is below server threshold of 256":
  // login_plugin_response's packet id 0x02 read as a compressed-frame
  // data-length).
  function respond (messageId, data, context) {
    const params = { messageId, data }
    if (context && context.awaited) writeLoginReplyNow(client, params, context)
    else writeLoginReplyDeferred(client, params, context || {})
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
        writeLoginReplyDeferred(client, { messageId: packet.messageId, data: reply }, { channel: packet.channel, kind: 'raw-channel reply' })
      } else {
        // we can't speak it, so give the vanilla "not understood" response
        debug(`unknown login channel ${packet.channel}, replying not-understood`)
        writeLoginReplyDeferred(client, { messageId: packet.messageId }, { channel: packet.channel, kind: 'raw-channel not-understood' })
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
      // Resolution ladder (resolveWrappedModLogin): table override first,
      // jar-DERIVED verdict second (ack / honest join stop for provably
      // unanswerable channels), FML acknowledge 99 last — only for channels
      // the local jars know nothing about.
      if (wrapper.channel !== 'fml:handshake') {
        const channel = wrapper.channel
        const messageId = packet.messageId
        const discValue = disc.value
        // One dispatch for the synchronous ladder AND the HF23 deferred
        // (acquired) resolution — the same three shapes, the same writes.
        const dispatch = (resolved, late) => {
          if (resolved && (resolved.failed || resolved.silent)) return true // honest join stop / deadline-law self-end — nothing to write
          if (resolved && resolved.declined) {
            // HF8: vanilla "not understood" — messageId with NO data encodes
            // successful=false (byte-identical to the reference client's
            // decline, ClientHandshakePacketListenerImpl patch). HF12: written
            // through the deferred boundary guard — the receipt's killer was
            // exactly this decline (tacztweaks:handshake), computed for ~650ms
            // by a cold jar assessment and then written RAW after the server
            // had already completed negotiation and armed compression.
            writeLoginReplyDeferred(client, { messageId }, { channel, kind: resolved.acquired ? 'wrapped decline (after acquisition)' : 'wrapped decline' })
            return true
          }
          if (resolved && resolved.reply) {
            debug(`answering ${channel} login message disc=${discValue} in its own index space via ${resolved.via} (${resolved.reply.length} bytes)`)
            respond(messageId, wrapLoginPayload(channel, resolved.reply), { channel, kind: resolved.acquired ? 'wrapped reply (acquired)' : 'wrapped reply' })
            return true
          }
          if (late) {
            // by construction the deferred rung never resolves null; belt:
            // the HF13 decline (never a guessed byte)
            writeLoginReplyDeferred(client, { messageId }, { channel, kind: 'wrapped decline (acquisition fallback)' })
            return true
          }
          return false
        }
        const resolved = resolveWrappedModLogin(client, channel, discValue, wrapper.data.slice(disc.size), options)
        if (resolved && resolved.pending) {
          // HF23: the answer is deferred behind the announced-mod acquisition;
          // the server waits for a needsResponse reply (see resolveWrappedModLogin)
          resolved.pending.then((late) => dispatch(late, true)).catch((err) => {
            console.warn(`[forge] announced-mod acquisition for ${channel} threw (${err && err.message}) — answering with the protocol's not-understood decline`)
            writeLoginReplyDeferred(client, { messageId }, { channel, kind: 'wrapped decline (acquisition error)' })
          })
          return
        }
        if (dispatch(resolved, false)) return
        // null: no local knowledge of this channel — fall through to the FML
        // convention acknowledge (99) below, wrapped on the ORIGINATING channel
      }

      if (wrapper.channel === 'fml:handshake' && disc.value === DISCRIMINATOR.MOD_LIST) {
        const modList = parseModList(wrapper.data, disc.size)
        debug(`server ModList: ${modList.mods.length} mods, ${modList.channels.length} channels, ${modList.registries.length} registries`)
        client.forgeModList = modList

        const pingVersions = options.pingModVersions || {}
        // HF23-R1: a hidden ping carries no versions — the S2CModData that
        // precedes this ModList on the wire does (parsed below into
        // client.forgeModData), so the embedder's mod census sees
        // modid@version either way.
        const modData = (client.forgeModData && client.forgeModData.mods) || {}
        client.emit('forgeMods', modList.mods.map((id) => {
          const version = pingVersions[id] || (modData[id] && modData[id].version) || null
          return version ? { modid: id, version } : id
        }))

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
        respond(packet.messageId, wrapLoginPayload('fml:handshake', encodeModListReply(reply)), { channel: 'fml:handshake', kind: 'ModListReply', awaited: true })
        return
      }

      // S2CModData (disc 5, "Sending ticking packet info ... S2CModData"):
      // dispatched fire-and-forget — the reference client's HandshakeHandler
      // stores the mod data and sends NOTHING back, and the live 1.20.1
      // server ERROR-logs our unsolicited ack ("Recieved unexpected index 0
      // in client reply", hf8rigC receipt) before tolerating it. HF12: an
      // unsolicited login reply is exactly the class that can cross the
      // compression-arming boundary, so the reference client's silence is
      // the law — record the receipt, reply with nothing.
      if (wrapper.channel === 'fml:handshake' && disc.value === DISCRIMINATOR.MOD_DATA) {
        // HF23-R1: READ it (never reply): modid -> version from the server's
        // own ModList.get() — the announced version on a wire whose ping hid
        // the mod list, consumed by announcedChannelAttribution for the
        // HF13 corroboration + HF23 acquisition rungs. Best-effort parse.
        try {
          const modData = parseModData(wrapper.data, disc.size)
          client.forgeModData = modData
          debug(`S2CModData received (${wrapper.data.length} bytes, ${modData.count} mods with versions) — no reply, matching the reference client`)
          client.emit('forgeModData', modData)
        } catch (err) {
          debug(`S2CModData received (${wrapper.data.length} bytes) but could not be parsed (${err.message}) — no reply, matching the reference client`)
        }
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
      respond(packet.messageId, wrapLoginPayload(wrapper.channel, encodeAcknowledgement()),
        { channel: wrapper.channel, kind: 'convention ack', awaited: wrapper.channel === 'fml:handshake' })
    } catch (err) {
      // A request left unanswered hangs the login until the server times us
      // out, so an acknowledgement is always the least-bad answer. If even the
      // outer wrapper failed to parse there is no originating channel to name,
      // so fall back to fml:handshake.
      debug(`failed to handle loginwrapper payload (${err.message}), acknowledging anyway`)
      const ch = wrapper ? wrapper.channel : 'fml:handshake'
      respond(packet.messageId, wrapLoginPayload(ch, encodeAcknowledgement()),
        { channel: ch, kind: 'fallback ack', awaited: ch === 'fml:handshake' })
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
// HF23-R1: the S2CModData reader (exported for tests — the announced-version
// source on hidden-ping wires)
module.exports.parseModData = parseModData
module.exports.SNAPSHOT_REGISTRIES = SNAPSHOT_REGISTRIES
// The hand-verified override table, exported so tests (and E2E rigs proving
// the derivation path) can inspect or disable individual entries.
module.exports.WRAPPED_LOGIN_PROTOCOLS = WRAPPED_LOGIN_PROTOCOLS
// Shared wrapped-channel machinery, used by the FML2 (1.13-1.17) sibling
// responder and by tests: one rule for the class of login-wrapped mod
// channels across both login-phase FML eras.
module.exports.resolveWrappedModLogin = resolveWrappedModLogin
module.exports.failWrappedLoginHonestly = failWrappedLoginHonestly
// HF13: announced-reality attribution (exported for tests — the corroboration
// gate between the local jars' 'unknown' verdict and the legacy 99 floor).
module.exports.announcedChannelAttribution = announcedChannelAttribution
// HF23: the announced-mod acquisition rung (exported for tests — the
// deferred resolution over an injected accessor, plus the version filter
// that keeps ANY / SERVER_ONLY markers from ever being queried).
module.exports.acquireThenResolve = acquireThenResolve
module.exports.isAcquirableVersion = isAcquirableVersion
module.exports.acquisitionOutcomeWords = acquisitionOutcomeWords
module.exports.wrapLoginPayload = wrapLoginPayload
module.exports.encodeAcknowledgement = encodeAcknowledgement
module.exports.modsPathsFor = modsPathsFor
