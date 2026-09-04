// D3 rider — the current dimension's VERTICAL BOUNDS as the wire states them,
// kept on the client so the loader custom-spawn plausibility gate can bound a
// decoded y to the world the bot is actually in (false-awareness law: a
// synthesized entity must never come from garbage).
//
// Where the wire says it (minecraft-data protocol.json per version — the
// same fields mineflayer's game plugin reads):
//   - 1.16.2–1.18.2: `login.dimension` / `respawn.dimension` = the dimension
//     type NBT itself (`min_y`, `height`; 1.16 has no `min_y` → 0..256);
//     `login.dimensionCodec` = the registry (`minecraft:dimension_type`).
//   - 1.19–1.20.1: `login.dimensionCodec` (registry) + `login.worldType` /
//     `respawn.dimension` = the dimension type NAME, looked up in the codec.
//   - 1.20.2–1.20.4: configuration `registry_data.codec` (registry NBT) +
//     `login.worldType` / `respawn.dimension` names.
//   - 1.20.5+: segmented configuration `registry_data` (`id` +
//     ordered `entries[{key, value?}]`) + `login/respawn.worldState.dimension`
//     = the INDEX into the dimension_type entries (a value-less entry — the
//     server assumes a known pack — leaves the bounds unknown, never guessed).
//
// When nothing is known the gate falls back to the widest LEGAL world:
// DimensionType (vanilla) MIN_Y = -2032, Y_SIZE = 4064 → min_y ∈ [-2032, 2031],
// min_y + height ≤ 2032. Below the dimension floor an entity survives down to
// minY − 64 (Entity.checkBelowWorld) — the gate's floor margin.
'use strict'

const LEGAL_MIN_Y = -2032
const LEGAL_MAX_Y = 2032
const VOID_MARGIN = 64

/** prismarine-nbt JSON shape → plain values (compound → object, list → array). */
function simplify (nbt) {
  if (nbt === null || nbt === undefined) return nbt
  if (typeof nbt !== 'object') return nbt
  if (Array.isArray(nbt)) return nbt
  if (typeof nbt.type !== 'string' || !('value' in nbt)) {
    // already plain (an object of simplified members)
    const out = {}
    for (const k of Object.keys(nbt)) out[k] = simplify(nbt[k])
    return out
  }
  switch (nbt.type) {
    case 'compound': {
      const out = {}
      for (const k of Object.keys(nbt.value || {})) out[k] = simplify(nbt.value[k])
      return out
    }
    case 'list': {
      const inner = nbt.value || {}
      const items = Array.isArray(inner.value) ? inner.value : []
      return items.map((v) => simplify({ type: inner.type, value: v }))
    }
    default: return nbt.value
  }
}

function stripNs (name) { return typeof name === 'string' ? name.replace(/^minecraft:/, '') : name }

function boundsFromType (t) {
  if (!t || typeof t !== 'object') return null
  const minY = Number.isFinite(t.min_y) ? t.min_y : (t.min_y === undefined ? 0 : null)
  const height = Number.isFinite(t.height) ? t.height : (t.height === undefined && t.min_y === undefined ? 256 : null)
  if (!Number.isFinite(minY) || !Number.isFinite(height)) return null
  return { minY, height }
}

/**
 * Track the dimension bounds on a client. Idempotent (one tracker per client).
 * @param {import('events').EventEmitter} client
 * @returns {{minY:number|null, height:number|null, dimension:string|null, source:string|null}}
 */
function installWorldBounds (client) {
  if (client.worldBounds) return client.worldBounds
  const st = { minY: null, height: null, dimension: null, source: null, types: new Map(), ordered: [] }
  client.worldBounds = st

  const learnRegistry = (reg) => {
    // {'minecraft:dimension_type': {type, value: [{name, id, element}]}} (simplified)
    const dt = reg && (reg['minecraft:dimension_type'] || reg.dimension_type)
    const list = dt && (Array.isArray(dt.value) ? dt.value : (Array.isArray(dt) ? dt : null))
    if (!list) return
    for (const e of list) {
      if (!e || typeof e.name !== 'string') continue
      const b = boundsFromType(e.element)
      st.types.set(stripNs(e.name), b)
      if (Number.isInteger(e.id)) st.ordered[e.id] = { name: stripNs(e.name), bounds: b }
    }
  }
  const set = (b, name, source) => {
    st.dimension = name === undefined ? st.dimension : stripNs(name)
    st.minY = b ? b.minY : null
    st.height = b ? b.height : null
    st.source = b ? source : null
  }
  const apply = (w) => {
    if (!w || typeof w !== 'object') return
    if (w.dimension && typeof w.dimension === 'object' && typeof w.dimension.type === 'string') {
      // 1.16.2–1.18.2: the dimension type NBT rides in the packet itself
      set(boundsFromType(simplify(w.dimension)), typeof w.worldName === 'string' ? w.worldName : undefined, 'packet dimension nbt')
      return
    }
    if (Number.isInteger(w.dimension)) {
      // 1.20.5+: index into the ordered dimension_type entries
      const e = st.ordered[w.dimension]
      set(e ? e.bounds : null, e ? e.name : `#${w.dimension}`, 'registry_data entry by index')
      return
    }
    const name = typeof w.worldType === 'string' ? w.worldType : (typeof w.dimension === 'string' ? w.dimension : null)
    if (name === null) return
    const b = st.types.has(stripNs(name)) ? st.types.get(stripNs(name)) : null
    set(b, name, 'dimension codec by name')
  }

  client.on('packet', (packet, meta) => {
    if (!meta || !packet || typeof packet !== 'object') return
    try {
      if (meta.name === 'registry_data') {
        if (packet.codec) learnRegistry(simplify(packet.codec))
        else if (packet.id && Array.isArray(packet.entries)) {
          if (stripNs(packet.id) !== 'dimension_type') return
          st.ordered = []
          packet.entries.forEach((e, i) => {
            const name = e && typeof e.key === 'string' ? stripNs(e.key) : `#${i}`
            const b = e && e.value !== undefined && e.value !== null ? boundsFromType(simplify(e.value)) : null
            st.ordered[i] = { name, bounds: b }
            st.types.set(name, b)
          })
        }
        return
      }
      if (meta.name === 'login' || meta.name === 'respawn') {
        const w = packet.worldState || packet
        if (w.dimensionCodec) learnRegistry(simplify(w.dimensionCodec))
        apply(w)
      }
    } catch { /* a bounds fact we cannot read stays unknown — the gate then uses the legal world */ }
  })
  return st
}

/** The dimension bounds the gate should use: the known dimension, else null (caller uses the legal world). */
function worldBoundsOf (client) {
  const st = client && client.worldBounds
  if (!st || !Number.isFinite(st.minY) || !Number.isFinite(st.height)) return null
  return { minY: st.minY, height: st.height, dimension: st.dimension || null }
}

module.exports = { installWorldBounds, worldBoundsOf, simplify, LEGAL_MIN_Y, LEGAL_MAX_Y, VOID_MARGIN }
