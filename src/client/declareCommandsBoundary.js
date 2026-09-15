'use strict'

const debug = require('debug')('minecraft-protocol-forge')
const { parseCommandTree, readVarInt } = require('./commandTreeParser')

// HF45 — the declare_commands boundary, one for EVERY MinePal connection
// (vanilla, Fabric, Forge, NeoForge). It sits on the play deserializer in
// front of minecraft-protocol: the raw declare_commands frame is read with
// commandTreeParser (vanilla schema + this client's derived argument-type
// table) and only a FULLY consumed, structurally valid tree reaches the
// client as `declare_commands`. Anything else — an unknown parser id, bytes
// left over, a broken root — is DROPPED under `declare_commands_dropped`
// with the receipt {unknown_parser_ids, bytes_unconsumed, nodes_read,
// nodes_declared, ...}, logged once, and stamped on
// client.minepalCommandTree; the client keeps running (nmp's chat.js never
// sees a tree it would reject and end the client over), the tellraw grant
// treats the tree as absent, and no copy claims commands are available.
//
// Why here and not a listener: minecraft-protocol's chat.js handles the
// parsed packet synchronously on 'declare_commands' and ends the client on
// an impossible tree; a listener after it is too late, and nmp's
// process-wide protocol must not be edited for one connection. The
// deserializer hook is the same seam the tolerant play parser and the
// jar-derived wire installs use; it is per client and idempotent.
//
// HF48-P3 — the HOLD (the HF41 ordering law applied to the tree): the
// server sends declare_commands right at play entry, while the argument-type
// table of a modded folder is still being derived in the play-entry scan
// worker (client.minepalCommandArgumentTypes.derived === false with a
// pendingSource). Parsing the frame THEN meets the loader's parser ids with
// no table and drops the whole tree for the session (Forge 1.21.11 + a
// 10-jar pack: 119/193 nodes, unknown 63,58,62, "derived table: none"); a
// tree parsed a few seconds late costs nothing. So the raw frame is KEPT and
// the parse deferred until the table settles (table.whenSettled) or the hold
// budget elapses — then it is parsed with whatever table exists (the budget
// path is today's behaviour, the frame is never lost) and delivered through
// the deserializer's own 'data' path, exactly as an immediate parse would
// be. No derivation pending (vanilla, the bare inline path, a settled
// cache) = no hold, byte-identical behaviour.
//
// The budget: the play-entry scheduler runs ONE worker for the item, body,
// command-argument and knowledge scans in that order and fails every pending
// task at its own 120 s budget (DEFAULT_SCAN_BUDGET_MS), which settles the
// table and releases the hold; HF46 measured 20.5 s for 964 mod files on a
// cold folder. The boundary's own 120 s is the backstop for a scheduler that
// never answers (a worker that died without a receipt): it equals the
// scheduler's budget so the two never disagree about when "late" becomes
// "never", and a frame is parsed by then at the latest.
const DEFAULT_COMMAND_TREE_HOLD_MS = 120000

function declareCommandsId (version) {
  const mcData = require('minecraft-data')(version)
  const mapper = mcData.protocol.play.toClient.types.packet[1][0].type[1]
  for (const [hex, name] of Object.entries(mapper.mappings)) if (name === 'declare_commands') return parseInt(hex, 16)
  return null
}

// HF48-P3 r2 — a hold is keyed to the deserializer that holds its frame:
// when the client leaves play while the frame waits (a configuration
// re-entry, a proxy switch, the connection ending) that frame is stale — the
// server sends a fresh tree at the next play entry on a NEW deserializer —
// so the hold is dropped (counted, logged) and the next frame takes the
// normal path; a held frame is never delivered into another state or an
// ended client, and its timer never outlives the hold.
function dropHold (state, why, log) {
  const h = state.hold
  if (!h) return false
  state.hold = null
  clearTimeout(h.timer)
  state.holdLost += 1
  log(`[command-tree] a held declare_commands frame (${h.buffer.length} bytes, ${Date.now() - h.startedAt} ms) was dropped: ${why}; the server sends a fresh tree at the next play entry`)
  return true
}

function wrap (client, state, log, holdMs) {
  const des = client.deserializer
  if (!des || des._hf45CommandTree) return
  // The packet id is resolved at EVERY play entry from the version the
  // client has THEN, never from install time: a client created with
  // auto-detected version (MinePal settings carry none) holds nmp's default
  // version at creation and the real one only after the status ping
  // (1.21.1: declare_commands is 0x11, on 26.2 it is 0x10 — the install-time
  // id let the 1.21.1 rig's tree walk straight past the boundary).
  state.version = client.version
  state.packetId = null
  try { state.packetId = declareCommandsId(client.version) } catch (err) { debug(`declare_commands id unresolved for ${client.version}: ${err.message}`) }
  if (state.packetId === null) { state.unresolved = (state.unresolved || 0) + 1; state.installed = false; return }
  state.installed = true
  des._hf45CommandTree = true
  const parse = des.parsePacketBuffer.bind(des)

  const finish = (buffer, hold) => {
    const idSize = readVarInt(buffer, 0).size
    const body = buffer.subarray(idSize)
    const table = client.minepalCommandArgumentTypes || null
    const extension = table && table.extension ? table.extension : null
    const res = parseCommandTree(body, client.version, extension)
    const receipt = {
      ...res.receipt,
      frame_bytes: buffer.length,
      held_ms: hold.held_ms,
      released_by: hold.released_by,
      table: table ? { derived: !!table.derived, source: table.source || null, registry_size: table.registrySize || 0, derived_ids: extension ? extension.parsers.map((p) => p.id) : [], abstains: (table.receipt && table.receipt.abstains) || [] } : null
    }
    const holdNote = hold.released_by === 'no-derivation' ? '' : ` after a ${hold.held_ms} ms hold for the argument-type table (released by ${hold.released_by})`
    state.frames += 1
    if (res.ok) {
      client.minepalCommandTree = { parsed: true, dropped: false, ...receipt }
      state.parsed += 1
      if (state.parsed === 1 || receipt.extended_parser_ids.length) {
        const derivedNote = receipt.extended_parser_ids.length
          ? ` using ${receipt.extended_parser_ids.length} derived parser id(s) [${receipt.extended_parser_ids.map((id) => `${id}=${(extension.parsers.find((p) => p.id === id) || {}).name}`).join(' ')}]`
          : ' (vanilla parser table only)'
        log(`[command-tree] declare_commands parsed: ${receipt.nodes_read}/${receipt.nodes_declared} nodes, ${receipt.bytes_total} bytes fully consumed, root ${receipt.root_index}${derivedNote}${holdNote}`)
      }
      return { data: { name: 'declare_commands', params: res.packet }, metadata: { size: buffer.length }, buffer, fullBuffer: buffer }
    }
    client.minepalCommandTree = { parsed: false, dropped: true, ...receipt }
    state.drops += 1
    if (state.drops === 1) {
      const why = receipt.error || (receipt.unknown_parser_ids.length ? `unknown parser ids [${receipt.unknown_parser_ids.join(',')}]` : '') ||
        (receipt.bytes_unconsumed ? `${receipt.bytes_unconsumed} bytes unconsumed` : '') || (receipt.structure ? `structure ${receipt.structure}` : 'unreadable')
      log(`[command-tree] declare_commands DROPPED (${why}; ${receipt.nodes_read}/${receipt.nodes_declared ?? '?'} nodes read, ${receipt.bytes_unconsumed} of ${receipt.bytes_total} bytes unconsumed` +
        `${receipt.unknown_parser_ids.length ? `, unknown parser ids ${receipt.unknown_parser_ids.join(',')}` : ''}` +
        `${receipt.table ? `; derived table: ${receipt.table.derived ? receipt.table.derived_ids.length + ' ids from ' + receipt.table.source : 'none'}` : '; derived table: none'}` +
        `${receipt.table && receipt.table.abstains.length ? `; non-derivable: ${receipt.table.abstains.map((a) => `${a.id}=${a.name}`).join(' ')}` : ''}` +
        `${holdNote}` +
        '): the server\'s command tree is treated as ABSENT for this session (no command availability is assumed)')
    }
    try { client.emit('command_tree_dropped', client.minepalCommandTree) } catch (err) { debug(`command_tree_dropped listener threw: ${err.message}`) }
    return { data: { name: 'declare_commands_dropped', params: client.minepalCommandTree }, metadata: { size: buffer.length }, buffer, fullBuffer: buffer }
  }

  // The hold: keep the raw frame while the table is in flight; release once
  // (settle or budget), parse, and hand the result to the deserializer's
  // 'data' path — the same object shape protodef pushes, so minecraft-
  // protocol's dispatch (packet / name / raw events, bundles) is untouched.
  const hold = (buffer, table) => {
    const h = { startedAt: Date.now(), buffer, des, source: table.pendingSource || null, superseded: 0, timer: null, returned: false, releaseNow: null }
    state.held += 1
    state.hold = h
    log(`[command-tree] declare_commands HELD (${buffer.length} bytes): the command-argument parser table is still being derived off the main thread (${h.source || 'pending'}); the frame waits for the table, at most ${holdMs} ms, then is parsed with whatever table exists`)
    const release = (by) => {
      if (state.hold !== h) return
      if (!h.returned) { h.releaseNow = by; return } // settled inside the hold call: parse in place, no re-entrant delivery
      state.hold = null
      clearTimeout(h.timer)
      const heldMs = Date.now() - h.startedAt
      if (client.deserializer !== des || client.state !== 'play') {
        state.holdLost += 1
        log(`[command-tree] a held declare_commands frame (${h.buffer.length} bytes, ${heldMs} ms) was released after the client left play (${by}); the server sends a fresh tree at the next play entry`)
        return
      }
      const out = finish(h.buffer, { held_ms: heldMs, released_by: by })
      try { des.emit('data', out) } catch (err) { debug(`held declare_commands delivery threw: ${err.message}`) }
    }
    h.timer = setTimeout(() => release('hold-budget'), holdMs)
    try { h.timer.unref?.() } catch { /* not Node */ }
    try { table.whenSettled(() => release('scan-settled')) } catch (err) { debug(`whenSettled threw: ${err.message}`); release('hold-budget') }
    h.returned = true
    if (h.releaseNow) { state.hold = null; clearTimeout(h.timer); return finish(buffer, { held_ms: Date.now() - h.startedAt, released_by: h.releaseNow }) }
    return { data: { name: 'declare_commands_held', params: { frame_bytes: buffer.length, source: h.source, hold_ms: holdMs } }, metadata: { size: buffer.length }, buffer, fullBuffer: buffer }
  }

  des.parsePacketBuffer = (buffer) => {
    let id = -1
    try { id = readVarInt(buffer, 0).value } catch { return parse(buffer) }
    if (id !== state.packetId) return parse(buffer)
    const table = client.minepalCommandArgumentTypes || null
    // a hold left by an EARLIER play deserializer (the client re-entered play
    // while its frame waited) is stale: this frame is the server's fresh tree
    if (state.hold && state.hold.des !== des) dropHold(state, 'the client re-entered play on a new deserializer while it waited', log)
    if (state.hold) {
      // the server re-sent the tree while the first copy waits: the newest
      // copy is the truth, the older one is superseded (counted)
      state.hold.buffer = buffer
      state.hold.superseded += 1
      return { data: { name: 'declare_commands_held', params: { frame_bytes: buffer.length, source: state.hold.source, hold_ms: holdMs, superseded: state.hold.superseded } }, metadata: { size: buffer.length }, buffer, fullBuffer: buffer }
    }
    if (table && !table.derived && table.pendingSource && typeof table.whenSettled === 'function') return hold(buffer, table)
    return finish(buffer, { held_ms: 0, released_by: 'no-derivation' })
  }
}

/**
 * Installs the boundary on a client (idempotent). Reads the derived table
 * from client.minepalCommandArgumentTypes (commandArgumentTypeInstall.js /
 * MinePal's commandArgumentTypesOffLoop) at parse time, so install order
 * does not matter; a table whose derivation is still pending
 * ({derived:false, pendingSource, whenSettled(cb)}) holds the frame.
 * @param {object} client
 * @param {{log?: Function, holdMs?: number}} options
 */
function installDeclareCommandsBoundary (client, { log = console.warn, holdMs = DEFAULT_COMMAND_TREE_HOLD_MS } = {}) {
  if (!client) return null
  if (client._hf45DeclareCommandsBoundary) return client._hf45DeclareCommandsBoundary
  const state = { packetId: null, version: null, frames: 0, drops: 0, parsed: 0, held: 0, holdLost: 0, hold: null, holdMs, installed: false }
  client._hf45DeclareCommandsBoundary = state
  client.on('state', (s) => { if (s === 'play') wrap(client, state, log, holdMs); else dropHold(state, `the client left play (state ${s}) while it waited`, log) })
  client.once('end', () => dropHold(state, 'the client ended while it waited', log))
  if (client.state === 'play') wrap(client, state, log, holdMs)
  return state
}

module.exports = { installDeclareCommandsBoundary, declareCommandsId, DEFAULT_COMMAND_TREE_HOLD_MS }
