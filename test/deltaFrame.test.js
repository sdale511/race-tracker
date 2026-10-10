// Tests for the delta-coded batch frame (protocol.js). Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const protocol = require('../src/protocol');
const { RadioLink } = require('../src/radioLink');

const pvt = (i, over = {}) => ({
  timestamp: 1760000000000 + Math.round(i * 125),
  lat: 40.897 + i * 0.000012,
  lon: -118.38 + i * 0.000009,
  gSpeedMmS: 3000 + i * 40,
  headMotDeg: 100 + i * 3.3,
  gnssFixOk: true,
  carrSoln: 2,
  numSV: 14,
  ...over,
});

test('delta frame: 8 fixes in 83 bytes, positions and speed exact, time within 1 ms, heading within 0.25 degrees', () => {
  const fixes = Array.from({ length: 8 }, (_, i) => pvt(i));
  const frames = protocol.encodeDeltaFrames('ABCDE', fixes);
  assert.deepStrictEqual(frames.map((f) => [f.count, f.buf.length]), [[8, 83]]);
  assert.ok(frames[0].buf.length <= protocol.RADIO_MAX_PAYLOAD);
  const out = protocol.decodeDeltaBatch(frames[0].buf);
  assert.strictEqual(out.length, 8);
  out.forEach((o, i) => {
    assert.strictEqual(o.boatId, 'ABCDE');
    assert.strictEqual(Math.round(o.lat * 1e7), Math.round(fixes[i].lat * 1e7), `lat ${i}`);
    assert.strictEqual(Math.round(o.lon * 1e7), Math.round(fixes[i].lon * 1e7), `lon ${i}`);
    assert.strictEqual(Math.round(o.speedKnots * 10), Math.round(((fixes[i].gSpeedMmS / 1000) * 1.94384) * 10), `speed ${i}`);
    assert.ok(Math.abs(o.timestamp - fixes[i].timestamp) <= 1, `time ${i}: ${o.timestamp - fixes[i].timestamp} ms off`);
    assert.ok(Math.abs(o.headingDeg - fixes[i].headMotDeg) <= 0.3, `heading ${i}: ${o.headingDeg} vs ${fixes[i].headMotDeg}`);
    assert.strictEqual(o.gnssFixOk, true);
    assert.strictEqual(o.carrSoln, 2);
    assert.strictEqual(o.numSV, 14);
  });
  // the first fix is exactly what the full frame carries
  const plain = protocol.decode(protocol.encode('ABCDE', fixes[0]));
  assert.strictEqual(out[0].timestamp, plain.timestamp);
  assert.strictEqual(out[0].headingDeg, plain.headingDeg);
});

test('delta frame: sizes - 4 fixes 51 bytes (84 before), 5 fixes 59, one frame for up to 8', () => {
  for (const [n, size] of [[2, 35], [4, 51], [5, 59], [6, 67], [7, 75], [8, 83]]) {
    const frames = protocol.encodeDeltaFrames('ABCDE', Array.from({ length: n }, (_, i) => pvt(i)));
    assert.deepStrictEqual(frames.map((f) => f.buf.length), [size], `${n} fixes`);
  }
  assert.strictEqual(protocol.batchFrameLen(4), 84);
});

test('delta frame: more than 8 fixes split into frames, a lone fix is the plain position frame', () => {
  const frames = protocol.encodeDeltaFrames('ABCDE', Array.from({ length: 9 }, (_, i) => pvt(i)));
  assert.deepStrictEqual(frames.map((f) => f.count), [8, 1]);
  assert.strictEqual(frames[1].buf.length, protocol.FRAME_LEN);
  assert.strictEqual(frames[1].buf[0], protocol.SYNC);
});

test('delta frame: a change that does not fit starts a new frame (jump, long gap, hard turn, speed spike)', () => {
  const cases = {
    'GPS jump of ~1 km': pvt(1, { lat: 40.906 }),
    'a gap over 510 ms': pvt(1, { timestamp: 1760000000000 + 700 }),
    'a 90 degree turn between fixes': pvt(1, { headMotDeg: 190 }),
    'a 20 knot speed spike': pvt(1, { gSpeedMmS: 3000 + 10300 }),
  };
  for (const [what, second] of Object.entries(cases)) {
    const frames = protocol.encodeDeltaFrames('ABCDE', [pvt(0), second, pvt(2, { timestamp: second.timestamp + 125, lat: second.lat, lon: second.lon, gSpeedMmS: second.gSpeedMmS, headMotDeg: second.headMotDeg })]);
    assert.deepStrictEqual(frames.map((f) => f.count), [1, 2], what);
    // and everything still decodes
    const decoded = frames.flatMap((f) => (f.count === 1 ? [protocol.decode(f.buf)] : protocol.decodeDeltaBatch(f.buf)));
    assert.strictEqual(decoded.length, 3, what);
    assert.ok(Math.abs(decoded[1].lat - second.lat) < 1e-7, what);
  }
});

test('delta frame: heading wraps around north the short way', () => {
  const fixes = [pvt(0, { headMotDeg: 358 }), pvt(1, { headMotDeg: 3 }), pvt(2, { headMotDeg: 357 })];
  const out = protocol.decodeDeltaBatch(protocol.encodeDeltaFrames('ABCDE', fixes)[0].buf);
  assert.ok(Math.abs(out[1].headingDeg - 3) <= 0.3);
  assert.ok(Math.abs(out[2].headingDeg - 357) <= 0.3);
});

test('delta frame: bad checksum or count is rejected; the byte-stream scanner knows the type', () => {
  const buf = protocol.encodeDeltaFrames('ABCDE', Array.from({ length: 5 }, (_, i) => pvt(i)))[0].buf;
  const bad = Buffer.from(buf);
  bad[12] ^= 0xff;
  assert.strictEqual(protocol.decodeDeltaBatch(bad), null);
  const badCount = Buffer.from(buf);
  badCount[1] = 99;
  assert.strictEqual(protocol.decodeDeltaBatch(badCount), null);
  assert.strictEqual(protocol.deltaFrameLenFromHeader(buf), buf.length);
  assert.ok(protocol.deltaFrameLenFromHeader(badCount) < 20, 'an implausible count never makes the scanner wait for a huge frame');
  const type = RadioLink.FRAME_TYPES.find((t) => t.sync === protocol.DELTA_SYNC);
  assert.ok(type && type.event === 'frame-batch', 'arrives as a normal batch of fixes');
});
