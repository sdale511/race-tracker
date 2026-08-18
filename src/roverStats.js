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

let rtcmCount = 0;
let rtcmCrcFailures = 0;
let lastRtcmAt = null;
let lastRtcmMsgType = null;

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

// msg: the same object emitted by ubxParser.js's 'rxm-rtcm' event. Tracked
// independent of GPS_LOG_RTCM (see boatAgent.js's openGps) - that flag only
// gates the console line, not whether the rover dashboard's own RTK
// corrections card sees this at all.
function recordRtcm(msg) {
  rtcmCount++;
  if (msg.crcFailed) rtcmCrcFailures++;
  lastRtcmAt = Date.now();
  lastRtcmMsgType = msg.msgType;
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
    rtcm: {
      count: rtcmCount,
      crcFailures: rtcmCrcFailures,
      lastReceivedAt: lastRtcmAt,
      lastMsgType: lastRtcmMsgType,
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
  recordRtcm,
  snapshot,
};
