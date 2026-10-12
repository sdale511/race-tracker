const test = require('node:test');
const assert = require('node:assert');
const stats = require('../src/stats');

test('fix rate comes from the fixes\' own times, so a burst that arrives at once still reads right', () => {
  const t0 = Date.now() - 4000;
  // 3 slot cycles of 16 fixes at 8 Hz, each cycle delivered in one go (same arrival millisecond)
  for (let cycle = 0; cycle < 3; cycle++) {
    for (let i = 0; i < 16; i++) stats.recordFrame('90001', { lat: 1, lon: 1 }, { carrSoln: 2, gnssFixOk: true, numSV: 14 }, t0 + (cycle * 16 + i) * 125);
  }
  const hz = stats.snapshot().boats['90001'].fixHz;
  assert.ok(hz > 7.5 && hz < 8.5, `expected about 8 Hz, got ${hz}`);
});

test('fixes of one frame in any order give the same rate', () => {
  const t0 = Date.now() - 4000;
  const order = [3, 0, 2, 1, 7, 5, 6, 4];
  for (const i of order) stats.recordFrame('90002', null, null, t0 + i * 250);
  const hz = stats.snapshot().boats['90002'].fixHz;
  assert.ok(hz > 3.5 && hz < 4.5, `expected about 4 Hz, got ${hz}`);
});
