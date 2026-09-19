'use strict'
// HF53 — ONE nested-jar rule for every deriver.
//
// Mod jars nest their library jars in two spellings: Fabric/Quilt under
// META-INF/jars/ (fabric.mod.json "jars"), Forge/NeoForge JarJar under
// META-INF/jarjar/ with META-INF/jarjar/metadata.json naming each nested
// artifact (group, artifact, artifactVersion, path). A mod carried this way
// is not published on its own — the ONLY place its classes exist is inside
// the parent jar. Every deriver that reads class bytes (block shapes,
// command argument types, login acks, payload ids, packet-body / item-stack
// wire extensions, owo fingerprints) walks nested jars through this one
// rule, depth-bounded, so no deriver can miss a spelling another one knows
// (the F2b receipt: the login-ack corroboration read META-INF/jars/ only and
// never saw a JarJar-nested login channel — a deterministic kick).
//
// HF53 rider: the rule is the ROOT, not the file's position under it — a
// nested jar in a subfolder (META-INF/jarjar/<group>/<name>.jar, the path a
// JarJar manifest may carry) is a nested jar, bounded to
// MAX_NESTED_FOLDER_DEPTH folders under the root, and is named by that path.
// A jar the loader manifest names OUTSIDE the two roots (fabric.mod.json
// "jars" may path anywhere) is walked too: the manifest is the loader's own
// statement of what it loads.
const { zipEntryData } = require('./jarAnalysis')

const MAX_NESTED_FOLDER_DEPTH = 4
const NESTED_JAR_RE = /^META-INF\/(?:jars|jarjar)\/(?:[^/]+\/){0,4}[^/]+\.jar$/
const NESTED_ROOT_RE = /^META-INF\/(?:jars|jarjar)\//
const MAX_NESTED_DEPTH = 2
const JARJAR_METADATA = 'META-INF/jarjar/metadata.json'
const FABRIC_MOD_JSON = 'fabric.mod.json'
const METADATA_MAX_BYTES = 256 * 1024

function readJsonEntry (buf, entries, name) {
  const meta = (entries || []).find((e) => e.name === name)
  if (!meta || (meta.usize != null && meta.usize > METADATA_MAX_BYTES)) return null
  try { return JSON.parse(zipEntryData(buf, meta).toString('utf8')) } catch { return null }
}

/**
 * The loader manifest of a jar: nested entry path -> the artifact it names.
 * JarJar rows carry group/artifact/artifactVersion; fabric.mod.json "jars"
 * rows name a file only (the label falls back to the path). Empty when the
 * jar carries neither.
 * @returns {Map<string, {group: string|null, artifact: string|null, artifactVersion: string|null, path: string}>}
 */
function readNestedManifest (buf, entries) {
  const out = new Map()
  const jj = readJsonEntry(buf, entries, JARJAR_METADATA)
  for (const j of Array.isArray(jj && jj.jars) ? jj.jars : []) {
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
  const fmj = readJsonEntry(buf, entries, FABRIC_MOD_JSON)
  for (const j of Array.isArray(fmj && fmj.jars) ? fmj.jars : []) {
    const p = j && typeof j.file === 'string' ? j.file : null
    if (!p || out.has(p)) continue
    out.set(p, { group: null, artifact: null, artifactVersion: null, path: p })
  }
  return out
}

/** A nested jar's path under its root (META-INF/jars/ or META-INF/jarjar/); the whole entry name when it lies outside both. */
function nestedRelPath (entryName) {
  return String(entryName).replace(NESTED_ROOT_RE, '')
}

/** A nested jar's name for receipts: the manifest's artifact@version, else its path under the root (the file name at the root). */
function nestedArtifactLabel (entryName, manifest) {
  const m = manifest && manifest.get(entryName)
  if (m && m.artifact) return m.artifactVersion ? `${m.artifact}@${m.artifactVersion}` : m.artifact
  return nestedRelPath(entryName)
}

/**
 * The nested jars of a jar, in entry order, WITHOUT reading their bytes:
 * every entry under either root (subfolders included) plus every .jar the
 * loader manifest names. Each row: { entry, relPath, artifact, meta }.
 */
function nestedJarEntriesOf (buf, entries) {
  const manifest = readNestedManifest(buf, entries)
  const out = []
  for (const entry of entries || []) {
    const name = entry.name
    if (!NESTED_JAR_RE.test(name) && !(manifest.has(name) && /\.jar$/.test(name))) continue
    out.push({ entry, relPath: nestedRelPath(name), artifact: nestedArtifactLabel(name, manifest), meta: manifest.get(name) || null })
  }
  return out
}

/**
 * Visit every nested jar of a jar (both spellings), depth-bounded: `depth`
 * is the nesting depth of `buf` itself (0 = a top-level jar); nothing is
 * visited once `depth >= maxDepth`. An unreadable nested entry is skipped.
 * The visitor receives { entry, data, relPath, artifact, meta } — `data` the
 * nested jar's bytes, `relPath` its path under the root, `artifact` its
 * receipt label, `meta` its manifest row or null.
 */
function forEachNestedJar (buf, entries, depth, visit, maxDepth = MAX_NESTED_DEPTH) {
  if (depth >= maxDepth) return
  for (const row of nestedJarEntriesOf(buf, entries)) {
    let data
    try { data = zipEntryData(buf, row.entry) } catch { continue }
    visit({ entry: row.entry, data, relPath: row.relPath, artifact: row.artifact, meta: row.meta })
  }
}

module.exports = { NESTED_JAR_RE, MAX_NESTED_DEPTH, MAX_NESTED_FOLDER_DEPTH, JARJAR_METADATA, readNestedManifest, nestedRelPath, nestedArtifactLabel, nestedJarEntriesOf, forEachNestedJar }
