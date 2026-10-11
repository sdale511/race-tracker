const test = require('node:test');
const assert = require('node:assert');
const { thinForTurns } = require('../src/thinFixes');

// A boat at ~29 m/s (57 kn) heading north at 8 Hz, optionally turning 90 degrees to the east at fix `turnAt`.
function track(n, turnAt = -1) {
  const out = [];
  let lat = 40, lon = -74, t = 1_000_000;
  let east = false;
  for (let i = 0; i < n; i++) {
    if (i === turnAt) east = true;
    if (east) lon += (3.6 / 111320) / Math.cos((40 * Math.PI) / 180);
    else lat += 3.6 / 111320;
    out.push({ timestamp: t, lat, lon });
    t += 125;
  }
  return out;
}

test('returns the list unchanged when it fits', () => {
  const l = track(8);
  assert.strictEqual(thinForTurns(l, 8), l);
});

test('keeps exactly cap fixes, in order, newest included', () => {
  const l = track(16, 8);
  const r = thinForTurns(l, 8);
  assert.strictEqual(r.length, 8);
  assert.strictEqual(r[r.length - 1], l[15]);
  for (let i = 1; i < r.length; i++) assert.ok(r[i].timestamp > r[i - 1].timestamp);
});

test('keeps the corner of a turn, where even thinning would cut it', () => {
  const l = track(16, 7); // the last fix heading north is l[6]: the corner; even thinning keeps only odd indices
  const r = thinForTurns(l, 8);
  assert.ok(r.includes(l[6]), 'the corner fix is kept');
  const cut = (arr) => {
    // how far the corner is from the polyline through the kept fixes, in metres
    const a = arr.filter((f) => f.timestamp < l[6].timestamp).pop();
    const b = arr.find((f) => f.timestamp > l[6].timestamp);
    const m = (f) => [f.lon * 111320 * Math.cos((40 * Math.PI) / 180), f.lat * 111320];
    const [ax, ay] = m(a), [bx, by] = m(b), [px, py] = m(l[6]);
    return Math.abs((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / Math.hypot(bx - ax, by - ay);
  };
  const evenly = [1, 3, 5, 7, 9, 11, 13, 15].map((i) => l[i]);
  assert.ok(!evenly.includes(l[6]));
  assert.ok(cut(evenly) > 1, 'even thinning cuts the corner by over a metre');
});

test('never leaves a gap over 480 ms on a straight run', () => {
  const r = thinForTurns(track(16), 8);
  for (let i = 1; i < r.length; i++) assert.ok(r[i].timestamp - r[i - 1].timestamp <= 480);
});

test('an anchor lets the first fix of the list be dropped', () => {
  const l = track(16);
  const r = thinForTurns(l.slice(1), 8, { anchor: l[0] });
  assert.strictEqual(r.length, 8);
});

test('protected fixes are thinned last', () => {
  const l = track(16);
  const prot = new Set([l[1], l[2], l[3], l[4]]);
  const r = thinForTurns(l, 8, { protect: (f) => prot.has(f) });
  for (const f of prot) assert.ok(r.includes(f));
  assert.strictEqual(r.length, 8);
  // with a cap smaller than the protected set they still go, rather than the cap being broken
  assert.strictEqual(thinForTurns(l, 3, { protect: (f) => prot.has(f) }).length, 3);
});

test('thinBackfill keeps one fix per 500 ms at most and the corner of a turn', () => {
  const { thinBackfill } = require('../src/thinFixes');
  const l = track(40, 20); // 5 s at 8 Hz, a corner at fix 19
  const r = thinBackfill(l);
  assert.ok(r.length <= 13 && r.length >= 9);
  assert.ok(r.includes(l[19]));
  for (let i = 1; i < r.length; i++) assert.ok(r[i].timestamp - r[i - 1].timestamp <= 500);
  assert.strictEqual(thinBackfill(l.slice(0, 2)).length, 2);
});
