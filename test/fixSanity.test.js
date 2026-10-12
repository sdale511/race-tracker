const test = require('node:test');
const assert = require('node:assert');
const { implausibleReason } = require('../src/fixSanity');

const now = Date.parse('2026-10-12T03:00:00Z');
const good = { boatId: '0MM9N', lat: 36.954619, lon: -121.974684, speedKnots: 0.1, timestamp: now - 1000 };

test('a normal fix passes', () => {
  assert.strictEqual(implausibleReason(good, now), null);
  assert.strictEqual(implausibleReason({ ...good, boatId: '00001', speedKnots: 57 }, now), null);
});

test('the corrupted fixes found in Redis are rejected', () => {
  // boat id of control characters, latitude -156, time in 1994
  assert.match(implausibleReason({ boatId: '\u001e\u001a$6\u001c', lat: -156.1434815, lon: -41.7520611, speedKnots: 1, timestamp: Date.parse('1994-02-27T00:11:48Z') }, now), /boat id/);
  // a plausible-looking boat id and position but a time in 2049
  assert.match(implausibleReason({ ...good, timestamp: Date.parse('2049-06-11T16:18:00Z') }, now), /time/);
});

test('out-of-range values are rejected one by one', () => {
  assert.match(implausibleReason({ ...good, lat: 91 }, now), /latitude/);
  assert.match(implausibleReason({ ...good, lon: -181 }, now), /longitude/);
  assert.match(implausibleReason({ ...good, lat: NaN }, now), /latitude/);
  assert.match(implausibleReason({ ...good, speedKnots: 400 }, now), /speed/);
  assert.match(implausibleReason({ ...good, speedKnots: -1 }, now), /speed/);
  assert.match(implausibleReason({ ...good, boatId: 'ab c' }, now), /boat id/);
  assert.ok(implausibleReason(null, now));
});

test('a clock a day out is tolerated, a week out is not', () => {
  assert.strictEqual(implausibleReason({ ...good, timestamp: now - 24 * 3600e3 }, now), null);
  assert.match(implausibleReason({ ...good, timestamp: now - 7 * 24 * 3600e3 }, now), /time/);
});
