// Central in-memory stats collector for the base station's admin dashboard
// (see adminServer.js). Deliberately simple and in-process: resets on
// restart, nothing persisted here - this is a live "what's happening right
// now" view, not a historical record (Redis and base-uploads are already
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
// boatId -> the fixes' own GPS times, trimmed to the last FIX_RATE_WINDOW_MS (of fix time) on every recordFrame call - see
// fixHz() below. Arrival time cannot be used: a boat's slot delivers a whole cycle of fixes in one burst, so they all
// arrive in the same millisecond (a rate from arrival gaps read 1,750 Hz).
const boatFrameTimes = new Map();
// How far back to look when computing each boat's live fix rate (fixHz) -
// long enough to smooth over ordinary per-fix jitter (network/OS
// scheduling), short enough that a real change (a radio dropout, a boat
// sitting still under TX_DISTANCE_M's movement gate) shows up within a few
// seconds rather than lingering on stale history.
const FIX_RATE_WINDOW_MS = 10000;
// boatId -> highest fixHz-style rate seen this session (see recordFrame).
// Only sampled once the window spans at least FIX_RATE_MIN_SPAN_MS: a
// batched frame delivers several fixes in one burst, so a rate computed over
// the first few frames after a boat appears (span of milliseconds) reads
// absurdly high and would pin the max there forever. (Measured over fix time
// now, so a burst reads right, but the minimum span still keeps one lone fix out.)
const boatMaxFixHz = new Map();
const FIX_RATE_MIN_SPAN_MS = 5000;
const boatPending = new Map(); // boatId -> { pending, reportedAt } - self-reported by the rover, see uploadClient.js
const boatUploadStats = new Map(); // boatId -> { attempts, successes, failures, bytes }
const boatIp = new Map(); // boatId -> { ip, at }: LAN IP and when, learned from its own upload/health-check requests
// A boat's IP is shown only while it keeps checking in over WiFi (every UPLOAD_CHECK_INTERVAL_MS, 15 s by default):
// after this long without one it has left WiFi or been given a new address, and the old one may belong to someone else.
const BOAT_IP_MAX_AGE_MS = 2 * 60 * 1000;
// boatId -> { diag, at }: the rover's own diagnosis from its last status hello (protocol.js's decodeStatusHello, roverDiag.js).
// A rover resends while it has a problem and once more when it clears, so an old one is only left by a rover gone quiet -
// dropped after DIAG_MAX_AGE_MS rather than shown as if current.
const boatDiag = new Map();
const DIAG_MAX_AGE_MS = 3 * 60 * 1000;
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
function recordFrame(boatId, position, fix, fixTimeMs) {
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
  // The fix's own time when given, else (a frame with no fix of its own) the arrival time
  times.push(Number.isFinite(fixTimeMs) ? fixTimeMs : now);
  // Fixes of one frame can be handed over in any order, so keep the newest and drop what is older than the window
  const newest = Math.max(...times);
  const kept = times.filter((t) => t >= newest - FIX_RATE_WINDOW_MS);
  times.length = 0;
  times.push(...kept);

  const span = newest - Math.min(...times);
  if (times.length >= 2 && span >= FIX_RATE_MIN_SPAN_MS) {
    const hz = (times.length - 1) / (span / 1000);
    if (hz > (boatMaxFixHz.get(id) || 0)) boatMaxFixHz.set(id, hz);
  }
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
  const id = normalizeBoatId(boatId);
  const times = boatFrameTimes.get(id);
  if (!times || times.length < 2) return null;
  // The window is anchored on the newest fix, so a boat that has gone quiet would keep its last rate for ever - once
  // nothing has arrived for a whole window, there is no current rate
  const lastSeen = boatLastSeen.get(id);
  if (lastSeen == null || Date.now() - lastSeen > FIX_RATE_WINDOW_MS) return null;
  const spanS = (Math.max(...times) - Math.min(...times)) / 1000;
  return spanS > 0 ? (times.length - 1) / spanS : null;
}

function recordSyncError() {
  syncErrors++;
}

// The dashboard's "Clear stats" button on the radio frames card: start the frame and sync-error totals from zero.
function resetRadioCounters() {
  framesReceived = 0;
  syncErrors = 0;
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
// boat's own rover dashboard (see roverAdminServer.js). DHCP can hand an address on to another boat, so whichever boat
// used it last owns it and any other boat holding it loses it.
function recordBoatIp(boatId, ip, now = Date.now()) {
  const id = normalizeBoatId(boatId);
  for (const [other, entry] of boatIp) {
    if (other !== id && entry.ip === ip) boatIp.delete(other);
  }
  boatIp.set(id, { ip, at: now });
}

function currentBoatIp(boatId, now) {
  const entry = boatIp.get(boatId);
  return entry && now - entry.at < BOAT_IP_MAX_AGE_MS ? entry.ip : null;
}

// Self-reported by the rover on the same health check as recordPending
// above (see uploadClient.js) - can't just assume it matches this base's
// own ADMIN_PORT, since a boat running SIMULATE=1 on the same machine as
// the base defaults to a different port specifically to avoid a port
// conflict (see boatAgent.js's myAdminPort).
function recordBoatAdminPort(boatId, port) {
  boatAdminPort.set(normalizeBoatId(boatId), port);
}

function recordRoverDiag(boatId, diag, now = Date.now()) {
  boatDiag.set(normalizeBoatId(boatId), { diag, at: now });
}

function currentDiag(boatId, now) {
  const entry = boatDiag.get(boatId);
  return entry && now - entry.at < DIAG_MAX_AGE_MS ? { ...entry.diag, at: entry.at } : null;
}

// One combined, JSON-friendly snapshot for adminServer.js's /api/stats.
function snapshot(now = Date.now()) {
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
      maxFixHz: boatMaxFixHz.get(boatId) || null,
      upload,
      pending: pendingInfo ? pendingInfo.pending : null,
      pendingReportedAt: pendingInfo ? pendingInfo.reportedAt : null,
      ip: currentBoatIp(boatId, now),
      adminPort: boatAdminPort.get(boatId) || null,
      diag: currentDiag(boatId, now),
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
  resetRadioCounters,
  recordUploadAttempt,
  recordUploadSuccess,
  recordUploadFailure,
  recordPending,
  recordBoatIp,
  recordBoatAdminPort,
  recordRoverDiag,
  snapshot,
};
