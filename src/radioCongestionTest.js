const config = require('./config');
const { RadioLink } = require('./radioLink');
const protocol = require('./protocol');
const { sequentialBoatId } = require('./boatIdFile');

// Bench test for REAL over-the-air congestion on the actual telemetry
// radio - distinct from both `npm run fleet` (SIMULATE=1's UDP stand-in
// has no real airtime limit to congest at all) and just running FLEET_SIZE
// real boatAgent.js processes with SIMULATE_GPS=1 (they'd all need their
// own real radio - a serial port only ever has one owner, so N processes
// can't share the one real RADIO_PORT most setups actually have).
//
// Instead, this is ONE process using the one real radio you do have to
// transmit the COMBINED frame traffic BOAT_COUNT real boats sailing at
// CONGESTION_SPEED_KN would actually put on the air - same protocol.js
// frames boatAgent.js sends, at the same per-boat cadence its own
// txDistanceM gate would produce at that speed (see config.js), just
// computed directly here instead of coming from a real/simulated GPS
// track. That's a genuine test of airtime/throughput load on the real
// link (frame rate, size, the base radio's own receive/decode pipeline) -
// it is NOT a test of real multi-transmitter RF behavior (hidden-node
// collisions, simultaneous keying) since every byte still leaves the same
// single antenna; for that you'd need one real radio per virtual boat.
//
// Point the BASE at its own real radio and run it for real (not
// SIMULATE=1 - that has no real link to congest):
//
//   npm run base
//
// then run this against your one boat-side radio:
//
//   BOAT_COUNT=30 RADIO_PORT=/dev/cu.usbserial-0001 npm run radio-congestion
//
// Watch the base's own dashboard (fleet table "last seen"/frame counts)
// and its "[radio] link quality" log line (sync-error count) as BOAT_COUNT
// climbs - that's the actual congestion signal. This script only generates
// realistic load; it doesn't judge the result, the same way `npm run
// fleet` doesn't judge race results either.

const BOAT_COUNT = parseInt(process.env.BOAT_COUNT || '30', 10);
if (!Number.isInteger(BOAT_COUNT) || BOAT_COUNT < 1) {
  console.error(`[radioCongestionTest] invalid BOAT_COUNT=${process.env.BOAT_COUNT} - must be a positive integer`);
  process.exit(1);
}

// 6kn - a brisk but ordinary beat/run boatspeed, not a peak surf/plane
// speed - this is meant to model realistic sustained load, not a
// worst-case burst.
const SPEED_KN = parseFloat(process.env.CONGESTION_SPEED_KN || '6');
const SPEED_MS = SPEED_KN * 0.514444;

// Reuses the REAL production transmit gate (config.js's txDistanceM,
// TX_DISTANCE_M) rather than an arbitrary made-up send rate, so this
// test's load matches what actual boats moving this fast would really put
// on the air.
const perBoatIntervalMs = (config.txDistanceM / SPEED_MS) * 1000;

const boatIds = Array.from({ length: BOAT_COUNT }, (_, i) => sequentialBoatId(i + 1));

// TX_BATCH_SIZE (config.txBatchSize) applies here too - lets you A/B the
// real airtime effect of batching against this same load profile without
// needing an actual fleet, see the README's own "Batching multiple fixes
// per send" section. Each boat still computes a fresh fix every
// perBoatIntervalMs below (the distance-gate cadence doesn't change), but
// only actually calls radio.send() once every txBatchSize fixes - modeling
// exactly what boatAgent.js's own queueFixForTx/flushPendingBatch do.
const batchNote = config.txBatchSize > 1 ? ` (batched ${config.txBatchSize}/send)` : '';
console.log(
  `[radioCongestionTest] ${BOAT_COUNT} virtual boats @ ${SPEED_KN}kn (txDistanceM=${config.txDistanceM}m)${batchNote} -> ` +
    `~${(1000 / perBoatIntervalMs).toFixed(2)} fixes/s/boat, ~${((BOAT_COUNT * 1000) / perBoatIntervalMs).toFixed(1)} fixes/s aggregate ` +
    `on ${config.radio.port} @ ${config.radio.baud}`
);

const radio = new RadioLink({ port: config.radio.port, baud: config.radio.baud });
radio.on('error', (err) => console.error('[radio] error:', err.message));
radio.on('connected', () => console.log(`[radioCongestionTest] radio open on ${config.radio.port}`));
radio.on('disconnected', () => console.warn('[radio] disconnected, retrying...'));

// sent/dropped are tracked separately - radio.send() returns false without
// writing anything whenever the port isn't actually open (wrong path, held
// by another process, disconnected), same as radioTest.js checks - so
// dropped is what tells you the sender itself isn't actually on the air,
// as opposed to `dropped: 0` meaning every attempted frame really left the
// radio.
let sent = 0;
let dropped = 0;
const startedAt = Date.now();

boatIds.forEach((boatId, i) => {
  // Spread starting positions a few meters apart around the real sim
  // course center (config.sim) purely so a real base's own map/fleet
  // table doesn't show every virtual boat stacked on one exact point -
  // has no bearing on radio load, which is about frame count/size, not
  // position.
  let lat = config.sim.centerLat + i * 0.00002;
  const lon = config.sim.centerLon;
  const pending = []; // only used when config.txBatchSize > 1

  // Each boat's own send loop, independently phased (see the random
  // initial delay below) so BOAT_COUNT sends don't all land on the same
  // tick - a real fleet's own distance gates would never line up that
  // precisely either, and firing them in lockstep would understate normal
  // jitter while overstating any single-instant burst.
  const tick = () => {
    lat += (SPEED_MS * (perBoatIntervalMs / 1000)) / 111320; // meters -> degrees lat, same flat-earth approximation course.js uses
    const pvt = {
      timestamp: Date.now(),
      lat,
      lon,
      gSpeedMmS: SPEED_MS * 1000,
      headMotDeg: 0, // due north - arbitrary, doesn't affect load
      gnssFixOk: true,
      carrSoln: 2,
      numSV: 14,
    };

    if (config.txBatchSize <= 1) {
      if (radio.send(protocol.encode(boatId, pvt))) sent++;
      else dropped++;
      return;
    }

    // Same size-based flush boatAgent.js's own queueFixForTx uses - this
    // tool models steady, continuous movement (the distance gate always
    // clears every tick), so there's no slow-boat/TX_INTERVAL_MS-staleness
    // case to model here, unlike the real app.
    pending.push(pvt);
    if (pending.length >= config.txBatchSize) {
      const frame = protocol.encodeBatch(boatId, pending);
      pending.length = 0;
      if (radio.send(frame)) sent++;
      else dropped++;
    }
  };

  setTimeout(() => {
    tick();
    setInterval(tick, perBoatIntervalMs);
  }, Math.random() * perBoatIntervalMs);
});

// Only the drops from THIS window get the "check RADIO_PORT/connection"
// warning - a handful during the first window is just startup timing (a
// boat's jittered first tick landing before the serial port finished
// opening async) and stops on its own, not an ongoing problem. Same
// "don't keep alarming about a number that stopped changing" reasoning as
// baseStation.js's own link-quality log.
let lastReportedDropped = 0;
setInterval(() => {
  const elapsedS = (Date.now() - startedAt) / 1000;
  const newDrops = dropped - lastReportedDropped;
  lastReportedDropped = dropped;
  const droppedNote =
    newDrops > 0
      ? `, ${newDrops} dropped in the last 10s (port not open - check RADIO_PORT/connection)`
      : dropped > 0
      ? `, ${dropped} dropped total (none in the last 10s)`
      : '';
  console.log(`[radioCongestionTest] --- ${sent} frames sent, ${(sent / elapsedS).toFixed(1)} tx/s actual average, ${elapsedS.toFixed(0)}s elapsed${droppedNote} ---`);
}, 10000);

process.on('SIGINT', () => {
  console.log('\n[radioCongestionTest] shutting down');
  process.exit(0);
});
