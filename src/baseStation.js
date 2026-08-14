const config = require('./config');
const protocol = require('./protocol');
const { RadioLink } = require('./radioLink');
const { RedisStore } = require('./redisStore');
const { distanceMeters, COURSE_LENGTH_M, LONG_COURSE_EXTRA_M, MARK_NAMES } = require('./course');
const { FinishLineWatcher } = require('./finishLineWatcher');
const { LapWebhookQueue } = require('./lapWebhookQueue');
const { OnGridWatcher } = require('./onGridWatcher');
const { OnGridWebhookQueue } = require('./onGridWebhookQueue');
const { MarkRoundingWatcher } = require('./markRoundingWatcher');
const { MarkRoundingWebhookQueue } = require('./markRoundingWebhookQueue');
const { pruneOldLogs } = require('./logRotation');
const { startUploadServer, detectLocalIp, scanUploadDir } = require('./uploadServer');
const { startAdminServer } = require('./adminServer');
const stats = require('./stats');
const { SerialPort } = require('serialport');
const { UbxParser, encodePollRequest, encodeSetTmode3, TMODE3_MODE_NAMES, CLASS_CFG, ID_CFG_TMODE3 } = require('./ubxParser');
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
//
// Lap detection also lives here (see finishLineWatcher.js), not on the
// boat: a real rover has no Redis access to resolve course marks itself, so
// it only ever sends its raw position - this is the one place that already
// has both the marks and every boat's fixes, so it's the only place that
// can watch for a finish-line crossing.

// Which mark pairs with which "other mark" to define its rounding gate's
// axis (see markRoundingWatcher.js) - one MarkRoundingWatcher per boat per
// entry. Green and black windward/leeward marks are colinear on the same
// axis (see course.js's getMarks), so both windward marks pair with
// leewardGreen and both leeward marks pair with windwardGreen; which pair
// is actually near a given boat is just whichever course it's sailing.
//
// `outerMark`, where present, is the mark that sits further out on that
// same axis, beyond `mark` - windwardBlack beyond windwardGreen,
// leewardBlack beyond leewardGreen (see course.js's own comment: green is
// always the inner, short-course pair). Only the inner (green) marks have
// one; windwardBlack/leewardBlack are the outermost marks on the course,
// nothing sits beyond them to worry about reaching. Used below to cap the
// green gate's forward extension short of the black mark's own position -
// see markRoundingWatchersFor's OUTER_MARK_SAFETY_FRACTION comment for why
// that cap has to hold regardless of how markRoundingExtensionM is
// configured.
const MARK_ROUNDING_GATES = [
  { mark: 'windwardGreen', otherMark: 'leewardGreen', outerMark: 'windwardBlack' },
  { mark: 'windwardBlack', otherMark: 'leewardGreen' },
  { mark: 'leewardGreen', otherMark: 'windwardGreen', outerMark: 'leewardBlack' },
  { mark: 'leewardBlack', otherMark: 'windwardGreen' },
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
  let radio;
  // Tracked alongside the radio object itself so the dashboard's "Radio
  // frames" card (see adminServer.js) can show which port/mode is actually
  // in play, not just the frame/error counters - useful for confirming
  // this process picked up the port you expected, especially with
  // SIMULATE=1 or NO_RADIO=1 around to override the default.
  const radioMode = config.simulate ? 'simulated' : config.radio.enabled ? 'real' : 'none';
  if (config.simulate) {
    const { SimRadioLink } = require('./simRadioLink');
    radio = new SimRadioLink({ port: config.sim.port });
  } else if (config.radio.enabled) {
    radio = new RadioLink({ port: config.radio.port, baud: config.radio.baud });
  } else {
    radio = new EventEmitter(); // NO_RADIO=1 - never emits 'frame'/'marks', other outputs still testable
    radio.send = () => false;
    radio.broadcast = () => false;
  }
  radio.on('error', (err) => console.error('[radio] error:', err.message));
  radio.on('disconnected', () => console.warn('[radio] disconnected, retrying...'));

  // Surfaced on the dashboard (see adminServer.js's "Radio frames" card) so
  // a lost connection actually shows as lost, rather than the card just
  // quietly freezing on whatever counters it last had - the values
  // themselves staying put is fine (this is a live view, not something
  // that needs to guess "still true" vs "last known"), but there needs to
  // be SOME live signal distinguishing "still connected" from "was
  // connected." Only 'real' mode has an actual disconnect concept - a
  // SimRadioLink's UDP socket, once bound, doesn't have a serial-port-style
  // physical disconnect to track, and 'none' (NO_RADIO=1) has no
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
    (function openBaseGps() {
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
          console.log(
            `[baseGps] ${pvt.lat.toFixed(6)},${pvt.lon.toFixed(6)} ` +
              `fixType=${pvt.fixType} diffSoln=${pvt.diffSoln} carrSoln=${pvt.carrSoln} numSV=${pvt.numSV} ` +
              `hAcc=${(pvt.hAccMm / 1000).toFixed(2)}m`
          );
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
    })();
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
  startUploadServer({ port: config.upload.port, uploadDir: config.upload.dir });

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

  const udpSocket = dgram.createSocket('udp4');
  const UDP_BROADCAST_ADDR = process.env.UDP_BROADCAST_ADDR || '255.255.255.255';
  const UDP_PORT = parseInt(process.env.UDP_PORT || '10110', 10); // 10110 is the conventional NMEA-over-UDP port
  udpSocket.bind(() => udpSocket.setBroadcast(true));

  const redisStore = new RedisStore({
    url: config.redis.url,
    connection: config.redis.connection,
    minMovementM: config.redis.minMovementM,
  });

  // Sends whatever raceMarks currently holds to every boat right now (as
  // opposed to the periodic heartbeat below, which is just "in case a
  // broadcast got missed") - called the instant marks first resolve, so a
  // boat isn't left waiting out a full MARKS_BROADCAST_INTERVAL_MS before
  // hearing about a course that's already known. Works the same way over a
  // real radio or SimRadioLink in SIMULATE mode - both just broadcast, no
  // per-boat addressing at this layer at all (see simRadioLink.js).
  function broadcastMarksNow() {
    if (!raceMarks) return;
    radio.broadcast(protocol.encodeMarks(raceMarks, { ip: baseIp, port: config.upload.port, adminPort: config.admin.port }));
    console.log(
      `[baseStation] ${new Date().toISOString()} broadcast course marks to all boats: ${Object.keys(raceMarks).join(', ')}`
    );
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
    // Existing finish-line watchers cached committee/finish's position at
    // whatever it was when a given boat's first fix arrived (see
    // watcherFor below) - clear so every boat's watcher rebuilds fresh
    // from the corrected marks on its next fix, rather than silently
    // keeping stale gate geometry for the rest of the race. Same reasoning
    // for on-grid watchers (pin/committee) and mark-rounding watchers
    // (every windward/leeward mark), regardless of which specific mark was
    // actually edited - simplest to always clear all three.
    finishLineWatchers.clear();
    onGridWatchers.clear();
    markRoundingWatchers.clear();
    broadcastMarksNow();
    return raceMarks;
  }

  // Course marks - windward, leeward, and the pin/committee ends of the
  // start/finish line (same geometry the simulator uses, see course.js). In
  // SIMULATE mode, computes+publishes them if missing (whichever process -
  // this one, or a boat simulator - asks Redis first defines the course for
  // everyone after it); for real hardware, only reads whatever a race
  // operator has actually published (getMarks(), not getOrCreateMarks() -
  // this app has no business inventing a real course). Either way, once
  // committee+finish are known, raceMarks below is what builds a
  // FinishLineWatcher per boat.
  let raceMarks = null;

  async function resolveMarks() {
    if (config.simulate) {
      // getOrCreateMarks otherwise has no way to tell "marks exist" from
      // "marks exist but are for a different course length/center" - if
      // SIM_COURSE_LENGTH_NM/SIM_CENTER_LAT/SIM_CENTER_LON is set AND the
      // course actually published in Redis doesn't match it, clear so it
      // gets recomputed. Deliberately NOT just "is the env var set" - those
      // vars normally stay set for a whole shell/testing session (or live
      // in .env), so that check alone would re-clear+rebroadcast on every
      // single restart even when nothing was actually asked to change,
      // including a stale/duplicate base process starting up later with
      // the same environment - exactly what looks like "something cleared
      // the course out from under me" from the outside. Comparing against
      // what's actually there makes this idempotent: same request, same
      // result, no matter how many times or which process asks.
      try {
        const existing = await redisStore.getMarks();
        const hasExisting = MARK_NAMES.every((name) => existing[name]);
        const centerMatches =
          hasExisting &&
          distanceMeters(existing.leewardGreen, { lat: config.sim.centerLat, lon: config.sim.centerLon }) < 0.1;
        const lengthMatches =
          hasExisting && Math.abs(distanceMeters(existing.leewardGreen, existing.windwardGreen) - COURSE_LENGTH_M) < 0.1;
        const longCourseMatches =
          hasExisting &&
          Math.abs(distanceMeters(existing.windwardGreen, existing.windwardBlack) - LONG_COURSE_EXTRA_M) < 0.1;
        const requestedChange = ['SIM_COURSE_LENGTH_NM', 'SIM_CENTER_LAT', 'SIM_CENTER_LON', 'SIM_LONG_COURSE_EXTRA_NM'].some(
          (name) => process.env[name] !== undefined
        );
        if (requestedChange && !(centerMatches && lengthMatches && longCourseMatches)) {
          await redisStore.clearCourseMarks();
          console.log('[baseStation] requested course differs from what\'s published - cleared old marks so they get recomputed');
        }
      } catch (err) {
        console.error('[redis] failed to check/clear old course marks:', err.message);
      }
      try {
        const marks = await redisStore.getOrCreateMarks(config.sim.centerLat, config.sim.centerLon);
        console.log(`[baseStation] course marks (Redis): ${Object.keys(marks).join(', ')}`);
        return marks;
      } catch (err) {
        console.error('[redis] failed to resolve marks:', err.message);
        return null;
      }
    } else {
      try {
        const marks = await redisStore.getMarks();
        if (marks.committee && marks.finish) {
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

  // Real-hardware marks might not be in Redis yet at startup (an operator
  // setting up the course after the base is already running is a normal
  // sequence, not an error) - keeps trying every few seconds instead of
  // giving up after one look, so the moment they do show up, this picks
  // them up and broadcasts immediately rather than waiting for the base to
  // be restarted.
  (async () => {
    while (!raceMarks) {
      raceMarks = await resolveMarks();
      if (raceMarks) {
        broadcastMarksNow();
      } else {
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
  // state per boat, built once raceMarks has pin/committee/finish AND
  // windwardGreen/leewardGreen (needed for the watcher's own starboard-tack
  // exclusion corridor - see its module comment).
  const onGridWatchers = new Map();
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
      if (!watcher && raceMarks[gate.mark] && raceMarks[gate.otherMark]) {
        let extensionM = config.regattaup.markRoundingExtensionM;
        if (gate.outerMark && raceMarks[gate.outerMark]) {
          const outerDistM = distanceMeters(raceMarks[gate.mark], raceMarks[gate.outerMark]);
          extensionM = Math.min(extensionM, outerDistM * OUTER_MARK_SAFETY_FRACTION);
        }
        watcher = new MarkRoundingWatcher(raceMarks[gate.mark], raceMarks[gate.otherMark], extensionM);
        markRoundingWatchers.set(key, watcher);
      }
      return watcher && { mark: gate.mark, watcher };
    }).filter(Boolean);
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
      console.log(`[baseStation] lap webhook queue ready at ${config.regattaup.queueDbPath}`);
      for (const lap of bufferedLaps) enqueueLap(lap);
      bufferedLaps = [];
      setInterval(() => retryQueuedLaps(lapWebhookQueue), config.regattaup.retryIntervalMs);
    } catch (err) {
      console.error('[regattaup] failed to initialize lap webhook queue:', err.message);
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
      console.log(`[baseStation] on-grid webhook queue ready at ${config.regattaup.onGridQueueDbPath}`);
      for (const event of bufferedOnGrid) enqueueOnGrid(event);
      bufferedOnGrid = [];
      setInterval(() => retryQueuedOnGrid(onGridWebhookQueue), config.regattaup.retryIntervalMs);
    } catch (err) {
      console.error('[regattaup] failed to initialize on-grid webhook queue:', err.message);
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
      console.log(`[baseStation] mark-rounding webhook queue ready at ${config.regattaup.markRoundingQueueDbPath}`);
      for (const event of bufferedMarkRoundings) enqueueMarkRounding(event);
      bufferedMarkRoundings = [];
      setInterval(() => retryQueuedMarkRoundings(markRoundingWebhookQueue), config.regattaup.retryIntervalMs);
    } catch (err) {
      console.error('[regattaup] failed to initialize mark-rounding webhook queue:', err.message);
    }
  })();

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

  radio.on('frame', (decoded) => {
    stats.recordFrame(decoded.boatId, { lat: decoded.lat, lon: decoded.lon });
    logToConsole(decoded);
    logToCsv(decoded);
    redisStore.recordFix(decoded, new Date()).catch((err) => console.error('[redis] write failed:', err.message));
    outputFrame(decoded); // <- swap/extend this for your actual race software

    const now = Date.now();
    const lastSeen = lastSeenByBoat.get(decoded.boatId);
    if (lastSeen === undefined || now - lastSeen > BOAT_RECONNECT_GAP_MS) {
      broadcastMarksNow();
    }
    lastSeenByBoat.set(decoded.boatId, now);

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
      console.log(`[baseStation] boat=${decoded.boatId} ${label} the start grid`);
      if (config.regattaup.enabled) {
        const event = {
          boatId: decoded.boatId,
          mode: onGridMode,
          rtcTime: decoded.timestamp * 1000, // ms -> microseconds
          receivedAt: new Date().toISOString(),
        };
        if (onGridWebhookQueue) enqueueOnGrid(event);
        else bufferedOnGrid.push(event);
      }
    }

    for (const { mark, watcher } of markRoundingWatchersFor(decoded.boatId)) {
      const rounding = watcher.check(decoded.lat, decoded.lon, decoded.timestamp);
      if (!rounding) continue;
      console.log(`[baseStation] boat=${decoded.boatId} rounded ${mark} - rounding ${rounding.rounding}`);
      if (config.regattaup.enabled && config.regattaup.markRoundingEnabled) {
        const event = {
          boatId: decoded.boatId,
          mark,
          rtcTime: rounding.crossingTime * 1000, // ms -> microseconds
          receivedAt: new Date().toISOString(),
        };
        if (markRoundingWebhookQueue) enqueueMarkRounding(event);
        else bufferedMarkRoundings.push(event);
      }
    }
  });

  // Durably records the lap (see lapWebhookQueue.js's module comment for
  // why) before making the first send attempt.
  function enqueueLap(lap) {
    const id = lapWebhookQueue.enqueue(lap);
    sendQueuedLap(lapWebhookQueue, lapWebhookQueue.get(id));
  }

  // Retries whatever's due (see LapWebhookQueue.dueForRetry's backoff) -
  // covers both a failed immediate attempt and a lap that was enqueued but
  // never got its first attempt at all (e.g. the process crashed in
  // between).
  function retryQueuedLaps(queue) {
    for (const row of queue.dueForRetry(config.regattaup.maxBackoffMs)) {
      sendQueuedLap(queue, row);
    }
  }

  // Same pattern as enqueueLap/retryQueuedLaps above, for on-grid events.
  function enqueueOnGrid(event) {
    const id = onGridWebhookQueue.enqueue(event);
    sendQueuedOnGrid(onGridWebhookQueue, onGridWebhookQueue.get(id));
  }

  function retryQueuedOnGrid(queue) {
    for (const row of queue.dueForRetry(config.regattaup.maxBackoffMs)) {
      sendQueuedOnGrid(queue, row);
    }
  }

  // Same pattern again, for mark-rounding events.
  function enqueueMarkRounding(event) {
    const id = markRoundingWebhookQueue.enqueue(event);
    sendQueuedMarkRounding(markRoundingWebhookQueue, markRoundingWebhookQueue.get(id));
  }

  function retryQueuedMarkRoundings(queue) {
    for (const row of queue.dueForRetry(config.regattaup.maxBackoffMs)) {
      sendQueuedMarkRounding(queue, row);
    }
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
  // input format/protocol. Currently emits a standard NMEA GGA sentence over
  // UDP broadcast, which some tracking tools can ingest directly. ---
  function outputFrame(d) {
    const sentence = toGGA(d);
    const buf = Buffer.from(sentence + '\r\n');
    udpSocket.send(buf, UDP_PORT, UDP_BROADCAST_ADDR);
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
      base: {
        ip: baseIp,
        uploadPort: config.upload.port,
        adminPort: config.admin.port,
        redisConnected: redisStore.isConnected(),
      },
      course: raceMarks ? { marks: raceMarks, boatsKnown: lastSeenByBoat.size } : null,
      lapCounts,
      redis: redisStats,
      // Merged onto snapshot.radio's own {framesReceived, syncErrors} -
      // port is a plain serial path in 'real' mode, or the UDP port
      // SimRadioLink actually listens on in 'simulated' mode (no baud
      // there, it isn't a serial connection); both null in 'none' mode
      // (NO_RADIO=1).
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

  startAdminServer({
    port: config.admin.port,
    getStats: getFullStats,
    getPositions: getBoatPositions,
    setMark: setMarkLocation,
    getBaseGps: getBaseGpsFix,
    getBaseGpsSurvey: getBaseGpsSurveyStatus,
    setBaseGpsSurveyIn,
    setBaseGpsFixed,
  });

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
  console.log(
    config.regattaup.enabled
      ? `[baseStation] lap crossings post to RegattaUp at ${config.regattaup.webhookUrl}`
      : '[baseStation] RegattaUp lap webhook disabled (REGATTAUP_WEBHOOK_DISABLED=1)'
  );
  if (config.regattaup.enabled) {
    console.log(`[baseStation] on-grid zone: ${config.regattaup.onGridZoneM}m either side of the pin<->committee line`);
    console.log(
      config.regattaup.markRoundingEnabled
        ? `[baseStation] mark roundings post to RegattaUp (gate extends ${config.regattaup.markRoundingExtensionM}m beyond each mark)`
        : '[baseStation] mark-rounding webhook disabled (set REGATTAUP_MARK_ROUNDING_ENABLED=1 to enable)'
    );
  }
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

// Counts the lap with RegattaUp (see https://regattaup.com) - boatId is
// supplied as tranCode (matched against the transponder code configured for
// that boat's class entry there), and the lap's own timestamp becomes
// rtcTime (already stored in the queue as microseconds). Every attempt
// (success or failure) is recorded on the row so dueForRetry's backoff
// stays accurate; the row is only removed once RegattaUp actually accepts
// it - a failure just leaves it queued for the next retry, logged but not
// thrown further, matching this app's "a webhook hiccup shouldn't affect
// any other output" philosophy elsewhere.
async function sendQueuedLap(queue, row) {
  queue.recordAttempt(row.id);
  const payload = {
    decoded: {
      tranCode: String(row.boat_id),
      rtcTime: row.rtc_time,
      strength: row.strength,
    },
    receivedAt: row.received_at,
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
      `[regattaup] webhook failed for boat=${row.boat_id} lap=${row.lap} (attempt ${row.attempts + 1}), will retry:`,
      err.message
    );
  }
}

// Tells RegattaUp a boat is (still) on the grid or has left it (see
// onGridWatcher.js) - same tranCode/rtcTime conventions as sendQueuedLap
// above, and the exact same retry/removal semantics, just posting to the
// same webhook URL with `mode` instead of a lap number.
async function sendQueuedOnGrid(queue, row) {
  queue.recordAttempt(row.id);
  const payload = {
    mode: row.mode,
    decoded: {
      tranCode: String(row.boat_id),
      rtcTime: row.rtc_time,
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
      `[regattaup] ${row.mode} webhook failed for boat=${row.boat_id} (attempt ${row.attempts + 1}), will retry:`,
      err.message
    );
  }
}

// Tells RegattaUp a boat rounded a mark (see markRoundingWatcher.js) - same
// tranCode/rtcTime conventions and retry/removal semantics as
// sendQueuedOnGrid above, posting to the same webhook URL with mode 'mark'
// and which mark (row.mark, e.g. 'windwardGreen') was rounded.
async function sendQueuedMarkRounding(queue, row) {
  queue.recordAttempt(row.id);
  const payload = {
    mode: 'mark',
    mark: row.mark,
    decoded: {
      tranCode: String(row.boat_id),
      rtcTime: row.rtc_time,
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
      `[regattaup] mark webhook failed for boat=${row.boat_id} mark=${row.mark} (attempt ${row.attempts + 1}), will retry:`,
      err.message
    );
  }
}
