'use strict'
// HF73b test helper: a synthetic library / mod / control jar trio for the
// per-jar derivation pins (the fork's mocha and the app's unit tests read
// ONE builder). The mod's channel id is built by the library's static
// helper (a cross-jar resolution: the mod's trail names the library); the
// control mod resolves from its own classes alone.
const fs = require('fs')
const path = require('path')
const { buildClass, buildJar } = require('./synthJar')

const EVENT = 'net/neoforged/neoforge/network/event/RegisterPayloadHandlersEvent'
const REG = 'net/neoforged/neoforge/network/registration/PayloadRegistrar'
const TYPE = 'net/minecraft/network/protocol/common/custom/CustomPacketPayload$Type'
const RL = 'net/minecraft/resources/ResourceLocation'
const CODEC = 'net/minecraft/network/codec/StreamCodec'
const HANDLER = 'net/neoforged/neoforge/network/handling/IPayloadHandler'
const REG_DESC = `(L${TYPE};L${CODEC};L${HANDLER};)L${REG};`
const LIB = 'synth/lib/Net'
const MOD = 'synth/mod/Handlers'
const SOLO = 'synth/solo/Handlers'

// the library: register(PayloadRegistrar, String path) builds "synthlib:<path>" and registers it serverbound
function libJar (dir, { version = '1.0.0' } = {}) {
  const net = buildClass({
    name: LIB,
    methods: [{
      name: 'register',
      desc: `(L${REG};Ljava/lang/String;)V`,
      flags: 0x0009,
      code: (a) => a.aload(0).new_(TYPE).dup().ldcStr('synthlib').aload(1).invokestatic(RL, 'fromNamespaceAndPath', `(Ljava/lang/String;Ljava/lang/String;)L${RL};`).invokespecial(TYPE, '<init>', `(L${RL};)V`)
        .aconstNull().aconstNull().invokevirtual(REG, 'playToServer', REG_DESC).pop().ret()
    }]
  })
  const jar = path.join(dir, 'lib.jar')
  fs.writeFileSync(jar, buildJar([
    { name: 'META-INF/neoforge.mods.toml', data: Buffer.from(`[[mods]]\nmodId="synthlib"\nversion="${version}"\n`) },
    { name: `${LIB}.class`, data: net }
  ]))
  return jar
}

// the mod: its entry hands the registrar to the LIBRARY's helper (a cross-jar resolution)
function modJar (dir) {
  const handlers = buildClass({
    name: MOD,
    methods: [{
      name: 'onRegister',
      desc: `(L${EVENT};)V`,
      flags: 0x0009,
      code: (a) => a.aload(0).ldcStr('synthmod').invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`).ldcStr('ping').invokestatic(LIB, 'register', `(L${REG};Ljava/lang/String;)V`).ret()
    }]
  })
  const jar = path.join(dir, 'mod.jar')
  fs.writeFileSync(jar, buildJar([
    { name: 'META-INF/neoforge.mods.toml', data: Buffer.from('[[mods]]\nmodId="synthmod"\nversion="2.0.0"\n') },
    { name: `${MOD}.class`, data: handlers }
  ]))
  return jar
}

// the control: a mod resolved entirely from its own classes
function soloJar (dir) {
  const handlers = buildClass({
    name: SOLO,
    methods: [{
      name: 'onRegister',
      desc: `(L${EVENT};)V`,
      flags: 0x0009,
      code: (a) => a.aload(0).ldcStr('synthsolo').invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REG};`)
        .new_(TYPE).dup().ldcStr('synthsolo').ldcStr('pong').invokestatic(RL, 'fromNamespaceAndPath', `(Ljava/lang/String;Ljava/lang/String;)L${RL};`).invokespecial(TYPE, '<init>', `(L${RL};)V`)
        .aconstNull().aconstNull().invokevirtual(REG, 'playToServer', REG_DESC).pop().ret()
    }]
  })
  const jar = path.join(dir, 'solo.jar')
  fs.writeFileSync(jar, buildJar([
    { name: 'META-INF/neoforge.mods.toml', data: Buffer.from('[[mods]]\nmodId="synthsolo"\nversion="3.0.0"\n') },
    { name: `${SOLO}.class`, data: handlers }
  ]))
  return jar
}

module.exports = { libJar, modJar, soloJar, LIB, MOD, SOLO }
