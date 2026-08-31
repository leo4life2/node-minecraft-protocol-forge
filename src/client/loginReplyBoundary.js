'use strict'

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
//      (compressor armed, state left login, or connection ended) the reply
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
  if (client.compressor) return 'compression-armed'
  if (typeof client.state === 'string' && client.state !== 'login') return `state-is-${client.state}`
  return null
}

function dropWithReceipt (client, params, context, why) {
  const label = context && context.channel ? `${context.channel} (${context.kind || 'reply'})` : (context && context.kind) || 'login reply'
  console.warn(`[forge] dropped late login reply for ${label} (messageId ${params && params.messageId}): ` +
    `the login negotiation is already over (${why}). Writing it would corrupt the stream — after the server arms ` +
    'compression every serverbound frame must be compression-framed, and a raw login_plugin_response\'s packet id ' +
    'byte (0x02) reads as a bogus compressed-frame data length ("Badly compressed packet - size of 2").')
  if (client) {
    if (!Array.isArray(client.forgeDroppedLoginReplies)) client.forgeDroppedLoginReplies = []
    client.forgeDroppedLoginReplies.push({
      messageId: params ? params.messageId : undefined,
      channel: context && context.channel,
      kind: context && context.kind,
      why
    })
    try { client.emit('forgeLoginReplyDropped', client.forgeDroppedLoginReplies[client.forgeDroppedLoginReplies.length - 1]) } catch { /* receipts never break the path */ }
  }
}

/**
 * Boundary-guarded synchronous login reply. For replies the server provably
 * awaits (fml:handshake lockstep rounds): written immediately unless the end
 * of negotiation has already been observed, in which case the reply is dead
 * and dropped with a receipt.
 */
function writeLoginReplyNow (client, params, context) {
  const why = boundaryObserved(client)
  if (why) {
    dropWithReceipt(client, params, context, why)
    return false
  }
  client.write('login_plugin_response', params)
  return true
}

/**
 * Boundary-guarded deferred login reply, for wrapped-mod-channel and raw
 * mod-channel messages (the class the server may dispatch fire-and-forget).
 * Defers one full event-loop turn so any already-arrived end-of-negotiation
 * evidence (set_compression, login success) is processed first, then applies
 * the same guard.
 */
function writeLoginReplyDeferred (client, params, context) {
  setImmediate(() => setImmediate(() => { writeLoginReplyNow(client, params, context) }))
}

module.exports = { writeLoginReplyNow, writeLoginReplyDeferred, boundaryObserved }
