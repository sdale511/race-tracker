const { SerialPort } = require('serialport');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const config = require('./config');
const { UbxParser, encodeNavPvt, RTCM_MSG_USED_NAMES } = require('./ubxParser');
const { toGGA } = require('./nmea');
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

// Local UDP broadcast of this boat's own fixes - onboard instruments
// (chartplotter, a laptop running OpenCPN, u-center) on the same LAN can
// pick this up directly, independent of the long-range radio TX to the
// base station below. Runs unthrottled (every fix, not gated by
// TX_DISTANCE_M like the radio) since it's a local broadcast, not
// bandwidth-constrained long-range airtime. Same format choice and
// UDP_BROADCAST_ADDR/UDP_PORT settings as baseStation.js's own copy of
// this - see config.js's localBroadcast.
const localBroadcastSocket = dgram.createSocket('udp4');
localBroadcastSocket.bind(() => localBroadcastSocket.setBroadcast(true));

function outputLocalFrame(pvt) {
  const buf = config.localBroadcast.format === 'nmea' ? Buffer.from(toGGA(pvt) + '\r\n') : encodeNavPvt(pvt);
  localBroadcastSocket.send(buf, config.localBroadcast.port, config.localBroadcast.address);
}

console.log(
  `[boatAgent] broadcasting ${config.localBroadcast.format.toUpperCase()} over UDP ${config.localBroadcast.address}:${config.localBroadcast.port}`
);

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

// True once marks have actually been received on THIS run, as opposed to
// the possibly-stale copy loaded from disk above. SIMULATE_GPS always waits
// for this before starting a simulated race - the disk cache exists so a
// restart has *something* immediately, but a real rover has no way to know
// whether the base's course has changed since that copy was written, so the
// simulator (standing in for a real rover, which would just report whatever
// its hardware GPS says regardless of marks) shouldn't either.
let freshMarksReceived = false;

radio.on('marks', ({ marks, baseIp, basePort, baseAdminPort }) => {
  currentMarks = marks;
  freshMarksReceived = true;
  stopMarksPingRetry();
  baseAddress = baseIp && baseIp !== '0.0.0.0' ? { ip: baseIp, port: basePort, adminPort: baseAdminPort } : null;
  roverStats.recordMarksReceived();
  try {
    fs.writeFileSync(marksFilePath, JSON.stringify(marks));
  } catch (err) {
    console.error('[boatAgent] failed to persist course marks to disk:', err.message);
  }
  console.log(
    '[boatAgent] received course marks from base station' +
      (baseAddress ? `, upload ${baseAddress.ip}:${baseAddress.port}` : '')
  );
  startGpsSimIfReady();
});

// Without this, a fresh boat has to sit idle for up to
// MARKS_BROADCAST_INTERVAL_MS (60s default) before it ever hears the
// course: the base only re-broadcasts immediately upon hearing a boat that
// looks like it just (re)started (see baseStation.js's lastSeenByBoat),
// which requires this boat to have already sent a frame - a chicken-and-egg
// wait that's pure friction during
// testing/iteration, since SIMULATE_GPS can't start until freshMarksReceived
// either way. One throwaway frame, using the exact same encode/send path a
// real fix would, breaks that: it's not itself meant to be a tracked
// position (see the position choice below), only to get this boat's ID
// heard so the base's own "new boat" broadcast fires right away.
//
// Position: the best guess available before real marks exist - last-known
// marks from disk (loaded above, if this boat has run before), else
// SIM_CENTER_LAT/LON's own configured point. Deliberately NOT some
// arbitrary sentinel like (0,0): every position-based watcher on the base
// (finish line, on-grid, mark rounding) only compares a NEW fix against
// this boat's own PREVIOUS one to detect a crossing, so keeping the ping
// close to where the boat will actually start avoids a spurious crossing
// on the real fix that follows it - and specifically the midpoint of
// pin<->committee, not a mark itself: this frame gets recorded and shown
// on the map exactly like a real fix (see baseStation.js's radio.on
// ('frame', ...)), so landing it on, say, leewardGreen would show the
// boat starting AT a course mark it was never actually near. The midpoint
// is guaranteed to read as on-grid (see onGridWatcher.js) regardless of
// which slot this boat ends up drawing once it actually starts.
function sendMarksPing() {
  const pos = currentMarks
    ? { lat: (currentMarks.pin.lat + currentMarks.committee.lat) / 2, lon: (currentMarks.pin.lon + currentMarks.committee.lon) / 2 }
    : { lat: config.sim.centerLat, lon: config.sim.centerLon };
  const pingPvt = {
    timestamp: Date.now(),
    lat: pos.lat,
    lon: pos.lon,
    gSpeedMmS: 0,
    headMotDeg: 0,
    gnssFixOk: true,
    carrSoln: 0,
    numSV: 0,
  };
  const sent = radio.send(protocol.encode(config.boatId, pingPvt));
  // Same "best effort, not critical" handling as handlePvt's own send
  // below - a real radio that isn't connected yet just falls back to the
  // periodic broadcast, same as before this ping existed at all.
  if (!sent && config.radio.enabled) console.warn('[radio] not connected, dropped a marks-ping frame');
}

// A single ping isn't enough - the base might not even be up yet when this
// boat starts (there's no guaranteed startup order between the two
// processes), or the one frame could just be lost, and either way there's
// no ack to know it missed. Retries on a short interval until marks
// actually arrive, rather than falling back to the full
// MARKS_BROADCAST_INTERVAL_MS heartbeat after a single failed attempt -
// stopped the instant real marks show up (see stopMarksPingRetry, called
// from the 'marks' handler above), so this never lingers once it's done
// its job.
let marksPingIntervalId = null;
const MARKS_PING_RETRY_MS = 3000;

function startMarksPingRetry() {
  if (marksPingIntervalId || freshMarksReceived) return;
  sendMarksPing();
  marksPingIntervalId = setInterval(sendMarksPing, MARKS_PING_RETRY_MS);
}

function stopMarksPingRetry() {
  if (marksPingIntervalId) {
    clearInterval(marksPingIntervalId);
    marksPingIntervalId = null;
  }
}

// Waits for radio's own 'connected' event (both RadioLink and
// SimRadioLink emit it once actually ready to send - see radioLink.js/
// simRadioLink.js) rather than calling startMarksPingRetry() immediately
// here: SimRadioLink's socket bind() is asynchronous, so sending right
// after construction would race ahead of setBroadcast(true) actually
// running - on at least some OSes that silently drops a broadcast send
// entirely (no error, no exception, just never arrives), which is exactly
// the kind of one-off miss these pings are meant to prevent, not
// reproduce. The NO_RADIO stub never emits 'connected', so this is simply
// a no-op there (nothing to ping over anyway). Left as a persistent
// listener, not `.once()`, so a boat that reconnects after a radio dropout
// (re-)starts retrying too, rather than only ever getting the marks-ping
// benefit on its very first connection.
if (config.simulateGps) radio.on('connected', startMarksPingRetry);

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
  outputLocalFrame(pvt);

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

  // Every fix gets a console line, same as the base's own GPS logging
  // (openBaseGps in baseStation.js) - the console is a live "is this thing
  // still getting fixes" view, independent of the SD log/radio TX below,
  // which stay gated on TX_DISTANCE_M since that's about what's actually
  // worth transmitting/recording, not what's worth watching.
  if (config.gps.logConsole) {
    // Timestamp included mainly for the in-place overwrite mode below - a
    // stationary boat can otherwise repeat the exact same line forever,
    // which looks indistinguishable from a frozen/dead connection. The
    // clock visibly ticking is what proves it's still live.
    const time = new Date(pvt.timestamp).toISOString().slice(11, 23);
    const line =
      `[gps] ${time} ${pvt.lat.toFixed(6)},${pvt.lon.toFixed(6)} ` +
      `fixType=${pvt.fixType} diffSoln=${pvt.diffSoln} carrSoln=${pvt.carrSoln} numSV=${pvt.numSV} ` +
      `hAcc=${(pvt.hAccMm / 1000).toFixed(2)}m`;
    // In-place overwriting only ever applies when stdout is a real
    // interactive terminal - piped to a file or captured by
    // systemd/journald, `\x1b[2K\r` would just write raw control characters
    // into the log instead of behaving like an overwrite, so that case
    // always falls through to a plain console.log below. GPS_LOG_REPLACE=0
    // opts out of it entirely (always scroll instead) - same guard as
    // baseStation.js's openBaseGps.
    const inPlaceMode = config.gps.logReplace && process.stdout.isTTY;
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

  if (clearedTxGate) transmitFix(pvt);
}

// Actually sends a fix over the radio (real or simulated) and logs it to
// SD - the second half of handlePvt's own clearedTxGate branch, pulled out
// so the ping handler below (which transmits the current fix on request,
// deliberately bypassing the movement gate - see its own comment) can reuse
// the exact same send/log/stats path rather than duplicating it.
// lastTxPosition is updated here too, same as a normal gated transmit, so a
// ping response doesn't leave the NEXT ordinary fix thinking it still needs
// to cover the same distance from further back than it actually last sent.
function transmitFix(pvt) {
  lastTxPosition = { lat: pvt.lat, lon: pvt.lon };
  sdLogger.logPvt(pvt);
  const frame = protocol.encode(config.boatId, pvt);
  const sent = radio.send(frame);
  if (sent) roverStats.recordFrameSent();
  if (!sent && config.radio.enabled) console.warn('[radio] not connected, dropped a frame (still logged to SD)');
}

// Base-triggered "report your current position now" (see protocol.js's
// encodePing/adminServer.js's "Ping fleet" button) - mainly for a boat
// that's been sitting stationary since before the base/dashboard was even
// up: a stationary boat only ever clears the TX_DISTANCE_M gate once (see
// handlePvt above), so without this the base has no way to learn it's
// there, on-grid, right now. Responds with whatever lastPvt already is
// (nothing new to acquire - GPS fixes arrive continuously regardless of
// whether they're ever transmitted), after a random delay up to
// config.pingResponseJitterMs so an entire fleet doesn't all key up over
// each other on the same shared channel the instant they hear the request.
radio.on('ping', () => {
  if (!lastPvt) return; // no fix yet at all - nothing to report
  const delayMs = Math.random() * config.pingResponseJitterMs;
  setTimeout(() => transmitFix(lastPvt), delayMs);
});

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

  // The only direct evidence this app can show that RTCM corrections are
  // actually reaching the receiver - that link runs over the module's own
  // onboard correction radio, entirely separate hardware from GPS_PORT/
  // RADIO_PORT (see README's "Wiring notes"), so this app has no other way
  // to see it. Requires two separate opt-ins before anything shows up
  // here: UBX-RXM-RTCM enabled as an output on this same UART on the
  // receiver itself (see ubxParser.js's own comment - off by default there
  // too, so seeing nothing doesn't by itself mean no corrections are
  // arriving, only that this message hasn't been turned on to report it),
  // and GPS_LOG_RTCM=1 here (see config.js - off by default so a one-off
  // diagnostic enable on the receiver doesn't also start scrolling
  // unwanted lines on every ordinary run afterward). crcFailed is a real
  // problem (a corrupted correction, dropped); msgUsed='not used' on its
  // own isn't - plenty of message types (e.g. a constellation you're not
  // tracking) are legitimately ignored.
  parser.on('rxm-rtcm', (msg) => {
    roverStats.recordRtcm(msg);
    if (!config.gps.logConsole || !config.gps.logRtcm) return;
    const used = RTCM_MSG_USED_NAMES[msg.msgUsed] || msg.msgUsed;
    const line = `[rtcm] type=${msg.msgType} station=${msg.refStation} used=${used}${msg.crcFailed ? ' CRC-FAILED' : ''}`;
    if (msg.crcFailed) console.warn(line);
    else console.log(line);
  });
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
  if (config.noGps || !config.simulateGps || gpsSimStarted || !freshMarksReceived) return;
  gpsSimStarted = true;

  const { SimGpsSource } = require('./simGps');
  const { deriveGeometry, getRaceMarks } = require('./course');

  // Measured from the marks themselves, not assumed from this process's own
  // SIM_COURSE_LENGTH_NM - the base station is the one authority on course
  // length now (it owns Redis and does the actual clear-and-recompute when
  // that env var changes); this boat just races whatever geometry the marks
  // it received actually describe, between whichever windward/leeward pair
  // config.sim.courseMarks picks (default 'GG', the plain short course).
  const geometry = deriveGeometry(currentMarks, config.sim.courseMarks);
  const raceMarks = getRaceMarks(currentMarks, config.sim.courseMarks);

  // No Redis-assigned sequential start slot anymore (a real rover has no
  // Redis access, and registration-order slot assignment lived there) -
  // and not the boat's own ID either, which would put this boat at the
  // exact same spot on the line every single run, back to back, real
  // testing usually wants a start position that actually varies (a fresh
  // random draw each time this boat process starts, i.e. once per
  // simulated race - startGpsSimIfReady only ever runs once per process).
  // getStartFraction's existing modulo wraparound maps any integer onto a
  // real slot on the line, so the draw doesn't need to know maxSlots
  // itself - a real per-boat start slot assigned by the base isn't
  // implemented, so this is a stand-in either way, not registration order.
  const startSlot = Math.floor(Math.random() * 1000);

  console.log(
    `[boatAgent] starting simulated GPS, course marks: ${Object.keys(currentMarks).join(', ')}, ` +
      `racing ${raceMarks.windwardName}/${raceMarks.leewardName} (SIM_COURSE_MARKS=${config.sim.courseMarks}), start slot: ${startSlot}`
  );

  // The resolved leeward mark (see raceMarks above, and config.sim.courseMarks)
  // is the course's center/reference point for this run - SimGpsSource's
  // whole local tacking frame is built around it being at local (0,0), and
  // geometry.courseLengthM/courseBearingDeg were measured from this exact
  // same mark, so the two have to agree on which one that is.
  const gps = new SimGpsSource({
    centerLat: raceMarks.leeward.lat,
    centerLon: raceMarks.leeward.lon,
    upwindSpeedKn: config.sim.upwindSpeedKn,
    downwindSpeedKn: config.sim.downwindSpeedKn,
    hz: config.sim.gpsHz,
    startSlot,
    lapCount: config.sim.lapCount,
    geometry,
    startOnly: config.sim.startOnly,
    prestartDwellS: config.sim.prestartDwellS,
    // The start/finish line logic needs the REAL pin/committee/finish
    // positions, not just geometry's scalar distances - see simGps.js's
    // own comment on why (an edited windward mark rotates the beat axis
    // independently of wherever the start/finish complex actually still is).
    pin: currentMarks.pin,
    committee: currentMarks.committee,
    finish: currentMarks.finish,
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
    if (config.sim.exitOnFinish) {
      console.log(`[boatAgent] finished simulated race after ${laps} lap(s) - exiting (SIM_EXIT_ON_FINISH=1)`);
      process.exit(0);
      return;
    }
    console.log(`[boatAgent] finished simulated race after ${laps} lap(s) - staying alive for pending uploads`);
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
  console.log(
    '[boatAgent] SIMULATE_GPS - waiting for a fresh course marks broadcast from the base station before starting' +
      (currentMarks ? ' (ignoring the last-known copy cached on disk - it may be stale)' : '') +
      (radioMode === 'none' ? ' (NO_RADIO=1 has no radio to receive one on, so this would wait forever)' : '')
  );
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
    baseUploadPort: baseAddress ? baseAddress.port : null,
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
