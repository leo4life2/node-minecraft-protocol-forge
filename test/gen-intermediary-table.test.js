/* eslint-env mocha */
'use strict'
// HF112: the runtime-name column generator (tools/gen-intermediary-table.js, dev-time) and the data it commits
// (src/client/data/packetBodyRuntimeNames.json + .sources.json). The column is never typed: it is the join of the two
// published mapping files, and this suite pins (1) the axis coverage, (2) the shape of every column, (3) byte-for-byte
// reproduction of the committed 1.20.1 column from the recorded mapping pair when the pair is present locally.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const gen = require('../tools/gen-intermediary-table')
const { PACKET_CLASS_TABLE, packetTableFor } = require('../src/client/packetBodyWireDerivation')
const DATA = path.join(__dirname, '..', 'src', 'client', 'data', 'packetBodyRuntimeNames.json')
const SOURCES = path.join(__dirname, '..', 'src', 'client', 'data', 'packetBodyRuntimeNames.sources.json')
const data = JSON.parse(fs.readFileSync(DATA, 'utf8'))
const sources = JSON.parse(fs.readFileSync(SOURCES, 'utf8'))
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
// the committed 1.20.1 column, serialised as the generator writes it (gen.canon)
const COLUMN_1_20_1_SHA256 = '6acba7f47ab5a211eb81021957060f68a648f932142d811751f5baa32c499b2c'
const VERDICTS = new Set(['column', 'no-fabric', 'no-mojang-mappings'])

describe('HF112 runtime-name column: the data file + the generator', function () {
  it('the axis is minecraft-data supportedVersions.pc (what the client speaks): every version has a verdict, a column iff the verdict says so, and every tabled version Fabric runs on (1.17+) has a column', () => {
    const axis = require('minecraft-data').supportedVersions.pc
    assert.equal(sources.axis, 'minecraft-data supportedVersions.pc')
    for (const v of axis) {
      const row = sources.versions[v]
      assert.ok(row, `no verdict for ${v}`)
      assert.ok(VERDICTS.has(row.verdict), `${v}: verdict ${row.verdict} outside the closed set`)
      assert.equal(!!data.columns[v], row.verdict === 'column', `${v}: column presence vs verdict ${row.verdict}`)
      if (row.verdict === 'column') { assert.match(row.intermediary.sha256, /^[0-9a-f]{64}$/); assert.match(row.mojang.sha256, /^[0-9a-f]{64}$/); assert.match(row.mojang.sha1, /^[0-9a-f]{40}$/) }
    }
    const tabled = axis.filter((v) => Object.keys(packetTableFor(v)).length && sources.versions[v].verdict !== 'no-fabric')
    assert.ok(tabled.length >= 20, `tabled Fabric versions: ${tabled.length}`)
    for (const v of tabled) assert.ok(data.columns[v], `${v} is tabled and Fabric runs there but has no column`)
    assert.ok(Object.keys(data.columns).every((v) => axis.includes(v)), 'a column outside the axis')
  })
  it('every column is well-formed: the closed class set (the table rows + FriendlyByteBuf + Packet + the payload packet), runtime class names in the runtime shape, member keys name(desc) -> method_N, sorted keys', () => {
    const wanted = new Set(gen.wantedClasses())
    for (const row of PACKET_CLASS_TABLE) for (const cls of Object.keys(row.classes)) assert.ok(wanted.has(cls), cls)
    for (const [v, col] of Object.entries(data.columns)) {
      assert.deepEqual(Object.keys(col), ['classes', 'methods'], v)
      const classes = Object.keys(col.classes)
      assert.deepEqual(classes, [...classes].sort(), `${v}: unsorted classes`)
      for (const [moj, runtime] of Object.entries(col.classes)) { assert.ok(wanted.has(moj), `${v}: ${moj} outside the closed set`); assert.match(runtime, /^net\/minecraft\/class_\d+(\$class_\d+)?$/, `${v}: ${moj} -> ${runtime}`) }
      for (const [owner, members] of Object.entries(col.methods)) {
        assert.ok(col.classes[owner], `${v}: members of an unmapped owner ${owner}`)
        for (const [member, runtime] of Object.entries(members)) { assert.match(member, /^[A-Za-z_$][\w$]*\(.*\).+$/, `${v}: ${owner} ${member}`); assert.match(runtime, /^method_\d+$/, `${v}: ${owner} ${member} -> ${runtime}`) }
      }
    }
    // the 1.20.1 column names the F47 facts read off the real mappings (receipts/f47/intermediary-table-1.20.1.json)
    const c = data.columns['1.20.1']
    assert.equal(c.classes['net/minecraft/network/protocol/game/ClientboundMapItemDataPacket'], 'net/minecraft/class_2683')
    assert.equal(c.classes['net/minecraft/network/protocol/game/ServerboundMovePlayerPacket$PosRot'], 'net/minecraft/class_2828$class_2830')
    assert.equal(c.classes['net/minecraft/network/FriendlyByteBuf'], 'net/minecraft/class_2540')
    assert.equal(c.methods['net/minecraft/network/protocol/game/ClientboundMapItemDataPacket']['write(Lnet/minecraft/network/FriendlyByteBuf;)V'], 'method_11052')
    assert.equal(c.methods['net/minecraft/network/FriendlyByteBuf']['writeVarIntArray([I)Lnet/minecraft/network/FriendlyByteBuf;'], 'method_10806')
    assert.equal(c.methods['net/minecraft/network/FriendlyByteBuf']['readVarIntArray()[I'], 'method_10787')
    assert.equal(sha256(gen.canon(c)), COLUMN_1_20_1_SHA256, 'the committed 1.20.1 column')
    assert.equal(fs.readFileSync(DATA, 'utf8'), gen.canon(data), 'the data file is its canonical serialisation (sorted keys, two-space indent, trailing newline)')
  })
  it('the generator REPRODUCES the committed 1.20.1 column byte for byte from the recorded mapping pair (HF112_MAPPING_PAIR_1_20_1=<intermediary jar or mappings.tiny>,<server.txt>); the pair absent = SKIPPED with the column sha256 still pinned', function () {
    const pair = process.env.HF112_MAPPING_PAIR_1_20_1
    const rec = sources.versions['1.20.1']
    if (!pair) { console.log(`      SKIPPED: HF112_MAPPING_PAIR_1_20_1 not set (the 1.20.1 mapping pair is not on this machine); committed column sha256 ${COLUMN_1_20_1_SHA256}`); assert.equal(sha256(gen.canon(data.columns['1.20.1'])), COLUMN_1_20_1_SHA256); return }
    const [tinyPath, serverPath] = pair.split(',')
    const tinyBytes = fs.readFileSync(tinyPath); const server = fs.readFileSync(serverPath)
    const isJar = tinyBytes[0] === 0x50 && tinyBytes[1] === 0x4b
    if (isJar) assert.equal(sha256(tinyBytes), rec.intermediary.sha256, 'the local intermediary jar is the recorded one')
    assert.equal(sha256(server), rec.mojang.sha256, 'the local server mappings are the recorded ones')
    const { zipCentralEntries, zipEntryData } = require('../src/client/jarAnalysis')
    const tiny = isJar ? zipEntryData(tinyBytes, zipCentralEntries(tinyBytes).find((e) => e.name === 'mappings/mappings.tiny')).toString('utf8') : tinyBytes.toString('utf8')
    assert.equal(sha256(tiny), rec.intermediary.tinySha256)
    const col = gen.buildColumn(tiny, server.toString('utf8'))
    assert.equal(gen.canon(col), gen.canon(data.columns['1.20.1']), 'the regenerated 1.20.1 column differs from the committed one')
    assert.equal(sha256(gen.canon(col)), COLUMN_1_20_1_SHA256)
  })
  it('the generator is dev-time only: no module under src/ requires tools/', () => {
    const SRC = path.join(__dirname, '..', 'src')
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
    for (const f of walk(SRC).filter((f) => f.endsWith('.js'))) assert.ok(!/require\(\s*['"][^'"]*tools\//.test(fs.readFileSync(f, 'utf8')), `${path.relative(SRC, f)} requires tools/`)
  })
  it('the two mapping formats parse as published: tiny v2 header + c/m rows (official -> intermediary), ProGuard class and member lines; the join keys are the obfuscated name AND descriptor', () => {
    const tiny = 'tiny\t2\t0\tofficial\tintermediary\nc\tsf\tnet/minecraft/class_2540\n\tm\t([I)Lsf;\ta\tmethod_10806\n\tm\t()[I\tc\tmethod_10787\nc\tuo\tnet/minecraft/class_2596\n\tm\t(Lsf;)V\ta\tmethod_11052\nc\twj\tnet/minecraft/class_2683\n'
    const pg = 'net.minecraft.network.FriendlyByteBuf -> sf:\n    net.minecraft.network.FriendlyByteBuf writeVarIntArray(int[]) -> a\n    int[] readVarIntArray() -> c\n    int writeInt(int) -> writeInt\nnet.minecraft.network.protocol.Packet -> uo:\n    void write(net.minecraft.network.FriendlyByteBuf) -> a\nnet.minecraft.network.protocol.game.ClientboundMapItemDataPacket -> wj:\n    60:84:void write(net.minecraft.network.FriendlyByteBuf) -> a\n    void <init>(net.minecraft.network.FriendlyByteBuf) -> <init>\n'
    const col = gen.buildColumn(tiny, pg)
    assert.deepEqual(col.classes, { 'net/minecraft/network/FriendlyByteBuf': 'net/minecraft/class_2540', 'net/minecraft/network/protocol/Packet': 'net/minecraft/class_2596', 'net/minecraft/network/protocol/game/ClientboundMapItemDataPacket': 'net/minecraft/class_2683' })
    assert.deepEqual(col.methods['net/minecraft/network/FriendlyByteBuf'], { 'readVarIntArray()[I': 'method_10787', 'writeVarIntArray([I)Lnet/minecraft/network/FriendlyByteBuf;': 'method_10806' }, 'writeInt keeps its name (a netty override): no entry')
    assert.deepEqual(col.methods['net/minecraft/network/protocol/game/ClientboundMapItemDataPacket'], { 'write(Lnet/minecraft/network/FriendlyByteBuf;)V': 'method_11052' }, 'the override resolves through the declaring interface row; <init> is name-stable and has no entry')
    assert.throws(() => gen.parseTiny('tiny\t2\t0\tofficial\tnamed\n'), /official\/intermediary/)
  })
})
