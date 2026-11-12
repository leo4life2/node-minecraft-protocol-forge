'use strict'

// HF145 - a class's facts are computed ONCE per read, and a kept per-jar
// result records the facts it read.
//
// Installed on the shared class index (neoForgePayloadDerivation.js,
// makeClassIndex). Three things live here, one mechanism:
//
// A. THE CLASS STORE. A class entry is inflated once per read; the byte
//    pre-filters (rawBytes) and the parser (get) share that one buffer, and
//    the entry lets go of its jar's compressed buffer when it is inflated.
//    `index.stats` counts it (inflations, maxPerEntry - the bound is 1).
//    A byte query does not sweep every class's bytes: each class carries a
//    small filter of the 3-byte windows it holds (built once, from the same
//    bytes); a class whose filter lacks a window of the needle cannot include
//    it, and every class that passes is tested on its real bytes - the answer
//    is exactly the byte test's, the cost no longer grows with pack x needles.
//
// B. PACK QUERIES, each computed once per read and shared by every unit and
//    by the read step's pack passes; each returns class names in the index's
//    own order (the order a sweep of every class would have met them in):
//      namesIncluding(needle)       classes whose bytes include the needle
//      namesDeclaring(name, desc)   classes with a coded method name+desc
//      descendantsOf(cls)           classes that reach cls through super /
//                                   interface edges of classes in the pack
//      ancestorsOf(cls)             the reverse walk, by live lookups
//    A pack-wide loop iterates a query's names instead of every class and
//    keeps its own exact test, so it meets the same classes in the same order.
//
// C. THE DEPENDENCY RECORD. While a unit is in focus, every query it asks is
//    noted (kind + key) and every unit owning a matching class joins its
//    trail. A unit is identified by its VIEW: its content sha1 and the names
//    of the classes it provides to the index (first jar wins a name), so a
//    jar that starts or stops shadowing another jar's class is a change.
//    queryDepsHold() is the check for a kept result: its own view and every
//    trail view are still there in the same relative order, the services
//    lists it read are equal, and no class of a jar that is new or changed
//    since the result was derived matches any query it asked.
//    Why that is enough: a byte match and a method declaration are a class's
//    own facts; a class becomes a descendant only through a class that is
//    itself a descendant (so the new or changed class on the way matches); an
//    ancestor is found by name lookups, which the trail and the absence law
//    already record.
//
// READ-ONLY, JARS-ONLY: requires only crypto and the jar primitives.

const crypto = require('crypto')
const { zipEntryData, parseClassFile } = require('./jarAnalysis')

const WINDOW_HASH = 0x9E3779B1
const ORD_SPAN = 2097152 // 2^21 class ordinals per hash in a packed pair

/** A 32-bit hash of a string (a collision only widens a query's candidates: every loop re-tests its exact condition). */
function hashOf (s) {
  let h = 0x811C9DC5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}

/** (hash, class ordinal) pairs packed into doubles and sorted: a pack-wide fact table of a few bytes per fact. */
function makePairs () {
  let a = new Float64Array(1 << 14)
  let n = 0
  let sealed = null
  const beyond = new Map() // ordinals past the packed span (a pack of more than ORD_SPAN classes): hash -> [ordinal], ascending
  return {
    add (hash, ord) {
      if (ord >= ORD_SPAN) { const l = beyond.get(hash); if (l) { if (l[l.length - 1] !== ord) l.push(ord) } else beyond.set(hash, [ord]); return }
      if (n === a.length) { const b = new Float64Array(a.length * 2); b.set(a); a = b }
      a[n++] = hash * ORD_SPAN + ord
    },
    seal () { sealed = a.subarray(0, n).sort(); a = null },
    /** The ordinals recorded under `hash`, ascending, each once. */
    lookup (hash) {
      const lo = hash * ORD_SPAN
      const hi = lo + ORD_SPAN
      let l = 0
      let r = sealed.length
      while (l < r) { const m = (l + r) >>> 1; if (sealed[m] < lo) l = m + 1; else r = m }
      const out = []
      for (let i = l; i < sealed.length && sealed[i] < hi; i++) { const ord = sealed[i] - lo; if (out[out.length - 1] !== ord) out.push(ord) }
      const far = beyond.get(hash)
      if (far) for (const ord of far) out.push(ord)
      return out
    }
  }
}

const QUERY_KIND_WORDS = { i: 'a byte pattern', m: 'a method declaration', h: 'a subclass' }

function sha1Hex (s) { return crypto.createHash('sha1').update(s).digest('hex') }

/** The view of a unit: its content, its file name (results carry it) and the class names it provides to the index. Null for an unreadable jar. */
function unitViewOf (unit) {
  return unit && unit.sha1 ? sha1Hex(`${unit.sha1}\n${unit.label ?? ''}\n${(unit.classNames || []).join('\n')}`) : null
}

function installClassFacts (index) {
  const raw = index.raw
  const stats = { inflations: 0, maxPerEntry: 0, sweeps: 0, factsMs: 0 }
  index.stats = stats
  index.scans = null // the focus unit's queries (ids)
  index.servicesRead = null // the focus unit's services lookups: interface -> joined list | null

  // ---- A. the class store ----
  function bytesOf (r) {
    if (r.bytes !== undefined) return r.bytes
    let b = null
    try {
      b = zipEntryData(r.buf, r.entry)
      // an exact copy: an inflated class is a view of a whole output chunk and a stored entry a view of its jar - either would pin a much larger block
      if (b.buffer.byteLength > b.length) b = Buffer.from(b)
    } catch { b = null }
    r.inflated = (r.inflated || 0) + 1
    stats.inflations++
    if (r.inflated > stats.maxPerEntry) stats.maxPerEntry = r.inflated
    r.bytes = b
    r.buf = null
    r.entry = null
    return b
  }
  index.bytesOf = bytesOf
  // the 3-byte-window filter of a class: one hashed bit per window, about one bit per two bytes; never a false miss
  function filterOf (r, b) {
    if (r.filter !== undefined) return r.filter
    const len = b.length
    let bits = 64
    while (bits < (len >>> 1)) bits <<= 1
    const shift = 32 - Math.log2(bits)
    const f = new Uint8Array(bits >>> 3)
    let g = len > 1 ? ((b[0] << 8) | b[1]) : 0
    for (let i = 2; i < len; i++) {
      g = ((g << 8) | b[i]) & 0xFFFFFF
      const h = Math.imul(g, WINDOW_HASH) >>> shift
      f[h >>> 3] |= 1 << (h & 7)
    }
    r.filter = f
    r.filterShift = shift
    return f
  }
  function mayInclude (r, b, windows) {
    const f = filterOf(r, b)
    const shift = r.filterShift
    for (let k = 0; k < windows.length; k++) {
      const h = windows[k] >>> shift
      if (!(f[h >>> 3] & (1 << (h & 7)))) return false
    }
    return true
  }
  function windowsOf (nb) {
    if (nb.length < 3) return null // too short for a window: every class is tested on its bytes
    const out = new Uint32Array(nb.length - 2)
    let g = (nb[0] << 8) | nb[1]
    for (let i = 2; i < nb.length; i++) { g = ((g << 8) | nb[i]) & 0xFFFFFF; out[i - 2] = Math.imul(g, WINDOW_HASH) >>> 0 }
    return out
  }
  /** The parsed class without a lookup record and without keeping it (the facts pass and the checks). */
  function parseQuiet (name) {
    if (index.parsedPeek && index.parsedPeek(name) !== undefined) return index.parsedPeek(name)
    const r = raw.get(name)
    if (!r) return null
    try { return parseClassFile(bytesOf(r)) } catch { return null }
  }

  let ordinals = null
  function ordinalOf (name) {
    if (!ordinals) { ordinals = new Map(); let i = 0; for (const k of raw.keys()) ordinals.set(k, i++) }
    return ordinals.get(name)
  }
  const byOrdinal = (a, b) => ordinalOf(a) - ordinalOf(b)

  // ---- C (recording side). a query asked while a unit is in focus ----
  function note (id, q) {
    const f = index.focus
    if (!f || !index.scans || index.scans.has(id)) return
    index.scans.add(id)
    for (const u of q.units) if (u !== f) index.trail.add(u.path)
  }
  const unitsOf = (names) => { const s = new Set(); for (const n of names) { const r = raw.get(n); if (r && r.unit) s.add(r.unit) } return s }

  // ---- B. the pack queries ----
  const includesMemo = new Map()
  function includingQuery (needle) {
    const nb = Buffer.isBuffer(needle) ? needle : Buffer.from(String(needle), 'utf8')
    const key = nb.toString('latin1')
    let q = includesMemo.get(key)
    if (!q) {
      const names = []
      const windows = windowsOf(nb)
      for (const [name, r] of raw) {
        const b = bytesOf(r)
        if (!b) continue
        if (windows && !mayInclude(r, b, windows)) continue
        if (b.includes(nb)) names.push(name)
      }
      q = { names, units: unitsOf(names) }
      includesMemo.set(key, q)
      stats.sweeps++
    }
    note(`i:${key}`, q)
    return q
  }
  index.namesIncluding = (needle) => includingQuery(needle).names
  index.namesIncludingAny = (needles) => {
    const list = [...needles]
    if (list.length === 1) return includingQuery(list[0]).names
    const seen = new Set()
    for (const n of list) for (const name of includingQuery(n).names) seen.add(name)
    return [...seen].sort(byOrdinal)
  }

  let facts = null
  function factsOf () {
    if (facts) return facts
    const t = Date.now()
    const names = [...raw.keys()]
    const children = makePairs()
    const declaring = makePairs()
    for (let ord = 0; ord < names.length; ord++) {
      const info = parseQuiet(names[ord])
      if (!info) continue
      for (const p of [info.superName, ...(info.interfaces || [])]) if (p) children.add(hashOf(p), ord)
      for (const c of info.codes) declaring.add(hashOf(`${c.method} ${c.desc}`), ord)
    }
    children.seal()
    declaring.seal()
    facts = { names, children, declaring, declaringQ: new Map(), descendantsQ: new Map() }
    stats.factsMs = Date.now() - t
    return facts
  }
  index.namesDeclaring = (method, desc) => {
    const f = factsOf()
    const key = `${method} ${desc}`
    let q = f.declaringQ.get(key)
    if (!q) { const names = f.declaring.lookup(hashOf(key)).map((ord) => f.names[ord]); q = { names, units: unitsOf(names) }; f.declaringQ.set(key, q) }
    note(`m:${key}`, q)
    return q.names
  }
  index.descendantsOf = (cls) => {
    const f = factsOf()
    let q = f.descendantsQ.get(cls)
    if (!q) {
      const seen = new Set()
      const stack = [cls]
      while (stack.length) {
        const p = stack.pop()
        for (const ord of f.children.lookup(hashOf(p))) if (!seen.has(ord)) { seen.add(ord); stack.push(f.names[ord]) }
      }
      const names = [...seen].sort((a, b) => a - b).map((ord) => f.names[ord])
      q = { names, units: unitsOf(names) }
      f.descendantsQ.set(cls, q)
    }
    note(`h:${cls}`, q)
    return q.names
  }
  /** Names in order, of two queries' union. */
  index.namesUnion = (a, b) => {
    if (!b || b.length === 0) return a
    if (!a || a.length === 0) return b
    const seen = new Set(a)
    for (const n of b) seen.add(n)
    return [...seen].sort(byOrdinal)
  }
  /** Every class of the pack that `cls` reaches through super / interface edges: live lookups (the trail and the absence law record them). */
  index.ancestorsOf = (cls) => {
    const seen = new Set()
    const stack = [cls]
    const out = []
    while (stack.length) {
      const info = index.get(stack.pop())
      if (!info) continue
      for (const p of [info.superName, ...(info.interfaces || [])]) {
        if (!p || seen.has(p)) continue
        seen.add(p)
        if (index.has(p)) out.push(p)
        stack.push(p)
      }
    }
    return out.sort(byOrdinal)
  }

  /** The services list of an interface, recorded as a dependency of the focus unit. */
  index.servicesOf = (iface) => {
    const list = index.services.get(iface)
    if (index.focus && index.servicesRead) index.servicesRead.set(iface, list ? list.join(',') : null)
    return list
  }

  // ---- a pack-level value computed once under one unit and read by the others: its lookups are captured and replayed ----
  index.capture = (fn) => {
    const saved = { focus: index.focus, trail: index.trail, missed: index.missed, packScanned: index.packScanned, scans: index.scans, servicesRead: index.servicesRead }
    const probe = { path: null, classNames: [], probe: true }
    index.focus = probe; index.trail = new Set(); index.missed = new Set(); index.packScanned = false; index.scans = new Set(); index.servicesRead = new Map()
    let value
    let deps
    try {
      value = fn()
    } finally {
      deps = { trail: index.trail, missed: index.missed, packScanned: index.packScanned, scans: index.scans, servicesRead: index.servicesRead }
      index.focus = saved.focus; index.trail = saved.trail; index.missed = saved.missed; index.packScanned = saved.packScanned; index.scans = saved.scans; index.servicesRead = saved.servicesRead
    }
    return { value, deps }
  }
  index.replay = (deps) => {
    const f = index.focus
    if (!f || !deps) return
    for (const p of deps.trail) if (p !== f.path) index.trail.add(p)
    for (const n of deps.missed) index.missed.add(n)
    if (index.scans) for (const id of deps.scans) index.scans.add(id)
    if (index.servicesRead) for (const [k, v] of deps.servicesRead) index.servicesRead.set(k, v)
    if (deps.packScanned) index.packScanned = true
  }

  // ---- C (checking side). does a class of this unit match a recorded query? ----
  const parentsMemo = new Map()
  function parentsOf (name) {
    let p = parentsMemo.get(name)
    if (p === undefined) {
      const info = parseQuiet(name)
      p = info ? [info.superName, ...(info.interfaces || [])].filter(Boolean) : null
      parentsMemo.set(name, p)
    }
    return p
  }
  function unitFacts (unit) {
    if (unit.queryFacts) return unit.queryFacts
    const declared = new Set()
    const ancestors = new Set()
    const stack = []
    for (const name of unit.classNames) {
      const info = parseQuiet(name)
      if (!info) continue
      for (const c of info.codes) declared.add(`${c.method} ${c.desc}`)
      stack.push(name)
    }
    const walked = new Set()
    while (stack.length) {
      const n = stack.pop()
      if (walked.has(n)) continue
      walked.add(n)
      for (const p of parentsOf(n) || []) { ancestors.add(p); stack.push(p) }
    }
    unit.queryFacts = { declared, ancestors, includes: new Map() }
    return unit.queryFacts
  }
  index.unitMatchesQuery = (unit, id) => {
    const kind = id[0]
    const key = id.slice(2)
    const f = unitFacts(unit)
    if (kind === 'm') return f.declared.has(key)
    if (kind === 'h') return f.ancestors.has(key)
    if (kind === 'i') {
      let hit = f.includes.get(key)
      if (hit === undefined) {
        const nb = Buffer.from(key, 'latin1')
        hit = false
        for (const name of unit.classNames) { const r = raw.get(name); const b = r ? bytesOf(r) : null; if (b && b.includes(nb)) { hit = true; break } }
        f.includes.set(key, hit)
      }
      return hit
    }
    return true // a kind this build does not know: never held
  }
}

/**
 * Do a kept result's recorded views, services and queries still hold against a fresh read?
 * `view` = the unit's own view when derived; `orderViews` = the views of the unit and its trail in read order
 * (both checked when handed: the reading child always hands them, a slot without them is never served);
 * deps.packViews = every view of the pack it was derived in; deps.scans = the queries it asked;
 * deps.services = the services lists it read. Returns { ok, why }.
 */
function queryDepsHold (read, { view = null, orderViews = null, deps = null } = {}) {
  if (!deps || !Array.isArray(deps.packViews) || !Array.isArray(deps.scans)) return { ok: false, why: 'the kept result carries no pack queries (an older result)' }
  if (!read.viewPos) { read.viewPos = new Map(); read.units.forEach((u, i) => { if (u.view) read.viewPos.set(u.view, i) }) }
  // the caller that keeps results across reads (the reading child) hands the unit's own view and its trail's views in read order
  if (view && !read.viewPos.has(view)) return { ok: false, why: 'this jar provides other classes to the pack now, or has another file name (its view of the pack changed)' }
  let last = -1
  for (const v of orderViews || []) {
    const pos = read.viewPos.get(v)
    if (pos === undefined) return { ok: false, why: 'a jar this result read from provides other classes to the pack now, or has another file name' }
    if (pos <= last) return { ok: false, why: 'the jars this result read from are read in another order now' }
    last = pos
  }
  for (const [iface, joined] of Object.entries(deps.services || {})) {
    const now = read.index.services.get(iface)
    if ((now ? now.join(',') : null) !== (joined ?? null)) return { ok: false, why: `the services list of ${iface} changed` }
  }
  const was = new Set(deps.packViews)
  const fresh = read.units.filter((u) => u.view && !was.has(u.view))
  if (fresh.length === 0) return { ok: true, why: null }
  for (const id of deps.scans) {
    for (const u of fresh) {
      if (read.index.unitMatchesQuery(u, id)) return { ok: false, why: `a pack-wide scan of this jar now matches a class of a new or changed jar (${QUERY_KIND_WORDS[id[0]] || 'a query'})` }
    }
  }
  return { ok: true, why: null }
}

module.exports = { installClassFacts, unitViewOf, queryDepsHold }
