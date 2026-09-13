'use strict'

const fs = require('fs')
const path = require('path')
const debug = require('debug')('minecraft-protocol-forge')
const { deriveCommandArgumentTypes } = require('./commandArgumentTypeDerivation')
const { vanillaParserTable } = require('./commandTreeParser')

// HF45 — per-client installer of the derived command argument-type table
// (commandArgumentTypeDerivation.js). It waits for the wire truth — the
// `command_argument_type` registry the server synced in configuration
// (NeoForge frozen_registry -> client.forgeRegistries, Fabric registry sync
// -> client.fabricRegistries) — then derives the loader/mod parser layouts
// from the local jars the caller resolves (mods folder + the loader's own
// jar) and parks the result on client.minepalCommandArgumentTypes for the
// declare_commands boundary (declareCommandsBoundary.js) to read at parse
// time. Nothing process-wide is touched: the table lives on THIS client.
//
// No registry on the wire (vanilla, or a loader that does not sync it) means
// no table: the boundary then keeps the vanilla schema and drops any tree
// carrying ids beyond it, naming them — never a guessed layout.

function jarsUnder (dirsOrJars) {
  const jars = []
  for (const p of dirsOrJars || []) {
    try {
      const st = fs.statSync(p)
      if (st.isFile() && p.endsWith('.jar')) jars.push(p)
      else if (st.isDirectory()) for (const f of fs.readdirSync(p)) if (f.endsWith('.jar')) jars.push(path.join(p, f))
    } catch { /* absent: nothing to read */ }
  }
  return jars
}

/**
 * @param {import('minecraft-protocol').Client} client
 * @param {object} options
 * @param {() => string[]} options.resolveJars jar files and/or mods folders to derive from (called once, when the registry arrives)
 * @param {(msg: string) => void} [options.log]
 */
function installCommandArgumentTypes (client, { resolveJars, log = debug } = {}) {
  if (!client) return null
  if (client.minepalCommandArgumentTypes) return client.minepalCommandArgumentTypes
  const state = { derived: false, source: null, registrySize: 0, extension: null, receipt: null, jars: [] }
  client.minepalCommandArgumentTypes = state

  const derive = (registry, source) => {
    if (!(registry instanceof Map) || registry.size === 0) return
    state.source = source
    state.registrySize = registry.size
    let table
    try { table = vanillaParserTable(client.version) } catch (err) { state.receipt = { error: `no vanilla parser table for ${client.version}: ${err.message}` }; return }
    if (!table) { state.receipt = { error: `no command_node schema for ${client.version}` }; return }
    let jars = []
    try { jars = jarsUnder(resolveJars ? resolveJars() : []) } catch (err) { state.receipt = { error: `jar resolution failed: ${err.message}` } }
    state.jars = jars.map((j) => path.basename(j))
    let res
    try {
      res = deriveCommandArgumentTypes({ registry, vanillaNames: table.names, vanillaMaxId: table.maxId, jars })
    } catch (err) {
      state.receipt = { error: `derivation failed: ${err.message}` }
      log(`[command-args] argument-type derivation failed (${err.message}); loader/mod parsers stay unknown`)
      return
    }
    state.derived = true
    state.extension = res.extension
    state.receipt = {
      source,
      registry_size: registry.size,
      vanilla: res.vanilla,
      derived: res.derived.map((d) => ({ id: d.id, name: d.name, layout: d.fields.map((f) => f.type).join(',') || 'none', jar: d.source.jar, serializer: d.source.serializer, evidence: d.source.evidence })),
      abstains: res.abstains,
      aliases: res.aliases,
      jars_scanned: res.jars.length,
      unreadable: res.unreadable,
      ms: res.ms
    }
    const beyond = registry.size - res.vanilla
    log(`[command-args] ${source} synced ${registry.size} command argument types (${res.vanilla} vanilla, ${beyond} beyond the ${client.version} schema): ` +
      `${res.derived.length} derived${res.derived.length ? ' [' + res.derived.map((d) => `${d.id}=${d.name}:${d.fields.map((f) => f.type).join(',') || 'none'}`).join(' ') + ']' : ''}` +
      `${res.abstains.length ? `, ${res.abstains.length} NOT derivable [` + res.abstains.map((a) => `${a.id}=${a.name}:${a.reason}`).join(' ') + ']' : ''}` +
      `${res.aliases.length ? `, ${res.aliases.length} vanilla ids named differently on the wire [` + res.aliases.map((a) => `${a.id}=${a.name}`).join(' ') + ']' : ''} from ${res.jars.length} jars in ${res.ms} ms`)
  }

  client.on('neoForgeRegistries', (regs) => derive(regs && regs.command_argument_type, 'neoforge-frozen-registry'))
  client.on('fabricRegistrySync', () => derive(client.fabricRegistries && client.fabricRegistries.command_argument_type, 'fabric-registry-sync'))
  // Forge's FML handshake (login-phase FML3 / the configuration-phase
  // RegistryData stream) stashes its snapshots on client.forgeRegistries
  // without a completion event: derive from whatever is stashed at play
  // entry. The same fallback covers a late install after any sync.
  const stashed = () => {
    if (state.derived) return
    const forge = client.forgeRegistries && client.forgeRegistries.command_argument_type
    const fabric = client.fabricRegistries && client.fabricRegistries.command_argument_type
    if (forge) derive(forge, 'forge-registry-snapshot')
    else if (fabric) derive(fabric, 'fabric-registry-sync')
  }
  client.on('state', (s) => { if (s === 'play') stashed() })
  stashed()
  return state
}

module.exports = { installCommandArgumentTypes, jarsUnder }
