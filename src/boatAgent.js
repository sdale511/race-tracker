require('./logTimestamps');
const { SerialPort } = require('serialport');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const util = require('util');
const config = require('./config');
const logBuffer = require('./logBuffer');
const { UbxParser, encodeNavPvt, RTCM_MSG_USED_NAMES } = require('./ubxParser');
const { toGGA } = require('./nmea');
const { RadioLink } = require('./radioLink');
const { SdLogger } = require('./sdLogger');
const { pruneForDiskSpace } = require('./logRotation');
const protocol = require('./protocol');
const { distanceMeters, MARK_NAMES } = require('./course');
const { startUploadClient, countPending } = require('./uploadClient');
const { startRoverAdminServer } = require('./roverAdminServer');
const roverStats = require('./roverStats');
const { getDiskSpace, CRITICAL_BELOW_PCT } = require('./diskSpace');
const { startShutdownScheduler } = require('./powerSchedule');

// True while the cursor is sitting mid-line after an in-place GPS log
// overwrite (see handlePvt's inPlaceMode) - any *other* log call landing
// while that's true would otherwise get silently tacked onto the end of
// that same line instead of starting its own, since nothing else in this
// process knows the cursor isn't at column 0. Wrapping console.log/warn/
// error here (rather than auditing every call site across this file and
// every module it pulls in - radioLink, uploadClient, roverStats, ...) is
// the only way to catch all of them, including ones added later. warn/
// error are included too, not just log - stdout and stderr both render to
// the same physical terminal, so either can land on that dirty line. Same
// choke point also feeds logBuffer (see its own comment) - every line this
// process ever logs passes through here exactly once, so it's the one
// place that can capture them all for the rover dashboard's "Console" page
// without auditing every call site a second time.
let gpsLineDirty = false;
for (const method of ['log', 'warn', 'error']) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    if (gpsLineDirty) {
      process.stdout.write('\n');
      gpsLineDirty = false;
    }
    original(...args);
    logBuffer.push(util.format(...args));
  };
}

// Short labels for the rover admin dashboard (see getRoverStats below).
const gpsMode = config.noGps ? 'none' : config.simulateGps ? 'simulated' : 'real';
const radioMode = config.simulate ? 'simulated' : config.radio.enabled ? 'real' : 'none';
// True whenever a radio link is actually expected to come up at all (real
// or simulated) - RADIO_ENABLED=0 is the only case this is false. Reused
// by transmitFix (below) and the status summary (further down) so "is the
// radio genuinely down" and "there's deliberately no radio" never drift
// out of sync between the two.
const radioExpected = config.simulate || config.radio.enabled;

// This boat's own admin dashboard port. In SIMULATE mode, defaults to a
// different port than the base's own dashboard (config.admin.port, 8092)
// so `npm run base` and `npm run boat` can run on the same machine without
// an EADDRINUSE - a real deployment always has these on separate machines,
// so config.admin.port's default is fine as-is there. An explicit
// ADMIN_PORT env var always wins, on either side.
const myAdminPort = process.env.ADMIN_PORT ? config.admin.port : config.simulate ? 8093 : config.admin.port;

// One consolidated startup summary of the settings that actually matter
// for "is this boat configured the way I expect," printed together right
// up front - instead of scattered one-line-each prints interleaved with
// unrelated setup code further down this file, which made them easy to
// miss and hard to compare against each other at a glance.
console.log(`[boatAgent] boatId=${config.boatId}`);
console.log(
  `[boatAgent] gps=${gpsMode}` +
    (gpsMode === 'real'
      ? ` ${config.gps.port}@${config.gps.baud}`
      : gpsMode === 'simulated'
      ? config.simulate
        ? ' (no GPS hardware)'
        : ' (real radio hardware)'
      : ' (NO_GPS=1)')
);
console.log(
  `[boatAgent] radio=${radioMode}` +
    (radioMode === 'real'
      ? ` ${config.radio.port}@${config.radio.baud}`
      : radioMode === 'simulated'
      ? ` udp:${config.sim.port}`
      : ' (RADIO_ENABLED=0, fixes still log to SD)') +
    ` txDistance=${config.txDistanceM}m txInterval=${config.txIntervalMs / 1000}s`
);
console.log(
  `[boatAgent] dashboard=http://localhost:${myAdminPort} ` +
    `localBroadcast=${config.localBroadcast.format.toUpperCase()}:${config.localBroadcast.address}:${config.localBroadcast.port} ` +
    `upload=${config.upload.enabled ? 'on' : 'off'}`
);

// config.boatLogDir (default boat-logs/, see config.js's own comment) - a
// completely separate directory from the base's own BASE_LOG_DIR (base-logs/),
// not a subdirectory of it, so the two never end up sharing a directory
// even when both roles happen to run from the same checkout on the same
// machine. Every other boatLogDir consumer below (pruneForDiskSpace,
// startUploadClient, countPending, getDiskSpace) has to agree on this same
// directory, or they'd end up scanning/uploading from the wrong place
// entirely.
const sdLogger = new SdLogger({
  logDir: config.boatLogDir,
  boatId: config.boatId,
  retentionDays: config.logRetentionDays,
  chunkMinutes: config.logChunkMinutes,
});

// Emergency last resort if LOG_RETENTION_DAYS's normal age-based pruning
// (above, run by SdLogger itself on every chunk rollover) still isn't
// enough to keep this boat's SD card from filling up - see
// logRotation.js's own comment on pruneForDiskSpace. On its own timer
// rather than only checked at chunk rollover, since a chunk boundary is up
// to LOG_CHUNK_MINUTES away and a genuinely full disk needs a much
// tighter check than that.
setInterval(
  () => pruneForDiskSpace(config.boatLogDir, /^boat[A-Za-z0-9]+_.*\.csv$/, CRITICAL_BELOW_PCT),
  60000
);

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

let radio;
// Tracked for the periodic status summary (further down) - starts false
// rather than assuming connected, so a boat that never reaches 'connected'
// at all (still trying, or genuinely broken) reports "down" instead of a
// misleadingly optimistic default. Stays permanently false under
// RADIO_ENABLED=0, which never emits 'connected' at all - fine, since
// radioExpected (above) is what the status summary actually checks first.
let radioConnected = false;
if (config.simulate) {
  const { SimRadioLink } = require('./simRadioLink');
  radio = new SimRadioLink({
    port: config.sim.port,
    packetLossPct: config.sim.packetLossPct,
  });
  radio.on('error', (err) => console.error('[radio] error:', err.message));
  radio.on('connected', () => { radioConnected = true; startHelloAnnounce(); });
  radio.on('disconnected', () => { radioConnected = false; console.warn('[radio] disconnected, retrying...'); });
} else if (config.radio.enabled) {
  radio = new RadioLink({ port: config.radio.port, baud: config.radio.baud });
  radio.on('error', (err) => console.error('[radio] error:', err.message));
  radio.on('connected', () => { radioConnected = true; startHelloAnnounce(); });
  radio.on('disconnected', () => { radioConnected = false; console.warn('[radio] disconnected, retrying...'); });
} else {
  radio = new EventEmitter(); // RADIO_ENABLED=0 - never emits 'frame'/'marks', other outputs still testable
  radio.send = () => false;
}

// Course marks (windward/leeward/pin/committeeStart/committeeFinish/finish),
// as last broadcast by
// the base station - a real rover has no Redis access of its own (see
// baseStation.js's mark-broadcast comment), so this is the only way it ever
// learns the course. Kept in memory for anything on the boat that wants it
// this run, and persisted to disk so a reboot/restart still has a last-known
// course immediately, without waiting for the next broadcast.
const marksFilePath = path.join(config.configDir, 'course_marks.json');
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
  // baseStation.js re-broadcasts marks periodically (MARKS_BROADCAST_INTERVAL_MS,
  // 60s default) for the whole time this boat's connected, not just once -
  // logging every re-broadcast would spam the console for the entire race.
  // freshMarksReceived already tracks "has this run heard marks yet" for
  // an unrelated reason (gating SIMULATE_GPS's own start below); reusing it
  // here means the log line fires on exactly the same "first time" event,
  // not a separately-tracked one that could drift out of sync with it.
  const isFirstMarks = !freshMarksReceived;
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
  if (isFirstMarks) {
    console.log(
      '[boatAgent] received course marks from base station' +
        (baseAddress ? `, upload ${baseAddress.ip}:${baseAddress.port}` : '')
    );
  }
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
// pin<->committeeStart, not a mark itself: this frame gets recorded and
// shown on the map exactly like a real fix (see baseStation.js's radio.on
// ('frame', ...)), so landing it on, say, leewardGreen would show the
// boat starting AT a course mark it was never actually near. The midpoint
// is guaranteed to read as on-grid (see onGridWatcher.js) regardless of
// which slot this boat ends up drawing once it actually starts.
function sendMarksPing() {
  const pos = currentMarks
    ? {
        lat: (currentMarks.pin.lat + currentMarks.committeeStart.lat) / 2,
        lon: (currentMarks.pin.lon + currentMarks.committeeStart.lon) / 2,
      }
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
// reproduce. The RADIO_ENABLED=0 stub never emits 'connected', so this is simply
// a no-op there (nothing to ping over anyway). Left as a persistent
// listener, not `.once()`, so a boat that reconnects after a radio dropout
// (re-)starts retrying too, rather than only ever getting the marks-ping
// benefit on its very first connection.
if (config.simulateGps) radio.on('connected', startMarksPingRetry);

radio.on('sync-error', () => roverStats.recordSyncError());

// Pushes completed chunked SD-card logs to the base whenever it's actually
// reachable over WiFi (see uploadClient.js) - independent of GPS
// source/simulate mode, since this is really about the boat's own
// microSD-backed log files, not position data. Always started, even with
// UPLOAD_ENABLED=0 - its periodic health-check ping is the only way the
// base ever learns this boat's IP/admin port (see adminServer.js's
// dashboard link), so a boat with file uploads turned off shouldn't also
// disappear from the base's own dashboard. UPLOAD_ENABLED only gates the
// actual file transfer inside uploadClient.js's own tick().
startUploadClient({
  logDir: config.boatLogDir,
  boatId: config.boatId,
  chunkMinutes: config.logChunkMinutes,
  getBaseAddress: () => baseAddress,
  checkIntervalMs: config.upload.checkIntervalMs,
  timeoutMs: config.upload.timeoutMs,
  adminPort: myAdminPort,
  uploadEnabled: config.upload.enabled,
  logSuccess: config.upload.logSuccess,
});

let lastTxPosition = null; // {lat, lon} of the last fix actually transmitted
let lastTxTime = null; // pvt.timestamp of the last fix actually transmitted
// Fixes accumulated for the next batch send - see queueFixForTx/
// flushPendingBatch below. Always empty when config.txBatchSize is 1 (the
// default) - that path never touches this at all, see handlePvt.
let pendingBatch = [];
let lastPvt = null;
// True once a dwelling/holding fix (pvt.stationary - see simGps.js's
// _emitStationaryFix) has already been logged to the console once, so
// handlePvt's own logging block below (see suppressRepeatStationary) knows
// every following one until movement resumes is a pure repeat, not new
// information.
let stationaryLineLogged = false;

// A receiver with no satellite lock yet (no antenna, freshly powered on,
// antenna damage) reports gnssFixOk=false, but lat/lon aren't necessarily
// undefined in that state - a real rig was once seen sending an exact
// (0,0) "null island" fix this way. Transmitting that over radio would put
// it on the base's map and, via redisStore.recordFix, on RegattaUp's live
// map too - checked before every send below rather than trusting fixType
// alone, since (0,0) specifically should never be a legitimate reading for
// this boat regardless of what fixType claims.
function hasValidFix(pvt) {
  return pvt.gnssFixOk && !(pvt.lat === 0 && pvt.lon === 0);
}

// Rate-limits the "no valid fix, not transmitting" warning below - without
// this, a boat with a genuinely dead/disconnected antenna would log one of
// these per GPS fix (up to GPS_HZ), since clearedTxGate never actually
// clears (lastTxPosition never advances - see transmitFix). Same pattern as
// baseStation.js's own NO_REGATTA_WARN_INTERVAL_MS.
const INVALID_FIX_WARN_INTERVAL_MS = 30000;
let lastInvalidFixWarnAt = 0;

function handlePvt(pvt) {
  lastPvt = pvt;
  roverStats.recordFix(pvt);
  outputLocalFrame(pvt);

  // Primarily distance-based: send whenever the boat has actually moved
  // TX_DISTANCE_M since the last transmitted fix, regardless of how long
  // that took - a stopped or barely-drifting boat doesn't need to keep
  // re-transmitting the same position on a timer, and a fast-moving one
  // gets updates as often as its own movement actually warrants. The SD
  // log follows the exact same gate rather than logging every fix - the SD
  // record is meant to mirror what actually went out over the radio, not a
  // separate full-rate trace, so a fix that wouldn't have been worth
  // transmitting isn't worth logging either.
  //
  // TX_INTERVAL_MS is the heartbeat fallback: a boat that's stayed inside
  // TX_DISTANCE_M this whole time (sitting at a mooring, holding on the
  // grid) still reports at least this often, so it doesn't go completely
  // silent on the base's dashboard for as long as it stays still. Elapsed
  // time is measured from the last fix actually transmitted, same as
  // movedM above - a distance-triggered send resets this timer too (see
  // transmitFix), so it's genuinely "at least every N seconds," not a
  // separate clock ticking on top of already-frequent distance-based sends.
  const movedM = lastTxPosition ? distanceMeters(lastTxPosition, pvt) : Infinity;
  const elapsedSinceTxMs = lastTxTime !== null ? pvt.timestamp - lastTxTime : Infinity;
  const clearedTxGate =
    movedM >= config.txDistanceM || (config.txIntervalMs > 0 && elapsedSinceTxMs >= config.txIntervalMs);

  // Every fix gets a console line, same as the base's own GPS logging
  // (openBaseGps in baseStation.js) - the console is a live "is this thing
  // still getting fixes" view, independent of the SD log/radio TX below,
  // which stay gated on TX_DISTANCE_M since that's about what's actually
  // worth transmitting/recording, not what's worth watching.
  if (config.gps.logConsole) {
    // In-place overwriting only ever applies when stdout is a real
    // interactive terminal - piped to a file or captured by
    // systemd/journald, `\x1b[2K\r` would just write raw control characters
    // into the log instead of behaving like an overwrite, so that case
    // always falls through to a plain console.log below. GPS_LOG_REPLACE=0
    // opts out of it entirely (always scroll instead) - same guard as
    // baseStation.js's openBaseGps.
    const inPlaceMode = config.gps.logReplace && process.stdout.isTTY;

    // A dwelling/holding boat (SIM_HOLD_FOR_START, SIM_PRESTART_DWELL_S,
    // SIM_START_ONLY) emits the exact same fix every tick - inPlaceMode
    // already handles that fine for a standalone boat's own real terminal
    // (overwrites in place, never scrolls), but a fleet child piped through
    // fleetSim.js never qualifies for that, so without this it scrolls a
    // full line per fix at the full SIM_GPS_HZ rate for every boat, purely
    // repeating information nothing about which has changed - across a
    // several-boat fleet that floods the shared terminal fast enough to
    // bury anything else printed in the same window (like the
    // SIM_HOLD_FOR_START prompt) within a second or two. Logs the first
    // stationary fix (so it's still clear the boat reached the grid and is
    // holding), then stays silent until it's next NOT stationary - which
    // logs normally and makes the transition back to racing obvious on its
    // own, no separate "race started" message needed here.
    const suppressRepeatStationary = pvt.stationary && !inPlaceMode && stationaryLineLogged;
    stationaryLineLogged = !!pvt.stationary;

    if (!suppressRepeatStationary) {
      // Timestamp included mainly for the in-place overwrite mode below - a
      // stationary boat can otherwise repeat the exact same line forever,
      // which looks indistinguishable from a frozen/dead connection. The
      // clock visibly ticking is what proves it's still live.
      const time = new Date(pvt.timestamp).toISOString().slice(11, 23);
      const line =
        `[gps] ${time} ${pvt.lat.toFixed(6)},${pvt.lon.toFixed(6)} ` +
        `fixType=${pvt.fixType} diffSoln=${pvt.diffSoln} carrSoln=${pvt.carrSoln} numSV=${pvt.numSV} ` +
        `hAcc=${(pvt.hAccMm / 1000).toFixed(2)}m`;
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
  }

  if (clearedTxGate) {
    if (hasValidFix(pvt)) {
      if (config.txBatchSize > 1) {
        queueFixForTx(pvt);
      } else {
        transmitFix(pvt);
      }
    } else {
      const now = Date.now();
      if (now - lastInvalidFixWarnAt > INVALID_FIX_WARN_INTERVAL_MS) {
        console.warn(`[gps] no valid fix (gnssFixOk=${pvt.gnssFixOk} lat=${pvt.lat} lon=${pvt.lon}) - not transmitting`);
        lastInvalidFixWarnAt = now;
      }
    }
  }
}

// Actually sends a fix over the radio (real or simulated) and logs it to
// SD - the second half of handlePvt's own clearedTxGate branch, pulled out
// so the ping handler below (which transmits the current fix on request,
// deliberately bypassing the movement gate - see its own comment) can reuse
// the exact same send/log/stats path rather than duplicating it.
// lastTxPosition/lastTxTime only advance when radio.send() actually reports
// success, OR there's deliberately no radio at all (RADIO_ENABLED=0 - see
// below) - NOT unconditionally on every call, so a frame dropped because a
// real radio hadn't finished connecting YET (a genuine startup race: an
// already-converged RTK fix can arrive within milliseconds of GPS port
// open, comfortably beating a USB radio's own connect time) doesn't get
// treated as "reported." Leaving both null in that specific case means
// handlePvt's own clearedTxGate stays true (movedM stays Infinity) on the
// very next fix too, so it keeps retrying every fix until one genuinely
// gets out, rather than a stationary boat silently never transmitting
// again because its one guaranteed always-send attempt was spent on a
// frame that never left. RADIO_ENABLED=0 is different: send() there is a
// permanent `() => false` by design (see radio init above), not a
// transient failure - advancing both regardless keeps that mode's SD
// logging properly TX_DISTANCE_M/TX_INTERVAL_MS-gated instead of retrying
// (and therefore logging) every single fix forever.
function transmitFix(pvt) {
  sdLogger.logPvt(pvt);
  const frame = protocol.encode(config.boatId, pvt);
  const sent = radio.send(frame);
  if (sent || !radioExpected) {
    lastTxPosition = { lat: pvt.lat, lon: pvt.lon };
    lastTxTime = pvt.timestamp;
  }
  if (sent) {
    roverStats.recordFrameSent();
  } else if (radioExpected) {
    console.warn('[radio] not connected, dropped a frame (still logged to SD)');
  }
}

// Only reachable when config.txBatchSize > 1 (see handlePvt) - logs pvt to
// SD immediately, same timing as transmitFix above (SD mirrors "cleared the
// gate," not "actually went out over radio" - see the README's own note on
// this), then adds it to the pending batch instead of sending it alone.
// Flushes once the batch reaches txBatchSize fixes, OR once the oldest
// pending fix has been waiting txIntervalMs - the latter is what keeps
// TX_INTERVAL_MS's own "never silent longer than this" guarantee intact
// even while a batch is still filling up on a slow-moving boat, instead of
// letting a partial batch sit indefinitely.
function queueFixForTx(pvt) {
  sdLogger.logPvt(pvt);
  pendingBatch.push(pvt);

  const batchFull = pendingBatch.length >= config.txBatchSize;
  // txIntervalMs === 0 means "heartbeat disabled" (same convention as
  // handlePvt's own clearedTxGate above) - without this guard, a fresh
  // batch's very first fix would read as instantly stale (0 >= 0) and flush
  // right away every time, silently defeating batching whenever an operator
  // has turned the heartbeat off.
  const batchStale = config.txIntervalMs > 0 && pvt.timestamp - pendingBatch[0].timestamp >= config.txIntervalMs;
  if (batchFull || batchStale) {
    flushPendingBatch();
  }
}

// Sends whatever's pending as one batch frame (or, for the common case of a
// single straggling fix once txIntervalMs forces an early flush, the exact
// same plain single-fix frame transmitFix would have sent) - same
// success/failure handling as transmitFix above, just applied once to the
// whole batch: lastTxPosition/lastTxTime advance to the LAST fix in the
// batch only if the send actually succeeded (or no radio is expected at
// all), so a failed send keeps retrying on the next fix exactly like a
// single dropped frame would. Always clears pendingBatch regardless of
// success - like a dropped single frame, an undelivered batch's fixes are
// already durably on SD (logged above as each one was queued); this app
// doesn't buffer-and-retry radio sends, on principle, for either case.
function flushPendingBatch() {
  const fixes = pendingBatch;
  pendingBatch = [];
  if (fixes.length === 0) return;

  const frame = fixes.length === 1 ? protocol.encode(config.boatId, fixes[0]) : protocol.encodeBatch(config.boatId, fixes);
  const sent = radio.send(frame);

  const last = fixes[fixes.length - 1];
  if (sent || !radioExpected) {
    lastTxPosition = { lat: last.lat, lon: last.lon };
    lastTxTime = last.timestamp;
  }
  if (sent) {
    roverStats.recordFrameSent();
  } else if (radioExpected) {
    const what = fixes.length === 1 ? 'a frame' : `a batch of ${fixes.length} frames`;
    console.warn(`[radio] not connected, dropped ${what} (still logged to SD)`);
  }
}

// Announces this boat's presence the moment the radio connects, well
// before a first GPS fix necessarily exists - a cold GPS start can take
// minutes, and without this the base has no way to know this boat's radio
// is even alive until that first real fix goes out (see protocol.js's own
// comment on encodeHello for the full reasoning, and baseStation.js's
// radio.on('hello', ...) for what the base does with it - just a live
// dashboard "last seen," never written to CSV/Redis/RegattaUp the way a
// real fix is). Sent immediately, then retried every HELLO_RETRY_MS in
// case the base wasn't listening yet or the frame was lost - stops on its
// own the moment a real fix actually transmits (lastTxTime goes non-null,
// see transmitFix above), since the base then has much better information
// than a bare hello and there's nothing left for this to usefully add.
const HELLO_RETRY_MS = 5000;
let helloIntervalId = null;
let helloStartupTimeoutId = null;

function sendHello() {
  if (lastTxTime !== null) {
    clearInterval(helloIntervalId);
    helloIntervalId = null;
    return;
  }
  const sent = radio.send(protocol.encodeHello(config.boatId));
  if (!sent && radioExpected) console.warn('[radio] not connected, dropped a hello frame (will keep retrying)');
}

function startHelloAnnounce() {
  // A real radio reconnecting mid-run (see radio.on('disconnected', ...)
  // above) fires 'connected' again - clear any interval/pending startup
  // delay from the previous connection first, so a reconnect before the
  // first real fix doesn't leave two intervals (or two pending jittered
  // starts) both calling sendHello.
  if (helloIntervalId !== null) clearInterval(helloIntervalId);
  if (helloStartupTimeoutId !== null) clearTimeout(helloStartupTimeoutId);

  // Random delay before the first send (see config.js's own comment on
  // helloStartupJitterMs) - the retry interval below only starts counting
  // once this fires, so it inherits the same random offset rather than
  // snapping back to a fleet-wide fixed beat after just one jittered send.
  const delayMs = Math.random() * config.helloStartupJitterMs;
  helloStartupTimeoutId = setTimeout(() => {
    helloStartupTimeoutId = null;
    sendHello();
    if (lastTxTime === null) helloIntervalId = setInterval(sendHello, HELLO_RETRY_MS);
  }, delayMs);
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
  if (!lastPvt || !hasValidFix(lastPvt)) return; // no fix yet, or not a valid one - nothing to report
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

// The live SimGpsSource, once created (see startGpsSimIfReady below) - kept
// so releaseHold() (SIM_HOLD_FOR_START's spacebar/IPC handler, set up
// further down) has something to call release() on. Stays null the whole
// run under any other mode (real GPS, or SIMULATE_GPS before marks arrive).
let simGpsSource = null;

// True once the operator's "start the race" signal has actually arrived
// (see releaseHold below) - the signal can beat marks reception (a fast
// spacebar press right after this process starts), so this is checked
// again once simGpsSource actually exists, rather than assuming the signal
// only ever arrives after the boat is already on the grid.
let holdReleased = false;

// SIM_HOLD_FOR_START's actual release - called either from this process's
// own stdin (a standalone `npm run boat`, which owns the terminal directly)
// or from an IPC 'start-race' message forwarded by fleetSim.js (which owns
// the terminal instead, when this boat was spawned as part of a fleet -
// see fleetSim.js's own keypress handling). Idempotent, since either path
// could in principle fire more than once.
function releaseHold() {
  holdReleased = true;
  if (simGpsSource) simGpsSource.release();
}

if (config.simulateGps && config.sim.holdForStart) {
  console.log('[boatAgent] SIM_HOLD_FOR_START=1 - will hold at the start position once on the grid, waiting for the start signal');
  // Fleet child: process.send only exists when this process was spawned
  // with an 'ipc' stdio channel (see fleetSim.js), which is how the
  // operator's spacebar press in the fleet's own terminal reaches every
  // boat it spawned - none of them have their own TTY stdin to read
  // directly (fleetSim spawns them with stdin 'ignore').
  if (typeof process.send === 'function') {
    process.on('message', (msg) => {
      if (msg === 'start-race') releaseHold();
    });
  }
  // Standalone boat: this process owns the terminal itself, so it reads
  // the operator's spacebar directly instead of waiting on an IPC message
  // nothing would ever send.
  if (process.stdin.isTTY) {
    console.log('[boatAgent] press SPACE in this terminal to start the race');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    // The one-time message above is easy to miss once GPS fix lines start
    // scrolling (or, in-place-overwrite mode, aren't scrolling at all - see
    // handlePvt's gpsLineDirty) - repeats a louder reminder on a slow timer
    // until actually released, only once the boat has actually reached the
    // grid (gpsSimStarted), so it doesn't nag before there's anything to
    // start yet. Cleared the moment SPACE lands - see the 'data' handler
    // below and the SIGINT handler at the bottom of this file.
    const reminderIntervalId = setInterval(() => {
      if (gpsSimStarted && !holdReleased) {
        console.log('[boatAgent] *** on the grid - press SPACE to start the race ***');
      }
    }, 15000);
    process.stdin.on('data', (data) => {
      if (data.includes(0x03)) {
        // Ctrl+C - raw mode intercepts this before the terminal driver ever
        // turns it into a real SIGINT, so it's re-raised by hand here to
        // reach the ordinary SIGINT shutdown handler at the bottom of this
        // file (which also restores normal stdin mode - see there).
        clearInterval(reminderIntervalId);
        process.kill(process.pid, 'SIGINT');
        return;
      }
      if (data.includes(0x20) && !holdReleased) {
        console.log('[boatAgent] SPACE pressed - starting the race');
        clearInterval(reminderIntervalId);
        process.stdin.setRawMode(false);
        releaseHold();
      }
    });
  }
}

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

  // fleetSim.js sets SIM_START_SLOT/SIM_FLEET_SIZE when this boat is part of
  // a spawned fleet - even spacing (this boat's index out of the whole
  // fleet) so the line fills up predictably instead of clustering wherever
  // chance happens to land a batch of independent random draws (that's just
  // how randomness works over a small fleet, not a bug - see course.js's
  // own getStartFraction, which still owns confining this to the line's
  // safe pin-half zone regardless of which of these two picks the fraction).
  // Falls back to a random draw when running standalone (no fleet context -
  // a lone boat has nothing to space evenly against), varying each run
  // rather than the boat's own ID, which would put it at the exact same
  // spot every single time.
  const simFleetSize = Number(process.env.SIM_FLEET_SIZE);
  const simStartSlot = Number(process.env.SIM_START_SLOT);
  const startFrac =
    Number.isInteger(simFleetSize) && simFleetSize > 0 && Number.isInteger(simStartSlot)
      ? simStartSlot / simFleetSize
      : Math.random();

  console.log(
    `[boatAgent] starting simulated GPS, course marks: ${Object.keys(currentMarks).join(', ')}, ` +
      `racing ${raceMarks.windwardName}/${raceMarks.leewardName} (SIM_COURSE_MARKS=${config.sim.courseMarks}), start frac: ${startFrac.toFixed(3)}`
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
    startFrac,
    lapCount: config.sim.lapCount,
    geometry,
    startOnly: config.sim.startOnly,
    prestartDwellS: config.sim.prestartDwellS,
    holdForStart: config.sim.holdForStart,
    foulTest: config.sim.foulTest,
    foulWindwardM: config.sim.foulWindwardM,
    // The start/finish line logic needs the REAL pin/committeeStart/
    // committeeFinish/finish positions, not just geometry's scalar
    // distances - see simGps.js's own comment on why (an edited windward
    // mark rotates the beat axis independently of wherever the
    // start/finish complex actually still is).
    pin: currentMarks.pin,
    committeeStart: currentMarks.committeeStart,
    committeeFinish: currentMarks.committeeFinish,
    finish: currentMarks.finish,
    // The operator's pin boundary gate checkbox (see course.js's own
    // comment on PIN_BOUNDARY_MARK) - false/undefined whenever it's off,
    // which SimGpsSource treats identically to "not set" either way.
    pinBoundaryEnabled: currentMarks.pinBoundaryEnabled,
  });
  simGpsSource = gps;
  // Listener attached (and the real starting position emitted through it -
  // see emitInitialFixIfDwelling's own comment on why this can't happen
  // inside the constructor itself) before the 'on-grid' IPC message below,
  // so fleetSim.js's fleet-wide "on-grid" count never runs ahead of this
  // boat's actual position having been transmitted at least once.
  gps.on('nav-pvt', handlePvt);
  gps.emitInitialFixIfDwelling();
  // The operator's start signal may have already arrived before this boat
  // even reached the grid (marks can take a moment - see freshMarksReceived
  // above) - releaseHold() only recorded that as holdReleased until there
  // was an actual SimGpsSource to call release() on, so catch up on it now.
  if (holdReleased) gps.release();
  if (config.sim.holdForStart && !holdReleased) {
    console.log('[boatAgent] on the grid, holding for the start signal');
    // Fleet child: lets fleetSim.js (the process actually watching for the
    // operator's spacebar - see its own 'message' handling) track how many
    // of the boats it spawned have actually reached the grid, so it can
    // prompt "press SPACE" once the whole fleet - not just this one boat -
    // is ready, instead of guessing from elapsed time.
    if (typeof process.send === 'function') process.send('on-grid');
  }
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

// SIM_TRUST_CACHED_MARKS=1 - set by fleetSim.js (never by a lone `npm run
// boat`) on every boat it spawns, after it has already fetched the
// CURRENT course from Redis itself and written it to this exact shared
// course_marks.json path (see fleetSim.js's own ensureFreshMarksCached -
// every boat in a fleet shares the same LOG_DIR, hence the same cache
// file). Unlike the standalone case below, there's no "may be stale" risk
// here to guard against: this boat only sees the flag because the
// controlling process just confirmed the file is current, not because of
// whatever happened to be left over from some earlier run - so it can
// skip the radio ping/retry wait entirely rather than have every boat in
// the fleet independently re-fetch the same answer over simulated radio.
const trustCachedMarks =
  (process.env.SIM_TRUST_CACHED_MARKS === '1' || process.env.SIM_TRUST_CACHED_MARKS === 'true') && !!currentMarks;

if (config.noGps) {
  // Radio (real or simulated), marks reception, and the upload client are
  // all still fully running above - this just skips ever starting a GPS
  // source, real or simulated, so no position fixes/frames are produced.
} else if (config.simulateGps && trustCachedMarks) {
  console.log('[boatAgent] SIM_TRUST_CACHED_MARKS=1 - using the course marks already on disk without waiting for a radio broadcast');
  freshMarksReceived = true;
  startGpsSimIfReady();
} else if (config.simulateGps) {
  console.log(
    '[boatAgent] SIMULATE_GPS - waiting for a fresh course marks broadcast from the base station before starting' +
      (currentMarks ? ' (ignoring the last-known copy cached on disk - it may be stale)' : '') +
      (radioMode === 'none' ? ' (RADIO_ENABLED=0 has no radio to receive one on, so this would wait forever)' : '')
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
    pendingCount: countPending(config.boatLogDir, config.boatId, config.logChunkMinutes),
    disk: getDiskSpace(config.boatLogDir),
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
        receivedAt: lastPvt.receivedAt,
        carrSoln: lastPvt.carrSoln,
        gnssFixOk: lastPvt.gnssFixOk,
        numSV: lastPvt.numSV,
        hAccMm: lastPvt.hAccMm,
      }
    : null;
}

// Armed only if config.power.shutdownAt ends up set (ROVER_SHUTDOWN_AT, or
// a schedule persisted from a previous rover dashboard edit - see config
// .js's own "Scheduled shutdown" comment) - otherwise this is just a live,
// currently-disabled controller the dashboard's power card can still arm
// on the fly. See powerSchedule.js for the full picture.
const powerScheduler = startShutdownScheduler({
  shutdownAt: config.power.shutdownAt,
  shutdownIdleMinutes: config.power.shutdownIdleMinutes,
  shutdownSpeedKn: config.power.shutdownSpeedKn,
  shutdownCheckIntervalMs: config.power.shutdownCheckIntervalMs,
  getLastFix: () => lastPvt,
});

startRoverAdminServer({
  port: myAdminPort,
  getStats: getRoverStats,
  getPosition,
  getPowerStatus: powerScheduler.getStatus,
  updatePowerSchedule: powerScheduler.updateParams,
});

// Compact fix-quality label - RTK carrier solution takes priority over the
// plain fixType, since "RTK-fixed" is a much stronger statement than the
// "3D" fixType alone would suggest (carrSoln is layered on top of a fix,
// not an alternative to one). Matches this app's own u-blox field names
// directly rather than inventing new terminology.
const FIX_TYPE_LABELS = { 0: 'no-fix', 1: 'dead-reckoning', 2: '2D', 3: '3D', 4: 'GNSS+DR', 5: 'time-only' };
function fixLabel(pvt) {
  if (!pvt) return 'none';
  if (pvt.carrSoln === 2) return 'RTK-fixed';
  if (pvt.carrSoln === 1) return 'RTK-float';
  return FIX_TYPE_LABELS[pvt.fixType] ?? `type${pvt.fixType}`;
}

// "Xs"/"Xm" ago, or "never" - used for every timestamp in the status
// summary below so a stale value (radio gone quiet, marks not refreshed
// in a while) is immediately obvious without doing timestamp math by eye.
function ageStr(ts) {
  if (ts == null) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

// One-line status summary - deliberately the ONE thing this process prints
// on a timer regardless of what GPS_LOG/etc. are set to, so there's always
// SOME live signal on an otherwise-quiet console without needing to enable
// any per-fix logging. Covers what an operator glancing at this terminal
// actually wants to know: is GPS locked and how good, where is the boat
// and how fresh is that, do we have a current course, and is the radio
// actually getting frames out - all the individually-toggleable logs
// elsewhere in this file are for digging into ONE of these in detail once
// this line says something's off, not for routine watching.
function radioLabel() {
  return !radioExpected ? 'disabled' : radioConnected ? 'ok' : 'down';
}

function logStatusSummary() {
  const pvt = lastPvt;
  // roverStats already tracks lastMarksReceivedAt/upload.lastUploadAt for
  // the dashboard (recordMarksReceived()/recordUploadSuccess() are called
  // from the 'marks' handler above and uploadClient.js respectively) -
  // reused here instead of second, separately-tracked copies of the same
  // timestamps that could drift out of sync with them.
  const snap = roverStats.snapshot();
  console.log(
    `[status] gps=${fixLabel(pvt)} acc=${pvt ? (pvt.hAccMm / 1000).toFixed(2) + 'm' : '-'} ` +
      `sv=${pvt ? pvt.numSV : 0} pos=${pvt ? `${pvt.lat.toFixed(6)},${pvt.lon.toFixed(6)}` : 'none'} ` +
      `fixAge=${ageStr(pvt?.timestamp)} marks=${ageStr(snap.marks.lastReceivedAt)} ` +
      `radio=${radioLabel()} txAge=${ageStr(lastTxTime)} uploadAge=${ageStr(snap.upload.lastUploadAt)}`
  );
}

// The DISCRETE part of the status worth reacting to immediately, as
// opposed to the 60s heartbeat below: GPS fix quality and radio
// connectivity are real state transitions (RTK lock gained/lost, radio up/
// down), and "never had one" -> "have one now" for a fix/marks/TX is a
// genuine one-time milestone. Deliberately excludes the continuously-
// varying fields (position, accuracy, satellite count, every *Age) - those
// change on essentially every fix while under way, and reacting to THEM
// immediately would just reproduce the exact per-fix log spam this status
// line was built to replace.
function statusKey() {
  const pvt = lastPvt;
  const snap = roverStats.snapshot();
  return JSON.stringify([
    fixLabel(pvt),
    radioLabel(),
    pvt != null,
    snap.marks.lastReceivedAt != null,
    lastTxTime != null,
    snap.upload.lastUploadAt != null,
  ]);
}

let lastLoggedStatusKey = null;
let lastStatusLogAt = 0;
function maybeLogStatusSummary() {
  const key = statusKey();
  const now = Date.now();
  if (key !== lastLoggedStatusKey || now - lastStatusLogAt >= 60000) {
    logStatusSummary();
    lastLoggedStatusKey = key;
    lastStatusLogAt = now;
  }
}
// Checked every 2s rather than hooked into every individual mutation site
// (handlePvt, radio connect/disconnect, the marks handler, transmitFix) -
// far simpler than scattering "maybe log now" calls across all of them,
// at the cost of up to ~2s detection latency for a change, which is
// irrelevant here (arguably even desirable - it won't fire on a one-fix
// transient blip).
setInterval(maybeLogStatusSummary, 2000);
maybeLogStatusSummary(); // once immediately, not just after the first check

// Simple heartbeat so you can tell the process is alive even with no fix yet.
// Under fleetSim.js, report through IPC instead of logging directly - a
// whole fleet (20-30 boats routinely) all starting at once otherwise means
// every boat's own copy of this exact message scrolls by independently
// every 10s, drowning out anything useful. fleetSim.js aggregates these into
// one combined line (see its own 'waiting-for-fix' handler). Standalone (no
// parent to aggregate for it) still logs directly, same as always.
setInterval(() => {
  if (lastPvt) return;
  if (typeof process.send === 'function') process.send('waiting-for-fix');
  else console.log('[boatAgent] waiting for first GPS fix...');
}, 10000);

// Handles SIGTERM the same as SIGINT (Ctrl+C), not just SIGINT alone -
// fleetSim.js sends this process SIGINT when stopping the fleet (see its
// own shutdown()), but this boat could also be killed directly - `kill
// <pid>` with no signal named, or a process manager's "stop" - which
// defaults to SIGTERM, not SIGINT. Without a handler for it, Node's default
// action for SIGTERM is an immediate exit that skips this same cleanup.
function shutdown() {
  // Only ever set true above (SIM_HOLD_FOR_START's own TTY handler) -
  // restores the terminal to normal input mode before exiting, so the
  // shell isn't left swallowing keystrokes raw after this process is gone.
  if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
  console.log('\n[boatAgent] shutting down');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
