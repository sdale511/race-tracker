const { EventEmitter } = require('events');

// Minimal UBX binary protocol parser, specialized for NAV-PVT (class 0x01,
// id 0x07), which the ZED-F9P (on the simpleRTK2B) can emit at 1-10Hz.
// NAV-PVT bundles position, velocity, heading, fix type and RTK carrier
// solution status into a single 92-byte payload, so we don't need to stitch
// together multiple NMEA sentences.
//
// Enable this message and disable NMEA chatter on the GPS's UART using
// u-center or ubxtool, e.g.:
//   ubxtool -P 27.11 -p CFG-VALSET -z CFG-MSGOUT-UBX_NAV_PVT_UART1,1
//   ubxtool -P 27.11 -p CFG-VALSET -z CFG-UART1OUTPROT-NMEA,0

const SYNC1 = 0xb5;
const SYNC2 = 0x62;
const CLASS_NAV = 0x01;
const ID_NAV_PVT = 0x07;
const ID_NAV_SVIN = 0x3b;
const CLASS_CFG = 0x06;
const ID_CFG_TMODE3 = 0x71;
const ID_CFG_CFG = 0x09;
const CLASS_RXM = 0x02;
const ID_RXM_RTCM = 0x32;
const PVT_LENGTH = 92;
const SVIN_LENGTH = 40;
const TMODE3_LENGTH = 40;
const CFG_CFG_LENGTH = 13;
const RXM_RTCM_LENGTH = 8;

// WGS84 ellipsoid constants, for converting the ECEF position NAV-SVIN
// reports (survey-in works in ECEF, not lat/lon) into something the admin
// UI can actually show. Closed-form (Heikkinen's method) rather than an
// iterative solve - exact to well within GPS precision and simpler than
// managing convergence.
const WGS84_A = 6378137.0; // semi-major axis, meters
const WGS84_F = 1 / 298.257223563; // flattening
const WGS84_E2 = WGS84_F * (2 - WGS84_F); // first eccentricity squared

function ecefToLla(xM, yM, zM) {
  const b = WGS84_A * (1 - WGS84_F);
  const ep2 = (WGS84_A * WGS84_A - b * b) / (b * b);
  const p = Math.hypot(xM, yM);
  const theta = Math.atan2(zM * WGS84_A, p * b);
  const sinTheta = Math.sin(theta);
  const cosTheta = Math.cos(theta);
  const lat = Math.atan2(
    zM + ep2 * b * sinTheta * sinTheta * sinTheta,
    p - WGS84_E2 * WGS84_A * cosTheta * cosTheta * cosTheta
  );
  const lon = Math.atan2(yM, xM);
  const sinLat = Math.sin(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const heightM = p / Math.cos(lat) - n;
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI, heightM };
}

// Header + class/id/length + payload + checksum - the same framing both
// encodePollRequest (empty payload) and encodeSetTmode3 (real payload)
// below need.
function buildFrame(msgClass, msgId, payload) {
  const header = Buffer.from([SYNC1, SYNC2, msgClass, msgId, payload.length & 0xff, (payload.length >> 8) & 0xff]);
  const body = Buffer.concat([header, payload]);
  let ckA = 0;
  let ckB = 0;
  for (let i = 2; i < body.length; i++) {
    ckA = (ckA + body[i]) & 0xff;
    ckB = (ckB + ckA) & 0xff;
  }
  return Buffer.concat([body, Buffer.from([ckA, ckB])]);
}

// Builds a UBX poll request: header + class/id/zero-length + checksum, no
// payload - the receiver responds with the same class/id carrying its
// current config (see UbxParser's cfg-tmode3 handling below).
function encodePollRequest(msgClass, msgId) {
  return buildFrame(msgClass, msgId, Buffer.alloc(0));
}

// Splits a value into a coarse integer component plus a high-precision
// remainder, the same two-part encoding UBX uses throughout for sub-unit
// precision (NAV-SVIN's ECEF mean, NAV-HPPOSLLH, and CFG-TMODE3's own
// lat/lon/height here) - trunc-based (not round-then-subtract) so the
// remainder's sign always matches the whole value's, which is what the
// receiver expects for negative coordinates.
function splitHP(totalSmallUnits) {
  const main = Math.trunc(totalSmallUnits / 100);
  const hp = totalSmallUnits - main * 100;
  return { main, hp };
}

// Sets TMODE3 to either survey-in (mode 1, using svinMinDurS/svinAccLimitMm)
// or fixed (mode 2, at lat/lon/heightM, given as LLA rather than ECEF - the
// lla flag bit means the receiver does that conversion itself rather than
// this app needing to). See baseStation.js's setBaseGpsSurveyIn /
// setBaseGpsFixed for how each is actually invoked, and the u-blox
// interface spec for the full CFG-TMODE3 field layout this mirrors.
function encodeSetTmode3({ mode, lat, lon, heightM, fixedPosAccMm, svinMinDurS, svinAccLimitMm }) {
  const payload = Buffer.alloc(TMODE3_LENGTH);
  const lla = mode === 2 ? 1 : 0;
  payload.writeUInt16LE((mode & 0xff) | (lla << 8), 2);
  if (mode === 2) {
    const latSplit = splitHP(Math.round(lat * 1e9));
    const lonSplit = splitHP(Math.round(lon * 1e9));
    const heightSplit = splitHP(Math.round(heightM * 1e4));
    payload.writeInt32LE(latSplit.main, 4);
    payload.writeInt32LE(lonSplit.main, 8);
    payload.writeInt32LE(heightSplit.main, 12);
    payload.writeInt8(latSplit.hp, 16);
    payload.writeInt8(lonSplit.hp, 17);
    payload.writeInt8(heightSplit.hp, 18);
    payload.writeUInt32LE(Math.max(0, Math.round((fixedPosAccMm || 0) * 10)), 20);
  } else if (mode === 1) {
    payload.writeUInt32LE(Math.max(0, svinMinDurS || 0), 24);
    payload.writeUInt32LE(Math.max(0, Math.round((svinAccLimitMm || 0) * 10)), 28);
  }
  return buildFrame(CLASS_CFG, ID_CFG_TMODE3, payload);
}

// Persists the receiver's current configuration (whatever TMODE3 mode was
// last SET, among everything else) to non-volatile storage, so it's still
// there after a power cycle - encodeSetTmode3 above only ever changes the
// receiver's live RAM config, the same as every other legacy UBX-CFG-*
// message (unlike the newer CFG-VALSET interface, which takes an explicit
// RAM/BBR/Flash layer bitmask per call - see the README's own ubxtool setup
// commands for that style). Without a save, TMODE3 silently reverts to
// whatever was last saved (or the factory default) on every restart.
//
// saveMask 0xffffffff saves every configuration group currently active, not
// just TMODE3 specifically - there's no narrower "just this one setting"
// option in this message. deviceMask targets BOTH BBR (bit 0) and Flash
// (bit 1): ArduSimple's simpleRTK2B boards typically have no SPI flash at
// all, relying on BBR (kept alive by an onboard supercap, or a coin cell if
// one's fitted) instead, but requesting Flash too is harmless when it's
// absent - the receiver just skips that part - and covers boards that do
// have it. BBR persistence only lasts as long as its own backup power does;
// a sufficiently long full power-down can still lose it.
function encodeSaveConfig() {
  const payload = Buffer.alloc(CFG_CFG_LENGTH);
  payload.writeUInt32LE(0x00000000, 0); // clearMask - nothing to clear
  payload.writeUInt32LE(0xffffffff, 4); // saveMask - save every active config group
  payload.writeUInt32LE(0x00000000, 8); // loadMask - nothing to load
  payload.writeUInt8(0x03, 12); // deviceMask - BBR (bit 0) | Flash (bit 1)
  return buildFrame(CLASS_CFG, ID_CFG_CFG, payload);
}

// Builds a synthetic UBX-NAV-PVT message from an already-decoded pvt-like
// object - the exact inverse of _decodePvt above, field for field. Used by
// baseStation.js/boatAgent.js's own local UDP broadcast (see config.js's
// GPS_OUTPUT_FORMAT) to re-emit position data in the format the GPS
// receiver itself speaks, rather than translating to NMEA - anything that
// already knows how to read UBX-NAV-PVT (u-center, this app's own
// UbxParser, ...) can consume it directly. Not a byte-for-byte replay of
// the original message (the original bytes aren't kept around once
// decoded) - re-encoded fresh from the same decoded field values instead,
// so there's no precision loss versus the original, just the handful of
// fields this app never decodes in the first place (velocity N/E/D
// components, heading accuracy, magnetic declination, ...) left at zero,
// same as any other UBX field a consumer doesn't care about.
//
// Works with EITHER a boat's own full pvt object (see _decodePvt, every
// field populated from its own hardware) or the base's own decoded radio
// frame (see protocol.js's decode - a much smaller field set, since the
// long-range radio link only carries what actually matters for race
// tracking, and uses speedKnots/headingDeg names instead of
// gSpeedMmS/headMotDeg) - fields the given object doesn't have fall back
// to a reasonable default (0, or the current wall-clock time for
// date/time) rather than throwing, so the same function serves both
// callers.
function encodeNavPvt(pvt) {
  const payload = Buffer.alloc(PVT_LENGTH);
  const now = new Date(pvt.timestamp ?? Date.now());
  payload.writeUInt16LE(pvt.utcYear ?? now.getUTCFullYear(), 4);
  payload.writeUInt8(pvt.utcMonth ?? now.getUTCMonth() + 1, 6);
  payload.writeUInt8(pvt.utcDay ?? now.getUTCDate(), 7);
  payload.writeUInt8(pvt.utcHour ?? now.getUTCHours(), 8);
  payload.writeUInt8(pvt.utcMin ?? now.getUTCMinutes(), 9);
  payload.writeUInt8(pvt.utcSec ?? now.getUTCSeconds(), 10);
  payload.writeUInt8(pvt.utcValid ? 0x03 : 0x00, 11); // bit0 validDate, bit1 validTime
  payload.writeUInt8(pvt.fixType ?? (pvt.gnssFixOk ? 3 : 0), 20);
  const flags = (pvt.gnssFixOk ? 0x01 : 0) | (pvt.diffSoln ? 0x02 : 0) | ((pvt.carrSoln & 0x03) << 6);
  payload.writeUInt8(flags, 21);
  payload.writeUInt8(Math.min(Math.max(pvt.numSV ?? 0, 0), 255), 23);
  payload.writeInt32LE(Math.round(pvt.lon * 1e7), 24);
  payload.writeInt32LE(Math.round(pvt.lat * 1e7), 28);
  payload.writeInt32LE(Math.round(pvt.heightMm ?? 0), 32);
  payload.writeInt32LE(Math.round(pvt.hMSLMm ?? pvt.heightMm ?? 0), 36);
  payload.writeUInt32LE(Math.max(0, Math.round(pvt.hAccMm ?? 0)), 40);
  payload.writeUInt32LE(Math.max(0, Math.round(pvt.vAccMm ?? 0)), 44);
  // gSpeedMmS/headMotDeg: a boat's own raw pvt already has these; the
  // base's own decoded radio frame instead carries the same information
  // as speedKnots/headingDeg (see protocol.js) - convert whichever is
  // actually present.
  const gSpeedMmS = pvt.gSpeedMmS ?? (pvt.speedKnots != null ? Math.round((pvt.speedKnots / 1.94384) * 1000) : 0);
  payload.writeInt32LE(gSpeedMmS, 60);
  const headMotDeg = pvt.headMotDeg ?? pvt.headingDeg ?? 0;
  payload.writeInt32LE(Math.round(headMotDeg * 1e5), 64);
  payload.writeUInt16LE(Math.max(0, Math.round((pvt.pDOP ?? 0) * 100)), 76);
  return buildFrame(CLASS_NAV, ID_NAV_PVT, payload);
}

class UbxParser extends EventEmitter {
  constructor() {
    super();
    this._buf = Buffer.alloc(0);
  }

  write(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    this._process();
  }

  _process() {
    // Find sync bytes, then make sure we have a full frame before consuming.
    while (true) {
      const syncIdx = this._buf.indexOf(Buffer.from([SYNC1, SYNC2]));
      if (syncIdx === -1) {
        // Keep at most 1 trailing byte in case it's a split sync marker.
        if (this._buf.length > 1) this._buf = this._buf.slice(this._buf.length - 1);
        return;
      }
      if (syncIdx > 0) this._buf = this._buf.slice(syncIdx);

      // Need at least header(6) + checksum(2) to know the length field.
      if (this._buf.length < 6) return;

      const msgClass = this._buf[2];
      const msgId = this._buf[3];
      const length = this._buf.readUInt16LE(4);
      const frameLen = 6 + length + 2;

      if (this._buf.length < frameLen) return; // wait for more data

      const frame = this._buf.slice(0, frameLen);
      this._buf = this._buf.slice(frameLen);

      if (this._checksumOk(frame)) {
        if (msgClass === CLASS_NAV && msgId === ID_NAV_PVT && length === PVT_LENGTH) {
          const payload = frame.slice(6, 6 + length);
          this.emit('nav-pvt', this._decodePvt(payload));
        } else if (msgClass === CLASS_NAV && msgId === ID_NAV_SVIN && length === SVIN_LENGTH) {
          const payload = frame.slice(6, 6 + length);
          this.emit('nav-svin', this._decodeSvin(payload));
        } else if (msgClass === CLASS_CFG && msgId === ID_CFG_TMODE3 && length === TMODE3_LENGTH) {
          const payload = frame.slice(6, 6 + length);
          this.emit('cfg-tmode3', this._decodeTmode3(payload));
        } else if (msgClass === CLASS_RXM && msgId === ID_RXM_RTCM && length === RXM_RTCM_LENGTH) {
          const payload = frame.slice(6, 6 + length);
          this.emit('rxm-rtcm', this._decodeRxmRtcm(payload));
        }
      } else {
        this.emit('checksum-error');
      }
      // loop again in case multiple frames arrived in one chunk
    }
  }

  _checksumOk(frame) {
    let ckA = 0;
    let ckB = 0;
    // checksum covers class, id, length, payload (everything after the 2 sync bytes,
    // up to but not including the checksum bytes)
    for (let i = 2; i < frame.length - 2; i++) {
      ckA = (ckA + frame[i]) & 0xff;
      ckB = (ckB + ckA) & 0xff;
    }
    return ckA === frame[frame.length - 2] && ckB === frame[frame.length - 1];
  }

  _decodePvt(p) {
    const flags = p.readUInt8(21);
    const carrSoln = (flags >> 6) & 0x03; // 0=none 1=float 2=fixed
    const validFlags = p.readUInt8(11);
    return {
      fixType: p.readUInt8(20),          // 0 no fix, 2 2D, 3 3D
      gnssFixOk: !!(flags & 0x01),
      diffSoln: !!(flags & 0x02),        // true as soon as RTCM corrections are being applied
      carrSoln,                          // RTK status
      numSV: p.readUInt8(23),
      lon: p.readInt32LE(24) * 1e-7,     // degrees
      lat: p.readInt32LE(28) * 1e-7,     // degrees
      heightMm: p.readInt32LE(32),       // height above the WGS84 ellipsoid
      hMSLMm: p.readInt32LE(36),         // height above mean sea level - what a sailor thinks of as "altitude"
      hAccMm: p.readUInt32LE(40),
      vAccMm: p.readUInt32LE(44),
      gSpeedMmS: p.readInt32LE(60),      // ground speed
      headMotDeg: p.readInt32LE(64) * 1e-5, // heading of motion
      // Dilution of precision - a classic GPS quality signal independent of
      // hAcc/vAcc: how much satellite geometry itself is amplifying
      // measurement error, lower is better (< 2 is excellent, > 5 is poor).
      pDOP: p.readUInt16LE(76) * 0.01,
      // The receiver's own satellite-derived UTC clock - a useful "is this
      // thing actually locked on" signal distinct from having a position
      // fix at all. Only trustworthy once both validDate and validTime
      // flags are set (bits 0/1 of the valid byte); until then the
      // date/time fields below may just be the receiver's power-on default.
      utcValid: !!(validFlags & 0x01) && !!(validFlags & 0x02),
      utcYear: p.readUInt16LE(4),
      utcMonth: p.readUInt8(6),
      utcDay: p.readUInt8(7),
      utcHour: p.readUInt8(8),
      utcMin: p.readUInt8(9),
      utcSec: p.readUInt8(10),
      timestamp: Date.now(),
    };
  }

  // Survey-in progress/result, reported periodically by the receiver while
  // TMODE3 is configured for survey-in (and once "valid" stays true forever
  // after, at whatever the final mean position landed on) - see
  // baseStation.js for how this and cfg-tmode3 below combine into one
  // status. Mean position is ECEF, split into a coarse cm component plus a
  // separate 0.1mm high-precision component per the interface spec - both
  // combined here into a single meters value before conversion to lat/lon.
  _decodeSvin(p) {
    // meanX/Y/Z: 0.01m units; meanXHP/YHP/ZHP: 0.0001m units, added in for
    // sub-cm precision - see u-blox NAV-SVIN spec.
    const meanXM = (p.readInt32LE(12) * 100 + p.readInt8(24)) / 1e4;
    const meanYM = (p.readInt32LE(16) * 100 + p.readInt8(25)) / 1e4;
    const meanZM = (p.readInt32LE(20) * 100 + p.readInt8(26)) / 1e4;
    return {
      durationS: p.readUInt32LE(8),
      meanAccMm: p.readUInt32LE(28) / 10,
      observations: p.readUInt32LE(32),
      valid: !!p.readUInt8(36),
      active: !!p.readUInt8(37),
      ...ecefToLla(meanXM, meanYM, meanZM),
      timestamp: Date.now(),
    };
  }

  // Current TMODE3 configuration, as returned when we poll for it (see
  // encodePollRequest) - mode tells us whether survey-in is even the thing
  // in progress (as opposed to a fixed position, or the mode being off
  // entirely), independent of whatever NAV-SVIN happens to be reporting.
  // In fixed mode, the poll response also echoes back the position it's
  // actually fixed to - given as ECEF or LLA depending on the lla flag (the
  // receiver reports it however it was last configured; this app always
  // SETs fixed mode as LLA - see encodeSetTmode3 - so an ECEF response here
  // means someone set it another way, e.g. u-center), so lat/lon/heightM
  // end up populated either way.
  _decodeTmode3(p) {
    const flags = p.readUInt16LE(2);
    const mode = flags & 0xff; // 0=disabled, 1=survey-in, 2=fixed
    const lla = (flags >> 8) & 1;
    const result = { mode, timestamp: Date.now() };
    if (mode === 2) {
      const aMain = p.readInt32LE(4);
      const bMain = p.readInt32LE(8);
      const cMain = p.readInt32LE(12);
      const aHp = p.readInt8(16);
      const bHp = p.readInt8(17);
      const cHp = p.readInt8(18);
      if (lla) {
        result.lat = (aMain * 100 + aHp) / 1e9;
        result.lon = (bMain * 100 + bHp) / 1e9;
        result.heightM = (cMain * 100 + cHp) / 1e4;
      } else {
        Object.assign(result, ecefToLla((aMain * 100 + aHp) / 1e4, (bMain * 100 + bHp) / 1e4, (cMain * 100 + cHp) / 1e4));
      }
      result.fixedPosAccMm = p.readUInt32LE(20) / 10;
    }
    return result;
  }

  // Reported once per incoming RTCM3 message the receiver's radio link
  // actually decodes - the only direct evidence (short of a scope on the
  // correction radio itself) that RTCM is arriving at all, since that link
  // is entirely separate hardware this app otherwise never touches (see
  // README's "Wiring notes"). msgUsed only reflects whether the receiver
  // could apply it (e.g. an as-yet-unneeded message type isn't a problem;
  // crcFailed is), not whether the overall correction stream is healthy -
  // see boatAgent.js's own rxm-rtcm handler for what actually gets logged.
  _decodeRxmRtcm(p) {
    const flags = p.readUInt8(1);
    return {
      crcFailed: !!(flags & 0x01),
      msgUsed: (flags >> 1) & 0x03, // 0 unknown, 1 not used, 2 used
      subType: p.readUInt16LE(2), // only meaningful for RTCM message type 4072
      refStation: p.readUInt16LE(4),
      msgType: p.readUInt16LE(6), // the actual RTCM3 message type, e.g. 1005, 1077
      timestamp: Date.now(),
    };
  }
}

const TMODE3_MODE_NAMES = { 0: 'disabled', 1: 'survey-in', 2: 'fixed' };
const RTCM_MSG_USED_NAMES = { 0: 'unknown', 1: 'not used', 2: 'used' };

module.exports = {
  UbxParser,
  PVT_LENGTH,
  SVIN_LENGTH,
  TMODE3_LENGTH,
  encodePollRequest,
  encodeSetTmode3,
  encodeSaveConfig,
  encodeNavPvt,
  ecefToLla,
  TMODE3_MODE_NAMES,
  RTCM_MSG_USED_NAMES,
  CLASS_CFG,
  ID_CFG_TMODE3,
};
