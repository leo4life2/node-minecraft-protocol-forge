'use strict'

const fs = require('fs')
const path = require('path')
const debug = require('debug')('minecraft-protocol-forge')
const { zipCentralEntries, zipEntryData, parseClassFile, readAnnotationsAttr, decodeInstructions } = require('./jarAnalysis')

// HF35 r2 — jar-derived ItemStack WIRE-SHAPE extensions.
//
// A mod may mixin into the buffer's item (de)serializer and add bytes to every
// item stack on the wire (stacc-api, nested in numismatic-overhaul, writes the
// stack count a second time as an int32 before the nbt so stacks above 127
// survive; it reads the same int back). The vanilla protocol then misreads
// EVERY slot-bearing packet in both directions: our vanilla-shaped
// set_creative_slot is kicked at the server's decoder ("readerIndex(6) +
// length(4) exceeds writerIndex(7)") and the server's window_items is
// unparseable here. This module DERIVES the extension from the jars the way
// the owo handshake and block shapes are derived — mixin annotations +
// bytecode are class-file DATA read locally, never loaded or run — and hands a
// declarative spec to itemStackWireInstall, which compiles the extended slot
// type into this client's play protocol. No shape is recalled: no mixin on the
// item (de)serializer means no extension; a mixin whose shape cannot be read
// or whose read and write halves disagree is an honest ABSTAIN naming the
// class and jar (the caller says so; the join is not blamed on the account).
//
// Recognised handler shape (data-driven, pairing-checked):
//   write: an injector on writeItemStack/writeItem placed at INVOKE writeNbt
//          (before the nbt) or RETURN/TAIL (after it) or HEAD, whose body
//          calls a fixed sequence of primitive buffer writes;
//   read:  a @ModifyArg on the ItemStack constructor's int (count) argument
//          in readItemStack/readItem whose body reads one primitive — that
//          primitive IS the count (source 'count'); or an @Inject on
//          readItemStack at the same anchor reading the same primitives.
// The write field list and the read field list must agree type-for-type and
// position-for-position; a lone i32 count read pins the write field's source.
//
// HF34 (family 2 of the same mechanism): a mod that @Injects into
// readItem/writeItem at RETURN/TAIL/HEAD and reads/writes primitives AROUND
// the stack (a trailing boolean after every present stack is the field shape:
// the vanilla-shaped click is then kicked at the server's decoder,
// "readerIndex(N) + length(1) exceeds writerIndex(N)"). The two sides are
// independent (a readItem mixin shapes what the SERVER reads = serverbound;
// a writeItem mixin shapes what it writes = clientbound); the placement is
// derived per injector from @At against the codec's return structure AND the
// injector's own presence guard (ItemStack.isEmpty() / == ItemStack.EMPTY on
// the codec's own stack: cir.getReturnValue() or the captured ItemStack
// parameter, directly or through a once-assigned local); the width is the
// COUNT of primitive reads under that one condition (two readBoolean() = two
// bytes), never assumed. Anything else — a guard on a foreign stack, primitives
// under different conditions, a shifted/sliced/INVOKE injection point, a
// cancellable injector, a lambda, a loop, an unmodelled buffer call, several
// injectors on one side — is an honest ABSTAIN (the caller refuses the
// container click with that reason instead of sending the kicking bytes).
// Trailer values are mod data this client cannot know: it sends the zero value
// (false / 0) and keeps what it reads on the parsed item.

const MIXIN_ANN = 'Lorg/spongepowered/asm/mixin/Mixin;'
const INJECTOR_RE = /^L(?:org\/spongepowered\/asm\/mixin\/injection|com\/llamalad7\/mixinextras\/injector(?:\/v1)?)\/([A-Za-z]+);$/
// SRG names (Forge 1.17-1.20.x stable obfuscation; javap of the 47.3.22
// FriendlyByteBuf): m_130267_ readItem, m_130055_ writeItem, m_130079_ writeNbt,
// m_130260_/m_130261_ readNbt/readAnySizeNbt, m_130242_ readVarInt,
// m_130130_ writeVarInt, m_130258_ readVarLong, m_130103_ writeVarLong.
const WRITE_ITEM_RE = /^(?:writeItemStack|writeItem|m_130055_)(?:\(|$)/
const READ_ITEM_RE = /^(?:readItemStack|readItem|m_130267_)(?:\(|$)/
const NBT_TARGET_RE = /;(?:writeNbt|readNbt|writeCompoundTag|readCompoundTag|writeCompoundNbt|readCompoundNbt|m_130079_|m_130260_|m_130261_)\(/
// the container-click packet itself (a mixin on its ctor/write reshapes the click; not derivable here)
const CLICK_PACKET_RE = /(?:ServerboundContainerClickPacket|ClickSlotC2SPacket|class_2813);?$/
const ITEMSTACK_OWNER_RE = /(?:^|\/)(?:ItemStack|class_1799)$/
const IS_EMPTY = ['isEmpty', 'm_41619_', 'method_7960']
const EMPTY_FIELD = ['EMPTY', 'f_41583_', 'field_8037']
const CALLBACK_INFO_RE = /^L?org\/spongepowered\/asm\/mixin\/injection\/callback\/CallbackInfo(?:Returnable)?;?$/
const BUFFER_OWNER_RE = /(?:^|\/)(?:FriendlyByteBuf|PacketByteBuf|class_2540|ByteBuf|AbstractByteBuf)$/
const JVM_RETURN_OPS = new Set([0xac, 0xad, 0xae, 0xaf, 0xb0, 0xb1, 0xbf]) // ireturn..return, athrow
const BRANCH_ALL = ['absent', 'present']
// buffer calls that never move the wire
const BENIGN_BUFFER_CALLS = new Set(['readableBytes', 'writableBytes', 'isReadable', 'isWritable', 'readerIndex', 'writerIndex', 'markReaderIndex', 'resetReaderIndex', 'markWriterIndex', 'resetWriterIndex', 'capacity', 'maxCapacity', 'ensureWritable'])
// The vanilla codec's return structure (1.13+ FriendlyByteBuf): readItem has
// two returns in order (EMPTY when the presence flag is false, then the read
// stack); writeItem has one return (after both branches).
const CODEC_RETURNS = { read: [['absent'], ['present']], write: [['absent', 'present']] }
const ITEMSTACK_CTOR_RE = /(?:item\/ItemStack|world\/item\/ItemStack|class_1799);<init>\(/

// buffer primitive name/descriptor -> protodef type (netty ByteBuf + the
// Minecraft varint helpers; owner-agnostic because mixins call them through a
// @Shadow on the mixin class itself)
const WRITE_PRIMS = {
  'writeInt:(I)': 'i32',
  'writeShort:(I)': 'i16',
  'writeByte:(I)': 'i8',
  'writeLong:(J)': 'i64',
  'writeFloat:(F)': 'f32',
  'writeDouble:(D)': 'f64',
  'writeBoolean:(Z)': 'bool',
  'writeVarInt:(I)': 'varint',
  'method_10804:(I)': 'varint',
  'writeVarLong:(J)': 'varlong',
  'method_10791:(J)': 'varlong',
  'm_130130_:(I)': 'varint',
  'm_130103_:(J)': 'varlong'
}
const READ_PRIMS = {
  'readInt:()I': 'i32',
  'readShort:()S': 'i16',
  'readByte:()B': 'i8',
  'readLong:()J': 'i64',
  'readFloat:()F': 'f32',
  'readDouble:()D': 'f64',
  'readBoolean:()Z': 'bool',
  'readVarInt:()I': 'varint',
  'method_10816:()I': 'varint',
  'readVarLong:()J': 'varlong',
  'method_10792:()J': 'varlong',
  'm_130242_:()I': 'varint',
  'm_130258_:()J': 'varlong'
}

function readJar (jarPath) {
  return fs.readFileSync(jarPath)
}

// refmap: yarn keys -> intermediary members, so a jar whose injector names
// its target by intermediary (method_10793/method_10819) is matched from the
// jar's OWN mapping table, never from recall.
function refmapAliases (entries, buf) {
  const write = new Set(); const read = new Set()
  for (const e of entries) {
    if (!/refmap.*\.json$/i.test(e.name)) continue
    let json
    try { json = JSON.parse(zipEntryData(buf, e).toString('utf8')) } catch { continue }
    const tables = [json.mappings || {}, ...Object.values(json.data || {})]
    for (const table of tables) {
      for (const cls of Object.values(table)) {
        for (const [k, v] of Object.entries(cls || {})) {
          const m = String(v).match(/;(method_\d+|\w+)\(/)
          if (!m) continue
          if (WRITE_ITEM_RE.test(k)) write.add(m[1])
          if (READ_ITEM_RE.test(k)) read.add(m[1])
        }
      }
    }
  }
  return { write, read }
}

function methodNames (elements) {
  const v = elements.method
  const arr = Array.isArray(v) ? v : (v == null ? [] : [v])
  return arr.filter((s) => typeof s === 'string').map((s) => s.replace(/^L[^;]+;/, ''))
}

function anchorOf (elements) {
  const at = Array.isArray(elements.at) ? elements.at[0] : elements.at
  if (!at || typeof at !== 'object') return { anchor: null }
  const value = String(at.elements?.value || '')
  const target = String(at.elements?.target || '')
  if (value === 'INVOKE' && NBT_TARGET_RE.test(target)) return { anchor: 'beforeNbt', value, target }
  if (value === 'INVOKE' && ITEMSTACK_CTOR_RE.test(target)) return { anchor: 'beforeNbt', value, target } // ctor runs after the count, before the nbt
  if (value === 'RETURN' || value === 'TAIL') return { anchor: 'afterNbt', value, target }
  if (value === 'HEAD') return { anchor: 'head', value, target }
  return { anchor: null, value, target }
}

function primsIn (parsed, methodName, methodDesc, table) {
  const code = parsed.codes.find((c) => c.method === methodName && c.desc === methodDesc)
  if (!code) return null
  const out = []
  for (const row of decodeInstructions(code.code, parsed.cp)) {
    if ((row.op === 0xb6 || row.op === 0xb7 || row.op === 0xb9 || row.op === 0xb8) && row.ref) {
      const key = `${row.ref.name}:${row.ref.desc}`
      const hit = Object.keys(table).find((k) => key.startsWith(k))
      if (hit) out.push(table[hit])
    }
  }
  return out
}

// ---------------------------------------------------------------- family 2
// (HF34) per-injector trailer analysis: the primitives an @Inject on
// readItem/writeItem reads/writes around the stack, where they fire, and the
// condition they fire under. Every verdict below is a class-file fact.

function refMatches (ref, ownerRe, names) { return !!ref && ownerRe.test(ref.owner || '') && names.includes(ref.name) }
function annList (a) { return Array.isArray(a) ? a : (a == null ? [] : [a]) }

// Walk the injector body (and its private helpers, two levels) collecting the
// buffer primitives in call order. Buffer calls outside the table are an
// honest stop (an unmodelled read/write cannot be sized), as are lambdas,
// switches and branching helpers.
function walkInjectorBody (parsed, codeEntry, depth, out, table) {
  const rows = decodeInstructions(codeEntry.code, parsed.cp)
  for (const row of rows) {
    const op = row.op
    if (op === 0xba) { out.stop = out.stop || 'the injector invokes a lambda (invokedynamic)'; continue }
    if (op === 0xaa || op === 0xab) { out.stop = out.stop || 'the injector switches on a value'; continue }
    if (row.target !== undefined && depth > 0 && op !== 0xa7) { out.stop = out.stop || 'a helper called from the injector branches'; continue }
    if (op !== 0xb6 && op !== 0xb9 && op !== 0xb7 && op !== 0xb8) continue
    const ref = row.ref
    if (!ref) continue
    if (CALLBACK_INFO_RE.test(ref.owner) && (ref.name === 'setReturnValue' || ref.name === 'cancel')) { out.stop = out.stop || 'the injector cancels or replaces the codec result'; continue }
    const key = `${ref.name}:${ref.desc}`
    const hit = Object.keys(table).find((k) => key.startsWith(k))
    const pc = depth === 0 ? row.pc : out.sitePc
    if (hit) { out.calls.push({ pc, name: ref.name, type: table[hit] }); continue }
    if (BUFFER_OWNER_RE.test(ref.owner)) {
      // any other call on the buffer may move the wire by an unmodelled amount (keep-when-uncertain)
      if (!BENIGN_BUFFER_CALLS.has(ref.name)) { out.stop = out.stop || `the injector calls an unmodelled buffer method ${ref.name}${ref.desc}`; continue }
      continue
    }
    if (ref.owner === parsed.className) {
      const helper = parsed.codes.find((c) => c.method === ref.name && c.desc === ref.desc)
      if (!helper) continue // @Shadow (no body) that is not a primitive: nothing on the wire
      if (depth >= 2) { out.stop = out.stop || 'helper nesting deeper than two levels'; continue }
      const prev = out.sitePc; out.sitePc = pc
      walkInjectorBody(parsed, helper, depth + 1, out, table)
      out.sitePc = prev
    }
  }
  return rows
}

// The injector's parameter slots by type: its CallbackInfo(Returnable)s and
// the ItemStack argument(s) captured from the codec (long/double take two).
function paramSlotsOf (desc, isStatic) {
  const slots = { callback: new Set(), item: new Set() }
  const m = (desc || '').match(/^\(([^)]*)\)/)
  if (!m) return slots
  const str = m[1]; let i = 0; let slot = isStatic ? 0 : 1
  while (i < str.length) {
    const start = i
    while (str[i] === '[') i++
    let type
    if (str[i] === 'L') { const e = str.indexOf(';', i); if (e < 0) break; type = str.slice(start, e + 1); i = e + 1 } else { type = str.slice(start, i + 1); i++ }
    if (/^L[^;]*(?:\/ItemStack|class_1799);$/.test(type)) slots.item.add(slot)
    else if (CALLBACK_INFO_RE.test(type)) slots.callback.add(slot)
    slot += (type === 'J' || type === 'D') ? 2 : 1
  }
  return slots
}

// A presence guard is a wire fact ONLY when the stack it inspects is the
// codec's own: cir.getReturnValue() on the injector's CallbackInfoReturnable
// parameter (readItem) or the captured ItemStack parameter (writeItem),
// directly or through a local assigned exactly once from either (through a
// checkcast). Returns the index of the operand's first row, or -1 for
// anything else (ItemStack.EMPTY itself, a field, a fresh read, a reassigned
// local): those say nothing about the stack on the wire.
function stackOperandStart (rows, idx, slots) {
  let i = idx
  if (i >= 0 && rows[i].op === 0xc0) i-- // checkcast
  if (i < 0) return -1
  const r = rows[i]
  const neverStored = (n) => !rows.some((x) => x.astore === n)
  if ((r.op === 0xb9 || r.op === 0xb6) && r.ref && CALLBACK_INFO_RE.test(r.ref.owner) && r.ref.name === 'getReturnValue') {
    const p = rows[i - 1]
    return p && p.aload !== undefined && slots.callback.has(p.aload) && neverStored(p.aload) ? i - 1 : -1
  }
  if (r.aload !== undefined) {
    if (slots.item.has(r.aload)) return neverStored(r.aload) ? i : -1
    const stores = []
    rows.forEach((x, j) => { if (x.astore === r.aload) stores.push(j) })
    if (stores.length !== 1 || stores[0] >= i) return -1
    return stackOperandStart(rows, stores[0] - 1, slots) >= 0 ? i : -1
  }
  return -1
}

// The condition set each primitive call fires under, from the injector's OWN
// conditional jumps: the only conditions accepted are the stack's presence
// (isEmpty() / == EMPTY on the codec's own stack) and null checks (which say
// nothing about presence). A guard at pc G jumping to T: a call inside
// (G, T) runs on the fall-through condition; a call at/after T runs on the
// jump condition when the region exits (return/throw/goto elsewhere) or, for
// an if/else, inside the else-region; otherwise the guard does not constrain
// it. Any other conditional jump, backward jump or switch => not derivable.
function conditionSetsOf (rows, calls, slots) {
  const guards = []
  const NOT_OWN = 'the presence guard reads a stack other than the one on the wire'
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (r.target === undefined || r.op === 0xa7 || r.op === 0xc8 || r.op === 0xa8 || r.op === 0xc9) continue
    if (r.op === 0xc6 || r.op === 0xc7) continue // ifnull / ifnonnull
    if (r.target <= r.pc) return { stop: 'the injector loops' }
    const prev = rows[i - 1]
    let fall = null
    if ((r.op === 0x99 || r.op === 0x9a) && prev && (prev.op === 0xb6 || prev.op === 0xb9) && refMatches(prev.ref, ITEMSTACK_OWNER_RE, IS_EMPTY)) {
      if (stackOperandStart(rows, i - 2, slots) < 0) return { stop: NOT_OWN }
      fall = r.op === 0x99 ? 'absent' : 'present' // ifeq falls when isEmpty()==true; ifne when false
    } else if (r.op === 0xa5 || r.op === 0xa6) {
      // == / != ItemStack.EMPTY: the OTHER operand must be the codec's own stack
      let own = false
      if (prev && prev.op === 0xb2 && refMatches(prev.ref, ITEMSTACK_OWNER_RE, EMPTY_FIELD)) own = stackOperandStart(rows, i - 2, slots) >= 0
      else { const st = stackOperandStart(rows, i - 1, slots); const g = st > 0 ? rows[st - 1] : null; own = st >= 0 && !!g && g.op === 0xb2 && refMatches(g.ref, ITEMSTACK_OWNER_RE, EMPTY_FIELD) }
      if (!own) return { stop: NOT_OWN }
      fall = r.op === 0xa5 ? 'present' : 'absent' // if_acmpeq jumps when == EMPTY (falls when present)
    } else {
      return { stop: 'the injector is conditional on something other than the stack\'s presence' }
    }
    const region = rows.filter((x) => x.pc > r.pc && x.pc < r.target)
    const last = region[region.length - 1]
    const exits = !!last && (JVM_RETURN_OPS.has(last.op) || ((last.op === 0xa7 || last.op === 0xc8) && last.target !== r.target))
    const elseEnd = last && (last.op === 0xa7 || last.op === 0xc8) && last.target > r.target ? last.target : null
    guards.push({ pc: r.pc, target: r.target, fall, jump: fall === 'absent' ? 'present' : 'absent', exits, elseEnd })
  }
  const sets = calls.map((c) => {
    let set = new Set(BRANCH_ALL)
    for (const g of guards) {
      let cond = null
      if (c.pc > g.pc && c.pc < g.target) cond = g.fall
      else if (c.pc >= g.target) cond = g.elseEnd !== null ? (c.pc < g.elseEnd ? g.jump : null) : (g.exits ? g.jump : null)
      if (cond) set = new Set([...set].filter((b) => b === cond))
    }
    return set
  })
  return { sets, guarded: guards.length > 0 }
}

// Where the injector fires inside the codec, from @At against the codec's
// return structure.
function firingSetOf (at, side) {
  if (!at || typeof at !== 'object' || !at.elements) return { stop: 'the injection point is unreadable' }
  const el = at.elements
  const value = typeof el.value === 'string' ? el.value : null
  if (el.shift && !(typeof el.shift === 'object' && el.shift.constName === 'NONE')) return { stop: `the injection point is shifted (${(el.shift && el.shift.constName) || '?'})` }
  if (el.slice) return { stop: 'the injection point is sliced' }
  const ordinal = typeof el.ordinal === 'number' ? el.ordinal : -1
  const returns = CODEC_RETURNS[side]
  if (value === 'HEAD') return { before: true, after: new Set() }
  if (value === 'TAIL') return { before: false, after: new Set(returns[returns.length - 1]) }
  if (value === 'RETURN') {
    if (ordinal < 0) return { before: false, after: new Set(returns.flat()) }
    if (ordinal >= returns.length) return { stop: `RETURN ordinal ${ordinal} does not exist in the codec method` }
    return { before: false, after: new Set(returns[ordinal]) }
  }
  return { stop: `injection point ${value || '?'} is not derivable as a trailer` }
}

// One @Inject on readItem/writeItem -> { placement, types, at } | { stop }.
function analyzeTrailer (parsed, m, el, side, targetNames = []) {
  const foreign = targetNames.filter((n) => !(WRITE_ITEM_RE.test(n) || READ_ITEM_RE.test(n)))
  if (foreign.length) return { stop: `the injector also targets ${foreign.join(', ')} (a codec other than the item's: its bytes are not derivable)` }
  if (el.cancellable === true) return { stop: 'the injector is cancellable (it may replace the codec method)' }
  const ats = annList(el.at)
  if (ats.length !== 1) return { stop: ats.length === 0 ? 'the injector has no @At' : 'the injector has several injection points' }
  const code = parsed.codes.find((c) => c.method === m.name && c.desc === m.desc)
  if (!code) return { stop: 'the injector has no body' }
  const walk = { calls: [], stop: null, sitePc: 0 }
  const rows = walkInjectorBody(parsed, code, 0, walk, side === 'write' ? WRITE_PRIMS : READ_PRIMS)
  if (walk.stop) return { stop: walk.stop }
  if (!walk.calls.length) return { stop: 'the injector touches the codec without a readable primitive' }
  const fire = firingSetOf(ats[0], side)
  if (fire.stop) return { stop: fire.stop }
  const conds = conditionSetsOf(rows, walk.calls, paramSlotsOf(m.desc, ((m.flags || 0) & 0x0008) !== 0))
  if (conds.stop) return { stop: conds.stop }
  if (fire.before && conds.guarded) return { stop: 'a presence guard at HEAD is not derivable (the flag is not on the wire yet)' }
  const keys = new Set(conds.sets.map((st) => [...st].sort().join('+')))
  if (keys.size > 1) return { stop: 'the injector\'s primitives fire under different conditions' }
  const cond = conds.sets[0] || new Set(BRANCH_ALL)
  const after = new Set([...fire.after].filter((b) => cond.has(b)))
  const placement = { before: !!fire.before, onAbsent: after.has('absent'), onPresent: after.has('present') }
  if (!placement.before && !placement.onAbsent && !placement.onPresent) return { stop: 'the injector never fires on the wire (guard and injection point exclude each other)' }
  return { placement, types: walk.calls.map((c) => c.type), at: { value: ats[0].elements.value, ordinal: typeof ats[0].elements.ordinal === 'number' ? ats[0].elements.ordinal : -1 } }
}

// placement -> the slot anchor the installer splices at
function trailerAnchor (placement) {
  if (placement.before) return 'head'
  if (placement.onAbsent && placement.onPresent) return 'tail'
  if (placement.onPresent) return 'presentTail'
  return 'absentTail'
}

function describePlacement (placement) {
  if (!placement) return 'at a derived position'
  if (placement.before) return 'before the presence flag'
  if (placement.onAbsent && placement.onPresent) return 'after every stack (present or not)'
  if (placement.onPresent) return 'after every present stack'
  return 'after every absent stack'
}

// One class -> the injections it declares on the item (de)serializer.
function scanClass (parsed, aliases, source) {
  if (!parsed) return null
  // @Mixin has CLASS retention (RuntimeInvisibleAnnotations); injectors are
  // RUNTIME (RuntimeVisibleAnnotations) — both tables are read for both levels.
  const annsAt = (...offsets) => {
    const out = []
    for (const at of offsets) {
      if (at == null) continue
      try { out.push(...readAnnotationsAttr(parsed.bytes, at, parsed.cp, { rich: true })) } catch { /* malformed table: tolerated */ }
    }
    return out
  }
  const mixin = annsAt(parsed.classInvisibleAnnotationsAt, parsed.classAnnotationsAt).find((a) => a.type === MIXIN_ANN)
  if (!mixin) return null
  const targets = [].concat(mixin.elements.value || [], mixin.elements.targets || []).filter((t) => typeof t === 'string')
  const found = { writes: [], reads: [], clicks: [], className: parsed.className, targets, source }
  const onClickPacket = targets.some((t) => CLICK_PACKET_RE.test(t))
  for (const m of parsed.methods) {
    for (const a of annsAt(m.annotationsAt, m.invisibleAnnotationsAt)) {
      const inj = String(a.type).match(INJECTOR_RE)
      if (!inj) continue
      const names = methodNames(a.elements)
      if (onClickPacket) { found.clicks.push({ injector: inj[1], handler: m.name, desc: m.desc, targetMethods: names }); continue }
      const isWrite = names.some((n) => WRITE_ITEM_RE.test(n) || aliases.write.has(n.replace(/\(.*$/, '')))
      const isRead = names.some((n) => READ_ITEM_RE.test(n) || aliases.read.has(n.replace(/\(.*$/, '')))
      if (!isWrite && !isRead) continue
      const { anchor, value, target } = anchorOf(a.elements)
      const row = { injector: inj[1], handler: m.name, desc: m.desc, anchor, at: value, target, targetMethods: names, cancellable: a.elements.cancellable === true }
      if (isWrite) found.writes.push({ ...row, fields: primsIn(parsed, m.name, m.desc, WRITE_PRIMS), trailer: analyzeTrailer(parsed, m, a.elements, 'write', names) })
      if (isRead) found.reads.push({ ...row, fields: primsIn(parsed, m.name, m.desc, READ_PRIMS), trailer: analyzeTrailer(parsed, m, a.elements, 'read', names) })
    }
  }
  return found.writes.length || found.reads.length || found.clicks.length ? found : null
}

function scanJar (buf, source, out, depth) {
  const entries = zipCentralEntries(buf)
  const aliases = refmapAliases(entries, buf)
  for (const entry of entries) {
    if (entry.name.endsWith('.jar') && entry.name.startsWith('META-INF/jars/') && depth < 2) {
      try { scanJar(zipEntryData(buf, entry), { jarPath: source.jarPath, nested: entry.name }, out, depth + 1) } catch (err) { debug(`item-wire scan: unreadable nested jar ${entry.name} in ${source.jarPath} (${err.message})`) }
      continue
    }
    if (!entry.name.endsWith('.class')) continue
    let parsed
    try { parsed = parseClassFile(zipEntryData(buf, entry)) } catch { continue }
    const found = scanClass(parsed, aliases, source)
    if (found) out.push(found)
  }
}

function listJars (paths) {
  const jars = []
  for (const p of paths || []) {
    try {
      const st = fs.statSync(p)
      if (st.isDirectory()) jars.push(...fs.readdirSync(p).filter((f) => f.endsWith('.jar')).map((f) => path.join(p, f)))
      else if (p.endsWith('.jar')) jars.push(p)
    } catch (err) { debug(`item-wire scan: skipping ${p} (${err.message})`) }
  }
  return jars
}

// Pairing law -> the declarative spec, or an abstain naming what stopped it.
function deriveSpec (mixins) {
  const writes = mixins.flatMap((m) => m.writes.map((w) => ({ ...w, className: m.className, source: m.source })))
  const reads = mixins.flatMap((m) => (m.reads || []).map((r) => ({ ...r, className: m.className, source: m.source })))
  const clicks = mixins.flatMap((m) => (m.clicks || []).map((c) => ({ ...c, className: m.className, source: m.source })))
  if (!writes.length && !reads.length && !clicks.length) return { ext: null }
  const where = (r) => `${r.className} in ${path.basename(r.source.jarPath)}${r.source.nested ? ` (nested ${r.source.nested})` : ''}`
  // serverbound: true when a read-side (server decoder) mixin exists — a vanilla-shaped click would then be kicked
  const abstain = (reason, detail, rows) => ({ ext: null, abstain: { reason, detail, mixins: rows.map(where), serverbound: reads.length > 0 || clicks.length > 0, clientbound: writes.length > 0 } })
  if (clicks.length) return abstain('click-packet-mixin', `the container-click packet itself is mixed in (${clicks.map((c) => `${c.handler} on ${c.targetMethods.join(',') || '?'}`).join('; ')}): its wire shape is not derivable`, clicks)
  // family dispatch: a @ModifyArg or an INVOKE-anchored (before-nbt) injection is the paired count family (HF35);
  // injections at RETURN/TAIL/HEAD only are the trailer family (HF34)
  const countFamily = [...writes, ...reads].some((r) => r.injector === 'ModifyArg' || r.anchor === 'beforeNbt')
  if (!countFamily) return deriveTrailerSpec(writes, reads, where, abstain)
  if (writes.length !== 1 || reads.length !== 1) return abstain('multiple-item-wire-mixins', `${writes.length} write-side and ${reads.length} read-side item (de)serializer injections — their order on the wire is not derivable`, writes.concat(reads))
  const [w] = writes; const [r] = reads
  if (!w.anchor || !r.anchor) return abstain('unknown-anchor', `injection point not understood (write at ${w.at || '?'} ${w.target || ''}; read at ${r.at || '?'} ${r.target || ''})`, [w, r])
  if (w.anchor !== r.anchor) return abstain('anchor-mismatch', `write side extends ${w.anchor}, read side ${r.anchor}`, [w, r])
  if (!w.fields || !r.fields || !w.fields.length || !r.fields.length) return abstain('no-primitives', 'the injection bodies write/read no buffer primitive this walk recognises', [w, r])
  if (w.fields.join(',') !== r.fields.join(',')) return abstain('field-mismatch', `write side [${w.fields.join(',')}] vs read side [${r.fields.join(',')}]`, [w, r])
  // sources: the read-side @ModifyArg on the ItemStack ctor int returning the
  // one primitive it reads pins that field as the stack count
  const countPinned = r.injector === 'ModifyArg' && ITEMSTACK_CTOR_RE.test(r.target) && /\(I\)I$/.test(r.desc) && r.fields.length === 1
  const fields = w.fields.map((type, i) => ({ name: `itemStackWire${i}`, type, source: countPinned ? 'count' : 'unknown' }))
  if (fields.some((f) => f.source === 'unknown')) return abstain('unknown-field-source', `the extension's ${fields.map((f) => f.type).join(',')} value(s) cannot be produced from an item this client holds`, [w, r])
  return {
    ext: { anchor: w.anchor, fields, mixin: { className: w.className, jar: path.basename(w.source.jarPath), nested: w.source.nested || null, write: w.handler, read: r.handler } }
  }
}

// Family 2 (HF34): independent sides; one injector per side; the placement,
// width and types come from analyzeTrailer. Values are unknowable mod data ->
// source 'trailer' (sent as zero, kept when read).
function deriveTrailerSpec (writes, reads, where, abstain) {
  const sideOf = (rows, label) => {
    if (!rows.length) return { layout: null }
    if (rows.length > 1) return { stop: abstain('multiple-item-wire-mixins', `${rows.length} ${label} trailer injectors on the item codec (their order on the wire is not derivable)`, rows) }
    const [r] = rows
    if (r.injector !== 'Inject') return { stop: abstain('trailer-not-derivable', `@${r.injector} on the ItemStack codec is not derivable`, rows) }
    if (!r.trailer || r.trailer.stop) return { stop: abstain('trailer-not-derivable', r.trailer ? r.trailer.stop : 'no trailer analysis', rows) }
    const anchor = trailerAnchor(r.trailer.placement)
    const scope = anchor === 'presentTail' ? 'present' : anchor === 'absentTail' ? 'absent' : 'slot'
    const fields = r.trailer.types.map((type, i) => ({ name: `itemStackWire${i}`, type, source: 'trailer', scope }))
    return { layout: { anchor, placement: r.trailer.placement, width: fields.length, fields, at: r.trailer.at, mixin: { className: r.className, jar: path.basename(r.source.jarPath), nested: r.source.nested || null, handler: r.handler, target: r.targetMethods.join(',') } } }
  }
  const sb = sideOf(reads, 'read-side (serverbound)'); if (sb.stop) return sb.stop
  const cb = sideOf(writes, 'write-side (clientbound)'); if (cb.stop) return cb.stop
  const primary = (sb.layout || cb.layout).mixin
  return { ext: { family: 'trailer', serverbound: sb.layout, clientbound: cb.layout, mixin: primary } }
}

// The side-specific layout an installer compiles for one direction: family 1
// specs apply to both directions unchanged; family 2 carries one per side.
function sideLayout (ext, direction) {
  if (!ext) return null
  if (ext.family !== 'trailer') return ext
  return direction === 'toServer' ? ext.serverbound : ext.clientbound
}

// paths: mods folders and/or jar files. Returns { ext, abstain, jars, mixins }.
function scanItemStackWireExtensions (paths) {
  const jars = listJars(paths)
  const mixins = []
  for (const jarPath of jars) {
    try { scanJar(readJar(jarPath), { jarPath }, mixins, 0) } catch (err) { debug(`item-wire scan: unreadable jar ${jarPath} (${err.message})`) }
  }
  const spec = deriveSpec(mixins)
  return { ...spec, jars: jars.length, mixins: mixins.map((m) => ({ className: m.className, jar: path.basename(m.source.jarPath), nested: m.source.nested || null, writes: m.writes.length, reads: m.reads.length, clicks: (m.clicks || []).length })) }
}

// The vanilla `slot` protodef type with the extension spliced in at its
// anchor. Data-driven off minecraft-data's own definition: the field carrying
// the nbt is located by name; a version whose slot has no nbt field (1.20.5+
// components) cannot host an nbt-anchored extension -> null (caller abstains).
function extendSlotType (slotType, ext) {
  const clone = JSON.parse(JSON.stringify(slotType))
  const visit = (node) => {
    if (Array.isArray(node) && node[0] === 'container' && Array.isArray(node[1])) {
      const fields = node[1]
      const nbtIdx = fields.findIndex((f) => f && /^nbt/i.test(f.name || ''))
      if (nbtIdx >= 0 && ext.anchor !== 'head') {
        const add = ext.fields.map((f) => ({ name: f.name, type: f.type }))
        fields.splice(ext.anchor === 'beforeNbt' ? nbtIdx : nbtIdx + 1, 0, ...add)
        return true
      }
      if (ext.anchor === 'head' && fields.some((f) => f && f.name === 'present')) {
        fields.unshift(...ext.fields.map((f) => ({ name: f.name, type: f.type })))
        return true
      }
      // family 2 anchors, against the slot's own presence switch (data-driven)
      if (['tail', 'presentTail', 'absentTail'].includes(ext.anchor) && fields.some((f) => f && f.name === 'present')) {
        const add = ext.fields.map((f) => ({ name: f.name, type: f.type }))
        const sw = fields.find((f) => f && Array.isArray(f.type) && f.type[0] === 'switch' && f.type[1] && f.type[1].compareTo === 'present')
        if (!sw) return false
        const branches = sw.type[1].fields || {}
        if (ext.anchor === 'tail') { fields.push(...add); return true }
        if (ext.anchor === 'presentTail') {
          const t = branches.true
          if (!Array.isArray(t) || t[0] !== 'container' || !Array.isArray(t[1])) return false
          t[1].push(...add); return true
        }
        if (branches.false !== 'void') return false
        branches.false = ['container', add]; return true
      }
      for (const f of fields) if (f && f.type && visit(f.type)) return true
      return false
    }
    if (Array.isArray(node) && node[0] === 'switch' && node[1] && node[1].fields) {
      for (const k of Object.keys(node[1].fields)) if (visit(node[1].fields[k])) return true
    }
    return false
  }
  return visit(clone) ? clone : null
}

module.exports = { scanItemStackWireExtensions, extendSlotType, sideLayout, describePlacement, trailerAnchor, WRITE_PRIMS, READ_PRIMS }
