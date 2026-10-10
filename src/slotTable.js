// Transmit-slot assignment for the shared radio (see txScheduler.js).
//
//   SlotAllocator      (base) hands each boat it hears a slot and builds the frames that tell
//                      every boat what they got.
//   SlotTableFollower  (boat) reads those frames and points its scheduler at the assigned slot.
//
// Assignment rules, chosen so a boat joining or leaving never moves anyone else:
//   - a boat gets the next free slot in a spread-out order (0, halfway, quarters, ... - see
//     slotOrder) the first time the base hears it, and keeps it;
//   - a boat only gets a slot once it is actively reporting (activeFrames fixes within
//     activeWindowMs), so idle boats - a moored fleet sending one heartbeat fix a minute - take none;
//   - a slot is freed only after the boat has stopped reporting actively for staleMs (a couple of
//     minutes - a boat briefly out of range finds its slot waiting; an idle one gives it up, and a
//     lone heartbeat fix does not count as reporting);
//   - with more boats than slots, the extras get no entry and keep using their own fallback slot
//     (hashed from the boat id) - the base logs it once. Slot size is fixed; it does not change
//     with the number of boats.

const protocol = require('./protocol');

const MAX_SLOTS = 250;

// How many slots of widthMs fit in one correction cycle: the cycle (burst to burst) minus the time
// blocked after a burst and, before the next one, what the biggest frame (a full batch) needs.
// `gate` is a TxGate (only its beforeMs/afterMs are used).
function slotCountForPeriod(periodMs, widthMs, gate) {
  const usable = periodMs - gate.afterMs() - gate.beforeMs(84);
  return Math.max(1, Math.min(MAX_SLOTS, Math.floor(usable / widthMs)));
}

// Slots in the order boats are given them: 0, then halfway, then the quarters, and so on (the
// slot numbers bit-reversed, skipping any past the count). The first boats land far apart, and the
// first half of the slots handed out are exactly every other slot - 0, 2, 4, ... for an even
// count - so a fleet of up to half the slot count never has two boats side by side. Neighbouring
// slots are the ones that can overlap (timing jitter, a second frame spilling past its slot).
const orderCache = new Map();
function slotOrder(count) {
  let order = orderCache.get(count);
  if (order) return order;
  let bits = 0;
  while (1 << bits < count) bits++;
  order = [];
  for (let i = 0; i < 1 << bits; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    if (r < count) order.push(r);
  }
  orderCache.set(count, order);
  return order;
}

// The first free slot in that order, or null when every slot is taken. Holes left by boats that
// have gone are reused the same way, so the spread is kept without moving anyone.
function pickSlot(taken, count) {
  for (const slot of slotOrder(count)) if (!taken.has(slot)) return slot;
  return null;
}

class SlotAllocator {
  constructor({ count, widthMs, staleMs = 2 * 60 * 1000, activeFrames = 2, activeWindowMs = 20 * 1000, now = () => Date.now(), log = () => {} }) {
    this.count = Math.max(1, Math.min(MAX_SLOTS, count));
    this.widthMs = Math.max(1, Math.min(255, widthMs));
    this.staleMs = staleMs;
    this.activeFrames = Math.max(1, activeFrames);
    this.activeWindowMs = activeWindowMs;
    this.recent = new Map(); // boatId -> times of recent fixes, for boats without a slot yet
    this.now = now;
    this.log = log;
    this.version = 0;
    this.byBoat = new Map(); // boatId -> { slot, lastHeard }
    this.overflow = new Set(); // boats heard while every slot was taken
    this.changed = false; // an assignment changed since the table was last taken
  }

  // Call for every position fix heard from a boat (a batch counts each of its fixes). A boat gets a
  // slot only once it is actively reporting - activeFrames fixes within activeWindowMs - so boats
  // sitting idle (a moored fleet sending one heartbeat fix a minute) never take one. Returns its
  // slot, or null when it has none (not active yet, or every slot is taken).
  noteHeard(boatId) {
    if (typeof boatId !== 'string' || boatId.length !== protocol.BOAT_ID_LEN) return null;
    const t = this.now();
    const times = (this.recent.get(boatId) || []).filter((x) => t - x <= this.activeWindowMs);
    times.push(t);
    this.recent.set(boatId, times);
    const existing = this.byBoat.get(boatId);
    if (existing) {
      // A slot is kept alive only by active reporting too: a lone heartbeat fix (one a minute from a
      // boat sitting still) must not hold a slot that the stale time would otherwise free.
      if (times.length >= this.activeFrames) existing.lastHeard = t;
      return existing.slot;
    }
    if (times.length < this.activeFrames) return null;
    const slot = pickSlot(new Set([...this.byBoat.values()].map((e) => e.slot)), this.count);
    if (slot === null) {
      if (!this.overflow.has(boatId)) {
        this.overflow.add(boatId);
        this.log(`[slots] no free slot for ${boatId}: all ${this.count} are taken - it keeps its own fallback slot`);
      }
      return null;
    }
    this.byBoat.set(boatId, { slot, lastHeard: t });
    this.overflow.delete(boatId);
    this._changed();
    this.log(`[slots] ${boatId} -> slot ${slot} of ${this.count} (${this.byBoat.size} boat${this.byBoat.size === 1 ? '' : 's'})`);
    return slot;
  }

  // Frees the slots of boats silent for longer than staleMs. Returns the freed boat ids.
  sweep() {
    const t = this.now();
    const freed = [];
    for (const [boatId, e] of this.byBoat) {
      if (t - e.lastHeard > this.staleMs) {
        this.byBoat.delete(boatId);
        freed.push(boatId);
        this.log(`[slots] ${boatId} silent for ${Math.round((t - e.lastHeard) / 60000)} min - slot ${e.slot} freed`);
      }
    }
    // boats that were waiting (or overflowed) and have gone quiet are no longer in the queue
    for (const [boatId, times] of this.recent) {
      if (t - times[times.length - 1] > this.activeWindowMs) {
        this.recent.delete(boatId);
        this.overflow.delete(boatId);
      }
    }
    for (const boatId of freed) this.recent.delete(boatId);
    if (freed.length) this._changed();
    return freed;
  }

  _changed() {
    this.version = (this.version + 1) & 0xff;
    this.changed = true;
  }

  // True once, after an assignment changes - the caller then broadcasts sooner than its normal
  // interval so a new boat doesn't wait for the next scheduled table.
  takeChanged() {
    const c = this.changed;
    this.changed = false;
    return c;
  }

  // The whole table as encoded frames, MAX_SLOT_ENTRIES boats per frame, ordered by slot.
  frames() {
    const entries = [...this.byBoat.entries()].map(([boatId, e]) => ({ boatId, slot: e.slot })).sort((a, b) => a.slot - b.slot);
    const out = [];
    for (let i = 0; i < entries.length; i += protocol.MAX_SLOT_ENTRIES) {
      out.push(
        protocol.encodeSlotTable({
          version: this.version,
          slotCount: this.count,
          slotWidthMs: this.widthMs,
          entries: entries.slice(i, i + protocol.MAX_SLOT_ENTRIES),
        })
      );
    }
    return out;
  }

  status() {
    const t = this.now();
    return {
      version: this.version,
      slotCount: this.count,
      slotWidthMs: this.widthMs,
      boats: [...this.byBoat.entries()]
        .map(([boatId, e]) => ({ boatId, slot: e.slot, silentS: Math.round((t - e.lastHeard) / 1000) }))
        .sort((a, b) => a.slot - b.slot),
      overflow: [...this.overflow],
    };
  }
}

class SlotTableFollower {
  // scheduler: a TxScheduler in slot mode. When `pinned` (the operator set TX_SLOT), tables are
  // ignored and the boat keeps the slot it was given by hand.
  constructor({ boatId, scheduler, pinned = false, log = () => {} }) {
    this.boatId = boatId;
    this.scheduler = scheduler;
    this.pinned = pinned;
    this.log = log;
    this.assigned = null; // the slot the base gave us, once heard
    this.lastVersion = null;
    this.tablesHeard = 0;
  }

  onTable(table) {
    if (this.pinned) return false;
    this.tablesHeard++;
    this.lastVersion = table.version;
    const mine = table.entries.find((e) => e.boatId === this.boatId);
    if (!mine) return false; // another part of the table, or the base has no room for us
    const cur = this.scheduler.slot;
    if (this.assigned === mine.slot && cur.index === mine.slot && cur.count === table.slotCount && cur.widthMs === table.slotWidthMs) return false;
    this.assigned = mine.slot;
    this.scheduler.setSlot({ index: mine.slot, count: table.slotCount, widthMs: table.slotWidthMs });
    this.log(`[slots] base assigned slot ${mine.slot} of ${table.slotCount} (${table.slotWidthMs} ms each), table v${table.version}`);
    return true;
  }
}

module.exports = { SlotAllocator, pickSlot, SlotTableFollower, slotCountForPeriod, MAX_SLOTS };
