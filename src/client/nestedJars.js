'use strict'
// HF53 — ONE nested-jar rule for every deriver.
//
// Mod jars nest their library jars in two spellings: Fabric/Quilt under
// META-INF/jars/ (fabric.mod.json "jars"), Forge/NeoForge JarJar under
// META-INF/jarjar/ with META-INF/jarjar/metadata.json naming each nested
// artifact (group, artifact, artifactVersion, path). A mod carried this way
// is not published on its own — the ONLY place its classes exist is inside
// the parent jar. Every deriver that reads class bytes (block shapes,
// command argument types, login acks) walks nested jars through this one
// rule, depth-bounded, so no deriver can miss a spelling another one knows
// (the F2b receipt: the login-ack corroboration read META-INF/jars/ only and
// never saw a JarJar-nested login channel — a deterministic kick).
const { zipEntryData } = require('./jarAnalysis')

const NESTED_JAR_RE = /^META-INF\/(?:jars|jarjar)\/[^/]+\.jar$/
const MAX_NESTED_DEPTH = 2
const JARJAR_METADATA = 'META-INF/jarjar/metadata.json'
const METADATA_MAX_BYTES = 256 * 1024

/**
 * The JarJar manifest of a jar: nested entry path -> the artifact it names.
 * Empty when the jar carries none (Fabric nesting names jars by file only).
 * @returns {Map<string, {group: string|null, artifact: string|null, artifactVersion: string|null, path: string}>}
 */
function readNestedManifest (buf, entries) {
  const out = new Map()
  const meta = (entries || []).find((e) => e.name === JARJAR_METADATA)
  if (!meta || (meta.usize != null && meta.usize > METADATA_MAX_BYTES)) return out
  let json
  try { json = JSON.parse(zipEntryData(buf, meta).toString('utf8')) } catch { return out }
  for (const j of Array.isArray(json && json.jars) ? json.jars : []) {
    const p = j && typeof j.path === 'string' ? j.path : null
    if (!p) continue
    const id = (j && j.identifier) || {}
    const ver = (j && j.version) || {}
    out.set(p, {
      group: typeof id.group === 'string' ? id.group : null,
      artifact: typeof id.artifact === 'string' ? id.artifact : null,
      artifactVersion: typeof ver.artifactVersion === 'string' ? ver.artifactVersion : null,
      path: p
    })
  }
  return out
}

/** A nested jar's name for receipts: the manifest's artifact@version, else its file name. */
function nestedArtifactLabel (entryName, manifest) {
  const m = manifest && manifest.get(entryName)
  if (m && m.artifact) return m.artifactVersion ? `${m.artifact}@${m.artifactVersion}` : m.artifact
  return String(entryName).split('/').pop()
}

/**
 * Visit every nested jar of a jar (both spellings), depth-bounded: `depth`
 * is the nesting depth of `buf` itself (0 = a top-level jar); nothing is
 * visited once `depth >= maxDepth`. An unreadable nested entry is skipped.
 * The visitor receives { entry, data, artifact, meta } — `data` the nested
 * jar's bytes, `artifact` its receipt label, `meta` its manifest row or null.
 */
function forEachNestedJar (buf, entries, depth, visit, maxDepth = MAX_NESTED_DEPTH) {
  if (depth >= maxDepth) return
  const manifest = readNestedManifest(buf, entries)
  for (const entry of entries || []) {
    if (!NESTED_JAR_RE.test(entry.name)) continue
    let data
    try { data = zipEntryData(buf, entry) } catch { continue }
    visit({ entry, data, artifact: nestedArtifactLabel(entry.name, manifest), meta: manifest.get(entry.name) || null })
  }
}

module.exports = { NESTED_JAR_RE, MAX_NESTED_DEPTH, JARJAR_METADATA, readNestedManifest, nestedArtifactLabel, forEachNestedJar }
