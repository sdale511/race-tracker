// Minimal standalone admin dashboard for "RTK-only" mode (see
// rtkStation.js/README's "RTK-only mode" section) - just the base GPS
// receiver's own status and TMODE3/survey-in controls, none of
// adminServer.js's telemetry radio, course, fleet, or RegattaUp concerns.
// Renders the exact same cards adminServer.js's own "Base GPS" section
// does (see rtkAdminCards.js) against the exact same API shape
// (getFix/getSurveyStatus/setSurveyIn/setFixed/saveConfig - see baseGps.js)
// - this is a smaller window onto identical behavior, not a second
// implementation of it.
const http = require('http');
const {
  renderBaseGpsCard,
  renderBaseGpsSurveyCard,
  renderManualFixedPositionCard,
  RTK_CLIENT_JS,
  RTK_CARD_CSS,
} = require('./rtkAdminCards');
// Same fully-resolved config dump/GET /config page every other dashboard
// (adminServer.js, roverAdminServer.js) already links to - see
// configReport.js's own comment on why it's role-filtered (each dashboard
// only shows the settings it actually reads).
const { renderConfigPage } = require('./configReport');
// Same "Disk space" card base/boat's dashboards already show - see its own
// module comment on why a full SD card matters here too, even though this
// mode itself writes nothing to disk.
const { renderDiskCard } = require('./dashboardFormat');

// Same generic "buffer the body, parse as JSON, cap the size" helper
// adminServer.js keeps its own copy of - small and domain-free enough
// (nothing GPS-specific in it) that duplicating it here is simpler than
// threading a shared-utility import through both servers for 15 lines.
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

function renderPage({ fix, survey, gpsPort, connected, disk }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>race-tracker RTK</title>
<meta http-equiv="refresh" content="5">
<style>${RTK_CARD_CSS}</style>
</head>
<body>
  <h1>RTK base GPS</h1>
  <div class="subtitle">RTK-only mode - monitors/configures the base GPS receiver only, no telemetry radio, course, or regatta &nbsp;&middot;&nbsp; refreshes every 5s &nbsp;&middot;&nbsp; <a href="/map">map</a> &nbsp;&middot;&nbsp; <a href="/config">config</a></div>
  <div class="grid">
    ${renderBaseGpsCard(fix, gpsPort, connected)}
    ${renderBaseGpsSurveyCard(survey, fix)}
    ${renderManualFixedPositionCard(survey, fix)}
    ${renderDiskCard(disk, 'This mode writes no logs of its own - just a general low-disk warning for this machine')}
  </div>
  <script>${RTK_CLIENT_JS}</script>
</body>
</html>`;
}

// Full-page map of where this base thinks it is - /map. Two markers: the live
// antenna fix (NAV-PVT) and the reference position the receiver is using
// (the fixed TMODE3 position, or the survey-in result so far). The gap
// between them is what an operator wants to see before trusting corrections
// to rovers: a survey that's still wandering, or a fixed position typed in a
// few metres off from where the antenna actually is. Polls the same
// /api/gps and /api/gps/survey endpoints the cards use, so it updates in
// place without the main page's 5s reload throwing away the operator's
// zoom/pan. Leaflet and the imagery tiles come from the internet (same as
// adminServer.js's course map); with no connection the readout panel still
// works, just without a basemap.
function renderMapPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>race-tracker RTK map</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; background: #0f1216; color: #e6e9ef; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  #map { position: absolute; inset: 0; background: #0f1216; }
  #panel { position: absolute; top: 12px; left: 12px; z-index: 1000; background: rgba(15,18,22,0.92); border: 1px solid #2a313b; border-radius: 8px; padding: 12px 14px; font-size: 13px; max-width: 320px; line-height: 1.5; }
  #panel h1 { font-size: 15px; margin: 0 0 6px; }
  #panel .row { display: flex; justify-content: space-between; gap: 16px; }
  #panel .name { color: #8b94a3; }
  #panel a, #panel button { color: #58a6ff; background: none; border: 0; padding: 0; font: inherit; cursor: pointer; text-decoration: underline; }
  #msg { color: #e3b341; margin-top: 6px; }
  .legend-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
</style>
</head>
<body>
  <div id="map"></div>
  <div id="panel">
    <h1>Where the RTK base thinks it is</h1>
    <div><span class="legend-dot" style="background:#3b82f6"></span>Live GPS fix &nbsp; <span class="legend-dot" style="background:#ef4444"></span>Reference position</div>
    <div id="rows"></div>
    <div id="msg"></div>
    <div style="margin-top:8px;"><button type="button" id="recenter">Recenter</button> &nbsp;&middot;&nbsp; <a href="/">Back to dashboard</a></div>
  </div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
  <script>
    var hasMap = typeof L !== 'undefined';
    var map = null, liveMarker = null, liveCircle = null, refMarker = null, refCircle = null, link = null, fitted = false;
    if (hasMap) {
      map = L.map('map', { maxZoom: 22 }).setView([0, 0], 2);
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 22, maxNativeZoom: 19, attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
      }).addTo(map);
    }

    function isNum(v) { return typeof v === 'number' && isFinite(v); }
    function distanceM(a, b) {
      var R = 6371000, toRad = Math.PI / 180;
      var dLat = (b.lat - a.lat) * toRad, dLon = (b.lon - a.lon) * toRad;
      var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
      return 2 * R * Math.asin(Math.sqrt(h));
    }
    function quality(f) {
      if (f.carrSoln === 2) return 'RTK fixed';
      if (f.carrSoln === 1) return 'RTK float';
      if (f.gnssFixOk) return 'GPS';
      return 'No fix';
    }

    // The position the receiver is using as its reference: the fixed TMODE3
    // position if one is set, otherwise the survey-in mean so far. Null when
    // neither exists (TMODE3 disabled, or a survey that hasn't started).
    function referencePos(sv) {
      if (!sv) return null;
      var fp = sv.fixedPosition;
      if (sv.mode === 2 && fp && isNum(fp.lat) && isNum(fp.lon)) {
        return { lat: fp.lat, lon: fp.lon, accM: isNum(fp.fixedPosAccMm) ? fp.fixedPosAccMm / 1000 : null, label: 'Fixed reference position (what rovers are corrected against)' };
      }
      var s = sv.survey;
      if (s && (s.active || s.valid) && s.observations > 0 && isNum(s.lat) && isNum(s.lon)) {
        return { lat: s.lat, lon: s.lon, accM: isNum(s.meanAccMm) ? s.meanAccMm / 1000 : null, label: s.valid ? 'Survey-in result (valid)' : 'Survey-in in progress (still moving)' };
      }
      return null;
    }

    function setRows(items) {
      var box = document.getElementById('rows');
      box.textContent = '';
      items.forEach(function (it) {
        var row = document.createElement('div'); row.className = 'row';
        var n = document.createElement('span'); n.className = 'name'; n.textContent = it[0];
        var v = document.createElement('span'); v.textContent = it[1];
        row.appendChild(n); row.appendChild(v); box.appendChild(row);
      });
    }

    function place(kind, pos, accM, color, label) {
      if (!hasMap) return;
      var marker = kind === 'live' ? liveMarker : refMarker, circle = kind === 'live' ? liveCircle : refCircle;
      var ll = [pos.lat, pos.lon];
      if (!marker) {
        marker = L.circleMarker(ll, { radius: kind === 'live' ? 7 : 9, color: color, weight: 3, fillColor: color, fillOpacity: kind === 'live' ? 0.9 : 0.2 }).addTo(map);
        circle = L.circle(ll, { radius: accM || 0.01, color: color, weight: 1, fillOpacity: 0.08 }).addTo(map);
      } else {
        marker.setLatLng(ll); circle.setLatLng(ll); circle.setRadius(accM || 0.01);
      }
      marker.bindTooltip(label, { direction: 'top' });
      if (kind === 'live') { liveMarker = marker; liveCircle = circle; } else { refMarker = marker; refCircle = circle; }
    }

    function clear(kind) {
      if (!hasMap) return;
      if (kind === 'live' && liveMarker) { map.removeLayer(liveMarker); map.removeLayer(liveCircle); liveMarker = liveCircle = null; }
      if (kind === 'ref' && refMarker) { map.removeLayer(refMarker); map.removeLayer(refCircle); refMarker = refCircle = null; }
    }

    var last = { live: null, ref: null };
    function fit() {
      if (!hasMap) return;
      var pts = [];
      if (last.live) pts.push([last.live.lat, last.live.lon]);
      if (last.ref) pts.push([last.ref.lat, last.ref.lon]);
      if (!pts.length) return;
      if (pts.length === 1) map.setView(pts[0], 18);
      else map.fitBounds(pts, { padding: [80, 80], maxZoom: 19 });
      fitted = true;
    }
    document.getElementById('recenter').addEventListener('click', fit);

    async function poll() {
      var msg = [];
      try {
        var res = await Promise.all([fetch('/api/gps').then(function (r) { return r.json(); }), fetch('/api/gps/survey').then(function (r) { return r.json(); })]);
        var fix = res[0], sv = res[1];
        var rows = [];

        var live = fix && isNum(fix.lat) && isNum(fix.lon) && !(fix.lat === 0 && fix.lon === 0) ? { lat: fix.lat, lon: fix.lon } : null;
        var ref = referencePos(sv);
        last.live = live; last.ref = ref;

        if (live) {
          var hasFix = !!(fix.gnssFixOk && fix.fixType >= 2);
          place('live', live, isNum(fix.hAccMm) ? fix.hAccMm / 1000 : null, hasFix ? '#3b82f6' : '#8b94a3',
            hasFix ? 'Live GPS fix' : 'Last known position - the receiver has NO fix, so this may be stale');
          rows.push(['Live fix', live.lat.toFixed(7) + ', ' + live.lon.toFixed(7)]);
          rows.push(['Quality', quality(fix) + (isNum(fix.numSV) ? ' (' + fix.numSV + ' sats)' : '')]);
          if (isNum(fix.hAccMm)) rows.push(['Accuracy', '±' + (fix.hAccMm / 1000).toFixed(2) + ' m']);
          if (!hasFix) msg.push('The receiver reports no position fix, so the live position above may be stale (the last one it remembered).');
        } else {
          clear('live');
          msg.push('No live GPS position yet.');
        }

        if (ref) {
          place('ref', ref, ref.accM, '#ef4444', ref.label);
          rows.push(['Reference', ref.lat.toFixed(7) + ', ' + ref.lon.toFixed(7)]);
          if (ref.accM != null) rows.push(['Reference accuracy', '±' + ref.accM.toFixed(3) + ' m']);
          rows.push(['Reference is', ref.label]);
        } else {
          clear('ref');
          msg.push(sv && sv.modeText ? 'No reference position: base mode is "' + sv.modeText + '" (start survey-in or set a fixed position on the dashboard).' : 'No reference position: base mode not read from the receiver yet.');
        }

        if (live && ref) rows.push(['Live fix to reference', distanceM(live, ref).toFixed(2) + ' m']);
        if (sv && sv.modeText) rows.unshift(['Base mode', sv.modeText]);
        setRows(rows);
        if (!fitted && (live || ref)) fit();
      } catch (e) {
        msg.push('Could not read the base GPS: ' + e.message);
      }
      if (!hasMap) msg.push('Map library could not load (no internet?) - the readout above still updates.');
      document.getElementById('msg').textContent = msg.join(' ');
    }
    poll();
    setInterval(poll, 2000);
  </script>
</body>
</html>`;
}

function startRtkAdminServer({ port, getFix, getSurveyStatus, setSurveyIn, setFixed, saveConfig, gpsPort, isConnected, getDisk }) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/gps/survey/mode' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        if (body.mode === 'survey-in') setSurveyIn();
        else if (body.mode === 'fixed') {
          // lat/lon/heightM present means the dashboard's manual-entry form
          // was used (an operator-typed known-good position) rather than
          // the plain "Use as fixed position" button, which sends none of
          // these and lets setFixed fall back to survey-in/live-fix itself.
          const manualPos =
            body.lat != null || body.lon != null || body.heightM != null
              ? { lat: Number(body.lat), lon: Number(body.lon), heightM: Number(body.heightM) }
              : null;
          setFixed(manualPos);
        } else throw new Error(`unknown mode "${body.mode}"`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.url === '/api/gps/save-config' && req.method === 'POST') {
      try {
        saveConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
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

    if (req.url === '/map') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderMapPage());
      return;
    }

    if (req.url === '/api/gps') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getFix()));
      return;
    }

    if (req.url === '/api/gps/survey') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getSurveyStatus()));
      return;
    }

    if (req.url === '/config') {
      // Only the settings this mode actually reads - see configReport.js's
      // own `roles` tags and renderConfigPage's `role` param.
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderConfigPage({ role: 'rtk' }));
      return;
    }

    if (req.url === '/' || req.url === '') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        renderPage({
          fix: getFix(),
          survey: getSurveyStatus(),
          gpsPort,
          connected: isConnected(),
          disk: getDisk(),
        })
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });
  // The "dashboard on :..." announcement itself is logged by rtkStation.js,
  // not here - same "caller logs it once, this module stays silent about
  // its own listen" convention adminServer.js/roverAdminServer.js already
  // use, so it isn't announced twice.
  server.listen(port);
  return server;
}

module.exports = { startRtkAdminServer };
