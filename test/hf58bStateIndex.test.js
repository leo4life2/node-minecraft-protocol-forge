/* eslint-env mocha */
// HF58b: mojmap-era state counts, the enum-loop / own-helper registrars, the
// sorted-by-name state index and ZIP64 central directories - pinned on
// TRIMMED real jars (the classes the pins need, sha1-recorded) plus the
// 79-row registry fixture of the Forge 26.3 rig (the F5 probe's
// javap-derived counts, cumulative from the wire boundary 35723).
const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const { deriveBlockShapes, decodeStateIndex, _internal } = require('../src/client/blockShapeDerivation')
const { zipCentralEntries, zipDirectoryBounds, parseClassFile, zipEntryData } = require('../src/client/jarAnalysis')
const { buildClass, buildJar } = require('./helpers/synthJar')
const { buildZip64 } = require('./helpers/zip64')

const FIX = path.join(__dirname, 'fixtures')
const GLOW = path.join(FIX, 'hf58b-glow_sticks-forge-26.3-7.5.1.trimmed.jar')
const FOOD = path.join(FIX, 'hf58b-foodtxf-26.3-1.8.8-forge.trimmed.jar')
const INGOT = path.join(FIX, 'hf58b-ingotcraft-26.3-2.4.11-forge.trimmed.jar')
const ROWS = JSON.parse(fs.readFileSync(path.join(FIX, 'hf58b-v263f-blocks.json'), 'utf8'))
const BOUNDARY = 35723 // the vanilla state count of 26.3 = the first modded state id on the rig
const SHA1 = {
  [GLOW]: '569dc1b9c13fb4104a5e22268ebff664bf98a79e',
  [FOOD]: '1a568a7a213c4f93732365db02c93a7eba895919',
  [INGOT]: 'eff1cc71fcc687735db277e61ff1ebf631a05a4f'
}
// the wire ids the F5 probe observed on the live rig (placement probe + registry snapshot)
const WIRE = [
  ['glow_sticks:glow_stick_lime', 49246, { facing: 'north', level: '0', waterlogged: 'false' }],
  ['glow_sticks:creative_glow_stick_cyan', 61342, { face: 'wall', facing: 'south', redstone_control: '0', variant: '2', waterlogged: 'false' }],
  ['glow_sticks:creative_glow_stick_rose', 82368, { face: 'floor', facing: 'west', redstone_control: '0', variant: '5', waterlogged: 'false' }],
  ['glow_sticks:creative_glow_stick_navy', 91694, { face: 'ceiling', facing: 'north', redstone_control: '0', variant: '0', waterlogged: 'false' }],
  ['glow_sticks:glow_stick_teal', 103390, { facing: 'south', level: '0', waterlogged: 'false' }],
  ['foodtxf:black_kitchen_block', 122269, {}],
  ['foodtxf:white_kitchen_block', 122270, {}],
  ['ingotcraft:bronze_block', 122277, {}],
  ['ingotcraft:tin_block', 122280, {}]
]

function sha1 (p) { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex') }

describe('HF58b mojmap era + registrars + state index (trimmed real jars)', function () {
  let derived
  before(function () {
    for (const [p, h] of Object.entries(SHA1)) assert.strictEqual(sha1(p), h, `fixture ${path.basename(p)} sha1`)
    derived = deriveBlockShapes([GLOW, FOOD, INGOT])
  })

  it('P1 the three trimmed jars are read in the mojmap era (member spelling, not a class-name guess)', function () {
    const buf = fs.readFileSync(GLOW)
    const e = zipCentralEntries(buf).find((x) => x.name.endsWith('/GlowStickBlock.class'))
    const parsed = parseClassFile(zipEntryData(buf, e))
    assert.strictEqual(_internal.eraOfClass(parsed), 'mojmap')
    // a class of the srg era (m_/f_ member ids on Mojang-named classes) still reads as srg
    const srg = buildClass({
      name: 'synth/SrgBlock',
      superName: 'net/minecraft/world/level/block/Block',
      methods: [{ name: 'm_7926_', desc: '(Lnet/minecraft/world/level/block/state/StateDefinition$Builder;)V', flags: 0x0004, code: (a) => a.ret() }]
    })
    assert.strictEqual(_internal.eraOfClass(parseClassFile(srg)), 'srg')
    for (const b of derived.blocks.values()) assert.strictEqual(b.era, 'mojmap', `${b.cls} era`)
  })

  it('P2 the enum-loop registrar yields one registration per constant per site, constant-major, names from the concat recipe + the constant accessor', function () {
    const names = [...derived.blocks.keys()].filter((n) => n.startsWith('glow_sticks:'))
    assert.strictEqual(names.length, 66)
    assert.deepStrictEqual(names.slice(0, 6), [
      'glow_sticks:glow_stick_light', 'glow_sticks:glow_stick_light_water',
      'glow_sticks:glow_stick_white', 'glow_sticks:creative_glow_stick_white',
      'glow_sticks:glow_stick_orange', 'glow_sticks:creative_glow_stick_orange'
    ])
    assert.deepStrictEqual(names.slice(-2), ['glow_sticks:glow_stick_tan', 'glow_sticks:creative_glow_stick_tan'])
    // the fixture's 32 colours in the enum <clinit> order
    const colours = ROWS.filter((r) => r.name.startsWith('glow_sticks:glow_stick_') && !r.name.includes('light')).map((r) => r.name)
    assert.deepStrictEqual(names.filter((n) => n.startsWith('glow_sticks:glow_stick_') && !n.includes('light')), colours)
  })

  it('P3 the own static helper (DR.register of its String parameter) yields its call sites: name + the Function handle class', function () {
    const food = [...derived.blocks.keys()].filter((n) => n.startsWith('foodtxf:')).sort()
    assert.deepStrictEqual(food, ['foodtxf:black_kitchen_block', 'foodtxf:rice', 'foodtxf:white_kitchen_block'])
    assert.strictEqual(derived.blocks.get('foodtxf:rice').cls, 'com/jahirtrap/foodtxf/block/RiceCropBlock')
    assert.strictEqual(derived.blocks.get('foodtxf:black_kitchen_block').cls, 'net/minecraft/world/level/block/Block')
    const ingot = [...derived.blocks.keys()].filter((n) => n.startsWith('ingotcraft:'))
    assert.strictEqual(ingot.length, 10)
    assert.strictEqual(derived.stats.registrations, 79)
  })

  it('P4 every state count is EXACT from the class era (never the vanilla parent count): 79/79 against the rig fixture, sum 86558', function () {
    let sum = 0
    for (const r of ROWS) {
      const d = derived.blocks.get(r.name)
      assert.ok(d, `${r.name} registered`)
      assert.strictEqual(d.stateCount, r.count, `${r.name} (${r.class}) count`)
      assert.strictEqual(d.witness, 'bytecode')
      sum += d.stateCount
    }
    assert.strictEqual(sum, 86558)
    assert.strictEqual(BOUNDARY + sum, 122281)
    assert.strictEqual(derived.stats.counted, 79)
    assert.strictEqual(derived.stats.indexed, 79)
  })

  it('P5 cumulative layout in the rig registry order reproduces every observed wire id, and the state index names the properties', function () {
    let cursor = BOUNDARY
    const start = new Map()
    for (const r of ROWS) { start.set(r.name, cursor); cursor += derived.blocks.get(r.name).stateCount }
    for (const [name, id, props] of WIRE) {
      const d = derived.blocks.get(name)
      const s0 = start.get(name)
      assert.ok(id >= s0 && id <= s0 + d.stateCount - 1, `${name} ${id} inside [${s0}, ${s0 + d.stateCount - 1}]`)
      assert.deepStrictEqual(decodeStateIndex(d.stateIndex, id - s0), props, `${name} ${id}`)
    }
  })

  it('P6 the state index is sorted by property NAME with the vanilla value orders; the declaration order is NOT accepted (rose 82368)', function () {
    const rose = derived.blocks.get('glow_sticks:creative_glow_stick_rose')
    assert.deepStrictEqual(rose.stateIndex.props.map((p) => p.name), ['face', 'facing', 'redstone_control', 'variant', 'waterlogged'])
    assert.deepStrictEqual(rose.stateIndex.props.map((p) => p.card), [3, 4, 17, 6, 2])
    assert.deepStrictEqual(rose.stateIndex.props[0].values, ['floor', 'wall', 'ceiling'])
    assert.deepStrictEqual(rose.stateIndex.props[1].values, ['north', 'south', 'west', 'east'])
    assert.deepStrictEqual(rose.stateIndex.props[4].values, ['true', 'false'])
    // the clinit declaration order (FACE, VARIANT, REDSTONE_CONTROL, FACING, WATERLOGGED)
    // lands rose[face=floor,facing=west,variant=5] at 82544 - the wire says 82368
    const roseStart = 81949
    const declaration = { props: [rose.stateIndex.props[0], rose.stateIndex.props[3], rose.stateIndex.props[2], rose.stateIndex.props[1], rose.stateIndex.props[4]] }
    const offset = 82368 - roseStart
    assert.notDeepStrictEqual(decodeStateIndex(declaration, offset), { face: 'floor', facing: 'west', redstone_control: '0', variant: '5', waterlogged: 'false' })
    assert.deepStrictEqual(decodeStateIndex(rose.stateIndex, 82544 - roseStart), { face: 'floor', facing: 'west', redstone_control: '15', variant: '3', waterlogged: 'false' })
    assert.deepStrictEqual(decodeStateIndex(rose.stateIndex, offset), { face: 'floor', facing: 'west', redstone_control: '0', variant: '5', waterlogged: 'false' })
  })

  it('P7 a mod class whose count cannot be resolved is UNKNOWN (never its vanilla parent count as exact)', function () {
    // a mojmap-era block whose createBlockStateDefinition reads a property
    // through a helper call (dynamic): the count abstains even though its
    // parent (Block) has exactly 1 state
    const BLOCK = 'net/minecraft/world/level/block/Block'
    const BUILDER = 'net/minecraft/world/level/block/state/StateDefinition$Builder'
    const cls = buildClass({
      name: 'synth/DynBlock',
      superName: BLOCK,
      methods: [{
        name: 'createBlockStateDefinition',
        desc: `(L${BUILDER};)V`,
        flags: 0x0004,
        // a helper PRODUCES the property: statically unknowable => UNKNOWN
        code: (a) => a.aload(1).invokestatic('synth/DynBlock', 'prop', '()Lnet/minecraft/world/level/block/state/properties/Property;').pop().ret()
      }]
    })
    const jar = buildJar([{ name: 'synth/DynBlock.class', data: cls }])
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hf58b-'))
    const p = path.join(dir, 'dyn.jar')
    fs.writeFileSync(p, jar)
    const universe = _internal.buildUniverse([p])
    assert.strictEqual(_internal.stateCountOf('synth/DynBlock', universe, _internal.VOCABS.mojmap), null)
    // and a plain subclass of a vanilla class with a known contribution stays exact
    assert.strictEqual(_internal.stateCountOf('net/minecraft/world/level/block/CropBlock', universe, _internal.VOCABS.mojmap), 8)
  })

  it('P9 REMEDIATION: a mod body is read by ALLOWLIST - a helper returning Property[] (the verifier\'s weird_arr), a helper that registers on the builder, an instance-field property or an unknown static are UNKNOWN; the varargs idiom stays exact', function () {
    const BLOCK = 'net/minecraft/world/level/block/Block'
    const BUILDER = 'net/minecraft/world/level/block/state/StateDefinition$Builder'
    const PROP = 'net/minecraft/world/level/block/state/properties/'
    const ADD = `([L${PROP}Property;)L${BUILDER};`
    const BSP = PROP + 'BlockStateProperties'
    const V = _internal.VOCABS.mojmap
    // (a) the verifier's javac-built jar (sources in fixtures/hf58b-syn-src): weird_arr = b.add(props()) with static Property<?>[] props()
    const SYN = path.join(FIX, 'hf58b-syn.jar')
    assert.strictEqual(sha1(SYN), '9f6b27bd05f1e6ad2639f337511dbd6146ee2b58', 'fixture hf58b-syn.jar sha1')
    const syn = deriveBlockShapes([SYN])
    const wa = syn.blocks.get('synmod:weird_arr')
    assert.ok(wa, 'weird_arr registered')
    assert.strictEqual(wa.stateCount, null, 'weird_arr: a Property[]-returning helper is UNKNOWN, never the parent count 1')
    assert.strictEqual(syn.blocks.get('synmod:weird_ext').stateCount, null, 'weird_ext stays UNKNOWN')
    const t = syn.blocks.get('synmod:triple')
    assert.strictEqual(t.stateCount, 12, 'triple stays exact (3 properties through Builder.add)')
    assert.deepStrictEqual(t.stateIndex.props.map((x) => x.name), ['alpha', 'mid', 'zed'])
    assert.deepStrictEqual(decodeStateIndex(t.stateIndex, 10), { alpha: '2', mid: 'false', zed: '1' })
    assert.strictEqual([...syn.blocks.keys()].filter((n) => /stick_/.test(n)).length, 6, 'the enum-loop registrations are still 6')
    // (b) hand-assembled bodies against the same vocabulary
    const cbsd = (name, code, extra = []) => buildClass({
      name,
      superName: BLOCK,
      methods: [{ name: 'createBlockStateDefinition', desc: `(L${BUILDER};)V`, flags: 0x0004, code }, ...extra]
    })
    const varargs = (a) => a.aload(1).iconst(2).raw([0xbd]).raw([(a.cp.cls(PROP + 'Property') >> 8) & 0xff, a.cp.cls(PROP + 'Property') & 0xff])
      .dup().iconst(0).getstatic(BSP, 'WATERLOGGED', `L${PROP}BooleanProperty;`).raw([0x53])
      .dup().iconst(1).getstatic(BSP, 'HORIZONTAL_FACING', `L${PROP}EnumProperty;`).raw([0x53])
      .invokevirtual(BUILDER, 'add', ADD).pop().ret()
    const cases = [
      ['synth/ArrHelper', (a) => a.aload(1).invokestatic('synth/ArrHelper', 'props', `()[L${PROP}Property;`).invokevirtual(BUILDER, 'add', ADD).pop().ret(), null],
      ['synth/VoidHelper', (a) => a.aload(0).aload(1).invokevirtual('synth/VoidHelper', 'addProps', `(L${BUILDER};)V`).ret(), null],
      ['synth/FieldProp', (a) => a.aload(1).iconst(1).raw([0xbd]).raw([(a.cp.cls(PROP + 'Property') >> 8) & 0xff, a.cp.cls(PROP + 'Property') & 0xff]).dup().iconst(0).aload(0).getfield('synth/FieldProp', 'age', `L${PROP}IntegerProperty;`).raw([0x53]).invokevirtual(BUILDER, 'add', ADD).pop().ret(), null],
      ['synth/OddStatic', (a) => a.aload(1).iconst(1).raw([0xbd]).raw([(a.cp.cls(PROP + 'Property') >> 8) & 0xff, a.cp.cls(PROP + 'Property') & 0xff]).dup().iconst(0).getstatic('synth/OddStatic', 'COLOR', 'Lsynth/ColorProperty;').raw([0x53]).invokevirtual(BUILDER, 'add', ADD).pop().ret(), null],
      ['synth/Varargs', varargs, 8]
    ]
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hf58b-p9-'))
    for (const [name, code, expect] of cases) {
      const p = path.join(dir, name.replace('/', '-') + '.jar')
      fs.writeFileSync(p, buildJar([{ name: name + '.class', data: cbsd(name, code) }]))
      const universe = _internal.buildUniverse([p])
      assert.strictEqual(_internal.stateCountOf(name, universe, V), expect, `${name} -> ${expect === null ? 'UNKNOWN' : expect}`)
    }
  })

  it('P10 r3: a property definition is read only when the era property class creates it in ONE straight call - a mod-owned helper (String) / (String,int,int) / (String,Class) returning a property, a name built by a call and a predicate lambda are UNKNOWN (never a wrong exact card); the direct creates, the inlined bound, the alias and the SlabBlock chain stay exact', function () {
    // the javac-built jar of the r2 verifier (sources in fixtures/hf58b-syn2-src, no net/ classes inside)
    const SYN2 = path.join(FIX, 'hf58b-syn2.jar')
    assert.strictEqual(sha1(SYN2), '995251d93e8d2144aa5def8fbe25e4843d06a7b7', 'fixture hf58b-syn2.jar sha1')
    const { blocks } = deriveBlockShapes([SYN2])
    const table = {
      helper_str: null, // static IntegerProperty mk(String) -> create(n, 0, 15): real 16, the r2 reading said 2
      helper_ii: null, // static mk2(String, int, int) -> create(n, lo, hi + 1): real 5, the r2 reading said 4
      helper_cls: null, // static mkE(String, Class) -> an EnumProperty subset: real 1, the r2 reading said 3
      subset: 2, // EnumProperty.create(name, Color.class, RED, GREEN)
      pred: null, // EnumProperty.create(name, Color.class, predicate lambda)
      constbound: 6, // IntegerProperty.create(age, 0, Limits.MAX) with the constant inlined
      dynbound: null, // IntegerProperty.create(age, 0, Limits.DYN) read by getstatic
      alias: 2, // WET = BlockStateProperties.WATERLOGGED
      nosuper_slab: 2, // a SlabBlock body without super: LIT only
      withsuper_slab: 12, // super(SlabBlock: TYPE x WATERLOGGED) x LIT
      named_via_call: null, // BooleanProperty.create(nm("zeta")): the real name is a_zeta - the r2 reading indexed it as zeta
      chk: 2 // Chk.nn(b, "b") (the Kotlin checkNotNullParameter idiom) before super + add(LIT): builder-blind, exact
    }
    for (const [n, exp] of Object.entries(table)) {
      const d = blocks.get('synmod2:' + n)
      assert.ok(d, `synmod2:${n} registered`)
      assert.strictEqual(d.stateCount, exp, `${n} -> ${exp === null ? 'UNKNOWN' : exp}`)
    }
    assert.deepStrictEqual(blocks.get('synmod2:withsuper_slab').stateIndex.props.map((x) => `${x.name}:${x.card}`), ['lit:2', 'type:3', 'waterlogged:2'])
    assert.deepStrictEqual(blocks.get('synmod2:chk').stateIndex.props.map((x) => `${x.name}:${x.card}`), ['lit:2'])
  })

  it('P11 r3: a void call the builder cannot reach is allowed in a mod body; a void (Object,String) helper whose body casts to the builder and adds, one that forwards the Object, one outside the universe, and a void call on the builder itself stay UNKNOWN', function () {
    const BLOCK = 'net/minecraft/world/level/block/Block'
    const BUILDER = 'net/minecraft/world/level/block/state/StateDefinition$Builder'
    const PROP = 'net/minecraft/world/level/block/state/properties/'
    const ADD = `([L${PROP}Property;)L${BUILDER};`
    const BSP = PROP + 'BlockStateProperties'
    const OS = '(Ljava/lang/Object;Ljava/lang/String;)V'
    const V = _internal.VOCABS.mojmap
    const addOne = (a) => a.aload(1).iconst(1).raw([0xbd]).raw([(a.cp.cls(PROP + 'Property') >> 8) & 0xff, a.cp.cls(PROP + 'Property') & 0xff])
      .dup().iconst(0).getstatic(BSP, 'WATERLOGGED', `L${PROP}BooleanProperty;`).raw([0x53])
      .invokevirtual(BUILDER, 'add', ADD).pop()
    const cbsd = (name, code) => buildClass({ name, superName: BLOCK, methods: [{ name: 'createBlockStateDefinition', desc: `(L${BUILDER};)V`, flags: 0x0004, code }] })
    const helper = (name, desc, code) => buildClass({ name, superName: 'java/lang/Object', methods: [{ name: 'nn', desc, flags: 0x0009, code }] })
    const callThenAdd = (owner, desc) => (a) => { a.aload(1).ldcStr('b').invokestatic(owner, 'nn', desc); addOne(a).ret() }
    const cases = [
      // the Kotlin idiom: null check, throws a NullPointerException(String) - builder-blind
      ['synth/Blind', helper('synth/BlindH', OS, (a) => a.raw([0xbb]).raw([(a.cp.cls('java/lang/NullPointerException') >> 8) & 0xff, a.cp.cls('java/lang/NullPointerException') & 0xff]).dup().aload(1).invokespecial('java/lang/NullPointerException', '<init>', '(Ljava/lang/String;)V').athrow()), callThenAdd('synth/BlindH', OS), 2],
      // a String-only void call: no parameter can carry the builder
      ['synth/Log', null, (a) => { a.ldcStr('x').invokestatic('synth/LogH', 'nn', '(Ljava/lang/String;)V'); addOne(a).ret() }, 2],
      // the same shape, but the body casts the Object to the builder and adds a property
      ['synth/Sneak', helper('synth/SneakH', OS, (a) => a.aload(0).checkcast(BUILDER).iconst(1).raw([0xbd]).raw([(a.cp.cls(PROP + 'Property') >> 8) & 0xff, a.cp.cls(PROP + 'Property') & 0xff]).dup().iconst(0).getstatic(BSP, 'HORIZONTAL_FACING', `L${PROP}EnumProperty;`).raw([0x53]).invokevirtual(BUILDER, 'add', ADD).pop().ret()), callThenAdd('synth/SneakH', OS), null],
      // the Object is forwarded to another call
      ['synth/Fwd', helper('synth/FwdH', OS, (a) => a.aload(0).aload(1).invokestatic('synth/FwdH', 'deep', OS).ret()), callThenAdd('synth/FwdH', OS), null],
      // the callee is not in the universe: its body cannot be read
      ['synth/Missing', null, callThenAdd('ext/MissingH', OS), null],
      // a void call on the builder itself
      ['synth/OnBuilder', null, (a) => { a.aload(1).invokevirtual(BUILDER, 'reset', '()V'); addOne(a).ret() }, null]
    ]
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hf58b-p11-'))
    for (const [name, helperClass, code, expect] of cases) {
      const p = path.join(dir, name.replace('/', '-') + '.jar')
      const entries = [{ name: name + '.class', data: cbsd(name, code) }]
      if (helperClass) entries.push({ name: name + 'H.class', data: helperClass })
      fs.writeFileSync(p, buildJar(entries))
      const universe = _internal.buildUniverse([p])
      assert.strictEqual(_internal.stateCountOf(name, universe, V), expect, `${name} -> ${expect === null ? 'UNKNOWN' : expect}`)
    }
  })

  it('P8 a ZIP64 central directory (65,939 entries; saturated 16/32-bit EOCD fields) is read with its true count', function () {
    const N = 65939
    const entries = []
    for (let i = 0; i < N; i++) entries.push({ name: `a/${i}.json`, data: '{}' })
    const buf = buildZip64(entries)
    const eocd = buf.length - 22
    assert.strictEqual(buf.readUInt32LE(eocd), 0x06054b50)
    assert.strictEqual(buf.readUInt16LE(eocd + 10), 0xFFFF)
    assert.deepStrictEqual(zipDirectoryBounds(buf, eocd).count, N)
    const list = zipCentralEntries(buf)
    assert.strictEqual(list.length, N)
    assert.strictEqual(list[N - 1].name, `a/${N - 1}.json`)
    assert.strictEqual(zipEntryData(buf, list[N - 1]).toString(), '{}')
    // a classic archive is unchanged
    const small = buildJar([{ name: 'x.txt', data: Buffer.from('x') }])
    assert.strictEqual(zipCentralEntries(small).length, 1)
  })
})
