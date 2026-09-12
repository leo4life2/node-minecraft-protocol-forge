'use strict'
// Test-only: rewrite UTF8 constant-pool strings of the classes in a (nested)
// jar, drop entries, edit text entries — so a REAL trimmed mod jar can be bent
// into the shapes the derivation must abstain on or follow (another packet
// class, another primitive, a missing manifest) without shipping more jars.
const { zipCentralEntries, zipEntryData } = require('../../src/client/jarAnalysis')
const { buildJar } = require('./synthJar')
const CP_SIZE = { 3: 5, 4: 5, 5: 9, 6: 9, 7: 3, 8: 3, 9: 5, 10: 5, 11: 5, 12: 5, 15: 4, 16: 3, 17: 5, 18: 5, 19: 3, 20: 3 }
function rewriteClass (buf, fn) {
  let o = 8; const cpCount = buf.readUInt16BE(o); o += 2; const parts = [buf.subarray(0, 10)]; let i = 1; let changed = 0
  while (i < cpCount) {
    const tag = buf[o]
    if (tag === 1) {
      const len = buf.readUInt16BE(o + 1); const str = buf.subarray(o + 3, o + 3 + len).toString('latin1'); const rep = fn(str)
      if (rep != null && rep !== str) { const nb = Buffer.from(rep, 'latin1'); const h = Buffer.alloc(3); h[0] = 1; h.writeUInt16BE(nb.length, 1); parts.push(h, nb); changed++ } else parts.push(buf.subarray(o, o + 3 + len))
      o += 3 + len; i++
    } else { const size = CP_SIZE[tag]; if (!size) throw new Error('cp tag ' + tag); parts.push(buf.subarray(o, o + size)); o += size; i += (tag === 5 || tag === 6) ? 2 : 1 }
  }
  parts.push(buf.subarray(o)); return { buf: Buffer.concat(parts), changed }
}
// rules: { drop(path)->bool, rewrite(path, str)->str|undefined, text(path, str)->str|undefined }; nested paths are joined by '!'
function mutateJar (buf, rules, prefix = '') {
  const out = []; let changed = 0; const dropped = []
  for (const e of zipCentralEntries(buf)) {
    if (e.name.endsWith('/')) continue
    const p = prefix + e.name; if (rules.drop && rules.drop(p)) { dropped.push(p); continue }
    let data = zipEntryData(buf, e)
    if (e.name.endsWith('.class') && rules.rewrite) { const r = rewriteClass(data, (s) => rules.rewrite(p, s)); data = r.buf; changed += r.changed } else if (e.name.endsWith('.jar')) { const r = mutateJar(data, rules, p + '!'); data = r.buf; changed += r.changed; dropped.push(...r.dropped) } else if (rules.text && /\.(json|toml|MF)$/.test(e.name)) { const t = data.toString('utf8'); const rep = rules.text(p, t); if (rep != null && rep !== t) { data = Buffer.from(rep, 'utf8'); changed++ } }
    out.push({ name: e.name, data })
  }
  return { buf: buildJar(out), changed, dropped }
}
// The two bends the copy law is pinned on: a serverbound CHAT packet read the client never writes (C), and chat paired on both sides (C2, not in the table).
const CHAT = {
  unpaired: { text: (p, t) => (/refmap\.json$/.test(p) ? t.split('ServerboundMovePlayerPacket$Pos;').join('ServerboundChatPacket;') : undefined), drop: (p) => /client\/sync\/MixinServerboundMovePlayerPacketPos\.class$/.test(p), rewrite: (p, s) => (/position_sync\/MixinServerboundMovePlayerPacketPos\.class$/.test(p) && s.includes('ServerboundMovePlayerPacket$Pos') ? s.split('ServerboundMovePlayerPacket$Pos').join('ServerboundChatPacket') : undefined) },
  paired: { text: (p, t) => (/refmap\.json$/.test(p) ? t.split('ServerboundMovePlayerPacket$Pos;').join('ServerboundChatPacket;') : undefined), rewrite: (p, s) => (/MixinServerboundMovePlayerPacketPos\.class$/.test(p) && s.includes('ServerboundMovePlayerPacket$Pos') ? s.split('ServerboundMovePlayerPacket$Pos').join('ServerboundChatPacket') : undefined) }
}
module.exports = { rewriteClass, mutateJar, CHAT }
