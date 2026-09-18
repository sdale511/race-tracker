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
//   [25]       reserved         uint8  (e.g. battery %, spare)
//   [26]       checksum         uint8  (sum of bytes 1..25 mod 256)

const { MARK_NAMES } = require('./course');

const SYNC = 0xaa;
// Length of the boatId field itself (see boatIdFile.js's own comment on why
// 5 uppercase letters - short enough to cost little extra airtime over the
// old single-byte numeric id, long enough that random generation across a
// whole fleet is only very remotely likely to ever collide).
const BOAT_ID_LEN = 5;
const FRAME_LEN = 1 + BOAT_ID_LEN + 4 + 2 + 4 + 4 + 2 + 2 + 1 + 1 + 1;

function encode(boatId, pvt) {
  if (typeof boatId !== 'string' || boatId.length !== BOAT_ID_LEN) {
    throw new Error(`boatId must be exactly ${BOAT_ID_LEN} characters, got ${JSON.stringify(boatId)}`);
  }
  const buf = Buffer.alloc(FRAME_LEN);
  buf.writeUInt8(SYNC, 0);
  buf.write(boatId, 1, BOAT_ID_LEN, 'ascii');
  let offset = 1 + BOAT_ID_LEN;
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

  buf.writeUInt8(0, offset + 19); // reserved

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
  const status = buf.readUInt8(offset + 18);
  return {
    boatId: buf.toString('ascii', 1, offset),
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
const MARKS_FRAME_LEN = 1 + MARK_NAMES.length * 8 + 4 + 2 + 2 + 1 + 1;

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

  let sum = 0;
  for (let i = 1; i < MARKS_FRAME_LEN - 1; i++) sum = (sum + buf[i]) & 0xff;
  buf.writeUInt8(sum, MARKS_FRAME_LEN - 1);

  return buf;
}

// Returns { marks: { windward: {lat,lon}, ..., pinBoundaryEnabled: bool },
// baseIp, basePort, baseAdminPort }, or null if the buffer isn't a valid
// marks frame. baseIp is '0.0.0.0' if the base doesn't have (or hasn't been
// told) an address to publish.
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

  return { marks, baseIp, basePort, baseAdminPort };
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

module.exports = {
  encode,
  decode,
  FRAME_LEN,
  SYNC,
  BOAT_ID_LEN,
  encodeMarks,
  decodeMarks,
  MARKS_FRAME_LEN,
  MARKS_SYNC,
  encodePing,
  decodePing,
  PING_FRAME_LEN,
  PING_SYNC,
  encodeHello,
  decodeHello,
  HELLO_FRAME_LEN,
  HELLO_SYNC,
};
