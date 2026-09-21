// Detects whether a boat is currently closing on the finish line while
// sailing upwind - used by boatAgent.js to temporarily tighten its own
// TX_DISTANCE_M transmit gate (to TX_FINISH_DISTANCE_M) once within
// TX_FINISH_APPROACH_ZONE_M of the line, so the base gets much more
// frequent position updates right at the moment that actually decides a
// close finish, instead of whatever coarser TX_DISTANCE_M an operator set
// for the rest of the race.
//
// Reuses FinishLineWatcher's own toXY/cross primitives and "upwind"
// convention (committee boat on the left/port side, finish mark on the
// right/starboard side when actually crossing upwind - see its own module
// comment) rather than a second, potentially-diverging copy of the same
// trig - "approaching upwind" here and "crossed upwind" there should never
// disagree about which side of the line is upwind.
//
// Deliberately NOT segment-clipped: distance here is the perpendicular
// distance to the infinite line through committeeFinish/finish, not the
// nearer of the two endpoints once past one of them. A boat closing from
// slightly outside the gate's own width still deserves tighter reporting
// as it nears the line - this is a transmit-rate heuristic, not a rules-of-
// sailing crossing judgment (that's FinishLineWatcher's job, base-side).
const { toXY, cross } = require('./finishLineWatcher');

class FinishApproachWatcher {
  // marks: { committeeFinish: {lat, lon}, finish: {lat, lon} }
  constructor(marks) {
    const originLat = marks.committeeFinish.lat;
    const originLon = marks.committeeFinish.lon;
    this._toXY = (lat, lon) => toXY(originLat, originLon, lat, lon);
    this.committeeFinish = this._toXY(marks.committeeFinish.lat, marks.committeeFinish.lon);
    this.finish = this._toXY(marks.finish.lat, marks.finish.lon);
    const v = { x: this.finish.x - this.committeeFinish.x, y: this.finish.y - this.committeeFinish.y };
    this.gateLengthM = Math.sqrt(v.x * v.x + v.y * v.y);
    // Same 90-degrees-counter-clockwise convention as FinishLineWatcher's
    // own upwindRef - a fixed point on the upwind side, used only to learn
    // which sign of cross() means "upwind of the line," never compared
    // against directly as a real position.
    const upwindRef = { x: this.committeeFinish.x - v.y, y: this.committeeFinish.y + v.x };
    this.upwindSign = Math.sign(cross(this.committeeFinish, this.finish, upwindRef));
    this.prevAbsDistanceM = null;
  }

  // Call with every new fix's lat/lon. True only while the boat is still
  // downwind of the gate, within approachZoneM of it, AND closing (this
  // fix's distance to the line is less than the last fix's) - a boat
  // sailing away, one that's already finished, or one merely passing
  // nearby on a reach/downwind leg, all return false.
  isApproachingUpwind(lat, lon, approachZoneM) {
    const pos = this._toXY(lat, lon);
    const signedDistanceM = this.gateLengthM > 0 ? cross(this.committeeFinish, this.finish, pos) / this.gateLengthM : 0;
    const isDownwindSide = Math.sign(signedDistanceM) !== this.upwindSign;
    const absDistanceM = Math.abs(signedDistanceM);
    const closing = this.prevAbsDistanceM !== null && absDistanceM < this.prevAbsDistanceM;
    this.prevAbsDistanceM = absDistanceM;
    return isDownwindSide && absDistanceM <= approachZoneM && closing;
  }
}

module.exports = { FinishApproachWatcher };
