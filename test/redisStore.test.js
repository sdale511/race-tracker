const test = require('node:test');
const assert = require('node:assert');
const { packFix, unpackFix } = require('../src/redisStore');

const fix = (timestamp) => ({ boatId: '00001', timestamp, lat: 40.897, lon: -118.3819, speedKnots: 53.8, headingDeg: 180, gnssFixOk: true, carrSoln: 2, numSV: 14 });

test('two fixes with identical content but different times are different Redis members', () => {
  // A sorted set keeps one entry per member; if these matched, the earlier fix would vanish from the track
  assert.notStrictEqual(packFix(fix(1000)), packFix(fix(1500)));
});

test('a stored fix reads back with the time from the score and no extra fields', () => {
  const got = unpackFix(packFix(fix(1234)), 1234);
  assert.strictEqual(got.timestamp, 1234);
  assert.strictEqual(got.lat, 40.897);
  assert.strictEqual(got.boatId, '00001');
  assert.strictEqual(got.t, undefined);
});
