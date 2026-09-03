const ProtoDef = require('protodef').ProtoDef
const debug = require('debug')('minecraft-protocol-forge')
// Shared wrapped mod-channel login machinery (one rule for the class of
// login-wrapped mod channels across the FML2 and FML3 eras): table override
// -> jar-derived verdict -> honest failure / FML-99 convention.
const { resolveWrappedModLogin, wrapLoginPayload, encodeAcknowledgement, readVarInt } = require('./forgeHandshake3')
// HF12 boundary law — see loginReplyBoundary.js: awaited fml:handshake
// lockstep replies write synchronously through the guard; wrapped-mod-channel
// replies (the fire-and-forget-capable class) defer one event-loop turn and
// are dropped with a receipt when the negotiation is observably over.
const { writeLoginReplyNow, writeLoginReplyDeferred } = require('./loginReplyBoundary')

// Channels
const FML_CHANNELS = {
  LOGINWRAPPER: 'fml:loginwrapper',
  HANDSHAKE: 'fml:handshake'
}

const PROTODEF_TYPES = {
  LOGINWRAPPER: 'fml_loginwrapper',
  HANDSHAKE: 'fml_handshake'
}

// Initialize Proto
const proto = new ProtoDef(false)

// copied from ../../dist/transforms/serializer.js
proto.addType('string', [
  'pstring',
  {
    countType: 'varint'
  }
])

// copied from node-minecraft-protocol
proto.addTypes({
  restBuffer: [
    (buffer, offset) => {
      return {
        value: buffer.slice(offset),
        size: buffer.length - offset
      }
    },
    (value, buffer, offset) => {
      value.copy(buffer, offset)
      return offset + value.length
    },
    (value) => {
      return value.length
    }
  ]
})

proto.addProtocol(require('./data/fml2.json'), ['fml2'])

/**
 * FML2 handshake to the server.
 * https://wiki.vg/Minecraft_Forge_Handshake#FML2_protocol_.281.13_-_Current.29
 * @param {import('minecraft-protocol').Client} client client that is connecting to the server.
 * @param {{
 *  forgeMods: Array.<string> | undefined,
 *  channels: Object.<string, string> | undefined,
 *  registries: Object.<string, string> | undefined
 * }} options
 */
module.exports = function (client, options) {
  const modNames = options.forgeMods
  const channels = options.channels
  const registries = options.registries

  // passed to src/client/setProtocol.js, signifies client supports FML2/Forge
  client.tagHost = '\0FML2\0'
  debug('initialized FML2 handler')
  if (!modNames) {
    debug("trying to guess modNames by reflecting the servers'")
  } else {
    debug('modNames:', modNames)
  }
  if (!channels) {
    debug("trying to guess channels by reflecting the servers'")
  } else {
    Object.entries(channels).forEach((name, marker) => {
      debug('channel', name, marker)
    })
  }
  if (!registries) {
    debug("trying to guess registries by reflecting the servers'")
  } else {
    Object.entries(registries).forEach((name, marker) => {
      debug('registry', name, marker)
    })
  }

  client.registerChannel('fml:loginwrapper', proto.types.fml_loginwrapper, false)

  // remove default login_plugin_request listener which would answer with an empty packet
  // and make the server disconnect us
  const nmplistener = client.listeners('login_plugin_request').find((fn) => fn.name === 'onLoginPluginRequest')
  client.removeListener('login_plugin_request', nmplistener)

  client.on('login_plugin_request', (data) => {
    if (data.channel === 'fml:loginwrapper') {
      // parse buffer
      const { data: loginwrapper } = proto.parsePacketBuffer(
        PROTODEF_TYPES.LOGINWRAPPER,
        data.data
      )

      if (!loginwrapper.channel) {
        console.error(loginwrapper)
      }

      switch (loginwrapper.channel) {
        case 'fml:handshake': {
          const { data: handshake } = proto.parsePacketBuffer(
            PROTODEF_TYPES.HANDSHAKE,
            loginwrapper.data
          )

          let loginwrapperpacket = Buffer.alloc(0)
          switch (handshake.discriminator) {
            // respond with ModListResponse
            case 'ModList': {
              const modlist = handshake.data

              // HF13: stash the server's announced reality in the same shape
              // FML3 keeps (mods: id strings, channels: {name, marker}) so the
              // shared wrapped-mod-channel corroboration gate
              // (forgeHandshake3.announcedChannelAttribution) works on both
              // login-phase FML eras.
              client.forgeModList = {
                mods: Array.isArray(modlist.modNames) ? modlist.modNames : [],
                channels: Array.isArray(modlist.channels) ? modlist.channels : [],
                registries: Array.isArray(modlist.registries) ? modlist.registries.map((r) => r && r.name).filter(Boolean) : []
              }

              const modlistreply = {
                modNames,
                channels: [],
                registries: []
              }

              if (!options.modNames) {
                modlistreply.modNames = modlist.modNames
              }

              if (!options.channels) {
                for (const { name, marker } of modlist.channels) {
                  if (marker !== 'FML2') {
                    modlistreply.channels.push({ name, marker })
                  }
                }
              } else {
                for (const channel in channels) {
                  modlistreply.channels.push({
                    name: channel,
                    marker: channels[channel]
                  })
                }
              }

              if (!options.registries) {
                for (const { name } of modlist.registries) {
                  modlistreply.registries.push({ name, marker: '1.0' })
                }
              } else {
                for (const registry in registries) {
                  modlistreply.registries.push({
                    name: registry,
                    marker: registries[registry]
                  })
                }
              }

              const modlistreplypacket = proto.createPacketBuffer(
                PROTODEF_TYPES.HANDSHAKE,
                {
                  discriminator: 'ModListReply',
                  data: modlistreply
                }
              )

              loginwrapperpacket = proto.createPacketBuffer(
                PROTODEF_TYPES.LOGINWRAPPER,
                {
                  channel: FML_CHANNELS.HANDSHAKE,
                  data: modlistreplypacket
                }
              )
              break
            }

            // this shouldn't happen
            case 'ModListReply':
              throw Error('received clientbound-only ModListReply from server')

            // respond with Ack
            case 'ServerRegistry': {
              loginwrapperpacket = proto.createPacketBuffer(
                PROTODEF_TYPES.LOGINWRAPPER,
                {
                  channel: FML_CHANNELS.HANDSHAKE,
                  data: proto.createPacketBuffer(PROTODEF_TYPES.HANDSHAKE, {
                    discriminator: 'Acknowledgement',
                    data: {}
                  })
                }
              )
              break
            }

            // respond with Ack
            case 'ConfigurationData': {
              loginwrapperpacket = proto.createPacketBuffer(
                PROTODEF_TYPES.LOGINWRAPPER,
                {
                  channel: FML_CHANNELS.HANDSHAKE,
                  data: proto.createPacketBuffer(PROTODEF_TYPES.HANDSHAKE, {
                    discriminator: 'Acknowledgement',
                    data: {}
                  })
                }
              )
              break
            }

            // this shouldn't happen
            case 'Acknowledgement':
              throw Error('received clientbound-only Acknowledgement from server')
          }

          writeLoginReplyNow(client, {
            messageId: data.messageId,
            data: loginwrapperpacket
          }, { channel: FML_CHANNELS.HANDSHAKE, kind: 'lockstep reply', awaited: true })
          break
        }

        default: {
          // A mod's own login message riding the loginwrapper. The server's
          // LoginWrapper routes our reply to whichever inner channel the
          // response NAMES, so the reply must be wrapped on the ORIGINATING
          // mod channel — the old fml:handshake-wrapped acknowledge was
          // delivered to the FML handshake handler while the waiting mod
          // channel never saw an answer.
          if (loginwrapper.data.length === 0) {
            // An EMPTY wrapped payload carries no discriminator — it is its
            // own honest shape (nothing to read, nothing to derive), not a
            // readVarInt failure to catch and fall through from. Answer with
            // the FML convention acknowledge on the originating channel.
            debug(`empty ${loginwrapper.channel} login payload - FML convention ack`)
            writeLoginReplyDeferred(client, { messageId: data.messageId, data: wrapLoginPayload(loginwrapper.channel, encodeAcknowledgement()) }, { channel: loginwrapper.channel, kind: 'convention ack' })
            break
          }
          try {
            const disc = readVarInt(loginwrapper.data, 0)
            const channel = loginwrapper.channel
            const messageId = data.messageId
            // same dispatch shapes as FML3 (one rule for the class), for both
            // the synchronous ladder and the HF23 deferred (acquired) rung
            const dispatch = (resolved, late) => {
              if (resolved && (resolved.failed || resolved.silent)) return true // honest join stop / deadline-law self-end — no guessed bytes
              if (resolved && resolved.declined) {
                // HF8: protocol-correct not-understood decline — messageId
                // with NO data (successful=false), same law as FML3.
                writeLoginReplyDeferred(client, { messageId }, { channel, kind: resolved.acquired ? 'wrapped decline (after acquisition)' : 'wrapped decline' })
                return true
              }
              if (resolved && resolved.reply) {
                debug(`answering ${channel} login message disc=${disc.value} via ${resolved.via} (${resolved.reply.length} bytes)`)
                writeLoginReplyDeferred(client, { messageId, data: wrapLoginPayload(channel, resolved.reply) }, { channel, kind: resolved.acquired ? 'wrapped reply (acquired)' : 'wrapped reply' })
                return true
              }
              if (late) {
                writeLoginReplyDeferred(client, { messageId }, { channel, kind: 'wrapped decline (acquisition fallback)' })
                return true
              }
              return false
            }
            const resolved = resolveWrappedModLogin(client, channel, disc.value, loginwrapper.data.slice(disc.size), options)
            if (resolved && resolved.pending) {
              // HF23: deferred behind the announced-mod acquisition (see FML3)
              resolved.pending.then((late) => dispatch(late, true)).catch((err) => {
                console.warn(`[forge] announced-mod acquisition for ${channel} threw (${err && err.message}) — answering with the protocol's not-understood decline`)
                writeLoginReplyDeferred(client, { messageId }, { channel, kind: 'wrapped decline (acquisition error)' })
              })
              break
            }
            if (dispatch(resolved, false)) break
          } catch (error) {
            debug(`failed to resolve wrapped channel ${loginwrapper.channel} (${error.message}), falling back to the FML convention ack`)
          }
          // no local knowledge: FML convention acknowledge (99), on the
          // originating channel
          console.log('other loginwrapperchannel', loginwrapper.channel, 'received, sending acknowledgement packet')
          writeLoginReplyDeferred(client, { messageId: data.messageId, data: wrapLoginPayload(loginwrapper.channel, encodeAcknowledgement()) }, { channel: loginwrapper.channel, kind: 'convention ack' })
          break
        }
      }
    } else {
      console.log('other channel', data.channel, 'received')
    }
  })
}
