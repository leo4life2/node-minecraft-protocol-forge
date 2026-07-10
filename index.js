'use strict'

// Look up a modded registry name from the id->name snapshots the Forge
// handshake stashed on the client (forgeHandshake3.js for <=1.20.1 login-phase
// FML3, forgeHandshakeConfig.js for 1.20.2+ config-phase). `registry` is one
// of the SNAPSHOT_REGISTRIES keys: 'item', 'block' or 'entity_type'. Returns
// the Forge name (e.g. 'twilightforest:naga_scale') for a numeric id the
// vanilla protocol reports as `unknown`, or null when unavailable.
function resolveForgeRegistryName (client, registry, numericId) {
  const ids = client && client.forgeRegistries && client.forgeRegistries[registry]
  if (!ids) return null
  return ids.get(numericId) || null
}

function resolveForgeItemName (client, numericId) {
  return resolveForgeRegistryName(client, 'item', numericId)
}

function resolveForgeEntityName (client, numericId) {
  return resolveForgeRegistryName(client, 'entity_type', numericId)
}

module.exports = {
  forgeHandshake: require('./src/client/forgeHandshake'),
  forgeHandshake2: require('./src/client/forgeHandshake2'),
  forgeHandshake3: require('./src/client/forgeHandshake3'),
  forgeHandshakeConfig: require('./src/client/forgeHandshakeConfig'),
  autoVersionForge: require('./src/client/autoVersionForge'),
  decodeOptimized: require('./src/client/decodeOptimized'),
  installTolerantPlayParser: require('./src/client/tolerantPlayParser'),
  resolveForgeRegistryName,
  resolveForgeItemName,
  resolveForgeEntityName
}
