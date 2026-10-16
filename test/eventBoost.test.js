// eventBoost.js: the boat sends the fixes around a start, finish or foul crossing whatever its gates say. Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const { EventBoost } = require('../src/eventBoost');
const { METERS_PER_DEG_LAT } = require('../src/course');

const M = 1 / METERS_PER_DEG_LAT;
const LON_M = (m) => (m * M) / Math.cos((40 * Math.PI) / 180);
// a course with the start line pin(-60 m)..committeeStart(0) and the finish gate committeeFinish(6 m)..finish(60 m) on the same line at lat 40,
// the windward marks 1.4 km north and the leeward marks 0.9 km south
const at = (north, east) => ({ lat: 40 + north * M, lon: -118 + LON_M(east) });
const marks = {
  pin: at(0, -60), committeeStart: at(0, 0), committeeFinish: at(0, 6), finish: at(0, 60),
  windwardGreen: at(1400, 0), windwardBlack: at(1850, 0), leewardGreen: at(-450, 0), leewardBlack: at(-900, 0),
};
// a boat at 28 m/s with a fix every 100 ms, from `north0` metres, sailing north along `east`
const fixN = (i, east, north0 = -5) => ({ ...at(north0 + 2.8 * i, east), timestamp: 1_000_000 + i * 100 });

test('a finish crossing: the fix across the line is urgent, with the fixes just before it, and the next half second', () => {
  const b = new EventBoost(marks);
  const outs = [];
  for (let i = 0; i < 20; i++) outs.push(b.onFix(fixN(i, 30)));
  const k = outs.findIndex((o) => o.events.includes('finish'));
  assert.ok(k >= 1 && k <= 3, `finish seen at fix ${k}`);
  assert.ok(outs[k].urgent && outs[k].before.length >= 1 && outs[k].before.length <= 2, 'the fixes before it, at most two');
  assert.ok(outs[k + 5].urgent, 'still urgent a moment later');
  assert.ok(!outs[k + 9].urgent, 'and not a second after');
});

test('a start crossing is seen too, so a boat reporting sparsely still gets its crossing to the base', () => {
  const b = new EventBoost(marks);
  const outs = [];
  for (let i = 0; i < 20; i++) outs.push(b.onFix(fixN(i, -30))); // north through the start line, midway between the marks
  const k = outs.findIndex((o) => o.events.includes('start'));
  assert.ok(k >= 1 && k <= 3, `start seen at fix ${k}`);
  assert.ok(outs[k].urgent);
});

test('a boat that stays south of the line triggers nothing', () => {
  const b = new EventBoost(marks);
  for (let i = 0; i < 20; i++) assert.deepStrictEqual(b.onFix(fixN(i, 30, -80)).events, []);
});

test('missing marks do not break it: the detectors that can be built still work', () => {
  const b = new EventBoost({ pin: marks.pin, committeeStart: marks.committeeStart });
  for (let i = 0; i < 5; i++) assert.doesNotThrow(() => b.onFix(fixN(i, 30)));
});
