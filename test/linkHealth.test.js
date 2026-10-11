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

test('boats that report sparsely by design are not flagged for gaps or silence: waiting for a slot is a warn, not a problem', () => {
  const c = clock(); const h = new LinkHealth({ now: c.now });
  // racing without a slot: a report every ~15 s, moving at 5 kn
  for (let i = 0; i < 6; i++) { h.recordFix('WAIT1', fix(c.t), { sparse: 'waiting' }); c.adv(15000); }
  let b = h.boatStatus('WAIT1');
  assert.strictEqual(b.gaps, 0);
  assert.strictEqual(b.level, 'warn');
  assert.ok(b.why.join(' ').includes('without a slot'));
  c.adv(30000);
  assert.strictEqual(h.boatStatus('WAIT1').level, 'warn', 'silence between its sparse reports is not a link problem');
  // not racing (no slot entitlement): nothing to judge but RTK
  for (let i = 0; i < 6; i++) { h.recordFix('ROLL1', fix(c.t), { sparse: 'none' }); c.adv(15000); }
  b = h.boatStatus('ROLL1');
  assert.strictEqual(b.gaps, 0);
  assert.strictEqual(b.level, 'ok');
  // a boat with a slot that skips seconds still is
  for (let i = 0; i < 5; i++) { h.recordFix('SLOT1', fix(c.t)); c.adv(1000); }
  c.adv(4000); h.recordFix('SLOT1', fix(c.t));
  assert.strictEqual(h.boatStatus('SLOT1').gaps, 1);
});

test('a start-up blip is not a problem: one float fix among a few is fine once the boat is fixed again', () => {
  const c = clock(); const h = new LinkHealth({ now: c.now });
  h.recordFix('PARK1', fix(c.t, { carrSoln: 1 }), { parked: true }); c.adv(5000);
  for (let i = 0; i < 8; i++) { h.recordFix('PARK1', fix(c.t), { parked: true }); c.adv(5000); }
  const b = h.boatStatus('PARK1');
  assert.strictEqual(b.rtkPct, 89, '8 of 9 fixed');
  assert.strictEqual(b.fixedNow, true);
  assert.strictEqual(b.level, 'ok');
  // the same 89% with the latest fix not fixed is still worth a look
  for (let i = 0; i < 8; i++) { h.recordFix('PARK2', fix(c.t), { parked: true }); c.adv(5000); }
  h.recordFix('PARK2', fix(c.t, { carrSoln: 1 }), { parked: true });
  assert.strictEqual(h.boatStatus('PARK2').level, 'warn');
  // a boat that was mostly float this minute but is fixed now is a warning, not a problem
  for (let i = 0; i < 40; i++) { h.recordFix('FLIP1', fix(c.t, { carrSoln: 1 })); c.adv(1000); }
  for (let i = 0; i < 5; i++) { h.recordFix('FLIP1', fix(c.t)); c.adv(1000); }
  assert.strictEqual(h.boatStatus('FLIP1').level, 'warn');
});

test('alerter: many boats turning bad together is one line, not one per boat', () => {
  const c = clock(); const h = new LinkHealth({ now: c.now }); const a = new LinkHealthAlerter(h);
  for (let i = 0; i < 12; i++) h.recordFix('B000' + String(i).padStart(2, '0'), fix(c.t, { carrSoln: 0 }));
  for (let s = 0; s < 8; s++) { c.adv(1000); for (let i = 0; i < 12; i++) h.recordFix('B000' + String(i).padStart(2, '0'), fix(c.t, { carrSoln: 0 })); }
  const lines = a.check();
  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0].includes('12 boats turned bad together'));
});

test('gap limit follows the correction cycle: at 2 s a boat that sends once per cycle is not flagged for fixes 2.4 s apart', () => {
  const c = clock(); const h = new LinkHealth({ now: c.now });
  h.setCycleMs(2000);
  for (let i = 0; i < 10; i++) { h.recordFix('SLOT1', fix(c.t)); c.adv(2400); }
  assert.strictEqual(h.boatStatus('SLOT1').gaps, 0);
  assert.strictEqual(h.boatStatus('SLOT1').level, 'ok');
  c.adv(1600); h.recordFix('SLOT1', fix(c.t)); // 4 s: more than 1.5 cycles + 0.5 s
  assert.strictEqual(h.boatStatus('SLOT1').gaps, 1);
  // at a 1 s cycle the same 2.4 s gaps are flagged
  const h2 = new LinkHealth({ now: c.now });
  h2.setCycleMs(1000);
  for (let i = 0; i < 4; i++) { h2.recordFix('SLOT2', fix(c.t)); c.adv(2400); }
  assert.ok(h2.boatStatus('SLOT2').gaps >= 1);
});

test('alerter: a boat that goes bad and then just stops is not "recovered"; one that is heard ok again is', () => {
  const c = clock(); const h = new LinkHealth({ now: c.now }); const a = new LinkHealthAlerter(h);
  feed(h, c, 'STOP1', 10); feed(h, c, 'BACK1', 10);
  c.adv(11000); // both silent for 11 s while moving: bad
  assert.strictEqual(a.check().filter((l) => l.includes('WARNING')).length, 2);
  // BACK1 comes back and is judged ok again: recovered. STOP1 never does.
  feed(h, c, 'BACK1', 5);
  const first = a.check();
  assert.ok(first.some((l) => l.includes('BACK1 recovered')), first.join(' | '));
  assert.ok(!first.some((l) => l.includes('STOP1')), 'STOP1 is still on the card, still bad - nothing new to say');
  // later STOP1 has dropped off the card: it stopped reporting, it did not recover
  c.adv(150000);
  const later = a.check();
  assert.ok(later.some((l) => l.includes('STOP1 stopped reporting')), later.join(' | '));
  assert.ok(!later.some((l) => l.includes('STOP1 recovered')));
});

test('a boat that crosses the finish and goes quiet is not flagged as silent', () => {
  const c = clock(); const h = new LinkHealth({ now: c.now }); const a = new LinkHealthAlerter(h);
  feed(h, c, 'FIN01', 10);
  h.noteFinish('FIN01');
  c.adv(20000);
  assert.strictEqual(h.boatStatus('FIN01').level, 'quiet');
  assert.deepStrictEqual(a.check(), []);
  // without the finish it would have been bad
  feed(h, c, 'OTH01', 10); c.adv(20000);
  assert.strictEqual(h.boatStatus('OTH01').level, 'bad');
});
