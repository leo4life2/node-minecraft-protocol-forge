const debug = require('debug')('minecraft-protocol-forge')

// HF38 — THE LOGIN WINDOW IS THE SERVER'S CLOCK.
//
// Vanilla law (ServerLoginPacketListenerImpl, every era since 1.13 and the
// same 600 on 1.20.1 / Fabric / Kilt / NeoForge): the login listener ticks
// from the moment it exists — the handshake intent, a few ms before our
// login_start — and at MAX_TICKS_BEFORE_LOGIN = 600 ticks (30 s at 20 TPS;
// a lagging server only lengthens it) disconnects with
// multiplayer.disconnect.slow_login. NOTHING we do on the client extends it.
// Every login_plugin_request the server awaits therefore carries an implicit
// deadline: reply — or honestly decline — before the server's clock fires,
// and NEVER leave a query pending. Receipt: join_diagnostics aa3a19f3 (a
// Fabric 1.20.1 host under Kilt): two Fabric API login queries arrived after
// set_compression, our replies were dropped, the server waited 26.9 s and
// kicked slow_login at 600 ticks — 30.1 s after login_start, twice, cold
// and warm. Nobody had a clock; this module is the clock.
//
// ONE mechanism (no per-mod branch), three jobs:
//   1. THE LEDGER — every login query is recorded on arrival (channel,
//      arrival offset from login_start) and closed by exactly one verdict
//      (answered / declined / dropped / budget-declined / budget-ended /
//      honest-stop / deadline-law / unanswered-at-close) with its reply
//      latency and the derivation that produced it (name + ms). The reply
//      boundary (loginReplyBoundary.js) files the verdicts; a SECOND reply
//      for an already-closed query is refused there (the vanilla server
//      kicks unexpected_query_response on an unknown/duplicate id).
//   2. THE BUDGET — each query gets a bounded reply deadline derived from
//      the window: min(arrival + queryBudgetMs, login_start + windowMs −
//      safetyMs). A query still open at its deadline is closed HONESTLY:
//      a raw mod channel gets the protocol's not-understood decline (what
//      the reference client answers for a channel it cannot speak — P4);
//      a loginwrapper-wrapped Forge channel, for which the protocol defines
//      no accepted decline, ends the connection OURSELVES with a typed fact
//      naming the derivation and how long it ran (P5) — never the server's
//      anonymous slow_login. Synchronous derivations cannot be pre-empted
//      by a timer (the event loop is theirs); they are TIMED and their ms
//      ride the ledger, and the pre-login warm-up (loginAckDerivation.
//      warmLoginAssessments + the embedder's persistent cache) is what
//      keeps them off the login path.
//   3. THE TIMELINE — one summary line at the end of login (success, state
//      change, or close) with the counts, the slowest reply, total
//      derivation ms and the window used; loginWindowSummary(client) is the
//      JSON-safe snapshot the embedder files in its receipts.

const DEFAULT_WINDOW_TICKS = 600 // ServerLoginPacketListenerImpl.MAX_TICKS_BEFORE_LOGIN
const TICK_MS = 50
const DEFAULT_SAFETY_MS = 5000 // the reply must be ON the wire before the clock fires
const DEFAULT_QUERY_BUDGET_MS = 18000 // one query never eats the whole window (= the HF23 acquisition budget)
const MIN_BUDGET_MS = 250

// 'no-reply-expected': a message the protocol answers with SILENCE (FML3
// S2CModData — the reference client sends nothing; HF12 receipt) — closed
// in the ledger so it is never "pending" and never budget-stopped.
const TERMINAL = new Set(['answered', 'declined', 'dropped', 'budget-declined', 'budget-ended', 'honest-stop', 'deadline-law', 'no-reply-expected', 'unanswered-at-close'])

function positive (v, dflt) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : dflt }
function nonneg (v, dflt) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : dflt }

function ledgerOf (client) {
  return client && client.forgeLoginWindow && client.forgeLoginWindow.installed ? client.forgeLoginWindow : null
}

/**
 * Installs the window on a client (idempotent). Called by every login-phase
 * handshake handler at install time — BEFORE its own login_plugin_request
 * listener, so the ledger entry exists when the handler answers.
 *
 * options: loginWindowTicks (600), loginWindowSafetyMs (5000),
 *          loginQueryBudgetMs (18000), now (clock seam for tests)
 */
function installLoginWindow (client, options) {
  if (!client || typeof client.on !== 'function') return null
  if (ledgerOf(client)) return client.forgeLoginWindow
  const o = options || {}
  const ticks = positive(o.loginWindowTicks, DEFAULT_WINDOW_TICKS)
  const w = {
    installed: true,
    ticks,
    tickMs: TICK_MS,
    windowMs: ticks * TICK_MS,
    safetyMs: nonneg(o.loginWindowSafetyMs, DEFAULT_SAFETY_MS),
    queryBudgetMs: positive(o.loginQueryBudgetMs, DEFAULT_QUERY_BUDGET_MS),
    now: typeof o.now === 'function' ? o.now : Date.now,
    startAt: null,
    startedBy: null,
    endedAt: null,
    endedBy: null,
    queries: [],
    byId: new Map(),
    budgetStops: [],
    derivationMs: 0
  }
  client.forgeLoginWindow = w
  client.forgeLoginWindowSummary = () => loginWindowSummary(client)
  const start = (by) => { if (w.startAt == null) { w.startAt = w.now(); w.startedBy = by; debug(`login window opened (${by}): ${w.ticks} ticks = ${w.windowMs} ms`) } }
  // nmp sets state = login immediately before writing login_start
  // (client/setProtocol.js) and emits 'state' from the setter.
  if (client.state === 'login') start('installed-in-login')
  client.on('state', (s) => {
    if (s === 'login') start('state-login')
    else if (w.startAt != null && w.endedAt == null && (s === 'play' || s === 'configuration')) closeWindow(client, `state-${s}`)
  })
  client.on('success', () => closeWindow(client, 'login-success'))
  client.on('end', () => closeWindow(client, 'connection-ended'))
  client.on('login_plugin_request', (packet) => noteQuery(client, packet))
  return w
}

function noteQuery (client, packet) {
  const w = ledgerOf(client)
  if (!w || !packet || w.endedAt != null) return null
  if (w.startAt == null) { w.startAt = w.now(); w.startedBy = 'first-query' }
  const now = w.now()
  const windowEdge = w.startAt + w.windowMs - w.safetyMs
  const deadlineAt = Math.max(now + MIN_BUDGET_MS, Math.min(now + w.queryBudgetMs, windowEdge))
  const entry = {
    messageId: packet.messageId,
    channel: packet.channel,
    innerChannel: null,
    wrapped: packet.channel === 'fml:loginwrapper',
    arrivedAt: now,
    sinceLoginStartMs: now - w.startAt,
    deadlineAt,
    budgetMs: deadlineAt - now,
    answeredAt: null,
    latencyMs: null,
    outcome: null,
    kind: null,
    why: null,
    derivation: null,
    timer: null
  }
  entry.timer = setTimeout(() => expire(client, entry), deadlineAt - now)
  if (entry.timer.unref) entry.timer.unref()
  w.queries.push(entry)
  w.byId.set(entry.messageId, entry)
  return entry
}

function entryOf (client, messageId) {
  const w = ledgerOf(client)
  return w && messageId != null ? (w.byId.get(messageId) || null) : null
}

/** The inner (wrapped) channel once the handler has parsed the wrapper. */
function noteInnerChannel (client, messageId, innerChannel) {
  const e = entryOf(client, messageId)
  if (e && typeof innerChannel === 'string') e.innerChannel = innerChannel
}

function settle (e, w, outcome, extra) {
  if (!e || e.outcome) return false // first verdict wins
  e.outcome = outcome
  e.answeredAt = w.now()
  // latency is a REPLY fact: a silence-by-protocol message and a query still
  // open at close have none (their "latency" would be the login's length)
  e.latencyMs = e.arrivedAt != null && outcome !== 'no-reply-expected' && outcome !== 'unanswered-at-close' ? e.answeredAt - e.arrivedAt : null
  if (extra) Object.assign(e, extra)
  if (e.derivation && !e.derivation.done) { e.derivation.done = true; e.derivation.ms = e.answeredAt - e.derivation.startedAt; w.derivationMs += e.derivation.ms }
  if (e.timer) { clearTimeout(e.timer); e.timer = null }
  return true
}

/**
 * Filed by the reply boundary: `written` (answered / declined by the shape
 * of params — data present or not) or `dropped` (with why). Unknown ids
 * (a reply the ledger never saw arrive) get a synthetic entry so the
 * timeline stays complete.
 */
function noteReply (client, params, context, disposition, why) {
  const w = ledgerOf(client)
  if (!w || !params) return
  let e = w.byId.get(params.messageId)
  if (!e) {
    e = { messageId: params.messageId, channel: context && context.channel, innerChannel: null, wrapped: false, arrivedAt: null, sinceLoginStartMs: null, deadlineAt: null, budgetMs: null, answeredAt: null, latencyMs: null, outcome: null, kind: null, why: null, derivation: null, timer: null, unsolicited: true }
    w.queries.push(e)
    w.byId.set(e.messageId, e)
  }
  const kind = context && context.kind
  if (disposition === 'dropped') { settle(e, w, 'dropped', { kind, why: why || null }); return }
  if (context && context.budget) { settle(e, w, 'budget-declined', { kind }); return }
  settle(e, w, params.data == null ? 'declined' : 'answered', { kind })
}

/** A typed stop the handler took instead of a reply (honest-stop / deadline-law). */
function noteStop (client, messageId, outcome, why) {
  const w = ledgerOf(client)
  const e = entryOf(client, messageId)
  if (w && e) settle(e, w, outcome, { why: why || null })
}

/** The verdict already filed for a message id, or null while it is open. */
function priorVerdict (client, messageId) {
  const e = entryOf(client, messageId)
  return e && e.outcome && TERMINAL.has(e.outcome) ? e.outcome : null
}

/** Times a SYNCHRONOUS derivation for a query and files name + ms on its entry. */
function timeDerivation (client, messageId, name, fn) {
  const w = ledgerOf(client)
  const e = entryOf(client, messageId)
  const t0 = w ? w.now() : Date.now()
  try {
    return fn()
  } finally {
    const ms = (w ? w.now() : Date.now()) - t0
    if (w) w.derivationMs += ms
    if (e && !e.derivation) e.derivation = { name, startedAt: t0, ms, done: true }
    else if (e) { e.derivation.name = `${e.derivation.name}; ${name}`; e.derivation.ms = (e.derivation.ms || 0) + ms }
    if (ms >= 100) console.log(`[forge] login derivation "${name}" took ${ms} ms on the login path (query messageId ${messageId})`)
  }
}

/** An ASYNCHRONOUS derivation (announced-mod acquisition) now owns the reply. */
function noteAsyncDerivation (client, messageId, name) {
  const w = ledgerOf(client)
  const e = entryOf(client, messageId)
  if (w && e) e.derivation = { name, startedAt: w.now(), ms: null, done: false }
}

/** Milliseconds this query may still take before its deadline (null = unknown query). */
function replyBudgetMs (client, messageId) {
  const w = ledgerOf(client)
  const e = entryOf(client, messageId)
  if (!w || !e || e.deadlineAt == null) return null
  return Math.max(0, e.deadlineAt - w.now())
}

/** Same, for the OPEN query on a wrapped channel (the acquisition rung knows the channel, not the id). */
function replyBudgetMsForChannel (client, channel) {
  const w = ledgerOf(client)
  if (!w || typeof channel !== 'string') return null
  for (let i = w.queries.length - 1; i >= 0; i--) {
    const e = w.queries[i]
    if (!e.outcome && e.deadlineAt != null && (e.innerChannel === channel || e.channel === channel)) return Math.max(0, e.deadlineAt - w.now())
  }
  return null
}

function describeDerivation (e, now) {
  if (!e.derivation) return 'no derivation was started for it'
  const d = e.derivation
  return d.done ? `${d.name} took ${d.ms} ms` : `${d.name} still running after ${now - d.startedAt} ms`
}

function expire (client, e) {
  const w = ledgerOf(client)
  if (!w || e.outcome || w.endedAt != null) return
  const now = w.now()
  const channel = e.innerChannel || e.channel
  const waitedMs = now - e.arrivedAt
  const remainingMs = Math.max(0, w.startAt + w.windowMs - now)
  const derivation = describeDerivation(e, now)
  const fact = {
    verdict: 'login-window-budget-expired',
    messageId: e.messageId,
    channel,
    wrapped: e.wrapped,
    waitedMs,
    budgetMs: e.budgetMs,
    sinceLoginStartMs: now - w.startAt,
    windowMs: w.windowMs,
    windowTicks: w.ticks,
    windowRemainingMs: remainingMs,
    derivation: e.derivation ? { name: e.derivation.name, ms: e.derivation.done ? e.derivation.ms : now - e.derivation.startedAt, done: !!e.derivation.done } : null,
    action: e.wrapped ? 'ended' : 'declined'
  }
  w.budgetStops.push(fact)
  if (!e.wrapped) {
    console.warn(`[forge] login-window budget: the login query on ${channel} (messageId ${e.messageId}) has waited ${waitedMs} ms of its ${e.budgetMs} ms budget (${derivation}); ` +
      `the server's ${w.ticks}-tick login window closes in ${remainingMs} ms — answering the protocol's not-understood decline now rather than leaving it pending for the server's slow_login clock.`)
    const { writeLoginReplyNow } = require('./loginReplyBoundary')
    writeLoginReplyNow(client, { messageId: e.messageId }, { channel, kind: 'budget decline (login-window)', budget: true })
  } else {
    const message = `Cannot answer the modded login check on channel "${channel}" inside the server's login window: ${derivation}; ` +
      `the query has waited ${waitedMs} ms of its ${e.budgetMs} ms budget and the server's ${w.ticks}-tick window closes in ${remainingMs} ms. ` +
      'Join stopped honestly (no guessed reply, and not the server\'s anonymous slow_login kick).'
    console.error(`[forge] ${message}`)
    settle(e, w, 'budget-ended', { kind: 'budget stop (login-window)' })
    client.forgeLoginWindowBudget = fact
    try { if (typeof client.end === 'function') client.end(message) } catch (err) { debug(`ending the connection failed (${err.message})`) }
  }
  try { client.emit('forgeLoginWindowBudget', fact) } catch { /* receipts never break the path */ }
}

function closeWindow (client, by) {
  const w = ledgerOf(client)
  if (!w || w.endedAt != null) return
  if (w.startAt == null && w.queries.length === 0) return // never opened — nothing to say
  w.endedAt = w.now()
  w.endedBy = by
  for (const e of w.queries) {
    if (e.timer) { clearTimeout(e.timer); e.timer = null }
    if (!e.outcome) settle(e, w, 'unanswered-at-close', { why: by })
  }
  const s = loginWindowSummary(client)
  const slow = s.slowest ? ` slowest reply ${s.slowest.latencyMs} ms (${s.slowest.channel})` : ''
  const pre = s.prelogin ? `; pre-login derivation ${s.prelogin.assessed} channel(s) in ${s.prelogin.ms} ms (${s.prelogin.fromCache} from the persistent cache)` : ''
  const open = s.unansweredAtClose.length > 0 ? `; UNANSWERED at close: ${s.unansweredAtClose.join(', ')}` : ''
  console.log(`[forge] login window (${by}): ${s.queries.length} login quer${s.queries.length === 1 ? 'y' : 'ies'} in ${s.elapsedMs} ms of the ${w.windowMs} ms window; ` +
    `${s.counts.answered} answered, ${s.counts.declined} declined, ${s.counts.dropped} dropped, ${s.counts.budget} budget-stopped;${slow}; derivation ${w.derivationMs} ms on the login path${pre}${open}`)
}

/** JSON-safe snapshot: names, counts, timings — never a body. */
function loginWindowSummary (client) {
  const w = ledgerOf(client)
  if (!w) return null
  const now = w.endedAt != null ? w.endedAt : w.now()
  const counts = { answered: 0, declined: 0, dropped: 0, budget: 0, stopped: 0, unanswered: 0, noReply: 0, open: 0 }
  let slowest = null
  const queries = w.queries.map((e) => {
    if (e.outcome === 'answered') counts.answered++
    else if (e.outcome === 'declined') counts.declined++
    else if (e.outcome === 'dropped') counts.dropped++
    else if (e.outcome === 'budget-declined' || e.outcome === 'budget-ended') counts.budget++
    else if (e.outcome === 'honest-stop' || e.outcome === 'deadline-law') counts.stopped++
    else if (e.outcome === 'unanswered-at-close') counts.unanswered++
    else if (e.outcome === 'no-reply-expected') counts.noReply++
    else counts.open++
    if (e.latencyMs != null && (!slowest || e.latencyMs > slowest.latencyMs)) slowest = { channel: e.innerChannel || e.channel, latencyMs: e.latencyMs, messageId: e.messageId }
    return {
      messageId: e.messageId,
      channel: e.innerChannel || e.channel,
      wrapped: e.wrapped,
      sinceLoginStartMs: e.sinceLoginStartMs,
      latencyMs: e.latencyMs,
      budgetMs: e.budgetMs,
      outcome: e.outcome,
      kind: e.kind,
      why: e.why,
      derivation: e.derivation ? { name: e.derivation.name, ms: e.derivation.done ? e.derivation.ms : now - e.derivation.startedAt, done: !!e.derivation.done } : null
    }
  })
  const pre = client.forgePreloginDerivation || null
  return {
    windowTicks: w.ticks,
    windowMs: w.windowMs,
    safetyMs: w.safetyMs,
    queryBudgetMs: w.queryBudgetMs,
    startAt: w.startAt,
    startedBy: w.startedBy,
    endedAt: w.endedAt,
    endedBy: w.endedBy,
    elapsedMs: w.startAt != null ? now - w.startAt : null,
    queries,
    counts,
    slowest,
    derivationMs: w.derivationMs,
    unansweredAtClose: queries.filter((q) => q.outcome === 'unanswered-at-close' || q.outcome == null).map((q) => q.channel),
    budgetStops: w.budgetStops.map((f) => ({ channel: f.channel, action: f.action, waitedMs: f.waitedMs, budgetMs: f.budgetMs, derivation: f.derivation })),
    prelogin: pre ? { assessed: pre.assessed, ms: pre.ms, fromCache: pre.fromCache, finishedBeforeLoginStart: pre.finishedBeforeLoginStart } : null
  }
}

module.exports = {
  installLoginWindow,
  noteQuery,
  noteInnerChannel,
  noteReply,
  noteStop,
  priorVerdict,
  timeDerivation,
  noteAsyncDerivation,
  replyBudgetMs,
  replyBudgetMsForChannel,
  loginWindowSummary,
  closeWindow,
  DEFAULT_WINDOW_TICKS,
  DEFAULT_SAFETY_MS,
  DEFAULT_QUERY_BUDGET_MS
}
