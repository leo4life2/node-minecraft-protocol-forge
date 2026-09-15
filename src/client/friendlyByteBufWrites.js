'use strict'

// FriendlyByteBuf write method -> protodef type (minecraft-data's own
// primitive names). ONE table shared by the runtime layout reader
// (commandArgumentTypeDerivation.js) and the dev-time mapping generator
// (tools/genBlockShapeTables.js), so the era vocabulary emitted into
// data/blockShapeTables.json (namespaces.<era>.ids.friendlyByteBufWrites)
// can never name a write the reader does not model, nor miss one it does.
const WRITES = {
  writeUtf: 'string',
  writeResourceLocation: 'string',
  writeIdentifier: 'string',
  writeResourceKey: 'string',
  writeBoolean: 'bool',
  writeByte: 'i8',
  writeShort: 'i16',
  writeInt: 'i32',
  writeLong: 'i64',
  writeFloat: 'f32',
  writeDouble: 'f64',
  writeVarInt: 'varint',
  writeVarLong: 'varlong',
  writeEnum: 'varint',
  writeUUID: 'UUID'
}

// The mapping era a member name belongs to, from its spelling alone:
// m_NNN_ / f_NNN_ = SRG (Forge 1.17-1.20.1), method_N / field_N =
// intermediary (Fabric); anything else is a Mojang (or mod-own) name.
function eraOfMember (name) {
  if (/^[mf]_\d+_$/.test(name)) return 'srg'
  if (/^(method|field)_\d+$/.test(name)) return 'intermediary'
  return null
}

module.exports = { WRITES, eraOfMember }
