// Tests for the base's slot table (protocol frame, slotTable.js). Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const protocol = require('../src/protocol');
const { SlotAllocator, SlotTableFollower } = require('../src/slotTable');
const { BurstTracker } = require('../src/burstTracker');
const { TxGate } = require('../src/txGate');
const { TxScheduler } = require('../src/txScheduler');

const ids = (n) => Array.from({ length: n }, (_, i) => `B${String(i + 1).padStart(4, '0')}`);

test('slot table frame round-trips and rejects a bad checksum or slot', () => {
  const entries = [{ boatId: 'LAT01', slot: 0 }, { boatId: 'LAT02', slot: 21 }];
  const buf = protocol.encodeSlotTable({ version: 9, slotCount: 22, slotWidthMs: 40, entries });
  assert.strictEqual(buf.length, protocol.slotTableFrameLen(2));
  assert.deepStrictEqual(protocol.decodeSlotTable(buf), { version: 9, slotCount: 22, slotWidthMs: 40, entries });
  const bad = Buffer.from(buf);
  bad[6] ^= 0xff;
  assert.strictEqual(protocol.decodeSlotTable(bad), null);
  assert.throws(() => protocol.encodeSlotTable({ slotCount: 22, slotWidthMs: 40, entries: [{ boatId: 'LAT01', slot: 22 }] }));
  assert.ok(protocol.slotTableFrameLen(protocol.MAX_SLOT_ENTRIES) <= protocol.RADIO_MAX_PAYLOAD);
});

test('allocator: new boats are spread out, assignments are sticky, a slot is freed only after the stale time', () => {
  let now = 0;
  const a = new SlotAllocator({ activeFrames: 1, count: 4, widthMs: 40, staleMs: 60000, now: () => now });
  assert.strictEqual(a.noteHeard('AAAAA'), 0);
  assert.strictEqual(a.noteHeard('BBBBB'), 2, 'the second boat goes halfway');
  assert.strictEqual(a.noteHeard('CCCCC'), 1);
  assert.strictEqual(a.noteHeard('BBBBB'), 2, 'a boat keeps its slot');
  assert.ok(a.takeChanged());
  assert.ok(!a.takeChanged());
  now = 30000;
  a.noteHeard('AAAAA');
  a.noteHeard('CCCCC');
  now = 70000; // BBBBB silent 70 s, the others 40 s
  assert.deepStrictEqual(a.sweep(), ['BBBBB']);
  assert.strictEqual(a.noteHeard('DDDDD'), 3, 'a newcomer gets a slot nobody has just given up; nobody else moved');
  assert.strictEqual(a.noteHeard('AAAAA'), 0);
  assert.strictEqual(a.noteHeard('CCCCC'), 1);
});

test('allocator: boats stay as far apart as the slot count allows, for any fleet size', () => {
  for (const [count, boats] of [[22, 2], [22, 3], [22, 5], [22, 11], [22, 22], [47, 10]]) {
    const a = new SlotAllocator({ activeFrames: 1, count, widthMs: 40 });
    const slots = ids(boats).map((id) => a.noteHeard(id)).sort((x, y) => x - y);
    assert.strictEqual(new Set(slots).size, boats, 'every boat has its own slot');
    const minGap = Math.min(...slots.slice(1).map((s, i) => s - slots[i]));
    if (boats > 1) assert.ok(minGap >= Math.floor((count - 1) / (boats - 1) / 2), `${boats} boats in ${count} slots: closest pair only ${minGap} apart (${slots})`);
    if (boats <= count / 2) assert.ok(minGap >= 2, `${boats} boats in ${count} slots must never be side by side (${slots})`);
  }
});

test('allocator: more boats than slots - the extras get none and nobody is moved', () => {
  const a = new SlotAllocator({ activeFrames: 1, count: 3, widthMs: 40 });
  const got = ids(5).map((id) => a.noteHeard(id));
  assert.deepStrictEqual(got, [0, 2, 1, null, null]);
  assert.deepStrictEqual(a.status().overflow, [ids(5)[3], ids(5)[4]]);
});

test('allocator: a big table is split over frames of at most MAX_SLOT_ENTRIES, together covering every boat', () => {
  const a = new SlotAllocator({ activeFrames: 1, count: 40, widthMs: 25 });
  ids(37).forEach((id) => a.noteHeard(id));
  const frames = a.frames();
  assert.strictEqual(frames.length, 3);
  const seen = new Map();
  for (const f of frames) {
    assert.ok(f.length <= protocol.RADIO_MAX_PAYLOAD);
    const t = protocol.decodeSlotTable(f);
    assert.strictEqual(t.slotCount, 40);
    t.entries.forEach((e) => seen.set(e.boatId, e.slot));
  }
  assert.strictEqual(seen.size, 37);
  assert.strictEqual(new Set(seen.values()).size, 37, 'every boat has a different slot');
});

function boatScheduler(sim, tracker, slot) {
  return new TxScheduler({
    send: () => true,
    tracker,
    gate: new TxGate({ tracker, now: () => sim.t }),
    slot,
    now: () => sim.t,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
}

test('follower: adopts its entry, ignores other boats\' entries, and adopts the base\'s count and width', () => {
  const sim = { t: 0 };
  const sched = boatScheduler(sim, new BurstTracker({ now: () => sim.t }), { enabled: true, index: 11, count: 30, widthMs: 30 });
  const logs = [];
  const f = new SlotTableFollower({ boatId: 'LAT02', scheduler: sched, log: (m) => logs.push(m) });
  assert.strictEqual(f.onTable({ version: 1, slotCount: 22, slotWidthMs: 40, entries: [{ boatId: 'LAT01', slot: 0 }] }), false);
  assert.strictEqual(sched.slot.index, 11);
  assert.strictEqual(f.onTable({ version: 1, slotCount: 22, slotWidthMs: 40, entries: [{ boatId: 'LAT02', slot: 5 }] }), true);
  assert.deepStrictEqual([sched.slot.index, sched.slot.count, sched.slot.widthMs], [5, 22, 40]);
  assert.strictEqual(f.onTable({ version: 1, slotCount: 22, slotWidthMs: 40, entries: [{ boatId: 'LAT02', slot: 5 }] }), false, 'a repeat changes nothing');
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(f.onTable({ version: 2, slotCount: 22, slotWidthMs: 40, entries: [{ boatId: 'LAT02', slot: 6 }] }), true, 'a reassignment is followed');
  assert.strictEqual(sched.slot.index, 6);
});

test('follower: a boat pinned with TX_SLOT ignores the table', () => {
  const sim = { t: 0 };
  const sched = boatScheduler(sim, new BurstTracker({ now: () => sim.t }), { enabled: true, index: 11, count: 30, widthMs: 30 });
  const f = new SlotTableFollower({ boatId: 'LAT02', scheduler: sched, pinned: true });
  assert.strictEqual(f.onTable({ version: 1, slotCount: 22, slotWidthMs: 40, entries: [{ boatId: 'LAT02', slot: 5 }] }), false);
  assert.strictEqual(sched.slot.index, 11);
});

const { slotCountForPeriod } = require('../src/slotTable');

test('slot count follows the correction interval: 1 s -> 22 slots of 40 ms, 2 s -> 47', () => {
  const gate = new TxGate({ tracker: new BurstTracker() });
  assert.strictEqual(slotCountForPeriod(1001, 40, gate), 22);
  assert.strictEqual(slotCountForPeriod(2002, 40, gate), 47);
  assert.strictEqual(slotCountForPeriod(1001, 30, gate), 30);
  assert.strictEqual(slotCountForPeriod(50, 40, gate), 1, 'never below one slot');
});

test('slot order: 0 first, then halfway; the first half of the slots are every other slot', () => {
  const taken = new Set();
  const first = [];
  for (let i = 0; i < 11; i++) {
    const s = require('../src/slotTable').pickSlot(taken, 22);
    taken.add(s);
    first.push(s);
  }
  assert.deepStrictEqual(first.slice(0, 3), [0, 16, 8]);
  assert.deepStrictEqual([...first].sort((x, y) => x - y), [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
});

test('config: the slot settings are all real numbers', () => {
  const { txGate } = require('../src/config');
  for (const k of ['count', 'widthMs', 'rtcmIntervalS', 'tableIntervalS', 'staleS', 'maxHz']) {
    assert.ok(Number.isFinite(txGate.slot[k]), `txGate.slot.${k} is ${txGate.slot[k]}`);
  }
});

test('allocator: only boats that are actively reporting get a slot', () => {
  let now = 0;
  const a = new SlotAllocator({ count: 4, widthMs: 35, staleMs: 120000, activeFrames: 2, activeWindowMs: 20000, now: () => now });
  // an idle fleet: one heartbeat fix a minute each, for ten minutes - never earns a slot
  for (let min = 0; min < 10; min++) {
    now = min * 60000;
    ids(8).forEach((id) => assert.strictEqual(a.noteHeard(id), null));
    a.sweep();
  }
  assert.strictEqual(a.status().boats.length, 0);
  assert.deepStrictEqual(a.status().overflow, [], 'idle boats are not counted as waiting for a slot either');
  // a boat that starts racing (a fix a second) gets one on its second fix
  now = 700000;
  assert.strictEqual(a.noteHeard('RACER'), null);
  now = 701000;
  assert.strictEqual(a.noteHeard('RACER'), 0);
  // a batch of four fixes arriving together counts as active straight away
  now = 702000;
  const got = [1, 2, 3, 4].map(() => a.noteHeard('BATCH'));
  assert.strictEqual(got[1], 2, 'second fix of the batch earns the slot');
});

test('allocator: a racing boat that stops loses its slot after the stale time; idle boats are not in the queue', () => {
  let now = 0;
  const a = new SlotAllocator({ count: 1, widthMs: 35, staleMs: 120000, activeFrames: 2, activeWindowMs: 20000, now: () => now });
  a.noteHeard('AAAAA'); now = 1000; a.noteHeard('AAAAA'); // AAAAA has the only slot
  now = 2000; a.noteHeard('BBBBB'); now = 3000;
  assert.strictEqual(a.noteHeard('BBBBB'), null, 'BBBBB is active but there is no slot left');
  assert.deepStrictEqual(a.status().overflow, ['BBBBB']);
  now = 60000; a.noteHeard('AAAAA'); a.sweep();
  assert.deepStrictEqual(a.status().overflow, [], 'BBBBB went quiet, so it is no longer waiting');
  now = 190000; // AAAAA silent 130 s
  assert.deepStrictEqual(a.sweep(), ['AAAAA']);
  a.noteHeard('BBBBB'); now = 191000;
  assert.strictEqual(a.noteHeard('BBBBB'), 0, 'the freed slot goes to the next active boat');
});

test('allocator: a heartbeat fix once a minute does not keep a slot alive', () => {
  let now = 0;
  const a = new SlotAllocator({ count: 4, widthMs: 35, staleMs: 120000, activeFrames: 2, activeWindowMs: 20000, now: () => now });
  for (let i = 0; i < 10; i++) { now = i * 1000; a.noteHeard('BOAT1'); } // racing for 10 s: has a slot
  assert.strictEqual(a.status().boats.length, 1);
  // then it sits still, sending one heartbeat fix a minute
  for (let min = 1; min <= 5; min++) { now = 10000 + min * 60000; a.noteHeard('BOAT1'); a.sweep(); }
  assert.strictEqual(a.status().boats.length, 0, 'the slot was freed even though heartbeats kept arriving');
  // it starts racing again and gets a slot again
  now += 1000; a.noteHeard('BOAT1'); now += 1000;
  assert.notStrictEqual(a.noteHeard('BOAT1'), null);
});

test('allocator: a boat that gave its slot up gets the same one back if it is free; others get it last', () => {
  let now = 0;
  const a = new SlotAllocator({ count: 4, widthMs: 35, staleMs: 120000, activeFrames: 1, holdMs: 1800000, now: () => now });
  const first = ['AAAAA', 'BBBBB', 'CCCCC'].map((id) => a.noteHeard(id)); // 0, 2, 1
  assert.deepStrictEqual(first, [0, 2, 1]);
  now = 300000; a.noteHeard('AAAAA'); a.noteHeard('CCCCC'); // BBBBB (slot 2) goes quiet
  now = 500000; a.noteHeard('AAAAA'); a.noteHeard('CCCCC');
  assert.deepStrictEqual(a.sweep(), ['BBBBB']);
  // a newcomer arrives while slot 2 is free: it gets slot 3, not the one BBBBB just gave up
  assert.strictEqual(a.noteHeard('DDDDD'), 3);
  // BBBBB comes back and gets slot 2 again
  assert.strictEqual(a.noteHeard('BBBBB'), 2);
  // when nothing else is free, a recently released slot is handed out after all
  now = 900000; a.noteHeard('AAAAA'); a.noteHeard('CCCCC'); a.noteHeard('DDDDD');
  now = 1100000; a.noteHeard('AAAAA'); a.noteHeard('CCCCC'); a.noteHeard('DDDDD');
  assert.deepStrictEqual(a.sweep(), ['BBBBB']);
  assert.strictEqual(a.noteHeard('EEEEE'), 2, 'the only free slot, although BBBBB gave it up recently');
  // BBBBB's slot was taken meanwhile and nothing is free: it overflows rather than stealing it
  assert.strictEqual(a.noteHeard('BBBBB'), null);
});

test('allocator: the memory of a released slot expires after the hold time', () => {
  let now = 0;
  const a = new SlotAllocator({ count: 4, widthMs: 35, staleMs: 1000, activeFrames: 1, holdMs: 10000, now: () => now });
  assert.strictEqual(a.noteHeard('AAAAA'), 0);
  assert.strictEqual(a.noteHeard('BBBBB'), 2);
  now = 5000; a.noteHeard('BBBBB'); a.sweep(); // AAAAA freed at 5000
  now = 20000; a.noteHeard('BBBBB'); a.sweep(); // hold time over (BBBBB kept its slot)
  assert.strictEqual(a.noteHeard('CCCCC'), 0, 'slot 0 is no longer held back for AAAAA, so the spread order gives it out first');
});
