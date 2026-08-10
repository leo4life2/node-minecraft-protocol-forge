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

describe('blockShapeDerivation (real jars, when present on this machine)', function () {
  const FD = '/Users/leoli/minepal-coop/modknowledge/jars/forge-1.20.1/FarmersDelight-1.20.1-1.3.2.jar'
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
})
