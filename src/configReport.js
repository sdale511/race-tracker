const config = require('./config');
const { COURSE_LENGTH_NM, START_LINE_POSITION, START_SIDE_LENGTH_M, FINISH_SIDE_LENGTH_M, COMMITTEE_GAP_M } = require('./course');

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
      { label: 'startOnly', value: config.sim.startOnly, envVar: 'SIM_START_ONLY' },
      { label: 'prestartDwellS', value: config.sim.prestartDwellS, envVar: 'SIM_PRESTART_DWELL_S', unit: 's' },
      { label: 'holdForStart', value: config.sim.holdForStart, envVar: 'SIM_HOLD_FOR_START' },
      { label: 'foulTest', value: config.sim.foulTest, envVar: 'SIM_FOUL' },
      { label: 'foulWindwardM', value: config.sim.foulWindwardM, envVar: 'SIM_FOUL_WINDWARD_M', unit: 'm' },
      // These live in course.js, not config.sim - only take effect on a
      // fresh course (see "Changing the course" in the README); a published
      // course already in Redis keeps whatever it was created with
      // regardless of what these currently resolve to.
      {
        label: `courseLengthNm (${config.sim.courseMarks})`,
        value: COURSE_LENGTH_NM,
        envVar: 'SIM_COURSE_LENGTH_NM',
        unit: 'nm',
        note: 'which pair races is SIM_COURSE_MARKS, shown in the label',
      },
      { label: 'startLinePosition', value: START_LINE_POSITION, envVar: 'SIM_START_LINE_POSITION', unit: '%' },
      { label: 'startLineLengthM', value: START_SIDE_LENGTH_M, unit: 'm' },
      { label: 'finishLineLengthM', value: FINISH_SIDE_LENGTH_M, unit: 'm' },
      { label: 'committeeGapM', value: COMMITTEE_GAP_M, envVar: 'SIM_COMMITTEE_GAP_M', unit: 'm' },
    ],
  },
  {
    title: 'Local UDP broadcast (base and boat both)',
    rows: [
      { label: 'format', value: config.localBroadcast.format, envVar: 'GPS_OUTPUT_FORMAT' },
      { label: 'address', value: config.localBroadcast.address, envVar: 'UDP_BROADCAST_ADDR' },
      { label: 'port', value: config.localBroadcast.port, envVar: 'UDP_PORT' },
    ],
  },
  {
    title: 'GPS (simpleRTK2B LR)',
    rows: [
      { label: 'port', value: config.gps.port, envVar: 'GPS_PORT', note: 'macOS: /dev/cu.usbmodemXXXX' },
      { label: 'baud', value: config.gps.baud, envVar: 'GPS_BAUD', unit: 'baud' },
      { label: 'logConsole', value: config.gps.logConsole, envVar: 'GPS_LOG' },
      { label: 'logReplace', value: config.gps.logReplace, envVar: 'GPS_LOG_REPLACE' },
      { label: 'logRtcm', value: config.gps.logRtcm, envVar: 'GPS_LOG_RTCM' },
      { label: 'svinMinDurS', value: config.gps.svinMinDurS, envVar: 'GPS_SVIN_MIN_DUR_S', unit: 's' },
      { label: 'svinAccLimitMm', value: config.gps.svinAccLimitMm, envVar: 'GPS_SVIN_ACC_LIMIT_MM', unit: 'mm' },
    ],
  },
  {
    title: 'Radio (telemetry)',
    rows: [
      { label: 'enabled', value: config.radio.enabled, envVar: 'RADIO_ENABLED' },
      { label: 'port', value: config.radio.port, envVar: 'RADIO_PORT', note: 'macOS: /dev/cu.usbserial-XXXX' },
      { label: 'baud', value: config.radio.baud, envVar: 'RADIO_BAUD', unit: 'baud' },
    ],
  },
  {
    title: 'Identity & timing',
    rows: [
      {
        label: 'boatId',
        value: config.boatId,
        envVar: 'BOAT_ID',
        // BOAT_ID unset means this value came from this device's own
        // persisted id instead (see boatIdFile.js) - worth saying so, since
        // otherwise "default" reads like a hardcoded constant rather than
        // an id this specific device generated and will keep reusing.
        note:
          process.env.BOAT_ID === undefined
            ? `from ${config.logDir}/boat_id.txt (this device's own persisted id)`
            : undefined,
      },
      { label: 'txDistanceM', value: config.txDistanceM, envVar: 'TX_DISTANCE_M', unit: 'm' },
      {
        label: 'marksBroadcastIntervalMs',
        value: config.marksBroadcastIntervalMs,
        envVar: 'MARKS_BROADCAST_INTERVAL_MS',
        unit: 'ms',
      },
      { label: 'logMarksBroadcast', value: config.logMarksBroadcast, envVar: 'LOG_MARKS_BROADCAST' },
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
      { label: 'enabled', value: config.upload.enabled, envVar: 'UPLOAD_ENABLED' },
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
    title: 'RegattaUp webhooks - lap + on-grid + mark rounding (base station only)',
    rows: [
      { label: 'webhookUrl', value: config.regattaup.webhookUrl, envVar: 'REGATTAUP_WEBHOOK_URL' },
      { label: 'enabled', value: config.regattaup.enabled, envVar: 'REGATTAUP_WEBHOOK_ENABLED' },
      { label: 'activeRegattasUrl', value: config.regattaup.activeRegattasUrl, envVar: 'REGATTAUP_ACTIVE_REGATTAS_URL' },
      {
        label: 'activeRegattasRefreshIntervalMs',
        value: config.regattaup.activeRegattasRefreshIntervalMs,
        envVar: 'REGATTAUP_REGATTAS_REFRESH_INTERVAL_MS',
        unit: 'ms',
      },
      {
        label: 'logActiveRegattas',
        value: config.regattaup.logActiveRegattas,
        envVar: 'REGATTAUP_LOG_ACTIVE_REGATTAS',
      },
      { label: 'queueDbPath', value: config.regattaup.queueDbPath, envVar: 'REGATTAUP_QUEUE_DB' },
      { label: 'postIntervalMs', value: config.regattaup.postIntervalMs, envVar: 'REGATTAUP_POST_INTERVAL_MS', unit: 'ms' },
      { label: 'maxBackoffMs', value: config.regattaup.maxBackoffMs, envVar: 'REGATTAUP_MAX_BACKOFF_MS', unit: 'ms' },
      { label: 'onGridZoneM', value: config.regattaup.onGridZoneM, envVar: 'REGATTAUP_ONGRID_ZONE_M', unit: 'm' },
      { label: 'onGridQueueDbPath', value: config.regattaup.onGridQueueDbPath, envVar: 'REGATTAUP_ONGRID_QUEUE_DB' },
      {
        label: 'markRoundingEnabled',
        value: config.regattaup.markRoundingEnabled,
        envVar: 'REGATTAUP_MARK_ROUNDING_ENABLED',
      },
      {
        label: 'markRoundingExtensionM',
        value: config.regattaup.markRoundingExtensionM,
        envVar: 'REGATTAUP_MARK_ROUNDING_EXTENSION_M',
        unit: 'm',
      },
      {
        label: 'markRoundingQueueDbPath',
        value: config.regattaup.markRoundingQueueDbPath,
        envVar: 'REGATTAUP_MARK_ROUNDING_QUEUE_DB',
      },
      { label: 'foulEnabled', value: config.regattaup.foulEnabled, envVar: 'REGATTAUP_FOUL_ENABLED' },
      { label: 'foulQueueDbPath', value: config.regattaup.foulQueueDbPath, envVar: 'REGATTAUP_FOUL_QUEUE_DB' },
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

// `inverted` is for a flag whose env var name is the *negation* of the
// resolved config value shown next to it (an old-style `_DISABLED`/`NO_*`
// var, like NO_RADIO and REGATTAUP_WEBHOOK_DISABLED used to be, before
// both were renamed to RADIO_ENABLED/REGATTAUP_WEBHOOK_ENABLED) - no row
// currently needs it. Prefer naming a new env var so its own polarity
// already matches the field it controls instead (an `_ENABLED` var,
// defaulting on - see REGATTAUP_WEBHOOK_ENABLED/markRoundingEnabled/
// RADIO_ENABLED); reach for `inverted` only if a var genuinely can't be
// renamed that way.
//
// The env var name is shown unconditionally (not just once overridden) -
// same reasoning as renderConfigPage's HTML table below: it's the actual
// command-line/`.env` knob for this setting, so it should be visible right
// next to its current value even while still at the default, not just
// after you've already gone and set it once.
function overrideTag(envVar, inverted) {
  if (!envVar) return '';
  const isSet = process.env[envVar] !== undefined;
  if (!inverted) return isSet ? `(${envVar}, overridden)` : `(${envVar}, default)`;
  // An inverted flag names the env var the OPPOSITE of the resolved value
  // printed next to this tag - "enabled  true  (NO_RADIO, default)" (back
  // when NO_RADIO was still spelled that way) reads like the no-radio flag
  // itself is true. Spelling out the env var's own raw state - always, not
  // just once overridden, since the confusion is just as real at the
  // default - is what actually resolves that.
  const rawState = isSet ? `${envVar}=${process.env[envVar]}` : `${envVar} not set`;
  return `(${rawState}, ${isSet ? 'overridden' : 'default'})`;
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
        .map(({ label, value, envVar, inverted, unit, note }) => {
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
              ? '<span class="overridden">overridden</span>'
              : '<span class="muted">default</span>';
          // A platform-specific hint (e.g. what this path looks like on
          // macOS vs the Linux paths used as the actual defaults) - shown
          // as a small muted line under the value, not part of the
          // resolved value itself.
          const extraLines = [];
          if (note) extraLines.push(note);
          // An inverted flag names the env var the OPPOSITE of the resolved
          // setting shown here - "enabled: true" sitting next to a bare
          // `_DISABLED`-style var name reads like that flag itself is true.
          // Spelling out the env var's own raw state right under the value
          // (not just in the Status column, and not just once overridden -
          // the confusion is just as real at the default) is what actually
          // resolves that: "true" next to "SOME_FLAG not set" can't be
          // misread the way "true" next to the bare env var name can. No
          // row currently sets `inverted` - see overrideTag's own module
          // comment above.
          if (inverted && envVar) {
            extraLines.push(isSet ? `${envVar}=${process.env[envVar]}` : `${envVar} not set`);
          }
          const valueHtml =
            extraLines.length > 0
              ? `${formatValue(value, unit)}${extraLines.map((line) => `<div class="muted" style="font-size:11px;">${line}</div>`).join('')}`
              : formatValue(value, unit);
          return `<tr>
            <td>${label}</td>
            <td>${envVarHtml}</td>
            <td>${valueHtml}</td>
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
