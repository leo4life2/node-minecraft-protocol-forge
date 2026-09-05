/* eslint-env mocha */
// HF35 rider (verify-r2 MED-1): the owo:handshake reply is the THREE writeHashes
// calls of OwoHandshake#syncClient (owo-lib 0.11.2 javap ~:75-109):
// REQUIRED_CHANNELS, REGISTERED_CONTROLLERS, then the client's OWN
// OPTIONAL_CHANNELS. The request payload (the server's optional map) is never
// echoed - the reply bytes are a pure function of our fingerprints.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildReply, encodeIdHashMap, RAW_LOGIN_PROTOCOLS, assess } = require('../src/client/owoHandshake')

// hand-pinned layout: [01 06 'a:main' 01] [01 03 'a:p' fbffffff0f] [01 05 'a:opt' <varint -123456789>]
const PINNED = '0106613a6d61696e010103613a70fbffffff0f0105613a6f7074ebe590c50f'
const FP = { channels: { 'a:main': 1 }, controllers: { 'a:p': -5 }, optional: { 'a:opt': -123456789 } }
const SERVER_REQUEST = encodeIdHashMap({ 'srv:opt': 7, 'srv:other': -1 })

describe('owo:handshake reply layout (javap-derived, syncClient)', function () {
  it('buildReply = required map + controller map + OUR optional map, byte-for-byte', () => {
    assert.strictEqual(buildReply(FP).toString('hex'), PINNED)
    assert.strictEqual(PINNED.slice(0, 2), '01')
    assert.ok(Buffer.from(PINNED, 'hex').includes(Buffer.from('a:opt')), 'our optional id is on the wire')
  })
  it('the server request bytes never reach the reply (no echo, whatever the second argument)', () => {
    assert.strictEqual(buildReply(FP, SERVER_REQUEST).toString('hex'), PINNED)
    assert.ok(!buildReply(FP, SERVER_REQUEST).includes(Buffer.from('srv:opt')))
  })
  it('the Forge-lane builder and assess produce the same bytes for a mods folder with no owo mods (three empty maps), ignoring the request', () => {
    const dir = fs.mkdtempSync(path.join(process.env.MINEPAL_USER_DATA_DIR || os.tmpdir(), 'hf35-owo-empty-'))
    try {
      const opts = { modsPaths: [dir] }
      assert.strictEqual(RAW_LOGIN_PROTOCOLS['owo:handshake'](SERVER_REQUEST, opts).toString('hex'), '000000')
      const a = assess(SERVER_REQUEST, opts)
      assert.strictEqual(a.data.toString('hex'), '000000')
      assert.strictEqual(assess(Buffer.from([0]), opts).data.toString('hex'), '000000')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
