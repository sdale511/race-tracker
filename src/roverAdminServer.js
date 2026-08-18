const http = require('http');
const { formatAgo, formatDuration, formatBytes, pct } = require('./dashboardFormat');
const { MARK_NAMES, MARK_COLORS, markStroke, distanceMeters, bearingDeg, compassDir } = require('./course');
const { renderConfigPage } = require('./configReport');
const { zonePolygon } = require('./onGridWatcher');
const config = require('./config');

function fixQualityText(f) {
  if (f.carrSoln === 2) return 'RTK fixed';
  if (f.carrSoln === 1) return 'RTK float';
  if (f.gnssFixOk) return 'GPS';
  return 'No fix';
}

// Dilution of precision - how much the current satellite geometry is
// amplifying measurement error, independent of hAcc/vAcc. Same rough bands
// as adminServer.js's own copy (duplicated rather than imported, same as
// buildCourseInfoHtml below): under 2 is about as good as GPS geometry
// gets, 2-5 is normal good-sky conditions, 5-10 a partially obstructed
// view, above 10 treat the fix with real suspicion.
function dopQualityText(dop) {
  if (dop < 2) return 'excellent';
  if (dop < 5) return 'good';
  if (dop < 10) return 'fair';
  return 'poor';
}

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
  .stat-rows { display: flex; flex-direction: column; gap: 5px; margin-top: 6px; }
  .stat-row { display: flex; align-items: baseline; gap: 10px; font-size: 12px; }
  .stat-row .name { flex-shrink: 0; color: #8b94a3; }
  .stat-row .val { color: #e6e9ef; font-variant-numeric: tabular-nums; margin-left: auto; text-align: right; }
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
      <div class="stat-rows">${
        fix
          ? [
              { label: 'Position', value: `${fix.lat.toFixed(6)}, ${fix.lon.toFixed(6)}` },
              fix.hMSLMm != null
                ? {
                    label: 'Altitude',
                    value: `${(fix.hMSLMm / 1000).toFixed(2)}m MSL${fix.heightMm != null ? ` / ${(fix.heightMm / 1000).toFixed(2)}m ellipsoid` : ''}`,
                  }
                : null,
              fix.gSpeedMmS != null ? { label: 'Speed', value: `${((fix.gSpeedMmS / 1000 / 1852) * 3600).toFixed(1)}kn` } : null,
              fix.headMotDeg != null && fix.gSpeedMmS > 0 ? { label: 'Heading', value: `${fix.headMotDeg.toFixed(0)}&deg;` } : null,
            ]
              .filter(Boolean)
              .map((r) => `<div class="stat-row"><span class="name">${r.label}</span><span class="val">${r.value}</span></div>`)
              .join('')
          : '<div class="stat-row"><span class="name">no fix yet</span></div>'
      }</div>
    </div>
    <div class="card">
      <div class="label">Fix quality</div>
      <div class="value">${fix ? fixQualityText(fix) : '—'}</div>
      <div class="stat-rows">${
        fix
          ? [
              { label: 'diffSoln', value: `${fix.diffSoln}` },
              { label: 'carrSoln', value: `${fix.carrSoln}` },
              { label: 'Satellites', value: `${fix.numSV}` },
              {
                label: 'Accuracy',
                value: `&plusmn;${(fix.hAccMm / 1000).toFixed(2)}m horiz${fix.vAccMm != null ? ` / &plusmn;${(fix.vAccMm / 1000).toFixed(2)}m vert` : ''}`,
              },
              fix.pDOP != null ? { label: 'DOP', value: `${fix.pDOP.toFixed(2)} (${dopQualityText(fix.pDOP)})` } : null,
            ]
              .filter(Boolean)
              .map((r) => `<div class="stat-row"><span class="name">${r.label}</span><span class="val">${r.value}</span></div>`)
              .join('')
          : ''
      }</div>
    </div>
    ${
      s.currentMarks
        ? `<div class="card marks-card">
      <div class="label">Course marks</div>
      <div class="sub">last update ${
        s.lastMarksReceivedAt == null ? 'unknown' : `${Math.floor((Date.now() - s.lastMarksReceivedAt) / 1000)}s ago`
      }</div>
      <div class="marks-mini">
        ${MARK_NAMES.map((name) => {
          const m = s.currentMarks[name];
          return `<div class="mark-row"><span class="dot" style="background:${MARK_COLORS[name]}; box-shadow: inset 0 0 0 1.5px ${markStroke(name)}"></span><span class="name">${name}</span><span class="coords">${m.lat.toFixed(4)}, ${m.lon.toFixed(4)}</span></div>`;
        }).join('')}
      </div>
    </div>`
        : `<div class="card">
      <div class="label">Course marks</div>
      <div class="value">waiting</div>
      <div class="sub">no course broadcast received yet</div>
    </div>`
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
// Floating card in the map page's top-left corner, showing the start/finish
// line's own length and bearing plus a compass heading from committee to
// each windward/leeward mark - the numbers a race committee actually calls
// out on the water, not just raw mark coordinates. Bearings are all
// measured FROM committee, matching how an operator standing at the
// committee boat would actually read them - not from this boat's own live
// position, which would make every reading shift as the boat moves. Same
// as adminServer.js's own copy - see its comment for why this file doesn't
// import that one instead.
function buildCourseInfoHtml(marks) {
  const startLineM = distanceMeters(marks.pin, marks.committee);
  const startLineBearing = bearingDeg(marks.committee, marks.pin);
  const finishLineM = distanceMeters(marks.committee, marks.finish);
  const finishLineBearing = bearingDeg(marks.committee, marks.finish);
  const headingRows = ['windwardBlack', 'windwardGreen', 'leewardGreen', 'leewardBlack']
    .map((name) => {
      const label = name[0].toUpperCase() + name.slice(1);
      const bearing = bearingDeg(marks.committee, marks[name]);
      return `<div class="course-info-row"><span class="label">Hdg &rarr; ${label}</span><span class="value">${Math.round(bearing)}&deg; ${compassDir(bearing)}</span></div>`;
    })
    .join('');
  return `<div class="course-info-card">
    <div class="course-info-title">Course</div>
    <div class="course-info-row"><span class="label">Start line</span><span class="value">${Math.round(startLineM)} m &middot; ${Math.round(startLineBearing)}&deg; ${compassDir(startLineBearing)}</span></div>
    <div class="course-info-row"><span class="label">Finish line</span><span class="value">${Math.round(finishLineM)} m &middot; ${Math.round(finishLineBearing)}&deg; ${compassDir(finishLineBearing)}</span></div>
    ${headingRows}
  </div>`;
}

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
    L.polyline([[${marks.leewardBlack.lat}, ${marks.leewardBlack.lon}], [${marks.windwardBlack.lat}, ${marks.windwardBlack.lon}]], { color: '#e6e9ef', weight: 1, dashArray: '2 8' }).addTo(map);
    // On-grid detection zone - the exact quadrilateral OnGridWatcher.check
    // itself tests against (see onGridWatcher.js's zonePolygon), not a
    // separately-eyeballed approximation, so this can never show a
    // different zone than what actually gets detected as on-grid.
    L.polygon(${JSON.stringify(zonePolygon(marks, config.regattaup.onGridZoneM).map((p) => [p.lat, p.lon]))}, { color: '${MARK_COLORS.pin}', weight: 2, dashArray: '4 6', fillColor: '${MARK_COLORS.pin}', fillOpacity: 0.08 }).addTo(map);`
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

  // Editing only makes sense once this boat actually knows a course to
  // edit, and only works when it knows where to send the edit - a real
  // rover has no Redis access of its own (see baseStation.js's
  // mark-broadcast comment), so "Set" here doesn't write anything
  // locally, it POSTs to the base's own /api/marks/:name cross-origin
  // (see the base admin/adminPort learned from the marks broadcast,
  // same address already used for the "base dashboard" link above) -
  // only reachable when this boat currently has WiFi connectivity to the
  // base, same requirement as log uploads.
  const canEditMarks = !!marks && !!s.baseIp;
  const markSetRowsHtml = canEditMarks
    ? MARK_NAMES.map(
        (name) =>
          `<div class="mark-set-row">
        <span class="dot" style="background:${MARK_COLORS[name]}; box-shadow: inset 0 0 0 1.5px ${markStroke(name)}"></span>
        <span class="name">${name}</span>
        <button type="button" class="set-mark-btn" data-mark="${name}">Set</button>
      </div>`
      ).join('')
    : '';
  const markBoundsJs = marks ? `[${MARK_NAMES.map((name) => `[${marks[name].lat}, ${marks[name].lon}]`).join(', ')}]` : '[]';
  const courseInfoHtml = marks ? buildCourseInfoHtml(marks) : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>boat ${s.boatId} map</title>
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
  .topbar .muted { color: #8b94a3; }
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
  .course-info-title { font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 8px; }
  .course-info-row { display: flex; justify-content: space-between; align-items: baseline; gap: 18px; padding: 4px 0; font-size: 13px; }
  .course-info-row .label { color: #8a94a3; }
  .course-info-row .value { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }

  /* Edit mode - see the matching block in adminServer.js's renderMap for
     the overall design (a map area that shrinks for a column of "set
     this mark here" buttons, plus a crosshair fixed at its exact
     center). */
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
    <h1>Boat ${s.boatId} map</h1>
    <span class="muted" id="fixStatus">${fix ? `last fix ${fixStale ? 'stale, ' : ''}${formatAgo(fix.timestamp)}` : 'no GPS fix yet'}</span>
    <a href="/">&larr; back to dashboard</a>
    <div class="spacer"></div>
    ${
      canEditMarks
        ? `<label class="refresh-toggle">
      <input type="checkbox" id="editToggle">
      edit marks
    </label>`
        : ''
    }
    <label class="refresh-toggle">
      <input type="checkbox" id="autoRefresh">
      auto-refresh (5s)
    </label>
  </div>
  <div class="main">
    <div class="map-wrap">
      <div id="map"></div>
      <div class="crosshair" id="crosshair"></div>
      ${courseInfoHtml}
    </div>
    ${
      canEditMarks
        ? `<div class="edit-column" id="editColumn">
      <div class="edit-column-inner">
        <h2>Edit course marks</h2>
        <div class="muted" style="font-size:11px;margin-bottom:10px;">Edits are sent to the base at ${s.baseIp}:${s.adminPort} - only works while this boat has WiFi connectivity to it, same as log uploads.</div>

        <div class="gps-readout"><span>Boat RTK GPS</span><span class="value" id="boatGpsReadout">${
          fix
            ? `${fix.lat.toFixed(6)}, ${fix.lon.toFixed(6)} (${
                fix.carrSoln === 2 ? 'RTK fixed' : fix.carrSoln === 1 ? 'RTK float' : fix.gnssFixOk ? 'GPS' : 'no fix'
              }, ±${(fix.hAccMm / 1000).toFixed(2)}m)`
            : '—'
        }</span></div>
        <button type="button" class="recenter-btn" id="recenterBoatGps">Recenter on boat GPS</button>

        <div class="gps-readout"><span>Browser GPS</span><span class="value" id="browserGpsReadout">—</span></div>
        <button type="button" class="recenter-btn" id="recenterGps">Recenter on my GPS</button>

        <button type="button" class="recenter-btn" id="recenterMarks">Recenter on marks</button>
        ${markSetRowsHtml}
      </div>
    </div>`
        : ''
    }
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
    let boatMarker = null;
    // Kept live by refreshBoat() below, used by the edit column's
    // "Recenter on boat GPS" button (see the canEditMarks block further
    // down) - initialized from the server-rendered fix so it's usable
    // immediately on page load, before the first refresh tick.
    let lastKnownFix = ${fix ? `{ lat: ${fix.lat}, lon: ${fix.lon} }` : 'null'};
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 22,
      maxNativeZoom: 19,
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
      const boatGpsReadout = document.getElementById('boatGpsReadout');
      if (!pos) {
        fixStatusEl.textContent = 'no GPS fix yet';
        return;
      }
      lastKnownFix = { lat: pos.lat, lon: pos.lon };
      if (boatGpsReadout) {
        boatGpsReadout.textContent =
          pos.lat.toFixed(6) + ', ' + pos.lon.toFixed(6) + ' (' + fixQualityText(pos) + ', ±' + (pos.hAccMm / 1000).toFixed(2) + 'm)';
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
    ${
      canEditMarks
        ? `
    const editModeKey = 'raceTrackerMapEditMode';
    const editColumn = document.getElementById('editColumn');
    const crosshair = document.getElementById('crosshair');
    const editToggle = document.getElementById('editToggle');
    const browserGpsReadout = document.getElementById('browserGpsReadout');
    let lastBrowserPos = null; // {lat, lon}, kept live by the watch below
    let geoWatchId = null;

    function fixQualityText(f) {
      if (f.carrSoln === 2) return 'RTK fixed';
      if (f.carrSoln === 1) return 'RTK float';
      if (f.gnssFixOk) return 'GPS';
      return 'no fix';
    }

    // A one-shot getCurrentPosition() call defaults to low accuracy with
    // no timeout - it can silently hang for a long time (or forever) if
    // the browser's location provider is struggling, and "Recenter on my
    // GPS" would just look broken with no feedback either way.
    // watchPosition with enableHighAccuracy instead keeps a continuous
    // stream running the whole time edit mode is on - the readout shows
    // whether it's actually gotten a fix yet, and by the time you go to
    // click "Recenter" a fresh position is usually already sitting there.
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

    function applyEditMode(checked) {
      editColumn.classList.toggle('visible', checked);
      crosshair.classList.toggle('visible', checked);
      // Leaflet caches its container size - the column's width
      // transitions via CSS, not instantly, so this has to wait for
      // that to settle rather than measuring the pre-transition size.
      setTimeout(() => map.invalidateSize(), 200);
      if (checked) {
        startBrowserGpsWatch();
      } else {
        // A continuous GPS watch has a real battery/permission-indicator
        // cost - no reason to keep it running once the column showing
        // the result isn't even visible.
        stopBrowserGpsWatch();
      }
    }

    // Persisted like auto-refresh above (localStorage, off by default) -
    // setting a mark still requires its own explicit confirm() further
    // down, so remembering the column's open/closed state across reloads
    // doesn't risk an accidental edit, just saves re-opening it every visit.
    editToggle.checked = localStorage.getItem(editModeKey) === '1';
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

    // This boat's own GPS, kept live by refreshBoat() above - already
    // flowing regardless of edit mode, so this just reuses whatever it
    // last saw rather than needing its own separate polling.
    document.getElementById('recenterBoatGps').addEventListener('click', () => {
      if (!lastKnownFix) {
        alert('No GPS fix from this boat yet.');
        return;
      }
      map.setView([lastKnownFix.lat, lastKnownFix.lon], map.getZoom());
    });

    const markBounds = ${markBoundsJs};
    document.getElementById('recenterMarks').addEventListener('click', () => {
      map.fitBounds(markBounds, { padding: [60, 60], maxZoom: 18 });
    });

    // Unlike the base's own edit column, this doesn't write anywhere
    // locally - this boat has no Redis access of its own (see this
    // function's module comment), so "Set" POSTs cross-origin straight
    // to the base's own /api/marks/:name (see adminServer.js, which has
    // CORS enabled specifically for this). Only works while this boat
    // currently has WiFi reachability to the base - same requirement as
    // log uploads, nothing to do with the radio link.
    const baseMarksUrl = 'http://${s.baseIp}:${s.adminPort}/api/marks/';
    document.querySelectorAll('.set-mark-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.mark;
        const center = map.getCenter();
        const latText = center.lat.toFixed(6);
        const lonText = center.lng.toFixed(6);
        if (!confirm('Set ' + name + ' to ' + latText + ', ' + lonText + ' on the base course?\\n\\nThis updates the live course and re-broadcasts it to every boat immediately.')) {
          return;
        }
        btn.disabled = true;
        try {
          const res = await fetch(baseMarksUrl + encodeURIComponent(name), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat: center.lat, lon: center.lng })
          });
          const body = await res.json();
          if (!res.ok || !body.ok) throw new Error(body.error || ('HTTP ' + res.status));
          // Not reloading - this boat's own currentMarks won't reflect
          // the change until the next broadcast actually reaches it
          // (course marks aren't a live-polled loop on this page, see
          // refreshBoat above), so a reload right now would just show
          // the same pre-edit positions.
          alert('Set ' + name + '. This boat will pick up the change once the next marks broadcast reaches it (usually within moments) - reload afterward to see it reflected here.');
        } catch (err) {
          alert('Failed to set ' + name + ' - could not reach the base (' + err.message + '). Make sure this boat currently has WiFi connectivity to it.');
        } finally {
          btn.disabled = false;
        }
      });
    });
    `
        : ''
    }
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
