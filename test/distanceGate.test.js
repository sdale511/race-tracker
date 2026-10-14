const test = require('node:test');
const assert = require('node:assert');
const { DistanceGate } = require('../src/distanceGate');
const { distanceMeters, METERS_PER_DEG_LAT } = require('../src/course');

const M = 1 / METERS_PER_DEG_LAT; // one metre of latitude, in degrees
const at = (northM, tMs) => ({ lat: 40 + northM * M, lon: -118, timestamp: 1_700_000_000_000 + tMs });

// Runs a boat through the gate and returns the fixes that cleared it. sendEveryMs is how often a held fix actually goes out
// (the slot cycle): the old gate only learned about a send then.
function run({ speedMps, hz = 10, seconds, distanceM = 1, intervalMs = 60000 }) {
  const gate = new DistanceGate({ intervalMs });
  const passed = [];
  for (let i = 0; i < seconds * hz; i++) {
    const fix = at((speedMps * i) / hz, (i * 1000) / hz);
    if (gate.cleared(fix, distanceM)) {
      gate.advance(fix);
      gate.sent(fix);
      passed.push(fix);
    }
  }
  return passed;
}

test('a boat creeping at 1.3 kn sends a fix about every metre, not clusters of fixes a millimetre apart', () => {
  const passed = run({ speedMps: 0.67, seconds: 10 });
  assert.ok(passed.length >= 6 && passed.length <= 8, `expected about 7 fixes in 10 s, got ${passed.length}`);
  for (let i = 1; i < passed.length; i++) {
    assert.ok(distanceMeters(passed[i - 1], passed[i]) >= 1, 'consecutive fixes are at least a metre apart');
  }
});

test('a fast boat clears the gate on every fix', () => {
  const passed = run({ speedMps: 15, seconds: 5 }); // 1.5 m per fix at 10 Hz
  assert.strictEqual(passed.length, 50);
});

test('a stationary boat sends one fix per heartbeat, not a batch of copies', () => {
  const passed = run({ speedMps: 0, seconds: 130, intervalMs: 60000 });
  assert.strictEqual(passed.length, 3); // at 0 s, 60 s and 120 s
});

test('the gate measures from the last fix that cleared it, whether or not it has gone out yet', () => {
  const gate = new DistanceGate({ intervalMs: 0 });
  const first = at(0, 0);
  assert.ok(gate.cleared(first, 1));
  gate.advance(first); // queued for its slot, not sent yet
  assert.ok(!gate.cleared(at(0.3, 100), 1));
  assert.ok(!gate.cleared(at(0.9, 200), 1));
  assert.ok(gate.cleared(at(1.1, 300), 1));
});

test('a failed send hands the reference back so the next fix passes at once', () => {
  const gate = new DistanceGate({ intervalMs: 0 });
  const first = at(0, 0);
  gate.advance(first);
  gate.sent(first);
  const second = at(2, 1000);
  gate.advance(second); // queued ...
  gate.failed(); // ... but never left the boat
  assert.ok(gate.cleared(at(2.1, 1100), 1), 'measured from the last fix that really went out');
});

test('before anything has gone out, a failed send leaves the gate open', () => {
  const gate = new DistanceGate({ intervalMs: 60000 });
  gate.advance(at(0, 0));
  gate.failed();
  assert.ok(gate.cleared(at(0, 100), 1));
});
