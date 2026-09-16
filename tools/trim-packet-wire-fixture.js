'use strict'
// Trims a real mod jar to the entries the packet-body wire derivation reads
// (META-INF/MANIFEST.MF + mod descriptors, mixin configs, refmaps, the packet mixin classes and the
// value-provider classes they reach), nested jars included, so the test
// fixture is REAL class bytes at a fraction of the size. Usage:
//   node tools/trim-packet-wire-fixture.js <in.jar> <out.jar> '<keep-regex>'
const fs = require('fs')
const { zipCentralEntries, zipEntryData } = require('../src/client/jarAnalysis')
const { buildJar } = require('../test/helpers/synthJar')
const [inPath, outPath, keepRe] = process.argv.slice(2)
const KEEP = new RegExp(keepRe)
const META = /(^|\/)(META-INF\/MANIFEST\.MF|fabric\.mod\.json|META-INF\/mods\.toml|META-INF\/neoforge\.mods\.toml|META-INF\/jarjar\/metadata\.json|META-INF\/services\/[^/]+|[^/]*mixins?[^/]*\.json|[^/]*refmap[^/]*\.json)$/
function trim (buf, depth) {
  const out = []
  for (const e of zipCentralEntries(buf)) {
    if (e.name.endsWith('.jar') && /^META-INF\/(jars|jarjar)\//.test(e.name) && depth < 3) {
      const nested = trim(zipEntryData(buf, e), depth + 1)
      if (nested.length) out.push({ name: e.name, data: buildJar(nested) })
      continue
    }
    if (META.test(e.name) || (e.name.endsWith('.class') && KEEP.test(e.name))) out.push({ name: e.name, data: zipEntryData(buf, e) })
  }
  return out
}
const entries = trim(fs.readFileSync(inPath), 0)
fs.writeFileSync(outPath, buildJar(entries))
console.log(`${outPath}: ${entries.length} top-level entries, ${fs.statSync(outPath).size} bytes`)
