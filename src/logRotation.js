const fs = require('fs');
const path = require('path');

// Deletes files in `dir` matching `pattern` whose last-modified time is
// older than `maxAgeDays` - keeps CSV logs from accumulating forever on a
// microSD card (boat) or a laptop left running across a multi-day regatta
// (base station). Uses each file's own mtime rather than parsing a
// timestamp out of its name, so it works the same regardless of naming
// scheme.
function pruneOldLogs(dir, pattern, maxAgeDays) {
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    return; // directory doesn't exist yet - nothing to prune
  }
  for (const file of files) {
    if (!pattern.test(file)) continue;
    const filePath = path.join(dir, file);
    try {
      const stat = fs.statSync(filePath);
      if (Date.now() - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        console.log(`[logRotation] deleted old log file: ${file}`);
      }
    } catch (err) {
      console.error(`[logRotation] prune failed for ${file}:`, err.message);
    }
  }
}

module.exports = { pruneOldLogs };
