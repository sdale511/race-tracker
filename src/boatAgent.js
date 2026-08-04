const { SerialPort } = require('serialport');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { UbxParser } = require('./ubxParser');
const { RadioLink } = require('./radioLink');
const { SdLogger } = require('./sdLogger');
const protocol = require('./protocol');
const { distanceMeters } = require('./course');
const { startUploadClient } = require('./uploadClient');

console.log(`[boatAgent] starting, boatId=${config.boatId}`);
if (config.simulateGps) {
  console.log(
    config.simulate
      ? '[boatAgent] SIMULATE=1 - using a fake GPS track (no GPS hardware)'
      : '[boatAgent] SIMULATE_GPS=1 - using a fake GPS track, real radio hardware'
  );
} else {
  console.log(`[boatAgent] GPS  ${config.gps.port} @ ${config.gps.baud}`);
}
if (config.simulate) {
  console.log(`[boatAgent] sim radio - UDP broadcast on :${config.sim.port}`);
} else if (config.radio.enabled) {
  console.log(`[boatAgent] Radio ${config.radio.port} @ ${config.radio.baud}`);
} else {
  console.log('[boatAgent] Radio disabled (NO_RADIO=1) - fixes still log to SD');
}

const sdLogger = new SdLogger({
  logDir: config.logDir,
  boatId: config.boatId,
  retentionDays: config.logRetentionDays,
  chunkMinutes: config.logChunkMinutes,
});

let radio;
if (config.simulate) {
  const { SimRadioLink } = require('./simRadioLink');
  radio = new SimRadioLink({
    port: config.sim.port,
    packetLossPct: config.sim.packetLossPct,
  });
  radio.on('error', (err) => console.error('[radio] error:', err.message));
  radio.on('disconnected', () => console.warn('[radio] disconnected, retrying...'));
} else if (config.radio.enabled) {
  radio = new RadioLink({ port: config.radio.port, baud: config.radio.baud });
  radio.on('error', (err) => console.error('[radio] error:', err.message));
  radio.on('disconnected', () => console.warn('[radio] disconnected, retrying...'));
} else {
  radio = new EventEmitter(); // NO_RADIO=1 - never emits 'frame'/'marks', other outputs still testable
  radio.send = () => false;
}

// Course marks (windward/leeward/pin/committee/finish), as last broadcast by
// the base station - a real rover has no Redis access of its own (see
// baseStation.js's mark-broadcast comment), so this is the only way it ever
// learns the course. Kept in memory for anything on the boat that wants it
// this run, and persisted to disk so a reboot/restart still has a last-known
// course immediately, without waiting for the next broadcast.
const marksFilePath = path.join(config.logDir, 'course_marks.json');
let currentMarks = null;
try {
  currentMarks = JSON.parse(fs.readFileSync(marksFilePath, 'utf8'));
  console.log(`[boatAgent] loaded last-known course marks from disk: ${Object.keys(currentMarks).join(', ')}`);
} catch (err) {
  if (err.code !== 'ENOENT') console.error('[boatAgent] failed to read persisted course marks:', err.message);
}

// The base's address for log uploads (see uploadClient.js), as last
// broadcast alongside the marks - not persisted to disk like currentMarks
// below, since it's much more likely to go stale across a restart (a
// reassigned DHCP lease, the base itself restarting) and a wrong cached
// address is worse than just waiting for the next broadcast to learn the
// current one.
let baseAddress = null;

radio.on('marks', ({ marks, baseIp, basePort }) => {
  currentMarks = marks;
  baseAddress = baseIp && baseIp !== '0.0.0.0' ? { ip: baseIp, port: basePort } : null;
  try {
    fs.writeFileSync(marksFilePath, JSON.stringify(marks));
  } catch (err) {
    console.error('[boatAgent] failed to persist course marks to disk:', err.message);
  }
  console.log(
    `[boatAgent] ${new Date().toISOString()} received course marks from base station: ${Object.keys(marks).join(', ')}` +
      (baseAddress ? `, upload address: ${baseAddress.ip}:${baseAddress.port}` : '')
  );
  startGpsSimIfReady();
});

// Pushes completed chunked SD-card logs to the base whenever it's actually
// reachable over WiFi (see uploadClient.js) - independent of GPS
// source/simulate mode, since this is really about the boat's own
// microSD-backed log files, not position data.
if (config.upload.enabled) {
  startUploadClient({
    logDir: config.logDir,
    boatId: config.boatId,
    chunkMinutes: config.logChunkMinutes,
    getBaseAddress: () => baseAddress,
    checkIntervalMs: config.upload.checkIntervalMs,
    timeoutMs: config.upload.timeoutMs,
  });
} else {
  console.log('[boatAgent] log upload disabled (UPLOAD_DISABLED=1)');
}

let lastTxPosition = null; // {lat, lon} of the last fix actually transmitted
let lastPvt = null;

function handlePvt(pvt) {
  lastPvt = pvt;
  sdLogger.logPvt(pvt); // log every fix, full rate
  console.log(
    `[gps] ${pvt.lat.toFixed(6)},${pvt.lon.toFixed(6)} ` +
      `fixType=${pvt.fixType} diffSoln=${pvt.diffSoln} carrSoln=${pvt.carrSoln} numSV=${pvt.numSV} ` +
      `hAcc=${(pvt.hAccMm / 1000).toFixed(2)}m`
  );

  // Distance-based, not time-based: send whenever the boat has actually
  // moved TX_DISTANCE_M since the last transmitted fix, regardless of how
  // long that took - a stopped or barely-drifting boat doesn't need to
  // keep re-transmitting the same position on a timer, and a fast-moving
  // one gets updates as often as its own movement actually warrants.
  const movedM = lastTxPosition ? distanceMeters(lastTxPosition, pvt) : Infinity;
  if (movedM >= config.txDistanceM) {
    lastTxPosition = { lat: pvt.lat, lon: pvt.lon };
    const frame = protocol.encode(config.boatId, pvt);
    const sent = radio.send(frame);
    if (!sent && config.radio.enabled) console.warn('[radio] not connected, dropped a frame (still logged to SD)');
  }
}

function openGps() {
  const gpsPort = new SerialPort({ path: config.gps.port, baudRate: config.gps.baud }, (err) => {
    if (err) {
      console.error('[gps] open failed:', err.message, '- retrying in 3s');
      setTimeout(openGps, 3000);
    }
  });

  const parser = new UbxParser();

  gpsPort.on('data', (chunk) => parser.write(chunk));
  gpsPort.on('close', () => {
    console.warn('[gps] port closed, retrying in 3s');
    setTimeout(openGps, 3000);
  });
  gpsPort.on('error', (err) => console.error('[gps] error:', err.message));

  parser.on('checksum-error', () => {
    // Occasional corrupt frames are normal on long/noisy UART runs; only
    // worry if this fires constantly.
  });

  parser.on('nav-pvt', handlePvt);
}

// True once the simulated GPS has actually started, so a mark broadcast
// arriving mid-race (the periodic re-broadcast, not just the first one)
// doesn't try to start a second one.
let gpsSimStarted = false;

// Starts the simulated GPS as soon as marks are actually known - either
// immediately (a persisted copy was already on disk from a previous run) or
// whenever the first broadcast arrives (see radio.on('marks', ...) above).
// No Redis access here at all: a real rover can't reach Redis, so the sim
// GPS source has to wait on exactly the same information a real rover would
// have to wait on - whatever the base station has actually radioed out.
function startGpsSimIfReady() {
  if (!config.simulateGps || gpsSimStarted || !currentMarks) return;
  gpsSimStarted = true;

  const { SimGpsSource } = require('./simGps');
  const { deriveGeometry } = require('./course');

  // Measured from the marks themselves, not assumed from this process's own
  // SIM_COURSE_LENGTH_NM - the base station is the one authority on course
  // length now (it owns Redis and does the actual clear-and-recompute when
  // that env var changes); this boat just races whatever geometry the marks
  // it received actually describe.
  const geometry = deriveGeometry(currentMarks);

  // No Redis-assigned sequential start slot anymore (a real rover has no
  // Redis access, and registration-order slot assignment lived there) -
  // fall back to the boat's own ID. getStartPosition's existing modulo
  // wraparound still keeps every boat on the real line rather than
  // overflowing past it, but boats no longer get spread out in the
  // registration order they actually joined in - a real per-boat start
  // slot would need the base to assign and broadcast one, which isn't
  // implemented.
  const startSlot = config.boatId;

  console.log(`[boatAgent] starting simulated GPS, course marks: ${Object.keys(currentMarks).join(', ')}, start slot: ${startSlot}`);

  // The leeward mark *is* the course's center/reference point by
  // construction (course.js), so it's exactly what SimGpsSource needs.
  const gps = new SimGpsSource({
    centerLat: currentMarks.leeward.lat,
    centerLon: currentMarks.leeward.lon,
    upwindSpeedKn: config.sim.upwindSpeedKn,
    downwindSpeedKn: config.sim.downwindSpeedKn,
    hz: config.sim.gpsHz,
    startSlot,
    lapCount: config.sim.lapCount,
    geometry,
  });
  gps.on('nav-pvt', handlePvt);
  // Diagnostic only - the sim's own internal lap counting, used to decide
  // when the simulated race ends and to report whether it stayed inside
  // the gate for tuning purposes. Actual lap *reporting* (to the base
  // station, and from there to RegattaUp) happens on the base station
  // side now (see finishLineWatcher.js there) - a real rover has no Redis
  // access to resolve marks itself, so it can only ever send its raw
  // position, the same as this sim GPS source does via handlePvt above.
  gps.on('lap', ({ lap, inGate, eastM }) =>
    console.log(`[boatAgent] (sim) completed lap ${lap} ${inGate ? 'through the finish gate' : `OUTSIDE the finish gate (east=${eastM.toFixed(1)}m)`}`)
  );
  gps.on('finished', ({ laps }) => {
    console.log(
      `[boatAgent] finished simulated race after ${laps} lap(s) - ` +
        'staying alive so any pending log upload still gets a chance to go out (see uploadClient.js)'
    );
    // SimGpsSource already stopped its own tick timer before emitting this
    // (see simGps.js), so nothing keeps producing fixes/position frames -
    // the process just idles here, with the upload client's own periodic
    // check (UPLOAD_CHECK_INTERVAL_MS) still running in the background
    // until this process is stopped (Ctrl+C, or a systemd restart).
  });
}

if (config.simulateGps) {
  if (currentMarks) {
    startGpsSimIfReady();
  } else {
    console.log(
      '[boatAgent] SIMULATE_GPS - no course marks yet, waiting for a broadcast from the base station ' +
        '(NO_RADIO=1 has no radio to receive one on, so this would wait forever)'
    );
  }
} else {
  openGps();
}

// Simple heartbeat so you can tell the process is alive even with no fix yet.
setInterval(() => {
  if (!lastPvt) console.log('[boatAgent] waiting for first GPS fix...');
}, 10000);

process.on('SIGINT', () => {
  console.log('\n[boatAgent] shutting down');
  process.exit(0);
});
