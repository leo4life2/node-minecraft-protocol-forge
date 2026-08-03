/* eslint-env mocha */
// Byte-level table test for the WRAPPED_LOGIN_PROTOCOLS mod login
// sub-protocols in the FML3 handshake responder. Drives the installed
// login_plugin_request handler through a stub client and asserts the exact
// login_plugin_response bytes, so any change to an existing entry (tacz,
// zeta, framework) or to the FML ack-99 fall-through is a test failure.
const assert = require('assert')
const { EventEmitter } = require('events')

// Required by path on purpose: the module under test must be THIS checkout,
// not whatever the package name resolves to through parent node_modules.
const forgeHandshake3 = require('../src/client/forgeHandshake3')
const { writeVarInt, writeString } = forgeHandshake3

// fml:loginwrapper framing (same as the server's LoginWrapper): inner
// channel string + varint-length-prefixed payload.
function wrap (channel, payload) {
  return Buffer.concat([writeString(channel), writeVarInt(payload.length), payload])
}

// Minimal stand-in for a connecting nmp client: an EventEmitter that
// captures everything written back to the server.
function makeClient () {
  const client = new EventEmitter()
  client.written = []
  client.write = (name, params) => client.written.push({ name, params })
  return client
}

// Delivers one wrapped mod login message (inner channel + discriminator +
// body) and returns the raw login_plugin_response payload.
function loginReply (channel, disc, body = Buffer.alloc(0)) {
  const client = makeClient()
  forgeHandshake3(client, {})
  client.emit('login_plugin_request', {
    messageId: 42,
    channel: 'fml:loginwrapper',
    data: wrap(channel, Buffer.concat([writeVarInt(disc), body]))
  })
  assert.strictEqual(client.written.length, 1, 'exactly one reply per request')
  const { name, params } = client.written[0]
  assert.strictEqual(name, 'login_plugin_response')
  assert.strictEqual(params.messageId, 42, 'reply mirrors the request messageId')
  return params.data
}

describe('WRAPPED_LOGIN_PROTOCOLS', function () {
  it('framework:handshake: replies Acknowledge = index 1, empty body, to every S2C login message', () => {
    // ForgeNetworkBuilder#build resets idCount to 1 and registers Acknowledge
    // first (S2CLoginData=2, S2CLoginConfigData=3), so the reply is always the
    // single byte 0x01 on the same inner channel.
    for (const disc of [2, 3]) {
      assert.deepStrictEqual(
        loginReply('framework:handshake', disc, Buffer.from([0xaa, 0xbb, 0xcc])),
        wrap('framework:handshake', Buffer.from([0x01]))
      )
    }
  })

  it('tacz:handshake: unchanged — single 0x01 ack byte regardless of message', () => {
    assert.deepStrictEqual(
      loginReply('tacz:handshake', 2, Buffer.from([1, 2, 3])),
      wrap('tacz:handshake', Buffer.from([0x01]))
    )
  })

  it('zeta:main: unchanged — S2CLoginFlag(98) body echoed back as C2SLoginFlag(99)', () => {
    const body = Buffer.from([9, 8, 7, 6, 5])
    assert.deepStrictEqual(
      loginReply('zeta:main', 98, body),
      wrap('zeta:main', Buffer.concat([writeVarInt(99), body]))
    )
    // any other zeta message falls through to the FML ack
    assert.deepStrictEqual(
      loginReply('zeta:main', 1, body),
      wrap('zeta:main', writeVarInt(99))
    )
  })

  it('unknown wrapped channels: unchanged — FML C2SAcknowledge (99) fall-through', () => {
    assert.deepStrictEqual(
      loginReply('somemod:handshake', 3, Buffer.from([1])),
      wrap('somemod:handshake', writeVarInt(99))
    )
  })
})
