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
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function pct(numerator, denominator) {
  if (!denominator) return '—';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

module.exports = { formatAgo, formatDuration, formatBytes, pct };
