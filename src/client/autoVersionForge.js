'use strict'

const forgeHandshake = require('./forgeHandshake')
const forgeHandshake2 = require('./forgeHandshake2')
const forgeHandshake3 = require('./forgeHandshake3')
const decodeOptimized = require('./decodeOptimized')

module.exports = function (client, options) {
  if (!client.autoVersionHooks) client.autoVersionHooks = []

  client.autoVersionHooks.push(function (response, client, options) {
    if (!response.modinfo || response.modinfo.type !== 'FML') {
      return // not ours
    }

    // Use the list of Forge mods from the server ping, so client will match server
    const forgeMods = response.modinfo.modList
    console.log('1 Using forgeMods:', forgeMods)

    // Install the FML|HS plugin with the given mods
    forgeHandshake(client, { forgeMods })
  })

  client.autoVersionHooks.push(function (response, client, options) {
    if (!response.forgeData || response.forgeData.fmlNetworkVersion !== 2) {
      return // not ours
    }

    // Use the list of Forge mods from the server ping, so client will match server
    const forgeMods = response.forgeData.mods
    console.log('2 Using forgeMods:', forgeMods)

    // Install the FML2 plugin with the given mods
    forgeHandshake2(client, { forgeMods })
  })

  client.autoVersionHooks.push(function (response, client, options) {
    if (!response.forgeData || !response.forgeData.d) {
      return // not ours
    }

    // Use the list of Forge mods from the server ping, so client will match server
    const forgeMods = response.forgeData.mods
    // Skip if mods is empty, let the fourth hook handle the encoded data
    if (!forgeMods || forgeMods.length === 0) {
      return
    }
    console.log('3 Using forgeMods:', forgeMods)

    // Install the FML3 plugin with the given mods
    forgeHandshake3(client, { forgeMods })
  })

  client.autoVersionHooks.push(function (response, client, options) {
    if (!response.forgeData || response.forgeData.fmlNetworkVersion !== 3) {
      return // not ours
    }

    // For 1.18+, the mod list and channel list are compressed in forgeData["d"]
    const encodedData = response.forgeData.d;
    
    if (!encodedData) {
      console.log('[FML3] No encoded data found in forgeData["d"]');
      return;
    }
    
    const decodedMods = decodeOptimized(encodedData);
    
    // Convert decoded mods to the format expected by forgeHandshake3
    const forgeMods = decodedMods.map(mod => mod.id);
    console.log('[FML3] Final forgeMods:', forgeMods);

    // Install the FML3 plugin with the given mods
    forgeHandshake3(client, { forgeMods });
  })
}
