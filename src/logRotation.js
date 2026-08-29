const fs = require('fs');
const path = require('path');
const { getDiskSpace } = require('./diskSpace');

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

// Emergency safety valve, distinct from pruneOldLogs' normal age-based
// retention above: LOG_RETENTION_DAYS should ordinarily keep a disk from
// ever getting critically full, but if it still does (a much longer race
// day than planned, retention set too generously, some other process
// eating the same disk), this is the last resort so a full disk doesn't
// silently break the very log writes/webhook queues this whole app
// depends on. Deletes the OLDEST files matching `pattern` in `dir` (by
// mtime, same "don't parse timestamps out of filenames" reasoning as
// pruneOldLogs above) one at a time, re-checking free space after each
// deletion, until back above `criticalFreePct` or there's nothing left to
// delete - never more than actually needed to recover.
function pruneForDiskSpace(dir, pattern, criticalFreePct) {
  const disk = getDiskSpace(dir);
  if (!disk || disk.freePct > criticalFreePct) return; // healthy, or unknown - nothing to do here

  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    return; // directory doesn't exist - nothing to prune
  }
  const candidates = files
    .filter((f) => pattern.test(f))
    .map((f) => {
      const filePath = path.join(dir, f);
      try {
        return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
      } catch (err) {
        return null; // gone by the time we got to it - fine, just skip it
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

  for (const { filePath } of candidates) {
    const current = getDiskSpace(dir);
    if (!current || current.freePct > criticalFreePct) break; // recovered - stop deleting
    try {
      fs.unlinkSync(filePath);
      console.warn(`[logRotation] disk critically low (${current.freePct.toFixed(1)}% free) - deleted oldest log file: ${path.basename(filePath)}`);
    } catch (err) {
      console.error(`[logRotation] emergency prune failed for ${path.basename(filePath)}:`, err.message);
    }
  }
}

module.exports = { pruneOldLogs, pruneForDiskSpace };
