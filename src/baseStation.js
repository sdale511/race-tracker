const config = require('./config');
const { RadioLink } = require('./radioLink');
const { RedisStore } = require('./redisStore');
const { FinishLineWatcher } = require('./finishLineWatcher');
const { LapWebhookQueue } = require('./lapWebhookQueue');
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

if (config.testLap) {
  console.log(
    `[baseStation] TEST_LAP=1 - sending a single test lap (${config.testLapNumber}) for boat ${config.testLapBoatId} and exiting`
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
  radio.on('sync-error', () => syncErrors++);
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
  const csvPath = path.join(logDir, 'base_station_received.csv');
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, 'received_iso,boat_id,fix_time_iso,lat,lon,speed_kn,heading_deg,fix_ok,carr_soln,num_sv\n');
  }

  const udpSocket = dgram.createSocket('udp4');
  const UDP_BROADCAST_ADDR = process.env.UDP_BROADCAST_ADDR || '255.255.255.255';
  const UDP_PORT = parseInt(process.env.UDP_PORT || '10110', 10); // 10110 is the conventional NMEA-over-UDP port
  udpSocket.bind(() => udpSocket.setBroadcast(true));

  const redisStore = new RedisStore({
    url: config.redis.url,
    connection: config.redis.connection,
    minMovementM: config.redis.minMovementM,
  });

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
  (async () => {
    if (config.simulate) {
      // getOrCreateMarks otherwise has no way to tell "marks exist" from
      // "marks exist but are for a different course length" - if you've
      // explicitly set SIM_COURSE_LENGTH_NM, clear whatever's already
      // published so the course actually gets recomputed at the new length
      // instead of silently reusing the old one.
      if (process.env.SIM_COURSE_LENGTH_NM !== undefined) {
        try {
          await redisStore.clearCourseMarks();
          console.log('[baseStation] SIM_COURSE_LENGTH_NM set - cleared old course marks so they get recomputed');
        } catch (err) {
          console.error('[redis] failed to clear old course marks:', err.message);
        }
      }
      try {
        raceMarks = await redisStore.getOrCreateMarks(config.sim.centerLat, config.sim.centerLon);
        console.log(`[baseStation] course marks (Redis): ${Object.keys(raceMarks).join(', ')}`);
      } catch (err) {
        console.error('[redis] failed to resolve marks:', err.message);
      }
    } else {
      try {
        const marks = await redisStore.getMarks();
        if (marks.committee && marks.finish) {
          raceMarks = marks;
          console.log('[baseStation] finish line resolved (Redis) - lap crossings will be reported');
        } else {
          console.log('[baseStation] no course marks in Redis yet - lap detection disabled until they are set');
        }
      } catch (err) {
        console.error('[redis] failed to resolve course marks for lap detection:', err.message);
      }
    }
  })();

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

  radio.on('frame', (decoded) => {
    logToConsole(decoded);
    logToCsv(decoded);
    redisStore.recordFix(decoded, new Date()).catch((err) => console.error('[redis] write failed:', err.message));
    outputFrame(decoded); // <- swap/extend this for your actual race software

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
