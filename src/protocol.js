// Compact fixed-length frame sent over the telemetry radio. Kept small on
// purpose: every byte costs airtime, and long-range links are often
// bandwidth-limited (a few kbps). This frame is FRAME_LEN bytes total.
//
// Layout (all little-endian):
//   [0]        sync byte        0xAA
//   [1..5]     boatId           BOAT_ID_LEN raw ASCII bytes, A-Z only (see
//                                boatIdFile.js) - not bit-packed (26 letters
//                                would fit in ~24 bits instead of 40) since
//                                the few bytes saved isn't worth the extra
//                                encode/decode complexity next to every
//                                other field here being a plain fixed-width
//                                number.
//   [6..9]     unix time (s)    uint32
//   [10..11]   ms within second uint16  (0-999 - full unix-time precision
//                                        without needing a 64-bit field or a
//                                        shared custom epoch)
//   [12..15]   lat * 1e7        int32
//   [16..19]   lon * 1e7        int32
//   [20..21]   speed (0.1 kn)   uint16
//   [22..23]   heading (0.1deg) uint16
//   [24]       status           uint8  (bit0 fixOk, bits1-2 carrSoln, bits3-7 numSV)
//   [25]       checksum         uint8  (sum of bytes 1..24 mod 256)
//
// WIRE-FORMAT CHANGE: this frame was 27 bytes (one extra always-zero,
// never-read "reserved" byte at the old [25], checksum at [26]) before the
// reserved byte was removed as dead weight - see the radio-efficiency audit
// this came out of. Every boat AND the base must run this updated
// protocol.js together - there's no backward compatibility here (a 26-byte
// sender talking to a 27-byte-expecting receiver, or vice versa, just
// checksum-fails/sync-errors on every single frame, never decodes), so this
// is a coordinated fleet-wide update, not something to roll out gradually.

const { MARK_NAMES } = require('./course');

const SYNC = 0xaa;
// Length of the boatId field itself (see boatIdFile.js's own comment on why
// 5 uppercase letters - short enough to cost little extra airtime over the
// old single-byte numeric id, long enough that random generation across a
// whole fleet is only very remotely likely to ever collide).
const BOAT_ID_LEN = 5;

// Everything in a fix except sync/boatId/checksum - shared byte-for-byte by
// the plain single-fix frame below and the batch frame further down, so the
// two only ever differ in framing (how many fixes, whose boatId), never in
// how one fix's own fields are laid out on the wire.
const FIX_FIELDS_LEN = 4 + 2 + 4 + 4 + 2 + 2 + 1; // time_s+time_ms+lat+lon+speed+heading+status = 19

function writeFixFields(buf, offset, pvt) {
  buf.writeUInt32LE(Math.floor(pvt.timestamp / 1000), offset);
  buf.writeUInt16LE(pvt.timestamp % 1000, offset + 4);
  buf.writeInt32LE(Math.round(pvt.lat * 1e7), offset + 6);
  buf.writeInt32LE(Math.round(pvt.lon * 1e7), offset + 10);

  const speedKnots = (pvt.gSpeedMmS / 1000) * 1.94384; // mm/s -> knots
  buf.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(speedKnots * 10))), offset + 14);

  const heading = ((pvt.headMotDeg % 360) + 360) % 360;
  buf.writeUInt16LE(Math.round(heading * 10), offset + 16);

  const status =
    (pvt.gnssFixOk ? 1 : 0) |
    ((pvt.carrSoln & 0x03) << 1) |
    ((Math.min(pvt.numSV, 31) & 0x1f) << 3);
  buf.writeUInt8(status, offset + 18);
}

function readFixFields(buf, offset) {
  const status = buf.readUInt8(offset + 18);
  return {
    timestamp: buf.readUInt32LE(offset) * 1000 + buf.readUInt16LE(offset + 4),
    lat: buf.readInt32LE(offset + 6) / 1e7,
    lon: buf.readInt32LE(offset + 10) / 1e7,
    speedKnots: buf.readUInt16LE(offset + 14) / 10,
    headingDeg: buf.readUInt16LE(offset + 16) / 10,
    gnssFixOk: !!(status & 0x01),
    carrSoln: (status >> 1) & 0x03,
    numSV: (status >> 3) & 0x1f,
  };
}

const FRAME_LEN = 1 + BOAT_ID_LEN + FIX_FIELDS_LEN + 1;

function encode(boatId, pvt) {
  if (typeof boatId !== 'string' || boatId.length !== BOAT_ID_LEN) {
    throw new Error(`boatId must be exactly ${BOAT_ID_LEN} characters, got ${JSON.stringify(boatId)}`);
  }
  const buf = Buffer.alloc(FRAME_LEN);
  buf.writeUInt8(SYNC, 0);
  buf.write(boatId, 1, BOAT_ID_LEN, 'ascii');
  writeFixFields(buf, 1 + BOAT_ID_LEN, pvt);

  let sum = 0;
  for (let i = 1; i < FRAME_LEN - 1; i++) sum = (sum + buf[i]) & 0xff;
  buf.writeUInt8(sum, FRAME_LEN - 1);

  return buf;
}

// Returns decoded object, or null if the buffer isn't a valid frame.
function decode(buf) {
  if (buf.length !== FRAME_LEN || buf[0] !== SYNC) return null;

  let sum = 0;
  for (let i = 1; i < FRAME_LEN - 1; i++) sum = (sum + buf[i]) & 0xff;
  if (sum !== buf[FRAME_LEN - 1]) return null; // checksum mismatch

  const offset = 1 + BOAT_ID_LEN;
  return {
    boatId: buf.toString('ascii', 1, offset),
    ...readFixFields(buf, offset),
  };
}

// Second frame type: base station -> all boats, broadcasting the current
// course marks (see redisStore.js's mark:* keys) so a rover can know the
// course without ever needing its own Redis access - it just remembers
// whatever the base last broadcast (see boatAgent.js's on-disk persistence).
// Also carries the base's own IP/port for the log-upload HTTP server (see
// uploadServer.js/uploadClient.js), plus the port its admin dashboard
// listens on (see adminServer.js) so a rover can link back to it (see
// roverAdminServer.js) without assuming it matches the rover's own
// ADMIN_PORT - riding along on the same frame and the same broadcast
// triggers (startup, new boat, periodic heartbeat) rather than needing a
// separate frame type and its own broadcast-timing logic. Given its own
// sync byte since it isn't the same length as the position frame, so a
// byte-stream scanner (radioLink.js) can tell them apart before it knows
// how many bytes to consume.
//
// Layout (all little-endian), marks in MARK_NAMES order (currently 8:
// windwardGreen/windwardBlack/leewardGreen/leewardBlack/pin/committeeStart/
// committeeFinish/finish - see course.js):
//   [0]  sync byte     0xBB
//   ...  MARK_NAMES.length x { lat*1e7 int32, lon*1e7 int32 }  (8 bytes each)
//   ...  base IP       4 bytes, one octet each (0.0.0.0 = unknown/none)
//   ...  base upload port  uint16
//   ...  base admin port   uint16
//   ...  pin boundary gate uint8  (0/1 - see course.js's own comment on
//                                   PIN_BOUNDARY_MARK/getPinBoundaryFarPoint)
//   ...  regatta name   REGATTA_NAME_LEN raw ASCII bytes, zero-padded/
//                        truncated (see baseStation.js's selectedRegatta.name -
//                        this frame only ever goes out once a regatta is
//                        selected, so there's no "none" case here) - a
//                        small dashboard hint (roverAdminServer.js), not an
//                        authoritative copy of anything; a rover never acts
//                        on this beyond displaying it
//   [last] checksum     uint8  (sum of all preceding bytes mod 256)
// Total length is MARKS_FRAME_LEN below - deliberately not hardcoded here
// as fixed byte offsets, since it shifts whenever MARK_NAMES grows/shrinks.
//
// The pin boundary gate rides on this frame as a single on/off bit, not a
// lat/lon pair - unlike every real mark above, it has no position of its
// own to transmit: when on, a rover derives its endpoint itself, fresh
// every time, from whichever pin/committeeStart positions this same frame
// already carries (see simGps.js/course.js's getPinBoundaryFarPoint) -
// exactly what keeps it from ever going stale if pin or committeeStart gets
// edited later without a fresh gate broadcast landing at the same instant.

const MARKS_SYNC = 0xbb;
// The most bytes this fleet's radios can send as one RF packet (the XBee-PRO
// 900HP 200K's read-only NP - see config/README's "Batching" notes). A frame
// longer than this is split by the radio into two over-the-air packets with
// no acknowledgement: if either is lost, or another transmitter's packet lands
// between them, the whole frame is lost (see radioLink.js's scanner). Every
// frame here is kept at or under it - checked at load time below.
const RADIO_MAX_PAYLOAD = 100;

// Truncated if longer - this is a small dashboard label, not the
// authoritative name (RegattaUp's own record is that), so a long real
// regatta name losing its tail here costs nothing beyond the display hint
// itself being less complete. Sized so the whole marks frame is exactly
// RADIO_MAX_PAYLOAD (it was 75 bytes before the name existed): 1 + 8*8 + 4 +
// 2 + 2 + 1 + 25 + 1 = 100.
const REGATTA_NAME_LEN = 25;
const MARKS_FRAME_LEN = 1 + MARK_NAMES.length * 8 + 4 + 2 + 2 + 1 + REGATTA_NAME_LEN + 1;
if (MARKS_FRAME_LEN > RADIO_MAX_PAYLOAD) {
  throw new Error(`marks frame is ${MARKS_FRAME_LEN} bytes, over the radio's ${RADIO_MAX_PAYLOAD}-byte payload limit - shorten REGATTA_NAME_LEN`);
}

function encodeMarks(marks, baseInfo = {}) {
  const buf = Buffer.alloc(MARKS_FRAME_LEN);
  buf.writeUInt8(MARKS_SYNC, 0);
  let offset = 1;
  for (const name of MARK_NAMES) {
    buf.writeInt32LE(Math.round(marks[name].lat * 1e7), offset);
    buf.writeInt32LE(Math.round(marks[name].lon * 1e7), offset + 4);
    offset += 8;
  }

  const ipOctets = (baseInfo.ip || '0.0.0.0').split('.').map((n) => parseInt(n, 10) & 0xff);
  for (let i = 0; i < 4; i++) buf.writeUInt8(ipOctets[i] || 0, offset + i);
  offset += 4;
  buf.writeUInt16LE(baseInfo.port || 0, offset);
  offset += 2;
  buf.writeUInt16LE(baseInfo.adminPort || 0, offset);
  offset += 2;
  buf.writeUInt8(marks.pinBoundaryEnabled ? 1 : 0, offset);
  offset += 1;
  // Buffer.alloc above already zero-filled the whole frame, so a shorter
  // (or absent) name just leaves the rest of this field as trailing zero
  // bytes - buf.write only ever writes what the string itself needs, never
  // pads on its own.
  buf.write((baseInfo.regattaName || '').slice(0, REGATTA_NAME_LEN), offset, REGATTA_NAME_LEN, 'ascii');
  offset += REGATTA_NAME_LEN;

  let sum = 0;
  for (let i = 1; i < MARKS_FRAME_LEN - 1; i++) sum = (sum + buf[i]) & 0xff;
  buf.writeUInt8(sum, MARKS_FRAME_LEN - 1);

  return buf;
}

// Returns { marks: { windward: {lat,lon}, ..., pinBoundaryEnabled: bool },
// baseIp, basePort, baseAdminPort, regattaName }, or null if the buffer
// isn't a valid marks frame. baseIp is '0.0.0.0' if the base doesn't have
// (or hasn't been told) an address to publish.
function decodeMarks(buf) {
  if (buf.length !== MARKS_FRAME_LEN || buf[0] !== MARKS_SYNC) return null;

  let sum = 0;
  for (let i = 1; i < MARKS_FRAME_LEN - 1; i++) sum = (sum + buf[i]) & 0xff;
  if (sum !== buf[MARKS_FRAME_LEN - 1]) return null;

  const marks = {};
  let offset = 1;
  for (const name of MARK_NAMES) {
    marks[name] = { lat: buf.readInt32LE(offset) / 1e7, lon: buf.readInt32LE(offset + 4) / 1e7 };
    offset += 8;
  }

  const baseIp = `${buf.readUInt8(offset)}.${buf.readUInt8(offset + 1)}.${buf.readUInt8(offset + 2)}.${buf.readUInt8(offset + 3)}`;
  offset += 4;
  const basePort = buf.readUInt16LE(offset);
  offset += 2;
  const baseAdminPort = buf.readUInt16LE(offset);
  offset += 2;
  marks.pinBoundaryEnabled = buf.readUInt8(offset) === 1;
  offset += 1;
  // split('\0')[0] rather than a trailing-only trim - the zero-padding
  // always starts right after the real name ends (see encodeMarks above),
  // so the first NUL byte is always exactly where the real name stops.
  const regattaName = buf.toString('ascii', offset, offset + REGATTA_NAME_LEN).split('\0')[0];
  offset += REGATTA_NAME_LEN;

  return { marks, baseIp, basePort, baseAdminPort, regattaName };
}

// Third frame type: base station -> all boats, asking every boat to report
// its current position right now, regardless of the normal TX_DISTANCE_M
// movement gate (see boatAgent.js's handlePvt) - for a boat that's been
// sitting stationary on the start line since before the base/dashboard was
// even up: it already sent its one and only frame at that old position (a
// stationary boat never clears the movement gate again - see
// onGridWatcher.js's own module comment on this), so the base has no way to
// learn it's actually there, on-grid, right now, without asking. An
// operator triggers this from the admin dashboard's "Ping fleet" button
// (see adminServer.js/baseStation.js's pingFleet) - not automatic, so it
// doesn't add its own recurring airtime cost on top of the normal
// broadcast/report traffic.
//
// No payload beyond a timestamp - the request itself carries no per-boat
// information, it's the same broadcast every boat hears and responds to
// independently (each with its own random delay - see boatAgent.js's own
// handling - so a whole fleet doesn't all key up over each other on the
// same shared channel at once). A boat's *response* to a ping is just an
// ordinary position frame (encode/decode above) - there's no separate
// "pong" frame type, since the payload is identical to any other report.
//
// Layout (all little-endian):
//   [0]    sync byte     0xCC
//   [1..4] unix time (s) uint32
//   [5]    checksum      uint8  (sum of bytes 1..4 mod 256)

const PING_SYNC = 0xcc;
const PING_FRAME_LEN = 6;

function encodePing() {
  const buf = Buffer.alloc(PING_FRAME_LEN);
  buf.writeUInt8(PING_SYNC, 0);
  buf.writeUInt32LE(Math.floor(Date.now() / 1000), 1);
  let sum = 0;
  for (let i = 1; i < PING_FRAME_LEN - 1; i++) sum = (sum + buf[i]) & 0xff;
  buf.writeUInt8(sum, PING_FRAME_LEN - 1);
  return buf;
}

// Returns { timestamp } (ms, reconstructed from the whole-second unix time
// carried on the wire), or null if the buffer isn't a valid ping frame.
function decodePing(buf) {
  if (buf.length !== PING_FRAME_LEN || buf[0] !== PING_SYNC) return null;
  let sum = 0;
  for (let i = 1; i < PING_FRAME_LEN - 1; i++) sum = (sum + buf[i]) & 0xff;
  if (sum !== buf[PING_FRAME_LEN - 1]) return null;
  return { timestamp: buf.readUInt32LE(1) * 1000 };
}

// Boat -> base only, sent unprompted right at radio startup, before any
// GPS fix exists - see boatAgent.js's own startup hello logic. The
// opposite direction/purpose from PING above (base -> boats, "report your
// current position now," and a boat with no fix yet can't even answer -
// see radio.on('ping', ...)'s own hasValidFix guard): this is the boat
// announcing itself unprompted specifically to cover the gap before a
// first real fix exists, so the base's dashboard can show "boat online,
// radio confirmed, still waiting on GPS" instead of nothing at all.
// Carries just the boat's own id - there's no position to report yet, and
// unlike a real position frame this is never written to CSV/Redis/
// RegattaUp (see baseStation.js's own radio.on('hello', ...)) - it only
// ever updates the live dashboard's "last seen," nothing durable.
//
// Layout (all little-endian):
//   [0]    sync byte  0xDD
//   [1..5] boatId     BOAT_ID_LEN raw ASCII bytes (same field as encode/decode above)
//   [6]    checksum   uint8 (sum of bytes 1..5 mod 256)

const HELLO_SYNC = 0xdd;
const HELLO_FRAME_LEN = 1 + BOAT_ID_LEN + 1;

function encodeHello(boatId) {
  if (typeof boatId !== 'string' || boatId.length !== BOAT_ID_LEN) {
    throw new Error(`boatId must be exactly ${BOAT_ID_LEN} characters, got ${JSON.stringify(boatId)}`);
  }
  const buf = Buffer.alloc(HELLO_FRAME_LEN);
  buf.writeUInt8(HELLO_SYNC, 0);
  buf.write(boatId, 1, BOAT_ID_LEN, 'ascii');
  let sum = 0;
  for (let i = 1; i < HELLO_FRAME_LEN - 1; i++) sum = (sum + buf[i]) & 0xff;
  buf.writeUInt8(sum, HELLO_FRAME_LEN - 1);
  return buf;
}

// Returns { boatId }, or null if the buffer isn't a valid hello frame.
function decodeHello(buf) {
  if (buf.length !== HELLO_FRAME_LEN || buf[0] !== HELLO_SYNC) return null;
  let sum = 0;
  for (let i = 1; i < HELLO_FRAME_LEN - 1; i++) sum = (sum + buf[i]) & 0xff;
  if (sum !== buf[HELLO_FRAME_LEN - 1]) return null;
  return { boatId: buf.toString('ascii', 1, 1 + BOAT_ID_LEN) };
}

// Fifth frame type: boat -> base, an optional batched variant of the plain
// position frame above - packs several consecutive fixes from the SAME boat
// into one radio transmission instead of one each (see config.js's
// TX_BATCH_SIZE/boatAgent.js's queueFixForTx), trading a little latency
// (fixes wait to be batched) for fewer, larger over-the-air transmissions -
// worth it only if per-transmission overhead, not per-byte airtime, is the
// actual bottleneck (see the XBee-PRO 900HP/XSC S3B User Guide's NP command -
// 256 RF payload bytes on the standard 900HP, but read-only and as low as
// 100 on this fleet's actual radios (the "900HP 200K" variant - higher RF
// data rate, smaller max payload per packet) - MAX_BATCH_COUNT below is
// chosen to stay comfortably under the SMALLER of those, not the datasheet
// default, even after encryption's -9 byte reduction).
// Sent by default (config.js's TX_BATCH_SIZE now defaults to 4, chosen
// from this fleet's own congestion-testing findings - see the README's
// "Congestion-testing the radio") - TX_BATCH_SIZE=1 is what falls back to
// the plain single-fix frame above, this app's original one-frame-per-fix
// behavior, unchanged at that setting.
//
// Layout (all little-endian):
//   [0]     sync byte     0xEE
//   [1]     count         uint8 (1..MAX_BATCH_COUNT) - how many fixes follow
//   [2..6]  boatId        BOAT_ID_LEN bytes, shared by every fix below (a
//                          batch is always one boat's own consecutive fixes,
//                          never a mix of boats)
//   [7..]   count x FIX_FIELDS_LEN-byte fix records (see writeFixFields/
//            readFixFields above), oldest fix first
//   [last]  checksum      uint8 (sum of bytes 1..N-2 mod 256)

const BATCH_SYNC = 0xee;
const BATCH_HEADER_LEN = 1 + 1 + BOAT_ID_LEN; // sync + count + boatId = 7
const MAX_BATCH_COUNT = 4; // largest batch frame: 7 + 4*19 + 1 = 84 bytes - fits under this fleet's actual (read-only) NP=100, not the standard 900HP's 256

function batchFrameLen(count) {
  return BATCH_HEADER_LEN + count * FIX_FIELDS_LEN + 1;
}

// Reads just enough of a candidate buffer to know the FULL length of the
// batch frame it's the start of, without needing that whole frame in hand
// yet - radioLink.js's byte-stream scanner needs this since (unlike every
// other frame type here) this one's length isn't a fixed constant. Returns
// null if there aren't even enough bytes to read the count byte yet (wait
// for more data), or a small definite length if the count byte reads as out
// of range - never a length computed from an unvalidated count, so a false
// sync-byte match on random noise can't stall the scanner waiting on an
// implausibly large frame that will never arrive; decodeBatch below
// re-validates count independently regardless.
function batchFrameLenFromHeader(buf) {
  if (buf.length < BATCH_HEADER_LEN) return null;
  const count = buf.readUInt8(1);
  if (count < 1 || count > MAX_BATCH_COUNT) return BATCH_HEADER_LEN + 1;
  return batchFrameLen(count);
}

function encodeBatch(boatId, pvts) {
  if (typeof boatId !== 'string' || boatId.length !== BOAT_ID_LEN) {
    throw new Error(`boatId must be exactly ${BOAT_ID_LEN} characters, got ${JSON.stringify(boatId)}`);
  }
  if (!Array.isArray(pvts) || pvts.length < 1 || pvts.length > MAX_BATCH_COUNT) {
    throw new Error(`encodeBatch needs 1-${MAX_BATCH_COUNT} fixes, got ${Array.isArray(pvts) ? pvts.length : typeof pvts}`);
  }

  const len = batchFrameLen(pvts.length);
  const buf = Buffer.alloc(len);
  buf.writeUInt8(BATCH_SYNC, 0);
  buf.writeUInt8(pvts.length, 1);
  buf.write(boatId, 2, BOAT_ID_LEN, 'ascii');

  let offset = BATCH_HEADER_LEN;
  for (const pvt of pvts) {
    writeFixFields(buf, offset, pvt);
    offset += FIX_FIELDS_LEN;
  }

  let sum = 0;
  for (let i = 1; i < len - 1; i++) sum = (sum + buf[i]) & 0xff;
  buf.writeUInt8(sum, len - 1);

  return buf;
}

// Returns an array of decoded fixes (each shaped exactly like decode()'s own
// return value, sharing the one boatId carried in the header), oldest fix
// first - or null if the buffer isn't a valid batch frame.
function decodeBatch(buf) {
  if (buf.length < BATCH_HEADER_LEN + 1 || buf[0] !== BATCH_SYNC) return null;
  const count = buf.readUInt8(1);
  if (count < 1 || count > MAX_BATCH_COUNT) return null;
  const len = batchFrameLen(count);
  if (buf.length !== len) return null;

  let sum = 0;
  for (let i = 1; i < len - 1; i++) sum = (sum + buf[i]) & 0xff;
  if (sum !== buf[len - 1]) return null;

  const boatId = buf.toString('ascii', 2, 2 + BOAT_ID_LEN);
  const fixes = [];
  let offset = BATCH_HEADER_LEN;
  for (let i = 0; i < count; i++) {
    fixes.push({ boatId, ...readFixFields(buf, offset) });
    offset += FIX_FIELDS_LEN;
  }
  return fixes;
}

// Sixth frame type: boat -> base, an operator (or mark mode's own
// automatic gate - see config.markMode) asking the base to set a specific
// course mark to THIS boat's own current position - see
// roverAdminServer.js's "Set mark here" card/boatAgent.js's sendSetMark.
// Built for exactly the field case this whole app exists for: an operator
// physically places a mark, then sets it from the rover's own touchscreen
// with no WiFi in reach at all - the existing WiFi-only cross-origin POST
// straight to the base's /api/marks/:name (see adminServer.js) simply
// isn't reachable there, so this rides the same telemetry radio a
// position fix already goes out on instead.
//
// No ack frame type exists in this protocol for anything (hello/ping don't
// get one either) - confirmation is the base's own re-broadcast of the
// updated course the instant it applies the change (see baseStation.js's
// radio.on('set-mark', ...), which calls the exact same setMarkLocation
// the WiFi path already uses), picked up the normal way by this boat's own
// radio.on('marks', ...) handler and shown on the dashboard's Course marks
// card - not a special-purpose response to this frame.
//
// Layout (all little-endian):
//   [0]      sync byte     0xFF
//   [1..5]   boatId        BOAT_ID_LEN raw ASCII bytes (same field as encode/decode above)
//   [6]      mark index    uint8 - index into MARK_NAMES (see course.js),
//                           not a string, to keep this frame as small as
//                           every other one here
//   [7]      continuous    uint8 (0/1) - whether this update came from mark
//                           mode's own automatic movement gate (see config
//                           .markMode/boatAgent.js's handlePvt), as opposed
//                           to a manual one-off markset tap. Purely
//                           informational - the base applies either one
//                           identically (setMarkLocation doesn't care) -
//                           but it's what lets the base's own admin map
//                           warn an operator that a mark is currently being
//                           driven by a mark-mode rover before they
//                           overwrite it with a manual edit that will just
//                           get reset on that rover's next auto-send (see
//                           baseStation.js's markRepresentedBy).
//   [8..11]  lat * 1e7     int32
//   [12..15] lon * 1e7     int32
//   [16]     checksum      uint8 (sum of bytes 1..15 mod 256)

const SET_MARK_SYNC = 0xff;
const SET_MARK_FRAME_LEN = 1 + BOAT_ID_LEN + 1 + 1 + 4 + 4 + 1;

function encodeSetMark(boatId, markName, lat, lon, { continuous } = {}) {
  if (typeof boatId !== 'string' || boatId.length !== BOAT_ID_LEN) {
    throw new Error(`boatId must be exactly ${BOAT_ID_LEN} characters, got ${JSON.stringify(boatId)}`);
  }
  const markIndex = MARK_NAMES.indexOf(markName);
  if (markIndex === -1) throw new Error(`unknown mark name: ${markName}`);

  const buf = Buffer.alloc(SET_MARK_FRAME_LEN);
  buf.writeUInt8(SET_MARK_SYNC, 0);
  buf.write(boatId, 1, BOAT_ID_LEN, 'ascii');
  buf.writeUInt8(markIndex, 1 + BOAT_ID_LEN);
  buf.writeUInt8(continuous ? 1 : 0, 1 + BOAT_ID_LEN + 1);
  buf.writeInt32LE(Math.round(lat * 1e7), 1 + BOAT_ID_LEN + 2);
  buf.writeInt32LE(Math.round(lon * 1e7), 1 + BOAT_ID_LEN + 2 + 4);

  let sum = 0;
  for (let i = 1; i < SET_MARK_FRAME_LEN - 1; i++) sum = (sum + buf[i]) & 0xff;
  buf.writeUInt8(sum, SET_MARK_FRAME_LEN - 1);

  return buf;
}

// Returns { boatId, markName, lat, lon, continuous }, or null if the
// buffer isn't a valid set-mark frame - including a mark index past the
// end of MARK_NAMES (corrupted/from a version with a different MARK_NAMES
// list, never trusted as-is) or a lat/lon outside real-world range (same
// bounds setMarkLocation itself enforces - rejected here too so a decode
// failure reads the same way regardless of which check catches it).
function decodeSetMark(buf) {
  if (buf.length !== SET_MARK_FRAME_LEN || buf[0] !== SET_MARK_SYNC) return null;

  let sum = 0;
  for (let i = 1; i < SET_MARK_FRAME_LEN - 1; i++) sum = (sum + buf[i]) & 0xff;
  if (sum !== buf[SET_MARK_FRAME_LEN - 1]) return null;

  const markIndex = buf.readUInt8(1 + BOAT_ID_LEN);
  if (markIndex >= MARK_NAMES.length) return null;
  const continuous = buf.readUInt8(1 + BOAT_ID_LEN + 1) === 1;
  const lat = buf.readInt32LE(1 + BOAT_ID_LEN + 2) / 1e7;
  const lon = buf.readInt32LE(1 + BOAT_ID_LEN + 2 + 4) / 1e7;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  return {
    boatId: buf.toString('ascii', 1, 1 + BOAT_ID_LEN),
    markName: MARK_NAMES[markIndex],
    lat,
    lon,
    continuous,
  };
}

// Seventh frame type: boat -> base, an operator marking a moment in the
// base's own log with a short free-text note - see roverAdminServer.js's
// "Mark log" card/boatAgent.js's sendMarkLog. Built for exactly the field-
// testing case this comes out of: walking/driving a rover to a new
// position (or making any other physical change - antenna orientation,
// power cycle) and wanting that moment to show up inline in whatever the
// base is already logging (see baseStation.js's radio.on('mark-log', ...),
// which annotates the SAME rate-stats CSV config.logRateStats writes to -
// see its own comment), rather than having to cross-reference two separate
// logs by wall-clock time after the fact.
//
// No position of its own - unlike Set-Mark above, this isn't about a
// physical location, just a labeled instant. No ack (same as every other
// frame here) - there's nothing to confirm back, the operator sees their
// own tap succeed or fail locally on the rover's own dashboard.
//
// Layout (all little-endian):
//   [0]      sync byte     0x88
//   [1..5]   boatId        BOAT_ID_LEN raw ASCII bytes (same field as encode/decode above)
//   [6..25]  label         MARK_LOG_LABEL_LEN raw ASCII bytes, zero-padded/
//                            truncated (same convention as encodeMarks'
//                            own regattaName field)
//   [26]     checksum      uint8 (sum of bytes 1..25 mod 256)

const MARK_LOG_SYNC = 0x88;
const MARK_LOG_LABEL_LEN = 20;
const MARK_LOG_FRAME_LEN = 1 + BOAT_ID_LEN + MARK_LOG_LABEL_LEN + 1;

function encodeMarkLog(boatId, label) {
  if (typeof boatId !== 'string' || boatId.length !== BOAT_ID_LEN) {
    throw new Error(`boatId must be exactly ${BOAT_ID_LEN} characters, got ${JSON.stringify(boatId)}`);
  }
  const buf = Buffer.alloc(MARK_LOG_FRAME_LEN);
  buf.writeUInt8(MARK_LOG_SYNC, 0);
  buf.write(boatId, 1, BOAT_ID_LEN, 'ascii');
  // Buffer.alloc above already zero-filled the frame, so a shorter (or
  // absent) label just leaves the rest of this field as trailing zero
  // bytes - same reasoning as encodeMarks' own regattaName field.
  buf.write((label || '').slice(0, MARK_LOG_LABEL_LEN), 1 + BOAT_ID_LEN, MARK_LOG_LABEL_LEN, 'ascii');

  let sum = 0;
  for (let i = 1; i < MARK_LOG_FRAME_LEN - 1; i++) sum = (sum + buf[i]) & 0xff;
  buf.writeUInt8(sum, MARK_LOG_FRAME_LEN - 1);

  return buf;
}

// Returns { boatId, label }, or null if the buffer isn't a valid mark-log
// frame. label is '' when sent with no text (a plain "mark this moment"
// tap, no note attached).
function decodeMarkLog(buf) {
  if (buf.length !== MARK_LOG_FRAME_LEN || buf[0] !== MARK_LOG_SYNC) return null;

  let sum = 0;
  for (let i = 1; i < MARK_LOG_FRAME_LEN - 1; i++) sum = (sum + buf[i]) & 0xff;
  if (sum !== buf[MARK_LOG_FRAME_LEN - 1]) return null;

  const label = buf.toString('ascii', 1 + BOAT_ID_LEN, 1 + BOAT_ID_LEN + MARK_LOG_LABEL_LEN).split('\0')[0];
  return {
    boatId: buf.toString('ascii', 1, 1 + BOAT_ID_LEN),
    label,
  };
}

// Eleventh frame type: boat -> base, a delta-coded batch - the same idea as the batch frame above (one
// boat's consecutive fixes in one radio transmission) but only the FIRST fix is sent in full; every
// later fix is sent as its change from the one before, which is 8 bytes instead of 19. Eight fixes
// fit in 83 bytes (the old batch frame needed 84 for four), so a boat can send 8 Hz - or 5 Hz, or 7
// Hz - in one frame per correction cycle without a bigger slot (see slotTable.js / txScheduler.js).
//
// What is exact and what is rounded, for the fixes after the first in a frame:
//   lat, lon, speed   exact (changes in the same 1e-7 degree / 0.1 knot units the full fix uses)
//   time              rounded to 2 ms (the change is a uint8 in 2 ms units, so up to 510 ms)
//   heading           rounded to 0.5 degree (the change is an int8 in 0.5 degree units, +-63.5)
// The encoder works from the values the decoder will rebuild, not the originals, so nothing drifts
// along a frame. A fix whose change does not fit (a GPS jump, a gap over 510 ms, a turn of more than
// 63 degrees between fixes) simply starts a new frame, which always opens with a full fix - see
// encodeDeltaFrames. Frames are self-contained: losing one never corrupts the next.
//
// Layout (all little-endian):
//   [0]      sync byte   0xE7
//   [1]      count       uint8 (2..MAX_DELTA_COUNT) - fixes in this frame
//   [2..6]   boatId      BOAT_ID_LEN bytes
//   [7..25]  first fix   FIX_FIELDS_LEN bytes, exactly as in the plain frame
//   then count-1 deltas of DELTA_FIX_LEN (8) bytes each:
//     +0  dt        uint8   time since the previous fix, 2 ms units
//     +1  dlat      int16   1e-7 degrees
//     +3  dlon      int16   1e-7 degrees
//     +5  dspeed    int8    0.1 knot units
//     +6  dheading  int8    0.5 degree units, shortest way round
//     +7  status    uint8   same bit layout as the full fix
//   [last]   checksum    uint8 (sum of bytes 1..N-2 mod 256)

const DELTA_SYNC = 0xe7;
const DELTA_HEADER_LEN = 1 + 1 + BOAT_ID_LEN; // 7
const DELTA_FIX_LEN = 8;
const MAX_DELTA_COUNT = 8; // 7 + 19 + 7*8 + 1 = 83 bytes - no bigger than the 84-byte batch frame the slots are sized for

function deltaFrameLen(count) {
  return DELTA_HEADER_LEN + FIX_FIELDS_LEN + (count - 1) * DELTA_FIX_LEN + 1;
}

// Same job as batchFrameLenFromHeader: the length from the header alone, never from an out-of-range
// count, so a false 0xE7 on noise can't stall the byte-stream scanner.
function deltaFrameLenFromHeader(buf) {
  if (buf.length < DELTA_HEADER_LEN) return null;
  const count = buf.readUInt8(1);
  if (count < 2 || count > MAX_DELTA_COUNT) return DELTA_HEADER_LEN + 1;
  return deltaFrameLen(count);
}

function fixInts(pvt) {
  const heading = ((pvt.headMotDeg % 360) + 360) % 360;
  return {
    ts: pvt.timestamp,
    lat: Math.round(pvt.lat * 1e7),
    lon: Math.round(pvt.lon * 1e7),
    speed: Math.max(0, Math.min(65535, Math.round(((pvt.gSpeedMmS / 1000) * 1.94384) * 10))),
    heading: Math.round(heading * 10),
    status: (pvt.gnssFixOk ? 1 : 0) | ((pvt.carrSoln & 0x03) << 1) | ((Math.min(pvt.numSV, 31) & 0x1f) << 3),
  };
}

// How `next` is written as a change from `prev` (both in fixInts form, prev being what the decoder will
// have), or null when a field's change does not fit.
function deltaOf(prev, next) {
  const dt = Math.round((next.ts - prev.ts) / 2);
  const dlat = next.lat - prev.lat;
  const dlon = next.lon - prev.lon;
  const dspeed = next.speed - prev.speed;
  const diff = ((((next.heading - prev.heading) % 3600) + 5400) % 3600) - 1800; // shortest signed difference, 0.1 degree units
  const dheading = Math.round(diff / 5);
  if (dt < 0 || dt > 255) return null;
  if (dlat < -32768 || dlat > 32767 || dlon < -32768 || dlon > 32767) return null;
  if (dspeed < -128 || dspeed > 127) return null;
  if (dheading < -128 || dheading > 127) return null;
  return { dt, dlat, dlon, dspeed, dheading, status: next.status };
}

function applyDelta(prev, d) {
  return {
    ts: prev.ts + d.dt * 2,
    lat: prev.lat + d.dlat,
    lon: prev.lon + d.dlon,
    speed: prev.speed + d.dspeed,
    heading: (((prev.heading + d.dheading * 5) % 3600) + 3600) % 3600,
    status: d.status,
  };
}

// Packs `pvts` (oldest first) into as few frames as possible: each frame holds up to MAX_DELTA_COUNT
// fixes, and a new one starts wherever the next fix's change does not fit. Returns
// [{ buf, count }]; a lone fix becomes the plain position frame.
function encodeDeltaFrames(boatId, pvts) {
  if (typeof boatId !== 'string' || boatId.length !== BOAT_ID_LEN) {
    throw new Error(`boatId must be exactly ${BOAT_ID_LEN} characters, got ${JSON.stringify(boatId)}`);
  }
  if (!Array.isArray(pvts) || pvts.length < 1) throw new Error('encodeDeltaFrames needs at least one fix');
  const out = [];
  let i = 0;
  while (i < pvts.length) {
    const first = pvts[i];
    const deltas = [];
    let prev = fixInts(first);
    // the first fix goes out exactly as the full frame writes it, so what the decoder holds is the full value
    let j = i + 1;
    while (j < pvts.length && deltas.length < MAX_DELTA_COUNT - 1) {
      const d = deltaOf(prev, fixInts(pvts[j]));
      if (!d) break;
      deltas.push(d);
      prev = applyDelta(prev, d);
      j++;
    }
    const count = 1 + deltas.length;
    if (count === 1) {
      out.push({ buf: encode(boatId, first), count: 1 });
    } else {
      const len = deltaFrameLen(count);
      const buf = Buffer.alloc(len);
      buf.writeUInt8(DELTA_SYNC, 0);
      buf.writeUInt8(count, 1);
      buf.write(boatId, 2, BOAT_ID_LEN, 'ascii');
      writeFixFields(buf, DELTA_HEADER_LEN, first);
      let offset = DELTA_HEADER_LEN + FIX_FIELDS_LEN;
      for (const d of deltas) {
        buf.writeUInt8(d.dt, offset);
        buf.writeInt16LE(d.dlat, offset + 1);
        buf.writeInt16LE(d.dlon, offset + 3);
        buf.writeInt8(d.dspeed, offset + 5);
        buf.writeInt8(d.dheading, offset + 6);
        buf.writeUInt8(d.status, offset + 7);
        offset += DELTA_FIX_LEN;
      }
      let sum = 0;
      for (let k = 1; k < len - 1; k++) sum = (sum + buf[k]) & 0xff;
      buf.writeUInt8(sum, len - 1);
      out.push({ buf, count });
    }
    i += count;
  }
  return out;
}

// Same shape as decodeBatch: an array of decoded fixes, oldest first, or null if the buffer isn't a valid
// delta frame.
function decodeDeltaBatch(buf) {
  if (buf.length < DELTA_HEADER_LEN + 1 || buf[0] !== DELTA_SYNC) return null;
  const count = buf.readUInt8(1);
  if (count < 2 || count > MAX_DELTA_COUNT) return null;
  const len = deltaFrameLen(count);
  if (buf.length !== len) return null;
  let sum = 0;
  for (let i = 1; i < len - 1; i++) sum = (sum + buf[i]) & 0xff;
  if (sum !== buf[len - 1]) return null;

  const boatId = buf.toString('ascii', 2, 2 + BOAT_ID_LEN);
  const firstFix = readFixFields(buf, DELTA_HEADER_LEN);
  const fixes = [{ boatId, ...firstFix }];
  let prev = {
    ts: firstFix.timestamp,
    lat: buf.readInt32LE(DELTA_HEADER_LEN + 6),
    lon: buf.readInt32LE(DELTA_HEADER_LEN + 10),
    speed: buf.readUInt16LE(DELTA_HEADER_LEN + 14),
    heading: buf.readUInt16LE(DELTA_HEADER_LEN + 16),
    status: buf.readUInt8(DELTA_HEADER_LEN + 18),
  };
  let offset = DELTA_HEADER_LEN + FIX_FIELDS_LEN;
  for (let n = 1; n < count; n++) {
    prev = applyDelta(prev, {
      dt: buf.readUInt8(offset),
      dlat: buf.readInt16LE(offset + 1),
      dlon: buf.readInt16LE(offset + 3),
      dspeed: buf.readInt8(offset + 5),
      dheading: buf.readInt8(offset + 6),
      status: buf.readUInt8(offset + 7),
    });
    fixes.push({
      boatId,
      timestamp: prev.ts,
      lat: prev.lat / 1e7,
      lon: prev.lon / 1e7,
      speedKnots: prev.speed / 10,
      headingDeg: prev.heading / 10,
      gnssFixOk: !!(prev.status & 0x01),
      carrSoln: (prev.status >> 1) & 0x03,
      numSV: (prev.status >> 3) & 0x1f,
    });
    offset += DELTA_FIX_LEN;
  }
  return fixes;
}

// Eighth frame type: base -> boats, a sleep/wake command for the rover's
// radio (see roverSleep.js) - "power" because it's the only frame that
// changes a rover's power state. One frame type for both directions of the
// command, since the two share every field:
//
//   sleep  Tells the targeted rovers to power their radio down and wake it
//          for a short listen window every `sleepS` seconds. Sent while the
//          rovers are awake and listening, so a few quick repeats are enough.
//   wake   Tells whichever targeted rovers hear it to leave sleep. A
//          sleeping rover only listens briefly every `sleepS` seconds and
//          its timer isn't synchronised with the base's, so one wake frame
//          is almost always missed - the base repeats it for a full sleep
//          cycle plus a listen window (see baseStation.js's wakeFleet).
//
// Targeting: count 0 means EVERY rover in range ("all"); otherwise exactly
// `count` boatIds follow and only those rovers act on the frame. A list is
// capped at MAX_POWER_IDS so the frame stays under this fleet's NP=100
// radio payload limit (5 + 18*5 = 95 bytes).
//
// Layout (all little-endian):
//   [0]      sync byte  0x99
//   [1]      action     uint8 (1 = sleep, 2 = wake)
//   [2]      sleepS     uint8 - seconds between listen windows (sleep only;
//                       0 = rover uses its own SLEEP_CYCLE_S default)
//   [3]      count      uint8 - number of boatIds that follow (0 = all)
//   [4..]    boatIds    count * BOAT_ID_LEN raw ASCII bytes
//   [last]   checksum   uint8 (sum of bytes 1..N-2 mod 256)

const POWER_SYNC = 0x99;
const POWER_HEADER_LEN = 4; // sync + action + sleepS + count
const MAX_POWER_IDS = 18; // 4 + 18*5 + 1 = 95 bytes
const POWER_ACTIONS = { sleep: 1, wake: 2 };
const POWER_ACTION_NAMES = { 1: 'sleep', 2: 'wake' };

function powerFrameLen(count) {
  return POWER_HEADER_LEN + count * BOAT_ID_LEN + 1;
}

// Same idea as batchFrameLenFromHeader: lets radioLink.js's byte-stream
// scanner learn the full length from the header alone, and never computes a
// length from an out-of-range count (a false 0x99 on noise must not make the
// scanner wait on a frame that will never arrive).
function powerFrameLenFromHeader(buf) {
  if (buf.length < POWER_HEADER_LEN) return null;
  const count = buf.readUInt8(3);
  if (count > MAX_POWER_IDS) return POWER_HEADER_LEN + 1;
  return powerFrameLen(count);
}

// boatIds: omit/empty = every rover ("all"); otherwise 1..MAX_POWER_IDS ids.
function encodePower(action, { sleepS = 0, boatIds = [] } = {}) {
  if (!POWER_ACTIONS[action]) throw new Error(`power action must be "sleep" or "wake", got ${JSON.stringify(action)}`);
  if (!Number.isInteger(sleepS) || sleepS < 0 || sleepS > 255) throw new Error(`sleepS must be 0-255 seconds, got ${sleepS}`);
  if (!Array.isArray(boatIds) || boatIds.length > MAX_POWER_IDS) {
    throw new Error(`a power frame carries at most ${MAX_POWER_IDS} boatIds, got ${Array.isArray(boatIds) ? boatIds.length : typeof boatIds}`);
  }
  for (const id of boatIds) {
    if (typeof id !== 'string' || id.length !== BOAT_ID_LEN) {
      throw new Error(`boatId must be exactly ${BOAT_ID_LEN} characters, got ${JSON.stringify(id)}`);
    }
  }
  const len = powerFrameLen(boatIds.length);
  const buf = Buffer.alloc(len);
  buf.writeUInt8(POWER_SYNC, 0);
  buf.writeUInt8(POWER_ACTIONS[action], 1);
  buf.writeUInt8(sleepS, 2);
  buf.writeUInt8(boatIds.length, 3);
  boatIds.forEach((id, i) => buf.write(id, POWER_HEADER_LEN + i * BOAT_ID_LEN, BOAT_ID_LEN, 'ascii'));
  let sum = 0;
  for (let i = 1; i < len - 1; i++) sum = (sum + buf[i]) & 0xff;
  buf.writeUInt8(sum, len - 1);
  return buf;
}

// Returns { action: 'sleep'|'wake', sleepS, all, boatIds }, or null if the
// buffer isn't a valid power frame. `all` is true when no ids are listed.
function decodePower(buf) {
  if (buf.length < POWER_HEADER_LEN + 1 || buf[0] !== POWER_SYNC) return null;
  const action = POWER_ACTION_NAMES[buf.readUInt8(1)];
  if (!action) return null;
  const count = buf.readUInt8(3);
  if (count > MAX_POWER_IDS) return null;
  const len = powerFrameLen(count);
  if (buf.length !== len) return null;
  let sum = 0;
  for (let i = 1; i < len - 1; i++) sum = (sum + buf[i]) & 0xff;
  if (sum !== buf[len - 1]) return null;
  const boatIds = [];
  for (let i = 0; i < count; i++) {
    const at = POWER_HEADER_LEN + i * BOAT_ID_LEN;
    boatIds.push(buf.toString('ascii', at, at + BOAT_ID_LEN));
  }
  return { action, sleepS: buf.readUInt8(2), all: count === 0, boatIds };
}

// Tenth frame type: base -> boats, the transmit-slot table for the shared radio (see
// txScheduler.js / slotTable.js). In slot mode each boat releases its position frames only in its
// own slot of the correction cycle; this frame is how the base tells every boat which slot is
// theirs, so slots don't have to be set by hand or derived from a boat id (which can collide).
//
// The base broadcasts the whole table every few seconds, split over as many of these frames as
// needed (each is self-contained: it also carries the slot count and width, so a boat that hears
// any frame with its own id in it knows everything it needs).
//
// Layout (all little-endian):
//   [0]      sync byte      0xA7
//   [1]      version        uint8 - bumps whenever an assignment changes (diagnostic only)
//   [2]      slotCount      uint8 - slots for boats in a cycle, including the join slots (the base's own
//                           slot, for its table, marks, pings and sleep/wake frames, follows the last)
//   [3]      slotWidthMs    uint8 - width of each slot
//   [4]      joinSlots      uint8 - how many of the last slots are never assigned: boats that have no
//                           slot yet (or no room in the table) send in one of these, so they cannot
//                           land on a racing boat's slot
//   [5]      count          uint8 - entries in this frame
//   [6..]    entries        count * (BOAT_ID_LEN raw ASCII bytes + slot uint8)
//   [last]   checksum       uint8 (sum of bytes 1..N-2 mod 256)

const SLOT_TABLE_SYNC = 0xa7;
const SLOT_TABLE_HEADER_LEN = 6; // sync + version + slotCount + slotWidthMs + joinSlots + count
const SLOT_TABLE_ENTRY_LEN = BOAT_ID_LEN + 1;
const MAX_SLOT_ENTRIES = 15; // 6 + 15*6 + 1 = 97 bytes

function slotTableFrameLen(count) {
  return SLOT_TABLE_HEADER_LEN + count * SLOT_TABLE_ENTRY_LEN + 1;
}

// Like powerFrameLenFromHeader: never computes a length from an out-of-range count, so a false
// 0xA7 on noise can't make the scanner wait for a frame that will never arrive.
function slotTableFrameLenFromHeader(buf) {
  if (buf.length < SLOT_TABLE_HEADER_LEN) return null;
  const count = buf.readUInt8(5);
  if (count > MAX_SLOT_ENTRIES) return SLOT_TABLE_HEADER_LEN + 1;
  return slotTableFrameLen(count);
}

// entries: [{ boatId, slot }] (0..MAX_SLOT_ENTRIES of them; an empty frame is valid). Each slot is
// an assignable one: 0 .. slotCount - joinSlots - 1.
function encodeSlotTable({ version = 0, slotCount, slotWidthMs, joinSlots = 0, entries = [] }) {
  if (!Number.isInteger(version) || version < 0 || version > 255) throw new Error(`slot table version must be 0-255, got ${version}`);
  if (!Number.isInteger(slotCount) || slotCount < 1 || slotCount > 255) throw new Error(`slotCount must be 1-255, got ${slotCount}`);
  if (!Number.isInteger(slotWidthMs) || slotWidthMs < 1 || slotWidthMs > 255) throw new Error(`slotWidthMs must be 1-255, got ${slotWidthMs}`);
  if (!Number.isInteger(joinSlots) || joinSlots < 0 || joinSlots >= slotCount) throw new Error(`joinSlots must be 0 to ${slotCount - 1}, got ${joinSlots}`);
  if (!Array.isArray(entries) || entries.length > MAX_SLOT_ENTRIES) {
    throw new Error(`a slot table frame carries at most ${MAX_SLOT_ENTRIES} entries, got ${Array.isArray(entries) ? entries.length : typeof entries}`);
  }
  const assignable = slotCount - joinSlots;
  for (const { boatId, slot } of entries) {
    if (typeof boatId !== 'string' || boatId.length !== BOAT_ID_LEN) throw new Error(`boatId must be exactly ${BOAT_ID_LEN} characters, got ${JSON.stringify(boatId)}`);
    if (!Number.isInteger(slot) || slot < 0 || slot >= assignable) throw new Error(`slot for ${boatId} must be 0-${assignable - 1}, got ${slot}`);
  }
  const len = slotTableFrameLen(entries.length);
  const buf = Buffer.alloc(len);
  buf.writeUInt8(SLOT_TABLE_SYNC, 0);
  buf.writeUInt8(version, 1);
  buf.writeUInt8(slotCount, 2);
  buf.writeUInt8(slotWidthMs, 3);
  buf.writeUInt8(joinSlots, 4);
  buf.writeUInt8(entries.length, 5);
  entries.forEach(({ boatId, slot }, i) => {
    const at = SLOT_TABLE_HEADER_LEN + i * SLOT_TABLE_ENTRY_LEN;
    buf.write(boatId, at, BOAT_ID_LEN, 'ascii');
    buf.writeUInt8(slot, at + BOAT_ID_LEN);
  });
  let sum = 0;
  for (let i = 1; i < len - 1; i++) sum = (sum + buf[i]) & 0xff;
  buf.writeUInt8(sum, len - 1);
  return buf;
}

// Returns { version, slotCount, slotWidthMs, joinSlots, entries: [{ boatId, slot }] }, or null if the
// buffer isn't a valid slot-table frame.
function decodeSlotTable(buf) {
  if (buf.length < SLOT_TABLE_HEADER_LEN + 1 || buf[0] !== SLOT_TABLE_SYNC) return null;
  const count = buf.readUInt8(5);
  if (count > MAX_SLOT_ENTRIES) return null;
  const len = slotTableFrameLen(count);
  if (buf.length !== len) return null;
  let sum = 0;
  for (let i = 1; i < len - 1; i++) sum = (sum + buf[i]) & 0xff;
  if (sum !== buf[len - 1]) return null;
  const slotCount = buf.readUInt8(2);
  const slotWidthMs = buf.readUInt8(3);
  const joinSlots = buf.readUInt8(4);
  if (slotCount < 1 || slotWidthMs < 1 || joinSlots >= slotCount) return null;
  const assignable = slotCount - joinSlots;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const at = SLOT_TABLE_HEADER_LEN + i * SLOT_TABLE_ENTRY_LEN;
    const slot = buf.readUInt8(at + BOAT_ID_LEN);
    if (slot >= assignable) return null;
    entries.push({ boatId: buf.toString('ascii', at, at + BOAT_ID_LEN), slot });
  }
  return { version: buf.readUInt8(1), slotCount, slotWidthMs, joinSlots, entries };
}

// Ninth "frame type": RTCM3 correction messages riding the same shared radio as
// telemetry (see README's "RTCM on the shared radio"). Not a frame this app
// defines - it is the standard RTCM3 transport the RTK base's ZED-F9P already
// emits - but every radio on the network hears it, so the byte-stream scanner
// (radioLink.js) must recognise it, otherwise its bytes read as noise: false
// sync matches on payload bytes that happen to equal one of our own sync bytes,
// counted as radio errors and able to swallow real frames.
//
// Layout (RTCM 10403.x transport): [0] 0xD3, [1] 6 reserved bits (zero) +
// top 2 bits of the length, [2] low 8 bits of the length, then `length` payload
// bytes, then a 3-byte CRC-24Q over everything before it. The message number is
// the first 12 bits of the payload. Passed through untouched (raw bytes) so it
// can be forwarded verbatim to a GPS receiver.
const RTCM_SYNC = 0xd3;
const RTCM_MAX_PAYLOAD = 300; // this fleet's biggest message is ~140 bytes; a larger length is treated as a false sync, so one stray 0xD3 can't make the scanner wait on ~1000 bytes

function crc24q(buf, end) {
  let crc = 0;
  for (let i = 0; i < end; i++) {
    crc ^= buf[i] << 16;
    for (let b = 0; b < 8; b++) {
      crc <<= 1;
      if (crc & 0x1000000) crc ^= 0x1864cfb;
    }
  }
  return crc & 0xffffff;
}

// Full frame length from the 3-byte header, like batchFrameLenFromHeader: null
// until the header is in hand, and a small definite length (so decode fails fast)
// whenever the header can't be a real RTCM frame.
function rtcmFrameLenFromHeader(buf) {
  if (buf.length < 3) return null;
  if ((buf[1] & 0xfc) !== 0) return 3;
  const length = ((buf[1] & 0x03) << 8) | buf[2];
  if (length < 2 || length > RTCM_MAX_PAYLOAD) return 3;
  return 3 + length + 3;
}

// Returns { type, length, raw } (raw = a copy of the whole frame, for
// forwarding), or null if the buffer isn't one valid RTCM3 frame.
function decodeRtcm(buf) {
  if (buf.length < 8 || buf[0] !== RTCM_SYNC) return null;
  if (rtcmFrameLenFromHeader(buf) !== buf.length) return null;
  const end = buf.length - 3;
  const crc = (buf[end] << 16) | (buf[end + 1] << 8) | buf[end + 2];
  if (crc24q(buf, end) !== crc) return null;
  return { type: (buf[3] << 4) | (buf[4] >> 4), length: buf.length, raw: Buffer.from(buf) };
}

// A short, human-readable description of an RTCM3 message for console logs - not
// a full decoder. Reads just the header bits that say what the message is and how
// big it is: for the MSM observation messages (1071-1127, GPS 107x, GLONASS 108x,
// Galileo 109x, SBAS 110x, QZSS 111x, BeiDou 112x) the number of satellites and of
// signal cells (satellite mask x signal mask, then the cell mask); for 1005/1006
// the reference station id. Returns { type, name, sats, signals, cells, station }
// with whatever applies (others undefined).
const MSM_SYSTEMS = { 107: 'GPS', 108: 'GLO', 109: 'GAL', 110: 'SBS', 111: 'QZS', 112: 'BDS' };

function readBits(buf, startBit, n) {
  let v = 0;
  for (let i = 0; i < n; i++) {
    const bit = startBit + i;
    v = v * 2 + ((buf[bit >> 3] >> (7 - (bit & 7))) & 1);
  }
  return v;
}

function countBits(buf, startBit, n) {
  let c = 0;
  for (let i = 0; i < n; i++) {
    const bit = startBit + i;
    c += (buf[bit >> 3] >> (7 - (bit & 7))) & 1;
  }
  return c;
}

function describeRtcm(frame) {
  const out = { type: frame.type };
  const payload = frame.raw.subarray(3, frame.raw.length - 3);
  if (frame.type === 1005 || frame.type === 1006) {
    out.name = 'stn';
    if (payload.length >= 3) out.station = readBits(payload, 12, 12);
    return out;
  }
  if (frame.type === 1230) {
    out.name = 'bias';
    return out;
  }
  const system = MSM_SYSTEMS[Math.floor(frame.type / 10)];
  const msm = frame.type % 10;
  if (system && msm >= 1 && msm <= 7 && payload.length >= 22) {
    // header: 12 msg + 12 station + 30 epoch + 1 + 3 + 7 + 2 + 2 + 1 + 3 = 73 bits,
    // then the 64-bit satellite mask and the 32-bit signal mask
    out.name = system;
    out.msm = msm;
    out.station = readBits(payload, 12, 12);
    out.sats = countBits(payload, 73, 64);
    out.signals = countBits(payload, 137, 32);
    if (out.sats && out.signals && out.sats * out.signals <= 64 && payload.length * 8 >= 169 + out.sats * out.signals) {
      out.cells = countBits(payload, 169, out.sats * out.signals);
    }
    return out;
  }
  out.name = String(frame.type);
  return out;
}

// The variable-length frames' largest forms must fit the radio's payload limit
// too (the marks frame is checked where it's defined above).
for (const [name, len] of [
  ['batch', batchFrameLen(MAX_BATCH_COUNT)],
  ['power', powerFrameLen(MAX_POWER_IDS)],
  ['delta batch', deltaFrameLen(MAX_DELTA_COUNT)],
  ['slot table', slotTableFrameLen(MAX_SLOT_ENTRIES)],
]) {
  if (len > RADIO_MAX_PAYLOAD) throw new Error(`largest ${name} frame is ${len} bytes, over the radio's ${RADIO_MAX_PAYLOAD}-byte payload limit`);
}

module.exports = {
  encode,
  decode,
  FRAME_LEN,
  SYNC,
  BOAT_ID_LEN,
  encodeMarks,
  decodeMarks,
  MARKS_FRAME_LEN,
  REGATTA_NAME_LEN,
  RADIO_MAX_PAYLOAD,
  MARKS_SYNC,
  encodePing,
  decodePing,
  PING_FRAME_LEN,
  PING_SYNC,
  encodeHello,
  decodeHello,
  HELLO_FRAME_LEN,
  HELLO_SYNC,
  encodeBatch,
  decodeBatch,
  batchFrameLen,
  batchFrameLenFromHeader,
  BATCH_SYNC,
  MAX_BATCH_COUNT,
  encodeSetMark,
  decodeSetMark,
  SET_MARK_FRAME_LEN,
  SET_MARK_SYNC,
  encodeMarkLog,
  decodeMarkLog,
  MARK_LOG_FRAME_LEN,
  MARK_LOG_SYNC,
  encodePower,
  decodePower,
  powerFrameLen,
  powerFrameLenFromHeader,
  POWER_SYNC,
  MAX_POWER_IDS,
  encodeDeltaFrames,
  decodeDeltaBatch,
  deltaFrameLen,
  deltaFrameLenFromHeader,
  DELTA_SYNC,
  MAX_DELTA_COUNT,
  encodeSlotTable,
  decodeSlotTable,
  slotTableFrameLen,
  slotTableFrameLenFromHeader,
  SLOT_TABLE_SYNC,
  MAX_SLOT_ENTRIES,
  RTCM_SYNC,
  crc24q,
  describeRtcm,
  rtcmFrameLenFromHeader,
  decodeRtcm,
};
