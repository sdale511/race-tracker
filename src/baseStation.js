require('./logTimestamps');
const config = require('./config');
const protocol = require('./protocol');
const { RadioLink } = require('./radioLink');
const { RedisStore } = require('./redisStore');
const { persistRegattaId, clearPersistedRegattaId } = require('./regattaIdFile');
const {
  distanceMeters,
  COURSE_LENGTH_M,
  START_LINE_POSITION,
  COMMITTEE_GAP_M,
  MARK_NAMES,
  PIN_BOUNDARY_MARK,
  getPinBoundaryFarPoint,
  resolveCourseCenter,
} = require('./course');
const { FinishLineWatcher } = require('./finishLineWatcher');
const { LapWebhookQueue } = require('./lapWebhookQueue');
const { OnGridWatcher, zonePolygon } = require('./onGridWatcher');
const { OnGridWebhookQueue } = require('./onGridWebhookQueue');
const { MarkRoundingWatcher } = require('./markRoundingWatcher');
const { MarkRoundingWebhookQueue } = require('./markRoundingWebhookQueue');
const { FoulWatcher } = require('./foulWatcher');
const { FoulWebhookQueue } = require('./foulWebhookQueue');
const { pruneOldLogs, pruneForDiskSpace } = require('./logRotation');
const { startUploadServer, detectLocalIp, scanUploadDir } = require('./uploadServer');
const { startAdminServer } = require('./adminServer');
const stats = require('./stats');
const { getDiskSpace, CRITICAL_BELOW_PCT } = require('./diskSpace');
const { SerialPort } = require('serialport');
const {
  UbxParser,
  encodePollRequest,
  encodeSetTmode3,
  encodeSaveConfig,
  encodeNavPvt,
  TMODE3_MODE_NAMES,
  CLASS_CFG,
  ID_CFG_TMODE3,
} = require('./ubxParser');
const { toGGA } = require('./nmea');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const util = require('util');
const logBuffer = require('./logBuffer');

// True while the cursor is sitting mid-line after an in-place base-GPS log
// overwrite (see openBaseGps's nav-pvt handler below) - any *other* log
// call landing while that's true would otherwise get silently tacked onto
// the end of that same line instead of starting its own, since nothing
// else in this process knows the cursor isn't at column 0. Wrapping
// console.log/warn/error here (rather than auditing every call site across
// this file and every module it pulls in) is the only way to catch all of
// them, including ones added later. Same mechanism as boatAgent.js's own
// gpsLineDirty - kept as a separate copy, not a shared import, since each
// file's console output is its own process/terminal, nothing to share.
// Same choke point also feeds logBuffer (see its own comment) - every line
// this process ever logs passes through here exactly once, so it's the
// one place that can capture them all for the admin dashboard's "Console"
// page without auditing every call site a second time.
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

// Color-codes the two flavors of RegattaUp webhook problem, so they stand
// out from the plain console noise around them at a glance: red for a
// webhook queue that failed to even initialize (nothing for that event type
// will ever be sent until this is fixed), orange for a single send attempt
// that failed but is already queued to retry on its own (self-healing, not
// something that needs immediate attention the way red does). Only applied
// when stderr is a real terminal - same isTTY gating as gpsLineDirty above,
// so a piped/redirected log (systemd, a file) never gets raw escape codes
// embedded in it instead of an actual color.
function red(text, stream = process.stderr) {
  return stream.isTTY ? `\x1b[31m${text}\x1b[0m` : text;
}
function orange(text, stream = process.stderr) {
  return stream.isTTY ? `\x1b[38;5;208m${text}\x1b[0m` : text;
}

// Base station: sits at the committee boat/shore with the matching radio.
// Decodes incoming frames and fans them out to whatever your race tracking
// software needs. You haven't picked that software yet, so this ships with
// four generic adapters you can mix/match/replace once you know the target:
//
//   1. console/JSON  - always on, good for debugging
//   2. CSV file       - one row per fix, per boat
//   3. Redis          - queryable per-boat or fleet-wide tracks, see redisStore.js
//   4. UDP broadcast  - re-broadcasts each fix locally as UBX-NAV-PVT
//                       (default) or NMEA GGA (see config.js's
//                       localBroadcast.format); swap outputFrame() below
//                       for whatever your chosen software's actual
//                       ingestion format is (HTTP POST to a cloud API,
//                       TCP NMEA stream, etc).
//
// Lap detection also lives here (see finishLineWatcher.js), not on the
// boat: a real rover has no Redis access to resolve course marks itself, so
// it only ever sends its raw position - this is the one place that already
// has both the marks and every boat's fixes, so it's the only place that
// can watch for a finish-line crossing.

// One MarkRoundingWatcher per boat per entry (see markRoundingWatcher.js -
// it only needs the mark itself now, no axis/other-mark direction).
//
// `outerMark`, where present, is the mark that sits further out on the
// same windward/leeward axis, beyond `mark` - windwardBlack beyond
// windwardGreen, leewardBlack beyond leewardGreen (see course.js's own
// comment: green is always the inner, short-course pair). Only the inner
// (green) marks have one; windwardBlack/leewardBlack are the outermost
// marks on the course, nothing sits beyond them to worry about reaching.
// Used below to cap the green mark's rounding radius short of the black
// mark's own position - see markRoundingWatchersFor's
// OUTER_MARK_SAFETY_FRACTION comment for why that cap has to hold
// regardless of how markRoundingExtensionM is configured.
const MARK_ROUNDING_GATES = [
  { mark: 'windwardGreen', outerMark: 'windwardBlack' },
  { mark: 'windwardBlack' },
  { mark: 'leewardGreen', outerMark: 'leewardBlack' },
  { mark: 'leewardBlack' },
];

// However markRoundingExtensionM is configured, an inner (green) mark's
// gate must never reach anywhere near the corresponding outer (black)
// mark - otherwise a boat rounding the black mark could get misattributed
// as rounding the green one. Capped at half the green<->black distance,
// not the full distance: half leaves a solid buffer on both sides (the
// gate stops well short of black, and a boat actually at/rounding black
// stays well clear of the green gate's own far end) rather than cutting
// it exactly at the boundary, where real GPS noise or a slightly-off mark
// position could still let the two overlap.
const OUTER_MARK_SAFETY_FRACTION = 0.5;

// Mirrors main()'s own selectedRegatta.id (see selectRegatta/
// refreshActiveRegattas inside main()) - kept in sync purely so the
// sendQueued* functions below, which are plain top-level functions with no
// closure over main()'s locals, can tag their RegattaUp webhook posts with
// which regatta they're for (mylapsWebhook/entry.ts's own optional
// regatta_id fast path - see its comment on ACTIVE_REGATTAS_KEY). null
// whenever no regatta is selected, same as selectedRegatta itself.
let currentRegattaId = null;

if (config.testLapNumber > 0) {
  console.log(
    `[baseStation] TEST_LAP_NUMBER=${config.testLapNumber} - sending a single test lap for boat ${config.testLapBoatId} and exiting`
  );
  runTestLap();
} else {
  main();
}

// Sends exactly one synthetic lap straight into the webhook queue (no
// radio, no GPS, no finish-line detection involved) and exits, so the
// queue -> RegattaUp path can be checked in isolation.
async function runTestLap() {
  const queue = await LapWebhookQueue.create(config.regattaup.queueDbPath);
  const id = queue.enqueue({
    boatId: config.testLapBoatId,
    lap: config.testLapNumber,
    rtcTime: Date.now() * 1000, // ms -> microseconds
    strength: 0,
    receivedAt: new Date().toISOString(),
  });
  await sendQueuedLap(queue, queue.get(id));
  await queue.close();
  process.exit(0);
}

function main() {
  // Logged this early (well before startAdminServer actually starts the
  // server, much further down this function) so the one thing an operator
  // most wants right after launch - "where's the dashboard" - isn't
  // buried under everything else this function logs during radio/Redis/
  // upload-server setup.
  console.log(`[adminServer] dashboard at http://localhost:${config.admin.port}`);

  let radio;
  // Tracked alongside the radio object itself so the dashboard's "Radio
  // frames" card (see adminServer.js) can show which port/mode is actually
  // in play, not just the frame/error counters - useful for confirming
  // this process picked up the port you expected, especially with
  // SIMULATE=1 or RADIO_ENABLED=0 around to override the default.
  const radioMode = config.simulate ? 'simulated' : config.radio.enabled ? 'real' : 'none';
  if (config.simulate) {
    const { SimRadioLink } = require('./simRadioLink');
    radio = new SimRadioLink({ port: config.sim.port });
  } else if (config.radio.enabled) {
    // Deferred - a real radio's serial port opening (RadioLink's own
    // constructor, see radioLink.js) fails loudly and retries forever with
    // a console error every 3s the moment nothing answers, which is exactly
    // the kind of noise that buries "please pick a regatta" the instant
    // this process starts on a base that isn't racing yet. `radio` is a
    // plain stand-in until connectRealRadio() below actually opens the port
    // - every .on(...)/.send()/.broadcast() call site elsewhere in this
    // file targets this same object regardless, so nothing else needs to
    // change; connectRealRadio() just wires a real RadioLink's events/
    // methods through it once a regatta is actually selected (see
    // selectRegatta). SIMULATE mode is deliberately NOT deferred the same
    // way - simulated boats have nothing resembling this failure mode, and
    // this app already explicitly supports running SIMULATE=1 with no
    // regatta selected at all.
    radio = new EventEmitter();
    radio.send = () => false;
    radio.broadcast = () => false;
  } else {
    radio = new EventEmitter(); // RADIO_ENABLED=0 - never emits 'frame'/'marks', other outputs still testable
    radio.send = () => false;
    radio.broadcast = () => false;
  }
  radio.on('error', (err) => console.error('[radio] error:', err.message));
  radio.on('disconnected', () => console.warn('[radio] disconnected, retrying...'));

  // Opens the real radio's serial port for the first time - see the
  // radioMode 'real' comment above for why this is deferred rather than
  // happening in the constructor the way RadioLink normally works (and
  // still does for boatAgent.js/radioTest.js, which have no regatta concept
  // to wait on). Forwards every event RadioLink emits onto the placeholder
  // `radio` above instead of replacing it, so every listener already
  // attached to `radio` throughout this file (including ones registered
  // further down, like the frame handler) keeps working unmodified. No-op
  // outside radioMode 'real' (nothing to defer for 'simulated'/'none').
  // Called once, from selectRegatta, the moment a regatta is first
  // selected - see systemStarted's own comment below.
  function connectRealRadio() {
    if (radioMode !== 'real') return;
    const real = new RadioLink({ port: config.radio.port, baud: config.radio.baud });
    radio.send = (buf) => real.send(buf);
    radio.broadcast = (buf) => real.broadcast(buf);
    for (const evt of ['error', 'disconnected', 'connected', 'frame', 'sync-error']) {
      real.on(evt, (...args) => radio.emit(evt, ...args));
    }
  }

  // Surfaced on the dashboard (see adminServer.js's "Radio frames" card) so
  // a lost connection actually shows as lost, rather than the card just
  // quietly freezing on whatever counters it last had - the values
  // themselves staying put is fine (this is a live view, not something
  // that needs to guess "still true" vs "last known"), but there needs to
  // be SOME live signal distinguishing "still connected" from "was
  // connected." Only 'real' mode has an actual disconnect concept - a
  // SimRadioLink's UDP socket, once bound, doesn't have a serial-port-style
  // physical disconnect to track, and 'none' (RADIO_ENABLED=0) has no
  // connection to speak of at all, so `radioConnected` stays null there
  // (adminServer.js treats null as "not applicable," not "disconnected").
  let radioConnected = radioMode === 'simulated' ? true : radioMode === 'real' ? false : null;
  if (radioMode === 'real') {
    radio.on('connected', () => {
      radioConnected = true;
    });
    radio.on('disconnected', () => {
      radioConnected = false;
    });
  }

  // Optional GPS wired directly to this machine (see config.js's gps
  // comment - shared with the boat's own GPS_PORT/GPS_BAUD) - purely so
  // an operator can plant a mark at their own real current position from
  // the admin map's "edit marks" column, with real RTK precision rather
  // than a phone's much coarser Geolocation API. Gated on GPS_PORT being
  // *explicitly* set (not just "does config.gps.port have a value" -
  // that's always true, it has a default) - most base stations don't
  // have GPS hardware attached at all, and unlike the boat (which always
  // opens one, since it's assumed to always have real GPS hardware
  // unless told otherwise), a base silently retrying against a
  // nonexistent default port forever would just be noise.
  let baseGpsFix = null;
  // TMODE3 (Time Mode 3) is the ZED-F9P's config for how it establishes its
  // OWN fixed reference position before it's trustworthy as an RTK base
  // (disabled / survey-in / fixed-position) - separate from baseGpsFix
  // above, which is just the receiver's ordinary nav solution and keeps
  // updating regardless. Neither is pushed by the receiver on its own the
  // way NAV-PVT is: TMODE3 has to be polled (see encodePollRequest below),
  // and NAV-SVIN only streams while survey-in mode is actually configured
  // and enabled as an output message. Both null until we've heard something,
  // same "never throws, null means not available yet" contract as
  // getBaseGpsFix.
  let baseGpsTmode3 = null;
  let baseGpsSvin = null;
  // The currently-open port, if any - null whenever GPS_PORT isn't set, or
  // it's set but momentarily disconnected/reconnecting. Only needed for
  // sending a SET command on demand (see setBaseGpsSurveyIn/setBaseGpsFixed
  // below, triggered by the admin dashboard's mode buttons) - everything
  // else about this GPS (fixes, poll responses) flows the other direction,
  // through the parser's event handlers, and never needed a reference to
  // the port itself outside this block.
  let currentGpsPort = null;
  if (process.env.GPS_PORT) {
    console.log(`[baseStation] base GPS ${config.gps.port} @ ${config.gps.baud}`);
  }
  // Opens the base GPS's serial port - deferred, same reasoning and same
  // trigger (selectRegatta, via systemStarted below) as connectRealRadio
  // above: a real port that isn't actually wired up yet would otherwise
  // retry-and-log-an-error every 3s starting the instant this process
  // boots, well before an operator has had a chance to pick a regatta.
  // No-op when GPS_PORT isn't set at all (most base stations have no GPS
  // hardware attached - see the config comment this used to sit under).
  function openBaseGps() {
    if (!process.env.GPS_PORT) return;
    const gpsPort = new SerialPort({ path: config.gps.port, baudRate: config.gps.baud }, (err) => {
      if (err) {
        if (currentGpsPort === gpsPort) currentGpsPort = null;
        console.error('[baseGps] open failed:', err.message, '- retrying in 3s');
        setTimeout(openBaseGps, 3000);
      }
    });
    currentGpsPort = gpsPort;
    const parser = new UbxParser();
    gpsPort.on('data', (chunk) => parser.write(chunk));
    gpsPort.on('close', () => {
      if (currentGpsPort === gpsPort) currentGpsPort = null;
      clearInterval(tmode3PollTimer);
      console.warn('[baseGps] port closed, retrying in 3s');
      setTimeout(openBaseGps, 3000);
    });
    gpsPort.on('error', (err) => console.error('[baseGps] error:', err.message));
    parser.on('nav-pvt', (pvt) => {
      baseGpsFix = pvt;
      if (config.gps.logConsole) {
        // The base GPS is normally stationary (it's the fixed reference,
        // not something moving around a course), so unlike the boat's own
        // TX_DISTANCE_M-gated logging, there's no "did it move enough to
        // be worth its own line" distinction to fall back on here - every
        // fix would otherwise scroll a near-identical line at whatever
        // rate the receiver's configured for. Overwrite the same line
        // instead (same mechanism as boatAgent.js's own in-place GPS log -
        // see the gpsLineDirty wrapper above), and let any other log call
        // advance past it. Timestamp included so a genuinely frozen
        // connection is still visually distinguishable from a live one
        // that just hasn't moved - the clock keeps ticking either way.
        const time = new Date(pvt.timestamp).toISOString().slice(11, 23);
        // No diffSoln/carrSoln here (unlike boatAgent.js's own [gps] line)
        // - those describe whether *this* receiver is consuming
        // corrections, which is meaningless for a base: it's the source
        // of corrections, not a consumer, so those fields just sit at
        // false/0 regardless of whether the base is actually working.
        const line =
          `[baseGps] ${time} ${pvt.lat.toFixed(6)},${pvt.lon.toFixed(6)} ` +
          `fixType=${pvt.fixType} numSV=${pvt.numSV} hAcc=${(pvt.hAccMm / 1000).toFixed(2)}m`;
        // Same isTTY/logReplace guard as boatAgent.js - piped/redirected
        // output (a log file, systemd/journald) falls through to a plain
        // scrolling console.log, since the in-place escape codes would
        // just show up as raw control characters there.
        if (config.gps.logReplace && process.stdout.isTTY) {
          process.stdout.write(`\x1b[2K\r${line}`);
          gpsLineDirty = true;
        } else {
          console.log(line);
        }
      }
    });
    parser.on('cfg-tmode3', (t) => {
      baseGpsTmode3 = t;
    });
    parser.on('nav-svin', (s) => {
      baseGpsSvin = s;
    });
    // The receiver only tells us its TMODE3 mode when asked - poll once
    // right after opening (so the UI has something on the very first
    // load) and again periodically, since a poll request sent before the
    // receiver's serial buffer is ready, or one that's simply lost, would
    // otherwise leave the UI stuck showing nothing until a manual
    // restart. 15s is frequent enough to feel live without meaningfully
    // adding to the base GPS's own UART traffic.
    gpsPort.write(encodePollRequest(CLASS_CFG, ID_CFG_TMODE3));
    const tmode3PollTimer = setInterval(() => {
      gpsPort.write(encodePollRequest(CLASS_CFG, ID_CFG_TMODE3));
    }, 15000);
  }

  // Receives boat log uploads over WiFi whenever a boat happens to be in
  // range (see uploadServer.js/uploadClient.js) - its address is what gets
  // published in the marks broadcast below (broadcastMarksNow), so this
  // needs to be resolved before that's ever called.
  const baseIp = config.upload.baseIp || detectLocalIp();
  if (!baseIp) {
    console.warn('[baseStation] could not detect a LAN IP - log uploads from boats will be unavailable (set BASE_IP to override)');
  } else {
    console.log(`[baseStation] log upload address: ${baseIp}:${config.upload.port}`);
  }
  startUploadServer({ port: config.upload.port, uploadDir: config.upload.dir, logSuccess: config.upload.logSuccess });

  // Scanned once at startup (see scanUploadDir's own comment on why this
  // stays cheap regardless of how many files have piled up over a season)
  // so the admin dashboard can show a boat's real uploaded history even
  // before it's said anything this session - stats.js only knows about
  // this session's activity, not what happened in prior ones.
  const uploadDirBaseline = scanUploadDir(config.upload.dir);

  // Passive signal-quality feel, without interrupting the data stream to
  // query the radio for RSSI: a rising 'sync-error' rate (bytes that arrive
  // shaped like a frame but fail the checksum, usually mid-frame bit
  // errors) is a real, standard proxy for a degrading RF link, same idea as
  // frame-error-rate on WiFi/cellular when true signal strength isn't
  // available. Logged as a periodic summary rather than per-error, since a
  // few isolated failures are normal noise - the *rate* over time is what's
  // actually informative.
  let framesOk = 0;
  let syncErrors = 0;
  radio.on('frame', () => framesOk++);
  radio.on('sync-error', () => {
    syncErrors++;
    stats.recordSyncError();
  });
  setInterval(() => {
    const total = framesOk + syncErrors;
    if (total === 0) return; // nothing heard at all this interval - not a quality signal, just silence
    const errorPct = ((syncErrors / total) * 100).toFixed(1);
    console.log(`[radio] link quality: ${framesOk} ok, ${syncErrors} sync errors (${errorPct}%) in the last 30s`);
    framesOk = 0;
    syncErrors = 0;
  }, 30000);

  const logDir = config.logDir;
  fs.mkdirSync(logDir, { recursive: true });

  // Unlike the boat (a new file per session, see sdLogger.js), a base
  // station can run for days straight at a single regatta without
  // restarting - so this rotates to a new dated file itself whenever the
  // date changes, rather than growing one file forever. ensureCsvFile()
  // (called once at startup, then again from logToCsv on every write - a
  // cheap date-string check, only reopens/prunes on an actual date change)
  // is what makes that happen without a separate timer.
  const CSV_HEADER = 'received_iso,boat_id,fix_time_iso,lat,lon,speed_kn,heading_deg,fix_ok,carr_soln,num_sv\n';
  let csvPath = null;
  let csvDate = null;
  function ensureCsvFile() {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    if (today === csvDate) return csvPath;
    csvDate = today;
    csvPath = path.join(logDir, `base_station_received_${today}.csv`);
    if (!fs.existsSync(csvPath)) fs.writeFileSync(csvPath, CSV_HEADER);
    pruneOldLogs(logDir, /^base_station_received_.*\.csv$/, config.logRetentionDays);
    return csvPath;
  }
  ensureCsvFile();

  // Emergency last resort if LOG_RETENTION_DAYS's normal age-based pruning
  // above (only re-checked once a day, at the next CSV rollover) still
  // isn't enough to keep this machine's disk from filling up - see
  // logRotation.js's own comment on pruneForDiskSpace. On its own timer
  // rather than only checked at the daily rollover, since a genuinely full
  // disk needs a much tighter check than that.
  setInterval(() => pruneForDiskSpace(logDir, /^base_station_received_.*\.csv$/, CRITICAL_BELOW_PCT), 60000);

  const udpSocket = dgram.createSocket('udp4');
  const UDP_BROADCAST_ADDR = config.localBroadcast.address;
  const UDP_PORT = config.localBroadcast.port;
  udpSocket.bind(() => udpSocket.setBroadcast(true));

  const redisStore = new RedisStore({
    url: config.redis.url,
    connection: config.redis.connection,
    minMovementM: config.redis.minMovementM,
    trackRetentionHours: config.redis.trackRetentionHours,
    keepaliveIntervalMs: config.redis.keepaliveIntervalMs,
  });

  // Sends whatever raceMarks currently holds to every boat right now (as
  // opposed to the periodic heartbeat below, which is just "in case a
  // broadcast got missed") - called the instant marks first resolve, so a
  // boat isn't left waiting out a full MARKS_BROADCAST_INTERVAL_MS before
  // hearing about a course that's already known. Works the same way over a
  // real radio or SimRadioLink in SIMULATE mode - both just broadcast, no
  // per-boat addressing at this layer at all (see simRadioLink.js).
  //
  // forceZoneUpdate: only true from setMarkLocation's own call (an explicit,
  // deliberate operator edit) - every other call site (initial resolve, the
  // periodic heartbeat, a new boat joining) is routine/automatic and must
  // NOT overwrite an already-published course:on_grid_zone, same "generate
  // only if nothing's there yet, never silently regenerate over top of it"
  // policy as the marks themselves (see resolveMarks' own comment on why -
  // this Redis instance can be shared with a real course). An edit
  // genuinely changed a mark's position, so the zone MUST be recomputed to
  // match, or it'd be left silently stale/wrong for the rest of the race.
  function broadcastMarksNow(forceZoneUpdate = false) {
    if (!raceMarks) return;
    radio.broadcast(protocol.encodeMarks(raceMarks, { ip: baseIp, port: config.upload.port, adminPort: config.admin.port }));
    // Off by default - this fires on every new-boat join (see
    // NEW_BOAT_FORCE_BROADCAST_THRESHOLD) as well as the periodic
    // heartbeat, so a fleet joining in a burst floods the console with a
    // line that's rarely worth watching. Set LOG_MARKS_BROADCAST=1 to turn
    // it back on, e.g. while debugging a boat that isn't receiving marks.
    if (config.logMarksBroadcast) console.log('[baseStation] broadcast course marks to all boats');
    (async () => {
      try {
        if (!forceZoneUpdate && (await redisStore.getOnGridZone())) return;
        await redisStore.setOnGridZone(zonePolygon(raceMarks, config.regattaup.onGridZoneM));
      } catch (err) {
        console.error('[redis] failed to publish on-grid zone:', err.message);
      }
    })();
  }

  // Explicit "where is everyone right now" action for the admin dashboard's
  // "Ping fleet" button (see protocol.js's encodePing/boatAgent.js's own
  // radio.on('ping', ...) handler) - mainly for a boat that's been sitting
  // stationary on the start line since before the base/dashboard was even
  // up: it already sent its one and only frame at that old position (a
  // stationary boat never clears TX_DISTANCE_M again), so there's otherwise
  // no way to learn it's actually there, on-grid, right now, without
  // asking. Works the same way over real radio or SimRadioLink - both just
  // broadcast, no per-boat addressing at this layer at all (see
  // simRadioLink.js). Each boat replies after its own random delay (see
  // config.js's pingResponseJitterMs), not all at once - nothing to
  // reconcile here on the base side beyond that; replies just arrive as
  // ordinary frames through the normal radio.on('frame', ...) path above.
  function pingFleet() {
    // Clears every boat's on-grid state (not lap counts or mark roundings)
    // so whatever on-grid status comes back in each boat's reply is
    // treated as a fresh entry (wasOnGrid reads false again) and actually
    // gets sent, rather
    // than being silently absorbed by the "already told RegattaUp" latch
    // (see detectRaceEvents' wasOnGrid/dueForResend logic) - the whole
    // point of an operator explicitly asking "where's everyone right now"
    // is to hear back about it, not have the answer suppressed by
    // dedup state from whenever a boat last reported in on its own.
    onGridWatchers.clear();
    lastOnGridSentByBoat.clear();
    radio.broadcast(protocol.encodePing());
    console.log(`[baseStation] ${new Date().toISOString()} pinged the fleet for current positions`);
  }

  // The regatta this base station is currently reporting for is an
  // operator choice, not something this process can infer on its own - a
  // base has no other way to know which of possibly several concurrent
  // RegattaUp regattas it's actually sitting at. `activeRegattas` is just
  // an in-memory cache of the last successful fetch, refreshed on the
  // interval below. `selectedRegatta` is the actual selection - entirely
  // local to THIS process (see redisStore.js's own module comment on why
  // this is never written to Redis: a base sharing Redis with other base
  // stations must be free to report for a completely different regatta
  // than any of them, with nothing there to collide over) - persisted to
  // regatta-id.txt (see regattaIdFile.js) so it survives a restart of this
  // same base, but never visible to, or shared with, any other process.
  let activeRegattas = [];
  let selectedRegatta = null;

  // Neither the real radio (connectRealRadio above) nor the base GPS
  // (openBaseGps above) actually opens anything until a regatta is picked
  // for the first time - see selectRegatta below, the sole place this
  // flips. Until then this process just runs the admin dashboard and keeps
  // fetching the active/future regatta list - no serial-port connect
  // attempts, no reconnect/retry error spam - so a freshly-started base
  // sitting on "please pick a regatta" has a quiet console instead of one
  // full of connection errors for hardware nobody's asked it to use yet.
  // Once true, stays true - re-selecting a DIFFERENT regatta later (or one
  // ending and needing a new pick) never tears this back down. SIMULATE
  // mode is unaffected either way (see radioMode 'simulated' above) - this
  // only ever gates real hardware.
  let systemStarted = false;

  function regattaHasEnded(regatta) {
    // end_date is a bare 'YYYY-MM-DD' (no time component) - treat the
    // regatta as still current through the end of that day rather than its
    // very first instant, so a race still running late on its last
    // scheduled day isn't flagged as ended out from under the operator.
    return new Date(`${regatta.end_date}T23:59:59`).getTime() < Date.now();
  }

  // Fetches the current active/future regatta list from RegattaUp (see
  // config.js's activeRegattasUrl) and, while at it, checks whether the
  // currently selected regatta (if any) has passed its own end_date - not
  // whether it's still in RegattaUp's own "active" list, since a regatta
  // can legitimately drop out of that list before its end_date arrives and
  // this base should keep reporting for it right up until the date itself
  // passes. Called once at startup and on a periodic timer (see the
  // interval below) - errors are logged and swallowed, same as the other
  // best-effort background refreshes in this file, so a transient
  // RegattaUp/network hiccup doesn't crash the base station.
  async function refreshActiveRegattas() {
    try {
      const res = await fetch(config.regattaup.activeRegattasUrl, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      activeRegattas = Array.isArray(body.regattas) ? body.regattas : [];
      if (config.regattaup.logActiveRegattas) {
        console.log(
          `[baseStation] ${new Date().toISOString()} fetched ${activeRegattas.length} active/future regatta(s) from ${config.regattaup.activeRegattasUrl}`
        );
      }
    } catch (err) {
      console.error(`[baseStation] failed to refresh active regattas from ${config.regattaup.activeRegattasUrl}:`, err.message);
    }

    if (selectedRegatta && regattaHasEnded(selectedRegatta)) {
      console.warn(
        `[baseStation] selected regatta "${selectedRegatta.name}" ended ${selectedRegatta.end_date} - cleared, please pick another one on the admin dashboard`
      );
      selectedRegatta = null;
      redisStore.setCurrentRegatta(null);
      currentRegattaId = null;
      clearPersistedRegattaId();
    }
  }

  // What the admin dashboard's regatta card actually renders - the cached
  // list plus whichever one (if any) is currently selected.
  function getRegattaStatus() {
    return { regattas: activeRegattas, selected: selectedRegatta };
  }

  // Called from the admin dashboard's regatta select (see adminServer.js)
  // and from the startup terminal prompt/default below - looks the id up
  // in the last-fetched list (not blindly trusted from the client) so a
  // stale/tampered id can't get selected.
  function selectRegatta(id) {
    const regatta = activeRegattas.find((r) => r.id === id);
    if (!regatta) throw new Error('unknown regatta id - refresh the list and try again');
    const isLiveSwitch = regattaSwitchesResolveTheirOwnCourse && (!selectedRegatta || selectedRegatta.id !== regatta.id);
    selectedRegatta = regatta;
    redisStore.setCurrentRegatta(regatta.id);
    currentRegattaId = regatta.id;
    // Remembers this pick as the new default for next time this base
    // restarts - the same file REGATTAUP_REGATTA_ID itself writes to (see
    // config.js's resolveDefaultRegattaId/regattaIdFile.js), so whichever
    // was used most recently (an operator's own dashboard pick, or the env
    // var) is what the startup resolution defaults to on the next run.
    persistRegattaId(id, regatta.name, regatta.default_lat, regatta.default_lon);
    // A newly-selected regatta is a new race starting - every per-boat
    // watcher (lap count, on-grid state, mark roundings) is keyed only by
    // boatId, not by regatta, and lives for as long as this process stays
    // up (see clearRaceWatchers' own comment). Without this, a boat ID
    // reused for the new regatta would inherit whatever lapCount/prevPos
    // its watcher was left at from whatever the PREVIOUS regatta last did
    // with that same boat - a stale crossing reference that can register a
    // spurious "lap" the moment this boat's very first fix of the new race
    // arrives, well before anyone actually crosses anything.
    clearRaceWatchers();
    // A live re-pick (the admin dashboard's dropdown, or a second terminal
    // prompt after the first regatta already got this base fully started)
    // - the course/pin-boundary/on-grid-zone that raceMarks and the admin
    // map are currently showing are the PREVIOUS regatta's, now published
    // under a namespace this base isn't even looking at anymore (see
    // redisStore.js's `regattas:<id>:...` prefixing). Not awaited - the
    // caller (the admin dashboard's POST handler) shouldn't hang on this,
    // and resolveCourseForCurrentRegatta(false) never retries past one
    // attempt anyway.
    if (isLiveSwitch) {
      resolveCourseForCurrentRegatta(false).catch((err) =>
        console.error('[baseStation] failed to resolve course for newly-selected regatta:', err.message)
      );
    }
    console.log(`[baseStation] regatta selected: "${regatta.name}" (${regatta.venue})`);
    if (!systemStarted) {
      systemStarted = true;
      if (radioMode === 'real') console.log(`[baseStation] connecting to radio ${config.radio.port} @ ${config.radio.baud}`);
      connectRealRadio();
      openBaseGps();
    }
    return regatta;
  }

  // Lets an operator correct/set a single mark's position from the base's
  // own admin map page (see adminServer.js's renderMap - the "edit marks"
  // column) - e.g. walking out to the actual mark with a phone and
  // recording its real GPS position, or nudging one that was set up
  // wrong. Persists to Redis (so it survives a base restart the same way
  // an initially-resolved course does) and re-broadcasts immediately,
  // same as any other course change.
  async function setMarkLocation(name, lat, lon) {
    if (!MARK_NAMES.includes(name)) throw new Error(`unknown mark: ${name}`);
    if (!raceMarks) throw new Error('no course published yet - nothing to edit');
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new Error('invalid lat/lon');
    }
    const pos = { lat, lon };
    await redisStore.setMark(name, pos);
    raceMarks[name] = pos;
    // Existing finish-line watchers cached committeeFinish/finish's
    // position at whatever it was when a given boat's first fix arrived
    // (see watcherFor below) - clear so every boat's watcher rebuilds fresh
    // from the corrected marks on its next fix, rather than silently
    // keeping stale gate geometry for the rest of the race. Same reasoning
    // for on-grid watchers (pin/committeeStart) and mark-rounding watchers
    // (every windward/leeward mark), regardless of which specific mark was
    // actually edited - simplest to always clear all three.
    clearRaceWatchers();
    // The pin boundary gate's own published endpoint (see
    // republishPinBoundaryMark) is derived from pin/committeeStart - if
    // either just moved and the gate is on, republish it too, or RegattaUp's
    // own copy (and this base's next restart) would keep showing/using
    // wherever it used to point.
    if ((name === 'pin' || name === 'committeeStart') && raceMarks.pinBoundaryEnabled) {
      await republishPinBoundaryMark();
    }
    broadcastMarksNow(true); // this mark's position just explicitly changed - the on-grid zone must be recomputed to match
    return raceMarks;
  }

  // Recomputes and republishes (or removes) the pin boundary gate's
  // Redis-visible mark:pinBoundary entry to match raceMarks.pinBoundaryEnabled
  // right now - called after that flag changes (setPinBoundaryEnabled),
  // after pin/committeeStart move while it's on (setMarkLocation above), and
  // once at startup right after marks first resolve, so a base restarted
  // after an out-of-band Redis edit still republishes a fresh, correct
  // value rather than trusting whatever's already sitting there. This mark
  // is never itself a source of truth for anything in THIS app - only
  // raceMarks.pinBoundaryEnabled plus the real pin/committeeStart positions
  // are (see foulWatcher.js/simGps.js, which never read it) - it exists
  // purely so RegattaUp's own generic mark:* scan (saveRaceMarks) can draw
  // the same gate on its map with no backend changes needed there.
  async function republishPinBoundaryMark() {
    if (raceMarks.pinBoundaryEnabled) {
      await redisStore.setMark(PIN_BOUNDARY_MARK, getPinBoundaryFarPoint(raceMarks.pin, raceMarks.committeeStart));
    } else {
      await redisStore.deleteMark(PIN_BOUNDARY_MARK);
    }
  }

  // Turns the pin boundary gate on/off - the base admin map's own checkbox
  // (see adminServer.js), the only way this is ever set. Unlike
  // setMarkLocation, there's no position to validate here - just persists
  // the flag, republishes its derived endpoint, and re-broadcasts, same as
  // any other course change.
  async function setPinBoundaryEnabled(enabled) {
    if (!raceMarks) throw new Error('no course published yet - nothing to edit');
    const wasEnabled = !!raceMarks.pinBoundaryEnabled;
    raceMarks.pinBoundaryEnabled = !!enabled;
    await redisStore.setPinBoundaryEnabled(raceMarks.pinBoundaryEnabled);
    await republishPinBoundaryMark();
    // Existing FoulWatchers cached whether the gate was on at construction
    // time (see foulWatcherFor) - only worth rebuilding if the flag actually
    // changed, same "don't do the work if nothing changed" reasoning
    // elsewhere in this file, though harmless either way.
    if (wasEnabled !== raceMarks.pinBoundaryEnabled) clearRaceWatchers();
    broadcastMarksNow(true);
    return raceMarks;
  }

  // Every per-boat watcher (finish-line lap count, on-grid state, mark
  // roundings) lives entirely in memory, keyed by boatId, for as long as
  // this base station process stays up - nothing about a boatId is
  // race-scoped on its own, so without an explicit reset a boat's watcher
  // (its lapCount, its last-known prevPos for crossing detection, ...)
  // just carries straight over from whatever race/test last used that same
  // boatId. Cleared whenever a mark is edited from the map (see
  // setMarkLocation, the only other caller - existing watchers cached the
  // old mark position, so they'd otherwise keep using stale gate geometry
  // for the rest of the race) AND whenever a different regatta is selected
  // (see selectRegatta below) - selecting a regatta is this app's own
  // signal that a new race is starting, the same base station process
  // often outliving several of them across a day of testing/racing with
  // the same boat IDs reused each time.
  function clearRaceWatchers() {
    finishLineWatchers.clear();
    onGridWatchers.clear();
    markRoundingWatchers.clear();
    foulWatchers.clear();
    lastOnGridSentByBoat.clear();
  }

  // Course marks - windward, leeward, and the pin/committeeStart ends of
  // the start line plus committeeFinish/finish for the finish gate (same
  // geometry the simulator uses, see course.js). In SIMULATE mode,
  // computes+publishes them if missing (whichever process - this one, or a
  // boat simulator - asks Redis first defines the course for everyone
  // after it); for real hardware, only reads whatever a race operator has
  // actually published (getMarks(), not getOrCreateMarks() - this app has
  // no business inventing a real course). Either way, once committeeFinish
  // +finish are known, raceMarks below is what builds a FinishLineWatcher
  // per boat.
  let raceMarks = null;

  // False until the startup flow below reaches its own course-resolution
  // step (see the call site further down) - selectRegatta checks this so a
  // regatta picked as part of THAT startup sequence (the default/persisted
  // id, the terminal prompt, or the closest-regatta fallback) doesn't also
  // race its own course resolution against the startup flow's, which runs
  // unconditionally right after regatta selection settles either way. Once
  // true, every later call to selectRegatta is necessarily a live re-pick
  // (the admin dashboard's dropdown, or a second terminal prompt), and gets
  // its course refreshed on the spot instead.
  let regattaSwitchesResolveTheirOwnCourse = false;

  async function resolveMarks() {
    if (config.simulate) {
      // Purely diagnostic: compares whatever SIM_COURSE_LENGTH_NM/
      // SIM_CENTER_LAT/SIM_CENTER_LON/SIM_START_LINE_POSITION/
      // SIM_COMMITTEE_GAP_M is set to against
      // whatever's actually published in Redis, and warns loudly on a
      // mismatch - but NEVER clears anything itself. This Redis instance
      // can be the same one a real course is published on (REDIS_ENV=
      // production is one env var away), and a simulation run must never be
      // able to destroy that just by having a SIM_* var set - resetting
      // published marks is only ever done explicitly, via `npm run
      // reset-course` (see below). getOrCreateMarks (below) still creates a
      // fresh course from scratch when NOTHING is published yet - that's
      // not a reset, there's nothing to lose.
      try {
        const existing = await redisStore.getMarks();
        // Only the marks actually compared below need to exist for this
        // check to mean anything - NOT every MARK_NAMES entry. Requiring the
        // full set (including pin/committeeStart/committeeFinish/finish,
        // which this check doesn't even look at) meant that adding a new
        // mark name here (e.g. the committeeStart/committeeFinish split)
        // made this permanently false against a course published before
        // that change, treating a pure schema upgrade as "the course
        // differs" and clearing a real, unrelated, already-correct course
        // out from under it. Checked against the BLACK marks specifically -
        // they're the ones COURSE_LENGTH_M/SIM_CENTER_LAT/LON actually
        // define now (green is always a derived midpoint, see course.js's
        // getMarks - nothing to independently check it against).
        const hasGeometryMarks = existing.leewardBlack && existing.windwardBlack;
        // Center is the midpoint between the two black marks (see getMarks)
        // - averaging lat/lon directly, same flat-earth approximation
        // distanceMeters/offsetToLatLon already use throughout this file,
        // fine at course-length scales.
        const centerMatches =
          hasGeometryMarks &&
          distanceMeters(
            { lat: (existing.leewardBlack.lat + existing.windwardBlack.lat) / 2, lon: (existing.leewardBlack.lon + existing.windwardBlack.lon) / 2 },
            { lat: config.sim.centerLat, lon: config.sim.centerLon }
          ) < 0.1;
        const lengthMatches =
          hasGeometryMarks && Math.abs(distanceMeters(existing.leewardBlack, existing.windwardBlack) - COURSE_LENGTH_M) < 0.1;
        // Where committeeStart actually sits, as a percentage back up the
        // leewardBlack->windwardBlack line - compared against
        // SIM_START_LINE_POSITION the same way as the other geometry checks
        // here. Plain distanceMeters ratio, not a full vector projection -
        // fine for an unedited (still axis-aligned) freshly-generated
        // course, which is the only case this check needs to catch; an
        // operator-edited course is a deliberate change this diagnostic
        // isn't meant to second-guess.
        const startLinePositionMatches =
          !hasGeometryMarks ||
          !existing.committeeStart ||
          Math.abs(
            (distanceMeters(existing.leewardBlack, existing.committeeStart) / distanceMeters(existing.leewardBlack, existing.windwardBlack)) * 100 -
              START_LINE_POSITION
          ) < 1;
        // Same idea, for the committeeStart<->committeeFinish gap (see
        // course.js's own comment on SIM_COMMITTEE_GAP_M) - without this, a
        // course published before the gap was set (or with a different gap)
        // silently keeps its old, stale gap forever: SIM_COMMITTEE_GAP_M
        // taking no visible effect until the course is cleared by some
        // OTHER means looks exactly like SIM_FOUL's committee-gap crossing
        // simply not firing. Missing fields (a course published before
        // committeeStart/committeeFinish existed at all) default to
        // "matches" rather than forcing a clear - same backward-
        // compatibility reasoning as hasGeometryMarks above.
        const gapSpanMatches =
          !existing.committeeStart ||
          !existing.committeeFinish ||
          Math.abs(
            distanceMeters(existing.committeeStart, existing.committeeFinish) -
              COMMITTEE_GAP_M
          ) < 0.1;
        const requestedChange = [
          'SIM_COURSE_LENGTH_NM',
          'SIM_CENTER_LAT',
          'SIM_CENTER_LON',
          'SIM_START_LINE_POSITION',
          'SIM_COMMITTEE_GAP_M',
        ].some((name) => process.env[name] !== undefined);
        // NEVER clear marks automatically - this used to call
        // redisStore.clearCourseMarks() right here whenever a SIM_* env var
        // was set and didn't match what's published. That's genuinely
        // dangerous: this same Redis instance can be shared with a real,
        // unrelated course (REDIS_ENV=production is one keystroke away, and
        // a base restarted for a routine test with one SIM_* var set could
        // silently wipe a real committee's actual course out from under
        // them, with no undo). Resetting published marks must always be a
        // deliberate, explicit action an operator takes on purpose - see
        // `npm run reset-course` (resetCourse.js) - never an automatic side
        // effect of starting a simulation. Loudly warn instead, so a
        // mismatch is visible rather than either silently wiped or silently
        // ignored, and leave the existing marks exactly as they are either
        // way.
        if (requestedChange && !(centerMatches && lengthMatches && startLinePositionMatches && gapSpanMatches)) {
          console.warn(
            '[baseStation] WARNING: requested course (SIM_COURSE_LENGTH_NM/SIM_CENTER_LAT/SIM_CENTER_LON/' +
              'SIM_START_LINE_POSITION/SIM_COMMITTEE_GAP_M) differs from what\'s ' +
              'already published in Redis - using the EXISTING published marks as-is, NOT the values just requested. ' +
              'Run `npm run reset-course` if you actually want to reset and republish with the new values.'
          );
        }
      } catch (err) {
        console.error('[redis] failed to check published course marks:', err.message);
      }
      try {
        // An operator's explicit SIM_CENTER_LAT/SIM_CENTER_LON always wins
        // (same rule the requestedChange warning above already applies) -
        // otherwise a freshly-created course defaults to the selected
        // regatta's own venue coordinates (RegattaUp's default_lat/
        // default_lon - see getActiveRegattas) rather than the hardcoded
        // Black Rock Desert fallback, so a course an operator never
        // explicitly positioned still starts out roughly where the regatta
        // actually is. See resolveCourseCenter's own comment (course.js).
        const explicitCenterOverride = process.env.SIM_CENTER_LAT !== undefined || process.env.SIM_CENTER_LON !== undefined;
        const { lat: centerLat, lon: centerLon } = resolveCourseCenter(
          explicitCenterOverride ? undefined : selectedRegatta && selectedRegatta.default_lat,
          explicitCenterOverride ? undefined : selectedRegatta && selectedRegatta.default_lon,
          config.sim.centerLat,
          config.sim.centerLon
        );
        const marks = await redisStore.getOrCreateMarks(centerLat, centerLon);
        marks.pinBoundaryEnabled = await redisStore.getPinBoundaryEnabled();
        console.log(`[baseStation] course marks (Redis): ${Object.keys(marks).join(', ')}`);
        return marks;
      } catch (err) {
        console.error('[redis] failed to resolve marks:', err.message);
        return null;
      }
    } else {
      try {
        const marks = await redisStore.getMarks();
        if (marks.committeeFinish && marks.finish) {
          marks.pinBoundaryEnabled = await redisStore.getPinBoundaryEnabled();
          console.log('[baseStation] finish line resolved (Redis) - lap crossings will be reported');
          return marks;
        }
        return null;
      } catch (err) {
        console.error('[redis] failed to resolve course marks for lap detection:', err.message);
        return null;
      }
    }
  }

  // Resolves the current regatta's course (raceMarks always starts back at
  // null, so a regatta switch can never leave the PREVIOUS regatta's course
  // sitting there mislabeled as the new one's), then republishes the pin
  // boundary gate and broadcasts to the fleet - the startup flow (below)
  // and selectRegatta (further up) share this rather than each having their
  // own copy. retryUntilFound=true (startup only) keeps trying every 5s,
  // the way real hardware needs when an operator hasn't published a course
  // yet; selectRegatta passes false so a live regatta switch that lands on
  // one with no course yet just shows "no course" on the admin map, rather
  // than leaving that dashboard request hanging on a retry loop.
  async function resolveCourseForCurrentRegatta(retryUntilFound) {
    raceMarks = null;
    do {
      raceMarks = await resolveMarks();
      if (raceMarks) {
        // Refreshes mark:pinBoundary against whatever pin/committeeStart
        // actually are right now - covers a base restarted after an
        // out-of-band Redis edit (or a version of this app that didn't yet
        // keep it in sync), rather than trusting whatever's already there.
        await republishPinBoundaryMark();
        console.log(
          raceMarks.pinBoundaryEnabled
            ? '[baseStation] pin boundary gate is ON - downwind crossings beyond pin will be reported as fouls, the whole pin side of the course is off-limits'
            : '[baseStation] pin boundary gate is off (optional - toggle it from the admin map if you want it)'
        );
        broadcastMarksNow();
        // Replay whatever arrived too early to be detected live (see
        // pendingFrames' own comment, above the radio.on('frame') handler) -
        // through the exact same detectRaceEvents logic a live frame goes
        // through, so none of it is silently lost just because it happened
        // to land before this resolved.
        for (const decoded of pendingFrames) detectRaceEvents(decoded);
        pendingFrames = [];
      } else if (retryUntilFound) {
        // Either a real Redis error (both branches) or, real-hardware mode
        // only, marks just aren't published yet - either way, wait before
        // retrying rather than hammering Redis in a tight loop.
        console.log(
          config.simulate
            ? '[baseStation] failed to resolve/create course marks - will retry in 5s'
            : '[baseStation] no course marks in Redis yet - will keep checking every 5s'
        );
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    } while (retryUntilFound && !raceMarks);
  }

  // Prompts on the terminal for which regatta to race, when nothing else
  // resolved one (see the call site below) - only possible with a real TTY
  // attached (a systemd/piped/background run has no one to answer, and
  // would otherwise hang here forever). Lists whatever refreshActiveRegattas
  // just fetched, 1-indexed for a human to type, and re-prompts on anything
  // that doesn't parse to a valid choice rather than guessing. Returns the
  // selected regatta, or null if there's nothing to prompt with (no TTY, or
  // RegattaUp returned an empty list).
  function promptForRegatta() {
    if (!process.stdin.isTTY) {
      console.warn(
        '[baseStation] no regatta selected and no interactive terminal to prompt on - pick one on the admin dashboard before racing'
      );
      return Promise.resolve(null);
    }
    if (activeRegattas.length === 0) {
      console.warn('[baseStation] no regatta selected and none are currently active/future on RegattaUp - pick one on the admin dashboard once available');
      return Promise.resolve(null);
    }
    console.log('\n[baseStation] no regatta selected - choose one to race:');
    activeRegattas.forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.name} - ${r.venue} (${r.start_date} to ${r.end_date})`);
    });
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = () => new Promise((resolve) => rl.question('[baseStation] enter a number: ', resolve));
    return (async () => {
      let choice = null;
      while (!choice) {
        const answer = (await ask()).trim();
        const n = parseInt(answer, 10);
        if (Number.isInteger(n) && n >= 1 && n <= activeRegattas.length) choice = activeRegattas[n - 1];
        else console.log(`[baseStation] enter a number between 1 and ${activeRegattas.length}`);
      }
      rl.close();
      try {
        return await selectRegatta(choice.id);
      } catch (err) {
        console.error('[baseStation] failed to select regatta:', err.message);
        return null;
      }
    })();
  }

  // Picks whichever active/future regatta's date range sits closest to
  // today - 0 "distance" if it's currently running (start_date <= today <=
  // end_date), otherwise however far off the nearer boundary is. Used only
  // as the last-resort fallback below, when nothing else selected a regatta
  // (no REGATTAUP_REGATTA_ID, nothing persisted in regatta-id.txt from a
  // prior run, and no interactive terminal to prompt on - i.e. running as a
  // systemd service with no operator watching the console). Without this a
  // freshly-installed service just sits idle reporting for nothing until
  // someone finds the admin dashboard - this gets it racing for *something*
  // reasonable immediately, and it's exactly as overridable afterward as
  // any other pick (selectRegatta below persists it the same way a
  // dashboard click would, and the admin dashboard's dropdown can always
  // change it). null if there's nothing to pick from.
  function pickClosestRegatta() {
    if (activeRegattas.length === 0) return null;
    const now = Date.now();
    const distanceMs = (r) => {
      const start = new Date(`${r.start_date}T00:00:00`).getTime();
      const end = new Date(`${r.end_date}T23:59:59`).getTime();
      if (now >= start && now <= end) return 0;
      return Math.min(Math.abs(now - start), Math.abs(now - end));
    };
    return activeRegattas.reduce((closest, r) => (distanceMs(r) < distanceMs(closest) ? r : closest));
  }

  // Regatta selection MUST resolve before course/marks resolution begins -
  // every mark/on-grid-zone/pin-boundary key now lives under
  // `regattas:<id>:...` (see redisStore.js's own module comment), so
  // creating or reading a course before redisStore.currentRegattaId is set
  // would silently operate on the "none" namespace even when a real
  // regatta (REGATTAUP_REGATTA_ID, a persisted default from regatta-id.txt,
  // or an operator's own terminal pick) is about to be selected moments
  // later. Previously these ran as two independent, unsequenced async flows
  // - now one sequential IIFE, regatta first, then marks.
  (async () => {
    // Fetch once at startup and keep refreshing on a slow heartbeat after
    // (see refreshActiveRegattas' own comment). Selection is always local
    // to this process (see the module comment above selectedRegatta) - a
    // fresh process always starts with nothing selected, so there's no
    // "already selected" case to check here the way a Redis-backed
    // selection would have had.
    await refreshActiveRegattas();
    // Apply config.regattaup.defaultRegatta (REGATTAUP_REGATTA_ID, or
    // whatever's persisted in regatta-id.txt from a prior run/pick - see
    // config.js's own comment) if it's actually one of the regattas
    // RegattaUp just returned. A default that doesn't match anything real
    // (stale, or from an account/environment switch) falls through to the
    // interactive terminal prompt below instead of a hard error, since an
    // operator can still pick correctly even when the remembered default no
    // longer applies.
    let picked = null;
    if (config.regattaup.defaultRegatta) {
      try {
        picked = selectRegatta(config.regattaup.defaultRegatta.id);
      } catch (err) {
        console.warn(
          `[baseStation] default regatta id "${config.regattaup.defaultRegatta.id}" isn't in the active/future list - ${err.message}`
        );
      }
    }
    if (!picked) picked = await promptForRegatta();
    // Only ever reached with no TTY (promptForRegatta blocks until answered
    // when one's attached) - see pickClosestRegatta's own comment.
    if (!picked) {
      const auto = pickClosestRegatta();
      if (auto) {
        try {
          picked = selectRegatta(auto.id);
          console.log(
            `[baseStation] no regatta selected - automatically picked "${auto.name}" (${auto.start_date} to ${auto.end_date}, closest to today) - change it on the admin dashboard if this isn't right`
          );
        } catch (err) {
          console.error('[baseStation] failed to auto-select the closest regatta:', err.message);
        }
      }
    }
    if (!picked) console.log('[baseStation] regatta: none selected - pick one on the admin dashboard before racing');
    setInterval(refreshActiveRegattas, config.regattaup.activeRegattasRefreshIntervalMs);

    // Flipped either way, right here rather than after course resolution
    // finishes (or doesn't run at all) - see regattaSwitchesResolveTheirOwnCourse's
    // own comment on why selectRegatta needs to know "the startup flow is
    // done deciding whether IT owns course resolution", not "a course now
    // exists". Without this, an operator who finally picks a regatta from
    // the admin dashboard after starting with none selected would find
    // selectRegatta silently skips resolving a course for it too.
    regattaSwitchesResolveTheirOwnCourse = true;
    if (picked) {
      // Real-hardware marks might not be in Redis yet at startup (an
      // operator setting up the course after the base is already running is
      // a normal sequence, not an error) - keeps trying every few seconds
      // instead of giving up after one look, so the moment they do show up,
      // this picks them up and broadcasts immediately rather than waiting
      // for the base to be restarted.
      await resolveCourseForCurrentRegatta(true);
    } else {
      // No regatta selected at all (no TTY to prompt on, RegattaUp returned
      // nothing to pick from) - deliberately do NOT create/read a course
      // here. redisStore.currentRegattaId is still null at this point, and
      // every course/mark/on-grid-zone key is namespaced by regatta (see
      // redisStore.js's own module comment) - resolving one now would
      // silently create/publish a real course under the "none" namespace,
      // which is exactly the confusing state an operator would otherwise
      // find later (a course apparently coming from nowhere, or fixes
      // recorded against no regatta at all - see radio.on('frame', ...)
      // below, which refuses to process anything for the same reason).
      // Once an operator does pick a regatta from the admin dashboard,
      // selectRegatta's own isLiveSwitch path (regattaSwitchesResolveTheirOwnCourse
      // is already true) resolves its course then, same as any other live switch.
      console.log('[baseStation] no regatta selected - not reading/writing any course, and ignoring any boat fixes, until one is picked on the admin dashboard');
    }
  })();

  // Periodic heartbeat re-broadcast, for a boat that missed the immediate
  // one above (powered on late, brief radio dropout) - see
  // broadcastMarksNow()'s comment.
  setInterval(broadcastMarksNow, config.marksBroadcastIntervalMs);

  // One FinishLineWatcher per boat (each needs its own independent
  // crossing-state and lap counter), built lazily the first time a given
  // boat's fixes are seen and raceMarks is available.
  const finishLineWatchers = new Map();
  function watcherFor(boatId) {
    if (!raceMarks) return null;
    let watcher = finishLineWatchers.get(boatId);
    if (!watcher) {
      watcher = new FinishLineWatcher(raceMarks);
      finishLineWatchers.set(boatId, watcher);
    }
    return watcher;
  }

  // One OnGridWatcher per boat, same lazy-build-per-boat pattern as
  // finishLineWatchers above (see onGridWatcher.js) - independent in/out
  // state per boat, built once raceMarks has pin/committeeStart AND
  // windwardGreen/leewardGreen (needed for the watcher's own starboard-tack
  // exclusion corridor - see its module comment).
  const onGridWatchers = new Map();

  // How long a boat can sit continuously on-grid before its own latched
  // "already told RegattaUp" state (see detectRaceEvents' wasOnGrid check
  // below) auto-releases and lets a fresh 'ongrid' send through again, even
  // without an intervening 'offgrid' - a periodic re-affirmation rather
  // than one static fact for however long the boat sits there, but capped
  // to once every 10s rather than every qualifying fix (which is what this
  // whole latch exists to avoid - see its own comment). Also the retry
  // cadence for a dropped webhook: mylapsWebhook's own realtime-notification
  // write can silently fail under a large fleet's grid-on burst even though
  // the actual present_racer_ids write succeeds (see regatta-up's
  // mylapsWebhook/entry.ts) - a shorter latch means this boat's next
  // re-affirmation retries sooner instead of leaving a dropped notification
  // to sit for up to 30s.
  const ONGRID_RESEND_INTERVAL_MS = 10000;
  const lastOnGridSentByBoat = new Map();

  function onGridWatcherFor(boatId) {
    if (!raceMarks || !raceMarks.windwardGreen || !raceMarks.leewardGreen) return null;
    let watcher = onGridWatchers.get(boatId);
    if (!watcher) {
      watcher = new OnGridWatcher(raceMarks, config.regattaup.onGridZoneM);
      onGridWatchers.set(boatId, watcher);
    }
    return watcher;
  }

  // One MarkRoundingWatcher per boat per gate in MARK_ROUNDING_GATES (see
  // markRoundingWatcher.js), same lazy-build pattern as the watchers above
  // - keyed by "boatId:markName" since a boat needs an independent watcher
  // per mark, not just per boat. Only built once raceMarks has both marks
  // a given gate needs.
  const markRoundingWatchers = new Map();
  function markRoundingWatchersFor(boatId) {
    if (!raceMarks) return [];
    return MARK_ROUNDING_GATES.map((gate) => {
      const key = `${boatId}:${gate.mark}`;
      let watcher = markRoundingWatchers.get(key);
      if (!watcher && raceMarks[gate.mark]) {
        let radiusM = config.regattaup.markRoundingExtensionM;
        if (gate.outerMark && raceMarks[gate.outerMark]) {
          const outerDistM = distanceMeters(raceMarks[gate.mark], raceMarks[gate.outerMark]);
          radiusM = Math.min(radiusM, outerDistM * OUTER_MARK_SAFETY_FRACTION);
        }
        watcher = new MarkRoundingWatcher(raceMarks[gate.mark], radiusM);
        markRoundingWatchers.set(key, watcher);
      }
      return watcher && { mark: gate.mark, watcher };
    }).filter(Boolean);
  }

  // One FoulWatcher per boat (see foulWatcher.js), same lazy-build-per-boat
  // pattern as the watchers above - built once raceMarks has all four marks
  // the start/finish line complex needs (pin/committeeStart/
  // committeeFinish/finish).
  const foulWatchers = new Map();
  function foulWatcherFor(boatId) {
    if (!raceMarks || !raceMarks.pin || !raceMarks.committeeStart || !raceMarks.committeeFinish || !raceMarks.finish) return null;
    let watcher = foulWatchers.get(boatId);
    if (!watcher) {
      watcher = new FoulWatcher(raceMarks);
      foulWatchers.set(boatId, watcher);
    }
    return watcher;
  }

  // All three webhook queues below default to the same LOG_DIR - a queue's
  // own "ready" line just shows its filename (see queueFileLabel), with the
  // shared directory logged once, immediately before the first "ready" line
  // (inside the lap queue's own IIFE below), so the two appear as adjacent
  // lines instead of the directory printing at setup time here while
  // "ready" only lands later, once each queue actually finishes opening,
  // with whatever else this file logs in between the two. Each
  // REGATTAUP_*_QUEUE_DB env var can still override its own path
  // independently, though, so a queue whose directory doesn't match this
  // one falls back to its own full path in its "ready" line instead of
  // silently going missing from the log.
  const webhookQueueDir = path.dirname(config.regattaup.queueDbPath);
  function queueFileLabel(dbPath) {
    return path.dirname(dbPath) === webhookQueueDir ? path.basename(dbPath) : dbPath;
  }

  // Lap webhook queue (see lapWebhookQueue.js) - initializes asynchronously
  // (it reads/creates a small sqlite file), so a lap detected before it's
  // ready gets buffered here rather than dropped. Once ready, buffered laps
  // flush immediately and a periodic retry loop starts picking up anything
  // already-queued that failed (or crashed before its first attempt on a
  // previous run).
  let lapWebhookQueue = null;
  let bufferedLaps = [];

  (async () => {
    try {
      lapWebhookQueue = await LapWebhookQueue.create(config.regattaup.queueDbPath);
      console.log(`[baseStation] webhook queues stored in ${webhookQueueDir}`);
      console.log(`[baseStation] lap webhook queue ready (${queueFileLabel(config.regattaup.queueDbPath)})`);
      for (const lap of bufferedLaps) enqueueLap(lap);
      bufferedLaps = [];
    } catch (err) {
      console.error(red(`[regattaup] failed to initialize lap webhook queue: ${err.message}`));
    }
  })();

  // Same buffer-then-flush pattern as the lap queue above, for on-grid/
  // off-grid transitions (see onGridWatcher.js) - its own separate queue
  // file, see onGridWebhookQueue.js's module comment for why.
  let onGridWebhookQueue = null;
  let bufferedOnGrid = [];

  (async () => {
    try {
      onGridWebhookQueue = await OnGridWebhookQueue.create(config.regattaup.onGridQueueDbPath);
      console.log(`[baseStation] on-grid webhook queue ready (${queueFileLabel(config.regattaup.onGridQueueDbPath)})`);
      for (const event of bufferedOnGrid) enqueueOnGrid(event);
      bufferedOnGrid = [];
    } catch (err) {
      console.error(red(`[regattaup] failed to initialize on-grid webhook queue: ${err.message}`));
    }
  })();

  // Same buffer-then-flush pattern again, for mark roundings (see
  // markRoundingWatcher.js) - its own separate queue file, same reasoning
  // as onGridWebhookQueue.js's module comment. Created unconditionally
  // (same as the lap/on-grid queues) even when markRoundingEnabled is off,
  // so it's ready instantly if the feature gets turned on without needing
  // this init to race a config change - config.regattaup.markRoundingEnabled
  // (and .enabled) are only checked at the point roundings actually get
  // enqueued, below.
  let markRoundingWebhookQueue = null;
  let bufferedMarkRoundings = [];

  (async () => {
    try {
      markRoundingWebhookQueue = await MarkRoundingWebhookQueue.create(config.regattaup.markRoundingQueueDbPath);
      console.log(`[baseStation] mark-rounding webhook queue ready (${queueFileLabel(config.regattaup.markRoundingQueueDbPath)})`);
      for (const event of bufferedMarkRoundings) enqueueMarkRounding(event);
      bufferedMarkRoundings = [];
    } catch (err) {
      console.error(red(`[regattaup] failed to initialize mark-rounding webhook queue: ${err.message}`));
    }
  })();

  // Same buffer-then-flush pattern again, for fouls (see foulWatcher.js) -
  // its own separate queue file, same reasoning as onGridWebhookQueue.js's
  // module comment. Created unconditionally even when foulEnabled is off,
  // same reasoning as the mark-rounding queue above.
  let foulWebhookQueue = null;
  let bufferedFouls = [];

  (async () => {
    try {
      foulWebhookQueue = await FoulWebhookQueue.create(config.regattaup.foulQueueDbPath);
      console.log(`[baseStation] foul webhook queue ready (${queueFileLabel(config.regattaup.foulQueueDbPath)})`);
      for (const event of bufferedFouls) enqueueFoul(event);
      bufferedFouls = [];
    } catch (err) {
      console.error(red(`[regattaup] failed to initialize foul webhook queue: ${err.message}`));
    }
  })();

  // Every queued lap/on-grid/mark-rounding/foul event, first attempt or
  // retry alike, is sent through this single shared loop instead of ever
  // being POSTed directly from enqueueLap/OnGrid/MarkRounding/Foul below -
  // see config.js's regattaup.postIntervalMs for why (throttling total
  // request rate to RegattaUp, not per-queue). Round-robins across the four
  // queues (rather than always draining lap first) so a busy lap queue
  // can't starve on-grid/mark-rounding/foul sends indefinitely; sends at most
  // ONE webhook POST per tick, across all queues combined, however many
  // are actually due (see dueForRetry's own backoff for what "due" means -
  // this loop only adds a rate ceiling on top of that, it doesn't change
  // when a given failed send becomes eligible to retry again).
  const webhookQueues = [
    { get: () => lapWebhookQueue, send: sendQueuedLap, inFlight: new Set() },
    { get: () => onGridWebhookQueue, send: sendQueuedOnGrid, inFlight: new Set() },
    { get: () => markRoundingWebhookQueue, send: sendQueuedMarkRounding, inFlight: new Set() },
    { get: () => foulWebhookQueue, send: sendQueuedFoul, inFlight: new Set() },
  ];
  let webhookQueueCursor = 0;

  function drainOneWebhook() {
    for (let i = 0; i < webhookQueues.length; i++) {
      const entry = webhookQueues[webhookQueueCursor];
      webhookQueueCursor = (webhookQueueCursor + 1) % webhookQueues.length;
      const queue = entry.get();
      if (!queue) continue;
      // dueForRetry only looks at attempts/last_attempt_at, both recorded
      // BEFORE the network call it's timing (see sendQueuedLap/OnGrid/
      // MarkRounding's own recordAttempt-then-await-fetch order) - a send
      // slow enough to still be in flight when its own backoff window
      // elapses would otherwise look "due" again and get picked a second
      // time, firing a genuinely duplicate webhook call before the first
      // attempt's response (success or failure) has even come back to
      // remove/reschedule the row. inFlight is this loop's own record of
      // which rows already have an attempt outstanding, independent of
      // what's persisted - excluded here regardless of what dueForRetry
      // itself thinks, and only cleared once that attempt actually
      // resolves (see below).
      const row = queue.dueForRetry(config.regattaup.maxBackoffMs).find((r) => !entry.inFlight.has(r.id));
      if (row) {
        entry.inFlight.add(row.id);
        Promise.resolve(entry.send(queue, row)).finally(() => entry.inFlight.delete(row.id));
        return;
      }
    }
  }

  setInterval(drainOneWebhook, config.regattaup.postIntervalMs);

  // A boat that starts up (or reconnects) after marks already resolved and
  // already broadcast would otherwise wait out a full
  // MARKS_BROADCAST_INTERVAL_MS before ever hearing about the course -
  // broadcasting again the instant a boat that LOOKS like it just (re)started
  // is heard from closes that gap. Broadcast itself doesn't need this (every
  // boat is always a valid target, real radio or SimRadioLink alike - see
  // simRadioLink.js); this is purely about not making a newly-joined boat
  // wait on a timer for something the base already knows.
  //
  // Tracks last-seen time per boat, not just "ever seen" (a plain Set):
  // a real dev workflow restarts boatAgent.js far more often than
  // baseStation.js, and a restarted boat reuses the same boatId - a Set
  // would only ever trigger this once per boatId for the process's whole
  // lifetime, leaving every later restart to wait out the full periodic
  // heartbeat despite boatAgent.js's own startup marks-ping (see its
  // sendMarksPing) being heard just fine, just not treated as "new."
  //
  // BOAT_RECONNECT_GAP_MS, not marksBroadcastIntervalMs (60s default): a
  // restarted boat is heard from again within seconds, not a minute, so a
  // threshold tied to the periodic heartbeat's own cadence would rarely
  // actually trigger for the case this exists to fix. A false trigger here
  // just re-sends marks every boat already has - harmless - so there's no
  // real cost to erring short.
  const BOAT_RECONNECT_GAP_MS = 10000;
  const lastSeenByBoat = new Map();

  // Debounces the "new boat" broadcast above (not the periodic heartbeat,
  // which already has its own natural cadence) - without this, an entire
  // fleet starting at once (or all replying to one "Ping fleet" click, see
  // adminServer.js) each independently looks "new" the instant its own
  // first frame arrives, firing one broadcast per boat, seconds apart,
  // when they all needed the exact same marks the very first one already
  // sent. A boat arriving just outside this window still gets its own
  // immediate broadcast - this only collapses ones that would otherwise
  // land within moments of each other.
  const NEW_BOAT_BROADCAST_DEBOUNCE_MS = 2000;
  let lastNewBoatBroadcastAt = 0;

  // If new boats keep arriving faster than the debounce window clears (a
  // large fleet all starting within the same couple seconds - see
  // fleetSim.js), strictly waiting out the full 2s means whichever boats
  // piled up during it all sit idle a bit longer than they need to. Once
  // this many have queued up since the last broadcast, force one through
  // immediately instead - a pile-up this size means real, currently-
  // connecting boats are accumulating, not just debounce noise from one or
  // two boats arriving moments apart.
  const NEW_BOAT_FORCE_BROADCAST_THRESHOLD = 5;
  let newBoatsSinceLastBroadcast = 0;

  // Frames that arrive before raceMarks has resolved (see resolveMarks'
  // own async startup loop below) - watcherFor/onGridWatcherFor/
  // markRoundingWatchersFor all short-circuit to null/[] until raceMarks is
  // set, which would otherwise silently drop whatever that frame's own
  // lap/on-grid/mark-rounding state actually was, with no way to detect it
  // again later. This isn't just a theoretical race: every boat sends a
  // one-off "marks ping" frame right at its own startup specifically to
  // elicit an immediate marks broadcast (see boatAgent.js's
  // sendMarksPing) - deliberately positioned to read as on-grid - and with
  // a full fleet all starting at once against a real (non-local) Redis,
  // several of those pings can easily land before this base's own
  // raceMarks round-trip finishes. Buffered here and replayed through
  // detectRaceEvents (below) the moment raceMarks becomes available, same
  // buffer-then-flush pattern already used for the webhook queues
  // themselves (bufferedLaps/bufferedOnGrid/bufferedMarkRoundings).
  let pendingFrames = [];

  // Rate-limits the "no regatta selected, ignoring fix" warning below - a
  // boat (or a whole simulated fleet) still streaming while nobody's picked
  // a regatta yet would otherwise log one of these per fix, per boat (5-10Hz
  // across a fleet), burying everything else in the console. First one
  // always logs immediately (so it's not missed), then at most once per this
  // interval while it keeps happening - same pattern as redisStore.js's own
  // WRITE_ERROR_LOG_INTERVAL_MS.
  const NO_REGATTA_WARN_INTERVAL_MS = 30000;
  let lastNoRegattaWarnAt = 0;

  radio.on('frame', (decoded) => {
    // No regatta selected - every course/mark/on-grid-zone/track key is
    // namespaced by regatta (see redisStore.js's own module comment), so
    // recording this fix now would silently write it under the "none"
    // namespace rather than just dropping it - an orphaned fix no actual
    // regatta will ever see, sitting in Redis under a namespace nothing
    // else meaningfully reads. Refused entirely rather than buffered (unlike
    // pendingFrames below, which only bridges the brief startup window
    // before an ALREADY-selected regatta's own course resolves): there's no
    // bound on how long "no regatta selected" can last, and no course to
    // eventually detect events against even if fixes were buffered.
    if (!selectedRegatta) {
      const now = Date.now();
      if (now - lastNoRegattaWarnAt > NO_REGATTA_WARN_INTERVAL_MS) {
        console.warn(`[baseStation] ignoring fix from boat=${decoded.boatId} - no regatta selected, pick one on the admin dashboard`);
        lastNoRegattaWarnAt = now;
      }
      return;
    }
    stats.recordFrame(
      decoded.boatId,
      { lat: decoded.lat, lon: decoded.lon },
      { carrSoln: decoded.carrSoln, gnssFixOk: decoded.gnssFixOk, numSV: decoded.numSV }
    );
    logToConsole(decoded);
    logToCsv(decoded);
    // recordFix never rejects - a write failure (Redis full, network blip,
    // ...) is caught, tracked, and rate-limit logged inside redisStore.js
    // itself now (see its own comment), surfaced on the admin dashboard's
    // Redis card rather than needing a .catch() here.
    redisStore.recordFix(decoded, new Date());
    outputFrame(decoded); // <- swap/extend this for your actual race software

    const now = Date.now();
    const lastSeen = lastSeenByBoat.get(decoded.boatId);
    if (lastSeen === undefined || now - lastSeen > BOAT_RECONNECT_GAP_MS) {
      newBoatsSinceLastBroadcast++;
      if (
        now - lastNewBoatBroadcastAt > NEW_BOAT_BROADCAST_DEBOUNCE_MS ||
        newBoatsSinceLastBroadcast >= NEW_BOAT_FORCE_BROADCAST_THRESHOLD
      ) {
        broadcastMarksNow();
        lastNewBoatBroadcastAt = now;
        newBoatsSinceLastBroadcast = 0;
      }
      // Same "looks like it just (re)started" signal as the marks
      // re-broadcast above, also used to clear this one boat's on-grid
      // latch (see onGridWatcherFor/lastOnGridSentByBoat, and pingFleet's
      // own comment for why the latch exists at all) - without this, a
      // simulator restarted with the same boatId inherits whatever
      // wasOnGrid/lastSent state this base still has cached from the
      // previous run, and its very first genuine on-grid entry gets
      // silently absorbed as a "still on"/already-told-RegattaUp
      // re-affirmation instead of sent. Scoped to just this boatId (not
      // pingFleet's whole-fleet clear), since only this one boat is
      // actually restarting.
      onGridWatchers.delete(decoded.boatId);
      lastOnGridSentByBoat.delete(decoded.boatId);
    }
    lastSeenByBoat.set(decoded.boatId, now);

    // The marks-ping frame (see boatAgent.js's sendMarksPing) is NOT a real
    // fix - "gnssFixOk: true" with zero satellites is physically impossible
    // for an actual GPS reading, so this combination unambiguously
    // identifies it. It's deliberately positioned at the pin<->committeeStart
    // midpoint specifically so the transition to the boat's real first fix
    // (2m leeward of that same line - see simGps.js's PENDING_LINE_OFFSET_M)
    // wouldn't trip up the finish-line/on-grid/mark-rounding watchers that
    // existed when that positioning was designed - but foulWatcher.js cares
    // about crossing that exact line, which the ping sits directly on top
    // of, so feeding it through would report a spurious "downwind start
    // line" foul on every single boat's startup. sendMarksPing's own
    // comment already says this frame isn't "itself meant to be a tracked
    // position" - skip it here for exactly that reason, while still
    // recording/broadcasting it above like any other frame.
    const isMarksPing = decoded.gnssFixOk && decoded.numSV === 0 && decoded.carrSoln === 0;
    if (!isMarksPing) {
      if (raceMarks) detectRaceEvents(decoded);
      else pendingFrames.push(decoded);
    }
  });

  // Lap/on-grid/mark-rounding detection for one already-decoded frame - split
  // out from the radio.on('frame') handler above so pendingFrames (above) can
  // replay exactly this same logic for a frame that arrived before raceMarks
  // was ready, without also re-running the side effects (stats, CSV/Redis
  // logging, the local UDP re-broadcast) that already happened live when the
  // frame first arrived.
  function detectRaceEvents(decoded) {
    const watcher = watcherFor(decoded.boatId);
    const crossing = watcher && watcher.check(decoded.lat, decoded.lon, decoded.timestamp);
    if (crossing) {
      console.log(`[baseStation] boat=${decoded.boatId} crossed the finish line - lap ${crossing.lap}`);
      if (config.regattaup.enabled) {
        const lap = {
          boatId: decoded.boatId,
          lap: crossing.lap,
          rtcTime: crossing.crossingTime * 1000, // ms -> microseconds
          strength: decoded.carrSoln,
          receivedAt: new Date().toISOString(),
        };
        if (lapWebhookQueue) enqueueLap(lap);
        else bufferedLaps.push(lap);
      }
    }

    const onGridWatcher = onGridWatcherFor(decoded.boatId);
    const wasOnGrid = onGridWatcher && onGridWatcher.onGrid;
    const onGridMode = onGridWatcher && onGridWatcher.check(decoded.lat, decoded.lon);
    if (onGridMode) {
      // 'ongrid' fires on every fix while in the zone (see onGridWatcher.js),
      // not just the first one - distinguish the actual entry from a
      // repeat re-affirmation so the log doesn't claim "entered" every time.
      const label = onGridMode === 'offgrid' ? 'left' : wasOnGrid ? 'still on' : 'entered';
      // 'offgrid' is still detected and logged below (useful operationally),
      // but RegattaUp only ever wants to hear about a boat actually being
      // on-grid, not the transition off it - never queued/sent. And even
      // among 'ongrid' results, only the actual transition INTO the zone
      // (!wasOnGrid) gets sent by default - onGridWatcher.check() itself
      // still re-fires 'ongrid' on every qualifying fix (see its own module
      // comment, and the "still on" log label above, both unchanged), but
      // repeat re-affirmations of a state RegattaUp was already told about
      // aren't worth another webhook call every single fix. That latch
      // isn't permanent though: a boat sitting on-grid continuously for
      // ONGRID_RESEND_INTERVAL_MS (30s) without ever going offgrid still
      // gets a fresh send, so a long pre-start dwell still reads as "alive"
      // rather than one static fact from however long ago it first arrived.
      const lastSent = lastOnGridSentByBoat.get(decoded.boatId);
      const dueForResend = lastSent !== undefined && Date.now() - lastSent >= ONGRID_RESEND_INTERVAL_MS;
      // Only meaningful for "still on" - the elapsed time toward the latch
      // above actually releasing again, so it's visible at a glance whether
      // a long-dwelling boat is about to get a fresh send or just did.
      const latchInfo =
        label === 'still on' && lastSent !== undefined
          ? ` (${Math.round((Date.now() - lastSent) / 1000)}s / ${ONGRID_RESEND_INTERVAL_MS / 1000}s latch)`
          : '';
      console.log(`[baseStation] boat=${decoded.boatId} ${label} the start grid${latchInfo}`);
      if (config.regattaup.enabled && onGridMode === 'ongrid' && (!wasOnGrid || dueForResend)) {
        const event = {
          boatId: decoded.boatId,
          mode: onGridMode,
          rtcTime: decoded.timestamp * 1000, // ms -> microseconds
          strength: decoded.carrSoln,
          receivedAt: new Date().toISOString(),
        };
        lastOnGridSentByBoat.set(decoded.boatId, Date.now());
        if (onGridWebhookQueue) enqueueOnGrid(event);
        else bufferedOnGrid.push(event);
      }
    }

    for (const { mark, watcher } of markRoundingWatchersFor(decoded.boatId)) {
      const rounding = watcher.check(decoded.lat, decoded.lon, decoded.timestamp);
      if (!rounding) continue;
      console.log(`[baseStation] boat=${decoded.boatId} rounded ${mark} - rounding ${rounding.rounding}`);
      // A windward rounding (either mark - whichever course this boat is
      // actually racing) means it's out sailing another lap or the next
      // race, not still parking after its last finish - see
      // FoulWatcher.clearFinishGrace's own comment for why that ends its
      // pin-boundary grace window early instead of leaving it to expire on
      // its own FINISH_GRACE_MS timer.
      if (mark === 'windwardGreen' || mark === 'windwardBlack') {
        const foulWatcherForRounding = foulWatcherFor(decoded.boatId);
        if (foulWatcherForRounding) foulWatcherForRounding.clearFinishGrace();
      }
      if (config.regattaup.enabled && config.regattaup.markRoundingEnabled) {
        const event = {
          boatId: decoded.boatId,
          mark,
          rtcTime: rounding.crossingTime * 1000, // ms -> microseconds
          strength: decoded.carrSoln,
          receivedAt: new Date().toISOString(),
        };
        if (markRoundingWebhookQueue) enqueueMarkRounding(event);
        else bufferedMarkRoundings.push(event);
      }
    }

    const foulWatcher = foulWatcherFor(decoded.boatId);
    const foul = foulWatcher && foulWatcher.check(decoded.lat, decoded.lon, decoded.timestamp);
    if (foul) {
      console.log(orange(`[baseStation] boat=${decoded.boatId} foul - ${foul.reason}`, process.stdout));
      if (config.regattaup.enabled && config.regattaup.foulEnabled) {
        const event = {
          boatId: decoded.boatId,
          reason: foul.reason,
          rtcTime: foul.crossingTime * 1000, // ms -> microseconds
          strength: decoded.carrSoln,
          receivedAt: new Date().toISOString(),
        };
        if (foulWebhookQueue) enqueueFoul(event);
        else bufferedFouls.push(event);
      }
    }
  }

  // Durably records the lap (see lapWebhookQueue.js's module comment for
  // why) - the actual send happens later, off the shared drainOneWebhook
  // loop above, not here (see its own comment for why sending is never
  // done inline at enqueue time).
  function enqueueLap(lap) {
    lapWebhookQueue.enqueue(lap);
  }

  // Same pattern as enqueueLap above, for on-grid events.
  function enqueueOnGrid(event) {
    onGridWebhookQueue.enqueue(event);
  }

  // Same pattern again, for mark-rounding events.
  function enqueueMarkRounding(event) {
    markRoundingWebhookQueue.enqueue(event);
  }

  // Same pattern again, for fouls.
  function enqueueFoul(event) {
    foulWebhookQueue.enqueue(event);
  }

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
    fs.appendFile(ensureCsvFile(), line + '\n', (err) => {
      if (err) console.error('[base] csv write failed:', err.message);
    });
  }

  // --- Adapter: replace this once you know your race software's expected
  // input format/protocol. Currently re-broadcasts each fix over UDP as
  // either a synthetic UBX-NAV-PVT message (default) or a standard NMEA GGA
  // sentence - see config.js's localBroadcast.format. ---
  function outputFrame(d) {
    if (config.localBroadcast.format === 'nmea') {
      const buf = Buffer.from(toGGA(d) + '\r\n');
      udpSocket.send(buf, UDP_PORT, UDP_BROADCAST_ADDR);
    } else {
      const buf = encodeNavPvt(d);
      udpSocket.send(buf, UDP_PORT, UDP_BROADCAST_ADDR);
    }
  }

  // Everything the admin dashboard (adminServer.js) needs in one place -
  // defined here rather than there since it's the only thing with closures
  // over all this live state (raceMarks, finishLineWatchers, redisStore,
  // ...). Redis is queried fresh on every call rather than cached, so the
  // dashboard is never showing stale counts - these are cheap ZCARD reads
  // (see redisStore.getStats), not full track fetches.
  async function getFullStats() {
    const redisStats = await redisStore.getStats().catch((err) => {
      console.error('[adminServer] failed to query Redis stats:', err.message);
      return null;
    });
    const redisMemory = await redisStore.getMemoryInfo().catch((err) => {
      console.error('[adminServer] failed to query Redis memory info:', err.message);
      return null;
    });

    const lapCounts = {};
    for (const [boatId, watcher] of finishLineWatchers) lapCounts[boatId] = watcher.lapCount;

    // Merge in uploadDirBaseline (see its own comment above) - a boat with
    // real uploaded history but no session activity yet still gets a row,
    // with everything session-scoped (lastSeen, this-session upload
    // counts, pending) left at its natural "nothing yet" default.
    const snapshot = stats.snapshot();
    const boats = { ...snapshot.boats };
    for (const [boatId, diskInfo] of Object.entries(uploadDirBaseline)) {
      if (!boats[boatId]) {
        boats[boatId] = {
          lastSeen: null,
          upload: { attempts: 0, successes: 0, failures: 0, bytes: 0 },
          pending: null,
          pendingReportedAt: null,
          ip: null,
        };
      }
      boats[boatId].filesOnDisk = diskInfo.fileCount;
      boats[boatId].lastUploadOnDisk = diskInfo.lastUploadAt;
    }

    return {
      ...snapshot,
      boats,
      disk: getDiskSpace(config.logDir),
      base: {
        ip: baseIp,
        uploadPort: config.upload.port,
        adminPort: config.admin.port,
        redisConnected: redisStore.isConnected(),
      },
      course: raceMarks ? { marks: raceMarks, boatsKnown: lastSeenByBoat.size } : null,
      lapCounts,
      redis: redisStats,
      // maxmemoryBytes falls back to the operator-configured
      // REDIS_MEMORY_LIMIT_MB whenever Redis itself won't report its own
      // (see redisStore.js's getMemoryInfo - common on a managed instance),
      // so the dashboard card still gets a real percentage to show whenever
      // that's been set, not just raw usage.
      redisMemory: redisMemory && {
        usedBytes: redisMemory.usedBytes,
        maxmemoryBytes: redisMemory.maxmemoryBytes || (config.redis.memoryLimitMb ? config.redis.memoryLimitMb * 1024 * 1024 : null),
      },
      // Merged onto snapshot.radio's own {framesReceived, syncErrors} -
      // port is a plain serial path in 'real' mode, or the UDP port
      // SimRadioLink actually listens on in 'simulated' mode (no baud
      // there, it isn't a serial connection); both null in 'none' mode
      // (RADIO_ENABLED=0).
      radio: {
        ...snapshot.radio,
        mode: radioMode,
        port: radioMode === 'real' ? config.radio.port : radioMode === 'simulated' ? `UDP :${config.sim.port}` : null,
        baud: radioMode === 'real' ? config.radio.baud : null,
        // null = not applicable (radioMode 'none'), not "disconnected" -
        // see radioConnected's own comment above.
        connected: radioConnected,
      },
      // Null whenever GPS_PORT isn't set at all - same "not configured"
      // signal getBaseGpsFix/getBaseGpsSurveyStatus already use, so the
      // dashboard can show which port it's trying even before any fix has
      // actually arrived (see renderBaseGpsCard).
      baseGpsPort: process.env.GPS_PORT ? { port: config.gps.port, baud: config.gps.baud } : null,
      // Whether the serial port is actually open right now - independent
      // of baseGpsFix below, which just holds the last fix received and
      // has no way on its own to show a lost connection (see
      // currentGpsPort's own comment - same variable setBaseGpsSurveyIn/
      // setBaseGpsFixed already rely on to know whether they can send a
      // command). null when GPS_PORT isn't set at all, same
      // not-applicable convention as radio.connected above.
      baseGpsConnected: process.env.GPS_PORT ? !!currentGpsPort : null,
      baseGpsFix: getBaseGpsFix(),
      baseGpsSurvey: getBaseGpsSurveyStatus(),
      webhook: {
        enabled: config.regattaup.enabled,
        queueReady: !!lapWebhookQueue,
      },
      regatta: await getRegattaStatus(),
    };
  }

  // Deliberately separate from getFullStats above - the map's live-refresh
  // loop (see adminServer.js's renderMap) only ever needs each boat's
  // last in-memory position, not the full dashboard snapshot, so this
  // stays synchronous and never touches Redis. Polling this every 5s from
  // however many browser tabs have the map open shouldn't cost a round
  // trip to Redis Cloud each time just to throw away everything but
  // lastPosition/lastSeen.
  function getBoatPositions() {
    const { boats } = stats.snapshot();
    const positions = {};
    for (const [boatId, b] of Object.entries(boats)) {
      if (b.lastPosition) positions[boatId] = { lastPosition: b.lastPosition, lastSeen: b.lastSeen };
    }
    return positions;
  }

  // Returns null - never throws - whenever there's nothing to report: no
  // GPS_PORT configured at all (the overwhelmingly common case; most
  // base stations have no GPS hardware attached), or configured but no
  // fix received yet. The admin map's GPS readout/recenter button (see
  // adminServer.js's renderMap) treats null as "not available" and says
  // so, not an error. Includes every NAV-PVT field this app decodes (see
  // ubxParser.js's _decodePvt), not just lat/lon/fix-quality - the main
  // dashboard's "Base GPS" card (see adminServer.js's renderBaseGpsCard)
  // shows the fuller picture; the map's lighter readout just ignores the
  // extra fields it doesn't use.
  function getBaseGpsFix() {
    if (!baseGpsFix) return null;
    return {
      lat: baseGpsFix.lat,
      lon: baseGpsFix.lon,
      timestamp: baseGpsFix.timestamp,
      carrSoln: baseGpsFix.carrSoln,
      gnssFixOk: baseGpsFix.gnssFixOk,
      fixType: baseGpsFix.fixType,
      numSV: baseGpsFix.numSV,
      hAccMm: baseGpsFix.hAccMm,
      vAccMm: baseGpsFix.vAccMm,
      heightMm: baseGpsFix.heightMm,
      hMSLMm: baseGpsFix.hMSLMm,
      pDOP: baseGpsFix.pDOP,
      gSpeedMmS: baseGpsFix.gSpeedMmS,
      headMotDeg: baseGpsFix.headMotDeg,
      utcValid: baseGpsFix.utcValid,
      utcYear: baseGpsFix.utcYear,
      utcMonth: baseGpsFix.utcMonth,
      utcDay: baseGpsFix.utcDay,
      utcHour: baseGpsFix.utcHour,
      utcMin: baseGpsFix.utcMin,
      utcSec: baseGpsFix.utcSec,
    };
  }

  // Same null-means-not-available contract as getBaseGpsFix, but for the
  // TMODE3/survey-in status - reported separately since a base can have a
  // perfectly good ordinary GPS fix (baseGpsFix) while TMODE3 itself is
  // still disabled, mid-survey, or never polled yet. modeText is a plain
  // label the UI can show directly, since 0/1/2 means nothing to an
  // operator glancing at the dashboard.
  function getBaseGpsSurveyStatus() {
    if (!baseGpsTmode3 && !baseGpsSvin) return null;
    return {
      mode: baseGpsTmode3 ? baseGpsTmode3.mode : null,
      modeText: baseGpsTmode3 ? TMODE3_MODE_NAMES[baseGpsTmode3.mode] || 'unknown' : null,
      tmode3Timestamp: baseGpsTmode3 ? baseGpsTmode3.timestamp : null,
      // The targets THIS APP last asked for via setBaseGpsSurveyIn (see
      // config.gps.svinMinDurS/svinAccLimitMm) - not read back from the
      // receiver itself (TMODE3's poll response doesn't echo them), so
      // this reflects our own request, not necessarily whatever an
      // operator may have separately configured via u-center. Given
      // alongside survey.durationS/meanAccMm below so the UI can show
      // progress against the actual finish line, not just raw numbers -
      // survey-in only completes once duration clears configuredMinDurS
      // AND accuracy drops to or below configuredAccLimitMm, whichever
      // takes longer.
      configuredMinDurS: config.gps.svinMinDurS,
      configuredAccLimitMm: config.gps.svinAccLimitMm,
      // Only meaningful once mode is actually 2 (fixed) - the poll
      // response echoes back whatever position it's fixed to (see
      // ubxParser.js's _decodeTmode3), whether this app set it (via
      // setBaseGpsFixed) or it was configured some other way, e.g.
      // u-center, before this app ever connected.
      fixedPosition:
        baseGpsTmode3 && baseGpsTmode3.mode === 2 && baseGpsTmode3.lat != null
          ? {
              lat: baseGpsTmode3.lat,
              lon: baseGpsTmode3.lon,
              heightM: baseGpsTmode3.heightM,
              fixedPosAccMm: baseGpsTmode3.fixedPosAccMm,
            }
          : null,
      survey: baseGpsSvin
        ? {
            active: baseGpsSvin.active,
            valid: baseGpsSvin.valid,
            durationS: baseGpsSvin.durationS,
            observations: baseGpsSvin.observations,
            meanAccMm: baseGpsSvin.meanAccMm,
            lat: baseGpsSvin.lat,
            lon: baseGpsSvin.lon,
            heightM: baseGpsSvin.heightM,
            timestamp: baseGpsSvin.timestamp,
          }
        : null,
    };
  }

  // Re-polls TMODE3 shortly after a SET command - the receiver doesn't
  // announce its new config on its own, and the operator clicking a mode
  // button wants to see it take effect, not wait up to 15s for the next
  // scheduled poll (see openBaseGps above).
  function requestTmode3Refresh() {
    setTimeout(() => {
      if (currentGpsPort) currentGpsPort.write(encodePollRequest(CLASS_CFG, ID_CFG_TMODE3));
    }, 500);
  }

  // Switches the base GPS into survey-in mode - see the admin dashboard's
  // "Start survey-in" button. Also the right call to REstart a survey (e.g.
  // conditions changed, or an operator wants a fresh/longer one) - TMODE3
  // has no separate "restart" command, sending the same SET again is how
  // u-blox receivers do it.
  function setBaseGpsSurveyIn() {
    if (!currentGpsPort) throw new Error('base GPS not connected');
    currentGpsPort.write(
      encodeSetTmode3({ mode: 1, svinMinDurS: config.gps.svinMinDurS, svinAccLimitMm: config.gps.svinAccLimitMm })
    );
    requestTmode3Refresh();
  }

  // Locks the base GPS to a fixed reference position - see the admin
  // dashboard's "Use as fixed position" button and the manual-entry form
  // beside it. manualPos, when given, is an operator-typed {lat, lon,
  // heightM, fixedPosAccMm} - e.g. a club's own previously-surveyed
  // benchmark position, which is more trustworthy than anything this app
  // can measure itself. Re-validated here even though the dashboard's own
  // form already checks ranges client-side, since this reconfigures RTK
  // corrections for every boat and a request could reach this function by
  // some other path than that form. Without manualPos, prefers the
  // completed survey-in's own mean position (what an operator normally
  // wants: survey in, then lock to the result) but falls back to whatever
  // ordinary fix the base currently has if no valid survey-in result
  // exists yet - still useful for bench testing, though nowhere near
  // RTK-base-grade precision that way (an ordinary nav fix's own accuracy,
  // not an averaged one).
  function setBaseGpsFixed(manualPos) {
    if (!currentGpsPort) throw new Error('base GPS not connected');
    let pos;
    if (manualPos) {
      const { lat, lon, heightM } = manualPos;
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error('lat must be a number between -90 and 90');
      if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error('lon must be a number between -180 and 180');
      if (!Number.isFinite(heightM) || heightM < -500 || heightM > 9000) throw new Error('height must be a number between -500 and 9000 meters');
      pos = manualPos;
    } else {
      pos =
        baseGpsSvin && baseGpsSvin.valid
          ? { lat: baseGpsSvin.lat, lon: baseGpsSvin.lon, heightM: baseGpsSvin.heightM, fixedPosAccMm: baseGpsSvin.meanAccMm }
          : baseGpsFix
          ? { lat: baseGpsFix.lat, lon: baseGpsFix.lon, heightM: baseGpsFix.heightMm / 1000, fixedPosAccMm: baseGpsFix.hAccMm }
          : null;
    }
    if (!pos) throw new Error('no base GPS position available yet to fix to');
    currentGpsPort.write(encodeSetTmode3({ mode: 2, ...pos }));
    requestTmode3Refresh();
  }

  // Persists whatever TMODE3 mode is CURRENTLY active (survey-in or fixed,
  // set moments ago or long since) to the receiver's own non-volatile
  // storage, so it's still set that way after a power cycle - see the
  // admin dashboard's own "Save config" button and encodeSaveConfig's own
  // comment for why this is a separate, explicit action rather than
  // automatic: setBaseGpsSurveyIn/setBaseGpsFixed above only ever change
  // the receiver's live RAM config on their own.
  function saveBaseGpsConfig() {
    if (!currentGpsPort) throw new Error('base GPS not connected');
    currentGpsPort.write(encodeSaveConfig());
  }

  startAdminServer({
    port: config.admin.port,
    getStats: getFullStats,
    getPositions: getBoatPositions,
    setMark: setMarkLocation,
    setPinBoundaryEnabled,
    pingFleet,
    selectRegatta,
    getBaseGps: getBaseGpsFix,
    getBaseGpsSurvey: getBaseGpsSurveyStatus,
    setBaseGpsSurveyIn,
    setBaseGpsFixed,
    saveBaseGpsConfig,
  });

  if (config.simulate) {
    console.log(`[baseStation] SIMULATE=1 - listening for sim radio frames on UDP :${config.sim.port}`);
  } else if (config.radio.enabled) {
    // Always logs the deferred form here - this line runs synchronously,
    // before the async regatta-resolution flow below has had any chance to
    // select one yet (see systemStarted's own comment), so it's never
    // actually already connected at this exact point.
    console.log(`[baseStation] radio ${config.radio.port} @ ${config.radio.baud} configured - will connect once a regatta is selected`);
  } else {
    console.log('[baseStation] Radio disabled (RADIO_ENABLED=0) - no frames will arrive, other outputs still testable');
  }
  console.log(`[baseStation] logging to ${csvPath}`);
  console.log(
    `[baseStation] recording fixes to Redis at ${
      config.redis.url || `${config.redis.connection.host}:${config.redis.connection.port}`
    }`
  );
  console.log(
    `[baseStation] broadcasting ${config.localBroadcast.format.toUpperCase()} over UDP ${UDP_BROADCAST_ADDR}:${UDP_PORT}`
  );
  console.log(
    config.regattaup.enabled
      ? `[baseStation] lap crossings post to RegattaUp at ${config.regattaup.webhookUrl}`
      : '[baseStation] RegattaUp lap webhook disabled (REGATTAUP_WEBHOOK_ENABLED=0)'
  );
  if (config.regattaup.enabled) {
    console.log(`[baseStation] on-grid zone: ${config.regattaup.onGridZoneM}m behind the pin<->committeeStart line`);
    console.log(
      config.regattaup.markRoundingEnabled
        ? `[baseStation] mark roundings post to RegattaUp (gate extends ${config.regattaup.markRoundingExtensionM}m beyond each mark)`
        : '[baseStation] mark-rounding webhook disabled (set REGATTAUP_MARK_ROUNDING_ENABLED=1 to enable)'
    );
    console.log(
      config.regattaup.foulEnabled
        ? '[baseStation] fouls (downwind start/finish line crossings, committee gap, pin boundary gate if on) post to RegattaUp'
        : '[baseStation] foul webhook disabled (set REGATTAUP_FOUL_ENABLED=1 to enable)'
    );
  }
}

// Counts the lap with RegattaUp (see https://regattaup.com) - boatId is
// supplied as tranCode (matched against the transponder code configured for
// that boat's class entry there), and the lap's own timestamp becomes
// rtcTime (already stored in the queue as microseconds). `mode: 'lap'` is
// sent explicitly even though the webhook already defaults to it when the
// field is missing entirely (real third-party MyLaps hardware has no
// concept of mode and will never send one) - explicit here just means our
// own three event types (lap/ongrid/mark) are never distinguished by
// *absence* of a field, only by its value. Also includes `regatta_id`
// (module-level currentRegattaId, kept in sync with main()'s own
// selectedRegatta - see its own comment) whenever a regatta is selected, so
// mylapsWebhook/entry.ts can read straight from that one regatta's own Redis
// cache instead of enumerating every active regatta on the platform - real
// MyLaps hardware has no such field and never sends one, so the webhook
// falls back to that enumeration exactly as before when it's absent (no
// regatta selected, e.g. SIMULATE=1 testing). Every attempt (success or
// failure) is recorded on the row so dueForRetry's backoff stays accurate;
// the row is only removed once RegattaUp actually accepts it - a failure
// just leaves it queued for the next retry, logged but not thrown further,
// matching this app's "a webhook hiccup shouldn't affect any other output"
// philosophy elsewhere.
async function sendQueuedLap(queue, row) {
  queue.recordAttempt(row.id);
  const payload = {
    mode: 'lap',
    ...(currentRegattaId ? { regatta_id: currentRegattaId } : {}),
    decoded: {
      tranCode: String(row.boat_id),
      rtcTime: row.rtc_time,
      strength: row.strength,
    },
  };
  try {
    const res = await fetch(config.regattaup.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    queue.remove(row.id);
    console.log(`[regattaup] lap webhook sent for boat=${row.boat_id} lap=${row.lap}`);
  } catch (err) {
    console.error(
      orange(`[regattaup] webhook failed for boat=${row.boat_id} lap=${row.lap} (attempt ${row.attempts + 1}), will retry: ${err.message}`)
    );
  }
}

// Tells RegattaUp a boat is (still) on the grid or has left it (see
// onGridWatcher.js) - same tranCode/rtcTime/strength conventions as
// sendQueuedLap above (see its own comment on why mode is always explicit),
// and the exact same retry/removal semantics, just with `mode` set to
// 'ongrid'/'offgrid' instead of 'lap'.
async function sendQueuedOnGrid(queue, row) {
  queue.recordAttempt(row.id);
  const payload = {
    mode: row.mode,
    ...(currentRegattaId ? { regatta_id: currentRegattaId } : {}),
    decoded: {
      tranCode: String(row.boat_id),
      rtcTime: row.rtc_time,
      strength: row.strength,
    },
  };
  try {
    const res = await fetch(config.regattaup.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    queue.remove(row.id);
    console.log(`[regattaup] ${row.mode} webhook sent for boat=${row.boat_id}`);
  } catch (err) {
    console.error(
      orange(`[regattaup] ${row.mode} webhook failed for boat=${row.boat_id} (attempt ${row.attempts + 1}), will retry: ${err.message}`)
    );
  }
}

// Tells RegattaUp a boat rounded a mark (see markRoundingWatcher.js) - same
// tranCode/rtcTime/strength conventions and retry/removal semantics as
// sendQueuedOnGrid above, with `mode: 'mark'` and which mark (row.mark, e.g.
// 'windwardGreen') was rounded.
async function sendQueuedMarkRounding(queue, row) {
  queue.recordAttempt(row.id);
  const payload = {
    mode: 'mark',
    mark: row.mark,
    ...(currentRegattaId ? { regatta_id: currentRegattaId } : {}),
    decoded: {
      tranCode: String(row.boat_id),
      rtcTime: row.rtc_time,
      strength: row.strength,
    },
  };
  try {
    const res = await fetch(config.regattaup.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    queue.remove(row.id);
    console.log(`[regattaup] mark webhook sent for boat=${row.boat_id} mark=${row.mark}`);
  } catch (err) {
    console.error(
      orange(`[regattaup] mark webhook failed for boat=${row.boat_id} mark=${row.mark} (attempt ${row.attempts + 1}), will retry: ${err.message}`)
    );
  }
}

// Tells RegattaUp a boat fouled (see foulWatcher.js) - same tranCode/
// rtcTime/strength conventions and retry/removal semantics as
// sendQueuedMarkRounding above, with `mode: 'foul'` and which foul
// (row.reason, e.g. 'downwind finish line') occurred.
async function sendQueuedFoul(queue, row) {
  queue.recordAttempt(row.id);
  const payload = {
    mode: 'foul',
    reason: row.reason,
    ...(currentRegattaId ? { regatta_id: currentRegattaId } : {}),
    decoded: {
      tranCode: String(row.boat_id),
      rtcTime: row.rtc_time,
      strength: row.strength,
    },
  };
  try {
    const res = await fetch(config.regattaup.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    queue.remove(row.id);
    console.log(orange(`[regattaup] foul webhook sent for boat=${row.boat_id} reason=${row.reason}`, process.stdout));
  } catch (err) {
    console.error(
      orange(`[regattaup] foul webhook failed for boat=${row.boat_id} reason=${row.reason} (attempt ${row.attempts + 1}), will retry: ${err.message}`)
    );
  }
}
