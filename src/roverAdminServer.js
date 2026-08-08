const http = require('http');
const { formatAgo, formatDuration, formatBytes, pct } = require('./dashboardFormat');
const { MARK_NAMES, MARK_COLORS, markStroke } = require('./course');
const { renderConfigPage } = require('./configReport');

// Renders the boat's own dashboard server-side from one stats snapshot (see
// boatAgent.js's getRoverStats) - the boat-side counterpart to
// adminServer.js's renderDashboard, but there's only ever one boat here, so
// this is a single detail view rather than a fleet table.
function renderDashboard(s) {
  const fix = s.lastFix;
  const fixAgeMs = fix ? Date.now() - fix.timestamp : null;
  // Stale if the boat hasn't produced a new fix in a while - catches a GPS
  // that's stopped responding even though the process itself is still up.
  const fixStale = fixAgeMs == null || fixAgeMs > 10000;

  const baseReachable = s.upload.lastHealthCheckOkAt && Date.now() - s.upload.lastHealthCheckOkAt < 60000;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>boat ${s.boatId} - rover admin</title>
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
  section { margin-bottom: 28px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.04em; color: #8b94a3; margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #262c36; border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 14px; font-size: 13px; font-variant-numeric: tabular-nums; }
  th { color: #8b94a3; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid #262c36; }
  tr:not(:last-child) td { border-bottom: 1px solid #1c222b; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; flex-shrink: 0; }
  .dot-green { background: #3fb950; box-shadow: 0 0 6px #3fb95080; }
  .dot-gray { background: #4b535e; }
  .dot-red { background: #f85149; box-shadow: 0 0 6px #f8514980; }
  .muted { color: #8b94a3; }
  .empty { color: #8b94a3; padding: 20px; text-align: center; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <h1>boat ${s.boatId} - rover admin</h1>
  <div class="subtitle">
    <span class="dot ${fixStale ? 'dot-red' : 'dot-green'}"></span>GPS ${s.gpsMode}
    &nbsp;·&nbsp; radio ${s.radioMode}
    &nbsp;·&nbsp; uptime ${formatDuration(s.uptimeMs)}
    &nbsp;·&nbsp; refreshes every 5s
    &nbsp;·&nbsp; <a href="/config">config</a>
    ${s.currentMarks || fix ? '&nbsp;·&nbsp; <a href="/map">map ↗</a>' : ''}
    ${s.baseIp ? `&nbsp;·&nbsp; <a href="http://${s.baseIp}:${s.adminPort}/" target="_blank" rel="noopener">base dashboard ↗</a>` : ''}
  </div>

  <div class="grid">
    <div class="card">
      <div class="label">Last fix</div>
      <div class="value">${formatAgo(fix ? fix.timestamp : null)}</div>
      <div class="sub">${fix ? `${fix.lat.toFixed(6)}, ${fix.lon.toFixed(6)}` : 'no fix yet'}</div>
    </div>
    <div class="card">
      <div class="label">Fix quality</div>
      <div class="value">${fix ? (fix.carrSoln === 2 ? 'RTK fixed' : fix.carrSoln === 1 ? 'RTK float' : fix.gnssFixOk ? 'GPS' : 'no fix') : '—'}</div>
      <div class="sub">${fix ? `${fix.numSV} sats, ${(fix.hAccMm / 1000).toFixed(2)}m acc` : ''}</div>
    </div>
    <div class="card">
      <div class="label">Course</div>
      <div class="value">${s.currentMarks ? 'known' : 'waiting'}</div>
      <div class="sub">${s.marksReceivedCount} broadcasts received, last ${formatAgo(s.lastMarksReceivedAt)}</div>
    </div>
    ${
      s.currentMarks
        ? `<div class="card marks-card">
      <div class="label">Course marks</div>
      <div class="marks-mini">
        ${MARK_NAMES.map((name) => {
          const m = s.currentMarks[name];
          return `<div class="mark-row"><span class="dot" style="background:${MARK_COLORS[name]}; box-shadow: inset 0 0 0 1.5px ${markStroke(name)}"></span><span class="name">${name}</span><span class="coords">${m.lat.toFixed(4)}, ${m.lon.toFixed(4)}</span></div>`;
        }).join('')}
      </div>
    </div>`
        : ''
    }
    <div class="card">
      <div class="label">Frames sent</div>
      <div class="value">${s.radio.framesSent.toLocaleString()}</div>
      <div class="sub">${s.radio.syncErrors} sync errors received</div>
    </div>
    <div class="card">
      <div class="label">Base reachable</div>
      <div class="value">${baseReachable ? 'yes' : 'no'}</div>
      <div class="sub">last check ok ${formatAgo(s.upload.lastHealthCheckOkAt)}</div>
    </div>
    <div class="card">
      <div class="label">Pending uploads</div>
      <div class="value">${s.pendingCount}</div>
      <div class="sub">not yet sent to base</div>
    </div>
    <div class="card">
      <div class="label">Uploaded files</div>
      <div class="value">${s.upload.successes.toLocaleString()}</div>
      <div class="sub">${formatBytes(s.upload.bytesTotal)} total, last ${formatAgo(s.upload.lastUploadAt)}</div>
    </div>
    <div class="card">
      <div class="label">Upload attempts</div>
      <div class="value">${s.upload.attempts.toLocaleString()}</div>
      <div class="sub">${pct(s.upload.successes, s.upload.attempts)} success rate, ${s.upload.failures} failures</div>
    </div>
  </div>
</body>
</html>`;
}

// A full-page map view (see adminServer.js's renderMap - same Esri World
// Imagery CDN tiles, same reasoning: these courses are raced on open
// playa, not somewhere a street basemap has anything useful to draw, so
// the viewing browser needs internet access). Unlike the base's version,
// this one is scoped to a single boat, so it also plots this boat's own
// last known fix - a live breadcrumb, not just the static course - since
// that's the one thing the base's fleet-wide map doesn't have room to
// show per-boat.
function renderMap(s) {
  const fix = s.lastFix;
  const fixAgeMs = fix ? Date.now() - fix.timestamp : null;
  const fixStale = fixAgeMs == null || fixAgeMs > 10000;

  if (!s.currentMarks && !fix) {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>boat ${s.boatId} map</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0f1216; color: #8b94a3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  a { color: #58a6ff; text-decoration: none; margin-left: 8px; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>No course marks or GPS fix yet.<a href="/">&larr; back to dashboard</a></body>
</html>`;
  }

  const marks = s.currentMarks;
  const markersJs = marks
    ? MARK_NAMES.map(
        (name) =>
          `L.circleMarker([${marks[name].lat}, ${marks[name].lon}], { radius: 8, color: '${markStroke(name)}', weight: 2, fillColor: '${MARK_COLORS[name]}', fillOpacity: 0.85 })
        .addTo(map)
        .bindTooltip('${name}', { permanent: true, direction: 'top', offset: [0, -8], className: 'mark-label' });`
      ).join('\n    ')
    : '';
  const linesJs = marks
    ? `
    L.polyline([[${marks.pin.lat}, ${marks.pin.lon}], [${marks.committee.lat}, ${marks.committee.lon}]], { color: '${MARK_COLORS.pin}', weight: 2, dashArray: '6 6' }).addTo(map);
    L.polyline([[${marks.committee.lat}, ${marks.committee.lon}], [${marks.finish.lat}, ${marks.finish.lon}]], { color: '${MARK_COLORS.finish}', weight: 2, dashArray: '6 6' }).addTo(map);
    L.polyline([[${marks.leewardBlack.lat}, ${marks.leewardBlack.lon}], [${marks.windwardBlack.lat}, ${marks.windwardBlack.lon}]], { color: '#e6e9ef', weight: 1, dashArray: '2 8' }).addTo(map);`
    : '';
  const boatMarkerJs = fix
    ? `boatMarker = L.circleMarker([${fix.lat}, ${fix.lon}], { radius: 7, color: '#ffffff', weight: 2, fillColor: '${fixStale ? '#8b94a3' : '#3fb950'}', fillOpacity: 0.9 })
      .addTo(map)
      .bindTooltip('boat ${s.boatId}', { permanent: true, direction: 'bottom', offset: [0, 8], className: 'mark-label' });`
    : '';

  const boundsPoints = [
    ...(marks ? MARK_NAMES.map((name) => `[${marks[name].lat}, ${marks[name].lon}]`) : []),
    ...(fix ? [`[${fix.lat}, ${fix.lon}]`] : []),
  ];

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>boat ${s.boatId} map</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">
<style>
  html, body, #map { height: 100%; margin: 0; background: #0f1216; }
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
  .topbar .muted { color: #8b94a3; }
  .topbar a { color: #58a6ff; text-decoration: none; }
  .topbar a:hover { text-decoration: underline; }
  .topbar .spacer { flex: 1; }
  .refresh-toggle { display: flex; align-items: center; gap: 6px; color: #8b94a3; cursor: pointer; user-select: none; }
  .refresh-toggle input { accent-color: #3fb950; cursor: pointer; }
  .mark-label {
    background: #161b22; border: 1px solid #262c36; color: #e6e9ef;
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;
    padding: 2px 6px; border-radius: 4px;
  }
  .leaflet-tooltip.mark-label::before { display: none; }
</style>
</head>
<body>
  <div class="topbar">
    <h1>Boat ${s.boatId} map</h1>
    <span class="muted" id="fixStatus">${fix ? `last fix ${fixStale ? 'stale, ' : ''}${formatAgo(fix.timestamp)}` : 'no GPS fix yet'}</span>
    <a href="/">&larr; back to dashboard</a>
    <div class="spacer"></div>
    <label class="refresh-toggle">
      <input type="checkbox" id="autoRefresh">
      auto-refresh (5s)
    </label>
  </div>
  <div id="map"></div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
  <script>
    const map = L.map('map', { zoomControl: true });
    let boatMarker = null;
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
    }).addTo(map);

    ${markersJs}
    ${linesJs}
    ${boatMarkerJs}

    map.fitBounds([${boundsPoints.join(', ')}], { padding: [60, 60], maxZoom: 18 });

    // Moves the boat's own marker (and creates it, if this page loaded
    // before the first fix came in) rather than reloading the page, so
    // pan/zoom isn't thrown away every few seconds. Course marks aren't
    // re-fetched here since they don't move mid-race. Hits /api/position,
    // NOT /api/stats - the latter also calls countPending's
    // fs.readdirSync over the log directory, which this loop has no use
    // for (see boatAgent.js's getPosition).
    async function refreshBoat() {
      let pos;
      try {
        pos = await (await fetch('/api/position')).json();
      } catch (err) {
        return; // boat unreachable for a moment - just try again next tick
      }
      const fixStatusEl = document.getElementById('fixStatus');
      if (!pos) {
        fixStatusEl.textContent = 'no GPS fix yet';
        return;
      }
      const ageMs = Date.now() - pos.timestamp;
      const stale = ageMs > 10000;
      const ageS = Math.floor(ageMs / 1000);
      const ageText = ageS < 5 ? 'just now' : ageS + 's ago';
      fixStatusEl.textContent = 'last fix ' + (stale ? 'stale, ' : '') + ageText;
      const fillColor = stale ? '#8b94a3' : '#3fb950';
      if (boatMarker) {
        boatMarker.setLatLng([pos.lat, pos.lon]);
        boatMarker.setStyle({ fillColor });
      } else {
        boatMarker = L.circleMarker([pos.lat, pos.lon], { radius: 7, color: '#ffffff', weight: 2, fillColor, fillOpacity: 0.9 })
          .addTo(map)
          .bindTooltip('boat ${s.boatId}', { permanent: true, direction: 'bottom', offset: [0, 8], className: 'mark-label' });
      }
    }

    (function () {
      const KEY = 'raceTrackerMapAutoRefresh';
      const checkbox = document.getElementById('autoRefresh');
      checkbox.checked = localStorage.getItem(KEY) !== '0'; // on by default
      let timer = null;
      function reschedule() {
        if (timer) clearInterval(timer);
        timer = checkbox.checked ? setInterval(refreshBoat, 5000) : null;
      }
      checkbox.addEventListener('change', () => {
        localStorage.setItem(KEY, checkbox.checked ? '1' : '0');
        reschedule();
      });
      reschedule();
    })();
  </script>
</body>
</html>`;
}

// Serves the boat's own admin dashboard - same idea as adminServer.js on
// the base, but scoped to this one boat's own state (GPS, radio, course,
// upload activity) rather than a whole fleet. Runs on the same ADMIN_PORT
// by default so the base's dashboard can link to it (see
// stats.recordBoatIp / adminServer.js's statsLink). getPosition is a
// separate, lean callback (see boatAgent.js) - the map page's own
// live-refresh loop (renderMap above) polls GET /api/position instead of
// /api/stats specifically so watching the map doesn't cost a
// fs.readdirSync of the log directory (via countPending) every 5s for
// data it doesn't use.
function startRoverAdminServer({ port, getStats, getPosition }) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(404);
      res.end();
      return;
    }

    if (req.url === '/api/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getStats()));
      return;
    }

    if (req.url === '/api/position') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getPosition()));
      return;
    }

    if (req.url === '/' || req.url === '') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderDashboard(getStats()));
      return;
    }

    if (req.url === '/map') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderMap(getStats()));
      return;
    }

    if (req.url === '/config') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderConfigPage());
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.on('error', (err) => console.error('[roverAdminServer] error:', err.message));
  server.listen(port, () => console.log(`[roverAdminServer] dashboard at http://localhost:${port}`));

  return server;
}

module.exports = { startRoverAdminServer, renderDashboard, renderMap };
