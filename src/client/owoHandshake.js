// owo-lib login-phase handshake (owo:handshake) — ONE jar-derived
// implementation shared by both login lanes (HF35): the Forge fork's FML3
// responder (forgeHandshake3.js RAW_LOGIN_PROTOCOLS, owo reaches Forge
// servers via Sinytra Connector) and the Fabric lib's login gates
// (minecraft-protocol-fabric fabricLoginGates.js, which takes this module's
// `assess` by injection from the embedding app — no lib->lib edge).
// Body moved verbatim from forgeHandshake3.js; `assess` is the lane-neutral
// derive-or-honest-abstain entry the Fabric lane uses.
const fs = require('fs')
const path = require('path')
const debug = require('debug')('minecraft-protocol-forge')
const { zipCentralEntries, zipEntryData, parseClassFile, walkBytecode, javaStringHash } = require('./jarAnalysis')
const { writeVarInt, writeString } = require('./loginBytes')

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
//   filterOptionalServices, which never rejects. syncClient (javap ~:101-109)
//   ALWAYS writes the client's OWN OwoNetChannel.OPTIONAL_CHANNELS there - it
//   never echoes the request bytes - so the reply carries our optional
//   fingerprints (the server intersects them with its own; no kick either way).
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
  'net/minecraft/resources/ResourceLocation', // mojmap/srg (Connector-remapped)
  'net/minecraft/resources/Identifier' // mojmap 26.1+ (HF43: ResourceLocation renamed)
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
        if (c && c.tag === 8) { lastStrings.push(utf8(c.strIndex)); if (lastStrings.length > 2) lastStrings.shift() } else if (c && c.tag === 7) lastClassConst = utf8(c.nameIndex)
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
        if (r.desc === `L${OWO_CHANNEL_CLASS};` && lastChannel) { facts.channelFields.set(key, lastChannel); lastChannel = null } else if (r.desc === `L${OWO_CONTROLLER_CLASS};` && lastController) { facts.controllerFields.set(key, lastController); lastController = null } else if (r.desc[0] === 'L' && OWO_IDENTIFIER_CLASSES.has(r.desc.slice(1, -1)) && lastIdentifier) facts.identifierFields.set(key, lastIdentifier)
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
  // owo:handshake reply (layout above): required-channel hashes, controller
  // hashes and optional-channel hashes, ALL derived from the modpack jars. The
  // request payload (the server's optional map) is not part of the reply -
  // syncClient writes the client's own OPTIONAL_CHANNELS, never an echo.
  'owo:handshake': (data, options) => buildReply(owoFingerprintsFor(options))
}

// The ONE reply layout (both entries above build through it): required-channel
// hash map, controller hash map, then OUR optional-channel hash map - exactly
// the three writeHashes calls of OwoHandshake#syncClient. Takes only the
// fingerprints: the request bytes never influence the reply.
function buildReply (fingerprints) {
  return Buffer.concat([
    encodeIdHashMap(fingerprints.channels),
    encodeIdHashMap(fingerprints.controllers),
    encodeIdHashMap(fingerprints.optional)
  ])
}

// Lane-neutral assessment (HF35, the Fabric lane's entry): derives the reply
// from the mods folders given in `options.modsPaths` (or the forge-lane
// aliases) and returns EITHER { data, derived, sources } — the understood
// reply — OR { abstain: { reason }, sources } when NO mods folder is known or
// the scan itself failed (the caller answers not-understood and names owo-lib
// + the channel + the mods-folder fix; never the account). A configured folder
// that simply yields zero owo fingerprints is NOT an abstain: the empty maps
// are the truthful reply (the server then names the channels it misses).
function assess (data, options) {
  const sources = modsPathsFor(options)
  if (sources.length === 0) {
    return { abstain: { reason: 'no-mods-folder', detail: 'no local mods folder is known for this join, so the owo-lib channel fingerprints cannot be derived' }, sources }
  }
  let fingerprints
  try {
    fingerprints = owoFingerprintsFor(options)
  } catch (err) {
    return { abstain: { reason: 'scan-failed', detail: `owo fingerprint scan failed: ${err.message}` }, sources }
  }
  const counts = (m) => Object.keys(m || {}).length
  return {
    data: buildReply(fingerprints),
    sources,
    derived: { channels: counts(fingerprints.channels), controllers: counts(fingerprints.controllers), optional: counts(fingerprints.optional), channelIds: Object.keys(fingerprints.channels), controllerIds: Object.keys(fingerprints.controllers) }
  }
}

module.exports = { CHANNEL: 'owo:handshake', buildReply, encodeIdHashMap, owoIdentifierHash, scanOwoFingerprints, modsPathsFor, owoFingerprintsFor, RAW_LOGIN_PROTOCOLS, assess }
