// Compact fixed-length frame sent over the telemetry radio. Kept small on
// purpose: every byte costs airtime, and long-range links are often
// bandwidth-limited (a few kbps). This frame is 21 bytes total.
//
// Layout (all little-endian):
//   [0]     sync byte        0xAA
//   [1]     boatId           uint8
//   [2..5]  unix time (s)    uint32
//   [6..9]  lat * 1e7        int32
//   [10..13] lon * 1e7       int32
//   [14..15] speed (0.1 kn)  uint16
//   [16..17] heading (0.1deg) uint16
//   [18]    status           uint8  (bit0 fixOk, bits1-2 carrSoln, bits3-7 numSV)
//   [19]    reserved         uint8  (e.g. battery %, spare)
//   [20]    checksum         uint8  (sum of bytes 1..19 mod 256)

const SYNC = 0xaa;
const FRAME_LEN = 21;

function encode(boatId, pvt) {
  const buf = Buffer.alloc(FRAME_LEN);
  buf.writeUInt8(SYNC, 0);
  buf.writeUInt8(boatId & 0xff, 1);
  buf.writeUInt32LE(Math.floor(pvt.timestamp / 1000), 2);
  buf.writeInt32LE(Math.round(pvt.lat * 1e7), 6);
  buf.writeInt32LE(Math.round(pvt.lon * 1e7), 10);

  const speedKnots = (pvt.gSpeedMmS / 1000) * 1.94384; // mm/s -> knots
  buf.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(speedKnots * 10))), 14);

  const heading = ((pvt.headMotDeg % 360) + 360) % 360;
  buf.writeUInt16LE(Math.round(heading * 10), 16);

  const status =
    (pvt.gnssFixOk ? 1 : 0) |
    ((pvt.carrSoln & 0x03) << 1) |
    ((Math.min(pvt.numSV, 31) & 0x1f) << 3);
  buf.writeUInt8(status, 18);

  buf.writeUInt8(0, 19); // reserved

  let sum = 0;
  for (let i = 1; i < 20; i++) sum = (sum + buf[i]) & 0xff;
  buf.writeUInt8(sum, 20);

  return buf;
}

// Returns decoded object, or null if the buffer isn't a valid frame.
function decode(buf) {
  if (buf.length !== FRAME_LEN || buf[0] !== SYNC) return null;

  let sum = 0;
  for (let i = 1; i < 20; i++) sum = (sum + buf[i]) & 0xff;
  if (sum !== buf[20]) return null; // checksum mismatch

  const status = buf.readUInt8(18);
  return {
    boatId: buf.readUInt8(1),
    timestamp: buf.readUInt32LE(2) * 1000,
    lat: buf.readInt32LE(6) / 1e7,
    lon: buf.readInt32LE(10) / 1e7,
    speedKnots: buf.readUInt16LE(14) / 10,
    headingDeg: buf.readUInt16LE(16) / 10,
    gnssFixOk: !!(status & 0x01),
    carrSoln: (status >> 1) & 0x03,
    numSV: (status >> 3) & 0x1f,
  };
}

module.exports = { encode, decode, FRAME_LEN, SYNC };
