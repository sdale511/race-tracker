const path = require('path');
require('dotenv').config();

// Central configuration. Override any of these with environment variables,
// e.g. GPS_PORT=/dev/ttyAMA0 BOAT_ID=7 npm run boat
// A git-ignored .env file in the project root is loaded automatically (see
// dotenv above), so secrets like REDIS_PASSWORD can live there instead of
// being typed on the command line or hardcoded in this file.

// SIMULATE=1 replaces the real GPS + radio hardware with a fake GPS track
// and a UDP-based stand-in for the radio link, so boatAgent/baseStation can
// be run and tested with no hardware attached (see simGps.js, simRadioLink.js).
const simulate = process.env.SIMULATE === '1' || process.env.SIMULATE === 'true';

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
  // Wire this UART directly to the Pi. This link is Pi<->GPS only, so
  // baud/bandwidth here is NOT the constraint (the radio link is) - default
  // matches the ZED-F9P's factory-default UART1 baud so no baud reconfig
  // step is needed on the module, just enabling NAV-PVT/disabling NMEA.
  gps: {
    port: process.env.GPS_PORT || '/dev/ttyAMA0',
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
  // How often we actually transmit a position frame over the radio.
  // GPS fixes can arrive at 1-10Hz; we throttle radio TX independently
  // to conserve airtime/bandwidth over long range.
  txIntervalMs: parseInt(process.env.TX_INTERVAL_MS || '2000', 10),

  // --- Local logging (microSD) ---
  // On the boat Pi, override LOG_DIR to point at the SD card mount. Default
  // is relative to this package (not the shell's cwd), so it works the same
  // whether you're on the Pi or testing on a laptop.
  logDir: process.env.LOG_DIR || path.join(__dirname, '..', 'race-logs'),

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
  },
};
