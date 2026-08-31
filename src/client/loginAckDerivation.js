'use strict'

// Static derivation of SimpleChannel LOGIN-ACK replies from mod jars.
//
// Mechanism. On Forge 1.18-1.20.1, individual mods run their own login
// sub-protocols over fml:loginwrapper: the server sends the mod's S2C login
// messages on the mod's channel and blocks the login until the client
// answers with the mod's own "Acknowledge" message — an EMPTY-body message
// whose one-byte(ish) discriminator is the index the mod registered it
// under in its SimpleChannel. That index is fixed at build time by
// straight-line registration code, so it can be read out of the shipped
// bytecode without ever executing it. This module does that: given a
// channel id ("tacz:handshake") and the local mods folder, it finds the
// channel's creation site, its message registrations, proves which
// registered class is the empty-encoder login acknowledge, resolves the
// index it received (explicit constant, or counter seed + provable
// uses-before), and returns the reply payload `varint(index)`.
//
// Grounded in three real registration shapes (bytecode-verified against
// shipped jars; see minepal-coop/mods-scan/lane-mods-scan.md):
//   - DIRECT-static (TACZ 1.1.7): NetworkRegistry.newSimpleChannel ->
//     static field; registrations across static methods ordered by a
//     unique root caller; index = AtomicInteger(seed=1).getAndIncrement()
//     with the Acknowledge registered first -> 1.
//   - WRAPPER-builder (MrCrayfish Framework 0.7.15): fluent builder chain
//     (createNetworkBuilder(id).registerHandshakeMessage(X)... .build());
//     build() resets an instance counter to 1, then registers Acknowledge
//     through a direct same-class call; play-message contributions are
//     ruled out by proving the chain added nothing to the play list -> 1.
//   - ABSTAIN (Zeta/Quark): login reply must ECHO server data (C2SLoginFlag
//     carries a BitSet) - no empty-encoder candidate exists, so derivation
//     returns null and the caller falls back to its table/default.
//
// HONESTY RULE: every quantity is proven from bytecode or the derivation
// abstains (returns null). A wrong ack index would kick the login with a
// worse diagnostic than the FML default, so "no answer" always beats "a
// guessed answer". The one documented assumption: registrations reachable
// only from OTHER root methods than the one registering the acknowledge are
// treated as happening after it (standard mod-init convention: a mod wires
// its own network before addons touch it).
//
// DESIGN LAWS (owner-ratified): LOCAL-ONLY (no network I/O - this module
// requires only fs/path/zlib-via-jarAnalysis), READ-ONLY JARS-ONLY (parse,
// never classload/execute), PURPOSE-LIMITED (network-registration
// signatures only: channel ids, message classes, registration indices).

const fs = require('fs')
const path = require('path')
const debug = require('debug')('minecraft-protocol-forge')
const { zipCentralEntries, zipEntryData, parseClassFile, walkBytecode, cpUtf8, cpRef } = require('./jarAnalysis')

const RL_CLASSES = new Set([
  'net/minecraft/resources/ResourceLocation', // mojmap/srg (Forge mods)
  'net/minecraft/class_2960', // intermediary (shipped Fabric jars)
  'net/minecraft/util/Identifier' // yarn (dev jars)
])
// SimpleChannel/MessageBuilder/NetworkDirection across the FML eras: Forge
// 1.17+ (FML3-era mods) uses net/minecraftforge/network/..., Forge 1.13-1.16
// (FML2-era mods) shipped the same API under net/minecraftforge/fml/network/.
// Both eras run the identical login sub-protocol over fml:loginwrapper, so
// one derivation covers both — membership sets, not a single name.
const SIMPLE_CHANNELS = new Set([
  'net/minecraftforge/network/simple/SimpleChannel',
  'net/minecraftforge/fml/network/simple/SimpleChannel'
])
const MESSAGE_BUILDERS = new Set([
  'net/minecraftforge/network/simple/SimpleChannel$MessageBuilder',
  'net/minecraftforge/fml/network/simple/SimpleChannel$MessageBuilder'
])
const NETWORK_DIRECTIONS = new Set([
  'net/minecraftforge/network/NetworkDirection',
  'net/minecraftforge/fml/network/NetworkDirection'
])
const ATOMIC_INT = 'java/util/concurrent/atomic/AtomicInteger'
const isSimpleChannelDesc = (desc) => typeof desc === 'string' && desc[0] === 'L' && desc.endsWith(';') && SIMPLE_CHANNELS.has(desc.slice(1, -1))
const returnsSimpleChannel = (desc) => {
  if (typeof desc !== 'string') return false
  const ret = desc.slice(desc.lastIndexOf(')') + 1)
  return isSimpleChannelDesc(ret)
}
// FriendlyByteBuf across mapping sets (mojmap, intermediary, legacy mcp)
const BYTEBUF_TYPES = ['net/minecraft/network/FriendlyByteBuf', 'net/minecraft/class_2540', 'net/minecraft/network/PacketBuffer']

const ACC_BRIDGE = 0x0040

// --- per-method ordered event stream ---------------------------------------
// Linearizes one method's bytecode into the events the derivation reasons
// about: constants, field traffic, allocations and calls, in program order.
// Straight-line registration code (what javac emits for fluent chains and
// sequential register calls) is exactly reconstructable this way.
function methodEvents (parsed, m) {
  const { cp } = parsed
  const ev = []
  const code = m.code
  // Every event carries `insn`: its ordinal in the FULL instruction walk,
  // modeled or not. Adjacency checks (resolveLocalIndex) use it to prove
  // that NO unmodeled instruction (imul/iadd/ineg/...) sits between a value
  // push and its consumer — unmodeled arithmetic is invisible to the event
  // stream, so without this a computed store would present a WRONG value
  // as proven.
  let insn = 0
  const handle = (op, pc) => {
    if (op === 0x12 || op === 0x13) { // ldc / ldc_w
      const c = cp[op === 0x12 ? code[pc + 1] : code.readUInt16BE(pc + 1)]
      if (!c) return
      if (c.tag === 8) ev.push({ k: 'str', v: cpUtf8(cp, c.strIndex) })
      else if (c.tag === 7) ev.push({ k: 'cls', v: cpUtf8(cp, c.nameIndex) })
      else if (c.tag === 3) ev.push({ k: 'int', v: c.int })
    } else if (op >= 0x02 && op <= 0x08) { // iconst_m1 .. iconst_5
      ev.push({ k: 'int', v: op - 0x03 })
    } else if (op === 0x10) { // bipush
      ev.push({ k: 'int', v: code.readInt8(pc + 1) })
    } else if (op === 0x11) { // sipush
      ev.push({ k: 'int', v: code.readInt16BE(pc + 1) })
    } else if (op === 0xbc || op === 0xbd || op === 0xc5) {
      // newarray/anewarray/multianewarray consume the preceding int (array
      // length), which must not be mistaken for a registration index
      if (ev.length && ev[ev.length - 1].k === 'int') ev.pop()
      if (op === 0xbd) ev.push({ k: 'anew' })
    } else if (op === 0xb2 || op === 0xb4) { // getstatic / getfield
      const r = cpRef(cp, code.readUInt16BE(pc + 1))
      if (r) ev.push({ k: 'get', r })
    } else if (op === 0xb3 || op === 0xb5) { // putstatic / putfield
      const r = cpRef(cp, code.readUInt16BE(pc + 1))
      if (r) ev.push({ k: 'put', r })
    } else if (op === 0xbb) { // new
      const c = cp[code.readUInt16BE(pc + 1)]
      if (c && c.tag === 7) ev.push({ k: 'new', v: cpUtf8(cp, c.nameIndex) })
    } else if (op === 0xb6 || op === 0xb7 || op === 0xb8 || op === 0xb9) { // invoke*
      const r = cpRef(cp, code.readUInt16BE(pc + 1))
      if (r) ev.push({ k: 'call', r })
    } else if (op === 0x15) { // iload <n>
      ev.push({ k: 'iload', slot: code[pc + 1] })
    } else if (op >= 0x1a && op <= 0x1d) { // iload_0..3
      ev.push({ k: 'iload', slot: op - 0x1a })
    } else if (op === 0x36) { // istore <n>
      ev.push({ k: 'istore', slot: code[pc + 1] })
    } else if (op >= 0x3b && op <= 0x3e) { // istore_0..3
      ev.push({ k: 'istore', slot: op - 0x3b })
    } else if (op === 0x84) { // iinc
      ev.push({ k: 'iinc', slot: code[pc + 1], delta: code.readInt8(pc + 2) })
    } else if (op === 0xc4) { // wide iload/istore/iinc
      const wop = code[pc + 1]
      if (wop === 0x15) ev.push({ k: 'iload', slot: code.readUInt16BE(pc + 2) })
      else if (wop === 0x36) ev.push({ k: 'istore', slot: code.readUInt16BE(pc + 2) })
      else if (wop === 0x84) ev.push({ k: 'iinc', slot: code.readUInt16BE(pc + 2), delta: code.readInt16BE(pc + 4) })
    } else if ((op >= 0x99 && op <= 0xa8) || op === 0xaa || op === 0xab ||
               op === 0xc6 || op === 0xc7 || op === 0xc8 || op === 0xc9 || op === 0xbf) {
      // any jump/switch/throw: the method is no longer straight-line, which
      // poisons LOCAL int-counter simulation (values may be branch-dependent)
      ev.push({ k: 'br' })
    }
  }
  walkBytecode(code, (op, pc) => {
    const before = ev.length
    handle(op, pc)
    for (let i = before; i < ev.length; i++) ev[i].insn = insn
    insn++
  })
  return ev
}

// --- facts store ------------------------------------------------------------

function newFacts () {
  return {
    classIndex: new Map(), // className -> {jarPath, chain, entryName}
    parsed: new Map(), // className -> parsed class
    events: new Map(), // 'className#method#desc' -> event list
    rlFields: new Map(), // 'owner.field' -> {ns, path}
    helperNs: new Map() // 'owner.name' -> ns  ((String)->RL id helpers)
  }
}

function indexJar (buf, source, facts, depth, nsNeedle, pathNeedle, hot) {
  let entries
  try { entries = zipCentralEntries(buf) } catch (err) {
    debug(`login-ack scan: unreadable jar ${source.jarPath} (${err.message})`)
    return
  }
  for (const entry of entries) {
    if (entry.name.endsWith('.jar') && entry.name.startsWith('META-INF/jars/') && depth < 2) {
      try {
        indexJar(zipEntryData(buf, entry), { jarPath: source.jarPath, chain: [...source.chain, entry.name] }, facts, depth + 1, nsNeedle, pathNeedle, hot)
      } catch (err) {
        debug(`login-ack scan: unreadable nested jar ${entry.name} (${err.message})`)
      }
      continue
    }
    if (!entry.name.endsWith('.class') || entry.name.startsWith('META-INF/')) continue
    const className = entry.name.slice(0, -6)
    if (!facts.classIndex.has(className)) facts.classIndex.set(className, { ...source, entryName: entry.name })
    // hot classes: mention both channel-id halves -> candidates for the
    // creation site; everything else is parsed lazily on demand
    let data
    try { data = zipEntryData(buf, entry) } catch { continue }
    if (data.includes(nsNeedle) && data.includes(pathNeedle)) {
      const parsed = parseClassFile(data)
      if (parsed) {
        facts.parsed.set(parsed.className, parsed)
        hot.push(parsed)
      }
    }
  }
}

function lazyClass (facts, className) {
  if (facts.parsed.has(className)) return facts.parsed.get(className)
  const loc = facts.classIndex.get(className)
  if (!loc) return null
  try {
    let buf = fs.readFileSync(loc.jarPath)
    for (const link of loc.chain) {
      buf = zipEntryData(buf, zipCentralEntries(buf).find((e) => e.name === link))
    }
    const entry = zipCentralEntries(buf).find((e) => e.name === loc.entryName)
    const parsed = entry && parseClassFile(zipEntryData(buf, entry))
    if (parsed) facts.parsed.set(parsed.className, parsed)
    return parsed || null
  } catch (err) {
    debug(`login-ack scan: failed to read ${className} (${err.message})`)
    return null
  }
}

function eventsFor (facts, parsed, m) {
  const key = `${parsed.className}#${m.method}#${m.desc}`
  if (!facts.events.has(key)) facts.events.set(key, methodEvents(parsed, m))
  return facts.events.get(key)
}

// Collect static-field RL literals and (String)->RL helper namespaces from a
// parsed class, for identifier indirection (MyMod.id("x"), static final RL).
function harvestIdentifiers (facts, parsed) {
  for (const m of parsed.codes) {
    const ev = eventsFor(facts, parsed, m)
    // helper: static method (Ljava/lang/String;)L<RL>; whose body ldc's
    // exactly one string (the namespace)
    const helperMatch = m.desc.match(/^\(Ljava\/lang\/String;\)L([^;]+);$/)
    if (helperMatch && RL_CLASSES.has(helperMatch[1])) {
      const strs = ev.filter((e) => e.k === 'str')
      if (strs.length === 1) facts.helperNs.set(`${parsed.className}.${m.method}`, strs[0].v)
    }
    // static final RL FIELD = new RL("ns","path") / new RL("ns:path")
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]
      if (e.k !== 'put' || !e.r.desc || e.r.desc[0] !== 'L' || !RL_CLASSES.has(e.r.desc.slice(1, -1))) continue
      const id = rlValueBefore(ev, i, facts)
      if (id) facts.rlFields.set(`${e.r.owner}.${e.r.name}`, id)
    }
  }
}

// Resolves the RL value on the stack just before event index i: literal
// constructor, known static field, or known helper call.
function rlValueBefore (ev, i, facts) {
  for (let j = i - 1; j >= 0 && j >= i - 8; j--) {
    const e = ev[j]
    if (e.k === 'call' && e.r.name === '<init>' && RL_CLASSES.has(e.r.owner)) {
      const strs = []
      for (let s = j - 1; s >= 0 && strs.length < 2; s--) {
        if (ev[s].k === 'str') strs.unshift(ev[s].v)
        else if (ev[s].k === 'new' && RL_CLASSES.has(ev[s].v)) break
      }
      if (e.r.desc === '(Ljava/lang/String;Ljava/lang/String;)V' && strs.length >= 2) {
        return { ns: strs[strs.length - 2], path: strs[strs.length - 1] }
      }
      if (e.r.desc === '(Ljava/lang/String;)V' && strs.length >= 1) {
        const s = strs[strs.length - 1]
        const ix = s.indexOf(':')
        return ix >= 0 ? { ns: s.slice(0, ix), path: s.slice(ix + 1) } : { ns: 'minecraft', path: s }
      }
      return null
    }
    if (e.k === 'get' && e.r.desc && e.r.desc[0] === 'L' && RL_CLASSES.has(e.r.desc.slice(1, -1))) {
      return facts.rlFields.get(`${e.r.owner}.${e.r.name}`) || null
    }
    if (e.k === 'call') {
      const helper = e.r.desc && e.r.desc.match(/^\(Ljava\/lang\/String;\)L([^;]+);$/)
      if (helper && RL_CLASSES.has(helper[1])) {
        const ns = helperNsOf(facts, e.r.owner, e.r.name)
        const prev = ev.slice(Math.max(0, j - 3), j).reverse().find((x) => x.k === 'str')
        if (ns && prev) return { ns, path: prev.v }
        return null
      }
    }
  }
  return null
}

// Namespace of a (String)->ResourceLocation id helper (MyMod.resource("x")).
// Harvested eagerly from HOT classes, but helpers routinely live in classes
// OUTSIDE the hot set (CalioAPI.resource carries "calio" and never mentions
// "channel"), so unknown helpers are resolved lazily from the full class
// index: parse the owner, find the single-ldc-string helper body, cache
// hits AND misses.
function helperNsOf (facts, owner, name) {
  const key = `${owner}.${name}`
  if (facts.helperNs.has(key)) return facts.helperNs.get(key)
  let ns = null
  const parsed = lazyClass(facts, owner)
  if (parsed) {
    for (const m of parsed.codes) {
      if (m.method !== name) continue
      const match = m.desc.match(/^\(Ljava\/lang\/String;\)L([^;]+);$/)
      if (!match || !RL_CLASSES.has(match[1])) continue
      const strs = eventsFor(facts, parsed, m).filter((e) => e.k === 'str')
      if (strs.length === 1) ns = strs[0].v
      break
    }
  }
  facts.helperNs.set(key, ns)
  return ns
}

// --- registration-site model ------------------------------------------------

// A call event is a registration when it targets SimpleChannel.messageBuilder
// or SimpleChannel.registerMessage. Extracts, via the surrounding events:
// message class, index source (constant | counter field), channel binding
// (static field | unbound), login markers, and any NetworkDirection constant.
function extractRegSites (ev, className, method) {
  const sites = []
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i]
    if (e.k !== 'call' || !SIMPLE_CHANNELS.has(e.r.owner)) continue
    if (e.r.name !== 'messageBuilder' && e.r.name !== 'registerMessage') continue

    // backwards scan bounded by the previous SimpleChannel call
    let msgClass = null
    let index = null // {const:n} | {counter:'owner.field', useIdx}
    let channelField = null
    let direction = null
    for (let j = i - 1; j >= 0; j--) {
      const p = ev[j]
      if (p.k === 'call' && SIMPLE_CHANNELS.has(p.r.owner)) break
      if (p.k === 'cls' && !msgClass) msgClass = p.v
      if (!index) {
        if (p.k === 'int') index = { const: p.v }
        else if (p.k === 'iload') {
          // local int variable as the index argument — the calio-class
          // `int index = 0; CHANNEL.messageBuilder(cls, index++, DIR)` idiom.
          // Resolved later by straight-line simulation of the local's value.
          index = { local: p.slot, useEvIdx: j }
        } else if (p.k === 'call' && p.r.owner === ATOMIC_INT && p.r.name === 'getAndIncrement') {
          const fieldGet = ev.slice(Math.max(0, j - 4), j).reverse()
            .find((x) => x.k === 'get' && x.r.desc === `L${ATOMIC_INT};`)
          // useIdx: this site's OWN counter use - callers counting "prior
          // uses" must count strictly before it, not before the call event
          index = { counter: fieldGet ? `${fieldGet.r.owner}.${fieldGet.r.name}` : null, useIdx: j }
        }
      }
      if (p.k === 'get' && isSimpleChannelDesc(p.r.desc) && !channelField) {
        channelField = `${p.r.owner}.${p.r.name}`
      }
      if (p.k === 'get' && NETWORK_DIRECTIONS.has(p.r.owner) && !direction) direction = p.r.name
    }
    // forwards scan for builder-chain login markers, bounded by the next
    // SimpleChannel call / field store (statement end)
    let loginMarked = false
    for (let j = i + 1; j < ev.length; j++) {
      const n = ev[j]
      if (n.k === 'call' && MESSAGE_BUILDERS.has(n.r.owner) &&
          (n.r.name === 'loginIndex' || n.r.name === 'markAsLoginPacket')) loginMarked = true
      if (n.k === 'call' && SIMPLE_CHANNELS.has(n.r.owner)) break
      if (n.k === 'put') break
      if (n.k === 'get' && NETWORK_DIRECTIONS.has(n.r.owner) && !direction) direction = n.r.name
    }
    sites.push({ className, method, evIdx: i, msgClass, index, channelField, direction, loginMarked, ev })
  }
  return sites
}

// --- ack-candidate proof: empty encoder ------------------------------------

// True when the message class provably encodes NOTHING: every non-bridge
// void method taking a FriendlyByteBuf(-mapped) parameter has an empty body
// (single `return`), and at least one such method exists. Bridge methods
// (compiler-generated Object-typed forwarders) are excluded.
function hasEmptyEncoder (facts, className) {
  const parsed = lazyClass(facts, className)
  if (!parsed) return false
  let found = false
  for (const m of parsed.codes) {
    if (m.flags & ACC_BRIDGE) continue
    if (!m.desc.endsWith(')V')) continue
    if (!BYTEBUF_TYPES.some((t) => m.desc.includes(`L${t};`))) continue
    if (m.method === '<init>') continue
    if (m.code.length === 1 && m.code[0] === 0xb1) found = true
    else return false // a real encoder writes bytes -> not an empty ack
  }
  return found
}

// --- LOCAL int-counter reasoning -------------------------------------------
// The most common 1.18-1.20.1 registration idiom (Calio, Apoli, and the wide
// `int index = 0; CHANNEL.messageBuilder(X, index++, DIR)` family) passes a
// METHOD-LOCAL counter as the index. javac compiles it to straight-line
// `iconst_k; istore_N; ... iload_N; iinc N,1; ...`, so the value at any use
// is exactly computable by walking the method once — PROVIDED the method has
// no branches (any jump/switch/throw poisons the simulation and we abstain;
// wrong answers are worse than no answer).
function resolveLocalIndex (ev, slot, useEvIdx) {
  if (ev.some((e) => e.k === 'br')) return null // not straight-line: abstain
  let value = null
  for (let i = 0; i < useEvIdx; i++) {
    const e = ev[i]
    if (e.k === 'istore' && e.slot === slot) {
      // Only a store of a DIRECTLY-ADJACENT pushed constant is provable —
      // adjacency by instruction ordinal, not event order: any instruction
      // between the push and the store (unmodeled arithmetic like imul is
      // invisible to the event stream) means the stored value is computed,
      // which poisons the local. Wrong answers are worse than no answer.
      const prev = ev[i - 1]
      const adjacent = prev && prev.insn === e.insn - 1
      if (adjacent && prev.k === 'int') {
        value = prev.v
      } else if (adjacent && prev.k === 'iload' && prev.slot === slot) {
        // self-store: value unchanged
      } else {
        value = null
      }
    } else if (e.k === 'iinc' && e.slot === slot) {
      if (value != null) value += e.delta
    }
  }
  return value
}

// --- counter reasoning ------------------------------------------------------

// Seed of an AtomicInteger field: the constant passed to its constructor at
// the store site (new AtomicInteger(k) -> put owner.field). No-arg ctor = 0.
function counterSeed (facts, counterField) {
  const [owner] = splitField(counterField)
  const parsed = lazyClass(facts, owner)
  if (!parsed) return null
  for (const m of parsed.codes) {
    const ev = eventsFor(facts, parsed, m)
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]
      if (e.k !== 'put' || `${e.r.owner}.${e.r.name}` !== counterField) continue
      // scan back for the AtomicInteger ctor and its int argument
      for (let j = i - 1; j >= 0; j--) {
        const p = ev[j]
        if (p.k === 'call' && p.r.owner === ATOMIC_INT && p.r.name === '<init>') {
          if (p.r.desc === '()V') return 0
          if (p.r.desc === '(I)V') {
            const arg = ev.slice(Math.max(0, j - 3), j).reverse().find((x) => x.k === 'int')
            return arg ? arg.v : null
          }
          return null
        }
        if (p.k === 'put' || (p.k === 'call' && SIMPLE_CHANNELS.has(p.r.owner))) break
      }
    }
  }
  return null
}

function splitField (fieldKey) {
  const dot = fieldKey.lastIndexOf('.')
  return [fieldKey.slice(0, dot), fieldKey.slice(dot + 1)]
}

// Ordered getAndIncrement positions on `counterField` within an event list.
function counterUsePositions (ev, counterField) {
  const out = []
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i]
    if (e.k !== 'call' || e.r.owner !== ATOMIC_INT || e.r.name !== 'getAndIncrement') continue
    const fieldGet = ev.slice(Math.max(0, i - 4), i).reverse()
      .find((x) => x.k === 'get' && x.r.desc === `L${ATOMIC_INT};`)
    if (fieldGet && `${fieldGet.r.owner}.${fieldGet.r.name}` === counterField) out.push(i)
  }
  return out
}

// --- DIRECT shape -----------------------------------------------------------
// Channel is a static SimpleChannel field; registrations reference it via
// getstatic. Proves the ack site is the counter's first use by linearizing
// the unique root method that calls every counter-using method.
function deriveDirect (facts, channelField, hotClasses, channelId) {
  // all registration sites on this channel across hot classes
  const sites = []
  for (const parsed of hotClasses) {
    for (const m of parsed.codes) {
      const ev = eventsFor(facts, parsed, m)
      for (const s of extractRegSites(ev, parsed.className, m.method)) {
        if (s.channelField === channelField) sites.push(s)
      }
    }
  }
  if (sites.length === 0) return null

  const ackSites = sites.filter((s) =>
    s.loginMarked &&
    s.msgClass && hasEmptyEncoder(facts, s.msgClass) &&
    (!s.direction || s.direction === 'LOGIN_TO_SERVER'))
  if (ackSites.length === 0) {
    debug(`login-ack ${channelId}: no empty-encoder login candidate among ${sites.length} registrations - abstaining`)
    return null
  }
  const distinctClasses = new Set(ackSites.map((s) => s.msgClass))
  if (distinctClasses.size > 1) {
    debug(`login-ack ${channelId}: ambiguous ack candidates (${[...distinctClasses].join(', ')}) - abstaining`)
    return null
  }
  const ack = ackSites[0]

  if (ack.index && ack.index.const != null) {
    return { index: ack.index.const, msgClass: ack.msgClass, evidence: `explicit constant at ${ack.className}#${ack.method}` }
  }
  if (ack.index && ack.index.local != null) {
    const v = resolveLocalIndex(ack.ev, ack.index.local, ack.index.useEvIdx)
    if (v == null) {
      debug(`login-ack ${channelId}: local counter slot ${ack.index.local} not provably straight-line - abstaining`)
      return null
    }
    return { index: v, msgClass: ack.msgClass, evidence: `local int counter slot ${ack.index.local} = ${v} (straight-line simulation) at ${ack.className}#${ack.method}` }
  }
  if (!ack.index || !ack.index.counter) {
    debug(`login-ack ${channelId}: ack index source unresolved - abstaining`)
    return null
  }

  const counter = ack.index.counter
  const seed = counterSeed(facts, counter)
  if (seed == null) {
    debug(`login-ack ${channelId}: counter ${counter} seed unresolved - abstaining`)
    return null
  }

  // uses of the counter before the ack, inside the ack's own method
  const parsedAck = facts.parsed.get(ack.className)
  const ackEv = eventsFor(facts, parsedAck, parsedAck.codes.find((m) => {
    return eventsFor(facts, parsedAck, m).length && extractRegSites(eventsFor(facts, parsedAck, m), ack.className, m.method)
      .some((s) => s.evIdx === ack.evIdx && s.msgClass === ack.msgClass)
  }) || parsedAck.codes.find((m) => m.method === ack.method))
  const usesInAckMethod = counterUsePositions(ackEv, counter)
  // strictly before the ack's OWN getAndIncrement (not the call event, which
  // sits after it and would count the ack's own use as "prior")
  const ackUseIdx = ack.index.useIdx != null ? ack.index.useIdx : ack.evIdx
  let usesBefore = usesInAckMethod.filter((p) => p < ackUseIdx).length

  // other methods using the counter: order them via a unique root caller
  const useMethods = new Map() // 'class#method' -> uses count
  for (const parsed of hotClasses) {
    for (const m of parsed.codes) {
      const uses = counterUsePositions(eventsFor(facts, parsed, m), counter).length
      if (uses > 0) useMethods.set(`${parsed.className}#${m.method}`, { className: parsed.className, method: m.method, uses })
    }
  }
  const ackKey = `${ack.className}#${ack.method}`
  const others = [...useMethods.keys()].filter((k) => k !== ackKey)
  if (others.length > 0) {
    // find root methods (in hot classes) that call the ack method
    const roots = []
    for (const parsed of hotClasses) {
      for (const m of parsed.codes) {
        const ev = eventsFor(facts, parsed, m)
        const callIdx = ev.findIndex((e) => e.k === 'call' && e.r.owner === ack.className && e.r.name === ack.method)
        if (callIdx >= 0) roots.push({ parsed, m, ev, callIdx })
      }
    }
    if (roots.length !== 1) {
      debug(`login-ack ${channelId}: ${roots.length} callers of ${ackKey} - ordering unprovable, abstaining`)
      return null
    }
    const root = roots[0]
    // counter uses in the root itself before the ack call
    usesBefore += counterUsePositions(root.ev, counter).filter((p) => p < root.callIdx).length
    // use-methods invoked by the root before the ack call
    for (let i = 0; i < root.callIdx; i++) {
      const e = root.ev[i]
      if (e.k === 'call') {
        const target = useMethods.get(`${e.r.owner}#${e.r.name}`)
        if (target) usesBefore += target.uses
      }
    }
    // use-methods NOT called by the root at all: assumed post-init (addon
    // registrations) - they consume later counter values, never earlier ones
  }

  return { index: seed + usesBefore, msgClass: ack.msgClass, evidence: `counter ${counter} seed ${seed} + ${usesBefore} prior uses` }
}

// --- WRAPPER shape ----------------------------------------------------------
// The channel id flows into a builder (createNetworkBuilder-style), a fluent
// chain registers message CLASSES, and a terminal build() assigns indices.
function deriveWrapper (facts, creation, hotClasses, channelId) {
  const chain = creation.chain
  const chainNames = chain.map((c) => c.name)
  const registerNames = chainNames.filter((n) => /^register/i.test(n))
  if (registerNames.length === 0) return null

  // Implementation candidates: classes shipping IN THE SAME JAR as the
  // creation site (a wrapper library ships its builder impl next to its
  // API - library locality, not name guessing) that implement at least one
  // of the chain's register methods and touch SimpleChannel.messageBuilder.
  const loc = facts.classIndex.get(creation.className)
  const jarKey = loc ? `${loc.jarPath}!${loc.chain.join('!')}` : null
  const impls = []
  for (const [cn, l] of facts.classIndex) {
    if (jarKey && `${l.jarPath}!${l.chain.join('!')}` !== jarKey) continue
    const parsed = lazyClass(facts, cn)
    if (!parsed) continue
    const names = new Set(parsed.codes.map((m) => m.method))
    if (!registerNames.some((n) => names.has(n))) continue
    const touchesBuilder = parsed.codes.some((m) =>
      eventsFor(facts, parsed, m).some((e) => e.k === 'call' && SIMPLE_CHANNELS.has(e.r.owner) && e.r.name === 'messageBuilder'))
    if (touchesBuilder) impls.push(parsed)
  }

  const results = new Set()
  let evidence = null
  let msgClass = null
  for (const impl of impls) {
    const r = deriveFromImpl(facts, impl, chain, channelId)
    if (r) {
      results.add(r.index)
      evidence = r.evidence
      msgClass = r.msgClass
    }
  }
  if (results.size !== 1) {
    if (results.size > 1) debug(`login-ack ${channelId}: builder impls disagree (${[...results].join(',')}) - abstaining`)
    return null
  }
  return { index: [...results][0], msgClass, evidence }
}

function deriveFromImpl (facts, impl, chain, channelId) {
  // count, per method name, how many chain calls register into each list
  const chainCallCounts = new Map()
  for (const c of chain) chainCallCounts.set(c.name, (chainCallCounts.get(c.name) || 0) + 1)

  // which List fields each impl method adds to
  const addsTo = new Map() // method name -> Set(list field keys)
  for (const m of impl.codes) {
    const ev = eventsFor(facts, impl, m)
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]
      if (e.k !== 'call' || e.r.name !== 'add' || !/Ljava\/util\/List;|Ljava\/util\/Collection;/.test(`L${e.r.owner};`)) continue
      const listGet = ev.slice(Math.max(0, i - 12), i).find((x) => x.k === 'get' && x.r.desc === 'Ljava/util/List;')
      if (!listGet) continue
      if (!addsTo.has(m.method)) addsTo.set(m.method, new Set())
      addsTo.get(m.method).add(`${listGet.r.owner}.${listGet.r.name}`)
    }
  }
  const listAddCounts = new Map() // list field -> items added via the chain
  for (const [methodName, lists] of addsTo) {
    for (const list of lists) {
      listAddCounts.set(list, (listAddCounts.get(list) || 0) + (chainCallCounts.get(methodName) || 0))
    }
  }

  // find the terminal method: contains an AtomicInteger.set reset and leads
  // (directly or via same-class calls, depth <=2) to an ack registration
  for (const m of impl.codes) {
    const ev = eventsFor(facts, impl, m)
    // locate reset: get counterField, int k, call AtomicInteger.set
    let reset = null
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]
      if (e.k === 'call' && e.r.owner === ATOMIC_INT && e.r.name === 'set' && e.r.desc === '(I)V') {
        const window = ev.slice(Math.max(0, i - 4), i)
        const fieldGet = window.find((x) => x.k === 'get' && x.r.desc === `L${ATOMIC_INT};`)
        const intArg = window.reverse().find((x) => x.k === 'int')
        if (fieldGet && intArg) reset = { idx: i, counter: `${fieldGet.r.owner}.${fieldGet.r.name}`, value: intArg.v }
        break
      }
    }
    if (!reset) continue

    // walk events after the reset, inlining direct same-class calls
    let usesBefore = 0
    let unprovable = false
    const findAck = (evList, cls, depth) => {
      for (let i = 0; i < evList.length; i++) {
        const e = evList[i]
        if (depth === 0 && i <= reset.idx) continue
        if (e.k === 'call' && e.r.owner === ATOMIC_INT && e.r.name === 'getAndIncrement') {
          const fieldGet = evList.slice(Math.max(0, i - 4), i).reverse().find((x) => x.k === 'get' && x.r.desc === `L${ATOMIC_INT};`)
          if (fieldGet && `${fieldGet.r.owner}.${fieldGet.r.name}` === reset.counter) usesBefore++
          continue
        }
        if (e.k === 'call' && e.r.name === 'forEach') {
          // find the List field being iterated; its contribution is the
          // number of chain-registered items times their per-item counter
          // uses. Chains that added nothing contribute nothing.
          const listGet = evList.slice(Math.max(0, i - 6), i).find((x) => x.k === 'get' && x.r.desc === 'Ljava/util/List;')
          const listKey = listGet ? `${listGet.r.owner}.${listGet.r.name}` : null
          const added = listKey != null ? (listAddCounts.get(listKey) || 0) : null
          if (added == null) { unprovable = true; return null }
          if (added > 0) {
            // per-item counter uses live in invokedynamic lambdas we do not
            // resolve; nonzero contributions are therefore unprovable
            unprovable = true
            return null
          }
          continue
        }
        if (e.k === 'call' && e.r.owner === impl.className && depth < 2) {
          const callee = impl.codes.find((mm) => mm.method === e.r.name)
          if (callee) {
            const found = findAck(eventsFor(facts, impl, callee), impl.className, depth + 1)
            if (found) return found
            if (unprovable) return null
          }
          continue
        }
        if (e.k === 'call' && SIMPLE_CHANNELS.has(e.r.owner) && (e.r.name === 'messageBuilder' || e.r.name === 'registerMessage')) {
          const sites = extractRegSites(evList, cls, '?')
          const site = sites.find((s) => s.evIdx === i)
          if (!site) continue
          // counter uses are already counted when their getAndIncrement event
          // is walked (including this site's own use, which sits BEFORE the
          // call event), so nothing is added here and the ack's own use is
          // subtracted back out of "prior uses"
          const usesCounter = site.index && site.index.counter === reset.counter
          if (usesCounter && site.loginMarked && site.msgClass && hasEmptyEncoder(facts, site.msgClass)) {
            const prior = usesBefore - 1 // exclude the ack's own use
            return { index: reset.value + prior, msgClass: site.msgClass, evidence: `builder ${impl.className}#${m.method} reset ${reset.counter}=${reset.value}, ack after ${prior} prior uses` }
          }
          continue
        }
      }
      return null
    }
    const found = findAck(ev, impl.className, 0)
    if (found && !unprovable) return found
  }
  return null
}

// --- channel-creation discovery --------------------------------------------

function findCreations (facts, hotClasses, ns, pathPart) {
  const creations = []
  for (const parsed of hotClasses) {
    harvestIdentifiers(facts, parsed)
  }
  for (const parsed of hotClasses) {
    for (const m of parsed.codes) {
      const ev = eventsFor(facts, parsed, m)
      for (let i = 0; i < ev.length; i++) {
        const e = ev[i]
        if (e.k !== 'call' || !e.r.desc) continue
        // a call that CONSUMES a ResourceLocation and returns an object
        const takesRL = [...RL_CLASSES].some((rl) => e.r.desc.includes(`L${rl};`) && e.r.desc.indexOf(`L${rl};`) < e.r.desc.indexOf(')'))
        if (!takesRL || !/\)L[^;]+;$/.test(e.r.desc)) continue
        if (e.r.name === '<init>') continue
        const id = rlValueBefore(ev, i, facts)
        if (!id || id.ns !== ns || id.path !== pathPart) continue
        // chain: subsequent calls until the produced value is stored
        const chain = []
        let lastCls = null
        for (let j = i + 1; j < ev.length; j++) {
          const n = ev[j]
          if (n.k === 'cls') lastCls = n.v
          if (n.k === 'call') {
            chain.push({ name: n.r.name, owner: n.r.owner, desc: n.r.desc, classArg: (n.r.desc || '').startsWith('(Ljava/lang/Class;') ? lastCls : null })
            if (lastCls && (n.r.desc || '').includes('Ljava/lang/Class;')) lastCls = null
          }
          if (n.k === 'put') break
        }
        const returned = e.r.desc.slice(e.r.desc.lastIndexOf(')') + 2, -1)
        const isDirectChannel = SIMPLE_CHANNELS.has(returned) || chain.some((c) => c.owner && c.desc && returnsSimpleChannel(c.desc))
        // the channel field the terminal value is stored into (if any)
        let channelField = null
        for (let j = i + 1; j < ev.length; j++) {
          if (ev[j].k === 'put' && isSimpleChannelDesc(ev[j].r.desc)) { channelField = `${ev[j].r.owner}.${ev[j].r.name}`; break }
          if (ev[j].k === 'put') break
        }
        creations.push({ className: parsed.className, method: m.method, direct: isDirectChannel, channelField, chain })
      }
    }
  }
  return creations
}

// --- public API -------------------------------------------------------------

const assessCache = new Map()

/**
 * Statically ASSESSES a mod's wrapped login channel against the local mod
 * jars. This is the verdict ladder the login-phase responders act on:
 *
 *   { verdict: 'ack', index, reply, msgClass, evidence }
 *       The channel's login reply is PROVABLY the mod's own empty-body
 *       acknowledge message; `reply` is the exact inner payload — a single
 *       index byte, because Forge's IndexedMessageCodec frames every
 *       SimpleChannel message as writeByte(index & 0xff) + body (1.20.1
 *       IndexedMessageCodec#build / #consume: readUnsignedByte), and the
 *       login index is context-side only, never on the wire.
 *   { verdict: 'underivable', reason, msgClass?, evidence }
 *       The channel IS created by a local jar, but no correct reply can be
 *       constructed: reason 'substantive-reply' when a login-marked C2S
 *       message provably writes data we cannot reconstruct, else
 *       'no-derivable-ack'. Callers must fail the join honestly — the FML
 *       convention byte (99) is then a KNOWN-wrong guess, and Forge's login
 *       protocol defines no accepted "not understood" answer for wrapped
 *       channels (any undispatched response kicks with
 *       multiplayer.disconnect.unexpected_query_response — 1.20.1
 *       ServerLoginPacketListenerImpl patch + NetworkHooks.onCustomPayload).
 *   { verdict: 'unknown' }
 *       No local jar creates this channel (or no jars are configured); the
 *       caller corroborates against the server's own announced mod list
 *       (HF13, forgeHandshake3.announcedChannelAttribution) — an announced
 *       channel gets the vanilla not-understood decline, only a channel the
 *       announcement doesn't know keeps the least-bad convention default.
 *
 * @param {string} channelId e.g. 'calio:channel'
 * @param {Array.<string>} modsPaths jar files and/or directories of jars
 */
function assessLoginChannel (channelId, modsPaths) {
  const paths = (modsPaths || []).filter(Boolean)
  if (paths.length === 0) return { verdict: 'unknown' }
  const cacheKey = `${paths.join('|')}::${channelId}`
  if (assessCache.has(cacheKey)) return assessCache.get(cacheKey)

  let result = { verdict: 'unknown' }
  const started = Date.now()
  try {
    result = assessUncached(channelId, paths)
  } catch (err) {
    debug(`login-ack assessment for ${channelId} failed (${err.message})`)
  }
  if (result.verdict === 'ack') {
    console.log(`[forge] derived ${channelId} login ack: index ${result.index} (${result.msgClass}; ${result.evidence}; ${Date.now() - started}ms)`)
  } else if (result.verdict === 'underivable') {
    console.log(`[forge] ${channelId} login channel found in local jars but no correct reply is derivable (${result.reason}; ${result.evidence}; ${Date.now() - started}ms)`)
  } else {
    debug(`login-ack derivation for ${channelId}: no local knowledge (${Date.now() - started}ms)`)
  }
  assessCache.set(cacheKey, result)
  return result
}

/**
 * HF12: warm the assessment cache OFF the login path. The receipt's killer
 * reply was ~650ms late because a cold jar-bytecode assessment ran INLINE in
 * the login_plugin_request handler — long enough for the server to complete
 * negotiation and arm compression while the reply was still being computed.
 * The ping already names every mod channel before the connection even
 * starts, so the verdicts can be computed here, one channel per event-loop
 * turn (each assessment itself is synchronous, so chunking keeps the ping ->
 * connect path responsive), leaving the in-handshake lookup a cache hit.
 * Purely an exposure-shrinker: correctness is owned by the reply boundary
 * guard (loginReplyBoundary.js); an unwarmed channel still assesses inline.
 *
 * Infra channels (fml:*, forge:*, minecraft:*) never reach the wrapped-mod
 * resolution ladder and are skipped.
 *
 * @param {Array.<string>} channelIds channel names from the server ping
 * @param {Array.<string>} modsPaths jar files and/or directories of jars
 * @returns {Promise<number>} resolves with the number of channels assessed
 */
function warmLoginAssessments (channelIds, modsPaths) {
  const paths = (modsPaths || []).filter(Boolean)
  const queue = (channelIds || []).filter((ch) =>
    typeof ch === 'string' && ch.includes(':') &&
    !/^(fml|forge|minecraft):/.test(ch))
  if (paths.length === 0 || queue.length === 0) return Promise.resolve(0)
  return new Promise((resolve) => {
    let done = 0
    const step = () => {
      const ch = queue.shift()
      if (!ch) return resolve(done)
      try { assessLoginChannel(ch, paths); done++ } catch { /* inline path still covers it */ }
      setImmediate(step)
    }
    setImmediate(step)
  })
}

/**
 * Back-compat surface: the provable ack reply for `channelId`, or null.
 * Returns { reply: Buffer, index, msgClass, evidence } exactly as before;
 * the richer verdict lives in assessLoginChannel.
 */
function deriveLoginAck (channelId, modsPaths) {
  const a = assessLoginChannel(channelId, modsPaths)
  if (a.verdict !== 'ack') return null
  const { verdict, ...rest } = a
  return rest
}

function assessUncached (channelId, paths) {
  const colon = channelId.indexOf(':')
  if (colon <= 0) return { verdict: 'unknown' }
  const ns = channelId.slice(0, colon)
  const pathPart = channelId.slice(colon + 1)

  const facts = newFacts()
  const hot = []
  const nsNeedle = Buffer.from(ns, 'utf8')
  const pathNeedle = Buffer.from(pathPart, 'utf8')
  for (const p of paths) {
    let jars = []
    try {
      jars = fs.statSync(p).isDirectory()
        ? fs.readdirSync(p).filter((f) => f.endsWith('.jar')).map((f) => path.join(p, f))
        : [p]
    } catch (err) {
      debug(`login-ack scan: source ${p} unreadable (${err.message})`)
      continue
    }
    for (const jar of jars) {
      try {
        indexJar(fs.readFileSync(jar), { jarPath: jar, chain: [] }, facts, 0, nsNeedle, pathNeedle, hot)
      } catch (err) {
        debug(`login-ack scan: skipping ${jar} (${err.message})`)
      }
    }
  }
  if (hot.length === 0) return { verdict: 'unknown' }

  const creations = findCreations(facts, hot, ns, pathPart)
  // Only CHANNEL-class creations count as local knowledge: a direct
  // SimpleChannel stored in a field, or a wrapper-builder chain that
  // registers messages. The same ResourceLocation routinely names other
  // things (dynamic registries, capabilities — origins:origins is a registry
  // key in the same family pack), and treating those as channel knowledge
  // would honest-fail joins the 99 convention may still carry.
  const channelCreations = creations.filter((c) =>
    (c.direct && c.channelField) ||
    (!c.direct && c.chain.some((link) => /^register/i.test(link.name))))
  if (channelCreations.length === 0) return { verdict: 'unknown' }

  for (const creation of channelCreations) {
    let r = null
    if (creation.direct && creation.channelField) {
      r = deriveDirect(facts, creation.channelField, hot, channelId)
    } else if (!creation.direct) {
      r = deriveWrapper(facts, creation, hot, channelId)
    }
    // reply framing per Forge IndexedMessageCodec: writeByte(index & 0xff).
    // An index above 255 cannot be represented distinctly on the wire (Forge
    // itself truncates), so it is unprovable — abstain into 'underivable'.
    if (r && r.index != null && r.index >= 0 && r.index <= 255) {
      return { verdict: 'ack', ...r, reply: Buffer.from([r.index]) }
    }
  }

  // The channel exists in the local jars but no ack reply was proven:
  // classify WHY, so the caller can surface an honest, channel-naming
  // failure instead of guessing.
  const fields = new Set(channelCreations.filter((c) => c.direct && c.channelField).map((c) => c.channelField))
  let substantive = null
  for (const parsed of hot) {
    for (const m of parsed.codes) {
      for (const site of extractRegSites(eventsFor(facts, parsed, m), parsed.className, m.method)) {
        if (!site.channelField || !fields.has(site.channelField)) continue
        if (site.loginMarked && site.msgClass && (!site.direction || site.direction === 'LOGIN_TO_SERVER') &&
            !hasEmptyEncoder(facts, site.msgClass)) {
          substantive = site.msgClass
        }
      }
    }
  }
  return {
    verdict: 'underivable',
    reason: substantive ? 'substantive-reply' : 'no-derivable-ack',
    msgClass: substantive || undefined,
    evidence: `channel is created by a local jar (${channelCreations[0].className}) but no provable login-ack reply exists`
  }
}

module.exports = { deriveLoginAck, assessLoginChannel, warmLoginAssessments, _internal: { extractRegSites, methodEvents, hasEmptyEncoder, counterSeed, resolveLocalIndex, findCreations, newFacts, indexJar, eventsFor } }
