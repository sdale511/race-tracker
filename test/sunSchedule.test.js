const test = require('node:test');
const assert = require('node:assert');
const { sunTimes, formatDuration, buildSchedule } = require('../src/sunSchedule');

const minutesApart = (a, b) => Math.abs(a - b) / 60000;
const utc = (s) => Date.parse(s);

test('sunrise and sunset agree with published values to a few minutes', () => {
  // Greenwich at the March equinox, the Black Rock desert in October, Sydney at the December solstice
  const g = sunTimes(new Date(2026, 2, 20), 51.4779, 0);
  assert.ok(minutesApart(g.sunrise, utc('2026-03-20T06:03:00Z')) < 5);
  assert.ok(minutesApart(g.sunset, utc('2026-03-20T18:13:00Z')) < 5);
  const b = sunTimes(new Date(2026, 9, 16), 40.89, -118.39);
  assert.ok(minutesApart(b.sunrise, utc('2026-10-16T14:07:00Z')) < 6);
  assert.ok(minutesApart(b.sunset, utc('2026-10-17T01:10:00Z')) < 6);
  const s = sunTimes(new Date(2026, 11, 21), -33.87, 151.21);
  assert.ok(minutesApart(s.sunrise, utc('2026-12-20T18:41:00Z')) < 6);
  assert.ok(minutesApart(s.sunset, utc('2026-12-21T09:05:00Z')) < 6);
});

test('a place with a polar night has no sunrise', () => {
  assert.strictEqual(sunTimes(new Date(2026, 11, 21), 80, 0), null);
});

test('durations are written in the Witty Pi\'s H, M and S units', () => {
  assert.strictEqual(formatDuration((11 * 3600 + 6 * 60 + 40) * 1000), 'H11 M6 S40');
  assert.strictEqual(formatDuration(8 * 3600 * 1000), 'H8');
  assert.strictEqual(formatDuration(59000), 'S59');
  assert.strictEqual(formatDuration(0), 'S1');
});

test('each day is an ON state to sunset plus the margin and an OFF state to the next sunrise minus the margin', () => {
  const text = buildSchedule({ lat: 40.89, lon: -118.39, from: new Date(2026, 9, 16), days: 3, beforeMin: 30, afterMin: 30 });
  const states = text.split('\n').filter((l) => /^(ON|OFF)\s/.test(l));
  assert.strictEqual(states.length, 6); // 3 days, one ON and one OFF each
  assert.ok(states.filter((l) => l.startsWith('ON')).every((l) => l.endsWith(' WAIT')));
  // a day is 24 hours: each ON plus the OFF after it is within a few minutes of a day (sunrise moves about a minute a day)
  const secs = (line) => {
    const m = [...line.matchAll(/([HMS])(\d+)/g)];
    return m.reduce((t, [, u, v]) => t + Number(v) * { H: 3600, M: 60, S: 1 }[u], 0);
  };
  for (let i = 0; i < states.length; i += 2) {
    const total = secs(states[i]) + secs(states[i + 1]);
    assert.ok(Math.abs(total - 86400) < 300, `day ${i / 2} is ${total} s`);
  }
});

test('--hard-stop leaves WAIT off, so the Witty Pi shuts the Pi down itself', () => {
  const text = buildSchedule({ lat: 40.89, lon: -118.39, from: new Date(2026, 9, 16), days: 2, hardStop: true });
  assert.ok(!/WAIT/.test(text.split('\n').filter((l) => /^ON/.test(l)).join('\n')));
});
