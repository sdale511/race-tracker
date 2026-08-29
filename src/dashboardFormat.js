// Formatting helpers shared by both admin dashboards (adminServer.js on
// the base station, roverAdminServer.js on the boat) - kept in one place so
// "2m ago" and "1.4 MB" mean the same thing, formatted the same way, on
// whichever side you're looking at.

// Human-readable "3m ago" / "2h 15m" style formatting - a dashboard is
// meant to be glanced at during a live race, not read as raw timestamps.
function formatAgo(ms) {
  if (ms == null) return 'never';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  // Uploaded-file totals rarely leave the KB/MB range this originally
  // covered, but a filesystem's own total/free space (see diskSpace.js)
  // routinely runs into GB - without this tier that shows as an
  // unreadable six-plus-digit MB figure instead.
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function pct(numerator, denominator) {
  if (!denominator) return '—';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

// Shared "Disk space" card for both dashboards - same thresholds, same
// colors, same layout on either side, since a full SD card is exactly as
// bad on the boat as it is on the base. `disk` is whatever diskSpace.js's
// getDiskSpace() returned (or null, if that path couldn't be statted -
// treated as unknown, not as an alert, since a missing reading isn't
// evidence of a problem, just of not knowing). `scheduleText` is a short,
// caller-supplied description of this side's own log rotation/retention
// policy (the base's daily files vs. the boat's chunked ones are described
// differently - see adminServer.js/roverAdminServer.js's own callers) -
// shown here since it's the other half of "will this disk actually fill
// up," not just the current snapshot.
function renderDiskCard(disk, scheduleText) {
  if (!disk) {
    return `<div class="card">
      <div class="label">Disk space</div>
      <div class="value">unknown</div>
      <div class="sub">couldn't read filesystem stats</div>
    </div>`;
  }
  const isAlert = disk.status === 'alert';
  return `<div class="card">
      <div class="label">Disk space</div>
      <div class="value"><span class="dot ${isAlert ? 'dot-red' : 'dot-green'}"></span>${disk.freePct.toFixed(1)}% free</div>
      <div class="sub">${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)} &middot; <strong style="color:${isAlert ? '#f85149' : '#3fb950'}">${isAlert ? 'ALERT' : 'OK'}</strong></div>
      ${scheduleText ? `<div class="sub" style="margin-top:2px;">${scheduleText}</div>` : ''}
    </div>`;
}

module.exports = { formatAgo, formatDuration, formatBytes, pct, renderDiskCard };
