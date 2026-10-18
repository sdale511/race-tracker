const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const protocol = require('../src/protocol');
const { createPowerScheduleStore } = require('../src/powerScheduleStore');

const make = (extra = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-'));
  const sent = [];
  let t = Date.UTC(2026, 9, 16, 12, 0, 0);
  const opts = { send: (f) => sent.push(protocol.decodePowerSchedule(f)), wittyFile: path.join(dir, 'w.json'), shutdownFile: path.join(dir, 's.json'), nowMs: () => t, log: () => {}, ...extra };
  return { store: createPowerScheduleStore(opts), sent, opts, tick: (ms) => { t += ms; } };
};
const daily = { action: 'enable', mode: 'daily', startTime: '09:00', endTime: '17:00' };
const shutdownOn = { action: 'enable', time: '17:00', idleMinutes: 10, speedKn: 0.5 };

test('nothing is sent until a rule has been set', () => {
  const { store, sent } = make();
  assert.strictEqual(store.frame(), null);
  assert.strictEqual(store.sendNow(), false);
  assert.strictEqual(sent.length, 0);
});

test('enabling the Witty Pi rule sends it, and the shutdown stays "not managed"', () => {
  const { store, sent } = make();
  store.setWitty(daily);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].witty.mode, 'daily');
  assert.strictEqual(sent[0].shutdown, null);
});

test('enabling the shutdown sends it alongside the Witty Pi rule in the same frame', () => {
  const { store, sent } = make();
  store.setWitty(daily);
  store.setShutdown(shutdownOn);
  const last = sent[sent.length - 1];
  assert.strictEqual(last.witty.mode, 'daily');
  assert.strictEqual(last.shutdown.enabled, true);
  assert.strictEqual(last.shutdown.time, '17:00');
});

test('disabling keeps the values, and the disabled rule is still sent so a boat that missed the change gets it', () => {
  const { store, sent, tick } = make();
  store.setWitty(daily);
  tick(5000);
  store.setWitty({ action: 'disable' });
  assert.strictEqual(sent[sent.length - 1].witty.mode, 'off'); // boats remove the schedule
  assert.strictEqual(store.status().witty.settings.startTime, '09:00'); // values kept
  assert.strictEqual(store.status().witty.settings.enabled, false);
  store.setShutdown(shutdownOn);
  store.setShutdown({ action: 'disable' });
  assert.strictEqual(sent[sent.length - 1].shutdown.enabled, false);
  assert.strictEqual(sent[sent.length - 1].shutdown.time, '17:00');
});

test('enabling again without new fields uses the stored values', () => {
  const { store, sent } = make();
  store.setWitty({ ...daily, endTime: '18:30' });
  store.setWitty({ action: 'disable' });
  store.setWitty({ action: 'enable' });
  assert.strictEqual(sent[sent.length - 1].witty.mode, 'daily');
  assert.strictEqual(sent[sent.length - 1].witty.endTime, '18:30');
});

test('bad input is refused with a plain message and changes nothing', () => {
  const { store, sent } = make();
  assert.throws(() => store.setWitty({ action: 'enable' }), /fill in the schedule/);
  assert.throws(() => store.setWitty({ action: 'disable' }), /no schedule to disable/);
  assert.throws(() => store.setWitty({ action: 'enable', mode: 'daily', startTime: 'x', endTime: '17:00' }), /HH:MM/);
  assert.throws(() => store.setWitty({ action: 'enable', mode: 'sun', lat: '', lon: '' }), /latitude/);
  assert.throws(() => store.setWitty({ action: 'save' }), /unknown action/);
  assert.throws(() => store.setShutdown({ action: 'enable' }), /shutdown time first/);
  assert.throws(() => store.setShutdown({ action: 'enable', time: '25:00' }), /HH:MM/);
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(store.frame(), null);
});

test('settings survive a restart of the base', () => {
  const a = make();
  a.store.setWitty(daily);
  a.store.setShutdown(shutdownOn);
  const b = createPowerScheduleStore({ ...a.opts, send: () => {} });
  const frame = protocol.decodePowerSchedule(b.frame());
  assert.strictEqual(frame.witty.endTime, '17:00');
  assert.strictEqual(frame.shutdown.enabled, true);
});

test('the frame stamp is the newer of the two rules\' changes', () => {
  const { store, sent, tick } = make();
  store.setWitty(daily);
  tick(60000);
  store.setShutdown(shutdownOn);
  const stamps = sent.map((f) => f.stamp);
  assert.ok(stamps[1] > stamps[0]);
});

test('with no radio nothing is sent, and the status says so', () => {
  const { store, sent } = make({ radioEnabled: () => false });
  store.setWitty(daily);
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(store.status().radioEnabled, false);
});

test('the status carries the send count, reset by every change, and the course place for the sunrise fields', () => {
  const { store } = make({ getPlace: () => ({ lat: 40.89, lon: -118.38 }) });
  store.setWitty(daily);
  store.sendNow();
  store.sendNow();
  assert.strictEqual(store.status().sendCount, 3);
  store.setShutdown(shutdownOn);
  assert.strictEqual(store.status().sendCount, 1);
  assert.deepStrictEqual(store.status().witty.defaultPlace, { lat: 40.89, lon: -118.38 });
});

test('a boat that has an old file saved before Enable existed stays disabled', () => {
  const { opts } = make();
  fs.writeFileSync(opts.wittyFile, JSON.stringify({ mode: 'daily', startTime: '09:00', endTime: '17:00', stamp: 5 }));
  const store = createPowerScheduleStore({ ...opts, send: () => {} });
  assert.strictEqual(store.status().witty.settings.enabled, false);
  assert.strictEqual(protocol.decodePowerSchedule(store.frame()).witty.mode, 'off');
});
