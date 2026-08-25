// Generic finish-line crossing detector: watches a stream of GPS fixes
// (from either real hardware or the simulator - it doesn't know or care
// which) against the committeeFinish/finish mark positions published in
// Redis, and reports a lap whenever the boat's path actually crosses the
// committeeFinish<->finish segment (the finish gate) heading upwind.
//
// "Upwind" doesn't need a separate windward-mark lookup - by convention,
// sailing upwind through a finish gate always has the committee boat on the
// port (left) side and the finish mark on the starboard (right) side, so
// upwind is always 90 degrees counter-clockwise from the committeeFinish->
// finish direction. That only needs the two marks that actually define the
// gate.
//
// This is deliberately independent of simGps.js's own internal lap
// counting, which uses the simulator's own known north/east course
// coordinates to decide when to end a simulated race - that's the sim's own
// bookkeeping. This module is the one thing responsible for deciding
// whether a crossing should be *reported* (radioed/webhooked) as a lap, and
// it needs to work the same way regardless of what's producing the fixes.
const METERS_PER_DEG_LAT = 111320;

function toXY(originLat, originLon, lat, lon) {
  const y = (lat - originLat) * METERS_PER_DEG_LAT;
  const x = (lon - originLon) * METERS_PER_DEG_LAT * Math.cos((originLat * Math.PI) / 180);
  return { x, y };
}

function cross(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function sideOf(a, b, p) {
  return Math.sign(cross(a, b, p));
}

function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  return (d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0);
}

class FinishLineWatcher {
  // marks: { committeeFinish: {lat, lon}, finish: {lat, lon} }
  constructor(marks) {
    const originLat = marks.committeeFinish.lat;
    const originLon = marks.committeeFinish.lon;
    this._toXY = (lat, lon) => toXY(originLat, originLon, lat, lon);
    this.committeeFinish = this._toXY(marks.committeeFinish.lat, marks.committeeFinish.lon);
    this.finish = this._toXY(marks.finish.lat, marks.finish.lon);
    const v = { x: this.finish.x - this.committeeFinish.x, y: this.finish.y - this.committeeFinish.y };
    // Upwind reference point, 90 degrees counter-clockwise from the
    // committeeFinish->finish direction (see module comment) - used purely as a
    // fixed point on the "upwind" side to compare crossing direction against,
    // not a real position.
    this.upwindRef = { x: this.committeeFinish.x - v.y, y: this.committeeFinish.y + v.x };
    this.prevPos = null;
    this.prevTimestamp = null;
    this.lapCount = 0;
  }

  // Call with every new fix's lat/lon/timestamp (ms). Returns
  // { lap, crossingTime } the instant the boat's path (prevPos -> curPos)
  // actually crosses the finish gate (the committeeFinish<->finish
  // segment), and only when heading upwind (committee on the left, finish
  // mark on the right) - null otherwise, including the very first call ever
  // (prevPos starts null, nothing to compare against yet).
  check(lat, lon, timestamp) {
    const curPos = this._toXY(lat, lon);
    let result = null;
    if (
      this.prevPos &&
      segmentsIntersect(this.prevPos, curPos, this.committeeFinish, this.finish) &&
      sideOf(this.committeeFinish, this.finish, curPos) === sideOf(this.committeeFinish, this.finish, this.upwindRef)
    ) {
      this.lapCount++;
      const d1 = cross(this.committeeFinish, this.finish, this.prevPos);
      const d2 = cross(this.committeeFinish, this.finish, curPos);
      const t = d1 / (d1 - d2);
      const crossingTime = this.prevTimestamp + t * (timestamp - this.prevTimestamp);
      result = { lap: this.lapCount, crossingTime };
    }
    this.prevPos = curPos;
    this.prevTimestamp = timestamp;
    return result;
  }
}

module.exports = { FinishLineWatcher };
