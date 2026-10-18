const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { RadioLink } = require('../src/radioLink');
const protocol = require('../src/protocol');

// A RadioLink without a serial port: only its byte-stream scanner is exercised.
const scanner = () => {
  const link = Object.create(RadioLink.prototype);
  EventEmitter.call(link);
  link._buf = Buffer.alloc(0);
  const events = [];
  for (const name of ['power-schedule', 'ping', 'sync-error']) link.on(name, (x) => events.push([name, x]));
  return { link, events };
};
const frame = (extra = {}) =>
  protocol.encodePowerSchedule({
    stamp: 100,
    witty: { mode: 'daily', haltItself: false, startTime: '09:00', endTime: '17:00', lat: 0, lon: 0, beforeMin: 30, afterMin: 30, days: 366 },
    shutdown: { enabled: true, time: '17:00', idleMinutes: 10, speedKn: 0.5 },
    ...extra,
  });

test('the real radio scanner delivers a power schedule frame, even split across reads and after noise', () => {
  const { link, events } = scanner();
  const f = frame();
  link._onData(Buffer.concat([Buffer.from([0x01, 0x02, 0x03]), f.slice(0, 10)]));
  assert.strictEqual(events.filter((e) => e[0] === 'power-schedule').length, 0);
  link._onData(f.slice(10));
  const got = events.filter((e) => e[0] === 'power-schedule');
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0][1].shutdown.time, '17:00');
});

test('a corrupted power schedule frame is dropped and the next valid frames still arrive', () => {
  const { link, events } = scanner();
  const bad = Buffer.from(frame());
  bad[12] ^= 0xff;
  link._onData(Buffer.concat([bad, protocol.encodePing(), frame()]));
  const names = events.map((e) => e[0]);
  assert.ok(names.includes('sync-error'));
  assert.ok(names.includes('ping'));
  assert.strictEqual(names.filter((n) => n === 'power-schedule').length, 1);
});
