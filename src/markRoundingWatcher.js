// Detects when a boat rounds a single course mark (windward or leeward).
//
// Earlier versions of this file tried to synthesize a "gate" out of one or
// two straight lines through the mark and detect a rounding as a line
// crossing - that approach turned out to be fundamentally the wrong shape
// for the problem. A real rounding's heading sweeps continuously through a
// wide arc (close-hauled on the approach, through roughly perpendicular
// during the clearance leg, to a reaching/running angle on departure -
// confirmed live: about 125 degrees of continuous turn, entirely on ONE
// side of the course axis, not symmetric across it) - a fixed pair of
// lines mirrored across the axis can be positioned to catch that sweep
// for boats turning ONE way around the mark, but a boat that rounds it
// the OTHER way (which tack it happens to approach on determines this,
// not something this file - or the course - controls) sweeps through the
// mirror-image arc instead, on the other side of the axis entirely, and
// never reaches either line.
//
// Instead: track the boat's own cumulative heading change (turning angle,
// sign-agnostic - a clockwise and a counterclockwise rounding both count)
// for as long as it stays within roundingRadiusMeters of the mark. A
// straight-line transit past the mark (e.g. a boat racing the black marks
// sailing through the green mark's own position on its way to/from the
// black one - see course.js's SIM_COURSE_MARKS) barely turns at all while
// passing through that radius - at most one ordinary tack's worth (up to
// ~2x CLOSE_HAULED_DEG, ~80 degrees in simGps.js's own model) - while an
// actual rounding turns much further (~125 degrees) before it ever exits
// the radius again. ROUNDING_MIN_SWEEP_DEG sits between those two figures,
// with real margin on both sides, and being purely a magnitude of turning
// (not which lines got crossed, or from which side) it doesn't care which
// way around the mark the boat actually went.
const METERS_PER_DEG_LAT = 111320;

// How much total heading change, while continuously within
// roundingRadiusMeters of the mark, counts as an actual rounding rather
// than a transit that happened to pass close by (see module comment for
// the ~80deg/~125deg figures this sits between).
const ROUNDING_MIN_SWEEP_DEG = 100;

// Suppresses a second rounding within this long of the last counted one -
// e.g. the boat's track grazing the radius boundary and briefly
// re-entering right after exiting, from real GPS noise or just the
// tick-rate granularity of when "distance > radius" actually gets
// observed. Far longer than a real rounding maneuver takes, far shorter
// than sailing all the way around the course again for a genuine next-lap
// rounding of the same mark.
const ROUNDING_DEBOUNCE_MS = 30000;

// Same flat-earth approximation as finishLineWatcher.js/onGridWatcher.js -
// fine at the meter-scale distances a mark rounding spans.
function toXY(originLat, originLon, lat, lon) {
  const y = (lat - originLat) * METERS_PER_DEG_LAT;
  const x = (lon - originLon) * METERS_PER_DEG_LAT * Math.cos((originLat * Math.PI) / 180);
  return { x, y };
}

// Signed angle (degrees, -180..180) from vector a to vector b - positive
// for a counterclockwise turn, negative for clockwise, by construction of
// atan2(cross, dot). This is what makes accumulating turning angle
// direction-agnostic once summed as absolute values below: a clockwise
// rounding accumulates a series of negative turnDeg values, a
// counterclockwise one a series of positive values, and |turnDeg| treats
// both the same.
function turnAngleDeg(a, b) {
  const cross = a.x * b.y - a.y * b.x;
  const dot = a.x * b.x + a.y * b.y;
  return (Math.atan2(cross, dot) * 180) / Math.PI;
}

class MarkRoundingWatcher {
  // mark: {lat, lon} - the mark being rounded. Used as this watcher's own
  // local origin, purely for measuring distance from it - unlike earlier
  // versions of this file, no axis/otherMark direction is needed at all,
  // since turning angle doesn't care which way the course runs.
  // roundingRadiusMeters: how close to the mark counts as "rounding
  // range" - the boat's cumulative turning angle is only tracked while
  // inside this radius.
  constructor(mark, roundingRadiusMeters) {
    this._toXY = (lat, lon) => toXY(mark.lat, mark.lon, lat, lon);
    this.roundingRadiusMeters = roundingRadiusMeters;

    this.prevPos = null;
    this.prevTimestamp = null;
    this.prevMoveVec = null; // direction of the last movement, for the next turnAngleDeg call
    this.inZone = false;
    this.sweepDeg = 0;
    this.enterTime = null;
    this.roundingCount = 0;
    this.lastRoundingTime = null;
  }

  // Call with every new fix's lat/lon/timestamp (ms), in order. Returns
  // { rounding, crossingTime } once a fix completes a genuine rounding -
  // the boat has just left roundingRadiusMeters of the mark, having
  // accumulated at least ROUNDING_MIN_SWEEP_DEG of turning while it was
  // inside, and it's been at least ROUNDING_DEBOUNCE_MS since the last
  // counted one. The very first call never reports anything (nothing to
  // compare against yet).
  check(lat, lon, timestamp) {
    const curPos = this._toXY(lat, lon);
    let result = null;

    if (this.prevPos) {
      const moveVec = { x: curPos.x - this.prevPos.x, y: curPos.y - this.prevPos.y };
      const distFromMark = Math.hypot(curPos.x, curPos.y);
      const withinRadius = distFromMark <= this.roundingRadiusMeters;

      if (withinRadius) {
        if (!this.inZone) {
          // Just entered - nothing to compare this move against yet, that
          // starts from the NEXT fix onward.
          this.inZone = true;
          this.sweepDeg = 0;
          this.enterTime = timestamp;
        } else if (this.prevMoveVec) {
          this.sweepDeg += Math.abs(turnAngleDeg(this.prevMoveVec, moveVec));
        }
        this.prevMoveVec = moveVec;
      } else if (this.inZone) {
        // Just exited - this is the one moment a rounding can actually be
        // confirmed (or not, if the sweep never got large enough).
        if (this.sweepDeg >= ROUNDING_MIN_SWEEP_DEG) {
          if (this.lastRoundingTime === null || this.enterTime - this.lastRoundingTime >= ROUNDING_DEBOUNCE_MS) {
            this.roundingCount++;
            this.lastRoundingTime = this.enterTime;
            result = { rounding: this.roundingCount, crossingTime: this.enterTime };
          }
        }
        this.inZone = false;
        this.sweepDeg = 0;
        this.prevMoveVec = null;
      }
    }

    this.prevPos = curPos;
    this.prevTimestamp = timestamp;
    return result;
  }
}

module.exports = { MarkRoundingWatcher };
