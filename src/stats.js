// Central in-memory stats collector for the base station's admin dashboard
// (see adminServer.js). Deliberately simple and in-process: resets on
// restart, nothing persisted here - this is a live "what's happening right
// now" view, not a historical record (Redis and fleet-uploads are already
// the durable stores for that). A singleton by construction (Node caches
// this module), which is fine since there's only ever one base station
// process per run.

const startedAt = Date.now();

let framesReceived = 0;
let syncErrors = 0;

let uploadAttempts = 0;
let uploadSuccesses = 0;
let uploadFailures = 0;
let uploadBytesTotal = 0;

const boatLastSeen = new Map(); // boatId -> timestamp of last position frame
const boatLastPosition = new Map(); // boatId -> {lat, lon} of last position frame - in-memory only, see recordFrame
// boatId -> {carrSoln, gnssFixOk, numSV} of last position frame - same
// in-memory-only, this-session-only treatment as boatLastPosition, for the
// fleet table's Fix column. Deliberately doesn't include fixType (3D/2D/
// dead-reckoning) - that field isn't in the wire protocol at all (see
// protocol.js's decode), only what's actually transmitted.
const boatLastFix = new Map();
// boatId -> recent frame-receipt timestamps, trimmed to the last
// FIX_RATE_WINDOW_MS on every recordFrame call - see fixHz() below.
const boatFrameTimes = new Map();
// How far back to look when computing each boat's live fix rate (fixHz) -
// long enough to smooth over ordinary per-fix jitter (network/OS
// scheduling), short enough that a real change (a radio dropout, a boat
// sitting still under TX_DISTANCE_M's movement gate) shows up within a few
// seconds rather than lingering on stale history.
const FIX_RATE_WINDOW_MS = 10000;
const boatPending = new Map(); // boatId -> { pending, reportedAt } - self-reported by the rover, see uploadClient.js
const boatUploadStats = new Map(); // boatId -> { attempts, successes, failures, bytes }
const boatIp = new Map(); // boatId -> LAN IP, learned from its own upload/health-check requests
const boatAdminPort = new Map(); // boatId -> its own admin dashboard port, self-reported (see uploadClient.js)

function _boatUpload(boatId) {
  let s = boatUploadStats.get(boatId);
  if (!s) {
    s = { attempts: 0, successes: 0, failures: 0, bytes: 0 };
    boatUploadStats.set(boatId, s);
  }
  return s;
}

// Callers pass boatId as whatever type is natural where they got it from -
// a number off a decoded radio frame in baseStation.js, a string captured
// from a URL/filename regex in uploadServer.js. Normalized to a string here
// so every recording function agrees on one key type; otherwise `1` and
// `"1"` end up as two separate Map entries for the same boat; since a JS
// object can only ever have string keys anyway, whichever one snapshot()
// happened to build last would silently clobber the other's fields (this
// is exactly what caused boat entries to show lastSeen: null despite frames
// clearly arriving, before this fix).
function normalizeBoatId(boatId) {
  return String(boatId);
}

// position is optional ({lat, lon} off the decoded frame) - kept purely
// in-memory here, same as everything else in this module, so the base
// map (adminServer.js's renderMap) only ever plots a boat once it's
// actually heard from this session, never from a boat's uploaded/on-disk
// history (see baseStation.js's uploadDirBaseline, which is deliberately
// kept separate from this). fix is likewise optional ({carrSoln,
// gnssFixOk, numSV} off the decoded frame) - see boatLastFix's own comment.
function recordFrame(boatId, position, fix) {
  framesReceived++;
  const id = normalizeBoatId(boatId);
  const now = Date.now();
  boatLastSeen.set(id, now);
  if (position) boatLastPosition.set(id, position);
  if (fix) boatLastFix.set(id, fix);

  let times = boatFrameTimes.get(id);
  if (!times) {
    times = [];
    boatFrameTimes.set(id, times);
  }
  times.push(now);
  const cutoff = now - FIX_RATE_WINDOW_MS;
  while (times.length && times[0] < cutoff) times.shift();
}

// The actual rate frames from this boat are arriving AT THE BASE, measured
// from the real gaps between the last few receipt timestamps in the window
// above - deliberately NOT the boat's own onboard GPS_HZ/SIM_GPS_HZ. Every
// fix is gated by TX_DISTANCE_M before boatAgent.js ever transmits it (see
// its handlePvt), so what actually arrives here is normally lower than the
// raw onboard rate, and legitimately drops toward 0 for a stationary or
// slow-moving boat - that's expected, not a radio problem. null until at
// least two frames have landed inside the window (one alone has no
// interval to measure a rate from).
function fixHz(boatId) {
  const times = boatFrameTimes.get(normalizeBoatId(boatId));
  if (!times || times.length < 2) return null;
  const spanS = (times[times.length - 1] - times[0]) / 1000;
  return spanS > 0 ? (times.length - 1) / spanS : null;
}

function recordSyncError() {
  syncErrors++;
}

function recordUploadAttempt(boatId) {
  uploadAttempts++;
  _boatUpload(normalizeBoatId(boatId)).attempts++;
}

function recordUploadSuccess(boatId, bytes) {
  uploadSuccesses++;
  uploadBytesTotal += bytes;
  const s = _boatUpload(normalizeBoatId(boatId));
  s.successes++;
  s.bytes += bytes;
}

function recordUploadFailure(boatId) {
  uploadFailures++;
  _boatUpload(normalizeBoatId(boatId)).failures++;
}

// Self-reported by the rover on its own periodic health check (see
// uploadClient.js) - the base has no way to know what's still sitting
// unsent on a boat's SD card otherwise, since that's purely local state on
// a machine the base can't inspect.
function recordPending(boatId, count) {
  boatPending.set(normalizeBoatId(boatId), { pending: count, reportedAt: Date.now() });
}

// Learned passively from the source address of the boat's own HTTP
// requests (uploadServer.js) - lets the base dashboard link out to that
// boat's own rover dashboard (see roverAdminServer.js).
function recordBoatIp(boatId, ip) {
  boatIp.set(normalizeBoatId(boatId), ip);
}

// Self-reported by the rover on the same health check as recordPending
// above (see uploadClient.js) - can't just assume it matches this base's
// own ADMIN_PORT, since a boat running SIMULATE=1 on the same machine as
// the base defaults to a different port specifically to avoid a port
// conflict (see boatAgent.js's myAdminPort).
function recordBoatAdminPort(boatId, port) {
  boatAdminPort.set(normalizeBoatId(boatId), port);
}

// One combined, JSON-friendly snapshot for adminServer.js's /api/stats.
function snapshot() {
  const boatIds = new Set([...boatLastSeen.keys(), ...boatPending.keys(), ...boatUploadStats.keys(), ...boatIp.keys()]);
  const boats = {};
  for (const boatId of boatIds) {
    const upload = boatUploadStats.get(boatId) || { attempts: 0, successes: 0, failures: 0, bytes: 0 };
    const pendingInfo = boatPending.get(boatId) || null;
    boats[boatId] = {
      lastSeen: boatLastSeen.get(boatId) || null,
      lastPosition: boatLastPosition.get(boatId) || null,
      lastFix: boatLastFix.get(boatId) || null,
      fixHz: fixHz(boatId),
      upload,
      pending: pendingInfo ? pendingInfo.pending : null,
      pendingReportedAt: pendingInfo ? pendingInfo.reportedAt : null,
      ip: boatIp.get(boatId) || null,
      adminPort: boatAdminPort.get(boatId) || null,
    };
  }
  return {
    startedAt,
    uptimeMs: Date.now() - startedAt,
    radio: { framesReceived, syncErrors },
    upload: { attempts: uploadAttempts, successes: uploadSuccesses, failures: uploadFailures, bytesTotal: uploadBytesTotal },
    boats,
  };
}

module.exports = {
  recordFrame,
  recordSyncError,
  recordUploadAttempt,
  recordUploadSuccess,
  recordUploadFailure,
  recordPending,
  recordBoatIp,
  recordBoatAdminPort,
  snapshot,
};
