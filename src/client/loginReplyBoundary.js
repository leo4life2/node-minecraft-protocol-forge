'use strict'

// HF36 + HF38 — ONE login-reply boundary (unified 2026-09-06).
//
// Every login query the rails receive is filed in the login-window ledger
// (loginWindow.js) on arrival, and every reply — lockstep round, table
// reply, jar-derived ack, HF8/HF13 decline, HF23 acquisition rung, HF36
// convention ack, raw-channel reply, HF38 budget decline — passes THIS
// write site. The ledger is the one place that knows which queries are
// still owed, so three laws are enforced here and nowhere else:
//   P4 (HF36) — exactly one login_plugin_response per PENDING query, in
//     order: a reply for an id nobody asked (unknown transaction), for an
//     id already closed (a second organ, a late acquisition rung racing the
//     synchronous ladder, a budget decline that already went out), or after
//     the negotiation observably ended, is refused with a receipt. Vanilla
//     and every FML era kick a stray or repeated answer as
//     multiplayer.disconnect.unexpected_query_response. Entries are keyed
//     by id AND open-order (a Kilt host restarts Fabric's query counter at
//     0 after the Forge handshake, so the same id names two distinct
//     queries in one login): a reply settles the most recent OPEN entry
//     with its id and is refused only when none is open.
//   THE WINDOW (HF38) — every query carries a deadline derived from the
//     server's 600-tick login clock; the ledger closes a still-open query
//     at its deadline (loginWindow.expire) through this same site.
//   THE ARMING BOUNDARY (HF12, bounded by HF38) — a fire-and-forget-capable
//     reply is deferred so already-arrived end-of-login evidence is read
//     first; after set_compression it is held until the next inbound packet
//     or a short bound (see writeLoginReplyDeferred) so it can never land in
//     PLAY.
// Fail-open by construction: a client no rail installed the ledger on (an
// embedder writing through this boundary on its own) keeps the pre-ledger
// behavior — only the arming boundary guards it.
const loginWindow = require('./loginWindow')

// HF12 — the login-reply / compression-arming boundary law.
//
// THE RECEIPT (2026-08-30 rig, Forge 1.20.1-47.2.0 + TACZ + tacztweaks,
// network-compression-threshold=256): the FULL modded login completed, the
// server logged "Pioneer27A joined the game" — and ~650ms later kicked with
//   io.netty.handler.codec.DecoderException: Badly compressed packet -
//   size of 2 is below server threshold of 256
// on every join attempt (a join -> 1s -> drop rejoin loop).
//
// ADJUDICATION (wire-derived): "size of 2" is NOT a compressed 2-byte packet.
// Our own Compressor can never emit a frame whose first byte is 0x02 — its
// frames start with either 0x00 (data-length 0, sub-threshold body, the
// framing law's uncompressed marker) or a varint >= the threshold (>= 0x80+
// lead byte for 256). The killer frame was a RAW, login-state
// login_plugin_response — vanilla packet id 0x02 — whose id byte the
// server's armed CompressionDecoder read as the compressed-frame
// data-length varint: "size of 2".
//
// HOW a raw login reply lands on an armed decoder: Forge's login wrapper
// (LoginWrapper.java: wrapped custom login channels dispatched over vanilla
// login_plugin_request) carries messages the server does NOT await —
// fire-and-forget dispatches (HandshakeHandler "ticking packet info"
// messages registered without needsResponse; the live server ERROR-logs
// "Recieved unexpected index 0 in client reply" for our unsolicited ModData
// ack and tolerates it). When such a message is dispatched near the END of
// negotiation, the server completes the login WITHOUT our reply, arms its
// serverbound CompressionDecoder (vanilla handleAcceptedLogin sends
// set_compression), and places the player — while our reply is still being
// computed (in the receipt: ~650ms of cold-cache jar bytecode assessment for
// tacztweaks:handshake's decline) or still in flight. The reply was framed
// raw because at write time the client had not yet READ the set_compression
// packet sitting behind the request in its inbound buffer. Framing is
// regime-dependent and the regime flips at server-send time, so no byte
// string parses correctly under both regimes: a reply that crosses the
// arming boundary is unfixable in flight — it must not be written at all.
//
// THE LAW, two mechanisms:
//   1. writeLoginReplyNow — every login reply passes a boundary guard at
//      write time: once the client has OBSERVED the end of negotiation
//      (state left login, or connection ended — NOT a mere armed compressor,
//      see boundaryObserved / HF38) the reply
//      is dead — the server provably completed without it — and is dropped
//      with a receipt instead of corrupting the stream. Used directly for
//      the fml:handshake lockstep rounds (ModListReply, registry/config
//      acks): the server awaits those, cannot complete while waiting, so a
//      synchronous write is always pre-boundary.
//   2. writeLoginReplyDeferred — wrapped-MOD-channel and raw-channel
//      replies (the fire-and-forget-capable class) are written only after
//      one full event-loop turn (two setImmediate hops: check phase, then a
//      poll that surfaces any kernel-buffered inbound, then check again).
//      Any already-arrived set_compression / login success is processed in
//      that turn, the guard in (1) then observes the boundary, and the dead
//      reply is dropped — the receipt's exact shape. A reply the server IS
//      awaiting loses ~a millisecond and nothing else (the server is
//      blocked on us; the boundary cannot arm meanwhile).
//
// Residual, stated honestly: a reply written pre-boundary can still cross
// an arming that happens within one wire RTT of the write. The reference
// client shares the ordering discipline but never replies unsolicited, so
// its exposure is zero; ours is bounded by reply latency — which
// loginAckDerivation.warmLoginAssessments collapses to ~0 by precomputing
// jar verdicts off the login path. Distinguishing awaited from
// fire-and-forget messages on the wire is impossible (needsResponse is a
// server-side registration fact, not a wire fact).

function boundaryObserved (client) {
  if (!client) return 'no-client'
  // Only POSITIVE wire evidence may kill a reply (fail-open toward the HF8
  // behavior): nmp's Client uses a strict-boolean lifecycle flag
  // (constructor true, setSocket false, endSocket true), always has a string
  // state, and sets `compressor` non-null exactly when it has processed
  // set_compression. Absent fields on an embedder's client are no evidence.
  if (client.ended === true) return 'connection-ended'
  if (typeof client.state === 'string' && client.state !== 'login') return `state-is-${client.state}`
  // HF38: an ARMED compressor is NOT end-of-negotiation evidence. Once the
  // client has processed set_compression, nmp routes the login serializer
  // through the compressor (client.js setCompressionThreshold), so a reply
  // written now is compression-framed — exactly what the server's armed
  // decoder expects — and the server may still be inside login AWAITING it:
  // Fabric API's login queries (fabric-networking-api-v1:early_registration,
  // fabric:custom_ingredient_sync — a Fabric host under Kilt/Connector, or
  // FFAPI on Forge) are sent from handleAcceptedLogin AFTER set_compression
  // and hold the accept until answered. Dropping the reply there left the
  // query unanswered and the server kicked slow_login at its 600-tick clock
  // (join_diagnostics aa3a19f3, Kilt 20.1.14 rig 2026-09-06: 2/2 reproduced,
  // 0/2 after this change). The HF12 kill-shot (a RAW frame onto an armed
  // decoder) is a write made BEFORE the client observed set_compression —
  // that is what the deferred write cures — never a write made after.
  return null
}

function compressionArmed (client) {
  // nmp: `compressor` is non-null exactly when set_compression was processed
  return !!(client && client.compressor)
}

function labelOf (params, context) {
  return context && context.channel ? `${context.channel} (${context.kind || 'reply'})` : (context && context.kind) || 'login reply'
}

function receipt (client, params, context, why) {
  if (!client) return
  if (!Array.isArray(client.forgeDroppedLoginReplies)) client.forgeDroppedLoginReplies = []
  client.forgeDroppedLoginReplies.push({
    messageId: params ? params.messageId : undefined,
    channel: context && context.channel,
    kind: context && context.kind,
    why
  })
  try { client.emit('forgeLoginReplyDropped', client.forgeDroppedLoginReplies[client.forgeDroppedLoginReplies.length - 1]) } catch { /* receipts never break the path */ }
}

// A reply the negotiation's end made dead (HF12 / HF38 rider): the query it
// answered is settled `dropped` in the ledger — it was owed and never
// reached the wire. Two ways in: the ledger already closed the window and
// filed the query unanswered-at-close before this reply was ready (the
// late-reply path: the entry is re-settled to dropped, still ONE verdict),
// or — with no ledger installed (bare embedder) — the wire evidence alone.
function dropWithReceipt (client, params, context, why) {
  console.warn(`[forge] dropped late login reply for ${labelOf(params, context)} (messageId ${params && params.messageId}): ` +
    `the login negotiation is already over (${why}) — the reply was ready after the server closed the login window. ` +
    'Writing it now would put a login_plugin_response (0x02) on the wire outside login, where the server reads that id ' +
    'as a different packet (a bogus PLAY frame, or on an armed decoder a bogus compressed-frame length: "Badly compressed packet - size of 2").')
  receipt(client, params, context, why)
  if (!loginWindow.noteLateReply(client, params, context, why)) loginWindow.noteReply(client, params, context, 'dropped', why)
}

// A reply the LEDGER refuses (HF36 P4): no query is owed for this id — the
// entry's own verdict stands; this write is filed as refused, never as a
// second verdict.
function refuseWithReceipt (client, params, context, why) {
  console.warn(`[forge] refused login reply for ${labelOf(params, context)} (messageId ${params && params.messageId}): ${why}. ` +
    'A login_plugin_response must carry the id of a query still awaiting its answer, exactly once — every server ' +
    '(vanilla and every FML era) kicks a stray or repeated answer as multiplayer.disconnect.unexpected_query_response.')
  receipt(client, params, context, why)
  loginWindow.noteRefused(client, params, context, why)
}

/**
 * HF36 — registers a login query the rails received (idempotent against the
 * ledger's own arrival listener: returns the OPEN entry for this id when one
 * exists, files a new one otherwise). Null when no ledger is installed on
 * the client (fail-open: the boundary then guards only the arming law).
 */
function registerLoginQuery (client, messageId, context) {
  if (!client || !Number.isInteger(messageId)) return null
  if (!loginWindow.installed(client)) return null
  return loginWindow.openEntry(client, messageId) || loginWindow.noteQuery(client, { messageId, channel: context && context.channel })
}

/**
 * Boundary-guarded synchronous login reply. For replies the server provably
 * awaits (fml:handshake lockstep rounds): written immediately unless the
 * ledger refuses it or the end of negotiation has already been observed.
 */
function writeLoginReplyNow (client, params, context) {
  const messageId = params && params.messageId
  if (loginWindow.installed(client)) {
    // P4: one reply per PENDING query id. The most recent open entry with
    // this id is the one being answered; none open = nothing is owed.
    if (!loginWindow.openEntry(client, messageId, context)) {
      const prior = loginWindow.priorVerdict(client, messageId)
      // HF38 rider (verify MED): the window closed (success / state / end)
      // before this reply was ready — the ledger filed the query
      // unanswered-at-close. No first reply ever existed, so this is a LATE
      // reply, never a duplicate: dropped with a receipt naming what ended
      // the window, and the query's verdict becomes `dropped` (one verdict).
      if (prior && prior.outcome === 'unanswered-at-close') {
        dropWithReceipt(client, params, context, `late-reply: window closed (endedBy=${loginWindow.windowEndedBy(client) || boundaryObserved(client) || 'unknown'})`)
        return false
      }
      const why = prior
        ? `duplicate-reply: already-closed-${prior.outcome}${prior.kind ? ` (first answered by ${prior.kind})` : ''}`
        : 'unknown-transaction'
      refuseWithReceipt(client, params, context, why)
      return false
    }
  }
  // With a ledger installed the window closes on the same success / state /
  // end events this reads, so an OPEN entry here implies no boundary yet;
  // this drop is the fail-open guard for a client without a ledger.
  const why = boundaryObserved(client)
  if (why) {
    dropWithReceipt(client, params, context, why)
    return false
  }
  client.write('login_plugin_response', params)
  loginWindow.noteReply(client, params, context, 'written')
  return true
}

// HF38 MED-4: after set_compression a deferred reply is held until the next
// inbound packet has been processed (login success flips the state and the
// guard drops the reply; a further login query proves the server is still
// inside login) or this bound elapses (the server is blocked on us: an
// awaited post-compression query — Fabric API on Kilt — receives its reply
// at most this late). Two event-loop hops were not a bound: a success packet
// already in the kernel buffer could be parsed AFTER the hops, and a reply
// to a non-awaited wrapped message then landed in PLAY as packet 0x02.
const POST_COMPRESSION_HOLD_MS = 100

function afterNextInboundOrBound (client, ms, fn) {
  let done = false
  let timer = null
  const fire = () => {
    if (done) return
    done = true
    if (timer) clearTimeout(timer)
    if (typeof client.removeListener === 'function') client.removeListener('packet', onPacket)
    // the named packet handler (success -> state play) runs in the same
    // synchronous emit frame as 'packet'; write only after it has
    setImmediate(fn)
  }
  function onPacket () { fire() }
  if (typeof client.once === 'function') client.once('packet', onPacket)
  timer = setTimeout(fire, ms)
}

/**
 * Boundary-guarded deferred login reply, for wrapped-mod-channel and raw
 * mod-channel messages (the class the server may dispatch fire-and-forget).
 * Defers one full event-loop turn so any already-arrived end-of-negotiation
 * evidence (set_compression, login success) is processed first; once
 * compression is armed, holds until the next inbound packet or a short
 * bound; then applies the same guard as writeLoginReplyNow.
 */
function writeLoginReplyDeferred (client, params, context) {
  setImmediate(() => setImmediate(() => {
    // hold only while the outcome is still undecided: an already-observed
    // end of login (success / end processed during the hops) drops now
    if (compressionArmed(client) && !boundaryObserved(client)) afterNextInboundOrBound(client, POST_COMPRESSION_HOLD_MS, () => writeLoginReplyNow(client, params, context))
    else writeLoginReplyNow(client, params, context)
  }))
}

module.exports = { writeLoginReplyNow, writeLoginReplyDeferred, boundaryObserved, registerLoginQuery, POST_COMPRESSION_HOLD_MS }
