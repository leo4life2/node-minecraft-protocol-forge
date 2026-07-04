'use strict'

// Look up a modded item's registry name from the id->name snapshot the FML3
// handshake stashed on the client (see forgeHandshake3.js). Returns the Forge
// name (e.g. 'twilightforest:naga_scale') for a numeric item id the vanilla
// protocol reports as `unknown`, or null when unavailable.
function resolveForgeItemName (client, numericId) {
  const items = client && client.forgeRegistries && client.forgeRegistries.item
  if (!items) return null
  return items.get(numericId) || null
}

module.exports = {
  forgeHandshake: require('./src/client/forgeHandshake'),
  forgeHandshake2: require('./src/client/forgeHandshake2'),
  forgeHandshake3: require('./src/client/forgeHandshake3'),
  forgeHandshakeConfig: require('./src/client/forgeHandshakeConfig'),
  autoVersionForge: require('./src/client/autoVersionForge'),
  decodeOptimized: require('./src/client/decodeOptimized'),
  resolveForgeItemName
}
