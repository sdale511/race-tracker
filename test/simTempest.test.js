const test = require('node:test');
const assert = require('node:assert');
const { SimTempest, pickWind, meanDirection, obsStMessage, rapidWindMessage } = require('../src/simTempest');
const { TempestListener, parseTempestMessage } = require('../src/tempestListener');

const range = { minMph: 5, maxMph: 8, dirSwingDeg: 10 };
// A repeatable stand-in for Math.random
const seq = (...values) => { let i = 0; return () => values[i++ % values.length]; };

test('a new wind is 5-8 mph and within 10 degrees of the course axis, either side of north too', () => {
  for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
    const w = pickWind(0, range, () => r);
    assert.ok(w.mph >= 5 && w.mph <= 8, `speed ${w.mph}`);
    const off = Math.min(Math.abs(w.dir - 0), 360 - Math.abs(w.dir - 0));
    assert.ok(off <= 10, `direction ${w.dir}`);
  }
  assert.deepStrictEqual(pickWind(90, range, () => 0), { dir: 80, mph: 5 });
  assert.strictEqual(pickWind(0, range, () => 0).dir, 350);
});

test('directions average around north, not through south', () => {
  assert.ok(Math.abs(meanDirection([350, 10])) < 1e-9 || Math.abs(meanDirection([350, 10]) - 360) < 1e-9);
  assert.ok(Math.abs(meanDirection([80, 100]) - 90) < 1e-9);
});

test('the minute\'s obs_st reads back as the lowest, mean and highest 3-second speeds', () => {
  const readings = [{ dir: 355, mph: 5 }, { dir: 5, mph: 6 }, { dir: 0, mph: 7 }];
  const parsed = parseTempestMessage(Buffer.from(JSON.stringify(obsStMessage('ST-SIM00001', 1000, readings))));
  assert.strictEqual(parsed.type, 'obs');
  assert.strictEqual(parsed.serial, 'ST-SIM00001');
  assert.strictEqual(parsed.dir, 0);
  assert.deepStrictEqual([parsed.lull, parsed.avg, parsed.gust], [5, 6, 7]);
});

test('a rapid_wind reads back in mph', () => {
  const parsed = parseTempestMessage(Buffer.from(JSON.stringify(rapidWindMessage('ST-SIM00001', 1000, { dir: 12.4, mph: 6.5 }))));
  assert.deepStrictEqual([parsed.type, parsed.dir, parsed.speed], ['rapid', 12, 6.5]);
});

test('the wind is held for changeS seconds, then a new one is picked from the current axis', () => {
  let t = 0;
  let axis = 0;
  const sim = new SimTempest({ port: 1, getAxisDeg: () => axis, changeS: 30, rng: seq(0.5), now: () => t });
  const first = sim.currentWind();
  t = 29000;
  assert.strictEqual(sim.currentWind(), first);
  axis = 90; // the course was rotated
  t = 30000;
  assert.deepStrictEqual(sim.currentWind(), { dir: 90, mph: 6.5 });
});

test('starting does not read the course axis (it resolves after the base starts)', () => {
  const sim = new SimTempest({ port: 1, getAxisDeg: () => assert.fail('read at start') }).start();
  sim.stop();
});

test('its messages reach the real listener over UDP and become one wind sample a minute', async () => {
  const port = 50297;
  const listener = new TempestListener({ port }).start();
  const samples = [];
  listener.on('sample', (s) => samples.push(s));
  const sim = new SimTempest({ port, getAxisDeg: () => 180, rng: seq(0.5) });
  sim.socket = require('dgram').createSocket('udp4'); // send without the start() timers
  await new Promise((r) => setTimeout(r, 50));
  for (let i = 0; i < 3; i++) sim.sendRapid();
  sim.sendObs();
  await new Promise((r) => setTimeout(r, 200));
  sim.stop();
  listener.close();
  assert.strictEqual(samples.length, 1);
  assert.strictEqual(samples[0].dir, 180);
  assert.strictEqual(samples[0].avg, 6.5);
  assert.strictEqual(samples[0].station, 'ST-SIM00001');
  assert.strictEqual(listener.status().lastRapid.dir, 180);
});
