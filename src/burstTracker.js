// Tracks the RTK correction bursts as heard on the shared radio, so telemetry can
// stay out of their way (see txGate.js/txScheduler.js).
//
// The base sends its RTCM messages as a short burst once per correction interval
// (a second by default). Every radio in range hears the same burst, so the moment
// it STARTS - the first RTCM message decoded after a quiet gap - is a shared time
// reference needing no clock sync. This keeps the recent burst starts, learns the
// period, and predicts the next starts. It also learns where each message type
// normally falls inside a burst, so a burst whose first message was lost (the
// radio can miss the start of a burst) is still anchored correctly from whichever
// message arrives first.
//
// Times are milliseconds on a monotonic clock (performance.now() by default).

const { performance } = require('perf_hooks');

const BURST_GAP_MS = 400; // quiet gap that separates one burst from the next
const KEEP_STARTS = 16;
const KEEP_OFFSETS = 24;
const MIN_PERIOD_MS = 400;
const MAX_PERIOD_MS = 15000;

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

class BurstTracker {
  constructor({ now = () => performance.now(), gapMs = BURST_GAP_MS } = {}) {
    this.now = now;
    this.gapMs = gapMs;
    this.starts = []; // burst start times, oldest first
    this.cur = null; // the burst in progress: { start, firstType, msgs: [{ type, t }] }
    this.lastMsgAt = -Infinity;
    this.offsets = new Map(); // message type -> recent offsets (ms after the burst start)
    this.firstTypes = []; // recent first-message types, to find the usual one
    this.bursts = 0;
    this.anchorCorrections = 0;
  }

  // Call for every RTCM message the radio decodes.
  onRtcm(type, t = this.now()) {
    if (t - this.lastMsgAt > this.gapMs || !this.cur) {
      this._closeBurst();
      let start = t;
      const usual = this._usualFirstType();
      // The usual first message is normally at offset ~0; if a different one arrives first,
      // the usual one was lost - back-date the start by this message's learned offset.
      if (usual !== null && type !== usual) {
        const off = median(this.offsets.get(type) || []);
        if (off !== null && off > 0) {
          start = t - off;
          this.anchorCorrections++;
        }
      }
      this.cur = { start, firstType: type, msgs: [] };
      this.starts.push(start);
      if (this.starts.length > KEEP_STARTS) this.starts.shift();
      this.bursts++;
    }
    this.cur.msgs.push({ type, t });
    this.lastMsgAt = t;
  }

  // Learn each message type's usual offset within a burst that began with the usual first
  // message (so the offsets are measured from a true burst start).
  _closeBurst() {
    const b = this.cur;
    if (!b || !b.msgs.length) return;
    this.firstTypes.push(b.firstType);
    if (this.firstTypes.length > KEEP_OFFSETS) this.firstTypes.shift();
    if (b.firstType !== this._usualFirstType()) return;
    for (const m of b.msgs) {
      const arr = this.offsets.get(m.type) || [];
      arr.push(m.t - b.msgs[0].t);
      if (arr.length > KEEP_OFFSETS) arr.shift();
      this.offsets.set(m.type, arr);
    }
  }

  _usualFirstType() {
    if (this.firstTypes.length < 3) return this.firstTypes.length ? this.firstTypes[this.firstTypes.length - 1] : null;
    const counts = new Map();
    for (const t of this.firstTypes) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  // Median spacing of recent burst starts, or null until two bursts have been heard.
  get period() {
    const iv = [];
    for (let i = 1; i < this.starts.length; i++) {
      const d = this.starts[i] - this.starts[i - 1];
      if (d >= MIN_PERIOD_MS && d <= MAX_PERIOD_MS) iv.push(d);
    }
    return median(iv);
  }

  get lastStart() {
    return this.starts.length ? this.starts[this.starts.length - 1] : null;
  }

  // True while bursts are still being heard. After a few missed cycles it goes false and
  // callers should stop holding anything back (they are out of range, or the base is off).
  isActive(t = this.now()) {
    const p = this.period;
    if (p === null || this.lastStart === null) return false;
    return t - this.lastStart <= Math.max(3 * p + 500, 3000);
  }

  // The first predicted burst start at or after `after`.
  nextStart(after) {
    const p = this.period;
    if (p === null || this.lastStart === null) return null;
    const k = Math.max(0, Math.ceil((after - this.lastStart) / p));
    return this.lastStart + k * p;
  }

  // The most recent burst start (real or predicted) at or before `t`.
  startAtOrBefore(t) {
    const p = this.period;
    if (p === null || this.lastStart === null) return null;
    const k = Math.floor((t - this.lastStart) / p);
    return this.lastStart + k * p;
  }

  status(t = this.now()) {
    return {
      active: this.isActive(t),
      bursts: this.bursts,
      periodMs: this.period,
      lastStartAgoMs: this.lastStart === null ? null : t - this.lastStart,
      anchorCorrections: this.anchorCorrections,
    };
  }
}

module.exports = { BurstTracker, median };
