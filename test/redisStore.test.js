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

test('a boat is added to boats:known at most once per upkeep interval, each boat on its own interval', () => {
  const calls = [];
  const store = Object.assign(Object.create(RedisStore.prototype), {
    lastKnownAt: new Map(),
    client: { sadd: (key, member) => { calls.push(['sadd', key, member]); return Promise.resolve(1); } },
  });
  store._keepBoatKnown('r1:00001', '00001', 'known');
  store._keepBoatKnown('r1:00001', '00001', 'known'); // too soon after the first
  store._keepBoatKnown('r1:00002', '00002', 'known'); // another boat has its own interval
  assert.deepStrictEqual(calls, [['sadd', 'known', '00001'], ['sadd', 'known', '00002']]);
});

const writeStore = (calls, extra = {}) => Object.assign(Object.create(RedisStore.prototype), {
  ready: Promise.resolve(),
  currentRegattaId: 'r1',
  trackRetentionSeconds: 172800,
  lastKnownAt: new Map(),
  lastWindowAt: new Map(),
  lastRecordedPosition: new Map(),
  trackWriteHealthy: true,
  trackWriteFailureCount: 0,
  _pendingFixes: [],
  _flushing: null,
  lastPositionAt: new Map(),
  client: {
    zadd: (key, ...args) => { calls.push(['zadd', key, args.length / 2]); return Promise.resolve(1); },
    hset: (key, ...args) => { calls.push(['hset', key, ...args]); return Promise.resolve(1); },
    sadd: (key, member) => { calls.push(['sadd', key, member]); return Promise.resolve(1); },
    zremrangebyscore: () => Promise.resolve(0),
    expire: () => Promise.resolve(1),
  },
  ...extra,
});

test('a frame\'s fixes, arriving in one tick, are written as one ZADD to the track and no per-boat key', async () => {
  const calls = [];
  const store = writeStore(calls);
  const boat2 = (t) => ({ ...fix(t), boatId: '00002' });
  await Promise.all([...[0, 1, 2, 3, 4].map((i) => store.writeFix(fix(T + i * 100))), store.writeFix(boat2(T))]);
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'zadd'), [['zadd', 'regattas:r1:track', 6]]);
  // boats:last: each boat's newest fix in one HSET
  const hset = calls.find((c) => c[0] === 'hset');
  assert.deepStrictEqual([hset[1], hset[2], hset[4]], ['regattas:r1:boats:last', '00001', '00002']);
  // boats:known: each boat once, on its first fix
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'sadd').map((c) => c[2]), ['00001', '00002']);
});

test('boats:known is added on a boat\'s first fix in each regatta, not on every fix', async () => {
  const calls = [];
  const store = writeStore(calls);
  for (let i = 0; i < 5; i++) await store.writeFix(fix(T + i * 100)); // separate ticks: separate flushes
  assert.strictEqual(calls.filter((c) => c[0] === 'zadd').length, 5);
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'sadd'), [['sadd', 'regattas:r1:boats:known', '00001']]);
  store.currentRegattaId = 'r2'; // a regatta switch inside the upkeep interval still lists the boat in the new regatta at once
  await store.writeFix(fix(T + 600));
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'sadd').at(-1), ['sadd', 'regattas:r2:boats:known', '00001']);
});

test('a failed batch is counted once and every boat in it posts its next fix again', async () => {
  const calls = [];
  const store = writeStore(calls);
  store.client.zadd = () => Promise.reject(new Error('OOM'));
  const origError = console.error;
  console.error = () => {};
  try {
    store.decideRecord(fix(T));
    store.decideRecord({ ...fix(T), boatId: '00002' });
    await Promise.all([store.writeFix(fix(T)), store.writeFix({ ...fix(T), boatId: '00002' })]);
  } finally {
    console.error = origError;
  }
  assert.strictEqual(store.trackWriteFailureCount, 1);
  assert.strictEqual(store.lastRecordedPosition.size, 0);
  assert.strictEqual(calls.filter((c) => c[0] === 'sadd').length, 0); // no upkeep after a failed write
});

test('the rolling window trims the track to the retention period and refreshes its expiry, once a minute', () => {
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
  store._keepRollingWindow('track');
  store._keepRollingWindow('track'); // inside the same minute: nothing
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0][0], 'zrem');
  assert.strictEqual(calls[0][2], '-inf');
  assert.ok(calls[0][3] >= before - 48 * 3600 * 1000 && calls[0][3] <= Date.now() - 48 * 3600 * 1000);
  assert.deepStrictEqual(calls[1], ['expire', 'track', 172800]);
});

test('marks:index follows every mark write and delete, and getMarks indexes the marks already there', async () => {
  const calls = [];
  const store = Object.assign(Object.create(RedisStore.prototype), {
    ready: Promise.resolve(),
    currentRegattaId: 'r1',
    client: {
      hset: () => Promise.resolve(1),
      del: () => Promise.resolve(1),
      sadd: (key, ...names) => { calls.push(['sadd', key, ...names]); return Promise.resolve(1); },
      srem: (key, name) => { calls.push(['srem', key, name]); return Promise.resolve(1); },
      hgetall: (key) => Promise.resolve(key.endsWith(':mark:pin') ? { lat: '40.1', lon: '-118.1' } : {}),
    },
  });
  await store.setMark('pinBoundary', { lat: 40.2, lon: -118.2 });
  await store.deleteMark('pinBoundary');
  await store.getMarks();
  assert.deepStrictEqual(calls, [
    ['sadd', 'regattas:r1:marks:index', 'pinBoundary'],
    ['srem', 'regattas:r1:marks:index', 'pinBoundary'],
    ['sadd', 'regattas:r1:marks:index', 'pin'],
  ]);
});

test('boats:last gets each boat\'s newest fix once per batch, never a late or future-dated one', async () => {
  const calls = [];
  const store = writeStore(calls);
  const hsets = () => calls.filter((c) => c[0] === 'hset').map(([, key, ...args]) =>
    [key, ...args.map((a, i) => (i % 2 ? JSON.parse(a).t : a))]);
  // a batch: three fixes from one boat, one from another - one HSET, each boat's newest
  await Promise.all([store.writeFix(fix(T)), store.writeFix(fix(T + 200)), store.writeFix(fix(T + 100)),
    store.writeFix({ ...fix(T + 50), boatId: '00002' })]);
  assert.deepStrictEqual(hsets(), [['regattas:r1:boats:last', '00001', T + 200, '00002', T + 50]]);
  // a late fix older than the one already written: stored in the track, not in boats:last
  calls.length = 0;
  await store.writeFix(fix(T + 150));
  assert.deepStrictEqual(hsets(), []);
  assert.strictEqual(calls.filter((c) => c[0] === 'zadd').length, 1); // the track only
  // more than a minute in the future: never in boats:last
  await store.writeFix(fix(Date.now() + 120_000));
  assert.deepStrictEqual(hsets(), []);
  await store.writeFix(fix(T + 300));
  assert.deepStrictEqual(hsets(), [['regattas:r1:boats:last', '00001', T + 300]]);
});
