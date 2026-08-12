const { SerialPort } = require('serialport');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { UbxParser } = require('./ubxParser');
const { RadioLink } = require('./radioLink');
const { SdLogger } = require('./sdLogger');
const protocol = require('./protocol');
const { distanceMeters, MARK_NAMES } = require('./course');
const { startUploadClient, countPending } = require('./uploadClient');
const { startRoverAdminServer } = require('./roverAdminServer');
const roverStats = require('./roverStats');

// True while the cursor is sitting mid-line after an in-place GPS log
// overwrite (see handlePvt's inPlaceMode) - any *other* log call landing
// while that's true would otherwise get silently tacked onto the end of
// that same line instead of starting its own, since nothing else in this
// process knows the cursor isn't at column 0. Wrapping console.log/warn/
// error here (rather than auditing every call site across this file and
// every module it pulls in - radioLink, uploadClient, roverStats, ...) is
// the only way to catch all of them, including ones added later. warn/
// error are included too, not just log - stdout and stderr both render to
// the same physical terminal, so either can land on that dirty line.
let gpsLineDirty = false;
for (const method of ['log', 'warn', 'error']) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    if (gpsLineDirty) {
      process.stdout.write('\n');
      gpsLineDirty = false;
    }
    original(...args);
  };
}

console.log(`[boatAgent] starting, boatId=${config.boatId}`);
if (config.noGps) {
  console.log('[boatAgent] NO_GPS=1 - not starting any GPS source (real or simulated)');
} else if (config.simulateGps) {
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

// Short labels for the rover admin dashboard (see getRoverStats below) -
// mirrors the startup log conditionals above without duplicating them.
const gpsMode = config.noGps ? 'none' : config.simulateGps ? 'simulated' : 'real';
const radioMode = config.simulate ? 'simulated' : config.radio.enabled ? 'real' : 'none';

// This boat's own admin dashboard port. In SIMULATE mode, defaults to a
// different port than the base's own dashboard (config.admin.port, 8092)
// so `npm run base` and `npm run boat` can run on the same machine without
// an EADDRINUSE - a real deployment always has these on separate machines,
// so config.admin.port's default is fine as-is there. An explicit
// ADMIN_PORT env var always wins, on either side.
const myAdminPort = process.env.ADMIN_PORT ? config.admin.port : config.simulate ? 8093 : config.admin.port;

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
  const loaded = JSON.parse(fs.readFileSync(marksFilePath, 'utf8'));
  // Reject a cache written by an older version of this app whose mark
  // schema doesn't match the current one (e.g. before green/black mark
  // pairs existed) - trusting it as-is would crash deriveGeometry on a
  // missing property the moment startGpsSimIfReady runs. Treat it the
  // same as no cache at all: wait for the next broadcast to write a
  // fresh one in the current shape.
  if (MARK_NAMES.every((name) => loaded[name])) {
    currentMarks = loaded;
    console.log(`[boatAgent] loaded last-known course marks from disk: ${Object.keys(currentMarks).join(', ')}`);
  } else {
    console.log('[boatAgent] persisted course marks on disk are in an outdated format - ignoring, waiting for a fresh broadcast');
  }
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

radio.on('marks', ({ marks, baseIp, basePort, baseAdminPort }) => {
  currentMarks = marks;
  baseAddress = baseIp && baseIp !== '0.0.0.0' ? { ip: baseIp, port: basePort, adminPort: baseAdminPort } : null;
  roverStats.recordMarksReceived();
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

radio.on('sync-error', () => roverStats.recordSyncError());

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
    adminPort: myAdminPort,
  });
} else {
  console.log('[boatAgent] log upload disabled (UPLOAD_DISABLED=1)');
}

let lastTxPosition = null; // {lat, lon} of the last fix actually transmitted
let lastPvt = null;

function handlePvt(pvt) {
  lastPvt = pvt;
  roverStats.recordFix(pvt);

  // Distance-based, not time-based: send whenever the boat has actually
  // moved TX_DISTANCE_M since the last transmitted fix, regardless of how
  // long that took - a stopped or barely-drifting boat doesn't need to
  // keep re-transmitting the same position on a timer, and a fast-moving
  // one gets updates as often as its own movement actually warrants. The
  // SD log follows the exact same gate rather than logging every fix -
  // the SD record is meant to mirror what actually went out over the
  // radio, not a separate full-rate trace, so a fix that wouldn't have
  // been worth transmitting isn't worth logging either.
  const movedM = lastTxPosition ? distanceMeters(lastTxPosition, pvt) : Infinity;
  const clearedTxGate = movedM >= config.txDistanceM;

  // GPS_LOG_ALL=1 logs every fix (1-10Hz, noisy); off by default, which
  // instead follows the same TX_DISTANCE_M gate as the SD log/radio TX
  // above - so the console mirrors what actually happened, not the full
  // raw stream.
  if (config.gps.logConsole && (config.gps.logAll || clearedTxGate)) {
    // Timestamp included mainly for the in-place overwrite mode below - a
    // stationary boat can otherwise repeat the exact same line forever,
    // which looks indistinguishable from a frozen/dead connection. The
    // clock visibly ticking is what proves it's still live.
    const time = new Date(pvt.timestamp).toISOString().slice(11, 23);
    const line =
      `[gps] ${time} ${pvt.lat.toFixed(6)},${pvt.lon.toFixed(6)} ` +
      `fixType=${pvt.fixType} diffSoln=${pvt.diffSoln} carrSoln=${pvt.carrSoln} numSV=${pvt.numSV} ` +
      `hAcc=${(pvt.hAccMm / 1000).toFixed(2)}m`;
    // In-place overwriting only ever applies when GPS_LOG_ALL is actually
    // on AND stdout is a real interactive terminal - piped to a file or
    // captured by systemd/journald, `\x1b[2K\r` would just write raw
    // control characters into the log instead of behaving like an
    // overwrite, so that combination always falls through to a plain
    // console.log below (same as the GPS_LOG_ALL=0 default already did).
    // GPS_LOG_REPLACE=0 opts out of it entirely (always scroll instead).
    const inPlaceMode = config.gps.logAll && config.gps.logReplace && process.stdout.isTTY;
    if (inPlaceMode && !clearedTxGate) {
      // Noise between the fixes that matter - overwrite the same
      // terminal line instead of scrolling at the full 1-10Hz GPS rate.
      // `\x1b[2K\r` clears whatever's on the line first so a shorter new
      // line never leaves stale trailing characters from a longer one.
      // gpsLineDirty stays true - see the console wrapper above, which is
      // what stops some *other* log call from landing on this same line.
      process.stdout.write(`\x1b[2K\r${line}`);
      gpsLineDirty = true;
    } else if (inPlaceMode) {
      // A real event (cleared the gate) while in TTY full-logging mode -
      // clear any pending in-place line first, then commit this one to
      // scrollback with a trailing newline.
      process.stdout.write(`\x1b[2K\r${line}\n`);
      gpsLineDirty = false;
    } else {
      console.log(line);
    }
  }

  if (clearedTxGate) {
    lastTxPosition = { lat: pvt.lat, lon: pvt.lon };
    sdLogger.logPvt(pvt);
    const frame = protocol.encode(config.boatId, pvt);
    const sent = radio.send(frame);
    if (sent) roverStats.recordFrameSent();
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
  if (config.noGps || !config.simulateGps || gpsSimStarted || !currentMarks) return;
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

  // The green leeward mark *is* the course's center/reference point by
  // construction (course.js), so it's exactly what SimGpsSource needs.
  // The simulator always races the green (short-course) marks - never the
  // black (long-course) ones, which exist only for reference (see
  // course.js's getMarks comment).
  const gps = new SimGpsSource({
    centerLat: currentMarks.leewardGreen.lat,
    centerLon: currentMarks.leewardGreen.lon,
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

if (config.noGps) {
  // Radio (real or simulated), marks reception, and the upload client are
  // all still fully running above - this just skips ever starting a GPS
  // source, real or simulated, so no position fixes/frames are produced.
} else if (config.simulateGps) {
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

// Assembles this boat's own dashboard snapshot (see roverAdminServer.js) -
// merges the running counters in roverStats with whatever else the
// dashboard needs that roverStats itself has no reason to track (course
// marks, the base's address, how many chunks are still unsent).
function getRoverStats() {
  const snapshot = roverStats.snapshot();
  return {
    ...snapshot,
    boatId: config.boatId,
    gpsMode,
    radioMode,
    currentMarks,
    marksReceivedCount: snapshot.marks.received,
    lastMarksReceivedAt: snapshot.marks.lastReceivedAt,
    pendingCount: countPending(config.logDir, config.boatId, config.logChunkMinutes),
    baseIp: baseAddress ? baseAddress.ip : null,
    adminPort: baseAddress ? baseAddress.adminPort : null,
  };
}

// Deliberately separate from getRoverStats above - the map's live-refresh
// loop (see roverAdminServer.js's renderMap) only ever needs the current
// fix, not the full dashboard snapshot, so this skips countPending's
// fs.readdirSync entirely - no reason to re-scan the log directory every
// 5s just to throw the result away.
function getPosition() {
  return lastPvt
    ? {
        lat: lastPvt.lat,
        lon: lastPvt.lon,
        timestamp: lastPvt.timestamp,
        carrSoln: lastPvt.carrSoln,
        gnssFixOk: lastPvt.gnssFixOk,
        numSV: lastPvt.numSV,
        hAccMm: lastPvt.hAccMm,
      }
    : null;
}

startRoverAdminServer({ port: myAdminPort, getStats: getRoverStats, getPosition });

// Simple heartbeat so you can tell the process is alive even with no fix yet.
setInterval(() => {
  if (!lastPvt) console.log('[boatAgent] waiting for first GPS fix...');
}, 10000);

process.on('SIGINT', () => {
  console.log('\n[boatAgent] shutting down');
  process.exit(0);
});
