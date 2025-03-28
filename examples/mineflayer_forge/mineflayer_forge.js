// Usage: node mineflayer_forge.js
// Change values of host, port, username before using. Tested with 1.19.2 Minecraft offline server.

const mineflayer = require('mineflayer')
const pathfinder = require('mineflayer-pathfinder')
const autoVersionForge = require('../../src/client/autoVersionForge')

// const host = "localhost"
const host = "192.168.50.131"
const port = "5555"
const username = "create_test"

const bot = mineflayer.createBot({
  version: '1.20.1',
  host,
  port,
  username,
  skipValidation: true
})

// leave options empty for guessing, otherwise specify the mods,
// channels and registries manually (channels and registries are only
// relevant for fml2 handshake)
const options = {
  forgeMods: undefined,
  channels: undefined
}

// add handler
autoVersionForge(bot._client, options)

bot.loadPlugin(pathfinder.pathfinder)
console.info('Started mineflayer')

// set up logging
bot.on('connect', function () {
  console.info('I connected')
})

bot.on('spawn', function () {
  console.info('I spawned')
})

bot.on('kicked', (reason, loggedIn) => {
  console.error(`I was kicked for ${JSON.stringify(reason, null, 2)} while ${loggedIn ? 'logged in' : 'not logged in'}`)
})

bot.on('error', (err) => {
  console.error('An error occurred:', err)
})