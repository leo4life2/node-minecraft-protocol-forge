// D3 — static derivation of the LOADER'S OWN custom-spawn message codec from
// the loader universal jar (Forge `fml:play` / `forge:play` SpawnEntity,
// NeoForge `neoforge:advanced_add_entity`): the message a Forge-family server
// ships INSTEAD of vanilla `spawn_entity` for every entity whose
// getAddEntityPacket goes through NetworkHooks.getEntitySpawningPacket
// (Moonlight/Supplementaries red_merchant + hat_stand on the D3 receipt rig).
//
// P2 (docs/MODDED-JOIN-DESIGN.md): the codec is a FACT OF THE JAR, never a
// hand-written per-version table. Everything below is read out of the
// shipped bytecode; when a fact cannot be read the derivation ABSTAINS
// with a named reason and the decoder synthesizes nothing.
//
// What is derived (and from where):
//   1. the SPAWN MESSAGE CLASS — a class under a `/network/` package whose
//      buffer-reading method (static `decode(FriendlyByteBuf)` or a
//      `(FriendlyByteBuf)` constructor) reads a sequence of buffer primitives
//      and feeds them to the canonical constructor; each read is classified
//      by the buffer method's NAME (netty's fixed-width readInt/readLong/
//      readDouble/readByte/readShort are unobfuscated) or, for a Mojang-
//      defined reader (obfuscated `m_130242_` on 1.16–1.20.4, `readVarInt`
//      under official names), by its return DESCRIPTOR (`()I` varint, `()J`
//      varlong, `()Ljava/util/UUID;` uuid, `()[B` varint-prefixed bytes);
//      two `readLong`s feeding `UUID.<init>(JJ)` collapse into one uuid.
//      The read order is corroborated against the canonical constructor's
//      parameter list (count + JVM type per slot) and every read's ROLE
//      (type / entityId / uuid / x / y / z / pitch / yaw / headYaw / vel* /
//      custom) comes from the FIELD NAME the constructor stores that
//      parameter into (Forge's own source names — `typeId`, `entityId`,
//      `posX` … — unobfuscated in every build inspected). A class whose
//      roles carry `entityId` + custom bytes but no type/position is a
//      COMPANION payload (NeoForge 20.4+ AdvancedAddEntityPayload rides
//      NEXT TO vanilla add_entity, it does not replace it): nothing to
//      synthesize, reported as such.
//   2. the CHANNEL + MESSAGE INDEX — the registrar class that `ldc`s the
//      spawn class: an explicit int pushed between the class constant and
//      the `messageBuilder(Class, int…)` call is the index (Forge ≤1.20.1,
//      NeoForge 20.2: `messageBuilder(SpawnEntity.class, 0)`); a
//      `messageBuilder(Class[, NetworkDirection])` without an int (Forge
//      1.20.2+) takes the channel's SEQUENTIAL counter — index = number of
//      earlier registrations on the SAME channel receiver (static field) in
//      program order, seeded from the channel class's counter field init
//      (0 when the constructor never stores a constant). The channel name is
//      the ResourceLocation handed to the builder's `named(...)`: an
//      `ldc "ns:path"`, a `("ns","path")` pair feeding `ResourceLocation.<init>`
//      / a static factory, or a static ResourceLocation field resolved
//      through its owner's `<clinit>` (NetworkConstants.FML_PLAY_RESOURCE).
//   3. the INDEX WIDTH — how the channel's codec reads the discriminator
//      before the per-message decoder: the buffer read that feeds an
//      id→handler map lookup (`Short2ObjectMap.get` after
//      `readUnsignedByte` = u8 on the IndexedMessageCodec builds,
//      `Int2ObjectMap.get` after a varint read on 1.20.2+ SimpleChannel),
//      searched in the registrar's channel class and the codec classes it
//      references. Two different widths found = ambiguous = abstain.
//
// PRIVACY LAWS (jarAnalysis): LOCAL-ONLY, READ-ONLY, PURPOSE-LIMITED — reads
// one local jar, parses bytecode, classloads/executes/sends nothing.
'use strict'

const fs = require('fs')
const debug = require('../../debug')
const { zipCentralEntries, zipEntryData, parseClassFile, walkBytecode, cpUtf8, cpClassName, cpRef } = require('./jarAnalysis')

const DERIVATION_SCHEMA = 1

// Field-name → role vocabulary (loader-family source names, lowercased).
const ROLE_NAMES = {
  type: ['typeid', 'entitytypeid', 'entitytype', 'type'],
  entityId: ['entityid', 'id', 'entity_id'],
  uuid: ['uuid', 'entityuuid'],
  x: ['posx', 'x'],
  y: ['posy', 'y'],
  z: ['posz', 'z'],
  pitch: ['pitch', 'xrot'],
  yaw: ['yaw', 'yrot'],
  headYaw: ['headyaw', 'headrot', 'yheadrot', 'headpitch'],
  velX: ['velx', 'velocityx', 'xvel', 'xd'],
  velY: ['vely', 'velocityy', 'yvel', 'yd'],
  velZ: ['velz', 'velocityz', 'zvel', 'zd'],
  custom: ['buf', 'custompayload', 'data', 'extradata', 'spawndata', 'payload']
}
const ROLE_OF_FIELD = (() => {
  const m = new Map()
  for (const [role, names] of Object.entries(ROLE_NAMES)) for (const n of names) m.set(n, role)
  return m
})()

// netty ByteBuf fixed-width readers (unobfuscated on every build)
const NETTY_READERS = {
  readInt: 'i32',
  readLong: 'i64',
  readDouble: 'f64',
  readFloat: 'f32',
  readByte: 'i8',
  readShort: 'i16',
  readBoolean: 'bool',
  readUnsignedByte: 'u8',
  readUnsignedShort: 'u16',
  readChar: 'u16'
}
// JVM type each wire kind pushes (for ctor-parameter corroboration)
const JVM_OF_KIND = { varint: 'I', i32: 'I', i16: 'S', i8: 'B', u8: 'S', u16: 'I', bool: 'Z', varlong: 'J', i64: 'J', f64: 'D', f32: 'F', uuid: 'Ljava/util/UUID;', bytes: '[B', string: 'Ljava/lang/String;' }
const INT_COMPAT = new Set(['I', 'S', 'B', 'C', 'Z'])

function isBufferOwner (owner) {
  return typeof owner === 'string' && /(ByteBuf|PacketBuffer)$/.test(owner)
}
function isRlOwner (owner) {
  return typeof owner === 'string' && /\/ResourceLocation$/.test(owner)
}
function simpleName (cls) { return cls ? cls.slice(cls.lastIndexOf('/') + 1) : '' }

// Method descriptor → parameter JVM types (as descriptor fragments).
function paramTypes (desc) {
  const out = []
  let i = desc.indexOf('(') + 1
  while (i < desc.length && desc[i] !== ')') {
    let j = i
    while (desc[j] === '[') j++
    if (desc[j] === 'L') { const e = desc.indexOf(';', j); out.push(desc.slice(i, e + 1)); i = e + 1 } else { out.push(desc.slice(i, j + 1)); i = j + 1 }
  }
  return out
}
function returnType (desc) { return desc.slice(desc.indexOf(')') + 1) }

// Instruction rows with the operands this derivation reasons about.
function rows (code, cp) {
  const out = []
  walkBytecode(code, (op, pc) => {
    const row = { op, pc }
    switch (op) {
      case 0x12: { const c = cp[code[pc + 1]]; if (c) { if (c.tag === 8) row.str = cpUtf8(cp, c.strIndex); else if (c.tag === 3) row.int = c.int; else if (c.tag === 7) row.cls = cpUtf8(cp, c.nameIndex) } break }
      case 0x13: { const c = cp[code.readUInt16BE(pc + 1)]; if (c) { if (c.tag === 8) row.str = cpUtf8(cp, c.strIndex); else if (c.tag === 3) row.int = c.int; else if (c.tag === 7) row.cls = cpUtf8(cp, c.nameIndex) } break }
      case 0x10: row.int = code.readInt8(pc + 1); break
      case 0x11: row.int = code.readInt16BE(pc + 1); break
      case 0x02: case 0x03: case 0x04: case 0x05: case 0x06: case 0x07: case 0x08: row.int = op - 0x03; break
      case 0x15: case 0x16: case 0x17: case 0x18: case 0x19: row.load = code[pc + 1]; break // iload/lload/fload/dload/aload n
      case 0x1a: case 0x1b: case 0x1c: case 0x1d: row.load = op - 0x1a; break
      case 0x1e: case 0x1f: case 0x20: case 0x21: row.load = op - 0x1e; break
      case 0x22: case 0x23: case 0x24: case 0x25: row.load = op - 0x22; break
      case 0x26: case 0x27: case 0x28: case 0x29: row.load = op - 0x26; break
      case 0x2a: case 0x2b: case 0x2c: case 0x2d: row.load = op - 0x2a; break
      case 0xb2: case 0xb3: case 0xb4: case 0xb5: case 0xb6: case 0xb7: case 0xb8: case 0xb9: row.ref = cpRef(cp, code.readUInt16BE(pc + 1)); break
      case 0xbb: case 0xc0: row.cls = cpClassName(cp, code.readUInt16BE(pc + 1)); break
    }
    out.push(row)
  })
  return out
}
const isInvoke = (r) => r.op >= 0xb6 && r.op <= 0xb9 && r.ref
const isGetstatic = (r) => r.op === 0xb2 && r.ref
const isPutstatic = (r) => r.op === 0xb3 && r.ref
const isPutfield = (r) => r.op === 0xb5 && r.ref

// --- 1. the spawn message class ---------------------------------------------

// Classify one buffer read by name (netty) or descriptor (Mojang-defined).
function classifyRead (ref) {
  if (!isBufferOwner(ref.owner)) return null
  if (NETTY_READERS[ref.name]) return NETTY_READERS[ref.name]
  if (!ref.desc.startsWith('()')) return null
  switch (returnType(ref.desc)) {
    case 'I': return 'varint'
    case 'J': return 'varlong'
    case 'Ljava/util/UUID;': return 'uuid'
    case '[B': return 'bytes'
    case 'Ljava/lang/String;': return 'string'
    default: return 'opaque'
  }
}

// The ordered read sequence of a buffer-reading method plus the canonical
// ctor it feeds (static decode form) — or direct putfields (ctor form).
function readSequence (parsed, m) {
  const rs = rows(m.code, parsed.cp)
  const reads = []
  let canonical = null
  const directFields = []
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i]
    if (!isInvoke(r)) { if (isPutfield(r) && r.ref.owner === parsed.className) directFields.push({ at: reads.length, field: r.ref.name }); continue }
    if (r.ref.owner === parsed.className && r.ref.name === '<init>' && m.method === '<init>' && r.op === 0xb7 && rs.slice(0, i).some((q) => q.load === 0)) {
      // this(...) delegation from a (FriendlyByteBuf) ctor
      canonical = r.ref
      break
    }
    if (r.ref.owner === parsed.className && r.ref.name === '<init>' && m.method !== '<init>') { canonical = r.ref; break }
    if (r.ref.owner === 'java/util/UUID' && r.ref.name === '<init>' && r.ref.desc === '(JJ)V') {
      const b = reads.pop(); const a = reads.pop()
      if (!a || !b || a.kind !== 'i64' || b.kind !== 'i64') return { error: 'uuid-from-non-longs' }
      reads.push({ kind: 'uuid' })
      continue
    }
    if (r.ref.owner === parsed.className && r.op === 0xb8 && paramTypes(r.ref.desc).some((t) => isBufferOwner(t.slice(1, -1)))) {
      // a static helper taking the buffer (Forge readSpawnDataPacket): opaque tail
      reads.push({ kind: 'opaque', via: r.ref.name })
      continue
    }
    const kind = classifyRead(r.ref)
    if (kind) reads.push({ kind, via: r.ref.name })
  }
  if (!canonical && m.method === '<init>' && directFields.length) return { reads, directFields }
  if (!canonical) return { error: 'no-canonical-ctor' }
  return { reads, canonical }
}

// slot → field-name map from the canonical ctor body (aload_0; xload n; putfield F)
function ctorSlotFields (parsed, ctorDesc) {
  const m = parsed.codes.find((c) => c.method === '<init>' && c.desc === ctorDesc)
  if (!m) return null
  const rs = rows(m.code, parsed.cp)
  const out = new Map()
  for (let i = 2; i < rs.length; i++) {
    const r = rs[i]
    if (!isPutfield(r) || r.ref.owner !== parsed.className) continue
    const a = rs[i - 2]; const b = rs[i - 1]
    if (a && a.load === 0 && b && typeof b.load === 'number' && b.load > 0) out.set(b.load, r.ref.name)
  }
  return out
}

function roleOf (fieldName) { return ROLE_OF_FIELD.get(String(fieldName).toLowerCase()) || null }

// Wire kind of a static StreamCodec constant by its field name (ByteBufCodecs /
// NeoForgeStreamCodecs / UUIDUtil.STREAM_CODEC — 1.20.5+ official names).
const STREAM_CODEC_KINDS = {
  VAR_INT: 'varint',
  INT: 'i32',
  VAR_LONG: 'varlong',
  LONG: 'i64',
  DOUBLE: 'f64',
  FLOAT: 'f32',
  BYTE: 'i8',
  SHORT: 'i16',
  BOOL: 'bool',
  BYTE_ARRAY: 'bytes',
  UNBOUNDED_BYTE_ARRAY: 'bytes',
  STRING_UTF8: 'string'
}
function streamCodecKind (ref) {
  if (!ref || !/StreamCodec;$/.test(ref.desc)) return null
  if (/UUIDUtil$/.test(ref.owner)) return 'uuid'
  if (!/Codecs$/.test(ref.owner)) return null
  return STREAM_CODEC_KINDS[ref.name] || 'opaque'
}

// 1.20.5+ record payload: `STREAM_CODEC = StreamCodec.composite(codecA, A::a,
// codecB, B::b, …, Payload::new)` in <clinit>; codecs in order = canonical
// ctor parameter order; roles from the ctor's putfields.
function analyzeCompositeCandidate (parsed) {
  const clinit = parsed.codes.find((c) => c.method === '<clinit>')
  if (!clinit) return null
  const rs = rows(clinit.code, parsed.cp)
  const { resolveLambdaImpl } = require('./jarAnalysis')
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i]
    if (!isInvoke(r) || !/StreamCodec$/.test(r.ref.owner) || r.ref.name !== 'composite') continue
    const kinds = []
    let ctor = null
    for (let j = i - 1; j >= 0; j--) {
      const q = rs[j]
      if (isPutstatic(q) || (isInvoke(q) && /StreamCodec$/.test(q.ref.owner))) break
      if (isGetstatic(q)) { const k = streamCodecKind(q.ref); if (k) kinds.unshift(k) }
      if (q.op === 0xba && ctor === null) {
        const dyn = parsed.cp[clinit.code.readUInt16BE(q.pc + 1)]
        const impl = dyn && dyn.bsmIndex !== undefined ? resolveLambdaImpl(parsed, dyn.bsmIndex) : null
        ctor = impl && impl.name === '<init>' && impl.owner === parsed.className ? impl : false
      }
    }
    if (!ctor || kinds.length === 0) continue
    const params = paramTypes(ctor.desc)
    if (params.length !== kinds.length) return { className: parsed.className, error: `composite arity mismatch (${kinds.length} codecs vs ${params.length} ctor params)` }
    const slotFields = ctorSlotFields(parsed, ctor.desc)
    if (!slotFields) return { className: parsed.className, error: 'record ctor body unreadable' }
    const fields = []
    let slot = 1
    for (let k = 0; k < params.length; k++) {
      const jvm = JVM_OF_KIND[kinds[k]]
      if (kinds[k] !== 'opaque' && !(jvm === params[k] || (INT_COMPAT.has(jvm) && INT_COMPAT.has(params[k])))) return { className: parsed.className, error: `codec ${kinds[k]} feeds ctor param ${params[k]} at slot ${k}` }
      const field = slotFields.get(slot) || null
      fields.push({ kind: kinds[k], field, role: field ? roleOf(field) : null, via: 'composite' })
      slot += (params[k] === 'J' || params[k] === 'D') ? 2 : 1
    }
    return { className: parsed.className, fields, readerMethod: '<clinit>', readerDesc: 'StreamCodec.composite', canonicalDesc: ctor.desc }
  }
  return null
}

// The payload's own id, from its <clinit> (TYPE / ID static of ResourceLocation
// or CustomPacketPayload$Type) — the channel a 1.20.2+ payload rides.
function payloadIdOf (parsed, classes) {
  const clinit = parsed.codes.find((c) => c.method === '<clinit>')
  if (!clinit) return null
  const rs = rows(clinit.code, parsed.cp)
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i]
    if (!isPutstatic(r) || r.ref.owner !== parsed.className) continue
    if (!(isRlOwner(r.ref.desc.slice(1, -1)) || /CustomPacketPayload\$Type;$/.test(r.ref.desc))) continue
    const rl = rlBefore(rs, i, classes, 0)
    if (rl) return rl
  }
  return null
}

function analyzeSpawnCandidate (parsed) {
  const bufCtor = parsed.codes.find((c) => c.method === '<init>' && paramTypes(c.desc).length === 1 && isBufferOwner(paramTypes(c.desc)[0].slice(1, -1)))
  const dec = parsed.codes.find((c) => (c.flags & 0x0008) && paramTypes(c.desc).length === 1 && isBufferOwner(paramTypes(c.desc)[0].slice(1, -1)) && returnType(c.desc) === `L${parsed.className};`)
  const reader = dec || bufCtor
  if (!reader) return null
  const seq = readSequence(parsed, reader)
  if (seq.error) return { className: parsed.className, error: seq.error }
  let fields
  if (seq.canonical) {
    const params = paramTypes(seq.canonical.desc)
    // reads feed the canonical ctor in order: count + JVM type per slot must agree
    const reads = seq.reads.slice()
    // the remaining buffer object itself handed over as the trailing parameter
    if (params.length === reads.length + 1 && isBufferOwner(params[params.length - 1].slice(1, -1))) reads.push({ kind: 'opaque', via: 'buffer-tail' })
    const consumed = reads.filter((r) => r.kind !== 'opaque')
    if (consumed.length !== params.length && !(reads.length === params.length && reads[reads.length - 1].kind === 'opaque')) {
      return { className: parsed.className, error: `read/ctor arity mismatch (${reads.length} reads vs ${params.length} params)` }
    }
    const slotFields = ctorSlotFields(parsed, seq.canonical.desc)
    if (!slotFields) return { className: parsed.className, error: 'canonical ctor body unreadable' }
    fields = []
    let slot = 1
    for (let i = 0; i < params.length; i++) {
      const p = params[i]; const r = reads[i]
      if (!r) break
      if (r.kind !== 'opaque') {
        const jvm = JVM_OF_KIND[r.kind]
        const ok = jvm === p || (INT_COMPAT.has(jvm) && INT_COMPAT.has(p))
        if (!ok) return { className: parsed.className, error: `read ${r.kind} (${jvm}) feeds ctor param ${p} at slot ${i}` }
      }
      const field = slotFields.get(slot) || null
      fields.push({ kind: r.kind, field, role: field ? roleOf(field) : null, via: r.via || null })
      slot += (p === 'J' || p === 'D') ? 2 : 1
    }
  } else {
    fields = seq.reads.map((r, i) => {
      const f = seq.directFields.find((d) => d.at === i + 1)
      return { kind: r.kind, field: f ? f.field : null, role: f ? roleOf(f.field) : null, via: r.via || null }
    })
  }
  return classifyFields({ className: parsed.className, fields, readerMethod: reader.method, readerDesc: reader.desc, canonicalDesc: seq.canonical ? seq.canonical.desc : null })
}

function classifyFields (c) {
  const fields = c.fields
  const roles = new Set(fields.map((f) => f.role).filter(Boolean))
  let kind = null
  if (roles.has('entityId') && roles.has('type') && roles.has('x') && roles.has('y') && roles.has('z')) kind = 'spawn'
  else if (roles.has('entityId') && roles.has('custom') && !roles.has('type') && !roles.has('x')) kind = 'companion'
  if (!kind) return null
  // an opaque read anywhere but the tail makes the later fields unreachable
  const opaqueAt = fields.findIndex((f) => f.kind === 'opaque')
  if (opaqueAt !== -1 && opaqueAt !== fields.length - 1) return { className: c.className, error: 'opaque read before the last field' }
  return { ...c, kind }
}

// --- 2. registration: channel + index -----------------------------------------

// ResourceLocation value produced by the rows ending just before `end`.
function rlBefore (rs, end, classes, depth) {
  for (let i = end - 1; i >= 0 && i >= end - 8; i--) {
    const r = rs[i]
    if (isGetstatic(r) && isRlOwner(r.ref.desc.slice(1, -1))) return rlFromStaticField(r.ref, classes, depth + 1)
    if (isInvoke(r) && isRlOwner(r.ref.owner) && (r.ref.name === '<init>' || returnType(r.ref.desc) === `L${r.ref.owner};`)) {
      const strs = paramTypes(r.ref.desc).filter((t) => t === 'Ljava/lang/String;').length
      const lits = []
      for (let j = i - 1; j >= 0 && lits.length < strs; j--) { if (typeof rs[j].str === 'string') lits.unshift(rs[j].str); else if (rs[j].op === 0xbb || rs[j].op === 0x59) continue; else break }
      if (lits.length !== strs || strs === 0) return null
      return strs === 1 ? (lits[0].includes(':') ? lits[0] : `minecraft:${lits[0]}`) : `${lits[0]}:${lits[1]}`
    }
    if (typeof r.str === 'string' && r.str.includes(':')) return r.str
  }
  return null
}
function rlFromStaticField (ref, classes, depth) {
  if (depth > 3) return null
  const owner = classes.get(ref.owner)
  if (!owner) return null
  const clinit = owner.codes.find((c) => c.method === '<clinit>')
  if (!clinit) return null
  const rs = rows(clinit.code, owner.cp)
  const at = rs.findIndex((r) => isPutstatic(r) && r.ref.name === ref.name && r.ref.owner === ref.owner)
  if (at === -1) return null
  return rlBefore(rs, at, classes, depth)
}
// nearest preceding builder call taking a ResourceLocation (`named(RL)`,
// `newSimpleChannel(RL, …)`) → its RL argument
function channelNameBefore (rs, end, classes) {
  for (let i = end - 1; i >= 0; i--) {
    const r = rs[i]
    if (!isInvoke(r)) continue
    const ps = paramTypes(r.ref.desc)
    if (ps.length >= 1 && isRlOwner(ps[0].slice(1, -1)) && !isRlOwner(r.ref.owner)) {
      // arguments after the RL (versions suppliers) sit between the RL and the call; the RL rows precede them
      const rl = rlBefore(rs, i, classes, 0)
      if (rl) return rl
    }
  }
  return null
}

function counterSeed (channelClass) {
  // the channel ctor storing a constant into its counter field; default 0
  if (!channelClass) return 0
  for (const m of channelClass.codes) {
    if (m.method !== '<init>') continue
    const rs = rows(m.code, channelClass.cp)
    for (let i = 1; i < rs.length; i++) {
      const r = rs[i]
      if (isPutfield(r) && r.ref.owner === channelClass.className && r.ref.desc === 'I' && /index|count|id/i.test(r.ref.name) && typeof rs[i - 1].int === 'number') return rs[i - 1].int
    }
  }
  return 0
}

function findRegistration (spawnClassName, classes) {
  const hits = []
  for (const parsed of classes.values()) {
    for (const m of parsed.codes) {
      const rs = rows(m.code, parsed.cp)
      for (let i = 0; i < rs.length; i++) {
        if (rs[i].cls !== spawnClassName || (rs[i].op !== 0x12 && rs[i].op !== 0x13)) continue
        // the registration call: next invoke whose first parameter is Class
        let reg = null; let regAt = -1; let explicitIndex = null
        for (let j = i + 1; j < Math.min(rs.length, i + 6); j++) {
          const r = rs[j]
          if (typeof r.int === 'number' && reg === null) explicitIndex = r.int
          if (isInvoke(r) && paramTypes(r.ref.desc)[0] === 'Ljava/lang/Class;') { reg = r.ref; regAt = j; break }
        }
        if (!reg) continue
        const takesInt = paramTypes(reg.desc).includes('I')
        hits.push({ parsed, m, rs, at: i, reg, regAt, explicitIndex: takesInt ? explicitIndex : null })
      }
    }
  }
  if (hits.length === 0) return { error: 'spawn class never registered (no registrar ldc)' }
  if (hits.length > 1) return { error: `spawn class registered ${hits.length} times (ambiguous)` }
  const h = hits[0]
  // channel: same-method builder chain, else the receiver's static field initializer
  let channel = channelNameBefore(h.rs, h.at, classes)
  // the receiver: the nearest preceding static field OF THE CHANNEL TYPE in
  // the same method — fluent registrations chain `.add()` back into the
  // channel, so the origin getstatic may sit many rows up
  const receiver = channelReceiverBefore(h.rs, h.at, h.reg.owner)
  const receiverField = receiver && receiver.ref ? receiver.ref : null
  if (!channel && receiverField) channel = rlFromChannelField(receiverField, classes)
  if (!channel) return { error: 'channel name unresolved for the spawn registration' }
  // index
  let index = h.explicitIndex
  let indexDerivation = 'explicit'
  if (index === null || index === undefined) {
    if (!receiver) return { error: 'implicit message index with no attributable channel receiver (sequential counter unattributable)' }
    let prior = 0
    let found = false
    for (const m of h.parsed.codes) {
      if (found) break
      const rs = m === h.m ? h.rs : rows(m.code, h.parsed.cp)
      for (let j = 0; j < rs.length; j++) {
        if (m === h.m && j === h.regAt) { found = true; break }
        const r = rs[j]
        if (isInvoke(r) && r.ref.owner === h.reg.owner && r.ref.name === h.reg.name) {
          const recv = m === h.m ? channelReceiverBefore(rs, j, h.reg.owner) : null // a chain/local receiver is method-scoped; statics count across methods
          const sameStatic = receiverField && (() => { const q = channelReceiverBefore(rs, j, h.reg.owner); return q && q.ref && q.ref.owner === receiverField.owner && q.ref.name === receiverField.name })()
          if ((recv && recv.key === receiver.key) || (!recv && sameStatic)) prior++
        }
      }
    }
    if (!found) return { error: 'registration site not re-found while counting' }
    index = counterSeed(classes.get(h.reg.owner)) + prior
    indexDerivation = 'sequential'
  }
  return { channel, index, indexDerivation, channelClass: h.reg.owner, registrar: h.parsed.className, registrarMethod: h.m.method, receiver: receiver ? receiver.key : null }
}
// The channel RECEIVER a registration at `end` is invoked on, as a stable
// key within the method: a static channel field (`getstatic PLAY`), a local
// (`aload n`), or the origin of a fluent chain (`…simpleChannel()` — every
// `.add()` hands the channel back, so links of the channel/builder classes
// are walked through). Null when nothing attributable precedes the site.
function channelReceiverBefore (rs, end, channelClass) {
  const builder = `${channelClass}$MessageBuilder`
  for (let j = end - 1; j >= 0; j--) {
    const r = rs[j]
    if (isGetstatic(r)) { if (r.ref.desc === `L${channelClass};`) return { key: `static:${r.ref.owner}.${r.ref.name}`, ref: r.ref }; continue }
    if (isPutstatic(r) && r.ref.desc === `L${channelClass};`) return null // a different channel was just stored: chain boundary
    if (typeof r.load === 'number' && r.op >= 0x19 && r.op <= 0x2d && (r.op === 0x19 || r.op >= 0x2a)) {
      // aload n immediately feeding the chain: a local receiver
      if (j === end - 1 || rs.slice(j + 1, end).every((q) => q.cls || (isGetstatic(q) && q.ref.desc !== `L${channelClass};`))) return { key: `local:${r.load}` }
      continue
    }
    if (isInvoke(r)) {
      if (r.ref.owner === channelClass || r.ref.owner === builder) continue // chain link
      if (returnType(r.ref.desc) === `L${channelClass};`) return { key: `chain:${r.pc}` } // chain origin (builder.simpleChannel())
    }
  }
  return null
}
function rlFromChannelField (field, classes) {
  const owner = classes.get(field.owner)
  if (!owner) return null
  const clinit = owner.codes.find((c) => c.method === '<clinit>')
  if (!clinit) return null
  const rs = rows(clinit.code, owner.cp)
  const at = rs.findIndex((r) => isPutstatic(r) && r.ref.name === field.name && r.ref.owner === field.owner)
  if (at === -1) return null
  return channelNameBefore(rs, at, classes)
}

// --- 3. discriminator width ---------------------------------------------------

function discriminatorWidth (channelClassName, classes) {
  const start = classes.get(channelClassName)
  if (!start) return { error: 'channel class not in jar' }
  const pkg = channelClassName.slice(0, channelClassName.lastIndexOf('/'))
  const visit = [start]
  const seen = new Set([channelClassName])
  // classes the channel class references within its package tree (the codec)
  for (let i = 1; i < start.cp.length; i++) {
    const c = start.cp[i]
    if (!c || c.tag !== 7) continue
    const name = cpUtf8(start.cp, c.nameIndex)
    if (name && !seen.has(name) && name.startsWith(pkg.slice(0, pkg.lastIndexOf('/') + 1)) && classes.has(name)) { seen.add(name); visit.push(classes.get(name)) }
  }
  const widths = new Set()
  const where = []
  for (const parsed of visit) {
    for (const m of parsed.codes) {
      const rs = rows(m.code, parsed.cp)
      for (let i = 0; i < rs.length; i++) {
        const r = rs[i]
        if (!isInvoke(r)) continue
        const kind = classifyRead(r.ref)
        if (kind !== 'u8' && kind !== 'varint') continue
        for (let j = i + 1; j < Math.min(rs.length, i + 10); j++) {
          const q = rs[j]
          if (isInvoke(q) && /^(get|getOrDefault|containsKey)$/.test(q.ref.name) && /(Map|Int2Object|Short2Object|Byte2Object)/.test(q.ref.owner)) {
            widths.add(kind); where.push(`${parsed.className}.${m.method}`); break
          }
        }
      }
    }
  }
  if (widths.size === 0) return { error: 'discriminator read not found in the channel/codec classes' }
  if (widths.size > 1) return { error: `discriminator width ambiguous (${[...widths].join('/')})` }
  return { width: [...widths][0], where: where[0] }
}

// --- entry point -----------------------------------------------------------------

const cache = new Map()

/**
 * Derive the loader's custom-spawn codec from one loader universal jar.
 * @returns {{ok:true, kind:'spawn', channel, index, indexDerivation, indexWidth, fields, className, jar}
 *         | {ok:true, kind:'companion', className, fields, reason, jar}
 *         | {ok:false, reason, jar}}
 */
function deriveLoaderSpawnCodec (jarPath) {
  if (cache.has(jarPath)) return cache.get(jarPath)
  const out = deriveUncached(jarPath)
  cache.set(jarPath, out)
  return out
}

function deriveUncached (jarPath) {
  let buf
  try { buf = fs.readFileSync(jarPath) } catch (err) { return { ok: false, reason: `jar unreadable (${err.message})`, jar: jarPath, schema: DERIVATION_SCHEMA } }
  let entries
  try { entries = zipCentralEntries(buf) } catch (err) { return { ok: false, reason: `not a jar (${err.message})`, jar: jarPath, schema: DERIVATION_SCHEMA } }
  const classes = new Map()
  for (const e of entries) {
    if (!e.name.endsWith('.class') || !/\/network\//.test(e.name)) continue
    try {
      const parsed = parseClassFile(zipEntryData(buf, e))
      if (parsed) classes.set(parsed.className, parsed)
    } catch { /* unreadable class: not evidence */ }
  }
  if (classes.size === 0) return { ok: false, reason: 'no network classes in jar', jar: jarPath, schema: DERIVATION_SCHEMA }
  const candidates = []
  const rejected = []
  for (const parsed of classes.values()) {
    let c = analyzeSpawnCandidate(parsed)
    if (!c) { const comp = analyzeCompositeCandidate(parsed); c = comp && !comp.error ? classifyFields(comp) : comp }
    if (!c) continue
    if (c.error) { rejected.push(`${simpleName(c.className)}: ${c.error}`); continue }
    candidates.push(c)
  }
  const spawns = candidates.filter((c) => c.kind === 'spawn')
  const companions = candidates.filter((c) => c.kind === 'companion')
  if (spawns.length > 1) return { ok: false, reason: `ambiguous: ${spawns.length} spawn-shaped messages (${spawns.map((s) => simpleName(s.className)).join(', ')})`, jar: jarPath, schema: DERIVATION_SCHEMA }
  if (spawns.length === 0) {
    if (companions.length >= 1) {
      const c = companions[0]
      const reg = findRegistration(c.className, classes)
      return { ok: true, kind: 'companion', className: c.className, fields: c.fields, channel: reg.channel || payloadIdOf(classes.get(c.className), classes) || null, reason: 'loader payload carries entityId + custom bytes only — it rides NEXT TO vanilla spawn_entity, never instead of it; nothing to synthesize', jar: jarPath, schema: DERIVATION_SCHEMA }
    }
    return { ok: false, reason: `no spawn-shaped message class under /network/ (${classes.size} classes read${rejected.length ? `; rejected: ${rejected.slice(0, 3).join('; ')}` : ''})`, jar: jarPath, schema: DERIVATION_SCHEMA }
  }
  const s = spawns[0]
  const reg = findRegistration(s.className, classes)
  if (reg.error) return { ok: false, reason: `registration: ${reg.error}`, className: s.className, jar: jarPath, schema: DERIVATION_SCHEMA }
  const w = discriminatorWidth(reg.channelClass, classes)
  if (w.error) return { ok: false, reason: `index width: ${w.error}`, className: s.className, channel: reg.channel, index: reg.index, jar: jarPath, schema: DERIVATION_SCHEMA }
  const spec = {
    ok: true,
    kind: 'spawn',
    schema: DERIVATION_SCHEMA,
    jar: jarPath,
    className: s.className,
    channel: reg.channel,
    index: reg.index,
    indexDerivation: reg.indexDerivation,
    indexWidth: w.width,
    indexWidthSource: w.where,
    registrar: `${reg.registrar}.${reg.registrarMethod}`,
    fields: s.fields.map((f) => ({ kind: f.kind, role: f.role, field: f.field })),
    companion: companions.length ? companions[0].className : null
  }
  debug(`loader spawn codec derived from ${jarPath}: ${spec.channel}#${spec.index} (${spec.indexWidth} index, ${spec.indexDerivation}) fields ${spec.fields.map((f) => `${f.role || f.field || '?'}:${f.kind}`).join(' ')}`)
  return spec
}

module.exports = {
  deriveLoaderSpawnCodec,
  DERIVATION_SCHEMA,
  _internal: { analyzeSpawnCandidate, analyzeCompositeCandidate, payloadIdOf, findRegistration, discriminatorWidth, classifyRead, paramTypes, rows, roleOf, ROLE_NAMES, _cache: cache }
}
