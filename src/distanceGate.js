// The boat's "is this fix worth sending" gate: a fix clears it when the boat has moved TX_DISTANCE_M from the last fix that
// cleared it, or when TX_INTERVAL_S has passed since then (the heartbeat of a boat that stays still).
//
// The reference is the last fix that CLEARED the gate (sent or queued for the slot), not the last one actually sent. In slot
// mode a fix waits up to a cycle (longer without a slot) before it goes out; measured against the last SENT fix, the gate
// stayed open for that whole wait, so once the boat had moved a metre every fix after it passed - a boat creeping at 1.3 kn
// sent clusters of 8 fixes a millimetre apart, then nothing for 2 s, and a heartbeat that fell due sent 8 copies of one
// position. Measured against the last fix that cleared it, consecutive fixes are at least the distance apart, and a
// heartbeat adds a single fix. Above about 19 kn at 10 Hz every fix is more than a metre from the last, so nothing changes.
//
// A send that fails (radio not connected yet, say) hands the reference back to the last fix that really went out, so the next
// fix passes again and keeps retrying instead of waiting for a metre of movement or the heartbeat.

const { distanceMeters } = require('./course');

class DistanceGate {
  // intervalMs: heartbeat; 0 disables it (distance only)
  constructor({ intervalMs = 0 } = {}) {
    this.intervalMs = intervalMs;
    this.ref = null; // {lat, lon, timestamp} of the last fix that cleared the gate
    this.lastSent = null; // the last fix that actually went out (or needed no radio)
  }

  // Would this fix clear the gate? Does not change anything: call advance() once the fix has been sent or queued.
  cleared(fix, distanceM) {
    if (!this.ref) return true;
    if (distanceMeters(this.ref, fix) >= distanceM) return true;
    return this.intervalMs > 0 && fix.timestamp - this.ref.timestamp >= this.intervalMs;
  }

  advance(fix) {
    this.ref = { lat: fix.lat, lon: fix.lon, timestamp: fix.timestamp };
  }

  // The fix really went out (or there is no radio to send it on).
  sent(fix) {
    this.lastSent = { lat: fix.lat, lon: fix.lon, timestamp: fix.timestamp };
  }

  // A send failed: forget what has not gone out, so the next fix passes again.
  failed() {
    this.ref = this.lastSent;
  }
}

module.exports = { DistanceGate };
