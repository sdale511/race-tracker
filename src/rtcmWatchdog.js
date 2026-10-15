// Says so, loudly, when this boat does not hear the base's RTCM correction bursts. The transmit slots are timed from those bursts: a
// boat that does not hear them is not slot-timed (it sends whenever it likes, on top of other boats), and it usually means the boat
// is out of range or the base's correction radio is off - RTK corrections are probably not reaching the GPS either.
//
// Checked every few seconds. Warns once the bursts have been missing for graceMs (counted from when the boat started, if it has never
// heard any), repeats every repeatMs while they stay missing, and says so once when they come back. Paused while the boat's radio is
// asleep on purpose, when it hears nothing.

class RtcmWatchdog {
  constructor({ tracker, warn = console.warn, info = console.log, color = (s) => s, graceMs = 20000, repeatMs = 30000, paused = () => false }) {
    this.tracker = tracker;
    this.warn = warn;
    this.info = info;
    this.color = color;
    this.graceMs = graceMs;
    this.repeatMs = repeatMs;
    this.paused = paused;
    this.startedAt = tracker.now(); // the reference until a first burst is heard (or after the radio wakes)
    this.missing = false;
    this.lastWarnAt = -Infinity;
    this.missingSince = null;
  }

  check() {
    const t = this.tracker.now();
    if (this.paused()) {
      this.startedAt = t; // the radio was off: give it a fresh grace period when it wakes
      this.missing = false;
      return;
    }
    if (this.tracker.isActive(t)) {
      if (this.missing) {
        this.info(`[rtcm] correction bursts heard again after ${Math.round((t - this.missingSince) / 1000)} s`);
      }
      this.missing = false;
      this.missingSince = null;
      return;
    }
    const last = this.tracker.lastStart;
    const since = last !== null && last >= this.startedAt ? last : this.startedAt;
    const silentMs = t - since;
    if (silentMs < this.graceMs) return;
    if (!this.missing) {
      this.missing = true;
      this.missingSince = since;
    }
    if (t - this.lastWarnAt < this.repeatMs) return;
    this.lastWarnAt = t;
    const secs = Math.round(silentMs / 1000);
    this.warn(
      this.color(
        last !== null && last >= this.startedAt
          ? `[rtcm] WARNING: no correction bursts heard for ${secs} s - out of range of the base, or its correction radio is off. ` +
              'Transmit slots cannot be timed (this boat sends unslotted) and RTK corrections are probably not arriving'
          : `[rtcm] WARNING: no correction bursts heard since this boat started (${secs} s) - is the base's correction radio on and in range? ` +
              'Transmit slots cannot be timed (this boat sends unslotted) and RTK corrections are probably not arriving'
      )
    );
  }
}

module.exports = { RtcmWatchdog };
