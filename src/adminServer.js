const http = require('http');
const { formatAgo, formatDuration, formatBytes, pct } = require('./dashboardFormat');
const { MARK_NAMES, MARK_COLORS, markStroke } = require('./course');
const { renderConfigPage } = require('./configReport');

// A boat is "online" if we've heard a position frame from it recently - a
// looser threshold than any single TX_DISTANCE_M-driven gap, just enough to
// tell "actively out there" from "was here earlier, gone quiet."
const ONLINE_THRESHOLD_MS = 60000;

// Renders the whole dashboard server-side from one stats snapshot (see
// baseStation.js's getFullStats) - simpler than shipping a client-side
// templating setup for what's fundamentally a page that reloads its data
// every few seconds anyway.
function renderDashboard(s) {
  // Most recently seen first, so an active fleet naturally floats to the
  // top instead of being scattered through however boat IDs happen to be
  // numbered. Boats never heard from this session (lastSeen null - e.g.
  // known only via the on-disk upload-history scan, see
  // baseStation.js's uploadDirBaseline) sink to the bottom, ordered by
  // boat ID among themselves for a stable, predictable position.
  const boatIds = Object.keys(s.boats).sort((a, b) => {
    const aSeen = s.boats[a].lastSeen;
    const bSeen = s.boats[b].lastSeen;
    if (aSeen == null && bSeen == null) return Number(a) - Number(b);
    if (aSeen == null) return 1;
    if (bSeen == null) return -1;
    return bSeen - aSeen;
  });
  const totalPending = boatIds.reduce((sum, id) => sum + (s.boats[id].pending || 0), 0);

  const boatRows = boatIds
    .map((id) => {
      const b = s.boats[id];
      const online = b.lastSeen && Date.now() - b.lastSeen < ONLINE_THRESHOLD_MS;
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
      return `
        <tr>
          <td><span class="dot ${online ? 'dot-green' : 'dot-gray'}"></span>boat ${id}</td>
          <td>${formatAgo(b.lastSeen)}</td>
          <td>${tracks.toLocaleString()}</td>
          <td>${laps}</td>
          <td>${b.upload.successes} / ${b.upload.attempts} <span class="muted">(${pct(b.upload.successes, b.upload.attempts)})</span></td>
          <td>${b.pending ?? '—'}</td>
          <td>${formatBytes(b.upload.bytes)}</td>
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
  <h1>race-tracker admin</h1>
  <div class="subtitle">
    <span class="dot ${s.base.redisConnected ? 'dot-green' : 'dot-red'}"></span>Redis ${s.base.redisConnected ? 'connected' : 'disconnected'}
    &nbsp;·&nbsp; uptime ${formatDuration(s.uptimeMs)}
    &nbsp;·&nbsp; upload address ${s.base.ip ? `${s.base.ip}:${s.base.uploadPort}` : 'unknown'}
    &nbsp;·&nbsp; refreshes every 5s
    &nbsp;·&nbsp; <a href="/config">config</a>
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
      <div class="label">Uploaded files</div>
      <div class="value">${s.upload.successes.toLocaleString()}</div>
      <div class="sub">${formatBytes(s.upload.bytesTotal)} total</div>
    </div>
    <div class="card">
      <div class="label">Upload attempts</div>
      <div class="value">${s.upload.attempts.toLocaleString()}</div>
      <div class="sub">${pct(s.upload.successes, s.upload.attempts)} success rate</div>
    </div>
    <div class="card">
      <div class="label">Pending uploads</div>
      <div class="value">${totalPending}</div>
      <div class="sub">across all boats, self-reported</div>
    </div>
    <div class="card">
      <div class="label">Upload failures</div>
      <div class="value">${s.upload.failures.toLocaleString()}</div>
    </div>
    <div class="card">
      <div class="label">Radio frames</div>
      <div class="value">${s.radio.framesReceived.toLocaleString()}</div>
      <div class="sub">${s.radio.syncErrors.toLocaleString()} sync errors (${pct(s.radio.syncErrors, s.radio.framesReceived + s.radio.syncErrors)})</div>
    </div>
    <div class="card">
      <div class="label">Course</div>
      <div class="value">${s.course ? 'set' : 'none'}</div>
      <div class="sub">${s.course ? `${Object.keys(s.course.marks).length} marks published` : 'waiting for marks'}</div>
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
      </div>
    </div>`
        : ''
    }
    <div class="card">
      <div class="label">RegattaUp webhook</div>
      <div class="value">${s.webhook.enabled ? 'on' : 'off'}</div>
      <div class="sub">${s.webhook.queueReady ? 'queue ready' : 'queue initializing'}</div>
    </div>
  </div>

  <section>
    <h2>Fleet</h2>
    ${
      boatIds.length === 0
        ? '<div class="card empty">No boats heard from yet.</div>'
        : `<table>
      <thead>
        <tr><th>Boat</th><th>Last seen</th><th>Tracks</th><th>Laps</th><th>Uploads this session</th><th>Pending</th><th>Bytes sent (session)</th><th>Files on disk (all-time)</th><th>Rover dashboard</th></tr>
      </thead>
      <tbody>${boatRows}</tbody>
    </table>`
    }
  </section>
</body>
</html>`;
}

// A full-page map view of the course (see "Course marks" section of
// renderDashboard above, which links here) - Leaflet + OpenStreetMap/CARTO
// tiles loaded from their public CDNs, so this needs the viewing browser to
// have internet access (the base station's own connectivity to publish
// marks/tracks does not matter here - this is rendered in whoever's
// looking at the dashboard). No live boat positions, just the five marks
// and the start/finish lines between them - this is a course reference
// view, not a live tracking map.
function renderMap(s) {
  if (!s.course) {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>race-tracker course map</title>
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
<body>No course marks published yet.<a href="/">&larr; back to dashboard</a></body>
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

  const boundsPoints = [
    ...MARK_NAMES.map((name) => `[${marks[name].lat}, ${marks[name].lon}]`),
    ...boatIds.map((id) => `[${s.boats[id].lastPosition.lat}, ${s.boats[id].lastPosition.lon}]`),
  ];
  const boundsJs = `[${boundsPoints.join(', ')}]`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>race-tracker course map</title>
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
    <h1>Course map</h1>
    <a href="/">&larr; back to dashboard</a>
    <div class="spacer"></div>
    <label class="refresh-toggle">
      <input type="checkbox" id="autoRefresh">
      auto-refresh boats (5s)
    </label>
  </div>
  <div id="map"></div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
  <script>
    const map = L.map('map', { zoomControl: true });
    const boatMarkers = {};
    // Satellite imagery, not a street/vector basemap - these courses are
    // typically raced on a dry lake bed (Black Rock Desert-style playa)
    // with no roads or buildings for a vector basemap to draw, which made
    // an OSM/CARTO-style layer render as an almost-empty void at any
    // useful zoom. Imagery actually shows the ground.
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
    }).addTo(map);

    ${markersJs}
    ${boatMarkersJs}

    // Start line (pin <-> committee) and finish gate (committee <-> finish).
    L.polyline([[${marks.pin.lat}, ${marks.pin.lon}], [${marks.committee.lat}, ${marks.committee.lon}]], { color: '${MARK_COLORS.pin}', weight: 2, dashArray: '6 6' }).addTo(map);
    L.polyline([[${marks.committee.lat}, ${marks.committee.lon}], [${marks.finish.lat}, ${marks.finish.lon}]], { color: '${MARK_COLORS.finish}', weight: 2, dashArray: '6 6' }).addTo(map);
    // Course axis (leewardBlack <-> windwardBlack) - just a visual
    // reference; boats actually tack back and forth across this, not sail
    // it directly. Drawn between the black (outer) marks rather than the
    // green ones since both pairs sit on the same axis - one line covers
    // the full extent, green marks included, since they fall on it too.
    L.polyline([[${marks.leewardBlack.lat}, ${marks.leewardBlack.lon}], [${marks.windwardBlack.lat}, ${marks.windwardBlack.lon}]], { color: '#e6e9ef', weight: 1, dashArray: '2 8' }).addTo(map);

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
  </script>
</body>
</html>`;
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
// 5s for data it doesn't use.
function startAdminServer({ port, getStats, getPositions }) {
  const server = http.createServer(async (req, res) => {
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

    if (req.url === '/' || req.url === '') {
      try {
        const s = await getStats();
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderDashboard(s));
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
        res.end(renderMap(s));
      } catch (err) {
        res.writeHead(500);
        res.end(`<pre>${err.message}</pre>`);
      }
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

  server.on('error', (err) => console.error('[adminServer] error:', err.message));
  server.listen(port, () => console.log(`[adminServer] dashboard at http://localhost:${port}`));

  return server;
}

module.exports = { startAdminServer, renderDashboard, renderMap };
