// Central in-memory stats collector for the boat's own admin dashboard
// (see roverAdminServer.js) - the boat-side counterpart to stats.js on the
// base station. Deliberately simple and in-process: resets on restart,
// nothing persisted here - the SD card CSV (sdLogger.js) is already the
// durable record of what this boat actually did.

const startedAt = Date.now();

let framesSent = 0;
let syncErrors = 0;
let marksReceived = 0;
let lastMarksReceivedAt = null;
let lastFix = null;

let uploadAttempts = 0;
let uploadSuccesses = 0;
let uploadFailures = 0;
let uploadBytesTotal = 0;
let lastUploadAt = null;
let lastHealthCheckOkAt = null;

function recordFrameSent() {
  framesSent++;
}

function recordSyncError() {
  syncErrors++;
}

function recordMarksReceived() {
  marksReceived++;
  lastMarksReceivedAt = Date.now();
}

// pvt: the same object handlePvt() receives (see boatAgent.js) - kept in
// full since the dashboard shows fix quality (fixType/carrSoln/numSV/hAcc),
// not just position.
function recordFix(pvt) {
  lastFix = pvt;
}

function recordUploadAttempt() {
  uploadAttempts++;
}

function recordUploadSuccess(bytes) {
  uploadSuccesses++;
  uploadBytesTotal += bytes;
  lastUploadAt = Date.now();
}

function recordUploadFailure() {
  uploadFailures++;
}

function recordHealthCheckOk() {
  lastHealthCheckOkAt = Date.now();
}

function snapshot() {
  return {
    startedAt,
    uptimeMs: Date.now() - startedAt,
    radio: { framesSent, syncErrors },
    marks: { received: marksReceived, lastReceivedAt: lastMarksReceivedAt },
    lastFix,
    upload: {
      attempts: uploadAttempts,
      successes: uploadSuccesses,
      failures: uploadFailures,
      bytesTotal: uploadBytesTotal,
      lastUploadAt,
      lastHealthCheckOkAt,
    },
  };
}

module.exports = {
  recordFrameSent,
  recordSyncError,
  recordMarksReceived,
  recordFix,
  recordUploadAttempt,
  recordUploadSuccess,
  recordUploadFailure,
  recordHealthCheckOk,
  snapshot,
};
