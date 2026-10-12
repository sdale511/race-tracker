const test = require('node:test');
const assert = require('node:assert');
const { BurstTracker } = require('../src/burstTracker');

// What a real base looked like at a 2 s interval (a capture on the shared radio): the 25-byte station message (1005) comes
// alone, a second before the five observation messages, which arrive together.
const SIZES = { 1005: 25, 1074: 144, 1084: 115, 1094: 144, 1124: 95, 1230: 16 };
function feed(tr, withSizes, cycles = 8) {
  for (let k = 0; k < cycles; k++) {
    const t0 = 1000 + k * 2000;
    tr.onRtcm(1005, t0, withSizes ? SIZES[1005] : undefined);
    for (const ty of [1074, 1084, 1094, 1124, 1230]) tr.onRtcm(ty, t0 + 1000 + (ty === 1230 ? 4 : 0), withSizes ? SIZES[ty] : undefined);
  }
}

test('a lone small message a second ahead of the observations does not halve the heard period', () => {
  const tr = new BurstTracker({ now: () => 0 });
  feed(tr, true);
  assert.ok(Math.abs(tr.period - 2000) < 5, `period ${tr.period}`);
  // bursts start at the observations (the last cycle's are at 15000 + 1000), not at the station message
  assert.ok(Math.abs(tr.lastStart - 16000) < 5, `lastStart ${tr.lastStart}`);
});

test('without sizes (older callers) every message still counts, as before', () => {
  const tr = new BurstTracker({ now: () => 0 });
  feed(tr, false);
  assert.ok(Math.abs(tr.period - 1000) < 5, `period ${tr.period}`);
});

test('an aligned burst that begins with the small message still works', () => {
  const tr = new BurstTracker({ now: () => 0 });
  for (let k = 0; k < 8; k++) {
    const t0 = 1000 + k * 2000;
    tr.onRtcm(1005, t0, 25);
    [1074, 1084, 1094, 1124, 1230].forEach((ty, i) => tr.onRtcm(ty, t0 + 40 + i * 30, SIZES[ty]));
  }
  assert.ok(Math.abs(tr.period - 2000) < 5, `period ${tr.period}`);
});
