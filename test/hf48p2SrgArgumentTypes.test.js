/* eslint-env mocha */
// HF48-P2 — Forge 1.17-1.20.1 jars are SRG-named at the member level:
// EnumArgument$Info.serializeToNetwork calls FriendlyByteBuf.m_130070_
// (= writeUtf), so the HF45 layout reader abstained 'unmodelled-write:
// m_130070_' and the declare_commands boundary dropped every Forge 1.20.1
// tree (HF45 verdict-forge1201 LOW: unknown [51]). The reader now resolves
// an era-spelled write through the GENERATED mapping vocabulary
// (data/blockShapeTables.json namespaces.<era>.ids.friendlyByteBufWrites,
// from the real proguard + tsrg2 + tiny-v2 mappings) back to the Mojang
// name the shared WRITES table keys. Fixture: the REAL Forge 1.20.1-47.3.22
// universal jar trimmed to EnumArgument* + ForgeMod (the registration site).
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { zipCentralEntries, zipEntryData } = require('../src/client/jarAnalysis')
const { buildJar } = require('./helpers/synthJar')
const { deriveCommandArgumentTypes, resolveWrite, WRITES, _internal } = require('../src/client/commandArgumentTypeDerivation')
const shared = require('../src/client/friendlyByteBufWrites')
const TABLES = require('../src/client/data/blockShapeTables.json')
const { vanillaParserTable } = require('../src/client/commandTreeParser')

const FIX = path.join(__dirname, 'fixtures', 'hf48p2-forge-1.20.1-argument-types.jar')
const REAL = '/Users/nemossoftware/minepal-coop/forge-block-registry/server/libraries/net/minecraftforge/forge/1.20.1-47.3.22/forge-1.20.1-47.3.22-universal.jar'
const itIf = (c) => (c ? it : it.skip)

// the 1.20.1 wire: 51 vanilla parsers (0..50), then forge:enum 51 / forge:modid 52
function forge1201Registry () {
  const vt = vanillaParserTable('1.20.1')
  const registry = new Map(vt.rows.map((r) => [r.id, r.name]))
  registry.set(51, 'forge:enum'); registry.set(52, 'forge:modid')
  return { vt, registry }
}

function mutatedFixture (from, to) {
  const buf = fs.readFileSync(FIX)
  assert.strictEqual(from.length, to.length, 'constant-pool utf8 length must not change')
  const entries = []
  let hits = 0
  for (const e of zipCentralEntries(buf)) {
    let data = zipEntryData(buf, e)
    if (e.name === 'net/minecraftforge/server/command/EnumArgument$Info.class') {
      const i = data.indexOf(from)
      assert.ok(i >= 0, `${from} present in the real serializer`)
      data = Buffer.concat([data.subarray(0, i), Buffer.from(to), data.subarray(i + from.length)]); hits++
    }
    entries.push({ name: e.name, data })
  }
  assert.strictEqual(hits, 1)
  return buildJar(entries)
}

describe('HF48-P2 the mapping-era FriendlyByteBuf write vocabulary', function () {
  it('ONE write table: the reader and the generator share src/client/friendlyByteBufWrites.js', () => {
    assert.strictEqual(WRITES, shared.WRITES)
    assert.strictEqual(shared.eraOfMember('m_130070_'), 'srg'); assert.strictEqual(shared.eraOfMember('f_1_'), 'srg')
    assert.strictEqual(shared.eraOfMember('method_10814'), 'intermediary'); assert.strictEqual(shared.eraOfMember('writeUtf'), null)
  })
  it('the generated vocabulary (tables from the real 1.20.1 mappings): srg + intermediary names for every write the 1.20.1 FriendlyByteBuf declares, keyed by the Mojang name the WRITES table knows', () => {
    for (const era of ['srg', 'intermediary']) {
      const v = TABLES.namespaces[era].ids.friendlyByteBufWrites
      assert.ok(v && Object.keys(v).length >= 14, `${era} vocabulary present`)
      for (const [mojang, names] of Object.entries(v)) { assert.ok(WRITES[mojang], `${era}: ${mojang} is a modelled write`); assert.ok(Array.isArray(names) && names.length) }
    }
    assert.deepStrictEqual(TABLES.namespaces.srg.ids.friendlyByteBufWrites.writeUtf, ['m_130070_', 'm_130072_']) // writeUtf(String) + writeUtf(String,int)
    assert.deepStrictEqual(TABLES.namespaces.intermediary.ids.friendlyByteBufWrites.writeUtf, ['method_10814', 'method_10788'])
    assert.deepStrictEqual(TABLES.namespaces.srg.ids.friendlyByteBufWrites.writeVarInt, ['m_130130_'])
    assert.deepStrictEqual(TABLES.namespaces.srg.ids.friendlyByteBufWrites.writeByte, ['writeByte']) // netty override: unobfuscated in every era
    assert.strictEqual(TABLES.namespaces.srg.ids.classNames.friendlyByteBuf, 'net/minecraft/network/FriendlyByteBuf')
    assert.strictEqual(TABLES.namespaces.intermediary.ids.classNames.friendlyByteBuf, 'net/minecraft/class_2540')
    assert.strictEqual(TABLES.namespaces.srg.ids.friendlyByteBufWrites.writeIdentifier, undefined) // the 26.x name: no such 1.20.1 member, never invented
  })
  it('resolveWrite: Mojang first (era null, receipt unchanged), else the era of the spelling; a name outside the vocabulary is null (the named abstain)', () => {
    assert.deepStrictEqual(resolveWrite('writeUtf'), { mojang: 'writeUtf', type: 'string', era: null })
    assert.deepStrictEqual(resolveWrite('m_130070_'), { mojang: 'writeUtf', type: 'string', era: 'srg' })
    assert.deepStrictEqual(resolveWrite('m_130072_'), { mojang: 'writeUtf', type: 'string', era: 'srg' })
    assert.deepStrictEqual(resolveWrite('m_130130_'), { mojang: 'writeVarInt', type: 'varint', era: 'srg' })
    assert.deepStrictEqual(resolveWrite('method_10814'), { mojang: 'writeUtf', type: 'string', era: 'intermediary' })
    assert.deepStrictEqual(resolveWrite('method_10804'), { mojang: 'writeVarInt', type: 'varint', era: 'intermediary' })
    assert.strictEqual(resolveWrite('m_999999_'), null)
    assert.strictEqual(resolveWrite('writeNullable'), null)
    assert.strictEqual(resolveWrite('method_1'), null)
    assert.strictEqual(_internal.ERA_WRITES.srg.get('m_130070_'), 'writeUtf')
    assert.strictEqual(_internal.ERA_WRITES.srg.has('writeByte'), false, 'a self-named member never aliases itself')
  })
  it('the REAL Forge 1.20.1-47.3.22 jar (trimmed fixture): 51 forge:enum -> string (m_130070_ = writeUtf via srg vocab), 52 forge:modid -> none; 0 abstains; the parser extension carries both', () => {
    const { vt, registry } = forge1201Registry()
    const r = deriveCommandArgumentTypes({ registry, vanillaNames: vt.names, jars: [FIX] })
    assert.strictEqual(r.vanilla, vt.rows.length); assert.ok(vt.rows.every((row) => row.id < 51)); assert.deepStrictEqual(r.abstains, [])
    const en = r.derived.find((d) => d.name === 'forge:enum'); const mod = r.derived.find((d) => d.name === 'forge:modid')
    assert.strictEqual(en.id, 51); assert.deepStrictEqual(en.fields, [{ name: 'utf0', type: 'string' }])
    assert.deepStrictEqual(en.source.writes, ['m_130070_ = writeUtf via srg vocab']); assert.strictEqual(en.source.era, 'srg')
    assert.strictEqual(en.source.serializer, 'net/minecraftforge/server/command/EnumArgument$Info'); assert.strictEqual(en.source.jar, 'hf48p2-forge-1.20.1-argument-types.jar')
    assert.strictEqual(mod.id, 52); assert.deepStrictEqual(mod.fields, []); assert.strictEqual(mod.source.kind, 'vanilla-api-no-properties'); assert.strictEqual(mod.source.era, undefined)
    assert.deepStrictEqual(r.extension.parsers, [{ id: 51, name: 'forge:enum', fields: [{ name: 'utf0', type: 'string' }] }, { id: 52, name: 'forge:modid', fields: [] }])
  })
  itIf(fs.existsSync(REAL))('the same from the untrimmed installed jar', () => {
    const { vt, registry } = forge1201Registry()
    const r = deriveCommandArgumentTypes({ registry, vanillaNames: vt.names, jars: [REAL] })
    assert.deepStrictEqual(r.abstains, []); assert.deepStrictEqual(r.extension.parsers.map((p) => `${p.id}=${p.fields.map((f) => f.type).join(',') || 'none'}`), ['51=string', '52=none'])
  })
  it('a write the mappings did not know (the real serializer mutated to m_999999_) stays the NAMED abstain — an SRG id outside the generated vocabulary is never guessed', () => {
    const jar = path.join(require('os').tmpdir(), `hf48p2-mutated-${process.pid}.jar`)
    fs.writeFileSync(jar, mutatedFixture('m_130070_', 'm_999999_'))
    try {
      const { vt, registry } = forge1201Registry()
      const r = deriveCommandArgumentTypes({ registry, vanillaNames: vt.names, jars: [jar] })
      assert.deepStrictEqual(r.abstains.map((a) => `${a.id}=${a.name}:${a.reason}`), ['51=forge:enum:serializer-non-derivable:unmodelled-write:m_999999_'])
      assert.deepStrictEqual(r.extension.parsers.map((p) => p.id), [52])
    } finally { try { fs.unlinkSync(jar) } catch {} }
  })
  it('RED on the base (the same fixture read with the Mojang table only): the write is m_130070_, no Mojang spelling in the bytes', () => {
    const buf = fs.readFileSync(FIX)
    const info = zipCentralEntries(buf).find((e) => e.name === 'net/minecraftforge/server/command/EnumArgument$Info.class')
    const data = zipEntryData(buf, info)
    assert.ok(data.includes('m_130070_')); assert.ok(!data.includes('writeUtf'))
  })
})
