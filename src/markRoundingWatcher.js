// Detects when a boat rounds a single course mark (windward or leeward) -
// unlike the finish line, a mark rounding has no second physical mark to
// form a gate out of, so the gate is synthesized: extend the line from the
// *other* mark (leeward, for a windward rounding, and vice versa) straight
// through this mark by markRoundingExtensionM, and treat that stretch - from
// just short of the mark out to the extended point beyond it - as a
// one-shot crossing line, using the exact same segment-intersection test
// finishLineWatcher.js uses for the finish gate.
//
// Unlike the finish gate, this doesn't need a direction/side check: the
// gate segment only exists near/beyond the mark along the course axis (it
// doesn't extend back down toward the other mark for more than
// BACK_MARGIN_M), so a boat can only physically cross it by having actually
// reached the mark - a normal tack while still well short of it never comes
// near it, since the segment isn't there yet at that point along the axis.
// That's also why the gate is colinear with the course axis rather than
// perpendicular to it: a perpendicular gate right at the mark would be
// crossed by any boat passing close abeam on either tack, mark or no mark.
//
// The gate isn't started exactly AT the mark (0m back) - a boat's fixes
// only arrive periodically (2Hz by default in SIMULATE mode, less on real
// hardware), so the specific fix that actually crosses the course axis can
// legitimately land a couple meters short of the mark's own along-axis
// position rather than past it, purely from tick granularity, not because
// the boat didn't round the mark. BACK_MARGIN_M absorbs that without
// meaningfully loosening "at the mark" - a few meters short of a real mark
// is still the boat rounding it, not a boat elsewhere on the beat.
const METERS_PER_DEG_LAT = 111320;
const BACK_MARGIN_M = 10;

// A real rounding isn't always one clean crossing: a boat correcting onto
// its final tack right at the mark, then peeling into the clearing leg
// (see simGps.js's own MARK_CLEARANCE_M), can cross the gate line twice
// within about a second - once on the old tack, once on the new one after
// a genuine mid-rounding tack change, both real crossings of the same
// physical rounding, not two separate ones. Confirmed against an actual
// base station log: two crossings ~1s apart, headings 320 -> 40 -> 90
// (a real tack change followed by the windward clearing heading).
// ROUNDING_DEBOUNCE_MS suppresses any further crossing within this long of
// the last COUNTED one - far longer than that kind of double-crossing
// takes, far shorter than sailing all the way around the course again for
// a genuine next-lap rounding of the same mark (multiple minutes even on a
// short course), so there's no realistic way this coalesces two real,
// separate roundings into one.
const ROUNDING_DEBOUNCE_MS = 30000;

// Same flat-earth approximation as finishLineWatcher.js/onGridWatcher.js -
// fine at the meter-scale distances a mark rounding spans.
function toXY(originLat, originLon, lat, lon) {
  const y = (lat - originLat) * METERS_PER_DEG_LAT;
  const x = (lon - originLon) * METERS_PER_DEG_LAT * Math.cos((originLat * Math.PI) / 180);
  return { x, y };
}

function cross(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
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

class MarkRoundingWatcher {
  // mark: {lat, lon} - the mark being rounded.
  // otherMark: {lat, lon} - the mark that defines the course axis (leeward
  // for a windward rounding, windward for a leeward rounding).
  // extensionMeters: how far past `mark`, continuing along the
  // otherMark->mark axis, the virtual gate extends.
  constructor(mark, otherMark, extensionMeters) {
    const originLat = mark.lat;
    const originLon = mark.lon;
    this._toXY = (lat, lon) => toXY(originLat, originLon, lat, lon);
    this.mark = this._toXY(mark.lat, mark.lon);
    const other = this._toXY(otherMark.lat, otherMark.lon);

    const dx = this.mark.x - other.x;
    const dy = this.mark.y - other.y;
    // Degenerate (mark and otherMark on top of each other) - fall back to
    // an arbitrary direction rather than dividing by zero. Shouldn't
    // happen with real course geometry, but an operator editing marks from
    // the map (see adminServer.js) could momentarily create it.
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;

    this.gateStart = { x: this.mark.x - ux * BACK_MARGIN_M, y: this.mark.y - uy * BACK_MARGIN_M };
    this.gateEnd = { x: this.mark.x + ux * extensionMeters, y: this.mark.y + uy * extensionMeters };

    this.prevPos = null;
    this.prevTimestamp = null;
    this.roundingCount = 0;
    this.lastRoundingTime = null;
  }

  // Call with every new fix's lat/lon/timestamp (ms), in order. Returns
  // { rounding, crossingTime } if this fix completes a rounding - the
  // boat's path crossed the virtual gate beyond the mark, and it's been at
  // least ROUNDING_DEBOUNCE_MS since the last counted one (see its own
  // comment). The very first call never reports a rounding (nothing to
  // compare against yet).
  check(lat, lon, timestamp) {
    const curPos = this._toXY(lat, lon);
    let result = null;
    if (this.prevPos && segmentsIntersect(this.prevPos, curPos, this.gateStart, this.gateEnd)) {
      // Interpolate the actual crossing instant between the two bracketing
      // fixes, same reasoning as finishLineWatcher.js's crossingTime.
      const d1 = cross(this.gateStart, this.gateEnd, this.prevPos);
      const d2 = cross(this.gateStart, this.gateEnd, curPos);
      const t = d1 / (d1 - d2);
      const crossingTime = this.prevTimestamp + t * (timestamp - this.prevTimestamp);
      if (this.lastRoundingTime === null || crossingTime - this.lastRoundingTime >= ROUNDING_DEBOUNCE_MS) {
        this.roundingCount++;
        this.lastRoundingTime = crossingTime;
        result = { rounding: this.roundingCount, crossingTime };
      }
    }
    this.prevPos = curPos;
    this.prevTimestamp = timestamp;
    return result;
  }
}

module.exports = { MarkRoundingWatcher };
