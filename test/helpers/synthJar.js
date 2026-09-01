'use strict'

// Test-only builders: a minimal Java class-file WRITER and a STORE-method
// jar writer, so the login-ack derivation's bytecode reasoning can be
// exercised deterministically without shipping third-party mod jars.
// Emits exactly the shapes javac produces for the registration idioms the
// derivation covers (fluent chains, AtomicInteger counters, static fields).

// --- constant pool builder ---
class ConstantPool {
  constructor () {
    this.entries = [] // 1-based
    this.map = new Map()
  }

  _add (key, bytes) {
    if (this.map.has(key)) return this.map.get(key)
    this.entries.push(bytes)
    const idx = this.entries.length
    this.map.set(key, idx)
    return idx
  }

  utf8 (s) {
    const b = Buffer.from(s, 'utf8')
    const out = Buffer.alloc(3 + b.length)
    out[0] = 1
    out.writeUInt16BE(b.length, 1)
    b.copy(out, 3)
    return this._add(`u:${s}`, out)
  }

  cls (name) {
    const n = this.utf8(name)
    const out = Buffer.from([7, 0, 0])
    out.writeUInt16BE(n, 1)
    return this._add(`c:${name}`, out)
  }

  str (s) {
    const n = this.utf8(s)
    const out = Buffer.from([8, 0, 0])
    out.writeUInt16BE(n, 1)
    return this._add(`s:${s}`, out)
  }

  int (v) {
    const out = Buffer.alloc(5)
    out[0] = 3
    out.writeInt32BE(v, 1)
    return this._add(`i:${v}`, out)
  }

  // Category-2 constants (tag 5/6) occupy TWO constant-pool slots; a phantom
  // zero-length entry keeps this builder's index accounting aligned with the
  // JVM's (parseClassFile skips the second slot the same way).
  long (v) {
    const key = `j:${v}`
    if (this.map.has(key)) return this.map.get(key)
    const out = Buffer.alloc(9)
    out[0] = 5
    out.writeBigInt64BE(BigInt(v), 1)
    this.entries.push(out)
    const idx = this.entries.length
    this.map.set(key, idx)
    this.entries.push(Buffer.alloc(0)) // phantom second slot
    return idx
  }

  double (v) {
    const key = `d:${v}`
    if (this.map.has(key)) return this.map.get(key)
    const out = Buffer.alloc(9)
    out[0] = 6
    out.writeDoubleBE(v, 1)
    this.entries.push(out)
    const idx = this.entries.length
    this.map.set(key, idx)
    this.entries.push(Buffer.alloc(0)) // phantom second slot
    return idx
  }

  nat (name, desc) {
    const n = this.utf8(name)
    const d = this.utf8(desc)
    const out = Buffer.from([12, 0, 0, 0, 0])
    out.writeUInt16BE(n, 1)
    out.writeUInt16BE(d, 3)
    return this._add(`n:${name}:${desc}`, out)
  }

  ref (tag, owner, name, desc) { // 9 field, 10 method, 11 interface method
    const c = this.cls(owner)
    const nt = this.nat(name, desc)
    const out = Buffer.from([tag, 0, 0, 0, 0])
    out.writeUInt16BE(c, 1)
    out.writeUInt16BE(nt, 3)
    return this._add(`r:${tag}:${owner}:${name}:${desc}`, out)
  }

  fieldRef (o, n, d) { return this.ref(9, o, n, d) }
  methodRef (o, n, d) { return this.ref(10, o, n, d) }
  iMethodRef (o, n, d) { return this.ref(11, o, n, d) }

  methodHandle (refKind, owner, name, desc) {
    const r = this.methodRef(owner, name, desc)
    const out = Buffer.from([15, refKind, 0, 0])
    out.writeUInt16BE(r, 2)
    return this._add(`h:${refKind}:${owner}:${name}:${desc}`, out)
  }

  invokeDynamic (bsmIndex, name, desc) {
    const nt = this.nat(name, desc)
    const out = Buffer.from([18, 0, 0, 0, 0])
    out.writeUInt16BE(bsmIndex, 1)
    out.writeUInt16BE(nt, 3)
    return this._add(`d:${bsmIndex}:${name}:${desc}`, out)
  }
}

// --- bytecode assembler (only the ops the derivation reasons about) ---
class Asm {
  constructor (cp) {
    this.cp = cp
    this.bytes = []
  }

  _u16 (v) { this.bytes.push((v >> 8) & 0xff, v & 0xff) }
  ldcCls (name) { const i = this.cp.cls(name); if (i < 256) this.bytes.push(0x12, i); else { this.bytes.push(0x13); this._u16(i) } return this }
  ldcStr (s) { const i = this.cp.str(s); if (i < 256) this.bytes.push(0x12, i); else { this.bytes.push(0x13); this._u16(i) } return this }
  iconst (v) {
    if (v >= -1 && v <= 5) this.bytes.push(0x03 + v)
    else if (v >= -128 && v <= 127) this.bytes.push(0x10, v & 0xff)
    else { this.bytes.push(0x11); this._u16(v & 0xffff) }
    return this
  }

  lconst (v) { this.bytes.push(0x09 + v); return this } // lconst_0/1
  fconst (v) { this.bytes.push(0x0b + v); return this } // fconst_0/1/2
  dconst (v) { this.bytes.push(0x0e + v); return this } // dconst_0/1
  ldc2Long (v) { this.bytes.push(0x14); this._u16(this.cp.long(v)); return this }
  ldc2Double (v) { this.bytes.push(0x14); this._u16(this.cp.double(v)); return this }
  lload (n) { this.bytes.push(0x1e + n); return this } // lload_n
  fload (n) { this.bytes.push(0x22 + n); return this } // fload_n
  dload (n) { this.bytes.push(0x26 + n); return this } // dload_n
  new_ (name) { this.bytes.push(0xbb); this._u16(this.cp.cls(name)); return this }
  dup () { this.bytes.push(0x59); return this }
  aload (n) { this.bytes.push(0x2a + n); return this }
  astore (n) { this.bytes.push(0x4b + n); return this } // astore_n
  getstatic (o, n, d) { this.bytes.push(0xb2); this._u16(this.cp.fieldRef(o, n, d)); return this }
  putstatic (o, n, d) { this.bytes.push(0xb3); this._u16(this.cp.fieldRef(o, n, d)); return this }
  invokevirtual (o, n, d) { this.bytes.push(0xb6); this._u16(this.cp.methodRef(o, n, d)); return this }
  invokespecial (o, n, d) { this.bytes.push(0xb7); this._u16(this.cp.methodRef(o, n, d)); return this }
  invokestatic (o, n, d) { this.bytes.push(0xb8); this._u16(this.cp.methodRef(o, n, d)); return this }
  invokedynamic (bsmIndex, name, desc) { this.bytes.push(0xba); this._u16(this.cp.invokeDynamic(bsmIndex, name, desc)); this.bytes.push(0, 0); return this }
  // HF11 additions: the aggregator-shape fixtures need instance state +
  // interface dispatch
  getfield (o, n, d) { this.bytes.push(0xb4); this._u16(this.cp.fieldRef(o, n, d)); return this }
  putfield (o, n, d) { this.bytes.push(0xb5); this._u16(this.cp.fieldRef(o, n, d)); return this }
  invokeinterface (o, n, d, count) { this.bytes.push(0xb9); this._u16(this.cp.iMethodRef(o, n, d)); this.bytes.push(count != null ? count : 1, 0); return this }
  athrow () { this.bytes.push(0xbf); return this }
  ifne (offset) { this.bytes.push(0x9a); this._u16(offset & 0xffff); return this }
  aconstNull () { this.bytes.push(0x01); return this }
  areturn () { this.bytes.push(0xb0); return this }
  goto_ (offset) { this.bytes.push(0xa7); this._u16(offset & 0xffff); return this }
  iload (n) { if (n <= 3) this.bytes.push(0x1a + n); else this.bytes.push(0x15, n); return this }
  istore (n) { if (n <= 3) this.bytes.push(0x3b + n); else this.bytes.push(0x36, n); return this }
  iinc (n, d) { this.bytes.push(0x84, n, d & 0xff); return this }
  imul () { this.bytes.push(0x68); return this }
  ifeq (offset) { this.bytes.push(0x99); this._u16(offset & 0xffff); return this }
  pop () { this.bytes.push(0x57); return this }
  ret () { this.bytes.push(0xb1); return this }
  // HF9 additions (annotation-registry idiom fixtures)
  aloadWide (n) { if (n <= 3) this.bytes.push(0x2a + n); else this.bytes.push(0x19, n); return this }
  aaload () { this.bytes.push(0x32); return this }
  iaload () { this.bytes.push(0x2e); return this }
  iastore () { this.bytes.push(0x4f); return this }
  newarrayInt () { this.bytes.push(0xbc, 10); return this }
  arraylength () { this.bytes.push(0xbe); return this }
  checkcast (name) { this.bytes.push(0xc0); this._u16(this.cp.cls(name)); return this }
  areturnOp () { this.bytes.push(0xb0); return this }
  raw (bytes) { for (const b of bytes) this.bytes.push(b & 0xff); return this }
  get pc () { return this.bytes.length }
  code () { return Buffer.from(this.bytes) }
}

// Builds one .class file:
//   { name, superName?, interfaces?: [name],
//     fields?: [{name, desc, flags?}],
//     annotations?: [{type: 'Lfoo/Bar;', elements: [{name, enums:
//       [{type: 'Lfoo/Dir;', const: 'X'}]}]}]  (RuntimeVisibleAnnotations),
//     bootstrapMethods?: [{refKind, owner, name, desc}],
//     methods: [{name, desc, flags, code(asm)=>void}] }
function buildClass (spec) {
  const cp = new ConstantPool()
  const thisIdx = cp.cls(spec.name)
  const superIdx = cp.cls(spec.superName || 'java/lang/Object')
  const codeAttr = cp.utf8('Code')
  const ifaceIdxs = (spec.interfaces || []).map((n) => cp.cls(n))
  const fieldSpecs = (spec.fields || []).map((f) => ({
    flags: f.flags != null ? f.flags : 0x0019, // public static final
    nameIdx: cp.utf8(f.name),
    descIdx: cp.utf8(f.desc)
  }))
  // bootstrap methods must be interned before the pool is frozen; each entry
  // becomes {ref: <handle>, args: [<same handle>, ...strArgs]} — enough for
  // resolveLambdaImpl (scans args for the implementation MethodHandle) AND
  // HF15's concatRecipeOf (scans args for the String recipe constant of a
  // makeConcatWithConstants call site — pass strArgs: ['s']).
  const bsmHandles = (spec.bootstrapMethods || []).map((b) => ({
    handle: cp.methodHandle(b.refKind != null ? b.refKind : 6, b.owner, b.name, b.desc),
    strArgs: (b.strArgs || []).map((s) => cp.str(s))
  }))
  const bsmAttrName = bsmHandles.length ? cp.utf8('BootstrapMethods') : null
  // class-level RuntimeVisibleAnnotations (JVMS 4.7.16): enum-array elements
  // only — exactly the shape the annotation-registry census reads.
  let annoAttrName = null
  let annoBody = null
  if (spec.annotations && spec.annotations.length > 0) {
    annoAttrName = cp.utf8('RuntimeVisibleAnnotations')
    const chunks = []
    const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v, 0); return b }
    chunks.push(u16(spec.annotations.length))
    for (const a of spec.annotations) {
      chunks.push(u16(cp.utf8(a.type)), u16((a.elements || []).length))
      for (const el of a.elements || []) {
        chunks.push(u16(cp.utf8(el.name)))
        chunks.push(Buffer.from('[', 'utf8'), u16(el.enums.length))
        for (const e of el.enums) {
          chunks.push(Buffer.from('e', 'utf8'), u16(cp.utf8(e.type)), u16(cp.utf8(e.const)))
        }
      }
    }
    annoBody = Buffer.concat(chunks)
  }

  const methods = spec.methods.map((m) => {
    const asm = new Asm(cp)
    m.code(asm)
    return { nameIdx: cp.utf8(m.name), descIdx: cp.utf8(m.desc), flags: m.flags != null ? m.flags : 0x0009, body: asm.code() }
  })

  const parts = []
  const head = Buffer.alloc(10)
  head.writeUInt32BE(0xCAFEBABE, 0)
  head.writeUInt16BE(0, 4)
  head.writeUInt16BE(52, 6)
  head.writeUInt16BE(cp.entries.length + 1, 8)
  parts.push(head, ...cp.entries)

  const mid = Buffer.alloc(8)
  mid.writeUInt16BE(0x21, 0)
  mid.writeUInt16BE(thisIdx, 2)
  mid.writeUInt16BE(superIdx, 4)
  mid.writeUInt16BE(ifaceIdxs.length, 6)
  parts.push(mid)
  for (const i of ifaceIdxs) {
    const b = Buffer.alloc(2)
    b.writeUInt16BE(i, 0)
    parts.push(b)
  }

  const fCount = Buffer.alloc(2)
  fCount.writeUInt16BE(fieldSpecs.length, 0)
  parts.push(fCount)
  for (const f of fieldSpecs) {
    const fh = Buffer.alloc(8)
    fh.writeUInt16BE(f.flags, 0)
    fh.writeUInt16BE(f.nameIdx, 2)
    fh.writeUInt16BE(f.descIdx, 4)
    fh.writeUInt16BE(0, 6) // no attributes
    parts.push(fh)
  }

  const mCount = Buffer.alloc(2)
  mCount.writeUInt16BE(methods.length, 0)
  parts.push(mCount)
  for (const m of methods) {
    const mh = Buffer.alloc(8)
    mh.writeUInt16BE(m.flags, 0)
    mh.writeUInt16BE(m.nameIdx, 2)
    mh.writeUInt16BE(m.descIdx, 4)
    mh.writeUInt16BE(1, 6) // one attribute: Code
    const codeLen = 12 + m.body.length
    const ah = Buffer.alloc(6)
    ah.writeUInt16BE(codeAttr, 0)
    ah.writeUInt32BE(codeLen, 2)
    const cb = Buffer.alloc(8)
    cb.writeUInt16BE(8, 0) // max_stack
    cb.writeUInt16BE(8, 2) // max_locals
    cb.writeUInt32BE(m.body.length, 4)
    const tail = Buffer.alloc(4) // exception_table_length=0, attributes_count=0
    parts.push(mh, ah, cb, m.body, tail)
  }
  const classAttrs = []
  if (bsmAttrName != null) {
    const chunks = []
    const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v, 0); return b }
    chunks.push(u16(bsmHandles.length))
    for (const h of bsmHandles) {
      chunks.push(u16(h.handle)) // bootstrap_method_ref
      chunks.push(u16(1 + h.strArgs.length)) // num args
      chunks.push(u16(h.handle)) // arg 0: the impl handle
      for (const s of h.strArgs) chunks.push(u16(s)) // recipe/extra String constants
    }
    classAttrs.push({ nameIdx: bsmAttrName, body: Buffer.concat(chunks) })
  }
  if (annoAttrName != null) classAttrs.push({ nameIdx: annoAttrName, body: annoBody })
  const acCount = Buffer.alloc(2)
  acCount.writeUInt16BE(classAttrs.length, 0)
  parts.push(acCount)
  for (const a of classAttrs) {
    const h = Buffer.alloc(6)
    h.writeUInt16BE(a.nameIdx, 0)
    h.writeUInt32BE(a.body.length, 2)
    parts.push(h, a.body)
  }
  return Buffer.concat(parts)
}

// STORE-method (uncompressed) jar writer: [{name, data}] -> jar Buffer
function buildJar (entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const nameB = Buffer.from(e.name, 'utf8')
    const lh = Buffer.alloc(30)
    lh.writeUInt32BE(0, 0)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(0, 8) // method: store
    lh.writeUInt32LE(e.data.length, 18) // csize
    lh.writeUInt32LE(e.data.length, 22) // usize
    lh.writeUInt16LE(nameB.length, 26)
    locals.push(lh, nameB, e.data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(0, 10) // method
    ch.writeUInt32LE(e.data.length, 20)
    ch.writeUInt32LE(e.data.length, 24)
    ch.writeUInt16LE(nameB.length, 28)
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, nameB)
    offset += 30 + nameB.length + e.data.length
  }
  const centralStart = offset
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(centralStart, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

module.exports = { buildClass, buildJar }
