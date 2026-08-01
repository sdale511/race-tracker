const path = require('path');
require('dotenv').config();

// Central configuration. Override any of these with environment variables,
// e.g. GPS_PORT=/dev/ttyACM0 BOAT_ID=7 npm run boat
// A git-ignored .env file in the project root is loaded automatically (see
// dotenv above), so secrets like REDIS_PASSWORD can live there instead of
// being typed on the command line or hardcoded in this file.

// SIMULATE=1 replaces the real GPS + radio hardware with a fake GPS track
// and a UDP-based stand-in for the radio link, so boatAgent/baseStation can
// be run and tested with no hardware attached (see simGps.js, simRadioLink.js).
const simulate = process.env.SIMULATE === '1' || process.env.SIMULATE === 'true';

// SIMULATE_GPS=1 fakes just the GPS (a simulated race track), while still
// using the real radio hardware on both ends - useful for bench-testing
// actual radios (range, packet loss) without needing a real GPS fix or
// being outdoors. SIMULATE=1 implies this too (full simulation, no
// hardware at all); this only matters as its own flag when you want
// simulated GPS with real radio specifically.
const simulateGps = simulate || process.env.SIMULATE_GPS === '1' || process.env.SIMULATE_GPS === 'true';

// TEST_LAP=1 (npm run base) sends one synthetic lap straight into the lap
// webhook queue and exits, to check the queue -> RegattaUp path end to end
// without a real or simulated race in progress. TEST_LAP_BOAT_ID/
// TEST_LAP_NUMBER pick which boat/lap number it's sent as - a dedicated
// pair rather than reusing BOAT_ID, since that otherwise means nothing to
// the base station (it's a boatAgent-only concept everywhere else).
const testLap = process.env.TEST_LAP === '1' || process.env.TEST_LAP === 'true';
const testLapBoatId = parseInt(process.env.TEST_LAP_BOAT_ID || '1', 10);
const testLapNumber = parseInt(process.env.TEST_LAP_NUMBER || '1', 10);

// On the boat Pi, override LOG_DIR to point at the SD card mount. Default
// is relative to this package (not the shell's cwd), so it works the same
// whether you're on the Pi or testing on a laptop.
const logDir = process.env.LOG_DIR || path.join(__dirname, '..', 'race-logs');

// Redis connection presets, selected via REDIS_ENV. Hostnames/ports are fine
// to keep in source; credentials are not, so those always come from the
// environment. See "redis" section below for how REDIS_URL can override this
// entirely for ad-hoc use.
const REDIS_CONNECTIONS = {
  local: {
    host: '127.0.0.1',
    port: 6379,
  },
  production: {
    host: 'redis-16266.c60.us-west-1-2.ec2.cloud.redislabs.com',
    port: 16266,
    username: process.env.REDIS_USERNAME || 'default',
    password: process.env.REDIS_PASSWORD,
    ...(process.env.REDIS_TLS === '1' || process.env.REDIS_TLS === 'true' ? { tls: {} } : {}),
  },
};

module.exports = {
  simulate,
  simulateGps,
  testLap,
  testLapBoatId,
  testLapNumber,

  // --- Simulation mode settings (only used when simulate=true) ---
  sim: {
    // boatAgent sends UDP frames to host:port; baseStation listens on port.
    host: process.env.SIM_HOST || '127.0.0.1',
    port: parseInt(process.env.SIM_PORT || '41234', 10),
    gpsHz: parseFloat(process.env.SIM_GPS_HZ || '2'),
    // Landsailers, unlike water boats, go much faster downwind than up -
    // low rolling resistance lets apparent wind build well past true wind
    // speed on a reach/run.
    upwindSpeedKn: parseFloat(process.env.SIM_UPWIND_SPEED_KN || '30'),
    downwindSpeedKn: parseFloat(process.env.SIM_DOWNWIND_SPEED_KN || '55'),
    // How many laps (start/finish line crossings, finish direction) each
    // simulated boat sails before it stops.
    lapCount: parseInt(process.env.SIM_LAP_COUNT || '2', 10),
    centerLat: parseFloat(process.env.SIM_CENTER_LAT || '40.8744'),
    centerLon: parseFloat(process.env.SIM_CENTER_LON || '-119.2024'),
    // % chance (0-100) each frame is dropped, to simulate radio range dropouts.
    packetLossPct: parseFloat(process.env.SIM_PACKET_LOSS || '0'),
  },

  // --- GPS (simpleRTK2B LR, ZED-F9P) ---
  // Default port is the Pi's USB CDC-ACM device, since the simpleRTK2B LR's
  // own USB port is what's actually used - not the Pi's hardware UART pins
  // (override GPS_PORT if you do wire it to GPIO 14/15 instead). This link
  // is Pi<->GPS only, so baud/bandwidth here is NOT the constraint (the
  // radio link is) - default matches the ZED-F9P's factory-default UART1
  // baud so no baud reconfig step is needed on the module, just enabling
  // NAV-PVT/disabling NMEA.
  gps: {
    port: process.env.GPS_PORT || '/dev/ttyACM0',
    baud: parseInt(process.env.GPS_BAUD || '38400', 10),
  },

  // --- Telemetry radio (transparent-serial style, e.g. Digi XBee SX) ---
  // Whatever bytes you write to this port are transmitted over the air and
  // appear byte-for-byte on the matching radio at the base station. Default
  // matches the XBee SX's factory-default baud (9600), so no radio-side
  // reconfig is needed out of the box. If you use an RFD900x/SiK radio
  // instead, override RADIO_BAUD - their factory default is typically 57600.
  radio: {
    // NO_RADIO=1 skips opening the radio port entirely (e.g. bench-testing
    // GPS alone, no radio hardware attached) - fixes still log to SD.
    enabled: process.env.NO_RADIO !== '1' && process.env.NO_RADIO !== 'true',
    port: process.env.RADIO_PORT || '/dev/ttyUSB0',
    baud: parseInt(process.env.RADIO_BAUD || '9600', 10),
  },

  // --- Identity & timing ---
  boatId: parseInt(process.env.BOAT_ID || '1', 10),
  // How far the boat has to actually move before we transmit a new
  // position frame over the radio - distance-based, not time-based, so a
  // stopped boat doesn't keep re-sending the same fix and a fast-moving one
  // gets updates as often as its own movement warrants. GPS fixes can
  // arrive at 1-10Hz; this throttles radio TX independently to conserve
  // airtime/bandwidth over long range.
  txDistanceM: parseFloat(process.env.TX_DISTANCE_M || '1'),

  // --- Local logging (microSD) ---
  logDir,

  // --- Redis (base station only) ---
  // Where baseStation.js records every decoded fix, so tracks can be queried
  // per-boat or across the whole fleet for a timeframe. See redisStore.js.
  //
  // REDIS_ENV picks a connection preset below (default 'local'). Credentials
  // are never hardcoded here - set REDIS_USERNAME/REDIS_PASSWORD/REDIS_TLS
  // in the environment (or a git-ignored .env) when pointing at production.
  // REDIS_URL, if set, overrides everything below for one-off/ad-hoc use.
  redis: {
    url: process.env.REDIS_URL,
    connection: REDIS_CONNECTIONS[process.env.REDIS_ENV || 'local'] || REDIS_CONNECTIONS.local,
    // A stopped/slow-moving boat reporting every couple seconds would
    // otherwise write a nearly-identical fix over and over - skip a Redis
    // write (SD/console logging is unaffected) unless the boat has moved at
    // least this far since the last one that was actually recorded.
    minMovementM: parseFloat(process.env.REDIS_MIN_MOVEMENT_M || '5'),
  },

  // --- RegattaUp lap webhook (base station only) ---
  // Whenever finishLineWatcher.js (running inside baseStation.js) detects
  // an actual finish line crossing from a boat's position frames - real
  // hardware or simulated, doesn't matter - this triggers a POST so
  // RegattaUp counts the lap. Override the URL to point at a mock endpoint
  // for testing; set REGATTAUP_WEBHOOK_DISABLED=1 to skip sending entirely
  // (crossings are still detected and logged).
  //
  // Every lap is durably queued (see lapWebhookQueue.js) before the first
  // send attempt and only removed once RegattaUp actually accepts it - a
  // failed attempt (RegattaUp down, network blip, a base station restart
  // mid-retry) gets retried with capped exponential backoff rather than
  // silently dropped.
  regattaup: {
    webhookUrl: process.env.REGATTAUP_WEBHOOK_URL || 'https://regattaup.com/api/functions/mylapsWebhook',
    enabled: process.env.REGATTAUP_WEBHOOK_DISABLED !== '1' && process.env.REGATTAUP_WEBHOOK_DISABLED !== 'true',
    queueDbPath: process.env.REGATTAUP_QUEUE_DB || path.join(logDir, 'lap_webhook_queue.sqlite'),
    retryIntervalMs: parseInt(process.env.REGATTAUP_RETRY_INTERVAL_MS || '15000', 10),
    maxBackoffMs: parseInt(process.env.REGATTAUP_MAX_BACKOFF_MS || '300000', 10), // 5 minutes
  },
};
