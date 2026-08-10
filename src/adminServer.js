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
</style>
</head>
<body>
  <div class="topbar">
    <h1>Course map</h1>
    <a href="/">&larr; back to dashboard</a>
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
    </div>
    <div class="edit-column" id="editColumn">
      <div class="edit-column-inner">
        <h2>Edit course marks</h2>

        <div class="gps-readout"><span>Browser GPS</span><span class="value" id="browserGpsReadout">—</span></div>
        <button type="button" class="recenter-btn" id="recenterGps">Recenter on my GPS</button>

        <div class="gps-readout"><span>Base RTK GPS</span><span class="value" id="baseGpsReadout">—</span></div>
        <button type="button" class="recenter-btn" id="recenterBaseGps">Recenter on base GPS</button>

        <button type="button" class="recenter-btn" id="recenterMarks">Recenter on marks</button>
        ${markSetRowsHtml}
      </div>
    </div>
  </div>
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
      baseGpsReadout.textContent = '—';
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

    document.getElementById('recenterBaseGps').addEventListener('click', () => {
      if (!lastBaseGpsFix) {
        alert('No GPS is attached to this base station (set GPS_PORT to enable one when running the base), or it hasn\\'t produced a fix yet.');
        return;
      }
      map.setView([lastBaseGpsFix.lat, lastBaseGpsFix.lon], map.getZoom());
    });

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
  </script>
</body>
</html>`;
}

// Reads and JSON-parses a request body - only the mark-editing POST route
// below needs this, everything else on this server is GET/no-body, so
// this doesn't need to be anything fancier than accumulate-then-parse.
// Capped well above any real {lat, lon} payload's size so a malformed or
// hostile client can't hold the connection open buffering an unbounded
// body.
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
function startAdminServer({ port, getStats, getPositions, setMark, getBaseGps }) {
  const server = http.createServer(async (req, res) => {
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
