'use strict'

// HF45 — the declare_commands (ClientboundCommandsPacket) reader that never
// trusts a misaligned frame. THE CLASS: a modded server numbers loader/mod
// command argument types AFTER the vanilla parser table (NeoForge 26.2.0.88:
// `/config showfile <mod: neoforge:modid> <type: neoforge:enum>` — enum
// serialises a UTF string property, the enum class name). minecraft-data's
// schema maps only the vanilla parser ids, so protodef's mapper leaves an
// unknown id numeric, the properties switch falls through to void, the rest
// of the frame is read misaligned WITHOUT any read error, and a garbage
// rootIndex (71 of 41 nodes) makes minecraft-protocol's chat.js reject the
// tree and END THE CLIENT 0.3 s after "joined the game".
//
// This module reads the frame node by node against minecraft-data's own
// command_node definition for the version, EXTENDED per client with the
// derived loader/mod parser table (commandArgumentTypeDerivation.js), and
// accounts for every byte: nodes declared vs read, bytes left unconsumed,
// parser ids the table does not know. The caller (declareCommandsBoundary)
// keeps a fully-consumed, structurally valid tree and drops anything else
// with that receipt — the tree is never guessed.
//
// PRIVACY: pure parsing of an in-memory frame; no network, no fs, no exec.

const compiled = new Map() // `${version}|${extensionKey}` -> compiled proto (or Error)

function extensionKey (extension) {
  const rows = (extension && extension.parsers) || []
  return rows.map((p) => `${p.id}=${p.name}:${JSON.stringify(p.fields || [])}`).join(',')
}

// Locate the parser mapper + properties switch inside a command_node type
// (minecraft-data 1.13 .. 26.x: extraNodeData switch, case "2" = argument).
function locateArgumentSchema (commandNode) {
  const fields = commandNode && commandNode[0] === 'container' ? commandNode[1] : null
  if (!fields) return null
  const extra = fields.find((f) => f.name === 'extraNodeData')
  const argCase = extra && extra.type && extra.type[1] && extra.type[1].fields && extra.type[1].fields['2']
  if (!argCase || argCase[0] !== 'container') return null
  const parser = argCase[1].find((f) => f.name === 'parser')
  const properties = argCase[1].find((f) => f.name === 'properties')
  if (!parser || !properties) return null
  const mapper = parser.type && parser.type[0] === 'mapper' ? parser.type[1] : null
  const sw = properties.type && properties.type[0] === 'switch' ? properties.type[1] : null
  if (!mapper || !sw) return null
  return { mapper, switch: sw, keyedByName: sw.compareTo === 'parser' }
}

/** The vanilla parser table of a version: [{id, name}] plus the max id, from minecraft-data. */
function vanillaParserTable (version) {
  const mcData = require('minecraft-data')(version)
  const schema = locateArgumentSchema(mcData.protocol.types.command_node)
  if (!schema) return null
  const rows = Object.entries(schema.mapper.mappings).map(([id, name]) => ({ id: Number(id), name }))
  return { rows, maxId: Math.max(...rows.map((r) => r.id)), names: new Set(rows.map((r) => r.name)), keyedByName: schema.keyedByName }
}

// Deep-copy the version's command_node and splice the extension in: mapper
// id -> name, properties[name] -> the derived layout (a container of the
// derived fields, or void when the serializer writes nothing).
function extendCommandNode (commandNode, extension) {
  const node = JSON.parse(JSON.stringify(commandNode))
  const schema = locateArgumentSchema(node)
  if (!schema) throw new Error('command_node schema shape not recognised (no parser mapper / properties switch)')
  for (const p of (extension && extension.parsers) || []) {
    if (!Number.isInteger(p.id) || typeof p.name !== 'string') continue
    schema.mapper.mappings[String(p.id)] = p.name
    const key = schema.keyedByName ? p.name : String(p.id)
    schema.switch.fields[key] = p.fields && p.fields.length ? ['container', p.fields.map((f) => ({ name: f.name, type: f.type }))] : 'void'
  }
  return node
}

function compileReader (version, extension) {
  const key = `${version}|${extensionKey(extension)}`
  if (compiled.has(key)) {
    const c = compiled.get(key)
    if (c instanceof Error) throw c
    return c
  }
  try {
    const mcData = require('minecraft-data')(version)
    const protocol = mcData.protocol
    const declare = protocol.play && protocol.play.toClient && protocol.play.toClient.types && protocol.play.toClient.types.packet_declare_commands
    if (!declare || !protocol.types.command_node) throw new Error(`no declare_commands schema for ${version}`)
    const mini = { types: { ...protocol.types, command_node: extendCommandNode(protocol.types.command_node, extension), packet_declare_commands: declare } }
    const { ProtoDefCompiler } = require('protodef').Compiler
    const nbt = require('prismarine-nbt')
    const minecraftTypes = require('minecraft-protocol/src/datatypes/compiler-minecraft')
    const compiler = new ProtoDefCompiler()
    compiler.addTypes(minecraftTypes)
    compiler.addProtocol(mini, [])
    nbt.addTypesToCompiler('big', compiler)
    const proto = compiler.compileProtoDefSync()
    compiled.set(key, proto)
    return proto
  } catch (err) {
    compiled.set(key, err)
    throw err
  }
}

function readVarInt (buffer, offset) {
  let result = 0; let shift = 0; let size = 0
  while (true) {
    if (offset + size >= buffer.length) throw new Error('varint runs past the buffer')
    const b = buffer[offset + size]; size++
    result |= (b & 0x7f) << shift; shift += 7
    if (!(b & 0x80)) break
    if (shift > 35) throw new Error('varint too long')
  }
  return { value: result >>> 0, size }
}

// Same acceptance as minecraft-protocol's chat.js validateCommandTree (a
// tree it would reject must never reach it) plus index-range checks.
function validateStructure (nodes, rootIndex) {
  if (!Array.isArray(nodes) || nodes.length === 0) return 'no-nodes'
  if (!Number.isInteger(rootIndex) || rootIndex < 0 || rootIndex >= nodes.length) return `root-index-out-of-range:${rootIndex}/${nodes.length}`
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (!n || !Array.isArray(n.children)) return `node-${i}-children-not-array`
    for (const c of n.children) if (!Number.isInteger(c) || c < 0 || c >= nodes.length) return `node-${i}-child-out-of-range:${c}`
    if (n.redirectNode !== undefined && (!Number.isInteger(n.redirectNode) || n.redirectNode < 0 || n.redirectNode >= nodes.length)) return `node-${i}-redirect-out-of-range:${n.redirectNode}`
  }
  let pending
  const canBuild = (i) => nodes[i].redirectNode === undefined || !pending.has(nodes[i].redirectNode)
  const canResolve = (i) => nodes[i].children.every((c) => !pending.has(c))
  for (const [label, validator] of [['redirect-cycle', canBuild], ['child-cycle', canResolve]]) {
    pending = new Set(nodes.keys())
    let progressed = true
    while (pending.size > 0 && progressed) {
      progressed = false
      for (const i of [...pending]) if (validator(i)) { pending.delete(i); progressed = true }
    }
    if (pending.size > 0) return `${label}:${[...pending].slice(0, 8).join(',')}`
  }
  return null
}

/**
 * Parse a declare_commands packet BODY (the frame after its packet id) with
 * exact byte accounting. Never throws: the receipt says what was read.
 *
 * @param {Buffer} body
 * @param {string} version minecraft-data version of this client
 * @param {object|null} extension { parsers: [{ id, name, fields: [{name,type}] }] } (derived per client; null = vanilla table only)
 * @returns {{ ok: boolean, packet: object|null, receipt: object }}
 */
function parseCommandTree (body, version, extension) {
  const receipt = {
    nodes_declared: null,
    nodes_read: 0,
    bytes_total: body.length,
    bytes_unconsumed: body.length,
    unknown_parser_ids: [],
    extended_parser_ids: [],
    parsers_seen: {},
    root_index: null,
    structure: null,
    error: null
  }
  const known = new Map()
  for (const p of (extension && extension.parsers) || []) if (Number.isInteger(p.id)) known.set(p.id, p.name)
  let proto
  try { proto = compileReader(version, extension) } catch (err) {
    receipt.error = `schema-compile-failed: ${err.message}`
    return { ok: false, packet: null, receipt }
  }
  const nodes = []
  let offset = 0
  try {
    const count = readVarInt(body, 0); offset = count.size
    receipt.nodes_declared = count.value
    for (let i = 0; i < count.value; i++) {
      const r = proto.read(body, offset, 'command_node')
      offset += r.size
      nodes.push(r.value)
      receipt.nodes_read = i + 1
      const ex = r.value && r.value.extraNodeData
      if (ex && ex.parser !== undefined) {
        const parser = ex.parser
        const label = typeof parser === 'number' ? String(parser) : parser
        receipt.parsers_seen[label] = (receipt.parsers_seen[label] || 0) + 1
        if (typeof parser === 'number') {
          if (!receipt.unknown_parser_ids.includes(parser)) receipt.unknown_parser_ids.push(parser)
        } else if ([...known.values()].includes(parser)) {
          const id = [...known.entries()].find(([, n]) => n === parser)[0]
          if (!receipt.extended_parser_ids.includes(id)) receipt.extended_parser_ids.push(id)
        }
      }
    }
    const root = readVarInt(body, offset); offset += root.size
    receipt.root_index = root.value
  } catch (err) {
    receipt.error = `read-failed: ${err && err.message ? err.message.split('\n')[0].slice(0, 160) : String(err)}`
    receipt.bytes_unconsumed = body.length - offset
    return { ok: false, packet: null, receipt }
  }
  receipt.bytes_unconsumed = body.length - offset
  if (receipt.unknown_parser_ids.length || receipt.bytes_unconsumed !== 0) {
    return { ok: false, packet: null, receipt }
  }
  receipt.structure = validateStructure(nodes, receipt.root_index)
  if (receipt.structure) return { ok: false, packet: null, receipt }
  return { ok: true, packet: { nodes, rootIndex: receipt.root_index }, receipt }
}

module.exports = { parseCommandTree, compileReader, extendCommandNode, vanillaParserTable, locateArgumentSchema, validateStructure, readVarInt }
