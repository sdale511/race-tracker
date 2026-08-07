const config = require('./config');

// The fully-resolved configuration - every default plus whatever's been
// overridden via environment variables or a .env file - grouped/labeled to
// match config.js's own section comments. Shared source of truth for both
// `npm run print-config` (printConfig.js, console output) and the admin
// dashboards' `GET /config` page (adminServer.js, roverAdminServer.js,
// HTML), so the two presentations can never drift out of sync with each
// other. Rows are objects (label, value, envVar, inverted, unit) rather
// than positional arrays - with five optional fields per row, named keys
// stay readable where array-position magic wouldn't.
//
// Not role-filtered: config.js resolves the exact same object structure
// whether this process is `npm run base` or `npm run boat`, so this list
// (and both dashboards' /config pages) always shows everything, with
// section titles noting the handful that are only actually read by one
// role or the other.
const sections = [
  {
    title: 'Mode',
    rows: [
      { label: 'simulate', value: config.simulate, envVar: 'SIMULATE' },
      { label: 'simulateGps', value: config.simulateGps, envVar: 'SIMULATE_GPS' },
      { label: 'noGps', value: config.noGps, envVar: 'NO_GPS' },
      // testLapNumber doubles as the on/off switch for this test mode (0 =
      // off) and the lap number to report - see config.js's own comment.
      { label: 'testLapBoatId', value: config.testLapBoatId, envVar: 'TEST_LAP_BOAT_ID' },
      { label: 'testLapNumber', value: config.testLapNumber, envVar: 'TEST_LAP_NUMBER' },
    ],
  },
  {
    title: 'Simulation (sim.*, only used when simulate=true)',
    rows: [
      { label: 'port', value: config.sim.port, envVar: 'SIM_PORT' },
      { label: 'gpsHz', value: config.sim.gpsHz, envVar: 'SIM_GPS_HZ', unit: 'Hz' },
      { label: 'upwindSpeedKn', value: config.sim.upwindSpeedKn, envVar: 'SIM_UPWIND_SPEED_KN', unit: 'kn' },
      { label: 'downwindSpeedKn', value: config.sim.downwindSpeedKn, envVar: 'SIM_DOWNWIND_SPEED_KN', unit: 'kn' },
      { label: 'lapCount', value: config.sim.lapCount, envVar: 'SIM_LAP_COUNT', unit: 'laps' },
      { label: 'centerLat', value: config.sim.centerLat, envVar: 'SIM_CENTER_LAT', unit: '°' },
      { label: 'centerLon', value: config.sim.centerLon, envVar: 'SIM_CENTER_LON', unit: '°' },
      { label: 'packetLossPct', value: config.sim.packetLossPct, envVar: 'SIM_PACKET_LOSS', unit: '%' },
    ],
  },
  {
    title: 'GPS (simpleRTK2B LR)',
    rows: [
      { label: 'port', value: config.gps.port, envVar: 'GPS_PORT' },
      { label: 'baud', value: config.gps.baud, envVar: 'GPS_BAUD', unit: 'baud' },
    ],
  },
  {
    title: 'Radio (telemetry)',
    rows: [
      { label: 'enabled', value: config.radio.enabled, envVar: 'NO_RADIO', inverted: true },
      { label: 'port', value: config.radio.port, envVar: 'RADIO_PORT' },
      { label: 'baud', value: config.radio.baud, envVar: 'RADIO_BAUD', unit: 'baud' },
    ],
  },
  {
    title: 'Identity & timing',
    rows: [
      { label: 'boatId', value: config.boatId, envVar: 'BOAT_ID' },
      { label: 'txDistanceM', value: config.txDistanceM, envVar: 'TX_DISTANCE_M', unit: 'm' },
      {
        label: 'marksBroadcastIntervalMs',
        value: config.marksBroadcastIntervalMs,
        envVar: 'MARKS_BROADCAST_INTERVAL_MS',
        unit: 'ms',
      },
    ],
  },
  {
    title: 'Local logging',
    rows: [
      { label: 'logDir', value: config.logDir, envVar: 'LOG_DIR' },
      { label: 'logRetentionDays', value: config.logRetentionDays, envVar: 'LOG_RETENTION_DAYS', unit: 'days' },
      { label: 'logChunkMinutes', value: config.logChunkMinutes, envVar: 'LOG_CHUNK_MINUTES', unit: 'min' },
    ],
  },
  {
    title: 'Log upload over WiFi',
    rows: [
      { label: 'enabled', value: config.upload.enabled, envVar: 'UPLOAD_DISABLED', inverted: true },
      { label: 'port', value: config.upload.port, envVar: 'UPLOAD_PORT' },
      { label: 'dir', value: config.upload.dir, envVar: 'UPLOAD_DIR' },
      { label: 'baseIp', value: config.upload.baseIp || '(auto-detect)', envVar: 'BASE_IP' },
      { label: 'checkIntervalMs', value: config.upload.checkIntervalMs, envVar: 'UPLOAD_CHECK_INTERVAL_MS', unit: 'ms' },
      { label: 'timeoutMs', value: config.upload.timeoutMs, envVar: 'UPLOAD_TIMEOUT_MS', unit: 'ms' },
    ],
  },
  {
    title: 'Admin dashboard',
    rows: [{ label: 'port', value: config.admin.port, envVar: 'ADMIN_PORT' }],
  },
  {
    title: 'Redis (base station only)',
    rows: [
      { label: 'url', value: config.redis.url || '(unset)', envVar: 'REDIS_URL' },
      { label: 'env preset', value: process.env.REDIS_ENV || 'local', envVar: 'REDIS_ENV' },
      { label: 'connection.host', value: config.redis.connection.host },
      { label: 'connection.port', value: config.redis.connection.port },
      { label: 'connection.username', value: config.redis.connection.username || '(none)', envVar: 'REDIS_USERNAME' },
      {
        label: 'connection.password',
        value: config.redis.connection.password ? '***REDACTED***' : '(none)',
        envVar: 'REDIS_PASSWORD',
      },
      { label: 'connection.tls', value: !!config.redis.connection.tls, envVar: 'REDIS_TLS' },
      { label: 'minMovementM', value: config.redis.minMovementM, envVar: 'REDIS_MIN_MOVEMENT_M', unit: 'm' },
    ],
  },
  {
    title: 'RegattaUp lap webhook (base station only)',
    rows: [
      { label: 'webhookUrl', value: config.regattaup.webhookUrl, envVar: 'REGATTAUP_WEBHOOK_URL' },
      { label: 'enabled', value: config.regattaup.enabled, envVar: 'REGATTAUP_WEBHOOK_DISABLED', inverted: true },
      { label: 'queueDbPath', value: config.regattaup.queueDbPath, envVar: 'REGATTAUP_QUEUE_DB' },
      { label: 'retryIntervalMs', value: config.regattaup.retryIntervalMs, envVar: 'REGATTAUP_RETRY_INTERVAL_MS', unit: 'ms' },
      { label: 'maxBackoffMs', value: config.regattaup.maxBackoffMs, envVar: 'REGATTAUP_MAX_BACKOFF_MS', unit: 'ms' },
    ],
  },
];

function formatValue(v, unit) {
  const formatted = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
  // Units only make sense tacked onto an actual number - a boolean/string
  // value with a unit attached (shouldn't happen given the table above,
  // but stay defensive) would just read as nonsense.
  return unit && typeof v === 'number' ? `${formatted} ${unit}` : formatted;
}

// `inverted` is for flags like NO_RADIO/REGATTAUP_WEBHOOK_DISABLED where the
// resolved config value (enabled=true) is the *negation* of the env var
// actually being set - still an override worth flagging as such.
function overrideTag(envVar, inverted) {
  if (!envVar) return '';
  const isSet = process.env[envVar] !== undefined;
  if (!isSet) return '(default)';
  return `(env: ${envVar}${inverted ? '=' + process.env[envVar] : ''})`;
}

// HTML rendering shared by both admin dashboards' GET /config (see
// adminServer.js, roverAdminServer.js) - same dark theme as the rest of
// the admin UI. No stats snapshot needed here (unlike renderDashboard/
// renderMap elsewhere) - config is resolved once at process startup from
// env vars, not something that changes while the process runs, so there's
// nothing to poll/refresh.
function renderConfigPage() {
  const sectionsHtml = sections
    .map((section) => {
      const rows = section.rows
        .map(({ label, value, envVar, inverted, unit }) => {
          // Env Var is shown unconditionally (not just once overridden) -
          // this is the actual command-line/`.env` knob for this setting,
          // so it should be visible right next to its current value even
          // while still at the default, not just after you've already
          // gone and set it once.
          const envVarHtml = envVar ? `<code>${envVar}</code>` : '<span class="muted">&mdash;</span>';
          const isSet = envVar && process.env[envVar] !== undefined;
          const statusHtml = !envVar
            ? '<span class="muted">&mdash;</span>'
            : isSet
              ? // Inverted flags (NO_RADIO etc.) resolve to the opposite of
                // what was actually set - show the raw env value too so
                // it's not confusing that e.g. NO_RADIO=1 shows "enabled: false".
                `<span class="overridden">overridden${inverted ? ` (${envVar}=${process.env[envVar]})` : ''}</span>`
              : '<span class="muted">default</span>';
          return `<tr>
            <td>${label}</td>
            <td>${envVarHtml}</td>
            <td>${formatValue(value, unit)}</td>
            <td>${statusHtml}</td>
          </tr>`;
        })
        .join('');
      return `<section>
        <h2>${section.title}</h2>
        <table>
          <thead><tr><th>Setting</th><th>Env Var</th><th>Value</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
    })
    .join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>race-tracker config</title>
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
  section { margin-bottom: 24px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.04em; color: #8b94a3; margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #262c36; border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 14px; font-size: 13px; font-variant-numeric: tabular-nums; }
  th { color: #8b94a3; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid #262c36; }
  tr:not(:last-child) td { border-bottom: 1px solid #1c222b; }
  .muted { color: #8b94a3; }
  .overridden { color: #e3b341; font-weight: 600; }
  code { background: #1c222b; padding: 1px 6px; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <h1>Resolved configuration</h1>
  <div class="subtitle">
    <a href="/">&larr; back to dashboard</a>
    &nbsp;·&nbsp; every default plus whatever's actually been overridden via environment variables or .env - same data as <code>npm run print-config</code>
    &nbsp;·&nbsp; "Env Var" is the command-line/.env variable that sets each value; yellow "Status" means it's been overridden from its default
  </div>
  ${sectionsHtml}
</body>
</html>`;
}

module.exports = { sections, formatValue, overrideTag, renderConfigPage };
