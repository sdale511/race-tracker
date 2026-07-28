const config = require('./config');
const { RadioLink } = require('./radioLink');
const { RedisStore } = require('./redisStore');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');

// Base station: sits at the committee boat/shore with the matching radio.
// Decodes incoming frames and fans them out to whatever your race tracking
// software needs. You haven't picked that software yet, so this ships with
// four generic adapters you can mix/match/replace once you know the target:
//
//   1. console/JSON  - always on, good for debugging
//   2. CSV file       - one row per fix, per boat
//   3. Redis          - queryable per-boat or fleet-wide tracks, see redisStore.js
//   4. UDP broadcast  - many tools can ingest a simple NMEA GGA sentence
//                       over UDP; swap outputFrame() below for whatever
//                       your chosen software's actual ingestion format is
//                       (HTTP POST to a cloud API, TCP NMEA stream, etc).

let radio;
if (config.simulate) {
  const { SimRadioLink } = require('./simRadioLink');
  radio = new SimRadioLink({ mode: 'listen', port: config.sim.port });
} else if (config.radio.enabled) {
  radio = new RadioLink({ port: config.radio.port, baud: config.radio.baud });
} else {
  radio = new EventEmitter(); // NO_RADIO=1 - never emits 'frame', other outputs still testable
}
radio.on('error', (err) => console.error('[radio] error:', err.message));
radio.on('disconnected', () => console.warn('[radio] disconnected, retrying...'));

const logDir = config.logDir;
fs.mkdirSync(logDir, { recursive: true });
const csvPath = path.join(logDir, 'base_station_received.csv');
if (!fs.existsSync(csvPath)) {
  fs.writeFileSync(csvPath, 'received_iso,boat_id,fix_time_iso,lat,lon,speed_kn,heading_deg,fix_ok,carr_soln,num_sv\n');
}

const udpSocket = dgram.createSocket('udp4');
const UDP_BROADCAST_ADDR = process.env.UDP_BROADCAST_ADDR || '255.255.255.255';
const UDP_PORT = parseInt(process.env.UDP_PORT || '10110', 10); // 10110 is the conventional NMEA-over-UDP port
udpSocket.bind(() => udpSocket.setBroadcast(true));

const redisStore = new RedisStore({ url: config.redis.url, connection: config.redis.connection });

// Course marks - windward, leeward, and the pin/committee ends of the
// start/finish line (same geometry the simulator uses, see course.js).
// Reads them from Redis if already set (e.g. by a boat simulator that
// started first) rather than overwriting; only computes+publishes them if
// missing, so every process racing the same course agrees on identical
// mark positions. Only meaningful while simulating - real-hardware mark
// positions aren't sourced from SIM_CENTER_LAT/LON, so there's nothing to
// resolve outside SIMULATE=1 yet.
if (config.simulate) {
  redisStore
    .getOrCreateMarks(config.sim.centerLat, config.sim.centerLon)
    .then((marks) => console.log(`[baseStation] course marks (Redis): ${Object.keys(marks).join(', ')}`))
    .catch((err) => console.error('[redis] failed to resolve marks:', err.message));
}

radio.on('frame', (decoded) => {
  logToConsole(decoded);
  logToCsv(decoded);
  redisStore.recordFix(decoded, new Date()).catch((err) => console.error('[redis] write failed:', err.message));
  outputFrame(decoded); // <- swap/extend this for your actual race software
});

function logToConsole(d) {
  console.log(
    `[base] boat=${d.boatId} ${new Date(d.timestamp).toISOString()} ` +
      `${d.lat.toFixed(6)},${d.lon.toFixed(6)} ${d.speedKnots.toFixed(1)}kn ` +
      `hdg=${d.headingDeg.toFixed(0)} fixOk=${d.gnssFixOk} carrSoln=${d.carrSoln} sv=${d.numSV}`
  );
}

function logToCsv(d) {
  const line = [
    new Date().toISOString(),
    d.boatId,
    new Date(d.timestamp).toISOString(),
    d.lat.toFixed(7),
    d.lon.toFixed(7),
    d.speedKnots.toFixed(2),
    d.headingDeg.toFixed(1),
    d.gnssFixOk,
    d.carrSoln,
    d.numSV,
  ].join(',');
  fs.appendFile(csvPath, line + '\n', (err) => {
    if (err) console.error('[base] csv write failed:', err.message);
  });
}

// --- Adapter: replace this once you know your race software's expected
// input format/protocol. Currently emits a standard NMEA GGA sentence over
// UDP broadcast, which some tracking tools can ingest directly. ---
function outputFrame(d) {
  const sentence = toGGA(d);
  const buf = Buffer.from(sentence + '\r\n');
  udpSocket.send(buf, UDP_PORT, UDP_BROADCAST_ADDR);
}

function toGGA(d) {
  const t = new Date(d.timestamp);
  const hhmmss =
    String(t.getUTCHours()).padStart(2, '0') +
    String(t.getUTCMinutes()).padStart(2, '0') +
    String(t.getUTCSeconds()).padStart(2, '0');

  const latAbs = Math.abs(d.lat);
  const latDeg = Math.floor(latAbs);
  const latMin = (latAbs - latDeg) * 60;
  const latStr = `${String(latDeg).padStart(2, '0')}${latMin.toFixed(4).padStart(7, '0')}`;
  const latHem = d.lat >= 0 ? 'N' : 'S';

  const lonAbs = Math.abs(d.lon);
  const lonDeg = Math.floor(lonAbs);
  const lonMin = (lonAbs - lonDeg) * 60;
  const lonStr = `${String(lonDeg).padStart(3, '0')}${lonMin.toFixed(4).padStart(7, '0')}`;
  const lonHem = d.lon >= 0 ? 'E' : 'W';

  const fixQuality = d.carrSoln === 2 ? 4 : d.carrSoln === 1 ? 5 : d.gnssFixOk ? 1 : 0; // 4=RTK fixed,5=RTK float,1=GPS
  const body = `GPGGA,${hhmmss},${latStr},${latHem},${lonStr},${lonHem},${fixQuality},${String(d.numSV).padStart(2, '0')},1.0,0.0,M,0.0,M,,`;
  return '$' + body + '*' + checksum(body);
}

function checksum(str) {
  let cs = 0;
  for (let i = 0; i < str.length; i++) cs ^= str.charCodeAt(i);
  return cs.toString(16).toUpperCase().padStart(2, '0');
}

if (config.simulate) {
  console.log(`[baseStation] SIMULATE=1 - listening for sim radio frames on UDP :${config.sim.port}`);
} else if (config.radio.enabled) {
  console.log(`[baseStation] listening on radio ${config.radio.port} @ ${config.radio.baud}`);
} else {
  console.log('[baseStation] Radio disabled (NO_RADIO=1) - no frames will arrive, other outputs still testable');
}
console.log(`[baseStation] logging to ${csvPath}`);
console.log(
  `[baseStation] recording fixes to Redis at ${
    config.redis.url || `${config.redis.connection.host}:${config.redis.connection.port}`
  }`
);
console.log(`[baseStation] broadcasting NMEA GGA over UDP ${UDP_BROADCAST_ADDR}:${UDP_PORT}`);
