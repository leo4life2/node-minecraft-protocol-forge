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

const MIXIN_ANN = 'Lorg/spongepowered/asm/mixin/Mixin;'
const INJECTOR_RE = /^L(?:org\/spongepowered\/asm\/mixin\/injection|com\/llamalad7\/mixinextras\/injector(?:\/v1)?)\/([A-Za-z]+);$/
const WRITE_ITEM_RE = /^(?:writeItemStack|writeItem)(?:\(|$)/
const READ_ITEM_RE = /^(?:readItemStack|readItem)(?:\(|$)/
const NBT_TARGET_RE = /;(?:writeNbt|readNbt|writeCompoundTag|readCompoundTag|writeCompoundNbt|readCompoundNbt)\(/
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
  'method_10791:(J)': 'varlong'
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
  'method_10792:()J': 'varlong'
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
  const found = { writes: [], reads: [], className: parsed.className, targets, source }
  for (const m of parsed.methods) {
    for (const a of annsAt(m.annotationsAt, m.invisibleAnnotationsAt)) {
      const inj = String(a.type).match(INJECTOR_RE)
      if (!inj) continue
      const names = methodNames(a.elements)
      const isWrite = names.some((n) => WRITE_ITEM_RE.test(n) || aliases.write.has(n.replace(/\(.*$/, '')))
      const isRead = names.some((n) => READ_ITEM_RE.test(n) || aliases.read.has(n.replace(/\(.*$/, '')))
      if (!isWrite && !isRead) continue
      const { anchor, value, target } = anchorOf(a.elements)
      const row = { injector: inj[1], handler: m.name, desc: m.desc, anchor, at: value, target, targetMethods: names }
      if (isWrite) found.writes.push({ ...row, fields: primsIn(parsed, m.name, m.desc, WRITE_PRIMS) })
      if (isRead) found.reads.push({ ...row, fields: primsIn(parsed, m.name, m.desc, READ_PRIMS) })
    }
  }
  return found.writes.length || found.reads.length ? found : null
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
  const reads = mixins.flatMap((m) => m.reads.map((r) => ({ ...r, className: m.className, source: m.source })))
  if (!writes.length && !reads.length) return { ext: null }
  const where = (r) => `${r.className} in ${path.basename(r.source.jarPath)}${r.source.nested ? ` (nested ${r.source.nested})` : ''}`
  const abstain = (reason, detail, rows) => ({ ext: null, abstain: { reason, detail, mixins: rows.map(where) } })
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

// paths: mods folders and/or jar files. Returns { ext, abstain, jars, mixins }.
function scanItemStackWireExtensions (paths) {
  const jars = listJars(paths)
  const mixins = []
  for (const jarPath of jars) {
    try { scanJar(readJar(jarPath), { jarPath }, mixins, 0) } catch (err) { debug(`item-wire scan: unreadable jar ${jarPath} (${err.message})`) }
  }
  const spec = deriveSpec(mixins)
  return { ...spec, jars: jars.length, mixins: mixins.map((m) => ({ className: m.className, jar: path.basename(m.source.jarPath), nested: m.source.nested || null, writes: m.writes.length, reads: m.reads.length })) }
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

module.exports = { scanItemStackWireExtensions, extendSlotType, WRITE_PRIMS, READ_PRIMS }
