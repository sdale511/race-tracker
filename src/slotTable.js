// Transmit-slot assignment for the shared radio (see txScheduler.js).
//
//   SlotAllocator      (base) hands each boat it hears a slot and builds the frames that tell
//                      every boat what they got.
//   SlotTableFollower  (boat) reads those frames and points its scheduler at the assigned slot.
//
// Assignment rules, chosen so a boat joining or leaving never moves anyone else:
//   - a boat gets the lowest free slot the first time the base hears it, and keeps it;
//   - a slot is freed only after the boat has been silent for staleMs (minutes, not seconds -
//     a boat that is briefly out of range or asleep should find its slot waiting);
//   - with more boats than slots, the extras get no entry and keep using their own fallback slot
//     (hashed from the boat id) - the base logs it once. Slot size is fixed; it does not change
//     with the number of boats.

const protocol = require('./protocol');

class SlotAllocator {
  constructor({ count, widthMs, staleMs = 10 * 60 * 1000, now = () => Date.now(), log = () => {} }) {
    this.count = Math.max(1, Math.min(255, count));
    this.widthMs = Math.max(1, Math.min(255, widthMs));
    this.staleMs = staleMs;
    this.now = now;
    this.log = log;
    this.version = 0;
    this.byBoat = new Map(); // boatId -> { slot, lastHeard }
    this.overflow = new Set(); // boats heard while every slot was taken
    this.changed = false; // an assignment changed since the table was last taken
  }

  // Call for every frame (position, batch, hello) heard from a boat. Returns its slot, or null
  // when every slot is taken.
  noteHeard(boatId) {
    if (typeof boatId !== 'string' || boatId.length !== protocol.BOAT_ID_LEN) return null;
    const t = this.now();
    const existing = this.byBoat.get(boatId);
    if (existing) {
      existing.lastHeard = t;
      return existing.slot;
    }
    const taken = new Set([...this.byBoat.values()].map((e) => e.slot));
    let slot = 0;
    while (slot < this.count && taken.has(slot)) slot++;
    if (slot >= this.count) {
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

module.exports = { SlotAllocator, SlotTableFollower };
