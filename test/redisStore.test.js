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

const { RedisStore } = require('../src/redisStore');
const T = Date.now(); // the sanity check rejects fixes that are not recent
// A store with only what decideRecord reads, so no Redis connection is needed
const bareStore = () => Object.assign(Object.create(RedisStore.prototype), { lastRecordedPosition: new Map(), minMovementM: 1 });

test('a batch of identical positions is posted once, not once per fix', () => {
  const store = bareStore();
  const verdicts = [];
  for (let i = 0; i < 8; i++) verdicts.push(store.decideRecord(fix(T + i * 100)));
  assert.deepStrictEqual(verdicts, ['post', 'skip', 'skip', 'skip', 'skip', 'skip', 'skip', 'skip']);
});

test('a fix that has moved far enough is posted and becomes the new reference', () => {
  const store = bareStore();
  assert.strictEqual(store.decideRecord(fix(T)), 'post');
  const moved = { ...fix(T + 1000), lat: 40.897 + 0.00003 }; // about 3.3 m north
  assert.strictEqual(store.decideRecord(moved), 'post');
  assert.strictEqual(store.decideRecord({ ...moved, timestamp: T + 1100 }), 'skip');
});

test('an implausible fix is never posted and does not become the reference', () => {
  const store = bareStore();
  assert.strictEqual(store.decideRecord({ ...fix(T), lat: 95 }), 'invalid');
  assert.strictEqual(store.decideRecord(fix(T + 1000)), 'post');
});

test('a boat\'s own track key is trimmed to the window, at most once per trim interval', () => {
  const trims = [];
  const store = Object.assign(Object.create(RedisStore.prototype), {
    boatTrackWindowMs: 2 * 60000,
    lastBoatTrimAt: new Map(),
    client: { zremrangebyscore: (key, min, max) => { trims.push([key, min, max]); return Promise.resolve(0); } },
  });
  store._trimBoatTrack('00001', 'k:00001', 2_000_000);
  store._trimBoatTrack('00001', 'k:00001', 2_001_000); // too soon after the first trim
  store._trimBoatTrack('00002', 'k:00002', 2_000_000); // another boat has its own interval
  assert.deepStrictEqual(trims, [['k:00001', '-inf', 2_000_000 - 120000], ['k:00002', '-inf', 2_000_000 - 120000]]);
});

test('a window of 0 keeps the whole per-boat track', () => {
  const store = Object.assign(Object.create(RedisStore.prototype), {
    boatTrackWindowMs: 0,
    lastBoatTrimAt: new Map(),
    client: { zremrangebyscore: () => assert.fail('must not trim') },
  });
  store._trimBoatTrack('00001', 'k', 1);
});

test('the rolling window trims all:track to the retention period and refreshes the expiry, once a minute', () => {
  const calls = [];
  const store = Object.assign(Object.create(RedisStore.prototype), {
    trackRetentionSeconds: 48 * 3600,
    lastWindowAt: new Map(),
    client: {
      zremrangebyscore: (key, min, max) => { calls.push(['zrem', key, min, max]); return Promise.resolve(0); },
      expire: (key, seconds) => { calls.push(['expire', key, seconds]); return Promise.resolve(1); },
    },
  });
  const before = Date.now();
  store._keepRollingWindow('all', 'boat');
  store._keepRollingWindow('all', 'boat'); // inside the same minute: nothing
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(calls[0][0], 'zrem');
  assert.strictEqual(calls[0][2], '-inf');
  assert.ok(calls[0][3] >= before - 48 * 3600 * 1000 && calls[0][3] <= Date.now() - 48 * 3600 * 1000);
  assert.deepStrictEqual(calls.slice(1), [['expire', 'all', 172800], ['expire', 'boat', 172800]]);
});
