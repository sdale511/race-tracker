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
  <div class="subtitle">RTK-only mode - monitors/configures the base GPS receiver only, no telemetry radio, course, or regatta &nbsp;&middot;&nbsp; refreshes every 5s &nbsp;&middot;&nbsp; <a href="/config">config</a></div>
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
