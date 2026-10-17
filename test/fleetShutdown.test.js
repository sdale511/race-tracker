const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const f = require('../src/fleetShutdown');

const appliedFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-')), 'applied.json');
const settings = (extra) => f.validate({ enabled: true, time: '17:00', idleMinutes: 10, speedKn: 0.5, stamp: 1000, ...extra });

test('shutdown settings are validated', () => {
  const s = f.validate({ enabled: true, time: '9:30', idleMinutes: '15', speedKn: '0.75' });
  assert.strictEqual(s.time, '09:30');
  assert.strictEqual(s.idleMinutes, 15);
  assert.strictEqual(s.speedKn, 0.75);
  assert.throws(() => f.validate({ time: '5pm' }), /HH:MM/);
  assert.throws(() => f.validate({ time: '17:00', idleMinutes: -1 }), /idle/);
  assert.throws(() => f.validate({ time: '17:00', speedKn: 'fast' }), /speed/);
  assert.strictEqual(f.validate({ time: '17:00' }).idleMinutes, 10); // the defaults
});

test('a boat applies the base\'s shutdown once, however often it is repeated, and a re-save of the same settings does nothing', () => {
  const file = appliedFile();
  const calls = [];
  const deps = { appliedFile: file, updateParams: (p) => calls.push(p) };
  assert.strictEqual(f.handleFrame(settings(), deps).ok, true);
  assert.deepStrictEqual(calls[0], { shutdownAt: '17:00', shutdownIdleMinutes: 10, shutdownSpeedKn: 0.5 });
  assert.strictEqual(f.handleFrame(settings(), deps), null); // the repeat
  assert.strictEqual(f.handleFrame(settings({ stamp: 2000 }), deps), null); // saved again, same settings
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(f.handleFrame(settings({ stamp: 3000, time: '18:00' }), deps).ok, true); // a change
  assert.strictEqual(calls.length, 2);
});

test('disabling disarms the boat\'s shutdown, once', () => {
  const calls = [];
  const deps = { appliedFile: appliedFile(), updateParams: (p) => calls.push(p) };
  f.handleFrame(settings(), deps);
  assert.strictEqual(f.handleFrame(settings({ enabled: false, stamp: 2000 }), deps).ok, true);
  assert.strictEqual(calls[1].shutdownAt, null);
  assert.strictEqual(f.handleFrame(settings({ enabled: false, stamp: 3000, time: '19:00' }), deps), null); // time is irrelevant while disabled
  assert.strictEqual(calls.length, 2);
});

test('a local edit on the boat is not undone by the base repeating the same settings', () => {
  const calls = [];
  const deps = { appliedFile: appliedFile(), updateParams: (p) => calls.push(p) };
  f.handleFrame(settings(), deps);
  // (the boat's controller was changed some other way; the base repeats the same settings)
  assert.strictEqual(f.handleFrame(settings(), deps), null);
  assert.strictEqual(calls.length, 1);
});

test('a failed apply is tried again on the next repeat', () => {
  const deps = { appliedFile: appliedFile(), updateParams: () => { throw new Error('already shutting down'); } };
  assert.strictEqual(f.handleFrame(settings(), deps).ok, false);
  const calls = [];
  deps.updateParams = (p) => calls.push(p);
  assert.strictEqual(f.handleFrame(settings(), deps).ok, true);
  assert.strictEqual(calls.length, 1);
});

test('the boat status describes what the base sent', () => {
  const file = appliedFile();
  assert.strictEqual(f.boatStatus(file), null);
  f.handleFrame(settings(), { appliedFile: file, updateParams: () => {} });
  assert.match(f.boatStatus(file).description, /after 17:00 local time/);
});
