const config = require('./config');

// Prints the fully-resolved configuration - every default plus whatever
// you've actually overridden via environment variables or a .env file - so
// there's one place to check "what am I actually running with" instead of
// reading through config.js's env var fallbacks by hand. Secrets (the
// Redis password) are redacted, never printed even in a debug tool.
//
// Grouped/labeled to match config.js's own section comments, with each
// value tagged (default) or (env: VAR_NAME) so it's obvious at a glance
// what you've actually changed vs. what you're just inheriting.

const sections = [
  {
    title: 'Mode',
    rows: [
      ['simulate', config.simulate, 'SIMULATE'],
      ['simulateGps', config.simulateGps, 'SIMULATE_GPS'],
      ['testLap', config.testLap, 'TEST_LAP'],
      ['testLapBoatId', config.testLapBoatId, 'TEST_LAP_BOAT_ID'],
      ['testLapNumber', config.testLapNumber, 'TEST_LAP_NUMBER'],
    ],
  },
  {
    title: 'Simulation (sim.*, only used when simulate=true)',
    rows: [
      ['port', config.sim.port, 'SIM_PORT'],
      ['gpsHz', config.sim.gpsHz, 'SIM_GPS_HZ'],
      ['upwindSpeedKn', config.sim.upwindSpeedKn, 'SIM_UPWIND_SPEED_KN'],
      ['downwindSpeedKn', config.sim.downwindSpeedKn, 'SIM_DOWNWIND_SPEED_KN'],
      ['lapCount', config.sim.lapCount, 'SIM_LAP_COUNT'],
      ['centerLat', config.sim.centerLat, 'SIM_CENTER_LAT'],
      ['centerLon', config.sim.centerLon, 'SIM_CENTER_LON'],
      ['packetLossPct', config.sim.packetLossPct, 'SIM_PACKET_LOSS'],
    ],
  },
  {
    title: 'GPS (simpleRTK2B LR)',
    rows: [
      ['port', config.gps.port, 'GPS_PORT'],
      ['baud', config.gps.baud, 'GPS_BAUD'],
    ],
  },
  {
    title: 'Radio (telemetry)',
    rows: [
      ['enabled', config.radio.enabled, 'NO_RADIO', true],
      ['port', config.radio.port, 'RADIO_PORT'],
      ['baud', config.radio.baud, 'RADIO_BAUD'],
    ],
  },
  {
    title: 'Identity & timing',
    rows: [
      ['boatId', config.boatId, 'BOAT_ID'],
      ['txDistanceM', config.txDistanceM, 'TX_DISTANCE_M'],
      ['marksBroadcastIntervalMs', config.marksBroadcastIntervalMs, 'MARKS_BROADCAST_INTERVAL_MS'],
    ],
  },
  {
    title: 'Local logging',
    rows: [
      ['logDir', config.logDir, 'LOG_DIR'],
      ['logRetentionDays', config.logRetentionDays, 'LOG_RETENTION_DAYS'],
    ],
  },
  {
    title: 'Redis (base station only)',
    rows: [
      ['url', config.redis.url || '(unset)', 'REDIS_URL'],
      ['env preset', process.env.REDIS_ENV || 'local', 'REDIS_ENV'],
      ['connection.host', config.redis.connection.host, null],
      ['connection.port', config.redis.connection.port, null],
      ['connection.username', config.redis.connection.username || '(none)', 'REDIS_USERNAME'],
      [
        'connection.password',
        config.redis.connection.password ? '***REDACTED***' : '(none)',
        'REDIS_PASSWORD',
      ],
      ['connection.tls', !!config.redis.connection.tls, 'REDIS_TLS'],
      ['minMovementM', config.redis.minMovementM, 'REDIS_MIN_MOVEMENT_M'],
    ],
  },
  {
    title: 'RegattaUp lap webhook (base station only)',
    rows: [
      ['webhookUrl', config.regattaup.webhookUrl, 'REGATTAUP_WEBHOOK_URL'],
      ['enabled', config.regattaup.enabled, 'REGATTAUP_WEBHOOK_DISABLED', true],
      ['queueDbPath', config.regattaup.queueDbPath, 'REGATTAUP_QUEUE_DB'],
      ['retryIntervalMs', config.regattaup.retryIntervalMs, 'REGATTAUP_RETRY_INTERVAL_MS'],
      ['maxBackoffMs', config.regattaup.maxBackoffMs, 'REGATTAUP_MAX_BACKOFF_MS'],
    ],
  },
];

function formatValue(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
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

console.log('race-tracker resolved configuration\n');

for (const section of sections) {
  console.log(section.title);
  const labelWidth = Math.max(...section.rows.map(([label]) => label.length));
  for (const [label, value, envVar, inverted] of section.rows) {
    const paddedLabel = label.padEnd(labelWidth);
    const tag = overrideTag(envVar, inverted);
    // Value is left as-is (not padded to the widest in the section) so a
    // single long value - a URL, a full path - doesn't force every other
    // row's tag out to that same column.
    console.log(`  ${paddedLabel}  ${formatValue(value)}${tag ? '  ' + tag : ''}`);
  }
  console.log('');
}
