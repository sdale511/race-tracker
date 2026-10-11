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

// "Parked" boats are those inside the on-grid zone behind the start line (onGridWatcher.js): they take no
// slot, and report only occasionally (see ParkedReporter), so a fleet queueing for a start can't use up the
// slots - or swamp the shared join slots - while another fleet is still racing. ZoneState adds hysteresis
// so a boat jostling at the edge of the zone doesn't flip in and out: it is parked on the first fix inside
// and unparked only after unparkFixes fixes in a row outside.
class ZoneState {
  constructor(unparkFixes = 3) {
    this.unparkFixes = Math.max(1, unparkFixes);
    this.parked = false;
    this.outside = 0;
    this.crossedLine = false;
  }

  // pastLine: this fix is past the start line on the course side. A boat that leaves the zone through the line
  // (crossedLine) has started; one that leaves backwards or sideways has not.
  update(inZone, pastLine = false) {
    if (inZone) {
      this.parked = true;
      this.outside = 0;
      this.crossedLine = false;
    } else if (this.parked) {
      if (pastLine) this.crossedLine = true;
      if (++this.outside >= this.unparkFixes) {
        this.parked = false;
        this.outside = 0;
      }
    }
    return this.parked;
  }
}

// Paces a parked boat's reports to one every intervalMs, plus or minus `jitter` (a fraction) chosen at
// random each time so a fleet that entered the zone together does not report together.
class ParkedReporter {
  constructor({ intervalMs, jitter = 0.25, now = () => Date.now(), rand = Math.random }) {
    this.intervalMs = intervalMs;
    this.jitter = jitter;
    this.now = now;
    this.rand = rand;
    this.nextAt = 0;
  }

  // Start of a parking spell: the first report comes a (jittered) interval from now.
  reset() {
    this.nextAt = this.now() + this._interval();
  }

  due() {
    return this.now() >= this.nextAt;
  }

  sent() {
    this.nextAt = this.now() + this._interval();
  }

  _interval() {
    return this.intervalMs * (1 - this.jitter + 2 * this.jitter * this.rand());
  }
}

// A boat with no slot of its own (waiting to be assigned one, or not racing so never going to get one) shares the
// join slots, so it backs off: its first reports come quickly - the base can assign it a slot on the first moving
// fix - then further apart, up to maxMs, each gap jittered +-25%. Cleared when it is given a slot.
class JoinBackoff {
  constructor({ maxMs, steps = [0, 1000, 2000, 4000, 8000], jitter = 0.25, now = () => Date.now(), rand = Math.random }) {
    this.steps = [...steps, maxMs].map((x) => Math.min(x, maxMs));
    this.jitter = jitter;
    this.now = now;
    this.rand = rand;
    this.reset();
  }

  reset() {
    this.step = 0;
    this.nextAt = 0;
  }

  due() {
    return this.now() >= this.nextAt;
  }

  sent() {
    const base = this.steps[Math.min(this.step, this.steps.length - 1)];
    this.nextAt = this.now() + base * (1 - this.jitter + 2 * this.jitter * this.rand());
    this.step++;
  }
}

class SlotAllocator {
  constructor({ count, widthMs, joinSlots = 0, unparkFixes = 3, staleMs = 45 * 1000, activeFrames = 0, gridOnly = false, racingTtlMs = 10 * 60 * 1000, zoneTtlMs = 10 * 60 * 1000, activeWindowMs = 20 * 1000, holdMs = 30 * 60 * 1000, now = () => Date.now(), log = () => {} }) {
    this.count = Math.max(1, Math.min(MAX_SLOTS, count));
    this.widthMs = Math.max(1, Math.min(255, widthMs));
    // The last joinSlots of the count are never assigned (see protocol.js's slot table frame): boats
    // without a slot send in those. Always leaves at least one slot to assign.
    this.joinSlots = Math.max(0, Math.min(joinSlots, this.count - 1));
    this.staleMs = staleMs;
    this.unparkFixes = unparkFixes;
    this.zones = new Map(); // boatId -> { state: ZoneState, lastHeard } for boats seen inside the on-grid zone
    this.holdMs = holdMs;
    this.released = new Map(); // boatId -> { slot, at } for slots given up, kept for holdMs
    this.activeFrames = Math.max(0, activeFrames); // 0 = a boat is active only by its speed (see noteHeard)
    // gridOnly: only boats that have come off the start grid across the line ("racing") get a slot - boats rolling
    // out, watching or heading to camp never do. Needs the course marks; without them (zoneKnown false) everyone is eligible.
    this.gridOnly = !!gridOnly;
    // A boat stays "racing" (eligible for a slot) until it has been stopped this long, or it comes back onto the grid - so
    // a stop mid-race (a repair, a pause) does not cost it its place; its slot is still freed after staleMs.
    this.racingTtlMs = racingTtlMs;
    // A boat stays "parked" this long without a fix: a boat sitting on the grid sends only a heartbeat fix about once a
    // minute, far less often than slots are freed (staleMs), so parking must outlast that or the display flips.
    this.zoneTtlMs = zoneTtlMs;
    this.racing = new Map(); // boatId -> { lastActive } for boats that started and have not stopped since
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
  noteHeard(boatId, { moving = false, inZone = false, pastLine = false, crossedStart = false, zoneKnown = true } = {}) {
    if (typeof boatId !== 'string' || boatId.length !== protocol.BOAT_ID_LEN) return null;
    const t = this.now();
    // Seen to cross the start line between two heard fixes: it has started, whether or not a fix was ever heard on the
    // grid (a late starter crosses the 10 m zone in about a second, and a parked boat reports only now and then).
    if (crossedStart && !this.racing.has(boatId)) {
      this.racing.set(boatId, { lastActive: t });
      this.zones.delete(boatId);
      this.log(`[slots] ${boatId} crossed the start line - racing`);
    }
    // A boat inside the on-grid zone is parked: no slot while it is there, and one it had is freed (it
    // is remembered, so the boat gets the same one back if it is still free when it leaves the zone).
    let zone = this.zones.get(boatId);
    if (inZone && !zone) {
      zone = { state: new ZoneState(this.unparkFixes), lastHeard: t };
      this.zones.set(boatId, zone);
    }
    if (zone) {
      zone.lastHeard = t;
      const wasParked = zone.state.parked;
      const parked = zone.state.update(inZone, pastLine);
      if (!parked) this.zones.delete(boatId);
      if (parked && !wasParked) this.log(`[slots] ${boatId} is on the start grid - parked`);
      if (!parked && wasParked) {
        if (zone.state.crossedLine) {
          this.racing.set(boatId, { lastActive: t });
          this.log(`[slots] ${boatId} started - racing`);
        } else {
          this.racing.delete(boatId);
          this.log(`[slots] ${boatId} left the start grid without starting`);
        }
      }
      if (parked) {
        this.racing.delete(boatId);
        const existing = this.byBoat.get(boatId);
        if (existing) {
          this.byBoat.delete(boatId);
          this.released.set(boatId, { slot: existing.slot, at: t });
          this._changed();
          this.log(`[slots] ${boatId} parked - slot ${existing.slot} freed`);
        }
        this.recent.delete(boatId);
        this.overflow.delete(boatId);
        return null;
      }
    }
    const times = (this.recent.get(boatId) || []).filter((x) => t - x <= this.activeWindowMs);
    times.push(t);
    this.recent.set(boatId, times);
    // Active = a fix that shows the boat under way (its speed is in every fix, so a boat gets a slot on its
    // first moving fix), or - if activeFrames is on - that many fixes within activeWindowMs. A stopped boat is
    // not active, so it frees its slot (a heartbeat fix does not count).
    const active = moving || (this.activeFrames > 0 && times.length >= this.activeFrames);
    if (active && this.racing.has(boatId)) this.racing.get(boatId).lastActive = t;
    const existing = this.byBoat.get(boatId);
    if (existing) {
      // A slot is kept alive only by active reporting too: a lone heartbeat fix (one a minute from a
      // boat sitting still) must not hold a slot that the stale time would otherwise free.
      if (active) existing.lastHeard = t;
      return existing.slot;
    }
    if (!active) return null;
    // Only boats that started from the grid get a slot (when the course marks make that knowable).
    if (this.gridOnly && zoneKnown && !this.racing.has(boatId)) return null;
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
    if (slot === null && this.racing.has(boatId)) {
      // A racing boat with no slot free takes one from a boat that is not racing (the longest silent first).
      const victims = [...this.byBoat.entries()].filter(([id]) => !this.racing.has(id)).sort((a, b) => a[1].lastHeard - b[1].lastHeard);
      if (victims.length) {
        const [victimId, v] = victims[0];
        this.byBoat.delete(victimId);
        this.released.set(victimId, { slot: v.slot, at: t });
        this.log(`[slots] ${victimId} gives up slot ${v.slot} to racing boat ${boatId}`);
        slot = v.slot;
      }
    }
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

  // The boats that have started and not stopped since, as { boatId: lastActive } - saved by the base so a restart
  // in the middle of a race does not forget who is racing.
  exportRacing() {
    return Object.fromEntries([...this.racing.entries()].map(([id, r]) => [id, r.lastActive]));
  }

  importRacing(saved, maxAgeMs = 2 * 60 * 60 * 1000) {
    const t = this.now();
    for (const [id, lastActive] of Object.entries(saved || {})) {
      if (typeof id === 'string' && id.length === protocol.BOAT_ID_LEN && Number.isFinite(lastActive) && t - lastActive <= maxAgeMs) {
        this.racing.set(id, { lastActive: Math.min(lastActive, t) });
      }
    }
  }

  // What a boat's slot situation is, for the dashboards: 'parked' (on the start grid), 'slot' (has one), 'waiting'
  // (racing, or heard while every slot was taken, but without one - it shares the join slots and reports sparsely
  // by design), or 'none' (not racing, so not entitled to one).
  slotState(boatId) {
    if (this.isParked(boatId)) return 'parked';
    if (this.byBoat.has(boatId)) return 'slot';
    if (this.racing.has(boatId) || this.overflow.has(boatId)) return 'waiting';
    return 'none';
  }

  // True while the boat is parked on the start grid (see noteHeard).
  isParked(boatId) {
    const z = this.zones.get(boatId);
    return !!z && z.state.parked;
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
    for (const [boatId, r] of this.racing) if (t - r.lastActive > this.racingTtlMs) this.racing.delete(boatId);
    for (const [boatId, z] of this.zones) if (t - z.lastHeard > this.zoneTtlMs) this.zones.delete(boatId);
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
      parked: [...this.zones.entries()].filter(([, z]) => z.state.parked).map(([id]) => id),
      racing: [...this.racing.keys()],
      gridOnly: this.gridOnly,
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
  constructor({ boatId, scheduler, pinned = false, revertAfterMs = 35 * 1000, now = () => Date.now(), log = () => {} }) {
    this.boatId = boatId;
    this.revertAfterMs = revertAfterMs;
    this.now = now;
    this.lastEntryAt = null; // when a table last listed this boat
    this.tablesSince = 0; // table frames heard since then, none listing it
    this.onAssigned = null; // called when the base gives this boat a slot
    this.scheduler = scheduler;
    this.pinned = pinned;
    this.log = log;
    this.assigned = null; // the slot the base gave us, once heard
    this.parked = false; // inside the on-grid zone - see setParked
    this.layout = null; // the count, width and join slots from the last table heard
    this.lastVersion = null;
    this.tablesHeard = 0;
  }

  // Called by the boat as it enters or leaves the on-grid zone. Parked, it goes back to the shared join
  // slots (its old slot is being freed by the base and may be given to someone else) and ignores its table
  // entry; after it leaves it stays there until a table assigns it a slot again.
  setParked(parked) {
    if (this.pinned || parked === this.parked) return;
    this.parked = parked;
    if (parked && this.layout && this.layout.joinSlots > 0) {
      this.assigned = null;
      const { slotCount, widthMs, joinSlots } = this.layout;
      this.scheduler.setSlot({ count: slotCount, widthMs, join: { first: slotCount - joinSlots, n: joinSlots } });
    }
  }

  onTable(table) {
    if (this.pinned) return false;
    this.tablesHeard++;
    this.lastVersion = table.version;
    this.layout = { slotCount: table.slotCount, widthMs: table.slotWidthMs, joinSlots: table.joinSlots };
    const cur = this.scheduler.slot;
    const mine = this.parked ? undefined : table.entries.find((e) => e.boatId === this.boatId);
    if (mine) {
      this.lastEntryAt = this.now();
      this.tablesSince = 0;
    } else if (this.assigned !== null && !this.parked) {
      // Assigned, but the base has stopped listing this boat - it freed the slot (the boat stopped, or a racing
      // boat needed it). After a few rebroadcasts without it, give the slot up and go back to the join slots so it
      // can't collide with whoever has it now. Only counted while tables are being heard.
      this.tablesSince++;
      if (this.lastEntryAt !== null && this.now() - this.lastEntryAt >= this.revertAfterMs && this.tablesSince >= 3) {
        this.assigned = null;
        const { slotCount, widthMs, joinSlots } = this.layout;
        if (joinSlots > 0) this.scheduler.setSlot({ count: slotCount, widthMs, join: { first: slotCount - joinSlots, n: joinSlots } });
        this.log('[slots] the base no longer lists this boat - back to the shared join slots');
      }
    }
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
    if (this.onAssigned) this.onAssigned(mine.slot);
    return true;
  }
}

module.exports = { SlotAllocator, ZoneState, ParkedReporter, JoinBackoff, pickSlot, SlotTableFollower, slotCountForPeriod, MAX_SLOTS };
