// Holds back radio writes so they stay out of the RTK correction burst and, optionally, lands
// each boat's telemetry in its own time slot - the shared-radio ("one radio") scheduler.
//
// It wraps a radio's send(): every frame passes through submit(). With no correction bursts
// being heard (no base, out of range, a separate correction radio) nothing is held and
// behaviour is exactly as before. Once bursts are heard (burstTracker.js):
//
//   - every frame waits until txGate.js says it is clear of the burst (hold, don't drop: the
//     window is short, about 60-100 ms, and the wait is usually zero);
//   - in SLOT mode, position and batch frames (the bulk of the traffic) are also released only
//     in this boat's slot of each cycle. A cycle starts at a burst; slot i begins
//     blockAfter + guard + i * slotMs after the burst start, so boats with different slot
//     numbers never overlap. Frames queue up and go out back to back when the slot opens, as
//     many as fit in the slot's air-time budget; the rest wait for the next cycle.
//
// Everything else (hello, ping replies, set-mark, mark-log, sleep/wake) is gated but not slotted:
// it is rare and shouldn't wait a whole cycle.
//
// A slot only works if every boat uses a different slot number, so boats are given one: by the
// base's slot table (slotTable.js - the normal way), explicitly (TX_SLOT), or, until a table is
// heard, derived from the boat id - which can collide. Timing the slots on this machine is limited by its serial/USB delay (see the
// radio-latency test).

const { performance } = require('perf_hooks');

// Estimated radio air time of one frame, used only to budget how much fits in a slot:
// per packet overhead + RF time at 200 kb/s. The overhead is an upper bound from measured
// latencies (docs/radio-latency-findings-2026-10-09.pdf), not a measured air time.
const AIR_MS_PER_PACKET = 8;
const AIR_MS_PER_BYTE = 0.04;
const SLOTTED_SYNCS = new Set([0xaa, 0xee]); // position frame, batch frame

function airMs(bytes) {
  return AIR_MS_PER_PACKET + bytes * AIR_MS_PER_BYTE;
}

// FNV-1a over the boat id, modulo the slot count - a deterministic default slot.
function hashSlot(boatId, count) {
  let h = 0x811c9dc5;
  for (const ch of String(boatId)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % count;
}

class TxScheduler {
  constructor({
    send, // the underlying (already-wrapped) send(buf) -> bool
    tracker,
    gate,
    slot = { enabled: false, index: 0, count: 30, widthMs: 30 },
    maxQueue = 12,
    maxAgeMs = 5000, // a frame held longer than this is dropped, not sent stale (positions are on the SD card)
    now = () => performance.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    log = () => {},
  }) {
    this.rawSend = send;
    this.tracker = tracker;
    this.gate = gate;
    this.slot = slot;
    this.maxQueue = maxQueue;
    this.maxAgeMs = maxAgeMs;
    this.lastSlotWarnAt = -Infinity;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.log = log;
    this.queue = [];
    this.timer = null;
    this.flushFn = null; // see startSlotFlush
    this.flushTimer = null;
    this.flushWasAligned = false;
    this.wasActive = false;
    this.window = { start: null, used: 0 }; // the slot window currently being filled
    this.counters = { submitted: 0, passedThrough: 0, held: 0, heldMsTotal: 0, heldMsMax: 0, dropped: 0, expired: 0, slotted: 0, spilled: 0 };
    this._checkSlotFit();
  }

  // Warn if the slots can't all fit between one burst's wake and the next burst's approach.
  _checkSlotFit() {
    if (!this.slot.enabled) return;
    const needed = this.gate.afterMs() + this.slot.count * this.slot.widthMs + this.gate.beforeMs(84);
    this.slotFitNeededMs = needed; // compared with the real period once bursts are heard
  }

  // Move this boat to a different slot (or change the slot count/width) while running - used
  // when the base's slot table assigns one (slotTable.js). Frames already queued are re-timed
  // against the new slot.
  setSlot({ index, count = this.slot.count, widthMs = this.slot.widthMs }) {
    this.slot = { ...this.slot, enabled: true, index, count, widthMs };
    this.window = { start: null, used: 0 };
    this._checkSlotFit();
    this._warnIfSlotsOverrun();
    if (this.queue.length) this._schedule(0);
    if (this.flushFn) this._armFlush();
  }

  _warnIfSlotsOverrun() {
    const p = this.tracker.period;
    if (this.slot.enabled && p && this.tracker.isActive(this.now()) && this.slotFitNeededMs > p) {
      this.log(`[txgate] WARNING: ${this.slot.count} slots of ${this.slot.widthMs} ms need ~${Math.round(this.slotFitNeededMs)} ms but the burst period is ${Math.round(p)} ms - the last slots would overrun`);
    }
  }

  // True while this boat is sending in slots: slot mode is on and the correction bursts are being
  // heard (so the slot timing means something).
  slotAligned() {
    return this.slot.enabled && this.tracker.isActive(this.now());
  }

  // Slot-aligned sending: call fn() just after this boat's slot opens, every cycle, so the caller
  // can send everything it has gathered in one go (fewest, fullest frames) instead of releasing
  // frames on its own clock and having them queue up for the slot. fn is also called once when the
  // bursts stop being heard, so nothing it was holding back is left waiting.
  startSlotFlush(fn) {
    this.flushFn = fn;
    this._armFlush();
  }

  _armFlush() {
    if (this.flushTimer) this.clearTimer(this.flushTimer);
    this.flushTimer = null;
    const t = this.now();
    const aligned = this.slotAligned();
    let delay = 500; // not aligned: just keep an eye out for the bursts (or slot mode) starting
    if (aligned) {
      const { index, widthMs } = this.slot;
      const p = this.tracker.period;
      const base = this.tracker.startAtOrBefore(t);
      delay = null;
      for (let k = 0; k < 3 && p; k++) {
        const start = base + k * p + this.gate.afterMs() + index * widthMs;
        if (start > t + 0.5) {
          delay = start - t + 1; // 1 ms after the slot opens, so the frames find it open
          break;
        }
      }
      if (delay === null) delay = 250;
    }
    this.flushTimer = this.setTimer(() => this._flushTick(aligned), delay);
    if (this.flushTimer && this.flushTimer.unref) this.flushTimer.unref();
  }

  _flushTick(wasAligned) {
    this.flushTimer = null;
    const aligned = this.slotAligned();
    // Fire when the slot opens, and once when alignment is lost so held-back frames are let go.
    if (wasAligned || (this.flushWasAligned && !aligned)) {
      try {
        this.flushFn();
      } catch (err) {
        this.log(`[txgate] slot flush failed: ${err.message}`);
      }
    }
    this.flushWasAligned = aligned;
    this._armFlush();
  }

  submit(buf) {
    const t = this.now();
    this.counters.submitted++;
    const active = this.tracker.isActive(t);
    if (active !== this.wasActive) {
      this.wasActive = active;
      const p = this.tracker.period;
      this.log(
        active
          ? `[txgate] correction bursts heard (every ${p ? Math.round(p) : '?'} ms) - telemetry now keeps clear of them${this.slot.enabled ? `, slot ${this.slot.index} of ${this.slot.count}` : ''}`
          : '[txgate] no correction bursts heard - telemetry unrestricted'
      );
      if (active) this._warnIfSlotsOverrun();
    }
    const slotted = this.slot.enabled && SLOTTED_SYNCS.has(buf[0]);
    if (this.queue.length === 0) {
      // nothing waiting ahead of it: if it is clear to go right now, write it with no timer delay
      if (!active || this._waitFor(buf.length, slotted, t) <= 0.5) {
        this.counters.passedThrough++;
        if (slotted && active) this._markSlotUsed(buf.length, t);
        return this.rawSend(buf);
      }
    }
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift(); // oldest first: positions are logged to SD and stale ones help nobody
      this.counters.dropped++;
    }
    this.queue.push({ buf, bytes: buf.length, at: t, slotted });
    this._schedule(0);
    return true;
  }

  _schedule(delayMs) {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => this._pump(), Math.max(0, delayMs));
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  // Wait (ms from `t`) until this boat's slot can take a frame of `bytes`, 0 if it can go now.
  _slotWaitMs(bytes, t) {
    const { index, widthMs } = this.slot;
    const p = this.tracker.period;
    const base = this.tracker.startAtOrBefore(t);
    const need = airMs(bytes);
    for (let k = 0; k < 3; k++) {
      const start = base + k * p + this.gate.afterMs() + index * widthMs;
      const end = start + widthMs;
      if (t >= end) continue;
      const sameWindow = this.window.start !== null && Math.abs(this.window.start - start) < 1;
      const used = sameWindow ? this.window.used : 0;
      const fits = used === 0 || used + need <= widthMs - this.gate.guardMs; // a frame bigger than a slot still gets one
      if (t >= start && fits) return 0;
      if (t >= start && !fits) {
        this.counters.spilled++;
        if (t - this.lastSlotWarnAt > 30000) {
          this.lastSlotWarnAt = t;
          this.log(`[txgate] WARNING: slot ${index} (${widthMs} ms) is too small for this boat's traffic - frames are waiting for later cycles. Raise TX_SLOT_MS (a 84-byte batch frame needs about 11 ms of slot plus a ${this.gate.guardMs} ms guard)`);
        }
        continue; // this slot is full - wait for the next cycle's
      }
      return start - t;
    }
    return 0;
  }

  // Total wait (ms from `t`) before a frame may be written: the gate's, plus the boat's slot.
  _waitFor(bytes, slotted, t) {
    let wait = this.gate.waitMs(bytes, t);
    if (slotted) wait += this._slotWaitMs(bytes, t + wait);
    return wait;
  }

  _markSlotUsed(bytes, t) {
    const { index, widthMs } = this.slot;
    const base = this.tracker.startAtOrBefore(t);
    const p = this.tracker.period;
    for (let k = 0; k < 3; k++) {
      const start = base + k * p + this.gate.afterMs() + index * widthMs;
      if (t < start + widthMs) {
        if (this.window.start === null || Math.abs(this.window.start - start) >= 1) this.window = { start, used: 0 };
        this.window.used += airMs(bytes);
        return;
      }
    }
  }

  _pump() {
    this.timer = null;
    const t0 = this.now();
    while (this.queue.length && t0 - this.queue[0].at > this.maxAgeMs) {
      this.queue.shift();
      this.counters.expired++;
    }
    if (!this.tracker.isActive(t0)) {
      // bursts stopped being heard: send everything straight out, in order
      while (this.queue.length) this._sendHead(t0);
      return;
    }
    while (this.queue.length) {
      const t = this.now();
      const head = this.queue[0];
      const wait = this._waitFor(head.bytes, head.slotted, t);
      if (wait > 0.5) {
        this._schedule(wait + 1);
        return;
      }
      this._sendHead(t);
    }
  }

  _sendHead(t) {
    const e = this.queue.shift();
    const heldMs = t - e.at;
    if (heldMs > 5) {
      this.counters.held++;
      this.counters.heldMsTotal += heldMs;
      this.counters.heldMsMax = Math.max(this.counters.heldMsMax, heldMs);
    }
    if (e.slotted) {
      this.counters.slotted++;
      if (this.tracker.isActive(t)) this._markSlotUsed(e.bytes, t);
    }
    this.rawSend(e.buf);
  }

  stats() {
    return { ...this.counters, queued: this.queue.length, tracker: this.tracker.status(this.now()) };
  }
}

module.exports = { TxScheduler, hashSlot, airMs };
