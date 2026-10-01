// HF72: forked child entry for the owo-lib fingerprint scan (see
// owoHandshake.js scanOwoFingerprintsOffLoop). Runs the ONE scan and ships
// the maps back over IPC, then exits; nothing else. The parent logs the
// derived / skipped facts from the result (this child's stdio is ignored).
const { scanOwoFingerprints } = require('./owoHandshake')

process.once('message', (msg) => {
  try {
    const paths = (msg && Array.isArray(msg.paths)) ? msg.paths : []
    const fingerprints = scanOwoFingerprints(paths)
    process.send({ ok: true, fingerprints }, () => process.exit(0))
  } catch (err) {
    process.send({ ok: false, error: String((err && err.message) || err) }, () => process.exit(1))
  }
})
