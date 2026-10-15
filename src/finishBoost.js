// Guarantees the base sees a finish crossing. The base counts a lap only when two consecutive fixes it received straddle the finish line
// (finishLineWatcher.js); a boat that is reporting sparsely at that moment - no slot, backing off, parked by mistake, or its gate admitting
// one fix a second - can have the whole crossing fall in a gap with every fix received on one side or the other (a boat that finished at 50 kn
// was seen south of the line before and after). This watches the boat's own full-rate fixes for the same crossing the base looks for and,
// when it sees one, hands back the fixes just before it (which the boat's gates dropped) and keeps the boat's gates open for a moment after,
// so the pair that straddles the line, and the ones around it, are all sent whatever state the boat is in.

const { FinishLineWatcher } = require('./finishLineWatcher');

class FinishBoost {
  // marks: { committeeFinish, finish } as the boat has them; windowMs: how long after the crossing every fix is let through;
  // beforeMs: how far back the fixes handed back reach
  constructor(marks, { windowMs = 1500, beforeMs = 1500, keep = 40 } = {}) {
    this.watcher = new FinishLineWatcher(marks);
    this.windowMs = windowMs;
    this.beforeMs = beforeMs;
    this.keep = keep;
    this.recent = []; // the last few fixes, newest last, not including the one being judged
    this.urgentUntil = 0;
  }

  // Call with every fix, in order. Returns { urgent, before }: urgent is true for this fix when it must be sent whatever the boat's gates
  // say (the crossing fix and those just after it); before is the earlier fixes to send first, only on the crossing itself.
  onFix(fix) {
    const crossing = this.watcher.check(fix.lat, fix.lon, fix.timestamp);
    let before = [];
    if (crossing) {
      this.urgentUntil = fix.timestamp + this.windowMs;
      before = this.recent.filter((f) => f.timestamp >= fix.timestamp - this.beforeMs);
    }
    this.recent.push(fix);
    if (this.recent.length > this.keep) this.recent.shift();
    return { urgent: fix.timestamp <= this.urgentUntil, before };
  }

  // Is the boat inside the window after a crossing at this time? For the boat's pacing, which asks between fixes.
  isUrgent(timestamp) {
    return timestamp <= this.urgentUntil;
  }
}

module.exports = { FinishBoost };
