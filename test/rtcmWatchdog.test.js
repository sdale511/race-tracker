// The boat's warning for correction bursts that are not heard (rtcmWatchdog.js). Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const { BurstTracker } = require('../src/burstTracker');
const { RtcmWatchdog } = require('../src/rtcmWatchdog');

const TYPES = [1005, 1074, 1084, 1094, 1124, 1230];
function setup(over = {}) {
  const clock = { t: 0 };
  const tracker = new BurstTracker({ now: () => clock.t });
  const warned = [];
  const info = [];
  const dog = new RtcmWatchdog({ tracker, now: () => clock.t, warn: (m) => warned.push(m), info: (m) => info.push(m), graceMs: 20000, repeatMs: 30000, ...over });
  // one burst of six messages, 6 ms apart, starting at the clock's time
  const burst = () => TYPES.forEach((ty, i) => tracker.onRtcm(ty, clock.t + i * 6, 100));
  return { clock, tracker, dog, warned, info, burst };
}
const at = (c, ms) => { c.t = ms; };

test('a boat that has never heard a burst warns once the grace time has passed, then repeats, and is quiet before', () => {
  const { clock, dog, warned } = setup();
  at(clock, 10000); dog.check();
  assert.strictEqual(warned.length, 0, 'still inside the grace time');
  at(clock, 21000); dog.check();
  assert.strictEqual(warned.length, 1);
  assert.match(warned[0], /since this boat started/);
  at(clock, 40000); dog.check();
  assert.strictEqual(warned.length, 1, 'not repeated before repeatMs');
  at(clock, 52000); dog.check();
  assert.strictEqual(warned.length, 2);
});

test('bursts that stop warn, with how long, and are reported when they come back', () => {
  const { clock, dog, warned, info, burst } = setup();
  for (let k = 0; k < 8; k++) { at(clock, 1000 + k * 2000); burst(); dog.check(); }
  assert.strictEqual(warned.length, 0, 'bursts are heard: nothing to say');
  at(clock, 60000); dog.check(); // 45 s since the last burst (at 15000)
  assert.strictEqual(warned.length, 1);
  assert.match(warned[0], /no correction bursts heard for 45 s/);
  for (let k = 0; k < 4; k++) { at(clock, 62000 + k * 2000); burst(); dog.check(); }
  assert.strictEqual(info.length, 1);
  assert.match(info[0], /heard again after/);
  at(clock, 120000); dog.check();
  assert.strictEqual(warned.length, 2, 'a new silence warns again');
});

test('while the radio is asleep on purpose nothing is said, and the grace time starts again on waking', () => {
  let asleep = true;
  const { clock, dog, warned } = setup({ paused: () => asleep });
  at(clock, 100000); dog.check();
  assert.strictEqual(warned.length, 0);
  asleep = false;
  at(clock, 105000); dog.check();
  assert.strictEqual(warned.length, 0, 'five seconds after waking is inside the grace time');
  at(clock, 126000); dog.check();
  assert.strictEqual(warned.length, 1);
});

test('the warning is passed through the colour function', () => {
  const { clock, warned, tracker } = setup();
  const dog = new RtcmWatchdog({ tracker, warn: (m) => warned.push(m), color: (s) => `<<${s}>>`, graceMs: 1000 });
  at(clock, 2000); dog.check();
  assert.match(warned[0], /^<<\[rtcm\] WARNING/);
});
