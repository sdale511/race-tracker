const test = require('node:test');
const assert = require('node:assert');
const { TempestListener, parseTempestMessage, windSampleFromObs, directionRange } = require('../src/tempestListener');
const { RedisStore } = require('../src/redisStore');

// The shapes the Tempest hub broadcasts (WeatherFlow UDP API v171): wind in m/s, direction in degrees.
const obsSt = (wind = [0.27, 4.47, 6.71, 225], serial = 'ST-00000512') =>
  Buffer.from(JSON.stringify({
    serial_number: serial,
    type: 'obs_st',
    hub_sn: 'HB-00013030',
    obs: [[1588948614, ...wind, 3, 1017.57, 22.37, 50.26, 328, 0.03, 3, 0.0, 0, 0, 0, 2.41, 1]],
    firmware_revision: 129,
  }));
const rapidWind = (speed = 2.3, dir = 128, serial = 'ST-00000512') =>
  Buffer.from(JSON.stringify({ serial_number: serial, type: 'rapid_wind', hub_sn: 'HB-00013030', ob: [1588948614, speed, dir] }));

test('an obs_st becomes lull/avg/gust in mph and the direction in degrees', () => {
  const msg = parseTempestMessage(obsSt());
  assert.deepStrictEqual(msg, { type: 'obs', serial: 'ST-00000512', stationTime: 1588948614000, lull: 0.6, avg: 10, gust: 15, dir: 225 });
});

test('a rapid_wind becomes a speed in mph and a direction', () => {
  assert.deepStrictEqual(parseTempestMessage(rapidWind()), { type: 'rapid', serial: 'ST-00000512', stationTime: 1588948614000, speed: 5.1, dir: 128 });
});

test('other message types and malformed datagrams are ignored', () => {
  assert.strictEqual(parseTempestMessage(Buffer.from(JSON.stringify({ type: 'hub_status', serial_number: 'HB-1' }))), null);
  assert.strictEqual(parseTempestMessage(Buffer.from('not json')), null);
  assert.strictEqual(parseTempestMessage(Buffer.from(JSON.stringify({ type: 'obs_st', obs: 'x' }))), null);
});

test('a direction of 360 reads as 0, and a missing reading stays null', () => {
  assert.strictEqual(parseTempestMessage(obsSt([0.2, 3, 4, 360])).dir, 0);
  const faulted = parseTempestMessage(obsSt([null, null, null, null]));
  assert.deepStrictEqual([faulted.lull, faulted.avg, faulted.gust, faulted.dir], [null, null, null, null]);
});

test('a sample needs a direction and an average speed', () => {
  assert.deepStrictEqual(windSampleFromObs({ dir: 225, avg: 10, gust: 15, lull: 0.6 }, 1000, 'Playa'), {
    t: 1000, dir: 225, avg: 10, gust: 15, lull: 0.6, station: 'Playa', units: 'mph',
  });
  assert.strictEqual(windSampleFromObs({ dir: null, avg: 10 }, 1000, 'Playa'), null);
  assert.strictEqual(windSampleFromObs({ dir: 225, avg: null }, 1000, 'Playa'), null);
});

test('the listener emits a sample for every reading - 3-second and one-minute - and filters by serial', () => {
  const samples = [];
  const listener = new TempestListener({ serial: 'ST-00000512', now: () => 5000 });
  listener.on('sample', (s) => samples.push(s));
  listener.handleMessage(rapidWind());
  listener.handleMessage(obsSt());
  listener.handleMessage(obsSt(undefined, 'ST-99999999')); // another station on the network
  assert.deepStrictEqual(samples, [
    { t: 5000, dir: 128, avg: 5.1, gust: 5.1, lull: 5.1, station: 'ST-00000512', units: 'mph' },
    { t: 5000, dir: 225, avg: 10, gust: 15, lull: 0.6, station: 'ST-00000512', units: 'mph' },
  ]);
  const status = listener.status();
  assert.deepStrictEqual([status.packets, status.ignored, status.samples], [3, 1, 2]);
  assert.deepStrictEqual(status.stationsHeard, ['ST-00000512', 'ST-99999999']);
  assert.strictEqual(status.lastRapid.speed, 5.1);
});

test('a 3-second reading with no speed or direction (a sensor fault) is not stored', () => {
  const samples = [];
  const listener = new TempestListener({ now: () => 1 });
  listener.on('sample', (s) => samples.push(s));
  listener.handleMessage(rapidWind(null, null));
  assert.deepStrictEqual(samples, []);
});

test('a 3-second sample\'s gust and lull are the highest and lowest speed of the last minute, per station', () => {
  let t = 0;
  const samples = [];
  const listener = new TempestListener({ now: () => t });
  listener.on('sample', (s) => samples.push(s));
  const ms = (mph) => mph / 2.2369362920544; // the station sends m/s
  t = 0; listener.handleMessage(rapidWind(ms(9), 0)); // 9 mph
  t = 30000; listener.handleMessage(rapidWind(ms(4), 0)); // 4 mph
  t = 30000; listener.handleMessage(rapidWind(ms(20), 0, 'ST-OTHER')); // another station: its own window
  t = 59000; listener.handleMessage(rapidWind(ms(6), 0)); // all three of this station's readings are within a minute
  const at59 = samples.at(-1);
  assert.deepStrictEqual([at59.avg, at59.gust, at59.lull], [6, 9, 4]);
  t = 61000; listener.handleMessage(rapidWind(ms(5), 0)); // the 9 mph reading is now over a minute old
  const at61 = samples.at(-1);
  assert.deepStrictEqual([at61.avg, at61.gust, at61.lull], [5, 6, 4]);
  assert.strictEqual(listener.status().lastSample, at61);
});

test('a configured station name is used in the samples', () => {
  const samples = [];
  const listener = new TempestListener({ stationName: 'Playa', now: () => 1 });
  listener.on('sample', (s) => samples.push(s));
  listener.handleMessage(obsSt());
  assert.strictEqual(samples[0].station, 'Playa');
});

test('recordWind adds the sample to the regatta\'s wind key and keeps the rolling window', async () => {
  const calls = [];
  const store = Object.assign(Object.create(RedisStore.prototype), {
    ready: Promise.resolve(),
    currentRegattaId: 'r1',
    trackRetentionSeconds: 172800,
    client: {
      zadd: (...a) => { calls.push(['zadd', ...a]); return Promise.resolve(1); },
      zremrangebyscore: (...a) => { calls.push(['zrem', ...a]); return Promise.resolve(0); },
      expire: (...a) => { calls.push(['expire', ...a]); return Promise.resolve(1); },
    },
  });
  const sample = { t: 200_000_000, dir: 225, avg: 10, gust: 15, lull: 0.6, station: 'Playa', units: 'mph' };
  await store.recordWind(sample);
  assert.deepStrictEqual(calls, [
    ['zadd', 'regattas:r1:wind', 200_000_000, JSON.stringify(sample)],
    ['zrem', 'regattas:r1:wind', '-inf', 200_000_000 - 172800 * 1000],
    ['expire', 'regattas:r1:wind', 172800],
  ]);
});

test('the direction range is the smallest arc holding every direction, across north too', () => {
  assert.deepStrictEqual(directionRange([200, 240, 215]), { from: 200, to: 240, width: 40 });
  assert.deepStrictEqual(directionRange([350, 5, 15, 355]), { from: 350, to: 15, width: 25 });
  assert.deepStrictEqual(directionRange([10, 10]), { from: 10, to: 10, width: 0 });
  assert.strictEqual(directionRange([]), null);
});

test('the swing covers the last 10 minutes of the newest station\'s readings', () => {
  let t = 0;
  const listener = new TempestListener({ now: () => t });
  assert.strictEqual(listener.directionSwing(), null);
  t = 0; listener.handleMessage(rapidWind(3, 300));
  t = 400000; listener.handleMessage(rapidWind(3, 340));
  t = 500000; listener.handleMessage(rapidWind(3, 10));
  assert.deepStrictEqual(listener.directionSwing(), { from: 300, to: 10, width: 70 });
  t = 650000; // the 300 reading is now over 10 minutes old
  assert.deepStrictEqual(listener.directionSwing(), { from: 340, to: 10, width: 30 });
});
