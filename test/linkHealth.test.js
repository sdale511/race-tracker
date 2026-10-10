// Tests for the link health tracker (linkHealth.js) in virtual time. Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const { LinkHealth, LinkHealthAlerter } = require('../src/linkHealth');

function clock() {
  const c = { t: 1_000_000, now: () => c.t, adv(ms) { c.t += ms; } };
  return c;
}
const fix = (ts, over = {}) => ({ timestamp: ts, speedKnots: 5, gnssFixOk: true, carrSoln: 2, ...over });

// a boat reporting once a second for `seconds`, optionally with a given carrier solution
function feed(h, c, id, seconds, over = {}) {
  for (let i = 0; i < seconds; i++) {
    h.recordFix(id, fix(c.t, over));
    c.adv(1000);
  }
}

test('a healthy boat: RTK fixed, no gaps - ok', () => {
  const c = clock(); const h = new LinkHealth({ now: c.now });
  feed(h, c, 'BOAT1', 30);
  const b = h.boatStatus('BOAT1');
  assert.strictEqual(b.level, 'ok');
  assert.strictEqual(b.rtkPct, 100);
  assert.strictEqual(b.gaps, 0);
  assert.strictEqual(b.fixesPerSec, 1);
});

test('RTK share: float for part of the minute is warn, mostly float is bad', () => {
  const c = clock(); const h = new LinkHealth({ now: c.now });
  feed(h, c, 'BOAT1', 40);
  feed(h, c, 'BOAT1', 10, { carrSoln: 1 }); // 40 fixed + 10 float = 80% fixed
  let b = h.boatStatus('BOAT1');
  assert.strictEqual(b.rtkPct, 80);
  assert.strictEqual(b.level, 'warn');
  feed(h, c, 'BOAT1', 40, { carrSoln: 1 });
  b = h.boatStatus('BOAT1');
  assert.ok(b.rtkPct < 50);
  assert.strictEqual(b.level, 'bad');
  assert.ok(b.why[0].includes('RTK'));
});

test('gaps: a moving boat that skips seconds is counted; parked or slow boats and huge gaps are not', () => {
  const c = clock(); const h = new LinkHealth({ now: c.now });
  feed(h, c, 'BOAT1', 10);
  c.adv(4000); // 5 s of nothing in total, then a fix
  h.recordFix('BOAT1', fix(c.t)); c.adv(1000);
  assert.strictEqual(h.boatStatus('BOAT1').gaps, 1);
  assert.strictEqual(h.boatStatus('BOAT1').level, 'warn');
  // slow boat: not a gap
  feed(h, c, 'SLOW1', 3, { speedKnots: 0.5 }); c.adv(5000); h.recordFix('SLOW1', fix(c.t, { speedKnots: 0.5 }));
  assert.strictEqual(h.boatStatus('SLOW1').gaps, 0);
  // parked boat reporting every 15 s: not a gap
  h.recordFix('PARK1', fix(c.t), { parked: true }); c.adv(15000); h.recordFix('PARK1', fix(c.t), { parked: true });
  assert.strictEqual(h.boatStatus('PARK1').gaps, 0);
  // a gap of several minutes is out of range or asleep, not a lost frame
  h.recordFix('AWAY1', fix(c.t)); c.adv(100000); h.recordFix('AWAY1', fix(c.t));
  assert.strictEqual(h.boatStatus('AWAY1').gaps, 0);
  // three gaps in the minute is bad
  for (let i = 0; i < 3; i++) { c.adv(3000); h.recordFix('BOAT2', fix(c.t)); }
  h.recordFix('BOAT2', fix(c.t + 0)); // keep it alive
  assert.strictEqual(h.boatStatus('BOAT2').gaps, 2);
  c.adv(3000); h.recordFix('BOAT2', fix(c.t));
  assert.strictEqual(h.boatStatus('BOAT2').level, 'bad');
});

test('silence: a moving boat that goes quiet turns warn then bad; an idle one is quiet, not bad', () => {
  const c = clock(); const h = new LinkHealth({ now: c.now });
  feed(h, c, 'BOAT1', 10);
  c.adv(6000);
  assert.strictEqual(h.boatStatus('BOAT1').level, 'warn');
  c.adv(5000);
  assert.strictEqual(h.boatStatus('BOAT1').level, 'bad');
  feed(h, c, 'IDLE1', 3, { speedKnots: 0 });
  c.adv(60000);
  assert.strictEqual(h.boatStatus('IDLE1').level, 'quiet');
  c.adv(200000);
  assert.strictEqual(h.boatStatus('IDLE1'), null, 'forgotten after a couple of minutes');
});

test('fleet: sync error share needs enough frames to count, then warns and goes bad', () => {
  const c = clock(); const h = new LinkHealth({ now: c.now });
  for (let i = 0; i < 10; i++) h.recordFrame();
  h.recordSyncError();
  assert.strictEqual(h.status().syncPct, null, 'too few frames to judge');
  for (let i = 0; i < 40; i++) h.recordFrame();
  assert.strictEqual(h.status().syncLevel, 'warn'); // 1 of 51 is 2%
});

test('fleet sync levels', () => {
  const c = clock(); const h = new LinkHealth({ now: c.now });
  for (let i = 0; i < 97; i++) h.recordFrame();
  for (let i = 0; i < 3; i++) h.recordSyncError(); // 3%
  assert.strictEqual(h.status().syncLevel, 'bad');
  const h2 = new LinkHealth({ now: c.now });
  for (let i = 0; i < 98; i++) h2.recordFrame();
  for (let i = 0; i < 2; i++) h2.recordSyncError(); // 2%
  assert.strictEqual(h2.status().syncLevel, 'warn');
  const h3 = new LinkHealth({ now: c.now });
  for (let i = 0; i < 200; i++) h3.recordFrame();
  h3.recordSyncError();
  assert.strictEqual(h3.status().syncLevel, 'ok');
  assert.strictEqual(h3.status().level, 'ok');
});

test('alerter: one warning when a boat turns bad, one when it recovers, no repeats', () => {
  const c = clock(); const h = new LinkHealth({ now: c.now }); const a = new LinkHealthAlerter(h);
  feed(h, c, 'BOAT1', 20);
  assert.deepStrictEqual(a.check(), []);
  feed(h, c, 'BOAT1', 60, { carrSoln: 1 }); // all float
  const first = a.check();
  assert.strictEqual(first.length, 1);
  assert.ok(first[0].includes('BOAT1') && first[0].includes('RTK'));
  assert.deepStrictEqual(a.check(), [], 'not repeated while it stays bad');
  feed(h, c, 'BOAT1', 60);
  assert.deepStrictEqual(a.check(), ['[health] boat BOAT1 recovered']);
});
