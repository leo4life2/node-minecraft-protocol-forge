/* eslint-env mocha */
// HF175 - the places where a reading still left NO row for something a server
// can refuse the pal for:
//   K1  a registration whose optional() the walk did not decide (it stands
//       under a condition, in the listener or in a caller of the helper that
//       makes the call) and whose version is not derivable said "safely
//       unclaimed" and handed over no row: in the listener's own registration
//       and in a registration several call sites share (the aggregator's row
//       did not carry whether optional was decided)
//   K2  an entry whose registrar never reaches a registration, a jar that
//       could not be read, a nested jar that could not be read and a jar in
//       which a class asks the event for a registrar in code no entry leads to
//       wrote a sentence (or nothing) and no row
// Each made jar has a TWIN that must stay as it is (optional() unconditional,
// its condition decided, the registrar reaching its registration): no row.
// The claims and the listen-only ids of every made jar are those of the commit
// before (fixtures/hf175/base-golden.json was made there): this change hands
// over rows and changes no claim.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const D = require('../src/client/neoForgePayloadDerivation')
const J = require('./helpers/hf175Jars')
const { dispatchJar, registrationSignJar } = require('./helpers/hf175Dispatch')
const { buildClass, buildJar } = require('./helpers/synthJar')

const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hf175', 'base-golden.json'), 'utf8'))
const JARS = {
  'k-direct-undecided.jar': () => J.direct('undecided'),
  'k-direct-plain.jar': () => J.direct('plain'),
  'k-direct-decided.jar': () => J.direct('decided'),
  'k-direct-callee.jar': () => J.direct('callee'),
  'k-direct-calleeplain.jar': () => J.direct('calleePlain'),
  'k-direct-none.jar': () => J.direct('none'),
  'k-direct-claimed.jar': () => J.direct('none', { version: '7' }),
  'k-shared-undecided.jar': () => J.shared('undecided'),
  'k-shared-plain.jar': () => J.shared('plain'),
  'k-shared-decided.jar': () => J.shared('decided'),
  'k-shared-callee.jar': () => J.shared('callee'),
  'k-shared-calleeplain.jar': () => J.shared('calleePlain'),
  'k-shared-none.jar': () => J.shared('none'),
  'k-silent.jar': () => J.silent(),
  'k-late.jar': () => J.late('asks'),
  'k-late-lib.jar': () => J.late('lib'),
  'k-late-entry.jar': () => J.late('entry'),
  'k-garbage.jar': () => J.garbage(),
  'k-nested-bad.jar': () => J.nestedBad(),
  'k-direct-switchcase.jar': () => J.direct('switchCase'),
  'k-direct-switchdefault.jar': () => J.direct('switchDefault'),
  'k-direct-switchboth.jar': () => J.direct('switchBoth'),
  'k-direct-switchbefore.jar': () => J.direct('switchBefore'),
  'k-direct-switchcase-versioned.jar': () => J.direct('switchCase', { version: '7' }),
  'k-shared-switchcase.jar': () => J.shared('switchCase'),
  'k-shared-switchdefault.jar': () => J.shared('switchDefault'),
  'k-shared-switchbefore.jar': () => J.shared('switchBefore'),
  'k-direct-lookupcase.jar': () => J.direct('lookupCase'),
  'k-direct-lookupdefault.jar': () => J.direct('lookupDefault'),
  'k-shared-lookupdefault.jar': () => J.shared('lookupDefault'),
  'k-beside.jar': () => J.beside(),
  'k-thrown.jar': () => J.thrown(true),
  'k-thrown-twin.jar': () => J.thrown(false),
  'k-thrown-early.jar': () => J.thrown('early')
}
// the rows the code before the lane handed over for each made jar (made there: fixtures/hf175/base-rows.json)
const BASE_ROWS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hf175', 'base-rows.json'), 'utf8'))
const FACTS = ['kind', 'jar', 'site', 'method', 'protocols', 'flow', 'version', 'optional', 'id', 'says']

describe('HF175: the word of a reading, its remaining places', function () {
  this.timeout(60000)
  let dir
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf175-')) })
  after(() => { fs.rmSync(dir, { recursive: true, force: true }) })
  const read = (name) => { const p = path.join(dir, name); fs.writeFileSync(p, JARS[name]()); return D.deriveNeoForgeComponents([p]) }
  const rows = (r) => (r.diagnostics.unresolvedSites || [])
    .map((s) => [s.kind, s.jar, s.method, (s.protocols || []).join('+') || null, s.flow, s.version, s.id])
    .sort((x, y) => JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)
  const sentences = (r, re) => r.diagnostics.abstains.filter((a) => re.test(a)).length
  const noRow = (r) => assert.deepStrictEqual(r.diagnostics.unresolvedSites || [], [])
  const everyRowNamesItsSentence = (r) => assert.ok((r.diagnostics.unresolvedSites || []).every((s) => typeof s.says === 'string' && s.says !== ''), 'each row names its sentence')
  const SAFELY = /safely unclaimed$/

  it('G the claims and the listen-only ids of every made jar are those of the commit before (no claim row leaves, none is added, no tuple changes)', () => {
    for (const name of Object.keys(JARS)) {
      const r = read(name)
      assert.deepStrictEqual(r.components, GOLDEN[name].components, `${name}: the claims`)
      assert.deepStrictEqual(r.listenOnly || [], GOLDEN[name].listenOnly, `${name}: the listen-only ids`)
    }
    assert.strictEqual(Object.keys(GOLDEN).length, Object.keys(JARS).length)
  })

  describe('K1 the listener\'s own registration, its version not derivable', () => {
    it('D1 optional() under a condition the walk cannot decide: one row of kind version with the id, the method and the direction; no sentence says safely unclaimed', () => {
      const r = read('k-direct-undecided.jar')
      assert.deepStrictEqual(rows(r), [['version', 'k-direct-undecided.jar', 'playToClient', 'play', 'clientbound', null, 'kmod:direct']])
      assert.strictEqual(sentences(r, SAFELY), 0)
      assert.strictEqual(sentences(r, /^kmod:direct: .*NOT safely unclaimed/), 1)
      everyRowNamesItsSentence(r)
    })
    it('D1t the twin, optional() unconditional: proven optional, its sentence kept, no row', () => {
      const r = read('k-direct-plain.jar')
      noRow(r)
      assert.deepStrictEqual(r.diagnostics.abstains, GOLDEN['k-direct-plain.jar'].abstains)
      assert.strictEqual(sentences(r, /^kmod:direct: optional channel with unresolved version — safely unclaimed$/), 1)
    })
    it('D2 optional() inside a helper of the mod that is called under an undecided condition: one row of kind version', () => {
      const r = read('k-direct-callee.jar')
      assert.deepStrictEqual(rows(r), [['version', 'k-direct-callee.jar', 'playToClient', 'play', 'clientbound', null, 'kmod:direct']])
      assert.strictEqual(sentences(r, SAFELY), 0)
    })
    it('D2t the twin, the same helper called unconditionally: proven optional, no row', () => {
      const r = read('k-direct-calleeplain.jar')
      noRow(r)
      assert.deepStrictEqual(r.diagnostics.abstains, GOLDEN['k-direct-calleeplain.jar'].abstains)
    })
    it('D3 a required registration: one row of kind version, as before', () => {
      const r = read('k-direct-none.jar')
      assert.deepStrictEqual(rows(r), [['version', 'k-direct-none.jar', 'playToClient', 'play', 'clientbound', null, 'kmod:direct']])
      assert.deepStrictEqual(r.diagnostics.abstains, GOLDEN['k-direct-none.jar'].abstains)
    })
  })

  describe('K1 a registration several call sites share (the aggregator\'s row), its version not derivable', () => {
    it('A1 optionality undecided: a row of kind version for each id, in one jar, with the direction; no sentence says safely unclaimed', () => {
      const r = read('k-shared-undecided.jar')
      assert.deepStrictEqual(rows(r), [
        ['version', 'k-shared-undecided.jar', null, 'play', 'clientbound', null, 'kmod:one'],
        ['version', 'k-shared-undecided.jar', null, 'play', 'clientbound', null, 'kmod:two']
      ])
      assert.strictEqual(new Set(r.diagnostics.unresolvedSites.map((s) => s.jar)).size, 1)
      assert.strictEqual(sentences(r, SAFELY), 0)
      assert.strictEqual(sentences(r, /^kmod:(one|two): aggregated .*NOT safely unclaimed/), 2)
      everyRowNamesItsSentence(r)
    })
    it('A1t the twin, proven optional (the call unconditional): its sentences kept, no row', () => {
      const r = read('k-shared-plain.jar')
      noRow(r)
      assert.deepStrictEqual(r.diagnostics.abstains, GOLDEN['k-shared-plain.jar'].abstains)
      assert.strictEqual(sentences(r, /^kmod:(one|two): aggregated optional channel with unresolved version — safely unclaimed$/), 2)
    })
    it('A2t the twin, the condition decided (a constant): proven optional, no row', () => {
      const r = read('k-shared-decided.jar')
      noRow(r)
      assert.deepStrictEqual(r.diagnostics.abstains, GOLDEN['k-shared-decided.jar'].abstains)
    })
    it('A3 required: a row of kind version for each id, as before', () => {
      const r = read('k-shared-none.jar')
      assert.deepStrictEqual(rows(r), [
        ['version', 'k-shared-none.jar', null, 'play', 'clientbound', null, 'kmod:one'],
        ['version', 'k-shared-none.jar', null, 'play', 'clientbound', null, 'kmod:two']
      ])
      assert.deepStrictEqual(r.diagnostics.abstains, GOLDEN['k-shared-none.jar'].abstains)
    })
    it('A4 optional() inside a helper called under an undecided condition, the id not provable at the shared call: the registration is handed over, never safely unclaimed', () => {
      const r = read('k-shared-callee.jar')
      assert.ok(rows(r).length >= 1, 'at least one row')
      for (const row of rows(r)) assert.deepStrictEqual(row, ['registration', 'k-shared-callee.jar', 'playToClient', 'play', 'clientbound', null, null])
      assert.strictEqual(sentences(r, SAFELY), 0)
      assert.ok(sentences(r, /NOT safely unclaimed/) >= 1)
    })
    it('A4t the twin, the same helper called unconditionally: proven optional, its sentence kept, no row', () => {
      const r = read('k-shared-calleeplain.jar')
      noRow(r)
      assert.deepStrictEqual(r.diagnostics.abstains, GOLDEN['k-shared-calleeplain.jar'].abstains)
    })
  })

  describe('registrar call coverage', () => {
    const entry = 'fixture/Entry'
    const event = 'net/neoforged/neoforge/network/event/RegisterPayloadHandlersEvent'
    const registrar = 'net/neoforged/neoforge/network/registration/PayloadRegistrar'
    const type = 'net/minecraft/network/protocol/common/custom/CustomPacketPayload$Type'
    const id = 'net/minecraft/resources/Identifier'
    const bus = 'net/neoforged/bus/api/IEventBus'
    const consumer = 'Ljava/util/function/Consumer;'
    const listener = '(L' + event + ';)V'
    const array = '([Ljava/lang/Object;)V'

    function inspect (shape) {
      const asks = []
      function ask (a, method) {
        a.ldcStr('7')
        asks.push(entry + '.' + method + '@' + a.bytes.length)
        a.invokevirtual(event, 'registrar', '(Ljava/lang/String;)L' + registrar + ';')
      }
      function forward (a, owner) {
        const object = a.cp.cls('java/lang/Object')
        a.iconst(1).raw([0xbd, object >> 8, object & 255]).dup().iconst(0).aload(1).raw([0x53])
          .invokestatic(owner, 'forward', array)
      }
      const methods = [
        {
          name: '<init>',
          desc: '(L' + bus + ';)V',
          flags: 1,
          code (a) {
            a.aload(0).invokespecial('java/lang/Object', '<init>', '()V').aload(1)
              .invokedynamic(0, 'accept', '()' + consumer).invokeinterface(bus, 'addListener', '(' + consumer + ')V', 2).ret()
          }
        },
        {
          name: 'onPayloads',
          desc: listener,
          flags: 9,
          code (a) {
            ask(a.aload(0), 'onPayloads' + listener)
            a.astore(1)
            forward(a, entry)
            if (shape === 'second call') {
              ask(a.aload(0), 'onPayloads' + listener)
              a.astore(1)
            }
            if (shape === 'missing constructor') {
              a.new_('fixture/Missing').dup().aload(1).invokespecial('fixture/Missing', '<init>', '(L' + registrar + ';)V').pop()
            }
            if (shape === 'lost helper' || shape === 'second call') forward(a, 'fixture/Missing')
            a.ret()
          }
        },
        {
          name: 'forward',
          desc: array,
          flags: 9,
          code (a) {
            a.aload(0).iconst(0).aaload().checkcast(registrar).new_(type).dup().ldcStr('fixture').ldcStr('covered')
              .invokestatic(id, 'fromNamespaceAndPath', '(Ljava/lang/String;Ljava/lang/String;)L' + id + ';')
              .invokespecial(type, '<init>', '(L' + id + ';)V').aconstNull().aconstNull()
              .invokevirtual(registrar, 'playToClient', '(L' + type + ';Ljava/lang/Object;Ljava/lang/Object;)L' + registrar + ';').pop().ret()
          }
        }
      ]
      if (shape === 'unvisited') {
        const desc = '(Ljava/lang/Object;)V'
        methods.push({
          name: 'other',
          desc,
          flags: 9,
          code (a) {
            ask(a.aload(0).checkcast(event), 'other' + desc)
            a.astore(1)
            forward(a, entry)
            a.ret()
          }
        })
      }
      const data = buildClass({
        name: entry,
        methods,
        annotations: [{ type: 'Lnet/neoforged/fml/common/Mod;', elements: [{ name: 'value', string: 'fixture' }] }],
        bootstrapMethods: [{ owner: entry, name: 'onPayloads', desc: listener }]
      })
      const jar = path.join(dir, 'hand-off.jar')
      fs.writeFileSync(jar, buildJar([
        { name: 'META-INF/neoforge.mods.toml', data: Buffer.from('[[mods]]\nmodId="fixture"\nversion="1"\n') },
        { name: entry + '.class', data }
      ]))
      const { diagnostics, components } = D.deriveNeoForgeComponents([jar])
      assert.deepStrictEqual(diagnostics.errors, [])
      assert.deepStrictEqual(components.play.map(c => [c.id, c.version, c.flow, c.optional]), [['fixture:covered', '7', 'clientbound', false]])
      return { asks, sites: (diagnostics.unresolvedSites || []).map(s => [s.kind, s.site, s.wordOnly]) }
    }

    it('a registrar forwarded in an array to a recorded registration leaves the reading complete', () => {
      assert.deepStrictEqual(inspect('covered').sites, [])
    })
    it('an unvisited registrar call in the same class keeps the reading partial and names its instruction', () => {
      const { asks, sites } = inspect('unvisited')
      assert.deepStrictEqual(sites, [['unseen', asks[1], true]])
    })
    it('a second registrar call in the same listener has its own bytecode offset and needs its own registration', () => {
      const { asks, sites } = inspect('second call')
      assert.deepStrictEqual(sites, [['unseen', asks[1], true]])
    })
    it('a missing constructor that receives the same registrar keeps its call unread', () => {
      const { asks, sites } = inspect('missing constructor')
      assert.deepStrictEqual(sites, [['unseen', asks[0], true]])
    })
    it('a registrar sent to a missing helper keeps the reading partial even when its other hand-off registered', () => {
      const { asks, sites } = inspect('lost helper')
      assert.deepStrictEqual(sites, [['unseen', asks[0], true]])
    })
  })

  describe('registration signs', () => {
    function probe (shape) {
      const file = path.join(dir, 'sign.jar')
      fs.writeFileSync(file, registrationSignJar(shape))
      const { components, diagnostics } = D.deriveNeoForgeComponentsPerJar([file])
      const signs = [...(diagnostics.unresolvedSites || []), ...(diagnostics.inputSigns || [])]
      return { claims: components.play.map(c => [c.id, c.version]), signs, diagnostics }
    }

    for (const [shape, reason] of [['catch', 'exception handler'], ['catch local', 'exception handler'],
      ['guarded registration', 'undecided branch'], ['switched registration', 'undecided switch'], ['branch', 'undecided branch'], ['switch', 'undecided switch'],
      ['call registrar', 'unresolved result'], ['call id', 'unresolved result'], ['call version', 'unresolved result'], ['erased call', 'unresolved result'], ['bad text', 'invalid modified UTF-8']]) {
      it(`reports ${shape} at the affected input or instruction`, () => {
        const { claims, signs } = probe(shape)
        assert.ok(signs.some(s => s.reason?.startsWith(reason) && /@\d+$/.test(s.site)), JSON.stringify(signs))
        assert.deepStrictEqual(claims, shape === 'bad text' ? [] : [['fixture:base', '1']])
      })
    }
    for (const [shape, version] of [['unrelated catch', '1'], ['unused call', '1'], ['decided', 'A'], ['text', '1😀']]) {
      it(`reads ${shape} completely with its exact tuples`, () => {
        const { claims, signs } = probe(shape)
        assert.deepStrictEqual(signs, [])
        assert.deepStrictEqual(claims, [['fixture:base', '1'], ['fixture:late', version]])
      })
    }
    it('records the nested jar whose class entry could not be decompressed', () => {
      const name = 'lost/Setup.class'
      const inner = buildJar([{ name, data: buildClass({ name: 'lost/Setup', methods: [] }) }])
      const central = inner.indexOf(Buffer.from('504b0102', 'hex'))
      inner.writeUInt16LE(99, central + 10)
      const outer = path.join(dir, 'compressed.jar')
      fs.writeFileSync(outer, buildJar([{ name: 'META-INF/jarjar/inner.jar', data: inner }]))
      const { diagnostics } = D.deriveNeoForgeComponentsPerJar([outer])
      assert.deepStrictEqual(diagnostics.unresolvedSites.map(s => [s.jar, s.site, s.reason]), [
        ['compressed.jar!inner.jar', name, 'unreadable class entry']
      ])
      assert.strictEqual(diagnostics.jarsRead, 0)
    })
    it('names the first nested jar beyond the read limit', () => {
      let data = registrationSignJar('unused call')
      for (let i = 0; i < 4; i++) data = buildJar([{ name: 'META-INF/jarjar/inner.jar', data }])
      const file = path.join(dir, 'outer.jar')
      fs.writeFileSync(file, data)
      const { diagnostics } = D.deriveNeoForgeComponentsPerJar([file])
      const skipped = (diagnostics.unresolvedSites || []).filter(s => s.reason === 'nested jar below depth limit')
      assert.deepStrictEqual(skipped.map(s => s.jar), ['outer.jar' + '!inner.jar'.repeat(4)])
      assert.strictEqual(diagnostics.jarsRead, 0)
    })
  })

  // Optional public fixture corpus. Each digest pins all phase/id/flow/version/
  // optional tuples plus the listen-only list from the verified round-two read.
  const fixtureRoot = process.env.MINEPAL_PACK_READER_FIXTURES
  const publicCase = fixtureRoot ? it : it.skip
  for (const [rig, jar, count, hash] of [
    ['hf16r', null, 40, '055838802ad221910f534a1b7736fc30446b74478a2b7b0e8d718790f19a3478'],
    ['hf16r', 'epic-fight-21.17.3.1-mc1.21.1-neoforge.jar', 40, '055838802ad221910f534a1b7736fc30446b74478a2b7b0e8d718790f19a3478'],
    ['hf16r', 'invincible-21.15.8.2-mc1.21.1-neoforge.jar', 0, '643d5437104296e21d906ecb15b2c96ad278f20cfc4af53b12bb6069bd853726'],
    ['neo263m', null, 13, 'ec7fa56b305c197295cef7fbab22f9eacbd2701ffa35236d0b8d93ded5d419fb'],
    ['neo263m', 'Jade-mc26.3-NeoForge-26.3.5.jar', 6, 'ce713d6642ffbfe26ae609f3e48997ffc876c19c687c94182d7325a3493b6453'],
    ['neo263m', 'appleskin-neoforge-mc26.3-3.0.10.jar', 3, '23bcb80e230f6cce5dac6d3ac87e435e4b96755ec2bce0531a3fcb3f69c001c3'],
    ['neo263m', 'carryon-neoforge-26.3-2.12.2.jar', 4, '9ff35084a033cbedd991a93a27842d33f9f79c88b00367216928b5eb9a53fc3e']
  ]) {
    publicCase(`keeps the complete reading and every claim of ${jar || rig}`, () => {
      const mods = path.join(fixtureRoot, rig, 'mods')
      const names = jar ? [jar] : fs.readdirSync(mods).filter(n => n.endsWith('.jar')).sort()
      const { components, diagnostics, listenOnly } = D.deriveNeoForgeComponentsPerJar(names.map(n => path.join(mods, n)))
      assert.deepStrictEqual(diagnostics.errors, [])
      assert.deepStrictEqual(diagnostics.unresolvedSites || [], [])
      assert.deepStrictEqual(diagnostics.inputSigns || [], [])
      const tuples = Object.entries(components).flatMap(([phase, values]) => values.map(c => [phase, c.id, c.flow, c.version, c.optional]))
      tuples.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)
      assert.strictEqual(tuples.length, count)
      const wireFacts = JSON.stringify([tuples, [...listenOnly].sort()])
      assert.strictEqual(require('crypto').createHash('sha256').update(wireFacts).digest('hex'), hash)
    })
  }

  describe('registrar dispatch proof', () => {
    function check (shape, claims, unresolved) {
      const { jar, sites } = dispatchJar(shape)
      const file = path.join(dir, 'dispatch.jar')
      fs.writeFileSync(file, jar)
      const { components, diagnostics } = D.deriveNeoForgeComponentsPerJar([file])
      assert.deepStrictEqual(diagnostics.errors, [])
      const remaining = diagnostics.unresolvedSites || []
      assert.deepStrictEqual(remaining.map(r => [r.kind, r.site]), unresolved ? [[unresolved === 'id' ? 'registration' : 'unseen', sites[unresolved]]] : [])
      assert.deepStrictEqual(components.play.map(c => [c.id, c.version, c.flow, c.optional]).sort(),
        claims.map(([id, version = '1']) => ['fixture:' + id, version, 'clientbound', false]).sort())
    }

    it('an unknown receiver cannot dispatch to the interface default', () => check('unknown override', [['base']], '1'))
    it('one present service provider cannot satisfy two listed providers', () => check('missing provider', [['base']], '1'))
    it('findFirst still needs every listed provider to be present', () => check('first only', [['base']], '1'))
    it('alternative implementations add no unconditional claim', () => check('abstract alternatives', [['base']], '1'))
    it('registrations in exclusive branch arms stay unclaimed', () => check('branch calls', [['base']], '1'))
    it('a receiver selected by an unknown branch stays undecided at the join', () => check('branch receiver', [['base']], '1'))
    it('a branch before the registrar ask cannot choose its later receiver', () => check('earlier receiver', [['base']], '1'))
    it('two present service providers leave the receiver undecided', () => check('two providers', [['base']], '1'))
    it('one listed and present service provider covers the call', () => check('one provider', [['base'], ['first']]))
    it('an allocated receiver uses only its own override', () => check('known receiver', [['second'], ['extra']]))
    it('a service declaration cannot bind an unrelated receiver', () => check('unrelated service', [['base']], '1'))
    it('a factory return type with a subclass cannot prove the receiver', () => check('factory bound', [['base']], '1'))
    it('an allocated receiver inherits the most specific interface default', () => check('specific default', [['child']]))
    it('a reassigned registrar field uses the new version', () => check('field', [['first'], ['second', '2']]))
    it('a captured registrar escaping the reader leaves its ask unread', () => check('capture', [['base']], '1'))
    it('only the second of two asks is unread', () => check('second ask', [['base']], '2'))
    it('a runtime ID names the registration instruction in the callee', () => check('runtime id', [['base']], 'id'))
    it('a direct registration still covers its ask', () => check('plain', [['base']]))
  })

  describe('K2 nothing of a registration was seen', () => {
    it('S1 the registrar never reaches a registration: its sentence as before and ONE row of its jar (kind unseen, the entry)', () => {
      const r = read('k-silent.jar')
      assert.deepStrictEqual(r.diagnostics.abstains, GOLDEN['k-silent.jar'].abstains, 'the sentence is the one of before')
      assert.deepStrictEqual(rows(r), [['unseen', 'k-silent.jar', null, null, null, null, null]])
      assert.strictEqual(r.diagnostics.unresolvedSites[0].site, `${J.INIT}.onRegister(Lnet/neoforged/neoforge/network/event/RegisterPayloadHandlersEvent;)V@3`)
      assert.strictEqual(r.diagnostics.unresolvedSites[0].says, r.diagnostics.abstains[0])
    })
    it('S1t the twin, the registrar reaches its registration and the id and the version are constants: claimed, no row', () => {
      const r = read('k-direct-claimed.jar')
      noRow(r)
      assert.deepStrictEqual(r.components.play.map((c) => [c.id, c.version, c.flow, c.optional]), [['kmod:direct', '7', 'clientbound', false]])
    })
    it('J1 a jar whose class asks the event for a registrar in a method that does not take the event (no entry leads to it): the reading held nothing of it; now ONE row of the jar (kind unseen, the class)', () => {
      const r = read('k-late.jar')
      assert.deepStrictEqual(rows(r), [['unseen', 'k-late.jar', null, null, null, null, null]])
      assert.strictEqual(r.diagnostics.unresolvedSites[0].site, J.LATE + '.accept(Ljava/lang/Object;)V@6')
      assert.strictEqual(r.diagnostics.abstains.length, 1)
      everyRowNamesItsSentence(r)
    })
    it('J1t the twin, a jar whose class only RECEIVES a registrar and that nothing hands one (a library nobody uses): no row, no sentence', () => {
      const r = read('k-late-lib.jar')
      noRow(r)
      assert.deepStrictEqual(r.diagnostics.abstains, [])
    })
    it('J2t the twin, that helper reached from a listener of the jar: claimed, no row, no sentence', () => {
      const r = read('k-late-entry.jar')
      noRow(r)
      assert.deepStrictEqual(r.diagnostics.abstains, [])
      assert.deepStrictEqual(r.components.play.map((c) => [c.id, c.version, c.flow]), [['kmod:late', '1', 'clientbound']])
    })
    it('U1 a jar that cannot be opened: ONE row of that jar (kind unseen)', () => {
      const r = D.deriveNeoForgeComponents([path.join(dir, 'k-missing.jar')])
      assert.deepStrictEqual(rows(r), [['unseen', 'k-missing.jar', null, null, null, null, null]])
      assert.strictEqual(r.diagnostics.errors.filter((e) => /^k-missing\.jar: unreadable/.test(e)).length, 1)
    })
    it('U2 a jar that is no zip: ONE row of that jar (kind unseen)', () => {
      const r = read('k-garbage.jar')
      assert.deepStrictEqual(rows(r), [['unseen', 'k-garbage.jar', null, null, null, null, null]])
      assert.strictEqual(r.diagnostics.errors.filter((e) => /^k-garbage\.jar: bad zip/.test(e)).length, 1)
    })
    it('U3 a nested jar that cannot be read: ONE row that names the outer jar and the nested one (kind unseen)', () => {
      const r = read('k-nested-bad.jar')
      assert.strictEqual(r.diagnostics.errors.filter((e) => /^k-nested-bad\.jar!.*nested jar unreadable/.test(e)).length, 1, JSON.stringify(r.diagnostics.errors))
      assert.strictEqual(rows(r).length, 1)
      assert.strictEqual(rows(r)[0][0], 'unseen')
      assert.ok(/^k-nested-bad\.jar!/.test(rows(r)[0][1]), rows(r)[0][1])
    })
    it('the mark travels: a unit result and the assembly carry it on each row this lane hands over, through a kept per-jar result', () => {
      for (const name of ['k-silent.jar', 'k-direct-undecided.jar', 'k-shared-callee.jar', 'k-beside.jar']) {
        const p = path.join(dir, name); fs.writeFileSync(p, JARS[name]())
        const whole = D.deriveNeoForgeComponents([p]).diagnostics.unresolvedSites.map((s) => [s.kind, s.wordOnly === true])
        const { perJar, read: rd } = D.deriveNeoForgeComponentsPerJar([p])
        const assembled = D.assembleNeoForgeComponents(rd, JSON.parse(JSON.stringify(perJar)))
        assert.deepStrictEqual(assembled.diagnostics.unresolvedSites.map((s) => [s.kind, s.wordOnly === true]), whole, name)
        assert.ok(whole.some((w) => w[1]), `${name}: a marked row`)
      }
    })
    it('a unit result and the assembly carry the rows (a kept per-jar result keeps them)', () => {
      const p = path.join(dir, 'k-silent.jar'); fs.writeFileSync(p, JARS['k-silent.jar']())
      const { perJar, read: rd } = D.deriveNeoForgeComponentsPerJar([p])
      assert.deepStrictEqual(perJar.flatMap((u) => u.diagnostics.unresolvedSites || []).map((s) => [s.kind, s.jar]), [['unseen', 'k-silent.jar']])
      const kept = JSON.parse(JSON.stringify(perJar))
      const assembled = D.assembleNeoForgeComponents(rd, kept)
      assert.deepStrictEqual((assembled.diagnostics.unresolvedSites || []).map((s) => [s.kind, s.jar]), [['unseen', 'k-silent.jar']])
    })
  })

  // ---- the remediation round ----
  const marked = (r) => (r.diagnostics.unresolvedSites || []).filter((s) => s.wordOnly === true)
  const unmarked = (r) => (r.diagnostics.unresolvedSites || []).filter((s) => s.wordOnly !== true)
  const kinds = (list) => list.map((s) => s.kind).sort()

  describe('M3 the mark: a row this lane hands over is for the word alone (wordOnly); every other row is the row of the code before', () => {
    it('R1 for every made jar the rows WITHOUT the mark are, fact for fact and in order, the rows the code before the lane handed over', () => {
      for (const name of Object.keys(JARS)) {
        const r = read(name)
        assert.deepStrictEqual(unmarked(r).map((s) => FACTS.map((k) => s[k])), BASE_ROWS[name], `${name}: the unmarked rows`)
        assert.ok(unmarked(r).every((s) => !('wordOnly' in s)), `${name}: an unmarked row holds no such key`)
      }
      assert.deepStrictEqual(Object.keys(BASE_ROWS).sort(), Object.keys(JARS).sort())
    })
    it('R2 the places: an optional() not proven (the listener\'s own, a shared one, in a helper), an id not provable behind such an optional(), an entry that lost its registrar, a jar asking in code no entry leads to, a jar or a nested jar that cannot be read: each row is marked', () => {
      const want = {
        'k-direct-undecided.jar': ['version'],
        'k-direct-callee.jar': ['version'],
        'k-shared-undecided.jar': ['version', 'version'],
        'k-shared-callee.jar': ['registration'],
        'k-silent.jar': ['unseen'],
        'k-late.jar': ['unseen'],
        'k-garbage.jar': ['unseen'],
        'k-nested-bad.jar': ['unseen']
      }
      for (const [name, k] of Object.entries(want)) {
        const r = read(name)
        assert.deepStrictEqual(kinds(marked(r)), k, `${name}: the marked rows`)
        assert.deepStrictEqual(unmarked(r), [], `${name}: no other row`)
      }
      const missing = D.deriveNeoForgeComponents([path.join(dir, 'k-missing.jar')])
      assert.deepStrictEqual([kinds(marked(missing)), unmarked(missing).length], [['unseen'], 0], 'a jar that cannot be opened')
    })
    it('R3 a required registration is no row of this lane: its rows carry no mark (the listener\'s own, a shared one)', () => {
      for (const name of ['k-direct-none.jar', 'k-shared-none.jar', 'k-shared-switchcase.jar']) {
        const r = read(name)
        assert.deepStrictEqual(marked(r), [], name)
        assert.ok(unmarked(r).length >= 1 && unmarked(r).every((s) => s.kind === 'version'), name)
      }
    })
    it('R4 a jar with both: the registration whose id is made at run time keeps its row of before, unmarked; the optional() not proven beside it is marked (the reader keeps its own order; the receipt of the main tree lists the unmarked rows first)', () => {
      const r = read('k-beside.jar')
      assert.deepStrictEqual(r.diagnostics.unresolvedSites.map((s) => [s.kind, s.method, s.version, s.id, s.wordOnly === true]), [['version', 'playToClient', null, 'kmod:direct', true], ['registration', 'playToClient', '7', null, false]])
    })
  })

  describe('M2 optional() under a switch the walk did not decide is not proven', () => {
    const versionRow = (name, id, method) => ['version', name, method, 'play', 'clientbound', null, id]
    it('X1 the listener\'s own registration, optional() in the case arm: one marked row of kind version, no sentence says safely unclaimed', () => {
      const r = read('k-direct-switchcase.jar')
      assert.deepStrictEqual(rows(r), [versionRow('k-direct-switchcase.jar', 'kmod:direct', 'playToClient')])
      assert.strictEqual(sentences(r, SAFELY), 0)
      assert.strictEqual(marked(r).length, 1)
    })
    it('X2 the listener\'s own registration, optional() in the default arm: one marked row of kind version', () => {
      const r = read('k-direct-switchdefault.jar')
      assert.deepStrictEqual(rows(r), [versionRow('k-direct-switchdefault.jar', 'kmod:direct', 'playToClient')])
      assert.strictEqual(sentences(r, SAFELY), 0)
      assert.strictEqual(marked(r).length, 1)
    })
    it('X3 a registration several call sites share, optional() in the default arm (the arm the deep walk takes): a marked row of kind version for each id', () => {
      const r = read('k-shared-switchdefault.jar')
      assert.deepStrictEqual(rows(r), [versionRow('k-shared-switchdefault.jar', 'kmod:one', null), versionRow('k-shared-switchdefault.jar', 'kmod:two', null)])
      assert.strictEqual(sentences(r, SAFELY), 0)
      assert.strictEqual(marked(r).length, 2)
    })
    it('X4 optional() in EVERY arm of the switch is still not proven (the walk joins no arms): one marked row; a later lane that joins arms changes this case knowingly', () => {
      const r = read('k-direct-switchboth.jar')
      assert.deepStrictEqual(rows(r), [versionRow('k-direct-switchboth.jar', 'kmod:direct', 'playToClient')])
      assert.strictEqual(marked(r).length, 1)
    })
    it('X5 the other switch opcode (lookupswitch): the listener\'s own registration in the case arm and in the default arm, and a shared one in the default arm: marked rows of kind version, no sentence says safely unclaimed', () => {
      for (const name of ['k-direct-lookupcase.jar', 'k-direct-lookupdefault.jar']) {
        const r = read(name)
        assert.deepStrictEqual(rows(r), [versionRow(name, 'kmod:direct', 'playToClient')], name)
        assert.deepStrictEqual([sentences(r, SAFELY), marked(r).length], [0, 1], name)
      }
      const r = read('k-shared-lookupdefault.jar')
      assert.deepStrictEqual(rows(r), [versionRow('k-shared-lookupdefault.jar', 'kmod:one', null), versionRow('k-shared-lookupdefault.jar', 'kmod:two', null)])
      assert.deepStrictEqual([sentences(r, SAFELY), marked(r).length], [0, 2])
    })
    it('X1t the twin, optional() unconditional BEFORE the switch: proven optional, its sentence kept, no row (the listener\'s own and a shared one)', () => {
      for (const name of ['k-direct-switchbefore.jar', 'k-shared-switchbefore.jar']) {
        const r = read(name)
        noRow(r)
        assert.deepStrictEqual(r.diagnostics.abstains, GOLDEN[name].abstains, name)
        assert.ok(sentences(r, SAFELY) >= 1, name)
      }
    })
    it('X2t the twin, the registrar versioned: the registration is claimed whatever the switch, no row', () => {
      const r = read('k-direct-switchcase-versioned.jar')
      noRow(r)
      assert.deepStrictEqual(r.components.play.map((c) => [c.id, c.version, c.flow, c.optional]), [['kmod:direct', '7', 'clientbound', true]])
    })
    it('X3t a shared registration whose optional() stands in the case arm: the deep walk takes the default arm and reads it as required, its rows are those of before (unmarked)', () => {
      const r = read('k-shared-switchcase.jar')
      assert.deepStrictEqual(rows(r), [versionRow('k-shared-switchcase.jar', 'kmod:one', null), versionRow('k-shared-switchcase.jar', 'kmod:two', null)])
      assert.deepStrictEqual(r.diagnostics.abstains, GOLDEN['k-shared-switchcase.jar'].abstains)
    })
  })

  describe('M4 a deep walk that failed after it proved an id', () => {
    it('T2 the entry\'s deep walk fails before it met any registration: the entry reaches none, as before: its sentence and ONE marked row of kind unseen (the row of an entry that lost its registrar), no second row for the failure', () => {
      const r = read('k-thrown-early.jar')
      assert.deepStrictEqual(r.components.play, [])
      assert.strictEqual(r.diagnostics.errors.filter((e) => /^deep walk of .*onRegister failed/.test(e)).length, 1, JSON.stringify(r.diagnostics.errors))
      assert.deepStrictEqual(r.diagnostics.unresolvedSites.map((s) => [s.kind, s.jar, s.site, s.wordOnly === true]), [['unseen', 'k-thrown-early.jar', `${J.INIT}.onRegister(Lnet/neoforged/neoforge/network/event/RegisterPayloadHandlersEvent;)V@3`, true]])
      assert.strictEqual(sentences(r, /never reaches a registration/), 1)
      assert.strictEqual(r.diagnostics.unresolvedSites[0].says, r.diagnostics.abstains[0])
    })
    it('T1 the entry\'s deep walk fails between two registrations: the first is claimed as before, and ONE marked row of kind unseen names the jar and the entry (what followed was not walked)', () => {
      const r = read('k-thrown.jar')
      assert.deepStrictEqual(r.components.play.map((c) => [c.id, c.version]), [['kmod:one', '7']])
      assert.strictEqual(r.diagnostics.errors.filter((e) => /^deep walk of .*onRegister failed/.test(e)).length, 1, JSON.stringify(r.diagnostics.errors))
      assert.deepStrictEqual(r.diagnostics.unresolvedSites.map((s) => [s.kind, s.jar, s.site, s.wordOnly === true]), [['unseen', 'k-thrown.jar', `${J.INIT}.onRegister`, true]])
      everyRowNamesItsSentence(r)
    })
    it('T1t the twin, the same entry with no fault: both registrations claimed, no row, no sentence', () => {
      const r = read('k-thrown-twin.jar')
      noRow(r)
      assert.deepStrictEqual(r.components.play.map((c) => [c.id, c.version]), [['kmod:one', '7'], ['kmod:two', '7']])
      assert.deepStrictEqual(r.diagnostics.abstains, [])
    })
  })

  describe('M6 the over-report, named', () => {
    it('OVER-REPORT OF THE LINEAR WALK: the listener\'s own registration whose optional() stands under a condition that is decided true (a constant) reads as not proven: one marked row of kind version. The linear walk decides no condition; a lane that teaches it to changes this case knowingly', () => {
      const r = read('k-direct-decided.jar')
      assert.deepStrictEqual(rows(r), [['version', 'k-direct-decided.jar', 'playToClient', 'play', 'clientbound', null, 'kmod:direct']])
      assert.strictEqual(sentences(r, /NOT safely unclaimed/), 1)
    })
  })
})
