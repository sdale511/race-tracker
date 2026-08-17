// Compact fixed-length frame sent over the telemetry radio. Kept small on
// purpose: every byte costs airtime, and long-range links are often
// bandwidth-limited (a few kbps). This frame is 23 bytes total.
//
// Layout (all little-endian):
//   [0]     sync byte        0xAA
//   [1]     boatId           uint8
//   [2..5]  unix time (s)    uint32
//   [6..7]  ms within second uint16  (0-999 - full unix-time precision
//                                     without needing a 64-bit field or a
//                                     shared custom epoch)
//   [8..11] lat * 1e7        int32
//   [12..15] lon * 1e7       int32
//   [16..17] speed (0.1 kn)  uint16
//   [18..19] heading (0.1deg) uint16
//   [20]    status           uint8  (bit0 fixOk, bits1-2 carrSoln, bits3-7 numSV)
//   [21]    reserved         uint8  (e.g. battery %, spare)
//   [22]    checksum         uint8  (sum of bytes 1..21 mod 256)

const { MARK_NAMES } = require('./course');

const SYNC = 0xaa;
const FRAME_LEN = 23;

function encode(boatId, pvt) {
  const buf = Buffer.alloc(FRAME_LEN);
  buf.writeUInt8(SYNC, 0);
  buf.writeUInt8(boatId & 0xff, 1);
  buf.writeUInt32LE(Math.floor(pvt.timestamp / 1000), 2);
  buf.writeUInt16LE(pvt.timestamp % 1000, 6);
  buf.writeInt32LE(Math.round(pvt.lat * 1e7), 8);
  buf.writeInt32LE(Math.round(pvt.lon * 1e7), 12);

  const speedKnots = (pvt.gSpeedMmS / 1000) * 1.94384; // mm/s -> knots
  buf.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(speedKnots * 10))), 16);

  const heading = ((pvt.headMotDeg % 360) + 360) % 360;
  buf.writeUInt16LE(Math.round(heading * 10), 18);

  const status =
    (pvt.gnssFixOk ? 1 : 0) |
    ((pvt.carrSoln & 0x03) << 1) |
    ((Math.min(pvt.numSV, 31) & 0x1f) << 3);
  buf.writeUInt8(status, 20);

  buf.writeUInt8(0, 21); // reserved

  let sum = 0;
  for (let i = 1; i < 22; i++) sum = (sum + buf[i]) & 0xff;
  buf.writeUInt8(sum, 22);

  return buf;
}

// Returns decoded object, or null if the buffer isn't a valid frame.
function decode(buf) {
  if (buf.length !== FRAME_LEN || buf[0] !== SYNC) return null;

  let sum = 0;
  for (let i = 1; i < 22; i++) sum = (sum + buf[i]) & 0xff;
  if (sum !== buf[22]) return null; // checksum mismatch

  const status = buf.readUInt8(20);
  return {
    boatId: buf.readUInt8(1),
    timestamp: buf.readUInt32LE(2) * 1000 + buf.readUInt16LE(6),
    lat: buf.readInt32LE(8) / 1e7,
    lon: buf.readInt32LE(12) / 1e7,
    speedKnots: buf.readUInt16LE(16) / 10,
    headingDeg: buf.readUInt16LE(18) / 10,
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
// Layout (all little-endian), marks in MARK_NAMES order (currently 7:
// windwardGreen/windwardBlack/leewardGreen/leewardBlack/pin/committee/
// finish - see course.js):
//   [0]  sync byte     0xBB
//   ...  MARK_NAMES.length x { lat*1e7 int32, lon*1e7 int32 }  (8 bytes each)
//   ...  base IP       4 bytes, one octet each (0.0.0.0 = unknown/none)
//   ...  base upload port  uint16
//   ...  base admin port   uint16
//   [last] checksum     uint8  (sum of all preceding bytes mod 256)
// Total length is MARKS_FRAME_LEN below - deliberately not hardcoded here
// as fixed byte offsets, since it shifts whenever MARK_NAMES grows/shrinks.

const MARKS_SYNC = 0xbb;
const MARKS_FRAME_LEN = 1 + MARK_NAMES.length * 8 + 4 + 2 + 2 + 1;

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

  let sum = 0;
  for (let i = 1; i < MARKS_FRAME_LEN - 1; i++) sum = (sum + buf[i]) & 0xff;
  buf.writeUInt8(sum, MARKS_FRAME_LEN - 1);

  return buf;
}

// Returns { marks: { windward: {lat,lon}, ... }, baseIp, basePort,
// baseAdminPort }, or null if the buffer isn't a valid marks frame. baseIp
// is '0.0.0.0' if the base doesn't have (or hasn't been told) an address to
// publish.
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

module.exports = {
  encode,
  decode,
  FRAME_LEN,
  SYNC,
  encodeMarks,
  decodeMarks,
  MARKS_FRAME_LEN,
  MARKS_SYNC,
  encodePing,
  decodePing,
  PING_FRAME_LEN,
  PING_SYNC,
};
