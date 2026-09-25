/* eslint-env mocha */
'use strict'

// HF69a — three real-jar registration shapes the login-ack deriver declined
// before (F10 receipts: Silent Gear 1.20.1-3.6.7 `silentgear:network`,
// verdict `unknown` in 30 ms while a real Forge client answers index 3, an
// empty body). Every pin is a synthetic jar built by test/helpers/synthJar —
// the shipped jar is never a committed fixture.
//   (A) SPLIT CONSTANTS — the class building the channel id carries the PATH
//       half only; the namespace lives in another class's `static final
//       String MOD_ID` (ConstantValue) or in META-INF/mods.toml.
//   (B) RL SUBCLASSES — the id helper returns a ResourceLocation SUBCLASS
//       whose (String) constructor prepends the namespace through a
//       makeConcatWithConstants recipe ("<ns>:" + the argument slot).
//   (C) DIRECTION-LESS LOGIN PACKETS — messageBuilder(Class,int) with no
//       NetworkDirection (SimpleChannel#messageBuilder(Class,int) ->
//       MessageBuilder.forType(.., null) -> Optional.empty), the server's
//       payloads marked with markAsLoginPacket() (-> loginPacketGenerators
//       -> SimpleChannel#networkLoginGather; NetworkRegistry#
//       gatherLoginPayloads gathers LOGIN_TO_CLIENT only) and the client's
//       reply registered with loginIndex(..) and an encoder LAMBDA whose
//       bytecode writes nothing (IndexedMessageCodec#build: writeByte(index)
//       then the registered encoder).

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildClass, buildJar } = require('./helpers/synthJar')
const { deriveLoginAck, assessLoginChannel, _internal } = require('../src/client/loginAckDerivation')

const RL = 'net/minecraft/resources/ResourceLocation'
const SC = 'net/minecraftforge/network/simple/SimpleChannel'
const MB = 'net/minecraftforge/network/simple/SimpleChannel$MessageBuilder'
const NR = 'net/minecraftforge/network/NetworkRegistry'
const CTX = 'net/minecraftforge/network/NetworkEvent$Context'
const FBB = 'net/minecraft/network/FriendlyByteBuf'
const STR = 'Ljava/lang/String;'
const SLOT = String.fromCharCode(1) // the argument slot of a makeConcatWithConstants recipe

// the package spells neither the namespace nor the path: no class of the
// jar carries both id halves, exactly the F10 shape (Network.class had
// "network" x55 and "silentgear" x0)
const PKG = 'synth/spl'
const MOD = `${PKG}/Mod`
const MODRL = `${PKG}/ModRL`
const NET = `${PKG}/Net`
const SYNC = `${PKG}/Sync`
const REPLY = `${PKG}/Reply`
const OTHER = `${PKG}/Other`

function writeJarDir (name, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hf69a-${name}-`))
  fs.writeFileSync(path.join(dir, `${name}.jar`), buildJar(entries))
  return dir
}

// Mod: `public static final String MOD_ID = "<ns>"` (ConstantValue) and the
// id helper `static ModRL id(String path) { return new ModRL(path) }`
function modClass ({ ns, withConstant = true, helperReturns = MODRL }) {
  return buildClass({
    name: MOD,
    fields: withConstant ? [{ name: 'MOD_ID', desc: STR, constValue: ns }] : [],
    methods: [{
      name: 'id',
      desc: `(${STR})L${helperReturns};`,
      flags: 0x0009,
      code: (a) => a.new_(helperReturns).dup().aload(0).invokespecial(helperReturns, '<init>', `(${STR})V`).areturn()
    }]
  })
}

// ModRL extends ResourceLocation: ModRL(String s) { super(addNs(s)) } with
// addNs(s) = "<ns>:" + s compiled to makeConcatWithConstants("<ns>:" + slot)
function modRlClass ({ ns, superName = RL }) {
  return buildClass({
    name: MODRL,
    superName,
    bootstrapMethods: [{ refKind: 6, owner: 'java/lang/invoke/StringConcatFactory', name: 'makeConcatWithConstants', desc: '(Ljava/lang/invoke/MethodHandles$Lookup;Ljava/lang/String;Ljava/lang/invoke/MethodType;Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/invoke/CallSite;', strArgs: [`${ns}:${SLOT}`] }],
    methods: [
      { name: '<init>', desc: `(${STR})V`, code: (a) => a.aload(0).aload(1).invokestatic(MODRL, 'addNs', `(${STR})${STR}`).invokespecial(superName, '<init>', `(${STR})V`).ret() },
      { name: 'addNs', desc: `(${STR})${STR}`, flags: 0x000a, code: (a) => a.aload(0).invokedynamic(0, 'makeConcatWithConstants', `(${STR})${STR}`).areturn() }
    ]
  })
}

// the S2C login packet's encoder: writes an int (substantive)
function syncClass () {
  return buildClass({
    name: SYNC,
    methods: [{ name: 'toBytes', desc: `(L${FBB};)V`, code: (a) => a.aload(1).iconst(7).invokevirtual(FBB, 'writeInt', '(I)Lio/netty/buffer/ByteBuf;').pop().ret() }]
  })
}

// the reply class: no buffer method of its own (like LoginPacket$Reply)
function replyClass (name = REPLY, { withEmptyEncode = false } = {}) {
  return buildClass({
    name,
    methods: [
      { name: '<init>', desc: '()V', code: (a) => a.ret() },
      ...(withEmptyEncode ? [{ name: 'encode', desc: `(L${FBB};)V`, code: (a) => a.ret() }] : [])
    ]
  })
}

// Net.<clinit>: CHANNEL = NetworkRegistry.newSimpleChannel(Mod.id("handshake"));
// then the registrations, every one messageBuilder(Class,int) with NO direction
function netClass ({ helperReturns = MODRL, replyEncoder = 'empty', extraReplyAt = null, replyTo = REPLY, syncAsLoginPacket = true, syncEncoderEmpty = false } = {}) {
  const bsms = [
    { refKind: 5, owner: SYNC, name: 'toBytes', desc: `(L${FBB};)V` }, // 0: Sync::toBytes
    { refKind: 6, owner: NET, name: 'lambda$enc', desc: `(L${REPLY};L${FBB};)V` }, // 1: (reply, buf) -> ...
    { refKind: 6, owner: NET, name: 'lambda$syncEnc', desc: `(L${SYNC};L${FBB};)V` }, // 2: empty S2C encoder
    { refKind: 6, owner: NET, name: 'lambda$otherEnc', desc: `(L${OTHER};L${FBB};)V` } // 3: empty second candidate
  ]
  const register = (a, cls, index, { login = true, packet = false, bsm }) => {
    a.getstatic(NET, 'CHANNEL', `L${SC};`).ldcCls(cls).iconst(index)
      .invokevirtual(SC, 'messageBuilder', `(Ljava/lang/Class;I)L${MB};`)
    if (login) a.invokevirtual(MB, 'loginIndex', `(Ljava/util/function/Function;Ljava/util/function/BiConsumer;)L${MB};`)
    a.invokedynamic(bsm, 'accept', '()Ljava/util/function/BiConsumer;')
      .invokevirtual(MB, 'encoder', `(Ljava/util/function/BiConsumer;)L${MB};`)
    if (packet) a.invokevirtual(MB, 'markAsLoginPacket', `()L${MB};`)
    a.invokevirtual(MB, 'add', '()V')
  }
  const encBody = {
    empty: (a) => a.ret(),
    writes: (a) => a.aload(1).iconst(1).invokevirtual(FBB, 'writeByte', '(I)Lio/netty/buffer/ByteBuf;').pop().ret(),
    delegates: (a) => a.aload(0).aload(1).invokevirtual(REPLY, 'encode', `(L${FBB};)V`).ret()
  }[replyEncoder]
  return buildClass({
    name: NET,
    fields: [{ name: 'CHANNEL', desc: `L${SC};`, flags: 0x0009 }],
    bootstrapMethods: bsms,
    methods: [
      {
        name: '<clinit>',
        desc: '()V',
        flags: 0x0008,
        code: (a) => {
          a.ldcStr('handshake').invokestatic(MOD, 'id', `(${STR})L${helperReturns};`)
            .invokestatic(NR, 'newSimpleChannel', `(L${RL};)L${SC};`)
            .putstatic(NET, 'CHANNEL', `L${SC};`)
          register(a, SYNC, 1, { packet: syncAsLoginPacket, bsm: syncEncoderEmpty ? 2 : 0 })
          register(a, REPLY, 3, { bsm: 1 })
          if (extraReplyAt != null) register(a, OTHER, extraReplyAt, { bsm: 3 })
          return a.ret()
        }
      },
      { name: 'lambda$enc', desc: `(L${REPLY};L${FBB};)V`, flags: 0x100a, code: encBody },
      { name: 'lambda$syncEnc', desc: `(L${SYNC};L${FBB};)V`, flags: 0x100a, code: (a) => a.ret() },
      { name: 'lambda$otherEnc', desc: `(L${OTHER};L${FBB};)V`, flags: 0x100a, code: (a) => a.ret() },
      // the handler of the S2C login packet: channel.reply(new Reply(), ctx.get())
      ...(replyTo
        ? [{
            name: 'lambda$handle',
            desc: `(L${SYNC};Ljava/util/function/Supplier;)V`,
            flags: 0x100a,
            code: (a) => a.getstatic(NET, 'CHANNEL', `L${SC};`).new_(replyTo).dup().invokespecial(replyTo, '<init>', '()V')
              .aload(1).invokeinterface('java/util/function/Supplier', 'get', '()Ljava/lang/Object;').checkcast(CTX)
              .invokevirtual(SC, 'reply', `(Ljava/lang/Object;L${CTX};)V`).ret()
          }]
        : [])
    ]
  })
}

function modsToml (ns) {
  return { name: 'META-INF/mods.toml', data: Buffer.from(`modLoader="javafml"\n[[mods]]\n    modId="${ns}"\n    version="1.0"\n`, 'utf8') }
}

function synthJar (name, { ns = 'splitns', withConstant = true, withToml = false, helperReturns = MODRL, modRlSuper = RL, replyEncoder = 'empty', extraReplyAt = null, replyTo = REPLY, syncAsLoginPacket = true, syncEncoderEmpty = false } = {}) {
  const entries = [
    { name: `${MOD}.class`, data: modClass({ ns, withConstant, helperReturns }) },
    { name: `${MODRL}.class`, data: modRlClass({ ns, superName: modRlSuper }) },
    { name: `${NET}.class`, data: netClass({ helperReturns, replyEncoder, extraReplyAt, replyTo, syncAsLoginPacket, syncEncoderEmpty }) },
    { name: `${SYNC}.class`, data: syncClass() },
    { name: `${REPLY}.class`, data: replyClass(REPLY, { withEmptyEncode: replyEncoder === 'delegates' }) },
    { name: `${OTHER}.class`, data: replyClass(OTHER) }
  ]
  if (withToml) entries.push(modsToml(ns))
  return writeJarDir(name, entries)
}

describe('HF69a - split constants, RL subclasses, direction-less login packets with lambda encoders', function () {
  it('H1 the F10 shape derives: namespace from a String constant in another class, the id through an RL subclass, the reply = the loginIndex message with an empty lambda encoder at its explicit index', () => {
    const dir = synthJar('h1')
    const r = assessLoginChannel('splitns:handshake', [dir])
    assert.strictEqual(r.verdict, 'ack')
    assert.strictEqual(r.index, 3)
    assert.deepStrictEqual(r.reply, Buffer.from([0x03]))
    assert.strictEqual(r.msgClass, REPLY)
    assert.match(r.encoderProof, /registered encoder synth\/spl\/Net#lambda\$enc writes nothing/)
    assert.strictEqual(r.replySite, `${NET}#lambda$handle`)
    assert.strictEqual(r.loginPacketMarked, false)
    assert.strictEqual(r.corroboration, 'corroborated-by-local-jar')
  })

  it('H2 the mechanism pieces read what the jar says: the RL subclass chain, the ctor-chain namespace, the constant ownership', () => {
    const dir = synthJar('h2')
    const facts = _internal.newFacts()
    const hot = []
    const jar = path.join(dir, 'h2.jar')
    const buf = fs.readFileSync(jar)
    _internal.indexJar(buf, { jarPath: jar, chain: [], artifacts: [] }, facts, 0, Buffer.from('splitns'), Buffer.from('handshake'), hot, false)
    assert.strictEqual(hot.length, 0, 'no class carries both halves: the strict prefilter sees nothing')
    _internal.indexJar(buf, { jarPath: jar, chain: [], artifacts: [] }, facts, 0, Buffer.from('splitns'), Buffer.from('handshake'), hot, true)
    assert.deepStrictEqual(facts.nsOwners.map((o) => [o.by, o.className]), [['string-constant', MOD]])
    assert.deepStrictEqual(hot.map((h) => h.className).sort(), [NET], 'the wide pass admits the path-carrying RL-naming class only')
    assert.strictEqual(_internal.isRlClass(facts, MODRL), true)
    assert.strictEqual(_internal.isRlClass(facts, SYNC), false)
    assert.strictEqual(_internal.ctorChainNs(facts, MODRL), 'splitns')
    assert.strictEqual(_internal.helperNsOf(facts, MOD, 'id'), 'splitns')
  })

  it('H3 mods.toml modId is the namespace truth when no class carries the constant', () => {
    const dir = synthJar('h3', { ns: 'tomlns', withConstant: false, withToml: true })
    const r = assessLoginChannel('tomlns:handshake', [dir])
    assert.strictEqual(r.verdict, 'ack')
    assert.strictEqual(r.index, 3)
  })

  it('H4 a jar that owns neither the constant nor the modId stays unknown (the wide pass never widens past the owner)', () => {
    const dir = synthJar('h4', { withConstant: false })
    assert.strictEqual(assessLoginChannel('splitns:handshake', [dir]).verdict, 'unknown')
    const owned = synthJar('h4b')
    assert.strictEqual(assessLoginChannel('otherns:handshake', [owned]).verdict, 'unknown')
  })

  it('H5 NEGATIVE: a lambda encoder that writes bytes stays substantive; the markAsLoginPacket S2C payload is never the reply', () => {
    const dir = synthJar('h5', { replyEncoder: 'writes' })
    const r = assessLoginChannel('splitns:handshake', [dir])
    assert.strictEqual(r.verdict, 'underivable')
    assert.strictEqual(r.reason, 'substantive-reply')
    assert.strictEqual(r.msgClass, REPLY, 'the reply candidate, not the server-generated Sync payload')
    assert.match(r.why, /registered encoder synth\/spl\/Net#lambda\$enc writes/)
    assert.strictEqual(deriveLoginAck('splitns:handshake', [dir]), null)
  })

  it('H6 NEGATIVE: a helper returning a non-RL type resolves nothing (unknown), and a subclass chain that never reaches RL is not RL', () => {
    const dir = synthJar('h6', { helperReturns: `${PKG}/NotRl` })
    assert.strictEqual(assessLoginChannel('splitns:handshake', [dir]).verdict, 'unknown')
    const dir2 = synthJar('h6b', { modRlSuper: 'java/lang/Object' })
    assert.strictEqual(assessLoginChannel('splitns:handshake', [dir2]).verdict, 'unknown')
  })

  it('H7 a delegating lambda `(msg, buf) -> msg.encode(buf)` over an empty encode is still an empty encoder (no regression on the delegation idiom)', () => {
    const dir = synthJar('h7', { replyEncoder: 'delegates' })
    const r = assessLoginChannel('splitns:handshake', [dir])
    assert.strictEqual(r.verdict, 'ack')
    assert.strictEqual(r.index, 3)
  })

  it('H8 ranking: among two empty-encoder login messages the markAsLoginPacket one is the server payload, the other is the reply', () => {
    const dir = synthJar('h8', { syncEncoderEmpty: true })
    const r = assessLoginChannel('splitns:handshake', [dir])
    assert.strictEqual(r.verdict, 'ack')
    assert.strictEqual(r.msgClass, REPLY)
    assert.strictEqual(r.index, 3)
  })

  it('H9 ranking: two loginIndex-only empty candidates are ambiguous unless a handler replies with one of them', () => {
    const silent = synthJar('h9a', { extraReplyAt: 2, replyTo: null })
    const r = assessLoginChannel('splitns:handshake', [silent])
    assert.strictEqual(r.verdict, 'underivable')
    assert.strictEqual(r.reason, 'no-derivable-ack')
    assert.match(r.why, /ambiguous ack candidates/)
    const replied = synthJar('h9b', { extraReplyAt: 2, replyTo: OTHER })
    const r2 = assessLoginChannel('splitns:handshake', [replied])
    assert.strictEqual(r2.verdict, 'ack')
    assert.strictEqual(r2.msgClass, OTHER)
    assert.strictEqual(r2.index, 2)
    assert.strictEqual(r2.replySite, `${NET}#lambda$handle`)
  })

  it('H10 methodWritesNothing: true for a bare return, false on any buffer call, null (unproven) for a body it cannot read', () => {
    const dir = synthJar('h10')
    const facts = _internal.newFacts()
    const jar = path.join(dir, 'h10.jar')
    _internal.indexJar(fs.readFileSync(jar), { jarPath: jar, chain: [], artifacts: [] }, facts, 0, Buffer.from('splitns'), Buffer.from('handshake'), [], true)
    assert.strictEqual(_internal.methodWritesNothing(facts, { owner: NET, name: 'lambda$enc', desc: `(L${REPLY};L${FBB};)V` }), true)
    assert.strictEqual(_internal.methodWritesNothing(facts, { owner: SYNC, name: 'toBytes', desc: `(L${FBB};)V` }), false)
    assert.strictEqual(_internal.methodWritesNothing(facts, { owner: `${PKG}/Missing`, name: 'x', desc: '()V' }), null)
  })
})
