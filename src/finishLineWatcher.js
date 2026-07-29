// Generic finish-line crossing detector: watches a stream of GPS fixes
// (from either real hardware or the simulator - it doesn't know or care
// which) against the committee/finish mark positions published in Redis,
// and reports a lap whenever the boat's path actually crosses the
// committee<->finish segment (the finish gate) heading upwind.
//
// "Upwind" doesn't need a separate windward-mark lookup - by convention,
// sailing upwind through a finish gate always has the committee boat on the
// port (left) side and the finish mark on the starboard (right) side, so
// upwind is always 90 degrees counter-clockwise from the committee->finish
// direction. That only needs the two marks that actually define the gate.
//
// This is deliberately independent of simGps.js's own internal lap
// counting, which uses the simulator's own known north/east course
// coordinates to decide when to end a simulated race - that's the sim's own
// bookkeeping. This module is the one thing responsible for deciding
// whether a crossing should be *reported* (radioed/webhooked) as a lap, and
// it needs to work the same way regardless of what's producing the fixes.
const METERS_PER_DEG_LAT = 111320;

// Flat-earth approximation (same style used elsewhere in this app) - fine
// at the meter-scale distances a finish line spans.
function toXY(originLat, originLon, lat, lon) {
  const y = (lat - originLat) * METERS_PER_DEG_LAT;
  const x = (lon - originLon) * METERS_PER_DEG_LAT * Math.cos((originLat * Math.PI) / 180);
  return { x, y };
}

function cross(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

// Which side of the line through a->b point p falls on (-1, 0, or 1).
function sideOf(a, b, p) {
  return Math.sign(cross(a, b, p));
}

// Standard orientation-based test for whether segment p1->p2 crosses
// segment p3->p4 (not just the infinite lines through them).
function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  return (d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0);
}

class FinishLineWatcher {
  // marks: { committee: {lat, lon}, finish: {lat, lon} }
  constructor(marks) {
    const originLat = marks.committee.lat;
    const originLon = marks.committee.lon;
    this._toXY = (lat, lon) => toXY(originLat, originLon, lat, lon);
    this.committee = this._toXY(marks.committee.lat, marks.committee.lon);
    this.finish = this._toXY(marks.finish.lat, marks.finish.lon);

    // A point on the upwind side of the line, 90 degrees CCW from the
    // committee->finish direction (see module comment) - used purely as a
    // side-of-line reference, not an actual position.
    const v = { x: this.finish.x - this.committee.x, y: this.finish.y - this.committee.y };
    this.upwindRef = { x: this.committee.x - v.y, y: this.committee.y + v.x };

    this.prevPos = null;
    this.lapCount = 0;
  }

  // Call with every new fix's lat/lon, in order. Returns { lap } if this
  // fix completes a lap-counting crossing: through the gate specifically
  // (not just anywhere on the infinite committee-finish line), and only
  // when heading upwind (committee on the left/port side, finish on the
  // right/starboard side, matching the standard convention) - a crossing
  // the other way (or one outside the gate) doesn't count. The very first
  // call never reports a lap (nothing to compare against yet).
  check(lat, lon) {
    const curPos = this._toXY(lat, lon);
    let result = null;
    if (
      this.prevPos &&
      segmentsIntersect(this.prevPos, curPos, this.committee, this.finish) &&
      sideOf(this.committee, this.finish, curPos) === sideOf(this.committee, this.finish, this.upwindRef)
    ) {
      this.lapCount++;
      result = { lap: this.lapCount };
    }
    this.prevPos = curPos;
    return result;
  }
}

module.exports = { FinishLineWatcher };
