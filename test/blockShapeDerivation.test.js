/* eslint-env mocha */
// blockShapeDerivation: static jar analysis -> {registryName -> shape/count}.
// Deterministic synthetic jars exercise both eras' registration idioms and
// every abstention guard; classifications were rig-proven against a real
// Forge 1.20.1 + Farmer's Delight server (132/132 blocks, 0 false-nonsolid,
// 0 false-solid — see the modded-block-shapes lane).
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { buildClass, buildJar } = require('./helpers/synthJar')
const { deriveBlockShapes } = require('../src/client/blockShapeDerivation')

const DR = 'net/minecraftforge/registries/DeferredRegister'
const RO = 'net/minecraftforge/registries/RegistryObject'
const PROPS = 'net/minecraft/world/level/block/state/BlockBehaviour$Properties'
const BLOCKS = 'net/minecraft/world/level/block/Blocks'
const FLOWER = 'net/minecraft/world/level/block/FlowerBlock'
const CROP = 'net/minecraft/world/level/block/CropBlock'
const BLOCK = 'net/minecraft/world/level/block/Block'
const BUILDER = 'net/minecraft/world/level/block/state/StateDefinition$Builder'

function writeJar (name, buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shape-derive-'))
  const p = path.join(dir, name)
  fs.writeFileSync(p, buf)
  return p
}

describe('blockShapeDerivation (Forge/srg era)', function () {
  function forgeJar () {
    const owner = 'synth/reg/ModBlocks'
    const propsDesc = `L${PROPS};`
    const supplier = '()Ljava/util/function/Supplier;'
    const modBlocks = buildClass({
      name: owner,
      bootstrapMethods: [
        { refKind: 6, owner, name: 'lambda$static$0', desc: `()L${BLOCK};` },
        { refKind: 6, owner, name: 'lambda$static$1', desc: `()L${BLOCK};` },
        { refKind: 6, owner, name: 'lambda$static$2', desc: `()L${BLOCK};` },
        { refKind: 6, owner, name: 'lambda$static$3', desc: `()L${BLOCK};` }
      ],
      methods: [
        {
          name: '<clinit>',
          desc: '()V',
          flags: 0x0008,
          code: (a) => a
            // BLOCKS = DeferredRegister.create(..., "synthmod")
            .ldcStr('synthmod')
            .invokestatic(DR, 'create', `(Ljava/lang/String;)L${DR};`)
            .putstatic(owner, 'BLOCKS', `L${DR};`)
            // register("wild_plant", lambda0) — noCollission plant
            .getstatic(owner, 'BLOCKS', `L${DR};`)
            .ldcStr('wild_plant')
            .invokedynamic(0, 'get', supplier)
            .invokevirtual(DR, 'register', `(Ljava/lang/String;Ljava/util/function/Supplier;)L${RO};`)
            .pop()
            // register("copy_plant", lambda1) — copy(TALL_GRASS) plant
            .getstatic(owner, 'BLOCKS', `L${DR};`)
            .ldcStr('copy_plant')
            .invokedynamic(1, 'get', supplier)
            .invokevirtual(DR, 'register', `(Ljava/lang/String;Ljava/util/function/Supplier;)L${RO};`)
            .pop()
            // register("aged_crop", lambda2) — CropBlock subclass, no props signal
            .getstatic(owner, 'BLOCKS', `L${DR};`)
            .ldcStr('aged_crop')
            .invokedynamic(2, 'get', supplier)
            .invokevirtual(DR, 'register', `(Ljava/lang/String;Ljava/util/function/Supplier;)L${RO};`)
            .pop()
            // register("plain_solid", lambda3) — of() full cube
            .getstatic(owner, 'BLOCKS', `L${DR};`)
            .ldcStr('plain_solid')
            .invokedynamic(3, 'get', supplier)
            .invokevirtual(DR, 'register', `(Ljava/lang/String;Ljava/util/function/Supplier;)L${RO};`)
            .pop()
            .ret()
        },
        {
          name: 'lambda$static$0',
          desc: `()L${BLOCK};`,
          flags: 0x000a,
          code: (a) => a
            .new_('synth/blocks/WildPlantBlock').dup()
            .invokestatic(PROPS, 'm_284310_', `()${propsDesc}`)
            .invokevirtual(PROPS, 'm_60910_', `()${propsDesc}`)
            .invokespecial('synth/blocks/WildPlantBlock', '<init>', `(${propsDesc})V`)
            .areturn()
        },
        {
          name: 'lambda$static$1',
          desc: `()L${BLOCK};`,
          flags: 0x000a,
          code: (a) => a
            .new_('synth/blocks/CopyPlantBlock').dup()
            .getstatic(BLOCKS, 'f_50359_', `L${BLOCK};`) // tall_grass
            .invokestatic(PROPS, 'm_60926_', `(Lnet/minecraft/world/level/block/state/BlockBehaviour;)${propsDesc}`)
            .invokespecial('synth/blocks/CopyPlantBlock', '<init>', `(${propsDesc})V`)
            .areturn()
        },
        {
          name: 'lambda$static$2',
          desc: `()L${BLOCK};`,
          flags: 0x000a,
          code: (a) => a
            .new_('synth/blocks/AgedCropBlock').dup()
            .invokespecial('synth/blocks/AgedCropBlock', '<init>', '()V')
            .areturn()
        },
        {
          name: 'lambda$static$3',
          desc: `()L${BLOCK};`,
          flags: 0x000a,
          code: (a) => a
            .new_('synth/blocks/PlainSolidBlock').dup()
            .invokestatic(PROPS, 'm_284310_', `()${propsDesc}`)
            .invokespecial('synth/blocks/PlainSolidBlock', '<init>', `(${propsDesc})V`)
            .areturn()
        }
      ]
    })
    const wild = buildClass({
      name: 'synth/blocks/WildPlantBlock',
      superName: FLOWER,
      methods: [{ name: '<init>', desc: `(L${PROPS};)V`, flags: 0x0001, code: (a) => a.ret() }]
    })
    const copy = buildClass({
      name: 'synth/blocks/CopyPlantBlock',
      superName: FLOWER,
      methods: [{ name: '<init>', desc: `(L${PROPS};)V`, flags: 0x0001, code: (a) => a.ret() }]
    })
    const aged = buildClass({
      name: 'synth/blocks/AgedCropBlock',
      superName: CROP,
      methods: [{ name: '<init>', desc: '()V', flags: 0x0001, code: (a) => a.ret() }]
    })
    const solid = buildClass({
      name: 'synth/blocks/PlainSolidBlock',
      superName: BLOCK,
      methods: [{ name: '<init>', desc: `(L${PROPS};)V`, flags: 0x0001, code: (a) => a.ret() }]
    })
    return buildJar([
      { name: 'synth/reg/ModBlocks.class', data: modBlocks },
      { name: 'synth/blocks/WildPlantBlock.class', data: wild },
      { name: 'synth/blocks/CopyPlantBlock.class', data: copy },
      { name: 'synth/blocks/AgedCropBlock.class', data: aged },
      { name: 'synth/blocks/PlainSolidBlock.class', data: solid }
    ])
  }

  it('derives shape + state count from DeferredRegister lambda registrations', function () {
    const jar = writeJar('synthmod.jar', forgeJar())
    const { blocks } = deriveBlockShapes([jar])
    assert.strictEqual(blocks.size, 4)

    const wild = blocks.get('synthmod:wild_plant')
    assert.strictEqual(wild.shape, 'nonsolid', 'noCollission proves nonsolid')
    assert.strictEqual(wild.stateCount, 1, 'FlowerBlock chain adds no properties')

    const copy = blocks.get('synthmod:copy_plant')
    assert.strictEqual(copy.shape, 'nonsolid', 'copy(tall_grass) proves nonsolid')

    const aged = blocks.get('synthmod:aged_crop')
    assert.strictEqual(aged.shape, 'abstain', 'no properties signal => abstain')
    assert.strictEqual(aged.stateCount, 8, 'CropBlock chain contributes AGE (8) from the vanilla table')

    const solid = blocks.get('synthmod:plain_solid')
    assert.strictEqual(solid.shape, 'solid', 'of() without noCollission => solid')
    assert.strictEqual(solid.stateCount, 1)
  })

  it('abstains from nonsolid when the chain overrides getCollisionShape', function () {
    const owner = 'synth/reg/GuardBlocks'
    const propsDesc = `L${PROPS};`
    const gcsDesc = '(Lnet/minecraft/world/level/block/state/BlockState;Lnet/minecraft/world/level/BlockGetter;' +
      'Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/phys/shapes/CollisionContext;)Lnet/minecraft/world/phys/shapes/VoxelShape;'
    const reg = buildClass({
      name: owner,
      bootstrapMethods: [{ refKind: 6, owner, name: 'lambda$static$0', desc: `()L${BLOCK};` }],
      methods: [
        {
          name: '<clinit>',
          desc: '()V',
          flags: 0x0008,
          code: (a) => a
            .ldcStr('guardmod')
            .invokestatic(DR, 'create', `(Ljava/lang/String;)L${DR};`)
            .putstatic(owner, 'BLOCKS', `L${DR};`)
            .getstatic(owner, 'BLOCKS', `L${DR};`)
            .ldcStr('shifty_plant')
            .invokedynamic(0, 'get', '()Ljava/util/function/Supplier;')
            .invokevirtual(DR, 'register', `(Ljava/lang/String;Ljava/util/function/Supplier;)L${RO};`)
            .pop().ret()
        },
        {
          name: 'lambda$static$0',
          desc: `()L${BLOCK};`,
          flags: 0x000a,
          code: (a) => a
            .new_('synth/blocks/ShiftyPlantBlock').dup()
            .invokestatic(PROPS, 'm_284310_', `()${propsDesc}`)
            .invokevirtual(PROPS, 'm_60910_', `()${propsDesc}`)
            .invokespecial('synth/blocks/ShiftyPlantBlock', '<init>', `(${propsDesc})V`)
            .areturn()
        }
      ]
    })
    const shifty = buildClass({
      name: 'synth/blocks/ShiftyPlantBlock',
      superName: FLOWER,
      methods: [
        { name: '<init>', desc: `(L${PROPS};)V`, flags: 0x0001, code: (a) => a.ret() },
        // overrides getCollisionShape (m_5939_): collision statically unknowable
        { name: 'm_5939_', desc: gcsDesc, flags: 0x0004, code: (a) => a.areturn() }
      ]
    })
    const jar = writeJar('guardmod.jar', buildJar([
      { name: 'synth/reg/GuardBlocks.class', data: reg },
      { name: 'synth/blocks/ShiftyPlantBlock.class', data: shifty }
    ]))
    const { blocks } = deriveBlockShapes([jar])
    const b = blocks.get('guardmod:shifty_plant')
    assert.strictEqual(b.shape, 'abstain', 'noCollission + getCollisionShape override => abstain, never nonsolid')
  })

  it('abstains from counting when a state definition branches (dynamic)', function () {
    const owner = 'synth/reg/DynBlocks'
    const propsDesc = `L${PROPS};`
    const reg = buildClass({
      name: owner,
      bootstrapMethods: [{ refKind: 6, owner, name: 'lambda$static$0', desc: `()L${BLOCK};` }],
      methods: [
        {
          name: '<clinit>',
          desc: '()V',
          flags: 0x0008,
          code: (a) => a
            .ldcStr('dynmod')
            .invokestatic(DR, 'create', `(Ljava/lang/String;)L${DR};`)
            .putstatic(owner, 'BLOCKS', `L${DR};`)
            .getstatic(owner, 'BLOCKS', `L${DR};`)
            .ldcStr('twisty')
            .invokedynamic(0, 'get', '()Ljava/util/function/Supplier;')
            .invokevirtual(DR, 'register', `(Ljava/lang/String;Ljava/util/function/Supplier;)L${RO};`)
            .pop().ret()
        },
        {
          name: 'lambda$static$0',
          desc: `()L${BLOCK};`,
          flags: 0x000a,
          code: (a) => a
            .new_('synth/blocks/TwistyBlock').dup()
            .invokestatic(PROPS, 'm_284310_', `()${propsDesc}`)
            .invokespecial('synth/blocks/TwistyBlock', '<init>', `(${propsDesc})V`)
            .areturn()
        }
      ]
    })
    const twisty = buildClass({
      name: 'synth/blocks/TwistyBlock',
      superName: BLOCK,
      methods: [
        { name: '<init>', desc: `(L${PROPS};)V`, flags: 0x0001, code: (a) => a.ret() },
        // createBlockStateDefinition with a branch: not statically countable
        { name: 'm_7926_', desc: `(L${BUILDER};)V`, flags: 0x0004, code: (a) => a.goto_(3).ret() }
      ]
    })
    const jar = writeJar('dynmod.jar', buildJar([
      { name: 'synth/reg/DynBlocks.class', data: reg },
      { name: 'synth/blocks/TwistyBlock.class', data: twisty }
    ]))
    const { blocks } = deriveBlockShapes([jar])
    const b = blocks.get('dynmod:twisty')
    assert.strictEqual(b.stateCount, null, 'branching state definition => count abstains')
    assert.strictEqual(b.shape, 'solid', 'of() props still classify solidity')
  })
})

describe('blockShapeDerivation (Fabric/intermediary era)', function () {
  const REGISTRY = 'net/minecraft/class_2378'
  const RL = 'net/minecraft/class_2960'
  const FPROPS = 'net/minecraft/class_4970$class_2251'
  const FBLOCK = 'net/minecraft/class_2248'
  const FBUSH = 'net/minecraft/class_2261' // BushBlock
  const regDesc = `(L${REGISTRY};L${RL};Ljava/lang/Object;)Ljava/lang/Object;`

  it('derives from direct Registry.register and helper-pattern registrations', function () {
    const helperOwner = 'fsynth/RegHelper'
    const helper = buildClass({
      name: helperOwner,
      methods: [{
        name: 'registerBlock',
        desc: `(Ljava/lang/String;L${FBLOCK};)L${FBLOCK};`,
        flags: 0x0009,
        code: (a) => a
          .getstatic('net/minecraft/class_7923', 'field_41175', 'Lnet/minecraft/class_7922;')
          .ldcStr('fabmod')
          .aload(0)
          .invokestatic(RL, 'method_60655', `(Ljava/lang/String;Ljava/lang/String;)L${RL};`)
          .aload(1)
          .invokestatic(REGISTRY, 'method_10230', regDesc)
          .areturn()
      }]
    })
    const caller = buildClass({
      name: 'fsynth/FabBlocks',
      methods: [{
        name: '<clinit>',
        desc: '()V',
        flags: 0x0008,
        code: (a) => a
          // helper call: registerBlock("weed", new FabPlantBlock(settings.noCollission))
          .ldcStr('weed')
          .new_('fsynth/FabPlantBlock').dup()
          .invokestatic(FPROPS, 'method_9637', `()L${FPROPS};`)
          .invokevirtual(FPROPS, 'method_9634', `()L${FPROPS};`) // noCollission
          .invokespecial('fsynth/FabPlantBlock', '<init>', `(L${FPROPS};)V`)
          .invokestatic(helperOwner, 'registerBlock', `(Ljava/lang/String;L${FBLOCK};)L${FBLOCK};`)
          .pop()
          // direct: Registry.register(reg, new RL("fabmod","slab"), new FabSolidBlock(of()))
          .new_(RL).dup().ldcStr('fabmod').ldcStr('slab')
          .invokespecial(RL, '<init>', '(Ljava/lang/String;Ljava/lang/String;)V')
          .new_('fsynth/FabSolidBlock').dup()
          .invokestatic(FPROPS, 'method_9637', `()L${FPROPS};`)
          .invokespecial('fsynth/FabSolidBlock', '<init>', `(L${FPROPS};)V`)
          .invokestatic(REGISTRY, 'method_10230', regDesc)
          .pop()
          .ret()
      }]
    })
    const plant = buildClass({
      name: 'fsynth/FabPlantBlock',
      superName: FBUSH,
      methods: [{ name: '<init>', desc: `(L${FPROPS};)V`, flags: 0x0001, code: (a) => a.ret() }]
    })
    const solid = buildClass({
      name: 'fsynth/FabSolidBlock',
      superName: FBLOCK,
      methods: [{ name: '<init>', desc: `(L${FPROPS};)V`, flags: 0x0001, code: (a) => a.ret() }]
    })
    const jar = writeJar('fabmod.jar', buildJar([
      { name: 'fsynth/RegHelper.class', data: helper },
      { name: 'fsynth/FabBlocks.class', data: caller },
      { name: 'fsynth/FabPlantBlock.class', data: plant },
      { name: 'fsynth/FabSolidBlock.class', data: solid }
    ]))
    const { blocks } = deriveBlockShapes([jar])
    const weed = blocks.get('fabmod:weed')
    assert.ok(weed, 'helper-pattern registration is found')
    assert.strictEqual(weed.shape, 'nonsolid', 'noCollission in the call window proves nonsolid')
    assert.strictEqual(weed.stateCount, 1)
    const slab = blocks.get('fabmod:slab')
    assert.ok(slab, 'direct registration is found')
    assert.strictEqual(slab.shape, 'solid')
  })
})

describe('blockShapeDerivation (invoked-ctor overload isolation)', function () {
  // verifier MEDIUM-1: a nonsolid CONVENIENCE ctor must never poison a
  // registration that invokes the plain Properties ctor — only the
  // actually-invoked this()/super() chain contributes signals.
  function trickJar (useConvenienceCtor) {
    const owner = 'synth/reg/TrickBlocks'
    const propsDesc = `L${PROPS};`
    const trick = 'synth/blocks/TrickBlock'
    const supplierCode = useConvenienceCtor
      ? (a) => a
          .new_(trick).dup()
          .invokespecial(trick, '<init>', '()V')
          .areturn()
      : (a) => a
          .new_(trick).dup()
          .invokestatic(PROPS, 'm_284310_', `()${propsDesc}`)
          .invokespecial(trick, '<init>', `(${propsDesc})V`)
          .areturn()
    const reg = buildClass({
      name: owner,
      bootstrapMethods: [{ refKind: 6, owner, name: 'lambda$static$0', desc: `()L${BLOCK};` }],
      methods: [
        {
          name: '<clinit>',
          desc: '()V',
          flags: 0x0008,
          code: (a) => a
            .ldcStr('trickmod')
            .invokestatic(DR, 'create', `(Ljava/lang/String;)L${DR};`)
            .putstatic(owner, 'BLOCKS', `L${DR};`)
            .getstatic(owner, 'BLOCKS', `L${DR};`)
            .ldcStr('trick_block')
            .invokedynamic(0, 'get', '()Ljava/util/function/Supplier;')
            .invokevirtual(DR, 'register', `(Ljava/lang/String;Ljava/util/function/Supplier;)L${RO};`)
            .pop().ret()
        },
        { name: 'lambda$static$0', desc: `()L${BLOCK};`, flags: 0x000a, code: supplierCode }
      ]
    })
    const trickCls = buildClass({
      name: trick,
      superName: BLOCK,
      methods: [
        // convenience ctor: this(Properties.of().noCollission())
        {
          name: '<init>',
          desc: '()V',
          flags: 0x0001,
          code: (a) => a
            .aload(0)
            .invokestatic(PROPS, 'm_284310_', `()L${PROPS};`)
            .invokevirtual(PROPS, 'm_60910_', `()L${PROPS};`)
            .invokespecial(trick, '<init>', `(L${PROPS};)V`)
            .ret()
        },
        // plain ctor: super(props)
        {
          name: '<init>',
          desc: `(L${PROPS};)V`,
          flags: 0x0001,
          code: (a) => a
            .aload(0).aload(1)
            .invokespecial(BLOCK, '<init>', `(L${PROPS};)V`)
            .ret()
        }
      ]
    })
    return writeJar('trickmod.jar', buildJar([
      { name: `${owner}.class`, data: reg },
      { name: `${trick}.class`, data: trickCls }
    ]))
  }

  it('plain-ctor registration is NOT poisoned by a sibling nonsolid ctor', function () {
    const { blocks } = deriveBlockShapes([trickJar(false)])
    const b = blocks.get('trickmod:trick_block')
    assert.ok(b, 'registration found')
    assert.strictEqual(b.shape, 'solid', 'of() through the PLAIN ctor => solid, never nonsolid')
  })

  it('convenience-ctor registration follows the this() delegation to nonsolid', function () {
    const { blocks } = deriveBlockShapes([trickJar(true)])
    const b = blocks.get('trickmod:trick_block')
    assert.strictEqual(b.shape, 'nonsolid', 'noCollission inside the INVOKED ctor chain => nonsolid')
  })
})

describe('blockShapeDerivation (Registrate framework)', function () {
  const RG_ABS = 'com/tterrag/registrate/AbstractRegistrate'
  const RG_BB = 'com/tterrag/registrate/builders/BlockBuilder'
  const RG_ENTRY = 'com/tterrag/registrate/util/entry/BlockEntry'
  const NNF = 'com/tterrag/registrate/util/nonnull/NonNullFunction'
  const NNU = 'com/tterrag/registrate/util/nonnull/NonNullUnaryOperator'
  const NNS = 'com/tterrag/registrate/util/nonnull/NonNullSupplier'
  const MY_RG = 'rsynth/MyRegistrate'
  const propsDesc = `L${PROPS};`

  // REGISTRATE = new MyRegistrate("rsmod");
  // FLOAT_WEED = REGISTRATE.block("float_weed", FloatWeedBlock::new)
  //   .properties(p -> p.noCollission()).register();
  // GILDED_SHRUB = REGISTRATE.block("gilded_shrub", ShrubBlock::new)
  //   .initialProperties(() -> Blocks.TALL_GRASS)[.transform(op)].register();
  function registrateJar (withTransform) {
    const owner = 'rsynth/RegBlocks'
    const myReg = buildClass({
      name: MY_RG,
      superName: RG_ABS,
      methods: [
        { name: '<init>', desc: '(Ljava/lang/String;)V', flags: 0x0001, code: (a) => a.ret() },
        { name: 'block', desc: `(Ljava/lang/String;L${NNF};)L${RG_BB};`, flags: 0x0001, code: (a) => a.areturn() }
      ]
    })
    const reg = buildClass({
      name: owner,
      bootstrapMethods: [
        { refKind: 6, owner, name: 'lambda$static$0', desc: `(L${PROPS};)L${BLOCK};` }, // FloatWeedBlock factory
        { refKind: 6, owner, name: 'lambda$static$1', desc: `(L${PROPS};)L${PROPS};` }, // properties op
        { refKind: 6, owner, name: 'lambda$static$2', desc: `(L${PROPS};)L${BLOCK};` }, // ShrubBlock factory
        { refKind: 6, owner, name: 'lambda$static$3', desc: `()L${BLOCK};` } // initialProperties supplier
      ],
      methods: [
        {
          name: '<clinit>',
          desc: '()V',
          flags: 0x0008,
          code: (a) => {
            a
              .new_(MY_RG).dup()
              .ldcStr('rsmod')
              .invokespecial(MY_RG, '<init>', '(Ljava/lang/String;)V')
              .putstatic(owner, 'REGISTRATE', `L${MY_RG};`)
              // float_weed: nonsolid via builder properties op
              .getstatic(owner, 'REGISTRATE', `L${MY_RG};`)
              .ldcStr('float_weed')
              .invokedynamic(0, 'apply', `()L${NNF};`)
              .invokevirtual(MY_RG, 'block', `(Ljava/lang/String;L${NNF};)L${RG_BB};`)
              .invokedynamic(1, 'apply', `()L${NNU};`)
              .invokevirtual(RG_BB, 'properties', `(L${NNU};)L${RG_BB};`)
              .invokevirtual(RG_BB, 'register', `()L${RG_ENTRY};`)
              .putstatic(owner, 'FLOAT_WEED', `L${RG_ENTRY};`)
              // gilded_shrub: initialProperties(copy of TALL_GRASS)
              .getstatic(owner, 'REGISTRATE', `L${MY_RG};`)
              .ldcStr('gilded_shrub')
              .invokedynamic(2, 'apply', `()L${NNF};`)
              .invokevirtual(MY_RG, 'block', `(Ljava/lang/String;L${NNF};)L${RG_BB};`)
              .invokedynamic(3, 'get', `()L${NNS};`)
              .invokevirtual(RG_BB, 'initialProperties', `(L${NNS};)L${RG_BB};`)
            if (withTransform) {
              a.invokedynamic(1, 'apply', `()L${NNU};`)
                .invokevirtual(RG_BB, 'transform', `(L${NNU};)L${RG_BB};`)
            }
            a.invokevirtual(RG_BB, 'register', `()L${RG_ENTRY};`)
              .putstatic(owner, 'GILDED_SHRUB', `L${RG_ENTRY};`)
              .ret()
          }
        },
        {
          name: 'lambda$static$0',
          desc: `(L${PROPS};)L${BLOCK};`,
          flags: 0x000a,
          code: (a) => a
            .new_('rsynth/FloatWeedBlock').dup().aload(0)
            .invokespecial('rsynth/FloatWeedBlock', '<init>', `(${propsDesc})V`)
            .areturn()
        },
        {
          name: 'lambda$static$1',
          desc: `(L${PROPS};)L${PROPS};`,
          flags: 0x000a,
          code: (a) => a
            .aload(0)
            .invokevirtual(PROPS, 'm_60910_', `()${propsDesc}`)
            .areturn()
        },
        {
          name: 'lambda$static$2',
          desc: `(L${PROPS};)L${BLOCK};`,
          flags: 0x000a,
          code: (a) => a
            .new_('rsynth/ShrubBlock').dup().aload(0)
            .invokespecial('rsynth/ShrubBlock', '<init>', `(${propsDesc})V`)
            .areturn()
        },
        {
          name: 'lambda$static$3',
          desc: `()L${BLOCK};`,
          flags: 0x000a,
          code: (a) => a
            .getstatic(BLOCKS, 'f_50359_', `L${BLOCK};`) // tall_grass (no collision)
            .areturn()
        }
      ]
    })
    const weed = buildClass({
      name: 'rsynth/FloatWeedBlock',
      superName: FLOWER,
      methods: [{ name: '<init>', desc: `(L${PROPS};)V`, flags: 0x0001, code: (a) => a.ret() }]
    })
    const shrub = buildClass({
      name: 'rsynth/ShrubBlock',
      superName: FLOWER,
      methods: [{ name: '<init>', desc: `(L${PROPS};)V`, flags: 0x0001, code: (a) => a.ret() }]
    })
    return writeJar('rsynth.jar', buildJar([
      { name: `${MY_RG}.class`, data: myReg },
      { name: 'rsynth/RegBlocks.class', data: reg },
      { name: 'rsynth/FloatWeedBlock.class', data: weed },
      { name: 'rsynth/ShrubBlock.class', data: shrub }
    ]))
  }

  it('derives builder-chain registrations (modid from the registrate creation)', function () {
    const { blocks } = deriveBlockShapes([registrateJar(false)])
    const weed = blocks.get('rsmod:float_weed')
    assert.ok(weed, 'REGISTRATE.block("float_weed", ...) found')
    assert.strictEqual(weed.shape, 'nonsolid', 'noCollission inside a .properties(...) op proves nonsolid')
    assert.strictEqual(weed.stateCount, 1)
    const shrub = blocks.get('rsmod:gilded_shrub')
    assert.ok(shrub, 'initialProperties chain found')
    assert.strictEqual(shrub.shape, 'nonsolid', 'initialProperties(() -> TALL_GRASS) proves nonsolid (no transform)')
  })

  it('an opaque .transform(...) kills base-copy nonsolid evidence (abstain)', function () {
    const { blocks } = deriveBlockShapes([registrateJar(true)])
    const shrub = blocks.get('rsmod:gilded_shrub')
    assert.ok(shrub)
    assert.strictEqual(shrub.shape, 'abstain',
      'a transform can replace initialProperties wholesale - copy evidence must not survive it')
    const weed = blocks.get('rsmod:float_weed')
    assert.strictEqual(weed.shape, 'nonsolid', 'noCollission (irreversible in the Properties API) survives')
  })
})

describe('blockShapeDerivation (const-namespace consumer-helper idiom)', function () {
  const RL = 'net/minecraft/resources/ResourceLocation'
  const propsDesc = `L${PROPS};`

  it('derives registrations routed through a BiConsumer sink helper', function () {
    const helperOwner = 'bsynth/reg/RegHelper'
    const helper = buildClass({
      name: helperOwner,
      methods: [{
        name: 'registerBlock',
        desc: `(Ljava/util/function/BiConsumer;L${BLOCK};Ljava/lang/String;)V`,
        flags: 0x0009,
        code: (a) => a
          .new_(RL).dup()
          .ldcStr('bopmod')
          .aload(2)
          .invokespecial(RL, '<init>', '(Ljava/lang/String;Ljava/lang/String;)V')
          .aload(0)
          .aload(1)
          .invokestatic('bsynth/reg/Sink', 'accept', '(Ljava/lang/Object;Ljava/lang/Object;)V')
          .ret()
      }]
    })
    const caller = buildClass({
      name: 'bsynth/reg/BopBlocks',
      methods: [{
        name: '<clinit>',
        desc: '()V',
        flags: 0x0008,
        code: (a) => a
          .getstatic('bsynth/reg/BopBlocks', 'SINK', 'Ljava/util/function/BiConsumer;')
          .new_('bsynth/GlowBloomBlock').dup()
          .invokestatic(PROPS, 'm_284310_', `()${propsDesc}`)
          .invokevirtual(PROPS, 'm_60910_', `()${propsDesc}`)
          .invokespecial('bsynth/GlowBloomBlock', '<init>', `(${propsDesc})V`)
          .ldcStr('glow_bloom')
          .invokestatic(helperOwner, 'registerBlock', `(Ljava/util/function/BiConsumer;L${BLOCK};Ljava/lang/String;)V`)
          .getstatic('bsynth/reg/BopBlocks', 'SINK', 'Ljava/util/function/BiConsumer;')
          .new_('bsynth/HardBloomBlock').dup()
          .invokestatic(PROPS, 'm_284310_', `()${propsDesc}`)
          .invokespecial('bsynth/HardBloomBlock', '<init>', `(${propsDesc})V`)
          .ldcStr('hard_bloom')
          .invokestatic(helperOwner, 'registerBlock', `(Ljava/util/function/BiConsumer;L${BLOCK};Ljava/lang/String;)V`)
          .ret()
      }]
    })
    const bloom = buildClass({
      name: 'bsynth/GlowBloomBlock',
      superName: FLOWER,
      methods: [{ name: '<init>', desc: `(L${PROPS};)V`, flags: 0x0001, code: (a) => a.ret() }]
    })
    const hard = buildClass({
      name: 'bsynth/HardBloomBlock',
      superName: BLOCK,
      methods: [{ name: '<init>', desc: `(L${PROPS};)V`, flags: 0x0001, code: (a) => a.ret() }]
    })
    const jar = writeJar('bsynth.jar', buildJar([
      { name: `${helperOwner}.class`, data: helper },
      { name: 'bsynth/reg/BopBlocks.class', data: caller },
      { name: 'bsynth/GlowBloomBlock.class', data: bloom },
      { name: 'bsynth/HardBloomBlock.class', data: hard }
    ]))
    const { blocks } = deriveBlockShapes([jar])
    const glow = blocks.get('bopmod:glow_bloom')
    assert.ok(glow, 'consumer-helper registration found (const namespace from the helper body)')
    assert.strictEqual(glow.shape, 'nonsolid', 'noCollission in the call-site window proves nonsolid')
    const hardB = blocks.get('bopmod:hard_bloom')
    assert.ok(hardB, 'statement windows keep neighboring registrations separated')
    assert.strictEqual(hardB.shape, 'solid', 'the noCollission of the PREVIOUS window must not leak')
  })
})

describe('blockShapeDerivation (solved dynamic-body factors)', function () {
  const MULTIFACE = 'net/minecraft/world/level/block/MultifaceBlock'
  const BOOL_PROP = 'net/minecraft/world/level/block/state/properties/BooleanProperty'

  it('counts a MultifaceBlock subclass via the equation-solved factor (64 x own props)', function () {
    const owner = 'msynth/reg/MossBlocks'
    const moss = 'msynth/CreepMossBlock'
    const propsDesc = `L${PROPS};`
    const reg = buildClass({
      name: owner,
      bootstrapMethods: [{ refKind: 6, owner, name: 'lambda$static$0', desc: `()L${BLOCK};` }],
      methods: [
        {
          name: '<clinit>',
          desc: '()V',
          flags: 0x0008,
          code: (a) => a
            .ldcStr('mossmod')
            .invokestatic(DR, 'create', `(Ljava/lang/String;)L${DR};`)
            .putstatic(owner, 'BLOCKS', `L${DR};`)
            .getstatic(owner, 'BLOCKS', `L${DR};`)
            .ldcStr('creep_moss')
            .invokedynamic(0, 'get', '()Ljava/util/function/Supplier;')
            .invokevirtual(DR, 'register', `(Ljava/lang/String;Ljava/util/function/Supplier;)L${RO};`)
            .pop().ret()
        },
        {
          name: 'lambda$static$0',
          desc: `()L${BLOCK};`,
          flags: 0x000a,
          code: (a) => a
            .new_(moss).dup()
            .invokestatic(PROPS, 'm_284310_', `()${propsDesc}`)
            .invokespecial(moss, '<init>', `(${propsDesc})V`)
            .areturn()
        }
      ]
    })
    const mossCls = buildClass({
      name: moss,
      superName: MULTIFACE,
      methods: [
        { name: '<init>', desc: `(L${PROPS};)V`, flags: 0x0001, code: (a) => a.ret() },
        {
          name: '<clinit>',
          desc: '()V',
          flags: 0x0008,
          code: (a) => a
            .ldcStr('waterlogged')
            .invokestatic(BOOL_PROP, 'm_61465_', `(Ljava/lang/String;)L${BOOL_PROP};`)
            .putstatic(moss, 'WATERLOGGED', `L${BOOL_PROP};`)
            .ret()
        },
        {
          // createBlockStateDefinition: super(builder); builder.add(WATERLOGGED)
          name: 'm_7926_',
          desc: `(L${BUILDER};)V`,
          flags: 0x0004,
          code: (a) => a
            .aload(0).aload(1)
            .invokespecial(MULTIFACE, 'm_7926_', `(L${BUILDER};)V`)
            .aload(1)
            .getstatic(moss, 'WATERLOGGED', `L${BOOL_PROP};`)
            .invokevirtual(BUILDER, 'm_61104_', `([Lnet/minecraft/world/level/block/state/properties/Property;)L${BUILDER};`)
            .pop().ret()
        }
      ]
    })
    const jar = writeJar('mossmod.jar', buildJar([
      { name: `${owner}.class`, data: reg },
      { name: `${moss}.class`, data: mossCls }
    ]))
    const { blocks } = deriveBlockShapes([jar])
    const b = blocks.get('mossmod:creep_moss')
    assert.ok(b)
    assert.strictEqual(b.stateCount, 128,
      'MultifaceBlock contributes the equation-solved factor 64; own WATERLOGGED doubles it')
  })
})

describe('blockShapeDerivation (real jars, when present on this machine)', function () {
  const FD = '/Users/leoli/minepal-coop/modknowledge/jars/forge-1.20.1/FarmersDelight-1.20.1-1.3.2.jar'
  const LANE_JARS = '/Users/leoli/minepal-coop/modded-block-shapes/registrate/jars'
  const CREATE = `${LANE_JARS}/create-1.20.1-6.0.8.jar`
  const BOP = `${LANE_JARS}/BiomesOPlenty-forge-1.20.1-19.0.0.96.jar`
  const TB = `${LANE_JARS}/TerraBlender-forge-1.20.1-3.0.1.10.jar`

  it('Farmers Delight 1.20.1: 132 blocks, wild crops nonsolid, crates solid', function () {
    if (!fs.existsSync(FD)) return this.skip()
    const { blocks, stats } = deriveBlockShapes([FD])
    assert.strictEqual(stats.registrations, 132)
    assert.strictEqual(stats.counted, 132, 'every FD block gets an exact state count')
    assert.strictEqual(blocks.get('farmersdelight:wild_cabbages').shape, 'nonsolid')
    assert.strictEqual(blocks.get('farmersdelight:sandy_shrub').shape, 'nonsolid')
    assert.strictEqual(blocks.get('farmersdelight:cabbage_crate').shape, 'solid')
    assert.strictEqual(blocks.get('farmersdelight:stove').shape, 'solid')
    assert.strictEqual(blocks.get('farmersdelight:rope').shape, 'abstain', 'getCollisionShape override guard')
    assert.strictEqual(blocks.get('farmersdelight:cabbages').stateCount, 8)
  })

  it('Create 1.20.1 (Registrate): 186 derived, all counted, rig-proven spots', function () {
    if (!fs.existsSync(CREATE)) return this.skip()
    const { blocks, stats } = deriveBlockShapes([CREATE])
    // 186 of 643 total registry blocks: explicit chains derive; loop-generated
    // families (dyed/palette variants) abstain per-block by design
    assert.strictEqual(stats.registrations, 186)
    assert.strictEqual(stats.counted, 186)
    assert.strictEqual(blocks.get('create:shaft').shape, 'solid')
    assert.strictEqual(blocks.get('create:shaft').stateCount, 6, 'axis(3) x waterlogged(2) - rig span-edge exact')
    assert.strictEqual(blocks.get('create:fluid_pipe').stateCount, 128, '6 faces x waterlogged (interface-constant props)')
    assert.strictEqual(blocks.get('create:fake_track').shape, 'nonsolid', 'the one nonsolid Create claim - rig-truthed')
    assert.strictEqual(blocks.get('create:crushing_wheel_controller').shape, 'abstain', 'collision-override guard')
  })

  it('Biomes O Plenty 1.20.1 (+TerraBlender): 429/429 derived and counted', function () {
    if (!fs.existsSync(BOP) || !fs.existsSync(TB)) return this.skip()
    const { blocks, stats } = deriveBlockShapes([BOP, TB])
    assert.strictEqual(stats.registrations, 429, 'BOP registers 429 blocks - full coverage via the consumer-helper idiom')
    assert.strictEqual(stats.counted, 429, 'incl. the MultifaceBlock factor blocks')
    assert.strictEqual(blocks.get('biomesoplenty:orange_cosmos').shape, 'nonsolid')
    assert.strictEqual(blocks.get('biomesoplenty:rose').stateCount, 1)
    assert.strictEqual(blocks.get('biomesoplenty:barnacles').stateCount, 128, 'MultifaceBlock factor 64 x waterlogged - rig span-edge exact')
    assert.strictEqual(blocks.get('biomesoplenty:webbing').stateCount, 64, 'MultifaceBlock factor alone - rig span-edge exact')
    assert.strictEqual(blocks.get('biomesoplenty:white_sandstone').shape, 'solid')
    assert.strictEqual(blocks.get('biomesoplenty:blood').shape, 'abstain', 'fluid block - collision-override guard')
  })
})
