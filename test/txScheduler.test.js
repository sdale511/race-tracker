// Tests for the shared-radio transmit scheduling (burstTracker.js, txGate.js, txScheduler.js) in virtual time.
// Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const { BurstTracker } = require('../src/burstTracker');
const { TxGate } = require('../src/txGate');
const { TxScheduler } = require('../src/txScheduler');

// a virtual clock with timers
class Sim {
  constructor() { this.t = 0; this.q = []; this.id = 0; }
  now = () => this.t;
  setTimer = (fn, ms) => { const e = { id: ++this.id, at: this.t + ms, fn }; this.q.push(e); return e; };
  clearTimer = (e) => { this.q = this.q.filter((x) => x !== e); };
  runUntil(T) {
    for (;;) {
      this.q.sort((a, b) => a.at - b.at || a.id - b.id);
      const e = this.q[0];
      if (!e || e.at > T) break;
      this.q.shift(); this.t = e.at; e.fn();
    }
    this.t = T;
  }
}
const TYPES = [1005, 1074, 1084, 1094, 1124, 1230];
// feed a tracker bursts starting at 130 + n*period (messages 6 ms apart)
function feed(tr, n, period = 1000) {
  for (let k = 0; k < n; k++) TYPES.forEach((ty, i) => tr.onRtcm(ty, 130 + k * period + i * 6));
}
function setup(nBursts = 8) {
  const sim = new Sim();
  const tr = new BurstTracker({ now: sim.now });
  feed(tr, nBursts);
  sim.t = 130 + (nBursts - 1) * 1000 + 100; // just after the last burst
  return { sim, tr, gate: new TxGate({ tracker: tr, now: sim.now }) };
}

test('tracker learns the period and predicts the next burst', () => {
  const { sim, tr } = setup();
  assert.ok(Math.abs(tr.period - 1000) < 2);
  assert.ok(tr.isActive(sim.t));
  assert.ok(Math.abs(tr.nextStart(sim.t + 500) - (130 + 8 * 1000)) < 3);
});

test('tracker goes inactive once bursts stop', () => {
  const { sim, tr } = setup();
  assert.ok(!tr.isActive(sim.t + 20000));
});

test('tracker back-dates the start when the first messages of a burst were lost', () => {
  const { tr } = setup();
  const s = 130 + 8 * 1000;
  TYPES.slice(2).forEach((ty, i) => tr.onRtcm(ty, s + (i + 2) * 6)); // 1005 and 1074 lost
  assert.ok(Math.abs(tr.lastStart - s) <= 2, `lastStart ${tr.lastStart} vs ${s}`);
  assert.strictEqual(tr.anchorCorrections, 1);
});

test('gate: clear mid-cycle, blocked around a burst, wider for bigger frames', () => {
  const { gate } = setup(); // bursts start at 130 + n*1000
  const w = (t, b = 26) => Math.round(gate.waitMs(b, t));
  assert.strictEqual(w(6500), 0);
  assert.strictEqual(w(5135), 25); // 5 ms after a burst start: wait until +30
  assert.ok(w(6130 - 40) > 0); // 40 ms before the next burst
  assert.strictEqual(w(6130 - 70), 0);
  assert.ok(w(6130 - 52, 84) > 0 && w(6130 - 52, 26) === 0); // a bigger frame is blocked earlier
});

test('gate never holds anything when no bursts are heard', () => {
  const sim = new Sim();
  const tr = new BurstTracker({ now: sim.now });
  const gate = new TxGate({ tracker: tr, now: sim.now });
  assert.strictEqual(gate.waitMs(84, 12345), 0);
});

test('scheduler: a clear frame goes at once; one in the burst window is held, in order, until it is over', () => {
  const { sim, tr, gate } = setup(); // t just after the burst at 7130
  const sent = [];
  const sch = new TxScheduler({ send: (b) => { sent.push({ t: sim.t, tag: b[1] }); return true; }, tracker: tr, gate, now: sim.now, setTimer: sim.setTimer, clearTimer: sim.clearTimer });
  const mk = (tag) => Buffer.from([0xcc, tag, 0, 0, 0, 0]);
  sim.runUntil(7500); sch.submit(mk(1)); sim.runUntil(7501);
  assert.deepStrictEqual(sent.map((x) => [x.tag, x.t]), [[1, 7500]]);
  sim.runUntil(8135); sch.submit(mk(2)); sch.submit(mk(3)); // 5 ms after the burst at 8130
  sim.runUntil(8300);
  const two = sent.find((x) => x.tag === 2), three = sent.find((x) => x.tag === 3);
  assert.ok(two.t >= 8160 && two.t < 8170, `frame 2 at ${two.t}`);
  assert.ok(three.t >= two.t);
});

test('scheduler: with the bursts gone, frames pass straight through', () => {
  const { sim, tr, gate } = setup();
  const sent = [];
  const sch = new TxScheduler({ send: (b) => { sent.push(b); return true; }, tracker: tr, gate, now: sim.now, setTimer: sim.setTimer, clearTimer: sim.clearTimer });
  sim.runUntil(30000);
  sch.submit(Buffer.from([0xcc, 9, 0, 0, 0, 0]));
  assert.strictEqual(sent.length, 1);
});

test('slots: two boats keep to their own slots and never transmit in a burst window or on top of each other', () => {
  const sim = new Sim();
  const log = [];
  const boats = [3, 7].map((idx, b) => {
    const tr = new BurstTracker({ now: sim.now });
    // keep feeding bursts as time passes
    for (let k = 0; k < 40; k++) sim.setTimer(() => TYPES.forEach((ty, i) => tr.onRtcm(ty, sim.t + i * 0)), 130 + k * 1000);
    const gate = new TxGate({ tracker: tr, now: sim.now });
    return new TxScheduler({
      send: () => { log.push({ b, idx, t: sim.t }); return true; },
      tracker: tr, gate, slot: { enabled: true, index: idx, count: 30, widthMs: 30 },
      now: sim.now, setTimer: sim.setTimer, clearTimer: sim.clearTimer,
    });
  });
  sim.runUntil(5000);
  for (let t = 5000; t < 30000; t += 400) boats.forEach((s, b) => sim.setTimer(() => s.submit(Buffer.concat([Buffer.from([0xee]), Buffer.alloc(83)])), t - sim.t + b * 50));
  sim.runUntil(32000);
  const phase = (t) => (t - 130) % 1000;
  assert.ok(log.length > 20);
  for (const x of log) {
    assert.ok(phase(x.t) >= 30, `sent in the burst's wake at phase ${phase(x.t)}`);
    assert.ok(phase(x.t) <= 1000 - 62, `sent too close to the next burst at phase ${phase(x.t)}`);
    const start = 30 + x.idx * 30;
    assert.ok(phase(x.t) >= start - 1 && phase(x.t) < start + 30, `boat slot ${x.idx} sent at phase ${phase(x.t)}, slot opens at ${start}`);
  }
  assert.ok(!log.filter((a) => a.b === 0).some((a) => log.some((c) => c.b === 1 && Math.abs(c.t - a.t) < 30)));
});

test('slot flush: fires just after the boat\'s slot opens each cycle, and once when the bursts stop', () => {
  const sim = new Sim();
  const tr = new BurstTracker({ now: sim.now });
  for (let k = 0; k < 6; k++) sim.setTimer(() => TYPES.forEach((ty) => tr.onRtcm(ty, sim.t)), 130 + k * 1000);
  sim.runUntil(5500); // bursts at 130, 1130, ... 5130; none after
  const fired = [];
  const s = new TxScheduler({
    send: () => true, tracker: tr, gate: new TxGate({ tracker: tr, now: sim.now }),
    slot: { enabled: true, index: 3, count: 22, widthMs: 40 },
    now: sim.now, setTimer: sim.setTimer, clearTimer: sim.clearTimer,
  });
  s.startSlotFlush(() => fired.push(sim.t));
  sim.runUntil(8000);
  // slot 3 opens 20 + 10 + 3*40 = 150 ms after a burst; the first fire is the 5130 burst's slot at 5280 or the next cycle's
  assert.ok(fired.length >= 1);
  for (const t of fired.slice(0, -1)) assert.ok(Math.abs(((t - 130) % 1000) - 151) <= 2, `fired at phase ${(t - 130) % 1000}`);
  assert.ok(fired.length <= 4, 'stops firing every cycle once the bursts are no longer heard');
});

test('slots: a frame submitted late in the boat\'s slot waits for the next cycle instead of running into the next slot', () => {
  const sim = new Sim();
  const tr = new BurstTracker({ now: sim.now });
  for (let k = 0; k < 12; k++) sim.setTimer(() => TYPES.forEach((ty) => tr.onRtcm(ty, sim.t)), 130 + k * 1000);
  const sent = [];
  const s = new TxScheduler({
    send: () => { sent.push(sim.t); return true; },
    tracker: tr, gate: new TxGate({ tracker: tr, now: sim.now }),
    slot: { enabled: true, index: 2, count: 22, widthMs: 35 },
    now: sim.now, setTimer: sim.setTimer, clearTimer: sim.clearTimer,
  });
  const frame = Buffer.concat([Buffer.from([0xee]), Buffer.alloc(83)]);
  sim.runUntil(6000);
  // slot 2 opens 130 + 20 + 10 + 70 = 230 ms after a burst start (ms) and closes 35 ms later
  const open = 6130 + 100;
  sim.setTimer(() => s.submit(frame), open + 2 - sim.t); // just after opening: goes at once
  sim.setTimer(() => s.submit(frame), open + 30 - sim.t); // 5 ms before it closes: too late
  sim.runUntil(open + 40);
  assert.strictEqual(sent.length, 1, 'only the early frame went in this cycle');
  sim.runUntil(open + 1200);
  assert.strictEqual(sent.length, 2);
  assert.ok(sent[1] >= open + 1000 - 2 && sent[1] <= open + 1000 + 5, `late frame went at ${sent[1] - open} ms after this cycle's slot opening`);
});

test('join slots: a boat without a slot of its own only ever sends in the shared slots, and varies which', () => {
  const sim = new Sim();
  const tr = new BurstTracker({ now: sim.now });
  for (let k = 0; k < 60; k++) sim.setTimer(() => TYPES.forEach((ty) => tr.onRtcm(ty, sim.t)), 130 + k * 1000);
  const sent = [];
  const s = new TxScheduler({
    send: () => { sent.push(sim.t); return true; },
    tracker: tr, gate: new TxGate({ tracker: tr, now: sim.now }),
    slot: { enabled: true, index: 25, count: 26, widthMs: 35, join: { first: 24, n: 2 } },
    now: sim.now, setTimer: sim.setTimer, clearTimer: sim.clearTimer,
  });
  sim.runUntil(5500);
  const frame = Buffer.concat([Buffer.from([0xee]), Buffer.alloc(83)]);
  for (let t = 6000; t < 50000; t += 1000) sim.setTimer(() => s.submit(frame), t - sim.t + 300);
  sim.runUntil(52000);
  assert.ok(sent.length >= 30);
  const phases = new Set();
  for (const t of sent) {
    const ph = Math.round((t - 130) % 1000);
    // join slots 24 and 25 open 30 + 24*35 = 870 and 905 ms after the burst; a frame goes within the first ~14 ms
    assert.ok((ph >= 868 && ph <= 886) || (ph >= 903 && ph <= 921), `sent at phase ${ph}, outside the join slots`);
    phases.add(ph >= 900 ? 25 : 24);
  }
  assert.strictEqual(phases.size, 2, 'both join slots get used over time');
});

test('base slot: the base\'s own frames (slot table etc.) go out in the slot after the boats\' slots, nowhere else', () => {
  const sim = new Sim();
  const tr = new BurstTracker({ now: sim.now });
  for (let k = 0; k < 40; k++) sim.setTimer(() => TYPES.forEach((ty) => tr.onRtcm(ty, sim.t)), 130 + k * 1000);
  const sent = [];
  const s = new TxScheduler({
    send: (b) => { sent.push({ t: sim.t, sync: b[0] }); return true; },
    tracker: tr, gate: new TxGate({ tracker: tr, now: sim.now }),
    slot: { enabled: true, index: 25, count: 26, widthMs: 35, join: null },
    slottedSyncs: new Set([0xa7]),
    trafficLabel: "the base's",
    now: sim.now, setTimer: sim.setTimer, clearTimer: sim.clearTimer,
  });
  sim.runUntil(5500);
  const table = Buffer.concat([Buffer.from([0xa7]), Buffer.alloc(96)]);
  const other = Buffer.from([0x55, 1, 2, 3]); // not one of the base's slotted frame types
  for (let t = 6000; t < 30000; t += 1700) sim.setTimer(() => { s.submit(table); s.submit(table); s.submit(other); }, t - sim.t + 123);
  sim.runUntil(34000);
  const tables = sent.filter((x) => x.sync === 0xa7);
  assert.ok(tables.length >= 20);
  // the base's slot (index 25) opens 30 + 25*35 = 905 ms after the burst; a frame goes in its first ~12 ms
  for (const x of tables) {
    const ph = Math.round((x.t - 130) % 1000);
    assert.ok(ph >= 903 && ph <= 920, `a table frame went out at phase ${ph}, outside the base's slot`);
  }
  assert.ok(sent.some((x) => x.sync === 0x55), 'other frames are not held for the slot');
});
