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

function declareCommandsId (version) {
  const mcData = require('minecraft-data')(version)
  const mapper = mcData.protocol.play.toClient.types.packet[1][0].type[1]
  for (const [hex, name] of Object.entries(mapper.mappings)) if (name === 'declare_commands') return parseInt(hex, 16)
  return null
}

function wrap (client, state, log) {
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
  des.parsePacketBuffer = (buffer) => {
    let id = -1
    try { id = readVarInt(buffer, 0).value } catch { return parse(buffer) }
    if (id !== state.packetId) return parse(buffer)
    const idSize = readVarInt(buffer, 0).size
    const body = buffer.subarray(idSize)
    const table = client.minepalCommandArgumentTypes || null
    const extension = table && table.extension ? table.extension : null
    const res = parseCommandTree(body, client.version, extension)
    const receipt = {
      ...res.receipt,
      frame_bytes: buffer.length,
      table: table ? { derived: !!table.derived, source: table.source || null, registry_size: table.registrySize || 0, derived_ids: extension ? extension.parsers.map((p) => p.id) : [], abstains: (table.receipt && table.receipt.abstains) || [] } : null
    }
    state.frames += 1
    if (res.ok) {
      client.minepalCommandTree = { parsed: true, dropped: false, ...receipt }
      state.parsed += 1
      if (state.parsed === 1 || receipt.extended_parser_ids.length) {
        const derivedNote = receipt.extended_parser_ids.length
          ? ` using ${receipt.extended_parser_ids.length} derived parser id(s) [${receipt.extended_parser_ids.map((id) => `${id}=${(extension.parsers.find((p) => p.id === id) || {}).name}`).join(' ')}]`
          : ' (vanilla parser table only)'
        log(`[command-tree] declare_commands parsed: ${receipt.nodes_read}/${receipt.nodes_declared} nodes, ${receipt.bytes_total} bytes fully consumed, root ${receipt.root_index}${derivedNote}`)
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
        '): the server\'s command tree is treated as ABSENT for this session (no command availability is assumed)')
    }
    try { client.emit('command_tree_dropped', client.minepalCommandTree) } catch (err) { debug(`command_tree_dropped listener threw: ${err.message}`) }
    return { data: { name: 'declare_commands_dropped', params: client.minepalCommandTree }, metadata: { size: buffer.length }, buffer, fullBuffer: buffer }
  }
}

/**
 * Installs the boundary on a client (idempotent). Reads the derived table
 * from client.minepalCommandArgumentTypes (commandArgumentTypeInstall.js)
 * at parse time, so install order does not matter.
 */
function installDeclareCommandsBoundary (client, { log = console.warn } = {}) {
  if (!client) return null
  if (client._hf45DeclareCommandsBoundary) return client._hf45DeclareCommandsBoundary
  const state = { packetId: null, version: null, frames: 0, drops: 0, parsed: 0, installed: false }
  client._hf45DeclareCommandsBoundary = state
  client.on('state', (s) => { if (s === 'play') wrap(client, state, log) })
  if (client.state === 'play') wrap(client, state, log)
  return state
}

module.exports = { installDeclareCommandsBoundary, declareCommandsId }
