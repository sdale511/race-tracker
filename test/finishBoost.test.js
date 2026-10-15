// finishBoost.js: the boat sends the fixes around a finish crossing whatever its gates say. Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const { FinishBoost } = require('../src/finishBoost');
const { METERS_PER_DEG_LAT } = require('../src/course');

const M = 1 / METERS_PER_DEG_LAT;
const marks = { committeeFinish: { lat: 40, lon: -118 }, finish: { lat: 40, lon: -118 + 60 * M / Math.cos((40 * Math.PI) / 180) } };
// a boat sailing north through the middle of the line at 28 m/s with a fix every 100 ms; fix 0 is 5 m south of the line
const fix = (i) => ({ lat: 40 + (-5 + 2.8 * i) * M, lon: -118 + 30 * M / Math.cos((40 * Math.PI) / 180), timestamp: 1_000_000 + i * 100 });

test('the fix that crosses the line is urgent and brings the fixes just before it, then the next second is urgent too', () => {
  const b = new FinishBoost(marks);
  const outs = [];
  for (let i = 0; i < 40; i++) outs.push(b.onFix(fix(i)));
  const crossAt = outs.findIndex((o) => o.before.length > 0);
  assert.ok(crossAt >= 1 && crossAt <= 3, `crossing seen at fix ${crossAt}`);
  assert.ok(outs[crossAt].urgent);
  assert.ok(outs[crossAt].before.length <= crossAt && outs[crossAt].before.length >= 1, 'the earlier fixes, oldest first');
  assert.ok(outs[crossAt].before.every((f, i, a) => i === 0 || f.timestamp > a[i - 1].timestamp));
  assert.ok(outs[crossAt + 10].urgent, 'a second later it is still urgent');
  assert.ok(!outs[crossAt + 25].urgent, 'and by 2.5 s later it is not');
  assert.ok(!outs.slice(0, crossAt).some((o) => o.urgent), 'nothing urgent before the line');
});

test('a boat that does not cross the line never triggers it, and neither does one crossing downwind', () => {
  const b = new FinishBoost(marks);
  for (let i = 0; i < 20; i++) assert.deepStrictEqual(b.onFix({ ...fix(0), timestamp: 1_000_000 + i * 100 }), { urgent: false, before: [] });
  const c = new FinishBoost(marks);
  const south = (i) => ({ ...fix(0), lat: 40 + (5 - 2.8 * i) * M, timestamp: 2_000_000 + i * 100 });
  for (let i = 0; i < 10; i++) assert.strictEqual(c.onFix(south(i)).urgent, false);
});
