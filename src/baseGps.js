// Owns the base station's own GPS receiver: the serial connection, TMODE3
// (survey-in/fixed reference position) polling, and the SET commands that
// actually reconfigure it. Pulled out of baseStation.js so this exact
// receiver-facing behavior can be reused by rtkStation.js (see README's
// "RTK-only mode" section) - a second, much smaller entry point whose whole
// job is monitoring/configuring this same GPS, with none of baseStation.js's
// telemetry radio, course, Redis, or RegattaUp concerns. baseStation.js
// itself now just calls into this module instead of doing any of this
// inline - same behavior, one copy of the logic.
const { SerialPort } = require('serialport');
const {
  UbxParser,
  encodePollRequest,
  encodeSetTmode3,
  encodeSaveConfig,
  TMODE3_MODE_NAMES,
  CLASS_CFG,
  ID_CFG_TMODE3,
} = require('./ubxParser');

// Re-polls TMODE3 this long after a SET command - the receiver doesn't
// announce its new config on its own, and whoever clicked the mode button
// wants to see it take effect, not wait up to TMODE3_POLL_INTERVAL_MS for
// the next scheduled poll.
const TMODE3_REFRESH_DELAY_MS = 500;
const TMODE3_POLL_INTERVAL_MS = 15000;
const REOPEN_DELAY_MS = 3000;

// enabled: whether to actually open anything - callers that only sometimes
// have GPS hardware attached (baseStation.js, gated on GPS_PORT being
// *explicitly* set - see its own comment) pass this through rather than
// always calling open(); rtkStation.js always passes true, since opening
// this connection is its entire reason to exist.
// logConsole/logReplace/onDirtyLine mirror config.gps's own fields - see
// config.js's comment on each. onDirtyLine, if given, is called whenever an
// in-place (non-scrolling) line is written, so a caller with OTHER console
// output of its own (baseStation.js's shared gpsLineDirty wrapper) knows to
// clear it first - harmless to omit for a caller with nothing else writing
// to its console.
function createBaseGps({ enabled, port, baud, svinMinDurS, svinAccLimitMm, logConsole, logReplace, onDirtyLine }) {
  let baseGpsFix = null;
  // TMODE3 governs how the receiver establishes its OWN fixed reference
  // position before it's trustworthy as an RTK base (disabled/survey-in/
  // fixed) - separate from baseGpsFix above, which is just the ordinary nav
  // solution and keeps updating regardless. Neither is pushed by the
  // receiver on its own the way NAV-PVT is: TMODE3 has to be polled (see
  // below), and NAV-SVIN only streams while survey-in mode is actually
  // configured and enabled as an output message. Both null until we've
  // heard something, same "never throws, null means not available yet"
  // contract as getFix.
  let baseGpsTmode3 = null;
  let baseGpsSvin = null;
  // The currently-open port, if any - null whenever not enabled, or enabled
  // but momentarily disconnected/reconnecting. Only needed for sending a SET
  // command on demand (setSurveyIn/setFixed below) - everything else about
  // this GPS (fixes, poll responses) flows the other direction, through the
  // parser's event handlers, and never needs a reference to the port itself
  // outside this module.
  let currentGpsPort = null;

  function open() {
    if (!enabled) return;
    const gpsPort = new SerialPort({ path: port, baudRate: baud }, (err) => {
      if (err) {
        if (currentGpsPort === gpsPort) currentGpsPort = null;
        console.error('[baseGps] open failed:', err.message, `- retrying in ${REOPEN_DELAY_MS / 1000}s`);
        setTimeout(open, REOPEN_DELAY_MS);
      }
    });
    currentGpsPort = gpsPort;
    const parser = new UbxParser();
    let tmode3PollTimer;
    gpsPort.on('data', (chunk) => parser.write(chunk));
    gpsPort.on('close', () => {
      if (currentGpsPort === gpsPort) currentGpsPort = null;
      clearInterval(tmode3PollTimer);
      console.warn('[baseGps] port closed, retrying in 3s');
      setTimeout(open, REOPEN_DELAY_MS);
    });
    gpsPort.on('error', (err) => console.error('[baseGps] error:', err.message));
    parser.on('nav-pvt', (pvt) => {
      baseGpsFix = pvt;
      if (logConsole) {
        // The base GPS is normally stationary (it's the fixed reference, not
        // something moving around a course), so unlike a boat's own
        // TX_DISTANCE_M-gated logging, there's no "did it move enough to be
        // worth its own line" distinction to fall back on here - every fix
        // would otherwise scroll a near-identical line at whatever rate the
        // receiver's configured for. Overwrite the same line instead.
        // Timestamp included so a genuinely frozen connection is still
        // visually distinguishable from a live one that just hasn't moved.
        const time = new Date(pvt.timestamp).toISOString().slice(11, 23);
        // No diffSoln/carrSoln here (unlike a rover's own [gps] line) - those
        // describe whether *this* receiver is consuming corrections, which
        // is meaningless for a base: it's the source of corrections, not a
        // consumer, so those fields just sit at false/0 regardless of
        // whether the base is actually working.
        const line =
          `[baseGps] ${time} ${pvt.lat.toFixed(6)},${pvt.lon.toFixed(6)} ` +
          `fixType=${pvt.fixType} numSV=${pvt.numSV} hAcc=${(pvt.hAccMm / 1000).toFixed(2)}m`;
        if (logReplace && process.stdout.isTTY) {
          process.stdout.write(`\x1b[2K\r${line}`);
          if (onDirtyLine) onDirtyLine();
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
    // right after opening (so the UI has something on the very first load)
    // and again periodically, since a poll request sent before the
    // receiver's serial buffer is ready, or one that's simply lost, would
    // otherwise leave the UI stuck showing nothing until a manual restart.
    gpsPort.write(encodePollRequest(CLASS_CFG, ID_CFG_TMODE3));
    tmode3PollTimer = setInterval(() => {
      gpsPort.write(encodePollRequest(CLASS_CFG, ID_CFG_TMODE3));
    }, TMODE3_POLL_INTERVAL_MS);
  }

  function isConnected() {
    return !!currentGpsPort;
  }

  // Returns null - never throws - whenever there's nothing to report: not
  // enabled at all (the overwhelmingly common case for a plain base
  // station; most have no GPS hardware attached), or enabled but no fix
  // received yet. Includes every NAV-PVT field this app decodes (see
  // ubxParser.js's _decodePvt), not just lat/lon/fix-quality - callers that
  // want a lighter readout (e.g. a map's recenter button) just ignore the
  // extra fields they don't use.
  function getFix() {
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

  // Same null-means-not-available contract as getFix, but for the
  // TMODE3/survey-in status - reported separately since the receiver can
  // have a perfectly good ordinary GPS fix (getFix) while TMODE3 itself is
  // still disabled, mid-survey, or never polled yet. modeText is a plain
  // label a UI can show directly, since 0/1/2 means nothing to an operator
  // glancing at a dashboard.
  function getSurveyStatus() {
    if (!baseGpsTmode3 && !baseGpsSvin) return null;
    return {
      mode: baseGpsTmode3 ? baseGpsTmode3.mode : null,
      modeText: baseGpsTmode3 ? TMODE3_MODE_NAMES[baseGpsTmode3.mode] || 'unknown' : null,
      tmode3Timestamp: baseGpsTmode3 ? baseGpsTmode3.timestamp : null,
      // The targets THIS APP last asked for via setSurveyIn (see
      // svinMinDurS/svinAccLimitMm above) - not read back from the receiver
      // itself (TMODE3's poll response doesn't echo them), so this reflects
      // our own request, not necessarily whatever an operator may have
      // separately configured via u-center. Given alongside
      // survey.durationS/meanAccMm below so a UI can show progress against
      // the actual finish line, not just raw numbers - survey-in only
      // completes once duration clears configuredMinDurS AND accuracy drops
      // to or below configuredAccLimitMm, whichever takes longer.
      configuredMinDurS: svinMinDurS,
      configuredAccLimitMm: svinAccLimitMm,
      // Only meaningful once mode is actually 2 (fixed) - the poll response
      // echoes back whatever position it's fixed to (see ubxParser.js's
      // _decodeTmode3), whether this app set it (via setFixed) or it was
      // configured some other way, e.g. u-center, before this ever connected.
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

  function requestTmode3Refresh() {
    setTimeout(() => {
      if (currentGpsPort) currentGpsPort.write(encodePollRequest(CLASS_CFG, ID_CFG_TMODE3));
    }, TMODE3_REFRESH_DELAY_MS);
  }

  // Switches the GPS into survey-in mode - see the admin dashboard's "Start
  // survey-in" button. Also the right call to REstart a survey (e.g.
  // conditions changed, or an operator wants a fresh/longer one) - TMODE3
  // has no separate "restart" command, sending the same SET again is how
  // u-blox receivers do it.
  function setSurveyIn() {
    if (!currentGpsPort) throw new Error('base GPS not connected');
    currentGpsPort.write(encodeSetTmode3({ mode: 1, svinMinDurS, svinAccLimitMm }));
    requestTmode3Refresh();
  }

  // Locks the GPS to a fixed reference position - see the admin dashboard's
  // "Use as fixed position" button and the manual-entry form beside it.
  // manualPos, when given, is an operator-typed {lat, lon, heightM,
  // fixedPosAccMm} - e.g. a club's own previously-surveyed benchmark
  // position, more trustworthy than anything this app can measure itself.
  // Re-validated here even though a dashboard's own form already checks
  // ranges client-side, since this reconfigures RTK corrections for every
  // boat and a request could reach this function by some other path than
  // that form. Without manualPos, prefers the completed survey-in's own
  // mean position (what an operator normally wants: survey in, then lock to
  // the result) but falls back to whatever ordinary fix the receiver
  // currently has if no valid survey-in result exists yet - still useful
  // for bench testing, though nowhere near RTK-base-grade precision that way
  // (an ordinary nav fix's own accuracy, not an averaged one).
  function setFixed(manualPos) {
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
  // storage, so it's still set that way after a power cycle - see the admin
  // dashboard's own "Save config" button and encodeSaveConfig's own comment
  // for why this is a separate, explicit action rather than automatic:
  // setSurveyIn/setFixed above only ever change the receiver's live RAM
  // config on their own.
  function saveConfig() {
    if (!currentGpsPort) throw new Error('base GPS not connected');
    currentGpsPort.write(encodeSaveConfig());
  }

  return { open, isConnected, getFix, getSurveyStatus, setSurveyIn, setFixed, saveConfig };
}

module.exports = { createBaseGps };
