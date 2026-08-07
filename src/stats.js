// Central in-memory stats collector for the base station's admin dashboard
// (see adminServer.js). Deliberately simple and in-process: resets on
// restart, nothing persisted here - this is a live "what's happening right
// now" view, not a historical record (Redis and race-uploads are already
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
// kept separate from this).
function recordFrame(boatId, position) {
  framesReceived++;
  const id = normalizeBoatId(boatId);
  boatLastSeen.set(id, Date.now());
  if (position) boatLastPosition.set(id, position);
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
