'use strict'
// Test-only (HF171): a made content-mod jar of the annotation-registry shape, class files written by
// synthJar. The builder is the one the main tree's content-join test holds; two switches are added so
// a case can take away one proof of the reader: annotationConst (false: the annotation class is not a
// constant at the getAnnotation call) and versionConst (false: the registrar's version is read from a
// field). Every other bend of a case is a string rewrite by jarMutate.
const { buildClass, buildJar } = require('./synthJar')

const EVENT = 'net/neoforged/neoforge/network/event/RegisterPayloadHandlersEvent'
const TASKS_EVENT = 'net/neoforged/neoforge/network/event/RegisterConfigurationTasksEvent'
const REGISTRAR = 'net/neoforged/neoforge/network/registration/PayloadRegistrar'
const TYPE_CLS = 'net/minecraft/network/protocol/common/custom/CustomPacketPayload$Type'
const RL = 'net/minecraft/resources/ResourceLocation'
const TASK_TYPE = 'net/minecraft/server/network/ConfigurationTask$Type'
const ANN = 'synth/reg/Ann'
const DIR = 'synth/reg/Dir'
const annOf = (...consts) => [{ type: `L${ANN};`, elements: [{ name: 'value', enums: consts.map((c) => ({ type: `L${DIR};`, const: c })) }] }]

// javac's enum-switch: getstatic $SwitchMap / (selector) / ordinal / iaload /
// tableswitch {1..n}; each arm invokes ONE PayloadRegistrar method.
function emitDirectionSwitch (asm, armMethods) {
  asm.getstatic('synth/reg/ContentRegistry$1', '$SwitchMap$synth$reg$Dir', '[I')
  asm.aload(2)
  asm.invokevirtual(DIR, 'ordinal', '()I')
  asm.iaload()
  const pc0 = asm.pc
  const pad = (4 - ((pc0 + 1) % 4)) % 4
  const headerLen = 1 + pad + 12 + armMethods.length * 4
  const armLens = armMethods.map((m) => 1 + 3 + 1 + 3) // aload_0, invokevirtual, pop, goto
  const armStarts = []
  let cursor = pc0 + headerLen
  for (const len of armLens) { armStarts.push(cursor); cursor += len }
  const end = cursor // the shared return
  const bytes = [0xaa]
  for (let i = 0; i < pad; i++) bytes.push(0)
  const i32 = (v) => bytes.push((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff)
  i32(end - pc0) // default -> end
  i32(1); i32(armMethods.length) // low..high
  for (const s of armStarts) i32(s - pc0)
  asm.raw(bytes)
  armMethods.forEach((m, i) => {
    asm.aload(0)
    asm.invokevirtual(REGISTRAR, m, `(L${TYPE_CLS};)L${REGISTRAR};`)
    // pop + goto end
    asm.raw([0x57])
    const gotoPc = asm.pc
    asm.raw([0xa7, ((end - gotoPc) >> 8) & 0xff, (end - gotoPc) & 0xff])
  })
  asm.ret()
}

function buildContentModJar ({ withWedgeTask = false, withClinitCensus = true, annotationConst = true, versionConst = true } = {}) {
  const entries = []
  const censusClasses = [
    'synth/reg/pk/AlphaSyncPacket', 'synth/reg/pk/BetaInfoPacket',
    'synth/reg/pk/GammaStreamPacket', 'synth/reg/pk/DeltaActionPacket',
    'synth/reg/pk/DoneAckPacket'
  ]
  entries.push({
    name: 'synth/reg/ContentRegistry.class',
    data: buildClass({
      name: 'synth/reg/ContentRegistry',
      methods: [
        ...(withClinitCensus
          ? [
              { name: '<clinit>', desc: '()V', flags: 0x0008, code: (a) => { for (const c of censusClasses) { a.ldcCls(c); a.pop() } a.ret() } }
            ]
          : []),
        {
          name: 'registerAll',
          desc: `(L${EVENT};)V`,
          code: (a) => {
            a.aload(0)
            if (versionConst) a.ldcStr('2.7.0'); else a.getstatic('synth/reg/Ids', 'REVISION', 'Ljava/lang/String;')
            a.invokevirtual(EVENT, 'registrar', `(Ljava/lang/String;)L${REGISTRAR};`)
            a.invokevirtual(REGISTRAR, 'optional', `()L${REGISTRAR};`)
            a.pop()
            a.ret()
          }
        },
        {
          name: 'registerPacket',
          desc: `(L${REGISTRAR};Ljava/lang/Class;)V`,
          code: (a) => {
            a.aload(1)
            if (annotationConst) a.ldcCls(ANN); else a.aload(1)
            a.invokevirtual('java/lang/Class', 'getAnnotation', '(Ljava/lang/Class;)Ljava/lang/annotation/Annotation;')
            a.checkcast(ANN)
            a.pop()
            a.new_(TYPE_CLS)
            a.dup()
            a.aload(1)
            a.invokevirtual('java/lang/Class', 'getSimpleName', '()Ljava/lang/String;')
            a.invokestatic('synth/reg/Ids', 'mod', `(Ljava/lang/String;)L${RL};`)
            a.invokespecial(TYPE_CLS, '<init>', `(L${RL};)V`)
            a.pop()
            emitDirectionSwitch(a, ['configurationToClient', 'configurationToServer', 'playToClient', 'playToServer'])
          }
        }
      ]
    })
  })
  entries.push({
    name: 'synth/reg/ContentRegistry$1.class',
    data: buildClass({
      name: 'synth/reg/ContentRegistry$1',
      methods: [{
        name: '<clinit>',
        desc: '()V',
        flags: 0x0008,
        code: (a) => {
          const rows = [['CONF_TO_CLIENT', 1], ['CONF_TO_SERVER', 2], ['PLAY_TO_CLIENT', 3], ['PLAY_TO_SERVER', 4]]
          for (const [constName, k] of rows) {
            a.getstatic('synth/reg/ContentRegistry$1', '$SwitchMap$synth$reg$Dir', '[I')
            a.getstatic(DIR, constName, `L${DIR};`)
            a.invokevirtual(DIR, 'ordinal', '()I')
            a.iconst(k)
            a.iastore()
          }
          a.ret()
        }
      }]
    })
  })
  entries.push({
    name: 'synth/reg/Ids.class',
    data: buildClass({
      name: 'synth/reg/Ids',
      methods: [
        {
          name: 'mod',
          desc: `(Ljava/lang/String;)L${RL};`,
          code: (a) => {
            a.ldcStr('contentmod')
            a.aload(0)
            a.invokestatic('synth/reg/Ids', 'of', `(Ljava/lang/String;Ljava/lang/String;)L${RL};`)
            a.areturnOp()
          }
        },
        {
          name: 'of',
          desc: `(Ljava/lang/String;Ljava/lang/String;)L${RL};`,
          code: (a) => {
            a.aload(0)
            a.getstatic('java/util/Locale', 'ROOT', 'Ljava/util/Locale;')
            a.invokevirtual('java/lang/String', 'toLowerCase', '(Ljava/util/Locale;)Ljava/lang/String;')
            a.aload(1)
            a.getstatic('java/util/Locale', 'ROOT', 'Ljava/util/Locale;')
            a.invokevirtual('java/lang/String', 'toLowerCase', '(Ljava/util/Locale;)Ljava/lang/String;')
            a.invokestatic(RL, 'fromNamespaceAndPath', `(Ljava/lang/String;Ljava/lang/String;)L${RL};`)
            a.areturnOp()
          }
        }
      ]
    })
  })
  // payload classes: annotation-borne directions, Pixelmon handler shapes
  entries.push({
    name: 'synth/reg/pk/AlphaSyncPacket.class',
    data: buildClass({
      name: 'synth/reg/pk/AlphaSyncPacket',
      annotations: annOf('CONF_TO_CLIENT'),
      methods: [{
        name: 'handlePacket',
        desc: '(Lsynth/ctx/Ctx;)V',
        flags: 0x0004,
        code: (a) => {
          a.aload(0)
          a.aload(1)
          a.new_('synth/reg/pk/DoneAckPacket')
          a.dup()
          a.getstatic('synth/reg/pk/AlphaSyncPacket$AlphaTask', 'TYPE', `L${TASK_TYPE};`)
          a.invokevirtual(TASK_TYPE, 'id', '()Ljava/lang/String;')
          a.invokespecial('synth/reg/pk/DoneAckPacket', '<init>', '(Ljava/lang/String;)V')
          a.invokevirtual('synth/reg/pk/AlphaSyncPacket', 'reply', '(Lsynth/ctx/Ctx;Ljava/lang/Object;)V')
          a.ret()
        }
      }]
    })
  })
  entries.push({
    name: 'synth/reg/pk/AlphaSyncPacket$AlphaTask.class',
    data: buildClass({
      name: 'synth/reg/pk/AlphaSyncPacket$AlphaTask',
      interfaces: ['net/minecraft/server/network/ConfigurationTask'],
      fields: [{ name: 'TYPE', desc: `L${TASK_TYPE};` }],
      methods: [{
        name: '<clinit>',
        desc: '()V',
        flags: 0x0008,
        code: (a) => {
          a.new_(TASK_TYPE)
          a.dup()
          a.ldcStr('contentmod:alpha_sync')
          a.invokespecial(TASK_TYPE, '<init>', '(Ljava/lang/String;)V')
          a.putstatic('synth/reg/pk/AlphaSyncPacket$AlphaTask', 'TYPE', `L${TASK_TYPE};`)
          a.ret()
        }
      }]
    })
  })
  entries.push({ name: 'synth/reg/pk/BetaInfoPacket.class', data: buildClass({ name: 'synth/reg/pk/BetaInfoPacket', annotations: annOf('CONF_TO_CLIENT'), methods: [{ name: 'noop', desc: '()V', code: (a) => a.ret() }] }) })
  entries.push({ name: 'synth/reg/pk/GammaStreamPacket.class', data: buildClass({ name: 'synth/reg/pk/GammaStreamPacket', annotations: annOf('PLAY_TO_CLIENT'), methods: [{ name: 'noop', desc: '()V', code: (a) => a.ret() }] }) })
  entries.push({ name: 'synth/reg/pk/DeltaActionPacket.class', data: buildClass({ name: 'synth/reg/pk/DeltaActionPacket', annotations: annOf('PLAY_TO_SERVER'), methods: [{ name: 'noop', desc: '()V', code: (a) => a.ret() }] }) })
  entries.push({ name: 'synth/reg/pk/DoneAckPacket.class', data: buildClass({ name: 'synth/reg/pk/DoneAckPacket', annotations: annOf('CONF_TO_SERVER'), methods: [{ name: 'noop', desc: '()V', code: (a) => a.ret() }] }) })
  // annotated but NOT in the site <clinit> census: never registers, never claimed
  entries.push({ name: 'synth/reg/pk/OrphanPacket.class', data: buildClass({ name: 'synth/reg/pk/OrphanPacket', annotations: annOf('PLAY_TO_CLIENT'), methods: [{ name: 'noop', desc: '()V', code: (a) => a.ret() }] }) })
  // the task registration subscriber
  entries.push({
    name: 'synth/reg/TaskCollector.class',
    data: buildClass({
      name: 'synth/reg/TaskCollector',
      methods: [{
        name: 'collect',
        desc: `(L${TASKS_EVENT};)V`,
        code: (a) => {
          a.aload(0)
          a.new_('synth/reg/pk/AlphaSyncPacket$AlphaTask')
          a.dup()
          a.invokespecial('synth/reg/pk/AlphaSyncPacket$AlphaTask', '<init>', '()V')
          a.invokevirtual(TASKS_EVENT, 'register', '(Lnet/minecraft/server/network/ConfigurationTask;)V')
          if (withWedgeTask) {
            a.aload(0)
            a.new_('synth/reg/WedgeTask')
            a.dup()
            a.invokespecial('synth/reg/WedgeTask', '<init>', '()V')
            a.invokevirtual(TASKS_EVENT, 'register', '(Lnet/minecraft/server/network/ConfigurationTask;)V')
          }
          a.ret()
        }
      }]
    })
  })
  if (withWedgeTask) {
    entries.push({
      name: 'synth/reg/WedgeTask.class',
      data: buildClass({
        name: 'synth/reg/WedgeTask',
        interfaces: ['net/minecraft/server/network/ConfigurationTask'],
        fields: [{ name: 'TYPE', desc: `L${TASK_TYPE};` }],
        methods: [{
          name: '<clinit>',
          desc: '()V',
          flags: 0x0008,
          code: (a) => {
            a.new_(TASK_TYPE)
            a.dup()
            a.ldcStr('contentmod:wedge_task')
            a.invokespecial(TASK_TYPE, '<init>', '(Ljava/lang/String;)V')
            a.putstatic('synth/reg/WedgeTask', 'TYPE', `L${TASK_TYPE};`)
            a.ret()
          }
        }]
      })
    })
  }
  return buildJar(entries)
}

module.exports = { buildContentModJar }
