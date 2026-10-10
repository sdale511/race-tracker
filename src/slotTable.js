// Transmit-slot assignment for the shared radio (see txScheduler.js).
//
//   SlotAllocator      (base) hands each boat it hears a slot and builds the frames that tell
//                      every boat what they got.
//   SlotTableFollower  (boat) reads those frames and points its scheduler at the assigned slot.
//
// Assignment rules, chosen so a boat joining or leaving never moves anyone else:
//   - a boat gets the next free slot in a spread-out order (0, halfway, quarters, ... - see
//     slotOrder) the first time the base hears it, and keeps it;
//   - a boat only gets a slot once it is actively reporting (one fix showing it under way, or
//     activeFrames fixes within activeWindowMs), so idle boats - a moored fleet sending one heartbeat
//     fix a minute - take none;
//   - a slot is freed only after the boat has stopped reporting actively for staleMs (a couple of
//     minutes - a boat briefly out of range finds its slot waiting; an idle one gives it up, and a
//     lone heartbeat fix does not count as reporting);
//   - the last joinSlots slots are never assigned: a boat without a slot of its own (newly active, or
//     left out because every slot is taken) shares them, so it can't land on a racing boat's slot;
//   - with more active boats than slots, the extras get no entry and stay in the join slots - the
//     base logs it once. Slot size is fixed; it does not change with the number of boats.

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
  constructor({ count, widthMs, joinSlots = 0, staleMs = 2 * 60 * 1000, activeFrames = 2, activeWindowMs = 20 * 1000, holdMs = 30 * 60 * 1000, now = () => Date.now(), log = () => {} }) {
    this.count = Math.max(1, Math.min(MAX_SLOTS, count));
    this.widthMs = Math.max(1, Math.min(255, widthMs));
    // The last joinSlots of the count are never assigned (see protocol.js's slot table frame): boats
    // without a slot send in those. Always leaves at least one slot to assign.
    this.joinSlots = Math.max(0, Math.min(joinSlots, this.count - 1));
    this.staleMs = staleMs;
    this.holdMs = holdMs;
    this.released = new Map(); // boatId -> { slot, at } for slots given up, kept for holdMs
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

  get assignable() {
    return this.count - this.joinSlots;
  }

  // Call for every position fix heard from a boat (a batch counts each of its fixes). A boat gets a
  // slot only once it is actively reporting - activeFrames fixes within activeWindowMs - so boats
  // sitting idle (a moored fleet sending one heartbeat fix a minute) never take one. Returns its
  // slot, or null when it has none (not active yet, or every slot is taken).
  noteHeard(boatId, { moving = false } = {}) {
    if (typeof boatId !== 'string' || boatId.length !== protocol.BOAT_ID_LEN) return null;
    const t = this.now();
    const times = (this.recent.get(boatId) || []).filter((x) => t - x <= this.activeWindowMs);
    times.push(t);
    this.recent.set(boatId, times);
    // Active = reporting at the active rate, or a single fix that shows the boat under way (its speed is
    // in every fix) - so a boat heading for the start line gets a slot on its first fix, not its second.
    const active = moving || times.length >= this.activeFrames;
    const existing = this.byBoat.get(boatId);
    if (existing) {
      // A slot is kept alive only by active reporting too: a lone heartbeat fix (one a minute from a
      // boat sitting still) must not hold a slot that the stale time would otherwise free.
      if (active) existing.lastHeard = t;
      return existing.slot;
    }
    if (!active) return null;
    return this._assign(boatId, t);
  }

  // Gives a boat a slot (its previous one if free, otherwise the next in the spread order), or none
  // when every slot is taken. Returns the slot or null.
  _assign(boatId, t) {
    const taken = new Set([...this.byBoat.values()].map((e) => e.slot));
    // A boat that gave its slot up and comes back goes to the same one if it is still free (the boat
    // never stopped using it). For anyone else, slots other boats gave up recently are the last to be
    // handed out, so those boats are likelier to find theirs still free.
    const prev = this.released.get(boatId);
    let slot = null;
    let returned = false;
    if (prev && t - prev.at <= this.holdMs && prev.slot < this.assignable && !taken.has(prev.slot)) {
      slot = prev.slot;
      returned = true;
    } else {
      const recentlyReleased = new Set();
      for (const [id, r] of this.released) if (id !== boatId && t - r.at <= this.holdMs) recentlyReleased.add(r.slot);
      slot = pickSlot(new Set([...taken, ...recentlyReleased]), this.assignable);
      if (slot === null) slot = pickSlot(taken, this.assignable);
    }
    this.released.delete(boatId);
    if (slot === null) {
      if (!this.overflow.has(boatId)) {
        this.overflow.add(boatId);
        this.log(`[slots] no free slot for ${boatId}: all ${this.assignable} are taken - it shares the ${this.joinSlots} join slot${this.joinSlots === 1 ? '' : 's'}`);
      }
      return null;
    }
    this.byBoat.set(boatId, { slot, lastHeard: t });
    this.overflow.delete(boatId);
    this._changed();
    this.log(`[slots] ${boatId} -> slot ${slot} of ${this.assignable} (${this.byBoat.size} boat${this.byBoat.size === 1 ? '' : 's'})${returned ? ' - back in its previous slot' : ''}`);
    return slot;
  }

  // Before a race start: clear the table down to the boats that are about to start. Every boat not in
  // `boatIds` gives its slot up; boats in it that already have a slot keep it (nothing moves for them),
  // and the rest are assigned one now, without waiting for them to be heard moving. Returns
  // { kept, assigned, released, overflow }.
  prepareStart(boatIds) {
    const t = this.now();
    const want = [...new Set(boatIds.filter((id) => typeof id === 'string' && id.length === protocol.BOAT_ID_LEN))];
    const wantSet = new Set(want);
    // (release() with an empty list means "everyone", so only call it when there are ids)
    const toRelease = [...this.byBoat.keys()].filter((id) => !wantSet.has(id));
    const released = toRelease.length ? this.release(toRelease) : [];
    const kept = want.filter((id) => this.byBoat.has(id));
    const assigned = [];
    const overflow = [];
    for (const id of want) {
      if (this.byBoat.has(id)) {
        this.byBoat.get(id).lastHeard = t;
        continue;
      }
      if (this._assign(id, t) !== null) assigned.push(id);
      else overflow.push(id);
    }
    // forget boats that gave up a slot and are not starting, so they don't count as waiting
    for (const id of [...this.overflow]) if (!wantSet.has(id)) this.overflow.delete(id);
    return { kept, assigned, released, overflow };
  }

  // Frees the slots of the named boats (all of them when boatIds is empty/null) right away, without
  // waiting for the stale time - used when the base puts a fleet to sleep, so the next fleet can take
  // the slots. A boat that wakes and starts racing again gets the same slot back if it is still free.
  // Returns the freed ids.
  release(boatIds = null) {
    const t = this.now();
    const wanted = boatIds && boatIds.length ? new Set(boatIds) : null;
    const freed = [];
    for (const [boatId, e] of this.byBoat) {
      if (wanted && !wanted.has(boatId)) continue;
      this.byBoat.delete(boatId);
      this.released.set(boatId, { slot: e.slot, at: t });
      this.recent.delete(boatId);
      freed.push(boatId);
    }
    if (wanted) for (const id of wanted) { this.recent.delete(id); this.overflow.delete(id); }
    else { this.recent.clear(); this.overflow.clear(); }
    if (freed.length) {
      this._changed();
      this.log(`[slots] released ${freed.length} slot${freed.length === 1 ? '' : 's'} (${freed.join(', ')})`);
    }
    return freed;
  }

  // Frees the slots of boats silent for longer than staleMs. Returns the freed boat ids.
  sweep() {
    const t = this.now();
    const freed = [];
    for (const [boatId, e] of this.byBoat) {
      if (t - e.lastHeard > this.staleMs) {
        this.byBoat.delete(boatId);
        this.released.set(boatId, { slot: e.slot, at: t });
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
    for (const [boatId, r] of this.released) if (t - r.at > this.holdMs) this.released.delete(boatId);
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
          joinSlots: this.joinSlots,
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
      joinSlots: this.joinSlots,
      boats: [...this.byBoat.entries()]
        .map(([boatId, e]) => ({ boatId, slot: e.slot, silentS: Math.round((t - e.lastHeard) / 1000) }))
        .sort((a, b) => a.slot - b.slot),
      overflow: [...this.overflow],
    };
  }
}

class SlotTableFollower {
  // scheduler: a TxScheduler in slot mode. When `pinned` (the operator set TX_SLOT), tables are
  // ignored and the boat keeps the slot it was given by hand. Otherwise the boat starts in the shared
  // join slots, learns the real slot count, width and join slots from any table it hears (even one
  // without an entry for it), and moves to its own slot when a table assigns one. Once it has a slot it
  // keeps using it even if the base later frees it - the base gives it the same slot back if it can.
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
    const cur = this.scheduler.slot;
    const mine = table.entries.find((e) => e.boatId === this.boatId);
    if (!mine) {
      // Not (yet) in the table. Until it has had a slot of its own, share the join slots - at the count,
      // width and join slots the base is actually using.
      if (this.assigned !== null || table.joinSlots < 1) return false;
      const join = { first: table.slotCount - table.joinSlots, n: table.joinSlots };
      if (cur.count === table.slotCount && cur.widthMs === table.slotWidthMs && cur.join && cur.join.first === join.first && cur.join.n === join.n) return false;
      this.scheduler.setSlot({ count: table.slotCount, widthMs: table.slotWidthMs, join });
      return false;
    }
    if (this.assigned === mine.slot && !cur.join && cur.index === mine.slot && cur.count === table.slotCount && cur.widthMs === table.slotWidthMs) return false;
    this.assigned = mine.slot;
    this.scheduler.setSlot({ index: mine.slot, count: table.slotCount, widthMs: table.slotWidthMs, join: null });
    this.log(`[slots] base assigned slot ${mine.slot} of ${table.slotCount - table.joinSlots} (${table.slotWidthMs} ms each), table v${table.version}`);
    return true;
  }
}

module.exports = { SlotAllocator, pickSlot, SlotTableFollower, slotCountForPeriod, MAX_SLOTS };
