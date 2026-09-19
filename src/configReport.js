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
// config.js resolves the exact same object structure regardless of which
// process reads it (`npm run base`/`boat`/`rtk`/`basertk`), but each
// process only ever actually READS a subset of it - `roles`, on a row or
// (when every row in it shares the same answer) a whole section, names
// which of 'base', 'boat', 'rtk' actually read that setting; omitted means
// every role does. 'basertk' is deliberately not a tag that appears below
// at all - see renderConfigPage's own comment on why it's derived (base's
// settings union rtk's) rather than duplicated onto every row. That
// function's `role` param uses this to show each dashboard only what that
// process reads, instead of the full list including settings it never
// looks at. `npm run print-config` (printConfig.js) deliberately bypasses
// this and always prints everything, unfiltered - it's a standalone
// diagnostic dump, not run "as" any particular role.
const sections = [
  {
    title: 'Mode',
    rows: [
      { label: 'simulate', value: config.simulate, envVar: 'SIMULATE', roles: ['base', 'boat'] },
      { label: 'simulateGps', value: config.simulateGps, envVar: 'SIMULATE_GPS', roles: ['boat'] },
      { label: 'noGps', value: config.noGps, envVar: 'NO_GPS', roles: ['boat'] },
      // testLapNumber doubles as the on/off switch for this test mode (0 =
      // off) and the lap number to report - see config.js's own comment.
      { label: 'testLapBoatId', value: config.testLapBoatId, envVar: 'TEST_LAP_BOAT_ID', roles: ['base'] },
      { label: 'testLapNumber', value: config.testLapNumber, envVar: 'TEST_LAP_NUMBER', roles: ['base'] },
    ],
  },
  {
    title: 'Simulation (sim.*, only used when simulate=true)',
    // Only `port` is read on the base side too (SimRadioLink listens on it
    // for sim frames) - every other sim.* field is specifically about
    // simGps.js's fake race track, boat-only.
    roles: ['base', 'boat'],
    rows: [
      { label: 'port', value: config.sim.port, envVar: 'SIM_PORT', roles: ['base', 'boat'] },
      { label: 'gpsHz', value: config.sim.gpsHz, envVar: 'SIM_GPS_HZ', unit: 'Hz', roles: ['boat'] },
      { label: 'upwindSpeedKn', value: config.sim.upwindSpeedKn, envVar: 'SIM_UPWIND_SPEED_KN', unit: 'kn', roles: ['boat'] },
      { label: 'downwindSpeedKn', value: config.sim.downwindSpeedKn, envVar: 'SIM_DOWNWIND_SPEED_KN', unit: 'kn', roles: ['boat'] },
      { label: 'lapCount', value: config.sim.lapCount, envVar: 'SIM_LAP_COUNT', unit: 'laps', roles: ['boat'] },
      { label: 'centerLat', value: config.sim.centerLat, envVar: 'SIM_CENTER_LAT', unit: '°', roles: ['boat'] },
      { label: 'centerLon', value: config.sim.centerLon, envVar: 'SIM_CENTER_LON', unit: '°', roles: ['boat'] },
      { label: 'packetLossPct', value: config.sim.packetLossPct, envVar: 'SIM_PACKET_LOSS', unit: '%', roles: ['boat'] },
      { label: 'startOnly', value: config.sim.startOnly, envVar: 'SIM_START_ONLY', roles: ['boat'] },
      { label: 'prestartDwellS', value: config.sim.prestartDwellS, envVar: 'SIM_PRESTART_DWELL_S', unit: 's', roles: ['boat'] },
      { label: 'holdForStart', value: config.sim.holdForStart, envVar: 'SIM_HOLD_FOR_START', roles: ['boat'] },
      { label: 'foulTest', value: config.sim.foulTest, envVar: 'SIM_FOUL', roles: ['boat'] },
      { label: 'foulWindwardM', value: config.sim.foulWindwardM, envVar: 'SIM_FOUL_WINDWARD_M', unit: 'm', roles: ['boat'] },
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
        roles: ['boat'],
      },
      { label: 'startLinePosition', value: START_LINE_POSITION, envVar: 'SIM_START_LINE_POSITION', unit: '%', roles: ['boat'] },
      { label: 'startLineLengthM', value: START_SIDE_LENGTH_M, unit: 'm', roles: ['boat'] },
      { label: 'finishLineLengthM', value: FINISH_SIDE_LENGTH_M, unit: 'm', roles: ['boat'] },
      { label: 'committeeGapM', value: COMMITTEE_GAP_M, envVar: 'SIM_COMMITTEE_GAP_M', unit: 'm', roles: ['boat'] },
    ],
  },
  {
    title: 'Local UDP broadcast (base and boat both)',
    roles: ['base', 'boat'],
    rows: [
      { label: 'format', value: config.localBroadcast.format, envVar: 'GPS_OUTPUT_FORMAT' },
      { label: 'address', value: config.localBroadcast.address, envVar: 'UDP_BROADCAST_ADDR' },
      { label: 'port', value: config.localBroadcast.port, envVar: 'UDP_PORT' },
    ],
  },
  {
    title: 'GPS (simpleRTK2B LR)',
    rows: [
      // Shared by all three modes: the boat's own GPS, an optional GPS
      // wired directly to the base, and rtkStation.js's entire reason to
      // exist - see config.js's own comment on this section.
      { label: 'port', value: config.gps.port, envVar: 'GPS_PORT', note: 'macOS: /dev/cu.usbmodemXXXX', roles: ['base', 'boat', 'rtk'] },
      { label: 'baud', value: config.gps.baud, envVar: 'GPS_BAUD', unit: 'baud', roles: ['base', 'boat', 'rtk'] },
      { label: 'logConsole', value: config.gps.logConsole, envVar: 'GPS_LOG', roles: ['base', 'boat', 'rtk'] },
      { label: 'logReplace', value: config.gps.logReplace, envVar: 'GPS_LOG_REPLACE', roles: ['base', 'boat', 'rtk'] },
      { label: 'logRtcm', value: config.gps.logRtcm, envVar: 'GPS_LOG_RTCM', roles: ['boat'] },
      // rtk only - plain `npm run base` opens the same GPS_PORT but never
      // wires the TMODE3/survey-in controls that actually read these (see
      // baseStation.js's rtkControlsEnabled); `basertk` sees them via the
      // rtk half of renderConfigPage's base∪rtk union, not this tag.
      { label: 'svinMinDurS', value: config.gps.svinMinDurS, envVar: 'GPS_SVIN_MIN_DUR_S', unit: 's', roles: ['rtk'] },
      { label: 'svinAccLimitMm', value: config.gps.svinAccLimitMm, envVar: 'GPS_SVIN_ACC_LIMIT_MM', unit: 'mm', roles: ['rtk'] },
    ],
  },
  {
    title: 'Radio (telemetry)',
    // Not rtk - that mode never opens the telemetry radio at all.
    roles: ['base', 'boat'],
    rows: [
      { label: 'enabled', value: config.radio.enabled, envVar: 'RADIO_ENABLED' },
      { label: 'port', value: config.radio.port, envVar: 'RADIO_PORT', note: 'macOS: /dev/cu.usbserial-XXXX' },
      { label: 'baud', value: config.radio.baud, envVar: 'RADIO_BAUD', unit: 'baud' },
    ],
  },
  {
    title: 'Identity & timing',
    // Not rtk - none of these apply once there's no telemetry radio/course
    // marks in the picture at all.
    roles: ['base', 'boat'],
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
            ? `from ${config.configDir}/boat_id.txt (this device's own persisted id)`
            : undefined,
        roles: ['boat'],
      },
      // markName/markDistanceM only ever DO anything on a mark/markset-mode
      // process (npm run mark/markset - see README's "Mark mode") - both are
      // just baseStation.js itself run with MARK_MODE=1/MARKSET_MODE=1.
      // Tagged 'markset', not 'base' - a plain base/basertk will never
      // represent a mark, so these would just be confusing noise on that
      // dashboard (see renderConfigPage's own comment on the 'markset' role
      // above, which unions in the generic 'base' rows a markset device
      // still needs - GPS/admin/Redis/etc - without inheriting these two).
      {
        label: 'markName',
        value: config.markName || '(not assigned)',
        envVar: 'MARK_NAME',
        note: 'which course mark THIS device auto-posts its own GPS position as, if any',
        roles: ['markset'],
      },
      {
        label: 'markDistanceM',
        value: config.markDistanceM,
        envVar: 'MARK_DISTANCE_M',
        unit: 'm',
        note: 'how far the assigned mark has to actually move before this device posts its new position to Redis, same distance-gated spirit as txDistanceM below but for a mark buoy instead of a boat',
        roles: ['markset'],
      },
      { label: 'txDistanceM', value: config.txDistanceM, envVar: 'TX_DISTANCE_M', unit: 'm', roles: ['boat'] },
      {
        label: 'txIntervalMs',
        value: config.txIntervalMs,
        envVar: 'TX_INTERVAL_S',
        unit: 'ms',
        note: 'env var is in seconds; 0 disables the heartbeat (distance gate only)',
        roles: ['boat'],
      },
      {
        label: 'txBatchSize',
        value: config.txBatchSize,
        envVar: 'TX_BATCH_SIZE',
        note: '1 (default) = one frame per fix, unchanged from before batching existed - see README\'s "Batching multiple fixes per send"',
        roles: ['boat'],
      },
      {
        label: 'pingResponseJitterMs',
        value: config.pingResponseJitterMs,
        envVar: 'PING_RESPONSE_JITTER_MS',
        unit: 'ms',
        note: 'max random delay before replying to "Ping fleet"',
        roles: ['boat'],
      },
      {
        label: 'helloStartupJitterMs',
        value: config.helloStartupJitterMs,
        envVar: 'HELLO_STARTUP_JITTER_MS',
        unit: 'ms',
        note: 'max random delay before the first hello announcement (and every retry after it)',
        roles: ['boat'],
      },
      {
        label: 'marksBroadcastIntervalMs',
        value: config.marksBroadcastIntervalMs,
        envVar: 'MARKS_BROADCAST_INTERVAL_MS',
        unit: 'ms',
        roles: ['base'],
      },
      { label: 'logMarksBroadcast', value: config.logMarksBroadcast, envVar: 'LOG_MARKS_BROADCAST', roles: ['base'] },
      { label: 'logReceivedFrames', value: config.logReceivedFrames, envVar: 'LOG_RECEIVED_FIXES', roles: ['base'] },
    ],
  },
  {
    title: 'Local logging',
    // Not rtk - it writes no CSV logs at all (no telemetry frames, no
    // course, nothing to log).
    roles: ['base', 'boat'],
    rows: [
      { label: 'logDir', value: config.logDir, envVar: 'LOG_DIR' },
      { label: 'logRetentionDays', value: config.logRetentionDays, envVar: 'LOG_RETENTION_DAYS', unit: 'days' },
      { label: 'logChunkMinutes', value: config.logChunkMinutes, envVar: 'LOG_CHUNK_MINUTES', unit: 'min', roles: ['boat'] },
    ],
  },
  {
    title: 'Log upload over WiFi',
    // Not rtk - it has no SD-card logs to upload and doesn't serve uploads.
    roles: ['base', 'boat'],
    rows: [
      { label: 'enabled', value: config.upload.enabled, envVar: 'UPLOAD_ENABLED', roles: ['boat'] },
      { label: 'logSuccess', value: config.upload.logSuccess, envVar: 'UPLOAD_LOG' },
      { label: 'port', value: config.upload.port, envVar: 'UPLOAD_PORT', roles: ['base'] },
      { label: 'dir', value: config.upload.dir, envVar: 'UPLOAD_DIR', roles: ['base'] },
      { label: 'baseIp', value: config.upload.baseIp || '(auto-detect)', envVar: 'BASE_IP', roles: ['base'] },
      { label: 'checkIntervalMs', value: config.upload.checkIntervalMs, envVar: 'UPLOAD_CHECK_INTERVAL_MS', unit: 'ms', roles: ['boat'] },
      { label: 'timeoutMs', value: config.upload.timeoutMs, envVar: 'UPLOAD_TIMEOUT_MS', unit: 'ms', roles: ['boat'] },
    ],
  },
  {
    title: 'Admin dashboard',
    // Shared by all three - each mode has its own dashboard on this port.
    roles: ['base', 'boat', 'rtk'],
    rows: [{ label: 'port', value: config.admin.port, envVar: 'ADMIN_PORT' }],
  },
  {
    title: 'Redis (base station only)',
    roles: ['base'],
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
      {
        label: 'trackRetentionHours',
        value: config.redis.trackRetentionHours,
        envVar: 'REDIS_TRACK_RETENTION_HOURS',
        unit: 'h',
      },
      { label: 'memoryLimitMb', value: config.redis.memoryLimitMb, envVar: 'REDIS_MEMORY_LIMIT_MB', unit: 'MB' },
    ],
  },
  {
    title: 'RegattaUp webhooks - lap + on-grid + mark rounding (base station only)',
    roles: ['base'],
    rows: [
      { label: 'webhookUrl', value: config.regattaup.webhookUrl, envVar: 'REGATTAUP_WEBHOOK_URL' },
      { label: 'enabled', value: config.regattaup.enabled, envVar: 'REGATTAUP_WEBHOOK_ENABLED' },
      { label: 'activeRegattasUrl', value: config.regattaup.activeRegattasUrl, envVar: 'REGATTAUP_ACTIVE_REGATTAS_URL' },
      {
        label: 'defaultRegatta',
        value: config.regattaup.defaultRegatta ? `${config.regattaup.defaultRegatta.id}${config.regattaup.defaultRegatta.name ? ` (${config.regattaup.defaultRegatta.name})` : ''}` : '(none)',
        envVar: 'REGATTAUP_REGATTA_ID',
        note: 'also persisted to regatta-id.txt by this env var or by picking a regatta from the admin dashboard/startup prompt',
      },
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

// HTML rendering shared by all three admin dashboards' GET /config (see
// adminServer.js, roverAdminServer.js, rtkAdminServer.js) - same dark theme
// as the rest of the admin UI. No stats snapshot needed here (unlike
// renderDashboard/renderMap elsewhere) - config is resolved once at process
// startup from env vars, not something that changes while the process
// runs, so there's nothing to poll/refresh.
//
// role ('base' | 'boat' | 'rtk' | 'basertk'), when given, keeps only the
// sections/rows tagged for it (see each row/section's own `roles` above;
// untagged means every role sees it) - a section that ends up with zero
// visible rows is dropped entirely rather than shown empty. Each dashboard
// passes its own role so an operator only ever sees settings that process
// actually reads, not the other modes' unrelated knobs (radio/course for
// rtk, Redis/RegattaUp for boat, sim-race tuning for base, ...).
//
// 'basertk' (npm run basertk - see baseStation.js's rtkControlsEnabled) is
// deliberately NOT its own tag scattered across rows below: it's exactly
// "everything 'base' reads, plus everything 'rtk' reads" (the same base
// station, with the TMODE3/survey-in controls additionally wired in), so
// visibleTo treats it as matching either tag rather than requiring every
// row to also carry a third label that would always just mirror the union
// of the other two.
//
// 'markset' (npm run markset/mark - see baseStation.js's marksetMode) is
// the same idea, one level narrower: it's baseStation.js too, so it still
// wants every generic 'base'-tagged row (GPS, admin port, Redis, ...), but
// it ALSO has its own extra settings (markName, markDistanceM - see their
// own rows above) that only ever do anything in this mode and would just
// be confusing noise on a plain base/basertk that will never represent a
// mark - hence those two are tagged 'markset' only, not 'base', and
// visibleTo unions 'markset' with 'base' here rather than the reverse.
//
// Omit role to show everything unfiltered - printConfig.js uses `sections`
// directly instead of this function, so nothing currently relies on that
// default, but it's the safe fallback for any future caller that isn't a
// specific role.
function renderConfigPage({ role } = {}) {
  const visibleTo = (item) => {
    if (!item.roles) return true;
    if (item.roles.includes(role)) return true;
    if (role === 'basertk') return item.roles.includes('base') || item.roles.includes('rtk');
    if (role === 'markset') return item.roles.includes('base');
    return false;
  };
  const sectionsToRender = role
    ? sections
        .filter(visibleTo)
        .map((section) => ({ ...section, rows: section.rows.filter(visibleTo) }))
        .filter((section) => section.rows.length > 0)
    : sections;
  const sectionsHtml = sectionsToRender
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
