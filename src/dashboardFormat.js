// Formatting helpers shared by both admin dashboards (adminServer.js on
// the base station, roverAdminServer.js on the boat) - kept in one place so
// "2m ago" and "1.4 MB" mean the same thing, formatted the same way, on
// whichever side you're looking at.

const { VERSION } = require('./version');

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

// The slot map shared by the base's Transmit slots card and the boat's Slot table card: one small square per slot of the
// correction cycle - slots held by a boat, free ones, the shared join slots and the base's own - plus a legend. mineId
// (the boat's own id, on the boat's dashboard) highlights that boat's slot.
const SLOT_MAP_CSS = `
  .slot-map { display: flex; flex-wrap: wrap; gap: 3px; margin: 10px 0 4px; }
  .slot-cell { width: 15px; height: 15px; border-radius: 3px; background: #1c222b; border: 1px solid #2d3542; box-sizing: border-box; }
  .slot-cell.used { background: #1f6feb; border-color: #388bfd; }
  .slot-cell.join { background: #4a3510; border-color: #f2b84b; }
  .slot-cell.base { background: #6e40c9; border-color: #a371f7; }
  .slot-cell.mine { background: #2ea043; border-color: #56d364; }
  .slot-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 11px; color: #8b94a3; margin-bottom: 6px; }
  .slot-legend .slot-cell { display: inline-block; width: 10px; height: 10px; vertical-align: -1px; margin-right: 4px; }`;

function slotEsc(x) {
  return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// bySlot: Map slot -> boat id. slotCount counts the join slots; the base's own slot is one more, after them.
function renderSlotMap({ slotCount, joinSlots, bySlot, mineId = null }) {
  const assignable = slotCount - joinSlots;
  const cells = [];
  for (let i = 0; i < slotCount + 1; i++) {
    if (i === slotCount) cells.push(`<span class="slot-cell base" title="Slot ${i}: the base's own frames (slot table, marks, pings)"></span>`);
    else if (i >= assignable) cells.push(`<span class="slot-cell join" title="Slot ${i}: shared by boats that have no slot of their own yet"></span>`);
    else if (bySlot.has(i) && mineId !== null && bySlot.get(i) === mineId) cells.push(`<span class="slot-cell mine" title="Slot ${i}: this boat"></span>`);
    else if (bySlot.has(i)) cells.push(`<span class="slot-cell used" title="Slot ${i}: ${slotEsc(bySlot.get(i))}"></span>`);
    else cells.push(`<span class="slot-cell" title="Slot ${i}: free"></span>`);
  }
  const legend =
    '<span><span class="slot-cell used"></span>in use</span>' +
    (mineId !== null ? '<span><span class="slot-cell mine"></span>this boat</span>' : '') +
    '<span><span class="slot-cell"></span>free</span><span><span class="slot-cell join"></span>shared</span><span><span class="slot-cell base"></span>base</span>';
  return `<div class="slot-map">${cells.join('')}</div><div class="slot-legend">${legend}</div>`;
}

// The dashboards reload themselves every 5 s, which resets any field being edited. This replaces the old
// <meta http-equiv="refresh">: a "Pause refresh" checkbox (remembered in the browser, so it stays on across pages and
// reloads) and a reload that is also skipped while a field has focus or has been changed since the page loaded.
// REFRESH_CONTROL_HTML goes in the page header, REFRESH_SCRIPT at the end of the body.
const REFRESH_CONTROL_HTML = '<label class="refresh-control" title="Stop the page reloading itself, so values you are setting do not reset. It also holds off while you are typing in a field."><input type="checkbox" id="pauseRefresh"> pause refresh</label>';
const REFRESH_SCRIPT = `
(function () {
  var KEY = 'adminRefreshPaused';
  var box = document.getElementById('pauseRefresh');
  var dirty = false;
  function stored() { try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; } }
  if (box) {
    box.checked = stored();
    box.addEventListener('change', function () {
      try { localStorage.setItem(KEY, box.checked ? '1' : '0'); } catch (e) {}
    });
  }
  function isField(el) { return el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.id !== 'pauseRefresh'; }
  document.addEventListener('input', function (e) { if (isField(e.target)) dirty = true; });
  document.addEventListener('change', function (e) { if (isField(e.target)) dirty = true; });
  setInterval(function () {
    if ((box && box.checked) || stored() || dirty || isField(document.activeElement)) return;
    location.reload();
  }, 5000);
})();`;

// The version this machine is running (version.js), as a small pill beside a page title: the commit and its date on
// hover, amber with "+ local changes" when the checkout has uncommitted edits - so a glance tells which Pi has which code.
function renderVersionBadge(v = VERSION) {
  const tip = v.commit ? `commit ${v.commit}${v.date ? `, ${v.date}` : ''}${v.dirty ? ' - with uncommitted changes' : ''}` : 'no git: package.json version';
  return `<span class="version-badge${v.dirty ? ' dirty' : ''}" title="${tip}">${v.label}${v.dirty ? ' + local changes' : ''}</span>`;
}
const VERSION_BADGE_CSS = `
  .version-badge { display: inline-block; vertical-align: middle; margin-left: 8px; padding: 1px 8px; border-radius: 999px;
    border: 1px solid #30363d; background: #161b22; color: #8b94a3; font-size: 11px; font-weight: 600;
    font-variant-numeric: tabular-nums; letter-spacing: 0.02em; cursor: default; }
  .version-badge.dirty { border-color: #9e6a03; color: #e3b341; }
`;

module.exports = { formatAgo, formatDuration, formatBytes, pct, renderDiskCard, SLOT_MAP_CSS, renderSlotMap, REFRESH_CONTROL_HTML, REFRESH_SCRIPT, renderVersionBadge, VERSION_BADGE_CSS };
