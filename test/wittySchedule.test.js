const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const w = require('../src/wittySchedule');
const protocol = require('../src/protocol');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'witty-'));
const fakeInstall = () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'runScript.sh'), '#!/bin/bash\n');
  return dir;
};
const noon = new Date(2026, 9, 16, 12, 0, 0);

test('settings are validated and normalised', () => {
  const s = w.validateSettings({ mode: 'daily', startTime: '9:05', endTime: '17:00' }, noon.getTime());
  assert.strictEqual(s.startTime, '09:05');
  assert.strictEqual(s.stamp, Math.floor(noon.getTime() / 1000));
  assert.throws(() => w.validateSettings({ mode: 'daily', startTime: '9am', endTime: '17:00' }), /HH:MM/);
  assert.throws(() => w.validateSettings({ mode: 'daily', startTime: '09:00', endTime: '09:00' }), /differ/);
  assert.throws(() => w.validateSettings({ mode: 'sun', lat: 95, lon: 0 }), /latitude/);
  assert.throws(() => w.validateSettings({ mode: 'sun', lat: 40, lon: '' }), /longitude/);
  assert.throws(() => w.validateSettings({ mode: 'weekly' }), /mode/);
  assert.strictEqual(w.validateSettings({ mode: 'off' }).mode, 'off');
});

test('a daily schedule is an ON state for the hours and an OFF state for the rest of the day', () => {
  const text = w.buildScript(w.validateSettings({ mode: 'daily', startTime: '09:00', endTime: '17:00' }), noon);
  assert.match(text, /^BEGIN 2026-10-16 09:00:00$/m);
  assert.match(text, /^ON    H8$/m);
  assert.match(text, /^OFF   H16$/m);
  const halting = w.buildScript(w.validateSettings({ mode: 'daily', startTime: '09:00', endTime: '17:30', haltItself: true }), noon);
  assert.match(halting, /^ON    H8 M30 WAIT$/m);
  assert.match(halting, /^OFF   H15 M30$/m);
});

test('a day that runs past midnight wraps', () => {
  const text = w.buildScript(w.validateSettings({ mode: 'daily', startTime: '20:00', endTime: '04:00' }), noon);
  assert.match(text, /^ON    H8$/m);
  assert.match(text, /^OFF   H16$/m);
});

test('the sunrise-to-sunset mode builds one ON and OFF pair per day', () => {
  const text = w.buildScript(w.validateSettings({ mode: 'sun', lat: 40.89, lon: -118.39, days: 5 }), noon);
  assert.strictEqual(text.split('\n').filter((l) => /^ON\s/.test(l)).length, 5);
});

test('applying writes schedule.wpi, keeps an old one once, and runs the board\'s own script', async () => {
  const dir = fakeInstall();
  fs.writeFileSync(path.join(dir, 'schedule.wpi'), 'old schedule');
  const ran = [];
  const runner = async (d, script) => { ran.push([d, script]); return { code: 0, output: '' }; };
  const r = await w.applySettings(w.validateSettings({ mode: 'daily', startTime: '09:00', endTime: '17:00' }), { dir, runner, now: noon });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(ran, [[dir, 'runScript.sh']]);
  assert.match(fs.readFileSync(path.join(dir, 'schedule.wpi'), 'utf8'), /^ON    H8$/m);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'schedule.wpi.bak'), 'utf8'), 'old schedule');
  await w.applySettings(w.validateSettings({ mode: 'daily', startTime: '08:00', endTime: '16:00' }), { dir, runner, now: noon });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'schedule.wpi.bak'), 'utf8'), 'old schedule'); // not overwritten by our own file
});

test('a failed load is reported but the file stays written', async () => {
  const dir = fakeInstall();
  const r = await w.applySettings(w.validateSettings({ mode: 'daily', startTime: '09:00', endTime: '17:00' }), { dir, runner: async () => ({ code: 1, output: 'i2c permission denied' }), now: noon });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.wrote, true);
  assert.match(r.message, /permission denied/);
  assert.ok(fs.existsSync(path.join(dir, 'schedule.wpi')));
});

test('mode off removes the schedule and clears the board\'s next times', async () => {
  const dir = fakeInstall();
  fs.writeFileSync(path.join(dir, 'schedule.wpi'), 'x');
  const r = await w.applySettings({ mode: 'off' }, { dir, clear: async () => ({ code: 0, output: '' }) });
  assert.strictEqual(r.ok, true);
  assert.ok(!fs.existsSync(path.join(dir, 'schedule.wpi')));
});

test('without the Witty Pi software nothing is written', async () => {
  const dir = tmp();
  const r = await w.applySettings(w.validateSettings({ mode: 'daily', startTime: '09:00', endTime: '17:00' }), { dir });
  assert.strictEqual(r.installed, false);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

const frameFor = (extra) => protocol.decodeWittySchedule(protocol.encodeWittySchedule(w.validateSettings({ mode: 'daily', startTime: '09:00', endTime: '17:00', stamp: 1000, ...extra })));
const boat = () => {
  const dir = fakeInstall();
  const calls = { runs: 0 };
  return { calls, deps: { dir, appliedFile: path.join(tmp(), 'applied.json'), now: noon, runner: async () => { calls.runs++; return { code: 0, output: '' }; } } };
};

test('a boat applies the schedule once, however often the base repeats it', async () => {
  const { calls, deps } = boat();
  assert.strictEqual((await w.handleScheduleFrame(frameFor(), deps)).ok, true);
  assert.strictEqual(await w.handleScheduleFrame(frameFor(), deps), null); // the repeat
  assert.strictEqual(calls.runs, 1);
});

test('saving the same settings again (a new stamp) does not reprogram the boat, but a change does', async () => {
  const { calls, deps } = boat();
  await w.handleScheduleFrame(frameFor({ stamp: 1000 }), deps);
  assert.strictEqual(await w.handleScheduleFrame(frameFor({ stamp: 2000 }), deps), null);
  assert.strictEqual(calls.runs, 1);
  assert.strictEqual((await w.handleScheduleFrame(frameFor({ stamp: 3000, endTime: '18:00' }), deps)).ok, true);
  assert.strictEqual(calls.runs, 2);
});

test('a setting that does not matter for the mode is not a difference', async () => {
  const { calls, deps } = boat();
  await w.handleScheduleFrame(frameFor({ lat: 10, lon: 20 }), deps); // daily mode ignores the place
  assert.strictEqual(await w.handleScheduleFrame(frameFor({ stamp: 5, lat: 50, lon: 60 }), deps), null);
  assert.strictEqual(calls.runs, 1);
});

test('a boat whose schedule file has gone applies the schedule again', async () => {
  const { calls, deps } = boat();
  await w.handleScheduleFrame(frameFor(), deps);
  fs.rmSync(path.join(deps.dir, 'schedule.wpi'));
  assert.strictEqual((await w.handleScheduleFrame(frameFor(), deps)).ok, true);
  assert.strictEqual(calls.runs, 2);
});

test('a failed apply is tried again on the next repeat', async () => {
  const dir = fakeInstall();
  const appliedFile = path.join(tmp(), 'applied.json');
  let ok = false;
  const deps = { dir, appliedFile, now: noon, runner: async () => (ok ? { code: 0, output: '' } : { code: 1, output: 'busy' }) };
  assert.strictEqual((await w.handleScheduleFrame(frameFor(), deps)).ok, false);
  ok = true;
  assert.strictEqual((await w.handleScheduleFrame(frameFor(), deps)).ok, true);
});

test('a sunrise-to-sunset file that is about to run out is written again', () => {
  const settings = w.validateSettings({ mode: 'sun', lat: 40, lon: -118, days: 366 });
  const applied = { ok: true, settings, coversUntil: noon.getTime() + 20 * 86400000 };
  assert.strictEqual(w.needsApply(settings, applied, true, noon.getTime()), false);
  assert.strictEqual(w.needsApply(settings, applied, true, noon.getTime() + 10 * 86400000), true); // 10 days left
});

test('a boat without the Witty Pi software says so once, and records nothing', async () => {
  const deps = { dir: tmp(), appliedFile: path.join(tmp(), 'applied.json'), now: noon };
  assert.strictEqual((await w.handleScheduleFrame(frameFor({ stamp: 77 }), deps)).notInstalled, true);
  assert.strictEqual(await w.handleScheduleFrame(frameFor({ stamp: 77 }), deps), null);
  assert.ok(!fs.existsSync(deps.appliedFile));
});

test('the schedule frame survives the radio encoding', () => {
  const s = w.validateSettings({ mode: 'sun', lat: 40.89, lon: -118.39, beforeMin: 20, afterMin: 40, days: 200, haltItself: true, stamp: 12345 });
  const back = protocol.decodeWittySchedule(protocol.encodeWittySchedule(s));
  assert.strictEqual(back.mode, 'sun');
  assert.strictEqual(back.haltItself, true);
  assert.strictEqual(back.stamp, 12345);
  assert.ok(Math.abs(back.lat - 40.89) < 1e-5 && Math.abs(back.lon + 118.39) < 1e-5);
  assert.strictEqual(back.days, 200);
});

test('the simulated radio link delivers the schedule frame as a witty-schedule event', () => {
  const { decodeDatagram } = require('../src/simRadioLink');
  const frame = protocol.encodeWittySchedule(w.validateSettings({ mode: 'daily', startTime: '09:00', endTime: '17:00', stamp: 9 }));
  const got = decodeDatagram(frame);
  assert.strictEqual(got.event, 'witty-schedule');
  assert.strictEqual(got.decoded.endTime, '17:00');
});

test('the boat status says whether the software is installed and shows what was applied', async () => {
  const none = w.boatStatus({ dir: tmp(), appliedFile: path.join(tmp(), 'applied.json') });
  assert.strictEqual(none.installed, false);
  assert.strictEqual(none.file, null);
  const { deps } = boat();
  await w.handleScheduleFrame(frameFor(), deps);
  const st = w.boatStatus(deps);
  assert.strictEqual(st.installed, true);
  assert.match(st.description, /09:00 to 17:00/);
  assert.match(st.file, /^ON    H8$/m);
});
