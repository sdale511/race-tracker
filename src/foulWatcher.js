// Detects a boat sailing straight through the start/finish line complex
// instead of going around the course - the same "downwind strip" that
// simGps.js's own ground-truth _inLocalStrip check exists to keep the
// SIMULATOR out of (see its module comment for the original "boat crossed
// the finish line backwards" bug this mirrors) - this module is the
// equivalent detector for REAL (or simulated) boat tracks, reporting a
// 'foul' webhook event instead of just avoiding the behavior in software.
//
// The strip is three segments, matching course.js's two-independent-
// committee-boat model:
//   - pin <-> committeeStart   (the start line)
//   - committeeStart <-> committeeFinish   (the gap between the two
//     committee boats - see course.js's own module comment; with
//     independent committeeStart/committeeFinish marks, a real boat should
//     never pass between them in either direction at all)
//   - committeeFinish <-> finish   (the finish line)
//
// The start and finish segments each have one legitimate direction - the
// same "committee boat on the left, outer mark on the right" upwind
// convention finishLineWatcher.js already uses for counting real laps.
// Crossing either of those two segments the OTHER way (downwind) means the
// boat sailed straight through the line instead of racing around the
// course, and is reported as a foul. The middle segment has no legitimate
// crossing direction at all - either way is a foul.
const { getPinBoundaryFarPoint } = require('./course');

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

// Upwind reference point, 90 degrees counter-clockwise from a->b (see
// finishLineWatcher.js's identical convention) - a fixed point on the
// "upwind" side to compare crossing direction against, not a real position.
function buildSegment(a, b) {
  const v = { x: b.x - a.x, y: b.y - a.y };
  const upwindRef = { x: a.x - v.y, y: a.y + v.x };
  return { a, b, upwindRef };
}

class FoulWatcher {
  // marks: { pin, committeeStart, committeeFinish, finish } - the same
  // marks finishLineWatcher.js/onGridWatcher.js already use, plus an
  // OPTIONAL marks.pinBoundaryEnabled (see course.js's PIN_BOUNDARY_MARK/
  // getPinBoundaryFarPoint - the operator's checkbox, not a mark of its
  // own). When true, this adds a fourth segment covering the effectively
  // indefinite extension beyond pin, downwind-only, same convention as the
  // start/finish segments below. When falsy (the default), this class
  // behaves exactly as it always has, with only the original three
  // segments.
  constructor(marks) {
    const originLat = marks.committeeStart.lat;
    const originLon = marks.committeeStart.lon;
    this._toXY = (lat, lon) => toXY(originLat, originLon, lat, lon);

    const pin = this._toXY(marks.pin.lat, marks.pin.lon);
    const committeeStart = this._toXY(marks.committeeStart.lat, marks.committeeStart.lon);
    const committeeFinish = this._toXY(marks.committeeFinish.lat, marks.committeeFinish.lon);
    const finish = this._toXY(marks.finish.lat, marks.finish.lon);

    // Argument order matters here, and isn't symmetric between the two
    // lines: finishLineWatcher.js's own verified convention is
    // committeeFinish -> finish (committee boat to the WEST, outer mark to
    // the EAST, in course.js's default layout - see its getMarks). The
    // start line's committee boat sits on the OPPOSITE side of its own
    // outer mark by construction (pin is WEST of committeeStart, not east -
    // see getMarks' own comment), so matching the same "legitimate
    // direction is north" handedness needs the arguments in mirrored order:
    // pin -> committeeStart, not committeeStart -> pin - verified against
    // real course.js marks (a south-to-north crossing, the direction an
    // actual start happens, must NOT be reported as a foul).
    this.segments = [
      { reason: 'downwind start line', requireDownwind: true, ...buildSegment(pin, committeeStart) },
      { reason: 'through committee gap', requireDownwind: false, ...buildSegment(committeeStart, committeeFinish) },
      { reason: 'downwind finish line', requireDownwind: true, ...buildSegment(committeeFinish, finish) },
    ];

    // farPoint-then-pin argument order (reversed from how it might look at a
    // glance) - buildSegment's "legitimate side" comes from rotating the
    // a->b vector 90 degrees CCW, and the start line's own
    // buildSegment(pin, committeeStart) above was verified to put north
    // (upwind) on the legitimate side specifically because committeeStart
    // sits EAST of pin (an eastward a->b vector). farPoint sits further
    // OUTWARD than pin - i.e. further west, continuing that same line past
    // it (see getPinBoundaryFarPoint) - so getting the same north-is-
    // legitimate result out of this segment needs an eastward vector too:
    // farPoint (west) -> pin (east), not pin -> farPoint. Verified against
    // course.js's canonical layout, same as the start line's own order was.
    if (marks.pinBoundaryEnabled) {
      const farPointLatLon = getPinBoundaryFarPoint(marks.pin, marks.committeeStart);
      const farPoint = this._toXY(farPointLatLon.lat, farPointLatLon.lon);
      this.segments.push({ reason: 'downwind pin boundary', requireDownwind: true, ...buildSegment(farPoint, pin) });
    }

    this.prevPos = null;
    this.prevTimestamp = null;
    this.foulCount = 0;
  }

  // Call with every new fix's lat/lon/timestamp (ms), in order. Returns
  // { reason, crossingTime } the instant the boat's path (prevPos -> curPos)
  // crosses one of the three segments in a way that counts as a foul - null
  // otherwise, including the very first call ever (nothing to compare
  // against yet). Reports at most one foul per call - if implausibly more
  // than one segment was crossed in the same tick, the first match wins, in
  // start/gap/finish order.
  check(lat, lon, timestamp) {
    const curPos = this._toXY(lat, lon);
    let result = null;

    if (this.prevPos) {
      for (const seg of this.segments) {
        if (!segmentsIntersect(this.prevPos, curPos, seg.a, seg.b)) continue;
        if (seg.requireDownwind) {
          const crossedUpwind = sideOf(seg.a, seg.b, curPos) === sideOf(seg.a, seg.b, seg.upwindRef);
          if (crossedUpwind) continue; // legitimate start/finish - not a foul
        }
        this.foulCount++;
        const d1 = cross(seg.a, seg.b, this.prevPos);
        const d2 = cross(seg.a, seg.b, curPos);
        const t = d1 / (d1 - d2);
        const crossingTime = this.prevTimestamp + t * (timestamp - this.prevTimestamp);
        result = { reason: seg.reason, crossingTime };
        break;
      }
    }

    this.prevPos = curPos;
    this.prevTimestamp = timestamp;
    return result;
  }
}

module.exports = { FoulWatcher };
