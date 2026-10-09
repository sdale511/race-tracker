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
