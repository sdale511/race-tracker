const http = require('http');
const { formatAgo, formatDuration, formatBytes, pct, renderDiskCard } = require('./dashboardFormat');
const { MARK_NAMES, MARK_COLORS, markStroke, distanceMeters, bearingDeg, compassDir, getPinBoundaryFarPoint } = require('./course');
const { renderConfigPage } = require('./configReport');
const { renderConsoleLogPage } = require('./consoleLogPage');
const { zonePolygon } = require('./onGridWatcher');
const config = require('./config');
const {
  fixQualityText,
  connectionDot,
  renderBaseGpsCard,
  renderBaseGpsSurveyCard,
  renderManualFixedPositionCard,
  RTK_CLIENT_JS,
} = require('./rtkAdminCards');

// A boat is "online" if we've heard from it recently, by radio or by its
// own WiFi health check (see renderDashboard's lastActivity) - a looser
// threshold than any single TX_DISTANCE_M-driven gap, just enough to tell
// "actively out there" from "was here earlier, gone quiet."
const ONLINE_THRESHOLD_MS = 60000;

// Regatta name/venue (unlike everything else this dashboard renders) come
// from an external HTTP response (RegattaUp's getActiveRegattas), not this
// app's own GPS/radio decoding - escape before interpolating into HTML so a
// regatta name can't inject markup/script into the dashboard.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Tri-state, not the plain connected/disconnected a dot might otherwise
// show - isConnected() only reflects the TCP/auth connection, which stays
// "connected" even while Redis is up but refusing writes (out of memory
// under a noeviction policy, most likely - see README's "If Redis runs out
// of space"). writeHealth is undefined before the very first fix this
// session has ever tried to record (nothing to report yet), treated the
// same as healthy rather than as a third "unknown" state - there's no
// failure to warn about yet either way. Shared by renderDashboard's own
// subtitle dot and renderMap's topbar (under mapOnly - see its own
// comment) - the same connection, same meaning, wherever it's shown.
function redisStatusFor(s) {
  const writeHealth = s.redis && s.redis.writeHealth;
  return !s.base.redisConnected
    ? { dot: 'dot-red', text: 'disconnected' }
    : writeHealth && !writeHealth.healthy
    ? { dot: 'dot-orange', text: `connected, track writes failing (${writeHealth.failureCount} in a row - ${escapeHtml(writeHealth.lastError)})` }
    : { dot: 'dot-green', text: 'connected' };
}

// Persists the operator's regatta choice (see baseStation.js's
// selectRegatta) - no confirm(), just picking which of possibly several
// concurrent RegattaUp regattas this base station reports events against.
// Reloads so every other regatta-dependent bit of whichever page embeds
// this (the dashboard's own warning banner, or markset's map/course data)
// reflects the new selection. Shared between renderDashboard's own select
// and renderMap's compact one (under mapOnly) - same request, same
// behavior, wherever it's triggered from.
const SELECT_REGATTA_JS = `
    async function selectRegatta(select) {
      const id = select.value;
      if (!id) return;
      select.disabled = true;
      try {
        const res = await fetch('/api/regattas/selected', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        const result = await res.json();
        if (!result.ok) throw new Error(result.error || 'request failed');
        location.reload();
      } catch (err) {
        alert('Failed: ' + err.message);
        select.disabled = false;
      }
    }`;

// fixQualityText/dopQualityText/connectionDot/renderBaseGpsCard/
// renderBaseGpsSurveyCard/renderManualFixedPositionCard now live in
// rtkAdminCards.js, shared with rtkAdminServer.js's own RTK-only dashboard
// (see README's "RTK-only mode" section) - both dashboards show the exact
// same base-GPS cards against the exact same underlying receiver
// (baseGps.js), so the rendering logic has one copy, not two that could
// silently drift apart.

// Below this percent free, the card reads ALERT instead of OK - same
// ALERT_BELOW_PCT convention diskSpace.js uses for the filesystem card,
// reused here for the same reason (real lead time before it's actually
// full, not a warning that only fires once there's nothing left).
const REDIS_MEMORY_ALERT_BELOW_PCT = 10;

// Base-only (a boat has no Redis connection of its own - see
// baseStation.js's own comment on why lap/on-grid/mark-rounding detection
// lives on the base, not the rover), so this isn't in dashboardFormat.js
// alongside renderDiskCard, which both dashboards share. `memory` is
// whatever baseStation.js's getFullStats put in s.redisMemory - null if the
// query itself failed or Redis is unreachable (treated as unknown, not as
// an alert - a missing reading isn't evidence of a problem, same reasoning
// renderDiskCard uses). `writeHealth` (from s.redis.writeHealth) is shown
// here too, not just in the page's own subtitle dot, since an operator
// checking on room left is exactly the moment they'd also want to know
// whether writes are actually succeeding right now.
function renderRedisMemoryCard(memory, writeHealth, retentionHours) {
  const retentionText = `Tracks recorded continuously (not just while racing), kept ${retentionHours}h, then expire automatically - "npm run clear-boats" clears sooner`;
  if (!memory) {
    return `<div class="card">
      <div class="label">Redis memory</div>
      <div class="value">unknown</div>
      <div class="sub">couldn't read memory stats</div>
    </div>`;
  }
  const { usedBytes, maxmemoryBytes } = memory;
  const writeFailing = writeHealth && !writeHealth.healthy;
  const writeSub = writeFailing
    ? `<div class="sub" style="margin-top:2px;"><strong style="color:#f2b84b;">Track writes failing</strong> (${writeHealth.failureCount} in a row)</div>`
    : '';
  if (!maxmemoryBytes) {
    return `<div class="card">
      <div class="label">Redis memory</div>
      <div class="value">${formatBytes(usedBytes)} used</div>
      <div class="sub">limit unknown - set REDIS_MEMORY_LIMIT_MB to see % used</div>
      <div class="sub" style="margin-top:2px;">${retentionText}</div>
      ${writeSub}
    </div>`;
  }
  const usedPct = (usedBytes / maxmemoryBytes) * 100;
  const freePct = 100 - usedPct;
  const isAlert = freePct < REDIS_MEMORY_ALERT_BELOW_PCT;
  return `<div class="card">
      <div class="label">Redis memory</div>
      <div class="value"><span class="dot ${isAlert ? 'dot-red' : 'dot-green'}"></span>${freePct.toFixed(1)}% free</div>
      <div class="sub">${formatBytes(usedBytes)} used of ${formatBytes(maxmemoryBytes)} &middot; <strong style="color:${isAlert ? '#f85149' : '#3fb950'}">${isAlert ? 'ALERT' : 'OK'}</strong></div>
      <div class="sub" style="margin-top:2px;">${retentionText}</div>
      ${writeSub}
    </div>`;
}

// Renders the whole dashboard server-side from one stats snapshot (see
// baseStation.js's getFullStats) - simpler than shipping a client-side
// templating setup for what's fundamentally a page that reloads its data
// every few seconds anyway.
// rtkControlsEnabled mirrors baseStation.js's own flag (see its comment) -
// true only under `npm run basertk`, gating the two TMODE3/survey-in
// control cards (renderBaseGpsSurveyCard/renderManualFixedPositionCard) and
// the RTK_CLIENT_JS driving their buttons. Plain `npm run base` still shows
// renderBaseGpsCard (the ordinary fix, for the map's "plant a mark at my
// real position" feature) regardless - only the RTK-reconfiguring controls
// are gated.
function renderDashboard(s, rtkControlsEnabled) {
  // Active fleet at the top, so it naturally floats above however boat IDs
  // happen to be numbered. "Active" is the more recent of lastSeen (an
  // actual radio position frame) and pendingReportedAt (the boat's own
  // periodic WiFi health check, see uploadServer.js's recordPending) - not
  // lastSeen alone, since a stationary boat only ever clears
  // TX_DISTANCE_M's movement gate once (see config.js) and then
  // legitimately has nothing new to radio back for as long as it doesn't
  // move, even though it's still very much alive and phoning home over
  // WiFi every UPLOAD_CHECK_INTERVAL_MS.
  //
  // Sorted into three tiers (online / seen-but-not-online / never seen)
  // rather than by exact recency, with boat ID as the tie-break *within*
  // each tier - deliberately coarse. This page reloads every 5s, and a
  // fleet of boats pinging in every ~15s over WiFi alone would otherwise
  // have rows constantly swapping places from sub-threshold timing noise
  // (boat A at 3s vs boat B at 4s flipping to 9s vs 8s a moment later) -
  // noise an operator glancing at a live table shouldn't have to parse.
  // Same ONLINE_THRESHOLD_MS boundary as the per-row dot below, so a
  // boat's tier and its dot color always agree.
  const lastActivity = (b) => Math.max(b.lastSeen || 0, b.pendingReportedAt || 0) || null;
  const activityTier = (b) => {
    const activity = lastActivity(b);
    if (activity == null) return 2; // never seen
    return Date.now() - activity < ONLINE_THRESHOLD_MS ? 0 : 1; // online / stale
  };
  const boatIds = Object.keys(s.boats).sort((a, b) => {
    const tierDiff = activityTier(s.boats[a]) - activityTier(s.boats[b]);
    if (tierDiff !== 0) return tierDiff;
    // Plain string comparison, not Number(a) - Number(b) - BOAT_ID is a
    // fixed-width alphanumeric string now (see boatIdFile.js), not
    // guaranteed numeric, and Number() on a letters-containing id is NaN.
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const totalPending = boatIds.reduce((sum, id) => sum + (s.boats[id].pending || 0), 0);

  const redisStatus = redisStatusFor(s);

  const boatRows = boatIds
    .map((id) => {
      const b = s.boats[id];
      // Same combined signal as the sort above - a stationary boat still
      // phoning home over WiFi shouldn't show as offline just because it
      // has nothing new to say over radio.
      const activity = lastActivity(b);
      const online = activity && Date.now() - activity < ONLINE_THRESHOLD_MS;
      // Flags when WiFi (not radio) is what's actually current, so "Last
      // seen: just now" on a boat that hasn't moved in 20 minutes reads as
      // expected instead of surprising - see the sort comment above for why
      // that's normal for a stationary boat.
      const viaWifi = b.pendingReportedAt != null && (b.lastSeen == null || b.pendingReportedAt > b.lastSeen);
      // Radio only, unlike "Last seen" above (which also counts the WiFi
      // health-check ping - see viaWifi) - a boat whose radio link is down
      // but whose WiFi still reaches the base looks deceptively "recent"
      // in that combined column; this one can't be fooled that way, since
      // it's exactly b.lastSeen with nothing else mixed in.
      const lastSeenRadio = b.lastSeen != null ? formatAgo(b.lastSeen) : '<span class="muted">—</span>';
      const tracks = (s.redis && s.redis.tracksByBoat && s.redis.tracksByBoat[id]) || 0;
      const laps = s.lapCounts[id] || 0;
      // The boat's own rover dashboard (see roverAdminServer.js) - IP and
      // admin port are both learned passively/self-reported from its
      // upload/health-check requests (see stats.recordBoatIp /
      // recordBoatAdminPort), so this only appears once it's made at least
      // one. Uses the boat's own reported port rather than assuming it
      // matches this base's - a boat running SIMULATE=1 on the same
      // machine as the base defaults to a different one specifically to
      // avoid a port conflict (see boatAgent.js's myAdminPort).
      const statsLink =
        b.ip && b.adminPort
          ? `<a href="http://${b.ip}:${b.adminPort}/" target="_blank" rel="noopener">stats ↗</a>`
          : '<span class="muted">—</span>';
      // filesOnDisk/lastUploadOnDisk come from a one-time startup scan of
      // race-uploads (see baseStation.js's uploadDirBaseline) - this is the
      // boat's real all-time uploaded history, distinct from the
      // this-session-only counters in the "Uploads" column, so a boat with
      // no activity yet this session can still show it has uploaded
      // before.
      const diskHistory =
        b.filesOnDisk != null
          ? `${b.filesOnDisk} <span class="muted">(last ${formatAgo(b.lastUploadOnDisk)})</span>`
          : '<span class="muted">—</span>';
      // The actual radio-frame arrival rate at THIS base, not the boat's own
      // onboard GPS_HZ - see stats.js's fixHz for why those normally
      // differ (TX_DISTANCE_M gates what's ever transmitted). '—' both
      // before any frame has arrived and for a stationary boat that
      // legitimately has nothing new to send right now.
      const fixRate = b.fixHz != null ? `${b.fixHz.toFixed(1)} Hz` : '<span class="muted">—</span>';
      // b.lastFix is {carrSoln, gnssFixOk, numSV} off the last decoded
      // frame (see stats.js's recordFrame) - null until the first frame
      // arrives. No fixType here (RTK-fixed/float vs. plain 3D/2D) - that
      // field never crosses the wire at all (see protocol.js's decode),
      // so this is coarser than boatAgent.js's own [status] line, but
      // still the actual RTK state, which is what matters for a fleet
      // overview. Same color convention as the online dot above (green =
      // good, orange = degraded-but-useful, red = not fixed at all).
      const fixDotClass = !b.lastFix
        ? 'dot-gray'
        : b.lastFix.carrSoln === 2
        ? 'dot-green'
        : b.lastFix.carrSoln === 1
        ? 'dot-orange'
        : b.lastFix.gnssFixOk
        ? 'dot-orange'
        : 'dot-red';
      const fixCell = b.lastFix
        ? `<span class="dot ${fixDotClass}"></span>${fixQualityText(b.lastFix)} <span class="muted">(${b.lastFix.numSV} sv)</span>`
        : '<span class="muted">—</span>';
      return `
        <tr>
          <td><span class="dot ${online ? 'dot-green' : 'dot-gray'}"></span>boat ${id}</td>
          <td>${formatAgo(activity)}${viaWifi ? ' <span class="muted">(WiFi)</span>' : ''}</td>
          <td>${lastSeenRadio}</td>
          <td>${fixRate}</td>
          <td>${fixCell}</td>
          <td>${tracks.toLocaleString()}</td>
          <td>${laps}</td>
          <td>${b.upload.successes} / ${b.upload.attempts} <span class="muted">(${pct(b.upload.successes, b.upload.attempts)})</span></td>
          <td>${b.pending ?? '—'}</td>
          <td>${diskHistory}</td>
          <td>${statsLink}</td>
        </tr>`;
    })
    .join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>race-tracker admin</title>
<meta http-equiv="refresh" content="5">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    background: #0f1216;
    color: #e6e9ef;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .subtitle { color: #8b94a3; font-size: 13px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-bottom: 24px; }
  .card {
    background: #161b22;
    border: 1px solid #262c36;
    border-radius: 10px;
    padding: 16px 18px;
  }
  .card .label { color: #8b94a3; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
  .card .value { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .card .sub { color: #8b94a3; font-size: 12px; margin-top: 4px; }
  .marks-card { grid-column: span 2; }
  .marks-mini { display: flex; flex-direction: column; gap: 5px; margin-top: 2px; }
  .marks-mini .mark-row { display: flex; align-items: baseline; gap: 6px; font-size: 12px; }
  .marks-mini .mark-row .name { flex-shrink: 0; }
  .marks-mini .mark-row .coords { color: #8b94a3; font-variant-numeric: tabular-nums; margin-left: auto; white-space: nowrap; }
  .stat-rows { display: flex; flex-direction: column; gap: 5px; margin-top: 6px; }
  .stat-row { display: flex; align-items: baseline; gap: 10px; font-size: 12px; }
  .stat-row .name { flex-shrink: 0; color: #8b94a3; }
  .stat-row .val { color: #e6e9ef; font-variant-numeric: tabular-nums; margin-left: auto; text-align: right; }
  section { margin-bottom: 28px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.04em; color: #8b94a3; margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #262c36; border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 14px; font-size: 13px; font-variant-numeric: tabular-nums; }
  /* Fixed width on "Last seen" - its text length varies a lot ("just now"
     vs "21m ago (WiFi)" vs "23h 59m ago") as time passes between the
     page's own 5s refreshes; without this the whole table visibly
     reflows every refresh even when no row actually changed. */
  th:nth-child(2), td:nth-child(2) { min-width: 150px; }
  th { color: #8b94a3; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid #262c36; }
  tr:not(:last-child) td { border-bottom: 1px solid #1c222b; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; flex-shrink: 0; }
  .dot-green { background: #3fb950; box-shadow: 0 0 6px #3fb95080; }
  .dot-gray { background: #4b535e; }
  .dot-red { background: #f85149; box-shadow: 0 0 6px #f8514980; }
  .dot-orange { background: #f2b84b; box-shadow: 0 0 6px #f2b84b80; }
  .muted { color: #8b94a3; }
  .empty { color: #8b94a3; padding: 20px; text-align: center; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .card-actions { display: flex; gap: 6px; margin-top: 10px; }
  .card-btn {
    flex: 1; padding: 6px 8px; border-radius: 6px; border: 1px solid #262c36;
    background: #1c222b; color: #e6e9ef; font-size: 11px; cursor: pointer;
  }
  .card-btn:hover { background: #262c36; }
  .card-btn:disabled { opacity: 0.5; cursor: default; }
  .manual-fixed-card { grid-column: span 2; }
  .manual-fixed-field { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
  .manual-fixed-field label { flex-shrink: 0; width: 70px; font-size: 11px; color: #8b94a3; }
  .manual-input {
    flex: 1; min-width: 0; padding: 7px 10px; border-radius: 6px; border: 1px solid #262c36;
    background: #0f1216; color: #e6e9ef; font-size: 13px; font-variant-numeric: tabular-nums;
  }
  .manual-input::placeholder { color: #5a6270; }
  .regatta-card { grid-column: span 2; }
  .regatta-select {
    width: 100%; margin-top: 10px; padding: 7px 10px; border-radius: 6px; border: 1px solid #262c36;
    background: #0f1216; color: #e6e9ef; font-size: 13px;
  }
  .regatta-warning {
    margin-top: 10px; padding: 8px 10px; border-radius: 6px; font-size: 12px;
    background: #3a2a0f; border: 1px solid #6b4a12; color: #f2b84b;
  }
</style>
</head>
<body>
  <h1>race-tracker admin</h1>
  <div class="subtitle">
    <span class="dot ${redisStatus.dot}"></span>Redis ${redisStatus.text}
    &nbsp;·&nbsp; uptime ${formatDuration(s.uptimeMs)}
    &nbsp;·&nbsp; upload address ${s.base.ip ? `${s.base.ip}:${s.base.uploadPort}` : 'unknown'}
    &nbsp;·&nbsp; refreshes every 5s
    &nbsp;·&nbsp; <a href="/config">config</a>
    &nbsp;·&nbsp; <a href="/console">console</a>
    ${s.course ? '&nbsp;·&nbsp; <a href="/map">map ↗</a>' : ''}
  </div>

  <div class="grid">
    <div class="card">
      <div class="label">Boats seen</div>
      <div class="value">${boatIds.length}</div>
    </div>
    <div class="card">
      <div class="label">Total tracks</div>
      <div class="value">${s.redis ? s.redis.totalTracks.toLocaleString() : '—'}</div>
      <div class="sub">recorded fixes, all boats</div>
    </div>
    <div class="card">
      <div class="label">Uploads</div>
      <div class="value">${s.upload.successes.toLocaleString()}</div>
      <div class="stat-rows">
        <div class="stat-row"><span class="name">Files</span><span class="val">${s.upload.successes.toLocaleString()} (${formatBytes(s.upload.bytesTotal)})</span></div>
        <div class="stat-row"><span class="name">Attempts</span><span class="val">${s.upload.attempts.toLocaleString()} (${pct(s.upload.successes, s.upload.attempts)})</span></div>
        <div class="stat-row"><span class="name">Pending</span><span class="val">${totalPending} <span class="muted">(self-reported)</span></span></div>
        <div class="stat-row"><span class="name">Failures</span><span class="val">${s.upload.failures.toLocaleString()}</span></div>
      </div>
    </div>
    <div class="card">
      <div class="label">Radio frames</div>
      <div class="value">${s.radio.framesReceived.toLocaleString()}</div>
      <div class="stat-rows">
        ${connectionDot(s.radio.connected) ? `<div class="stat-row"><span class="name">Status</span><span class="val">${connectionDot(s.radio.connected)}</span></div>` : ''}
        <div class="stat-row"><span class="name">Sync errors</span><span class="val">${s.radio.syncErrors.toLocaleString()} (${pct(s.radio.syncErrors, s.radio.framesReceived + s.radio.syncErrors)})</span></div>
        <div class="stat-row"><span class="name">Port</span><span class="val">${s.radio.port ? `${s.radio.port}${s.radio.baud ? ` @ ${s.radio.baud}` : ''}` : 'no radio (RADIO_ENABLED=0)'}</span></div>
      </div>
    </div>
    ${
      s.course
        ? `<div class="card marks-card">
      <div class="label">Course marks</div>
      <div class="marks-mini">
        ${MARK_NAMES.map((name) => {
          const m = s.course.marks[name];
          return `<div class="mark-row"><span class="dot" style="background:${MARK_COLORS[name]}; box-shadow: inset 0 0 0 1.5px ${markStroke(name)}"></span><span class="name">${name}</span><span class="coords">${m.lat.toFixed(4)}, ${m.lon.toFixed(4)}</span></div>`;
        }).join('')}
        <div class="mark-row"><span class="dot" style="background:${MARK_COLORS.pinBoundary}"></span><span class="name">pin boundary gate</span><span class="coords">${s.course.marks.pinBoundaryEnabled ? 'ON' : 'off'}</span></div>
      </div>
    </div>`
        : ''
    }
    <div class="card">
      <div class="label">RegattaUp webhook</div>
      <div class="value">${s.webhook.enabled ? 'on' : 'off'}</div>
      <div class="sub">${s.webhook.queueReady ? 'queue ready' : 'queue initializing'}</div>
    </div>
    <div class="card regatta-card">
      <div class="label">Regatta</div>
      ${
        s.regatta.selected
          ? `<div class="sub">Reporting for <strong>${escapeHtml(s.regatta.selected.name)}</strong> - ${escapeHtml(s.regatta.selected.venue)} (through ${escapeHtml(s.regatta.selected.end_date)})</div>`
          : `<div class="regatta-warning">No regatta selected - pick one below before racing, so laps/on-grid/mark events report against the right event.${
              s.radio.mode === 'real' ? ' The radio connection is paused until then.' : ''
            }</div>`
      }
      <select class="regatta-select" id="regatta-select" onchange="selectRegatta(this)">
        <option value="" ${!s.regatta.selected ? 'selected' : ''}>Select a regatta&hellip;</option>
        ${s.regatta.regattas
          .map(
            (r) =>
              `<option value="${escapeHtml(r.id)}" ${s.regatta.selected && s.regatta.selected.id === r.id ? 'selected' : ''}>${escapeHtml(r.name)} - ${escapeHtml(r.venue)} (${escapeHtml(r.start_date)} to ${escapeHtml(r.end_date)})</option>`
          )
          .join('')}
      </select>
    </div>
    <div class="card">
      <div class="label">Ping fleet</div>
      <div class="sub">Asks every boat to report its current position now, even a stationary one that's already sent its one and only frame (e.g. sitting on the line since before this dashboard was up). Replies trickle in over the next few seconds.</div>
      <button type="button" class="card-btn" onclick="pingFleet(this)">Ping fleet</button>
    </div>
    ${renderBaseGpsCard(s.baseGpsFix, s.baseGpsPort, s.baseGpsConnected)}
    ${rtkControlsEnabled ? renderBaseGpsSurveyCard(s.baseGpsSurvey, s.baseGpsFix) : ''}
    ${rtkControlsEnabled ? renderManualFixedPositionCard(s.baseGpsSurvey, s.baseGpsFix) : ''}
    ${renderDiskCard(s.disk, `New log file daily, kept ${config.logRetentionDays} days`)}
    ${renderRedisMemoryCard(s.redisMemory, s.redis && s.redis.writeHealth, config.redis.trackRetentionHours)}
  </div>

  <section>
    <h2>Fleet</h2>
    ${
      boatIds.length === 0
        ? '<div class="card empty">No boats heard from yet.</div>'
        : `<table>
      <thead>
        <tr>
          <th title="Green dot = heard from (radio or WiFi) within the last minute">Boat</th>
          <th title="Most recent activity from either the radio link or the WiFi health-check ping, whichever is more recent - marked (WiFi) when that ping is the only reason this looks current">Last seen</th>
          <th title="Most recent actual position frame received over radio specifically - unlike &quot;Last seen&quot;, not satisfied by the WiFi health-check ping alone, so a boat with a dead radio link but working WiFi shows stale here even while Last seen looks current">Last seen (radio)</th>
          <th title="How often radio frames are actually arriving at THIS base right now - not the boat's own onboard GPS rate, since TX_DISTANCE_M gates what's ever transmitted, and a stationary boat legitimately reads near zero">Fix rate</th>
          <th title="GPS/RTK fix quality from the last radio frame received: RTK fixed (cm-level) > RTK float (dm-level) > GPS (no RTK correction) > No fix. Satellite count in parentheses">Fix</th>
          <th title="Number of position points stored in Redis for this boat this session">Tracks</th>
          <th title="Completed lap count for this boat this race">Laps</th>
          <th title="Successful vs. attempted SD-card log uploads since this base station started">Uploads this session</th>
          <th title="Log files this boat says are still waiting to upload, self-reported on its own last health-check ping">Pending</th>
          <th title="Total files ever received from this boat, from a one-time scan of race-uploads at startup - includes previous sessions, not just this one">Files on disk (all-time)</th>
          <th title="Link to this boat's own admin dashboard - appears once it has self-reported its IP/port via a health check">Rover dashboard</th>
        </tr>
      </thead>
      <tbody>${boatRows}</tbody>
    </table>`
    }
  </section>
  <script>
    // saveGpsConfigOrThrow/setTmode3Mode/setManualFixedPosition (talking to
    // baseStation.js's baseGps.setSurveyIn/setFixed/saveConfig via the
    // /api/gps/... routes) now live in rtkAdminCards.js's RTK_CLIENT_JS,
    // shared with rtkAdminServer.js's own RTK-only dashboard - see that
    // module's own comment. No optimistic UI update in either: each page's
    // own 5s meta-refresh picks up the new mode on its own once the
    // receiver's actually responded to the poll the server sends right
    // after the SET - reloading immediately would still show the OLD mode,
    // since that poll response hasn't arrived yet. Only included when the
    // survey/manual-fixed cards actually exist to click (rtkControlsEnabled -
    // npm run basertk) - on plain base there'd be nothing to wire these
    // functions to.
    ${rtkControlsEnabled ? RTK_CLIENT_JS : ''}
    ${SELECT_REGATTA_JS}

    // Broadcasts a ping (see baseStation.js's pingFleet) - no confirm()
    // needed, unlike setTmode3Mode above: this has no destructive
    // side effect, it just asks boats to report in. Replies arrive as
    // ordinary frames over the next few seconds (each boat's own random
    // delay - see config.js's pingResponseJitterMs) and show up in the
    // Fleet table on this page's own next 5s refresh, so there's nothing
    // for this handler itself to wait on or reflect - just fire the
    // request and briefly confirm it went out.
    async function pingFleet(btn) {
      btn.disabled = true;
      try {
        const res = await fetch('/api/ping-fleet', { method: 'POST' });
        const result = await res.json();
        if (!result.ok) throw new Error(result.error || 'request failed');
        btn.textContent = 'Pinged - waiting for replies...';
        setTimeout(() => {
          btn.textContent = 'Ping fleet';
          btn.disabled = false;
        }, 4000);
      } catch (err) {
        alert('Failed: ' + err.message);
        btn.disabled = false;
      }
    }

    // Manual-entry counterpart to setTmode3Mode('fixed', ...) above - an
    // operator-typed position (e.g. a club's own previously-surveyed
    // benchmark) instead of whatever this app's own survey-in/live-fix
    // would otherwise supply. Validated here (range checks) AND again
    // server-side (see baseStation.js's setBaseGpsFixed) - this is just for
    // a fast, clear error before ever sending a request; the server-side
    // check is the one that actually matters. The confirm() spells out the
    // exact numbers about to be sent, not just "are you sure", so a typo
    // (wrong sign, transposed digits) is visible one last time before it
    // reconfigures RTK corrections for every boat. andSave mirrors
    // setTmode3Mode's own flag - see saveGpsConfigOrThrow above.
    async function setManualFixedPosition(btn, andSave) {
      const lat = parseFloat(document.getElementById('manualLat').value);
      const lon = parseFloat(document.getElementById('manualLon').value);
      const heightM = parseFloat(document.getElementById('manualHeight').value);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) return alert('Lat must be a number between -90 and 90.');
      if (!Number.isFinite(lon) || lon < -180 || lon > 180) return alert('Lon must be a number between -180 and 180.');
      if (!Number.isFinite(heightM)) return alert('Height must be a number (meters).');
      const saveNote = andSave ? ' and save it so it survives a reboot' : '';
      const confirmMsg =
        'Set the base GPS fixed position to exactly ' + lat.toFixed(7) + ', ' + lon.toFixed(7) + ' (' + heightM.toFixed(2) + 'm)' + saveNote + '?\\n\\n' +
        'This affects RTK corrections for every boat - double-check these numbers against your known position before continuing.';
      if (!confirm(confirmMsg)) return;
      btn.disabled = true;
      try {
        const res = await fetch('/api/gps/survey/mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'fixed', lat, lon, heightM }),
        });
        const result = await res.json();
        if (!result.ok) throw new Error(result.error || 'request failed');
        if (andSave) await saveGpsConfigOrThrow();
        setTimeout(() => location.reload(), 800);
      } catch (err) {
        alert('Failed: ' + err.message);
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>`;
}

// A full-page map view of the course (see "Course marks" section of
// renderDashboard above, which links here) - Leaflet + OpenStreetMap/CARTO
// tiles loaded from their public CDNs, so this needs the viewing browser to
// have internet access (the base station's own connectivity to publish
// marks/tracks does not matter here - this is rendered in whoever's
// looking at the dashboard). No live boat positions, just the course marks
// and the start/finish lines between them - this is a course reference
// view, not a live tracking map.
// Floating card in the map page's top-left corner, showing the start/finish
// lines' own lengths and bearings plus a compass heading from committeeStart
// to each windward/leeward mark - the numbers a race committee actually
// calls out on the water, not just raw mark coordinates (see the "Course
// marks" card on the dashboard page for that). Windward/leeward bearings
// are measured FROM committeeStart specifically (the usual start-line
// committee boat), matching how an operator standing there would actually
// read them - not from the boat's own live position, which would make
// every reading shift as the boat moves.
// Each row carries a data-marks attribute (one mark name, or two comma-
// separated) so the map page's own script (see renderMap's client-side
// script below) can zoom to it on click - one name zooms straight to that
// mark, two fits both into view (a line, not a single point). Built here
// rather than guessed client-side from the label text, so the click target
// can never drift out of sync with what the row is actually showing.
// Distance text is deliberately NOT baked in here as a fixed string -
// each row instead carries the raw distance in meters (data-dist-m) plus
// which unit pair it should ever be shown in (data-dist-kind: "small" =
// meters/feet, for the two line lengths, which stay short regardless of
// course size; "large" = km/mi, for mark distances, which don't). The
// client-side unit toggle (see renderMap's own <script>) is what actually
// writes the visible text, from these attributes - one formatting
// implementation, not a server copy that could drift from the client one.
// Server-rendered text below is just the metric default, so the card still
// looks right for the instant before that script runs.
function buildCourseInfoHtml(marks) {
  const startLineM = distanceMeters(marks.pin, marks.committeeStart);
  const startLineBearing = bearingDeg(marks.committeeStart, marks.pin);
  const finishLineM = distanceMeters(marks.committeeFinish, marks.finish);
  const finishLineBearing = bearingDeg(marks.committeeFinish, marks.finish);
  const bearingText = (bearing) => `${Math.round(bearing)}&deg; ${compassDir(bearing)}`;
  // Distance/bearing from committeeStart - the same start-line reference
  // point the "Start line" row above already measures from, so this reads
  // as "how far/which way from the line" for every mark, not a second,
  // differently-anchored set of numbers to reconcile against the first.
  const headingRows = ['windwardBlack', 'windwardGreen', 'leewardGreen', 'leewardBlack']
    .map((name) => {
      const label = name[0].toUpperCase() + name.slice(1);
      const distM = distanceMeters(marks.committeeStart, marks[name]);
      const bearing = bearingDeg(marks.committeeStart, marks[name]);
      return `<div class="course-info-row zoomable" data-marks="${name}" data-dist-m="${distM}" data-dist-kind="large" data-bearing="${bearingText(bearing)}"><span class="label">${label}</span><span class="value">${(distM / 1000).toFixed(2)} km &middot; ${bearingText(bearing)}</span></div>`;
    })
    .join('');
  // Only shown when the operator's pin boundary gate checkbox is actually
  // on. Zooms to pin alone (not a fitBounds spanning the gate's own far
  // endpoint, kilometers out by design - see getPinBoundaryFarPoint) since
  // that would zoom the map absurdly far out just to fit one dashed line's
  // own distant end.
  const pinBoundaryRow = marks.pinBoundaryEnabled
    ? '<div class="course-info-row zoomable" data-marks="pin"><span class="label">Pin boundary gate</span><span class="value">ON &middot; extends past pin</span></div>'
    : '';
  return `<div class="course-info-card">
    <div class="course-info-title-row">
      <span class="course-info-title">Course</span>
      <label class="unit-toggle-label" title="Start/finish always show meters/feet - this only switches the mark-distance rows below between km and mi">
        <input type="checkbox" id="unitToggle"> mi/ft
      </label>
    </div>
    <div class="course-info-row zoomable" data-marks="pin,committeeStart" data-dist-m="${startLineM}" data-dist-kind="small" data-bearing="${bearingText(startLineBearing)}"><span class="label">Start line</span><span class="value">${Math.round(startLineM)} m &middot; ${bearingText(startLineBearing)}</span></div>
    <div class="course-info-row zoomable" data-marks="committeeFinish,finish" data-dist-m="${finishLineM}" data-dist-kind="small" data-bearing="${bearingText(finishLineBearing)}"><span class="label">Finish line</span><span class="value">${Math.round(finishLineM)} m &middot; ${bearingText(finishLineBearing)}</span></div>
    ${pinBoundaryRow}
    ${headingRows}
  </div>`;
}

// mapOnly (see baseStation.js's marksetMode/adminServer.js's own
// startAdminServer param) hides every "back to dashboard" link - under
// `npm run markset` there IS no separate dashboard page at all (`/` and
// `/map` are aliases of this exact page), so a link back to itself would
// just be confusing, not merely redundant.
function renderMap(s, { mapOnly } = {}) {
  const backToDashboardLink = mapOnly ? '' : '<a href="/">&larr; back to dashboard</a>';
  // Under mapOnly (markset - see baseStation.js's marksetMode) this page IS
  // the only UI, with no dashboard reachable at all to show the Regatta
  // card or the Redis status dot that would normally live there - both are
  // shown compactly here instead, in the topbar, since marks are useless
  // without the right regatta selected and Redis is the actual store
  // setMark writes to. Plain base/basertk skip this entirely - they still
  // have the real Regatta/Redis cards one click away on the dashboard, so
  // duplicating a second, smaller copy of them here would just be clutter.
  // Computed before the early "no course yet" return below too, since a
  // freshly-started markset with no regatta selected yet is exactly the
  // moment this control is most needed - that's the one state with
  // nothing else on the page to reach it from otherwise.
  const redisStatus = redisStatusFor(s);
  const regattaControlsHtml = mapOnly
    ? `<span style="display:inline-flex;align-items:center;gap:6px;margin-left:16px;font-size:12px;color:#8b94a3;white-space:nowrap;">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${
          redisStatus.dot === 'dot-green' ? '#3fb950' : redisStatus.dot === 'dot-orange' ? '#e3b341' : '#f85149'
        };" title="${escapeHtml(redisStatus.text)}"></span>Redis ${escapeHtml(redisStatus.text)}
      </span>
      <select
        onchange="selectRegatta(this)"
        style="margin-left:10px;background:#161b22;color:#e6e9ef;border:1px solid #262c36;border-radius:6px;padding:4px 8px;font-size:12px;max-width:240px;"
        title="${s.regatta.selected ? 'Reporting for ' + escapeHtml(s.regatta.selected.name) : 'No regatta selected - marks/course have nowhere to be stored until one is picked'}"
      >
        <option value="" ${!s.regatta.selected ? 'selected' : ''}>Select a regatta&hellip;</option>
        ${s.regatta.regattas
          .map(
            (r) =>
              `<option value="${escapeHtml(r.id)}" ${s.regatta.selected && s.regatta.selected.id === r.id ? 'selected' : ''}>${escapeHtml(r.name)} - ${escapeHtml(r.venue)}</option>`
          )
          .join('')}
      </select>`
    : '';
  if (!s.course) {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>race-tracker course map</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
    background: #0f1216; color: #8b94a3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  a { color: #58a6ff; text-decoration: none; margin-left: 8px; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <div>No course marks published yet.${backToDashboardLink}</div>
  ${regattaControlsHtml ? `<div>${regattaControlsHtml}</div>` : ''}
  <script>${mapOnly ? SELECT_REGATTA_JS : ''}</script>
</body>
</html>`;
  }

  const marks = s.course.marks;
  const markersJs = MARK_NAMES.map(
    (name) =>
      `L.circleMarker([${marks[name].lat}, ${marks[name].lon}], { radius: 8, color: '${markStroke(name)}', weight: 2, fillColor: '${MARK_COLORS[name]}', fillOpacity: 0.85 })
        .addTo(map)
        .bindTooltip('${name}', { permanent: true, direction: 'top', offset: [0, -8], className: 'mark-label' });`
  ).join('\n    ');

  // Only boats stats.js actually has an in-memory position for this
  // session (see stats.recordFrame) - deliberately NOT the on-disk
  // upload history (uploadDirBaseline/filesOnDisk in baseStation.js's
  // getFullStats), which can be hours or days stale. A boat that's only
  // ever shown up via a prior upload, never heard live this session,
  // just doesn't get a dot.
  const boatIds = Object.keys(s.boats).filter((id) => s.boats[id].lastPosition);
  const boatMarkersJs = boatIds
    .map((id) => {
      const b = s.boats[id];
      const online = b.lastSeen && Date.now() - b.lastSeen < ONLINE_THRESHOLD_MS;
      return `boatMarkers['${id}'] = L.circleMarker([${b.lastPosition.lat}, ${b.lastPosition.lon}], { radius: 7, color: '#ffffff', weight: 2, fillColor: '${online ? '#3fb950' : '#8b94a3'}', fillOpacity: 0.9 })
      .addTo(map)
      .bindTooltip('boat ${id}', { permanent: true, direction: 'bottom', offset: [0, 8], className: 'mark-label' });`;
    })
    .join('\n    ');

  const markBoundsPoints = MARK_NAMES.map((name) => `[${marks[name].lat}, ${marks[name].lon}]`);
  const markBoundsJs = `[${markBoundsPoints.join(', ')}]`;
  const boundsPoints = [
    ...markBoundsPoints,
    ...boatIds.map((id) => `[${s.boats[id].lastPosition.lat}, ${s.boats[id].lastPosition.lon}]`),
  ];
  const boundsJs = `[${boundsPoints.join(', ')}]`;

  // One row per settable mark in the "edit marks" column (see the
  // .edit-column below) - each button sets that mark to wherever the
  // fixed center crosshair currently points, read from map.getCenter()
  // at click time (see setEditMode/set-mark-btn handler below), not
  // anything server-rendered here.
  const markSetRowsHtml = MARK_NAMES.map(
    (name) =>
      `<div class="mark-set-row">
        <span class="dot" style="background:${MARK_COLORS[name]}; box-shadow: inset 0 0 0 1.5px ${markStroke(name)}"></span>
        <span class="name">${name}</span>
        <button type="button" class="set-mark-btn" data-mark="${name}">Set</button>
      </div>`
  ).join('');

  // "This rover represents..." (see README's "Mark mode") - a device
  // physically attached to one course mark, auto-posting that mark's
  // position to Redis as it moves (baseStation.js's onFix, gated on
  // config.markDistanceM) instead of an operator manually walking between
  // marks and clicking "Set" below. Only shown under mapOnly (markset/mark
  // - see renderMap's own comment on why the Redis/regatta topbar controls
  // are scoped the same way) - plain base/basertk's /map stays exactly as
  // it is today, fleet-oriented, not this workflow.
  const markAssignmentHtml = mapOnly
    ? `<div class="mark-assignment">
        <label for="markAssignSelect" style="display:block;font-size:11px;color:#8b94a3;margin-bottom:4px;">This rover represents</label>
        <select id="markAssignSelect" onchange="assignMark(this)" data-current="${s.markAssignment || ''}" style="width:100%;background:#0f1216;color:#e6e9ef;border:1px solid #262c36;border-radius:6px;padding:7px 10px;font-size:13px;">
          <option value="" ${!s.markAssignment ? 'selected' : ''}>Not assigned - edit marks manually below</option>
          ${MARK_NAMES.map((name) => `<option value="${name}" ${s.markAssignment === name ? 'selected' : ''}>${name}</option>`).join('')}
        </select>
        ${
          s.markAssignment
            ? `<div class="muted" style="font-size:11px;margin-top:6px;">Auto-posts to Redis whenever this rover's own GPS moves &ge;${config.markDistanceM}m from the last position it posted.${
                marks[s.markAssignment]
                  ? ` Currently stored: ${marks[s.markAssignment].lat.toFixed(6)}, ${marks[s.markAssignment].lon.toFixed(6)}.`
                  : ''
              }</div>`
            : ''
        }
      </div>`
    : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>race-tracker course map</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">
<style>
  html, body { height: 100%; margin: 0; background: #0f1216; }
  .topbar {
    position: absolute; top: 0; left: 0; right: 0; z-index: 1000;
    display: flex; align-items: center; gap: 14px;
    padding: 10px 16px;
    background: #161b22ee;
    border-bottom: 1px solid #262c36;
    color: #e6e9ef;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 13px;
  }
  .topbar h1 { font-size: 15px; margin: 0; font-weight: 600; }
  .topbar a { color: #58a6ff; text-decoration: none; }
  .topbar a:hover { text-decoration: underline; }
  .topbar .spacer { flex: 1; }
  .refresh-toggle { display: flex; align-items: center; gap: 6px; color: #8b94a3; cursor: pointer; user-select: none; }
  .refresh-toggle input { accent-color: #3fb950; cursor: pointer; }
  #editToggle { accent-color: #e3b341; }
  .mark-label {
    background: #161b22; border: 1px solid #262c36; color: #e6e9ef;
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;
    padding: 2px 6px; border-radius: 4px;
  }
  .leaflet-tooltip.mark-label::before { display: none; }

  /* Zoom control moved to the top-right (Leaflet's own default is
     top-left, set via zoomControl:false + a manual L.control.zoom below)
     - offset down past the topbar the same way .edit-column-inner already
     does (56px), so it doesn't sit underneath/behind it. */
  .leaflet-top.leaflet-right { top: 56px; }

  /* Course-info card, top-left, offset past the topbar the same way -
     deliberately a light card (not this page's usual dark chrome) so it
     reads clearly over satellite imagery of any brightness, the same
     reasoning real paper course cards on a committee boat use a plain
     white background regardless of the water/sky behind them. */
  .course-info-card {
    position: absolute; top: 66px; left: 16px; z-index: 800;
    background: #ffffff; color: #1b2430;
    border-radius: 14px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
    padding: 14px 18px; min-width: 230px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  .course-info-title { font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
  .course-info-title-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
  .unit-toggle-label {
    display: flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.03em; color: #8a94a3; cursor: pointer; user-select: none;
  }
  .unit-toggle-label input { accent-color: #3a5169; cursor: pointer; }
  .course-info-row { display: flex; justify-content: space-between; align-items: baseline; gap: 18px; padding: 4px 0; font-size: 13px; }
  .course-info-row .label { color: #8a94a3; }
  .course-info-row .value { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  /* Rows with a data-marks attribute (see buildCourseInfoHtml) zoom the map
     to that mark/line on click - a subtle rounded-highlight hover is the
     only affordance, matching this card's own plain/paper-card look rather
     than looking like a button. */
  .course-info-row.zoomable { cursor: pointer; border-radius: 6px; margin: 0 -6px; padding: 4px 6px; }
  .course-info-row.zoomable:hover { background: #f1f3f6; }

  /* Edit mode: a map area that shrinks to make room for a column of
     "set this mark here" buttons, plus a crosshair fixed at the exact
     center of whatever's left of the map - see the class comment on
     renderMap() in adminServer.js for the overall design. */
  .main { position: absolute; inset: 0; display: flex; }
  .map-wrap { position: relative; flex: 1; min-width: 0; }
  #map { position: absolute; inset: 0; }
  .crosshair {
    position: absolute; top: 50%; left: 50%; z-index: 900;
    width: 30px; height: 30px; margin: -15px 0 0 -15px;
    pointer-events: none; display: none;
  }
  .crosshair.visible { display: block; }
  .crosshair::before, .crosshair::after { content: ''; position: absolute; background: #e3b341; box-shadow: 0 0 3px #000a; }
  .crosshair::before { left: 14px; top: 0; width: 2px; height: 30px; }
  .crosshair::after { top: 14px; left: 0; width: 30px; height: 2px; }

  .edit-column {
    width: 0; flex-shrink: 0; overflow: hidden;
    background: #161b22; border-left: 1px solid #262c36;
    transition: width 0.15s ease;
  }
  .edit-column.visible { width: 240px; }
  .edit-column-inner {
    width: 240px; box-sizing: border-box; height: 100%; overflow-y: auto;
    padding: 56px 14px 14px;
    color: #e6e9ef;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  .edit-column h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #8b94a3; margin: 0 0 10px; }
  .recenter-btn {
    display: block; width: 100%; margin-bottom: 14px;
    padding: 8px 10px; border-radius: 6px; border: 1px solid #262c36;
    background: #1c222b; color: #e6e9ef; font-size: 12px; cursor: pointer;
  }
  .recenter-btn:hover { background: #262c36; }
  .gps-readout { display: flex; justify-content: space-between; align-items: baseline; font-size: 11px; color: #8b94a3; margin: 2px 0 6px; gap: 6px; }
  .gps-readout .value { color: #e6e9ef; font-variant-numeric: tabular-nums; text-align: right; }
  .mark-assignment { margin: 14px 0; padding: 10px 0; border-top: 1px solid #262c36; border-bottom: 1px solid #262c36; }
  .mark-set-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #1c222b; font-size: 12px; }
  .mark-set-row:last-child { border-bottom: none; }
  .mark-set-row .name { flex: 1; }
  .mark-set-row button {
    padding: 4px 10px; border-radius: 4px; border: 1px solid #262c36;
    background: #1c222b; color: #e6e9ef; font-size: 11px; cursor: pointer;
  }
  .mark-set-row button:hover { background: #262c36; }
  .mark-set-row button:disabled { opacity: 0.5; cursor: default; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .pin-boundary-toggle {
    display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;
    font-size: 12px; color: #e6e9ef;
  }
  .pin-boundary-toggle input { accent-color: #f85149; cursor: pointer; }
</style>
</head>
<body>
  <div class="topbar">
    <h1>Course map</h1>
    ${backToDashboardLink}
    ${regattaControlsHtml}
    <div class="spacer"></div>
    <label class="refresh-toggle">
      <input type="checkbox" id="editToggle">
      edit marks
    </label>
    <label class="refresh-toggle">
      <input type="checkbox" id="autoRefresh">
      auto-refresh boats (5s)
    </label>
  </div>
  <div class="main">
    <div class="map-wrap">
      <div id="map"></div>
      <div class="crosshair" id="crosshair"></div>
      ${buildCourseInfoHtml(marks)}
    </div>
    <div class="edit-column" id="editColumn">
      <div class="edit-column-inner">
        <h2>Edit course marks</h2>

        <div class="gps-readout"><span>Browser GPS</span><span class="value" id="browserGpsReadout">—</span></div>
        <button type="button" class="recenter-btn" id="recenterGps">Recenter on my GPS</button>

        ${
          s.baseGpsPort
            ? `<div class="gps-readout"><span>Base RTK GPS</span><span class="value" id="baseGpsReadout">—</span></div>
        <button type="button" class="recenter-btn" id="recenterBaseGps">Recenter on base GPS</button>`
            : '' /* No GPS_PORT configured on this process at all (the common case for plain base) - omitted
                    entirely rather than shown as a permanent "unavailable"/"unreachable" row with nothing to
                    do. Present whenever a GPS actually is configured - base with GPS_PORT set, basertk, and
                    always under markset (see baseStation.js's marksetMode). */
        }

        <button type="button" class="recenter-btn" id="recenterMarks">Recenter on marks</button>
        ${markAssignmentHtml}
        ${mapOnly && s.markAssignment ? '' : markSetRowsHtml}

        <h2 style="margin-top:18px;">Pin boundary gate</h2>
        <div class="muted" style="font-size:11px;margin-bottom:10px;">When on, boats can never legally sail downwind past the pin side of the course - the whole port side becomes off-limits, indefinitely. Updates and re-broadcasts immediately, same as an edited mark.</div>
        <label class="pin-boundary-toggle">
          <input type="checkbox" id="pinBoundaryToggle" ${marks.pinBoundaryEnabled ? 'checked' : ''}>
          Enable pin boundary gate
        </label>
      </div>
    </div>
  </div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
  <script>
    // zoomControl:false + a manual L.control.zoom below (positioned
    // top-right, see .leaflet-top.leaflet-right above) instead of Leaflet's
    // own default top-left control, which sits under the topbar/course-info
    // card. maxZoom:22 matches RegattaUp's own map, well past the imagery's
    // own native resolution (maxNativeZoom below) - Leaflet upscales the
    // last real tile level for anything past that rather than showing
    // nothing, so zooming that far in still shows *something*, just soft,
    // instead of hitting a hard ceiling.
    const map = L.map('map', { zoomControl: false, maxZoom: 22 });
    L.control.zoom({ position: 'topright' }).addTo(map);
    const boatMarkers = {};

    // Course-info card rows (see buildCourseInfoHtml's own comment on
    // data-marks) zoom the map to the mark(s) they're describing on click -
    // one name zooms straight in on that mark, two (a line) fits both into
    // view. courseMarks is the same marks object the rest of this page's
    // markers/lines were built from, just handed to the client this once so
    // this lookup doesn't need its own separate route.
    const courseMarks = ${JSON.stringify(marks)};
    const COURSE_INFO_ZOOM = 19; // close enough to make out a single mark clearly, short of maxNativeZoom's soft upscaling
    document.querySelectorAll('.course-info-row.zoomable').forEach((row) => {
      const names = row.dataset.marks.split(',');
      row.addEventListener('click', () => {
        if (names.length === 1) {
          const m = courseMarks[names[0]];
          map.setView([m.lat, m.lon], Math.max(map.getZoom(), COURSE_INFO_ZOOM));
        } else {
          const points = names.map((name) => [courseMarks[name].lat, courseMarks[name].lon]);
          map.fitBounds(points, { padding: [80, 80], maxZoom: COURSE_INFO_ZOOM });
        }
      });
    });

    // Course-card unit toggle: "small" rows (start/finish line lengths)
    // always show meters/feet regardless of this toggle - they're short
    // enough that km/mi would read as an unhelpful "0.06 km" - only
    // "large" rows (mark distances) actually switch between km and mi.
    // One conversion implementation here, not a duplicate server-side copy
    // that could drift from it - see buildCourseInfoHtml's own comment.
    (function () {
      const KEY = 'raceTrackerMapUnits';
      const toggle = document.getElementById('unitToggle');
      if (!toggle) return; // no course card at all (e.g. the "no marks yet" page)
      function applyUnits(imperial) {
        document.querySelectorAll('.course-info-row[data-dist-m]').forEach((row) => {
          const m = parseFloat(row.dataset.distM);
          const bearing = row.dataset.bearing || '';
          const text =
            row.dataset.distKind === 'small'
              ? Math.round(imperial ? m * 3.28084 : m) + (imperial ? ' ft' : ' m')
              : (imperial ? m / 1609.344 : m / 1000).toFixed(2) + (imperial ? ' mi' : ' km');
          row.querySelector('.value').textContent = bearing ? text + ' · ' + bearing : text;
        });
      }
      toggle.checked = localStorage.getItem(KEY) === '1'; // off (metric) by default
      applyUnits(toggle.checked);
      toggle.addEventListener('change', () => {
        localStorage.setItem(KEY, toggle.checked ? '1' : '0');
        applyUnits(toggle.checked);
      });
    })();

    // Satellite imagery, not a street/vector basemap - these courses are
    // typically raced on a dry lake bed (Black Rock Desert-style playa)
    // with no roads or buildings for a vector basemap to draw, which made
    // an OSM/CARTO-style layer render as an almost-empty void at any
    // useful zoom. Imagery actually shows the ground.
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 22,
      maxNativeZoom: 19,
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
    }).addTo(map);

    ${markersJs}
    ${boatMarkersJs}

    // Start line (pin <-> committeeStart) and finish gate (committeeFinish
    // <-> finish) - drawn as two independent lines since they no longer
    // necessarily share an endpoint.
    L.polyline([[${marks.pin.lat}, ${marks.pin.lon}], [${marks.committeeStart.lat}, ${marks.committeeStart.lon}]], { color: '${MARK_COLORS.pin}', weight: 2, dashArray: '6 6' }).addTo(map);
    L.polyline([[${marks.committeeFinish.lat}, ${marks.committeeFinish.lon}], [${marks.finish.lat}, ${marks.finish.lon}]], { color: '${MARK_COLORS.finish}', weight: 2, dashArray: '6 6' }).addTo(map);
    // Course axis (leewardBlack <-> windwardBlack) - just a visual
    // reference; boats actually tack back and forth across this, not sail
    // it directly. Drawn between the black (outer) marks rather than the
    // green ones since both pairs sit on the same axis - one line covers
    // the full extent, green marks included, since they fall on it too.
    L.polyline([[${marks.leewardBlack.lat}, ${marks.leewardBlack.lon}], [${marks.windwardBlack.lat}, ${marks.windwardBlack.lon}]], { color: '#e6e9ef', weight: 1, dashArray: '2 8' }).addTo(map);
    // On-grid detection zone - the exact quadrilateral OnGridWatcher.check
    // itself tests against (see onGridWatcher.js's zonePolygon), not a
    // separately-eyeballed approximation, so this can never show a
    // different zone than what actually gets detected as on-grid.
    L.polygon(${JSON.stringify(zonePolygon(marks, config.regattaup.onGridZoneM).map((p) => [p.lat, p.lon]))}, { color: '${MARK_COLORS.pin}', weight: 2, dashArray: '4 6', fillColor: '${MARK_COLORS.pin}', fillOpacity: 0.08 }).addTo(map);
    // Pin boundary gate - the whole port side of the course is off-limits
    // downwind while this is on (see course.js's getPinBoundaryFarPoint).
    // Not included in any fitBounds call - its far endpoint sits many times
    // the course's own length away by design, so bounding to it would zoom
    // the map absurdly far out just to fit one dashed line's own distant
    // end; Leaflet still draws it perfectly well extending off past the
    // edge of whatever's actually in view.
    ${
      marks.pinBoundaryEnabled
        ? (() => {
            const far = getPinBoundaryFarPoint(marks.pin, marks.committeeStart);
            return `L.polyline([[${marks.pin.lat}, ${marks.pin.lon}], [${far.lat}, ${far.lon}]], { color: '${MARK_COLORS.pinBoundary}', weight: 2, dashArray: '6 6' }).addTo(map);`;
          })()
        : ''
    }

    // Marks-only bounds, kept separate from the initial-load fit below
    // (which also includes boats) - this is what the "Recenter on marks"
    // button in the edit column snaps back to, regardless of where a
    // boat happens to be or how far "Recenter on my GPS" panned away.
    const markBounds = ${markBoundsJs};

    // Capped below the tile layer's own maxZoom so a very short course
    // (e.g. a shrunk SIM_COURSE_LENGTH_NM test course) doesn't fit so
    // tightly it zooms in past the point where imagery tiles exist.
    map.fitBounds(${boundsJs}, { padding: [60, 60], maxZoom: 18 });

    // Moves existing boat markers (and adds new ones as boats first get an
    // in-memory position - see stats.recordFrame) rather than reloading
    // the whole page, so pan/zoom you've set up isn't thrown away every
    // few seconds. Course marks aren't re-fetched here since they don't
    // move mid-race. Hits /api/positions, NOT /api/stats - the latter
    // also queries Redis for track counts the map has no use for, and
    // this loop shouldn't cost a Redis round trip every 5s just to throw
    // that away (see baseStation.js's getBoatPositions).
    async function refreshBoats() {
      let positions;
      try {
        positions = await (await fetch('/api/positions')).json();
      } catch (err) {
        return; // base unreachable for a moment - just try again next tick
      }
      const now = Date.now();
      for (const [id, b] of Object.entries(positions)) {
        const online = b.lastSeen && now - b.lastSeen < ${ONLINE_THRESHOLD_MS};
        const fillColor = online ? '#3fb950' : '#8b94a3';
        if (boatMarkers[id]) {
          boatMarkers[id].setLatLng([b.lastPosition.lat, b.lastPosition.lon]);
          boatMarkers[id].setStyle({ fillColor });
        } else {
          boatMarkers[id] = L.circleMarker([b.lastPosition.lat, b.lastPosition.lon], { radius: 7, color: '#ffffff', weight: 2, fillColor, fillOpacity: 0.9 })
            .addTo(map)
            .bindTooltip('boat ' + id, { permanent: true, direction: 'bottom', offset: [0, 8], className: 'mark-label' });
        }
      }
    }

    (function () {
      const KEY = 'raceTrackerMapAutoRefresh';
      const checkbox = document.getElementById('autoRefresh');
      checkbox.checked = localStorage.getItem(KEY) !== '0'; // on by default
      let timer = null;
      function reschedule() {
        if (timer) clearInterval(timer);
        timer = checkbox.checked ? setInterval(refreshBoats, 5000) : null;
      }
      checkbox.addEventListener('change', () => {
        localStorage.setItem(KEY, checkbox.checked ? '1' : '0');
        reschedule();
      });
      reschedule();
    })();

    // Edit mode: shrinks the map to make room for the "set this mark
    // here" column and shows the fixed center crosshair. Persisted like
    // auto-refresh above (localStorage, off by default) - actually
    // setting a mark still requires its own explicit confirm() below, so
    // remembering the column's open/closed state across reloads doesn't
    // risk an accidental edit, just saves re-opening it every visit.
    const editModeKey = 'raceTrackerMapEditMode';
    const editColumn = document.getElementById('editColumn');
    const crosshair = document.getElementById('crosshair');
    const editToggle = document.getElementById('editToggle');
    const browserGpsReadout = document.getElementById('browserGpsReadout');
    const baseGpsReadout = document.getElementById('baseGpsReadout');
    let lastBrowserPos = null; // {lat, lon}, kept live by the watch below
    let lastBaseGpsFix = null; // {lat, lon, carrSoln, ...}, kept live by the poll below
    let geoWatchId = null;
    let baseGpsTimer = null;

    function fixQualityText(f) {
      if (f.carrSoln === 2) return 'RTK fixed';
      if (f.carrSoln === 1) return 'RTK float';
      if (f.gnssFixOk) return 'GPS';
      return 'no fix';
    }

    // A one-shot getCurrentPosition() call defaults to low accuracy with
    // no timeout - it can silently hang for a long time (or forever) if
    // the browser's location provider is struggling, especially indoors
    // or on a cold GPS start, and "Recenter on my GPS" would just look
    // broken with no feedback either way. watchPosition with
    // enableHighAccuracy instead keeps a continuous stream running in
    // the background the whole time edit mode is on - the readout shows
    // whether it's actually gotten a fix yet, and by the time you go to
    // click "Recenter" a fresh position is usually already sitting there
    // instead of starting cold at click time.
    function startBrowserGpsWatch() {
      if (!navigator.geolocation) {
        browserGpsReadout.textContent = 'not available';
        return;
      }
      browserGpsReadout.textContent = 'waiting for fix…';
      geoWatchId = navigator.geolocation.watchPosition(
        (pos) => {
          lastBrowserPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
          browserGpsReadout.textContent =
            lastBrowserPos.lat.toFixed(6) + ', ' + lastBrowserPos.lon.toFixed(6) + ' (±' + Math.round(pos.coords.accuracy) + 'm)';
        },
        (err) => {
          browserGpsReadout.textContent = err.code === err.PERMISSION_DENIED ? 'permission denied' : 'unavailable (' + err.message + ')';
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
      );
    }
    function stopBrowserGpsWatch() {
      if (geoWatchId != null && navigator.geolocation) navigator.geolocation.clearWatch(geoWatchId);
      geoWatchId = null;
      lastBrowserPos = null;
      browserGpsReadout.textContent = '—';
    }

    // A GPS module wired directly to this base station (config.js's gps
    // section, GPS_PORT - shared with the boat's own GPS config) - real
    // RTK precision, not a phone's much coarser Geolocation API. Most
    // base stations don't have one attached at all, so a null response
    // here (never an error - see baseStation.js's getBaseGpsFix) is the
    // expected, common case, not a failure.
    async function pollBaseGps() {
      if (!baseGpsReadout) return; // no GPS configured on this process at all - row isn't in the DOM
      let fix;
      try {
        fix = await (await fetch('/api/gps')).json();
      } catch (err) {
        baseGpsReadout.textContent = 'unreachable';
        return;
      }
      lastBaseGpsFix = fix;
      baseGpsReadout.textContent = fix
        ? fix.lat.toFixed(6) + ', ' + fix.lon.toFixed(6) + ' (' + fixQualityText(fix) + ', ±' + (fix.hAccMm / 1000).toFixed(2) + 'm)'
        : 'unavailable';
    }
    function startBaseGpsPoll() {
      pollBaseGps();
      baseGpsTimer = setInterval(pollBaseGps, 3000);
    }
    function stopBaseGpsPoll() {
      if (baseGpsTimer) clearInterval(baseGpsTimer);
      baseGpsTimer = null;
      lastBaseGpsFix = null;
      if (baseGpsReadout) baseGpsReadout.textContent = '—';
    }

    function applyEditMode(checked) {
      editColumn.classList.toggle('visible', checked);
      crosshair.classList.toggle('visible', checked);
      // The column's width transitions via CSS, not instantly - Leaflet
      // caches its container size and won't notice the map-wrap resizing
      // on its own, so it has to be told explicitly once the transition
      // settles (an immediate call would measure the pre-transition size).
      setTimeout(() => map.invalidateSize(), 200);
      if (checked) {
        startBrowserGpsWatch();
        startBaseGpsPoll();
      } else {
        // Stop both rather than leaving them running unattended - a
        // continuous GPS watch has a real battery/permission-indicator
        // cost, and there's no reason to keep polling the base once the
        // column showing the result isn't even visible.
        stopBrowserGpsWatch();
        stopBaseGpsPoll();
      }
    }

    editToggle.checked = localStorage.getItem(editModeKey) === '1'; // off by default
    applyEditMode(editToggle.checked);
    editToggle.addEventListener('change', () => {
      localStorage.setItem(editModeKey, editToggle.checked ? '1' : '0');
      applyEditMode(editToggle.checked);
    });

    document.getElementById('recenterGps').addEventListener('click', () => {
      if (!lastBrowserPos) {
        alert('No browser GPS fix yet - wait for the readout above to show a position. This requires a secure context (https, or localhost), so it may be blocked entirely when viewing this dashboard over plain http on your LAN.');
        return;
      }
      map.setView([lastBrowserPos.lat, lastBrowserPos.lon], map.getZoom());
    });

    // The button itself isn't in the DOM at all when this process has no
    // GPS configured (see the edit-column HTML above) - nothing to wire up.
    const recenterBaseGpsBtn = document.getElementById('recenterBaseGps');
    if (recenterBaseGpsBtn) {
      recenterBaseGpsBtn.addEventListener('click', () => {
        if (!lastBaseGpsFix) {
          alert('No GPS is attached to this base station (set GPS_PORT to enable one when running the base), or it hasn\\'t produced a fix yet.');
          return;
        }
        map.setView([lastBaseGpsFix.lat, lastBaseGpsFix.lon], map.getZoom());
      });
    }

    // Snaps back to the whole course - useful after either GPS button
    // walked the view away, or after just panning around to line up a
    // shot with the crosshair.
    document.getElementById('recenterMarks').addEventListener('click', () => {
      map.fitBounds(markBounds, { padding: [60, 60], maxZoom: 18 });
    });

    // Sets a mark to wherever the crosshair currently points - i.e.
    // map.getCenter(), read fresh at click time, not wherever the map
    // happened to be when the page loaded. Confirms first since this
    // immediately updates the live course and re-broadcasts to every
    // boat (see baseStation.js's setMarkLocation) - not something to
    // fire accidentally. Reloads on success rather than patching the
    // moved marker/lines in place - unlike the 5s boat-position refresh
    // loop, this only happens on a deliberate, infrequent edit, so
    // losing pan/zoom here to guarantee everything (including the
    // course-axis/start-line polylines) reflects the change is a fine
    // trade.
    document.querySelectorAll('.set-mark-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.mark;
        const center = map.getCenter();
        const latText = center.lat.toFixed(6);
        const lonText = center.lng.toFixed(6);
        if (!confirm('Set ' + name + ' to ' + latText + ', ' + lonText + '?\\n\\nThis updates the live course and re-broadcasts it to every boat immediately.')) {
          return;
        }
        btn.disabled = true;
        try {
          const res = await fetch('/api/marks/' + encodeURIComponent(name), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat: center.lat, lon: center.lng })
          });
          const body = await res.json();
          if (!res.ok || !body.ok) throw new Error(body.error || ('HTTP ' + res.status));
          location.reload();
        } catch (err) {
          alert('Failed to set ' + name + ': ' + err.message);
          btn.disabled = false;
        }
      });
    });

    // Turns the pin boundary gate on/off (see baseStation.js's
    // setPinBoundaryEnabled) - confirmed first since, once on, it makes the
    // entire port side of the course illegal to sail through downwind, not
    // a small local nudge like an ordinary mark edit. Reloads on success,
    // same reasoning as the mark-edit handler above (the dashed gate line
    // itself needs a fresh render either way).
    document.getElementById('pinBoundaryToggle').addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      const label = enabled
        ? 'turn ON the pin boundary gate? The entire pin side of the course becomes off-limits to downwind boats, indefinitely.'
        : 'turn OFF the pin boundary gate?';
      if (!confirm('Are you sure you want to ' + label + '\\n\\nThis updates the live course and re-broadcasts it to every boat immediately.')) {
        e.target.checked = !enabled;
        return;
      }
      e.target.disabled = true;
      try {
        const res = await fetch('/api/pin-boundary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        });
        const body = await res.json();
        if (!res.ok || !body.ok) throw new Error(body.error || ('HTTP ' + res.status));
        location.reload();
      } catch (err) {
        alert('Failed to set pin boundary gate: ' + err.message);
        e.target.checked = !enabled;
        e.target.disabled = false;
      }
    });
    ${
      mapOnly
        ? `${SELECT_REGATTA_JS}

    // Assigns (or clears) which mark this rover represents (see README's
    // "Mark mode") - the "This rover represents" dropdown above. Confirmed
    // only when actually assigning to a real mark, not when clearing back
    // to "Not assigned" - unassigning just stops this device auto-posting,
    // nothing to double-check there. On cancel, reverts the dropdown to
    // whatever was actually assigned server-side (data-current, set at
    // render time) rather than leaving it showing the choice that was just
    // backed out of.
    async function assignMark(select) {
      const name = select.value;
      if (name && !confirm('Assign this rover to represent the "' + name + '" mark? It will auto-post its own GPS position as that mark\\'s new location whenever it moves ${config.markDistanceM}m or more, until unassigned.')) {
        select.value = select.dataset.current;
        return;
      }
      select.disabled = true;
      try {
        const res = await fetch('/api/mark-assignment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        const result = await res.json();
        if (!result.ok) throw new Error(result.error || 'request failed');
        location.reload();
      } catch (err) {
        alert('Failed: ' + err.message);
        select.value = select.dataset.current;
        select.disabled = false;
      }
    }`
        : ''
    }
  </script>
</body>
</html>`;
}

// Reads and JSON-parses a request body - only the mark-editing and
// regatta-select POST routes need this, everything else on this server is
// GET/no-body, so this doesn't need to be anything fancier than
// accumulate-then-parse. Capped well above any real payload's size so a
// malformed or hostile client can't hold the connection open buffering an
// unbounded body.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10000) req.destroy(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Serves the admin dashboard (base station only) - GET / for the human-
// readable page (server-rendered, reloads itself every 5s via a meta
// refresh rather than needing any client-side JS at all), GET /api/stats
// for the same data as JSON. getStats is an async callback (see
// baseStation.js's getFullStats) since some of what it reports - track
// counts - comes from a live Redis query, not just in-memory state.
// getPositions is a separate, synchronous, Redis-free callback (see
// baseStation.js's getBoatPositions) - the map page's own live-refresh
// loop (renderMap above) polls GET /api/positions instead of /api/stats
// specifically so watching the map doesn't cost a Redis round trip every
// 5s for data it doesn't use. setMark (see baseStation.js's
// setMarkLocation) is the one non-GET operation this server exposes -
// used by the map page's "edit marks" column to persist and
// re-broadcast a corrected mark position; it's also the one route with
// CORS enabled, since a boat's own rover dashboard calls it cross-origin
// (see roverAdminServer.js). getBaseGps (see baseStation.js's
// getBaseGpsFix) reports a GPS module wired directly to this base
// station, if any - null (not an error) when none is configured.
// getBaseGpsSurvey (see baseStation.js's getBaseGpsSurveyStatus) reports
// that same GPS module's TMODE3 mode and, while in survey-in mode, its
// progress/result - also null when no base GPS is configured.
// setBaseGpsSurveyIn/setBaseGpsFixed (see baseStation.js) switch that same
// GPS module's TMODE3 mode - unlike setMark, this is base-only (no rover
// equivalent), so it doesn't need setMark's CORS handling. selectRegatta
// (see baseStation.js's selectRegatta) persists which RegattaUp regatta
// this base station reports events against - the dashboard's own regatta
// list/selection comes bundled in getStats' own s.regatta, not a separate
// callback, since it's cheap in-memory state, not a live query.
//
// getBaseGpsSurvey/setBaseGpsSurveyIn/setBaseGpsFixed/saveBaseGpsConfig are
// all four given together or not at all - baseStation.js only passes them
// under `npm run basertk` (see its own rtkControlsEnabled), never plain
// `npm run base`. rtkControlsEnabled below just checks one of the four as a
// stand-in for "were the RTK controls wired in at all."
function startAdminServer({
  port,
  getStats,
  getPositions,
  setMark,
  setPinBoundaryEnabled,
  pingFleet,
  selectRegatta,
  getMarkAssignment,
  setMarkAssignment,
  getBaseGps,
  getBaseGpsSurvey,
  setBaseGpsSurveyIn,
  setBaseGpsFixed,
  saveBaseGpsConfig,
  // See baseStation.js's marksetMode - true only under `npm run markset`.
  // Swaps GET / from the fleet dashboard to the course map, since a
  // mark-setting run has no use for the fleet/radio/upload view as its
  // default page. Every other route (including /map itself, so the two
  // are just aliases of each other under this mode) is unchanged.
  mapOnly,
}) {
  const rtkControlsEnabled = !!setBaseGpsSurveyIn;
  const server = http.createServer(async (req, res) => {
    // Persists which RegattaUp regatta this base station is reporting for
    // (see baseStation.js's selectRegatta) - the dashboard's own regatta
    // select. id is looked up against the last-fetched active-regattas
    // list server-side, not trusted as-is - see selectRegatta's own comment.
    if (req.url === '/api/regattas/selected' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        await selectRegatta(body.id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // Broadcasts a ping asking every boat to report its current position
    // (see baseStation.js's pingFleet/protocol.js's encodePing) - the
    // dashboard's own "Ping fleet" button. Fire-and-forget from this route's
    // own perspective: replies trickle in over the next few seconds (each
    // boat waits its own random delay) as ordinary position frames, picked
    // up by the ordinary fleet table the next time this page polls/refreshes.
    if (req.url === '/api/ping-fleet' && req.method === 'POST') {
      try {
        pingFleet();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // Guarded on rtkControlsEnabled - not wired at all under plain
    // `npm run base` (see startAdminServer's own comment), so this falls
    // through to the 404 below rather than reconfiguring RTK corrections a
    // dashboard that never showed the controls for it in the first place.
    if (rtkControlsEnabled && req.url === '/api/gps/survey/mode' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        if (body.mode === 'survey-in') setBaseGpsSurveyIn();
        else if (body.mode === 'fixed') {
          // lat/lon/heightM present means the dashboard's manual-entry
          // form was used (an operator-typed known-good position, e.g. a
          // club's own surveyed benchmark) rather than the plain "Use as
          // fixed position" button, which sends none of these and lets
          // setBaseGpsFixed fall back to survey-in/live-fix itself.
          const manualPos =
            body.lat != null || body.lon != null || body.heightM != null
              ? { lat: Number(body.lat), lon: Number(body.lon), heightM: Number(body.heightM) }
              : null;
          setBaseGpsFixed(manualPos);
        } else throw new Error(`unknown mode "${body.mode}"`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // Persists whatever TMODE3 mode is currently active (see
    // baseStation.js's saveBaseGpsConfig) - a separate, explicit action
    // from setting survey-in/fixed mode itself, which only ever changes
    // the receiver's live RAM config on its own.
    if (rtkControlsEnabled && req.url === '/api/gps/save-config' && req.method === 'POST') {
      try {
        saveBaseGpsConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // Toggles the pin boundary gate (see baseStation.js's
    // setPinBoundaryEnabled/course.js's PIN_BOUNDARY_MARK) - the map's own
    // checkbox. Base-only, unlike /api/marks/:name below - no CORS needed,
    // since this checkbox only ever lives on the base's own admin map, not
    // the rover's (see the user-facing copy on that checkbox).
    if (req.url === '/api/pin-boundary' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const marks = await setPinBoundaryEnabled(!!body.enabled);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, marks }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // Assigns (or clears, with a falsy/absent name) which mark this device
    // represents (see README's "Mark mode") - the map's own "This rover
    // is:" dropdown, under mapOnly. Base-only same as /api/pin-boundary
    // above - no rover-side equivalent needs to call this cross-origin.
    if (req.url === '/api/mark-assignment' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const name = setMarkAssignment(body.name || null);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    const marksMatch = req.url.match(/^\/api\/marks\/([^/?]+)$/);
    if (marksMatch && (req.method === 'POST' || req.method === 'OPTIONS')) {
      // CORS: unlike every other route here (same-origin only - each
      // dashboard only ever calls its own server), this one is also
      // called cross-origin from a boat's own rover dashboard - a
      // completely different host:port - when it's in WiFi range of the
      // base (see roverAdminServer.js's edit-marks column, which already
      // knows this base's address from the marks broadcast). A JSON POST
      // triggers a browser preflight, so OPTIONS needs handling too.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      const name = decodeURIComponent(marksMatch[1]);
      try {
        const body = await readJsonBody(req);
        const marks = await setMark(name, Number(body.lat), Number(body.lon));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, marks }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(404);
      res.end();
      return;
    }

    if (req.url === '/api/stats') {
      try {
        const s = await getStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(s));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.url === '/api/positions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getPositions()));
      return;
    }

    if (req.url === '/api/gps') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getBaseGps()));
      return;
    }

    // TMODE3/survey-in status (see baseStation.js's getBaseGpsSurveyStatus)
    // - already included in /api/stats too (renderDashboard's card reads
    // it from there), but exposed standalone same as /api/gps above, for
    // anything that wants just this without the full stats payload.
    if (rtkControlsEnabled && req.url === '/api/gps/survey') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getBaseGpsSurvey()));
      return;
    }

    if (req.url === '/' || req.url === '') {
      try {
        const s = await getStats();
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(mapOnly ? renderMap(s, { mapOnly }) : renderDashboard(s, rtkControlsEnabled));
      } catch (err) {
        res.writeHead(500);
        res.end(`<pre>${err.message}</pre>`);
      }
      return;
    }

    if (req.url === '/map') {
      try {
        const s = await getStats();
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderMap(s, { mapOnly }));
      } catch (err) {
        res.writeHead(500);
        res.end(`<pre>${err.message}</pre>`);
      }
      return;
    }

    if (req.url === '/config') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderConfigPage({ role: rtkControlsEnabled ? 'basertk' : 'base' }));
      return;
    }

    // Last logBuffer.MAX_LINES (100) lines of this process's own console
    // output - works the same whether this is an interactive `npm run
    // base` session or a systemd service (where stdout goes straight to
    // the journal, not something this app could otherwise re-read itself -
    // see logBuffer's own comment).
    if (req.url === '/console') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderConsoleLogPage('base station console'));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.on('error', (err) => console.error('[adminServer] error:', err.message));
  // The "dashboard at http://..." announcement itself is logged by
  // baseStation.js, as early as possible in main() - well before this
  // function even runs - so an operator sees it before everything else
  // this process logs during radio/Redis/upload-server setup, not after.
  server.listen(port);

  return server;
}

module.exports = { startAdminServer, renderDashboard, renderMap };
