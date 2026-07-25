const ProtoDef = require('protodef').ProtoDef
const debug = require('../../debug')

const proto = new ProtoDef()
// copied from ../../dist/transforms/serializer.js TODO: refactor
proto.addType('string', [
  'pstring',
  {
    countType: 'varint'
  }
])

// http://wiki.vg/Minecraft_Forge_Handshake
// TODO: move to https://github.com/PrismarineJS/minecraft-data
proto.addType('fml|hsMapper', [
  'mapper',
  {
    type: 'i8',
    mappings: {
      0: 'ServerHello',
      1: 'ClientHello',
      2: 'ModList',
      3: 'RegistryData',
      '-1': 'HandshakeAck',
      '-2': 'HandshakeReset'
    }
  }
])

proto.addType('FML|HS', [
  'container',
  [
    {
      name: 'discriminator',
      type: 'fml|hsMapper'
    },

    {
      anon: true,
      type: [
        'switch',
        {
          compareTo: 'discriminator',
          fields: {
            ServerHello: [
              'container',
              [
                {
                  name: 'fmlProtocolVersion',
                  type: 'i8'
                },
                {
                  name: 'overrideDimension',
                  type: [
                    'switch',
                    {
                      // "Only sent if protocol version is greater than 1."
                      compareTo: 'fmlProtocolVersion',
                      fields: {
                        0: 'void',
                        1: 'void'
                      },
                      default: 'i32'
                    }
                  ]
                }
              ]
            ],

            ClientHello: [
              'container',
              [
                {
                  name: 'fmlProtocolVersion',
                  type: 'i8'
                }
              ]
            ],

            ModList: [
              'container',
              [
                {
                  name: 'mods',
                  type: [
                    'array',
                    {
                      countType: 'varint',
                      type: [
                        'container',
                        [
                          {
                            name: 'modid',
                            type: 'string'
                          },
                          {
                            name: 'version',
                            type: 'string'
                          }
                        ]
                      ]
                    }
                  ]
                }
              ]
            ],

            RegistryData: [
              'container',
              [
                {
                  name: 'hasMore',
                  type: 'bool'
                }

                /* TODO: support all fields http://wiki.vg/Minecraft_Forge_Handshake#RegistryData
                   * TODO: but also consider http://wiki.vg/Minecraft_Forge_Handshake#ModIdData
                   *  and https://github.com/ORelio/Minecraft-Console-Client/pull/100/files#diff-65b97c02a9736311374109e22d30ca9cR297
                  {
                    "name": "registryName",
                    "type": "string"
                  },
                  */
              ]
            ],

            HandshakeAck: [
              'container',
              [
                {
                  name: 'phase',
                  type: 'i8'
                }
              ]
            ],
            HandshakeReset: [
              'container',
              [
                {
                  name: 'phase',
                  type: 'i8'
                }
              ]
            ]
          }
        }
      ]
    }
  ]
])

function writeAck (client, phase) {
  const ackData = proto.createPacketBuffer('FML|HS', {
    discriminator: 'HandshakeAck', // HandshakeAck,
    phase
  })
  client.write('custom_payload', {
    channel: 'FML|HS',
    data: ackData
  })
}

const FMLHandshakeClientState = {
  START: 1,
  WAITINGSERVERDATA: 2,
  WAITINGSERVERCOMPLETE: 3,
  PENDINGCOMPLETE: 4,
  COMPLETE: 5,
  RESET: 6
}

// FML1 state-machine resilience (crash hardening): the old code assert.ok'd
// every discriminator/phase, and those asserts threw inside the
// custom_payload packet-listener context — an out-of-order message (BungeeCord
// backend switch re-sending ServerHello/HandshakeReset while COMPLETE) became
// a process-killing uncaughtException and a deterministic crash-restart loop.
// A real FML1 client resyncs instead: HandshakeReset is legal at ANY point
// (dimension change, proxy switch), an unexpected ServerHello re-enters the
// handshake, and anything else out of order is logged and dropped. Repeated
// violations mean client and server genuinely disagree — surfaced ONCE as a
// clean client 'error' carrying a structural joinProtocolError marker.
const MAX_FML_DESYNCS = 3

function fmlDesync (client, detail) {
  client.fmlDesyncCount = (client.fmlDesyncCount || 0) + 1
  debug(`FML|HS desync (${client.fmlDesyncCount}/${MAX_FML_DESYNCS}): ${detail}`)
  console.warn(`[forge] FML handshake out-of-order (${client.fmlDesyncCount}/${MAX_FML_DESYNCS}): ${detail}`)
  if (client.fmlDesyncCount >= MAX_FML_DESYNCS) {
    const err = new Error(`FML handshake desync: ${detail} (${client.fmlDesyncCount} protocol-order violations this session)`)
    err.joinProtocolError = true
    client.fmlHandshakeDead = true
    client.emit('error', err)
    return false
  }
  return true
}

function fmlHandshakeStep (client, data, options) {
  if (client.fmlHandshakeDead) return
  const parsed = proto.parsePacketBuffer('FML|HS', data)
  debug('FML|HS', parsed)

  const discriminator = parsed.data.discriminator
  // The FML1 handshake opens with the server's ServerHello, which the START
  // state handles; defaulting to RESET made the first message assert-fail.
  let fmlHandshakeState =
    client.fmlHandshakeState || FMLHandshakeClientState.START

  // HandshakeReset is legal at ANY point: FML1 servers re-run the handshake
  // on dimension change and proxy backend switches. Ack and re-enter START.
  if (discriminator === 'HandshakeReset') {
    writeAck(client, FMLHandshakeClientState.START)
    client.fmlHandshakeState = FMLHandshakeClientState.START
    client.fmlHandshakeReset = true
    debug('HandshakeReset!')
    return
  }

  // An unexpected ServerHello means the server restarted the handshake
  // without a reset (some proxies do): re-enter START and process it there.
  if (discriminator === 'ServerHello' && fmlHandshakeState !== FMLHandshakeClientState.START) {
    if (!fmlDesync(client, `ServerHello while in state ${fmlHandshakeState}; re-entering handshake`)) return
    client.fmlHandshakeState = FMLHandshakeClientState.START
    fmlHandshakeState = FMLHandshakeClientState.START
    client.fmlHandshakeReset = true
  }

  switch (fmlHandshakeState) {
    case FMLHandshakeClientState.START: {
      if (discriminator !== 'ServerHello') {
        fmlDesync(client, `expected ServerHello in START state, got ${discriminator}; dropping`)
        return
      }
      if (parsed.data.fmlProtocolVersion > 2) {
        // TODO: support higher protocols, if they change
      }

      client.write('custom_payload', {
        channel: 'REGISTER',
        data: Buffer.from(
          ['FML|HS', 'FML', 'FML|MP', 'FML', 'FORGE'].join('\0')
        )
      })

      const clientHello = proto.createPacketBuffer('FML|HS', {
        discriminator: 'ClientHello',
        fmlProtocolVersion: parsed.data.fmlProtocolVersion
      })

      client.write('custom_payload', {
        channel: 'FML|HS',
        data: clientHello
      })

      debug('Sending client modlist')
      const modList = proto.createPacketBuffer('FML|HS', {
        discriminator: 'ModList',
        mods: options.forgeMods || []
      })
      client.write('custom_payload', {
        channel: 'FML|HS',
        data: modList
      })
      writeAck(client, FMLHandshakeClientState.WAITINGSERVERDATA)
      client.fmlHandshakeState = FMLHandshakeClientState.WAITINGSERVERDATA
      break
    }

    case FMLHandshakeClientState.WAITINGSERVERDATA: {
      if (discriminator !== 'ModList') {
        fmlDesync(client, `expected ModList in WAITINGSERVERDATA state, got ${discriminator}; dropping`)
        return
      }
      debug('Server ModList:', parsed.data.mods)
      // Emit event so client can check client/server mod compatibility
      client.emit('forgeMods', parsed.data.mods)

      if (client.fmlHandshakeReset) {
        writeAck(client, FMLHandshakeClientState.PENDINGCOMPLETE)
        client.fmlHandshakeState = FMLHandshakeClientState.PENDINGCOMPLETE
      } else {
        client.fmlHandshakeState =
          FMLHandshakeClientState.WAITINGSERVERCOMPLETE
      }
      break
    }

    case FMLHandshakeClientState.WAITINGSERVERCOMPLETE: {
      if (discriminator !== 'RegistryData') {
        fmlDesync(client, `expected RegistryData in WAITINGSERVERCOMPLETE, got ${discriminator}; dropping`)
        return
      }
      debug('RegistryData', parsed.data)
      if (
        client.version === '1.7.10' || // actually ModIdData packet, and there is only one of those TODO: avoid hardcoding version, allow earlier
        parsed.data.hasMore === false
      ) {
        // RegistryData packet 1.8+ hasMore boolean field, set to false when ready to ack
        debug('LAST RegistryData')

        writeAck(client, FMLHandshakeClientState.WAITINGSERVERCOMPLETE)
        client.fmlHandshakeState = FMLHandshakeClientState.PENDINGCOMPLETE
      }
      break
    }

    case FMLHandshakeClientState.PENDINGCOMPLETE: {
      if (discriminator !== 'HandshakeAck') {
        fmlDesync(client, `expected HandshakeAck in PENDINGCOMPLETE, got ${discriminator}; dropping`)
        return
      }
      if (parsed.data.phase !== 2) {
        fmlDesync(client, `expected HandshakeAck phase WAITINGACK (2) in PENDINGCOMPLETE, got ${parsed.data.phase}; dropping`)
        return
      }
      writeAck(client, FMLHandshakeClientState.PENDINGCOMPLETE)
      client.fmlHandshakeState = FMLHandshakeClientState.COMPLETE
      break
    }

    case FMLHandshakeClientState.COMPLETE: {
      if (discriminator !== 'HandshakeAck' || parsed.data.phase !== 3) {
        fmlDesync(client, `expected HandshakeAck phase COMPLETE (3) in COMPLETE state, got ${discriminator} phase ${parsed.data.phase}; dropping`)
        return
      }

      writeAck(client, FMLHandshakeClientState.COMPLETE)
      debug('HandshakeAck Complete!')
      break
    }

    default: {
      fmlDesync(client, `unexpected FML state ${fmlHandshakeState} (got ${discriminator}); dropping`)
    }
  }
}

module.exports = function (client, options) {
  client.tagHost = '\0FML\0' // passed to src/client/setProtocol.js, signifies client supports FML/Forge
  client.on('custom_payload', function (packet) {
    // TODO: channel registration tracking in NMP, https://github.com/PrismarineJS/node-minecraft-protocol/pull/328
    if (packet.channel === 'FML|HS') {
      fmlHandshakeStep(client, packet.data, options)
    }
  })
}
