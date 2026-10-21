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

test('a boat\'s own track key is trimmed to the window, its expiry refreshed and the boat added to boats:known, at most once per trim interval', () => {
  const calls = [];
  const store = Object.assign(Object.create(RedisStore.prototype), {
    boatTrackWindowMs: 2 * 60000,
    trackRetentionSeconds: 172800,
    lastBoatTrimAt: new Map(),
    client: {
      sadd: (key, member) => { calls.push(['sadd', key, member]); return Promise.resolve(1); },
      zremrangebyscore: (key, min, max) => { calls.push(['zrem', key, min, max]); return Promise.resolve(0); },
      expire: (key, seconds) => { calls.push(['expire', key, seconds]); return Promise.resolve(1); },
    },
  });
  store._trimBoatTrack('00001', 'k:00001', 2_000_000, 'known');
  store._trimBoatTrack('00001', 'k:00001', 2_001_000, 'known'); // too soon after the first
  store._trimBoatTrack('00002', 'k:00002', 2_000_000, 'known'); // another boat has its own interval
  assert.deepStrictEqual(calls, [
    ['sadd', 'known', '00001'], ['zrem', 'k:00001', '-inf', 2_000_000 - 120000], ['expire', 'k:00001', 172800],
    ['sadd', 'known', '00002'], ['zrem', 'k:00002', '-inf', 2_000_000 - 120000], ['expire', 'k:00002', 172800],
  ]);
});

test('a fix writes only the two track entries; boats:known is added on a boat\'s first fix in each regatta, not on every fix', async () => {
  const calls = [];
  const store = Object.assign(Object.create(RedisStore.prototype), {
    ready: Promise.resolve(),
    currentRegattaId: 'r1',
    boatTrackWindowMs: 0,
    trackRetentionSeconds: 172800,
    lastBoatTrimAt: new Map(),
    lastWindowAt: new Map(),
    lastRecordedPosition: new Map(),
    trackWriteHealthy: true,
    client: {
      zadd: (key) => { calls.push(['zadd', key]); return Promise.resolve(1); },
      sadd: (key, member) => { calls.push(['sadd', key, member]); return Promise.resolve(1); },
      zremrangebyscore: () => Promise.resolve(0),
      expire: () => Promise.resolve(1),
    },
  });
  for (let i = 0; i < 5; i++) await store.writeFix(fix(T + i * 100));
  assert.strictEqual(calls.filter((c) => c[0] === 'zadd').length, 10);
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'sadd'), [['sadd', 'regattas:r1:boats:known', '00001']]);
  store.currentRegattaId = 'r2'; // a regatta switch inside the trim interval still lists the boat in the new regatta at once
  await store.writeFix(fix(T + 600));
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'sadd').at(-1), ['sadd', 'regattas:r2:boats:known', '00001']);
});

test('a window of 0 keeps the whole per-boat track but still sets its expiry', () => {
  const calls = [];
  const store = Object.assign(Object.create(RedisStore.prototype), {
    boatTrackWindowMs: 0,
    trackRetentionSeconds: 172800,
    lastBoatTrimAt: new Map(),
    client: {
      sadd: () => Promise.resolve(1),
      zremrangebyscore: () => assert.fail('must not trim'),
      expire: (key, seconds) => { calls.push([key, seconds]); return Promise.resolve(1); },
    },
  });
  store._trimBoatTrack('00001', 'k', 1, 'known');
  assert.deepStrictEqual(calls, [['k', 172800]]);
});

test('the rolling window trims all:track to the retention period and refreshes its expiry, once a minute', () => {
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
  store._keepRollingWindow('all');
  store._keepRollingWindow('all'); // inside the same minute: nothing
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0][0], 'zrem');
  assert.strictEqual(calls[0][2], '-inf');
  assert.ok(calls[0][3] >= before - 48 * 3600 * 1000 && calls[0][3] <= Date.now() - 48 * 3600 * 1000);
  assert.deepStrictEqual(calls[1], ['expire', 'all', 172800]);
});
