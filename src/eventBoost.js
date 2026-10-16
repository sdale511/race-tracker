// Guarantees the base gets the fixes it needs to see a race event. The base detects the start, a lap (the finish) and the fouls from two
// CONSECUTIVE fixes it received that straddle a line (onGridWatcher.crossedStartLine, finishLineWatcher.js, foulWatcher.js): one fix on
// each side is all it needs, wherever the boat's other fixes went. A boat that is reporting sparsely at that moment - no slot, backing
// off, its gate admitting one fix a second, a frame lost - can have the whole crossing fall in a gap, with every fix received on one
// side (a boat that finished at 50 kn was seen south of the line before and after, and its lap was never counted).
//
// This runs the same detectors on the boat's own full-rate fixes. When one sees an event it hands back the fixes just before (which the
// boat's gates dropped) and keeps the gates open for a moment after, so the pair that straddles the line is sent whatever state the boat is
// in. It only decides what to send; the base still does the counting. A trigger that fires without the base agreeing costs a few extra fixes.
//
// Mark roundings are different - the base needs several fixes inside the rounding zone to see the turn - and are covered by the full-rate
// zone around each mark (TX_SLOT_MARK_ZONE_M), not by this.

const { FinishLineWatcher } = require('./finishLineWatcher');
const { FoulWatcher } = require('./foulWatcher');
const { OnGridWatcher } = require('./onGridWatcher');

class EventBoost {
  // marks: the course marks the boat has. zoneM: the on-grid zone width (the start-line detector is built on the same watcher the base uses).
  // beforeFixes: how many fixes before the event are handed back; windowMs: how long after it every fix goes through.
  constructor(marks, { zoneM = 10, beforeFixes = 2, windowMs = 600, keep = 8 } = {}) {
    this.finish = tryBuild(() => new FinishLineWatcher(marks));
    this.foul = tryBuild(() => new FoulWatcher(marks));
    this.start = tryBuild(() => new OnGridWatcher(marks, zoneM));
    this.beforeFixes = beforeFixes;
    this.windowMs = windowMs;
    this.keep = keep;
    this.recent = []; // the last few fixes, newest last, not including the one being judged
    this.urgentUntil = 0;
  }

  // Call with every fix, in order. Returns { urgent, before, events }: urgent is true for this fix when it must be sent whatever the boat's gates
  // say; before is the earlier fixes to send first (only on the event itself); events names what was seen ('finish', 'start', 'foul').
  onFix(fix) {
    const events = [];
    const prev = this.recent.length ? this.recent[this.recent.length - 1] : null;
    if (this.finish && this.finish.check(fix.lat, fix.lon, fix.timestamp)) events.push('finish');
    if (this.start && prev && this.start.crossedStartLine(prev.lat, prev.lon, fix.lat, fix.lon)) events.push('start');
    if (this.foul && this.foul.check(fix.lat, fix.lon, fix.timestamp)) events.push('foul');
    let before = [];
    if (events.length) {
      this.urgentUntil = fix.timestamp + this.windowMs;
      before = this.recent.slice(-this.beforeFixes);
    }
    this.recent.push(fix);
    if (this.recent.length > this.keep) this.recent.shift();
    return { urgent: fix.timestamp <= this.urgentUntil, before, events };
  }

  // Is the boat inside the window after an event at this time? For the boat's pacing, which asks between fixes.
  isUrgent(timestamp) {
    return timestamp <= this.urgentUntil;
  }
}

function tryBuild(make) {
  try {
    return make();
  } catch (err) {
    return null; // the marks do not describe this line yet
  }
}

module.exports = { EventBoost };
