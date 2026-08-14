// Detects when a boat is in the "on-grid" pre-start zone: the area between
// the pin and committee marks (the start line itself), within a
// configurable distance of the line (see config.js's regattaup.onGridZoneM),
// and only on the leeward side of it (a genuine pre-start boat sits behind
// the line, never past it - crossing early would be OCS) - used to tell
// RegattaUp a boat is queued up for the start. Distinct from
// finishLineWatcher.js's one-shot crossing detection - 'ongrid' re-fires on
// every fix for as long as the boat stays in the zone (so RegattaUp sees a
// live signal tied to actual incoming position updates, not one stale event
// for however long the boat sits there), while 'offgrid' only fires once,
// on the transition out - there's no reason to keep affirming "still not
// there."
const METERS_PER_DEG_LAT = 111320;

// A boat genuinely sitting at either mark (a real committee boat or pin,
// or a simulated one via simGps.js, which places every start slot exactly
// on the real pin<->committee line by construction) should always count as
// on-grid - but "exactly on the line" from one source (real GPS noise, or
// a different flat-earth projection upstream - simGps.js's own
// offsetToLatLon uses a different origin than this file's toXY below) can
// land a hair past 0 or 1 in _isInZone's projection. This absorbs that
// without meaningfully loosening "between the marks" - one meter of slack
// at either end of a real start line is not the difference between a boat
// that's on the grid and one that isn't.
const ONGRID_EDGE_MARGIN_M = 1;

// A boat finishing upwind on STARBOARD tack near the committee end
// approaches from the southwest, briefly on the geometric "pin side" of
// committee while still south of the line, before crossing just past
// committee - indistinguishable from genuine pre-start queuing by the
// ordinary "between pin and committee, within the zone" check alone. The
// wedge below cuts that approach off directly: assuming the start line was
// laid square to the wind (the standard, and the only wind direction this
// app can derive at all for real racing - there's no live wind sensor
// anywhere in this codebase), the real windwardGreen<->leewardGreen bearing
// IS the wind axis, and a starboard-tack close-hauled boat finishing near
// committee approaches along that axis rotated by the same close-hauled
// angle upwind sailing always uses (see simGps.js's CLOSE_HAULED_DEG - kept
// as a local copy here rather than importing simGps.js, which pulls in the
// whole simulator for a single constant this file would be the only real
// consumer of outside it), plus a fudge factor for how far off that exact
// heading a real approach can scatter (see WEDGE_OUTER_ANGLE_DEG).
//
// The wedge's near edge sits at 0 degrees - straight downwind from
// committee, i.e. exactly perpendicular to the start line - not offset
// from it: anywhere between committee and that whole perpendicular is
// already ambiguous (a boat could be crossing there instead of queuing),
// so there's no reason to carve out a separate, narrower exclusion right
// at committee itself on top of the wedge - one mechanism covers both.
// The mirror-image port-tack case near the pin end doesn't need the
// equivalent treatment, since a boat approaching there is already excluded
// by the ordinary "between pin and committee" bound (see _isInZone) well
// before it'd ever look on-grid.
//
// A WEDGE (angular tolerance from committee), not a fixed-width parallel
// corridor: a real approach isn't a single perfect line - free-tacking
// before the final precision tack, plus HEADING_JITTER_DEG, scatters the
// actual track around the assumed heading, and that scatter is naturally
// bigger in absolute meters the farther the boat is from committee. A
// fixed-width corridor can't win against that: wide enough to cover the
// scatter far from committee ends up swallowing genuine on-the-real-line
// starts close to committee too (a high start slot can land only a few
// meters out, see course.js's getStartFraction - verified empirically:
// even a 5m-wide corridor excluded an actual start position). An angular
// tolerance scales with distance the same way the real scatter does -
// tight (a couple meters) right at committee, wider farther out - which a
// fixed corridor width structurally can't do.
const CLOSE_HAULED_DEG = 40;
// Outer edge of the wedge, measured from straight downwind (0 degrees) -
// the close-hauled angle plus a fudge factor for how far a real approach
// scatters off that exact heading (free-tacking fixes before the boat
// settles onto its final precision-solved tack can sit noticeably further
// off the nominal bearing than instantaneous heading jitter alone would
// suggest, since their position reflects the boat's whole tacking history,
// not just where it's pointed right now). Verified empirically against
// simGps.js's actual finish approaches and start positions - see
// onGridWatcher's own test notes.
const WEDGE_OUTER_ANGLE_DEG = CLOSE_HAULED_DEG + 20;

// Same flat-earth approximation as finishLineWatcher.js - fine at the
// meter-scale distances a start line and its surrounding zone span.
function toXY(originLat, originLon, lat, lon) {
  const y = (lat - originLat) * METERS_PER_DEG_LAT;
  const x = (lon - originLon) * METERS_PER_DEG_LAT * Math.cos((originLat * Math.PI) / 180);
  return { x, y };
}

class OnGridWatcher {
  // marks: { committee, pin, windwardGreen, leewardGreen } (all {lat, lon}).
  // zoneMeters: how far to either side of the line still counts as on-grid.
  constructor(marks, zoneMeters) {
    const originLat = marks.committee.lat;
    const originLon = marks.committee.lon;
    this._toXY = (lat, lon) => toXY(originLat, originLon, lat, lon);
    this.committee = this._toXY(marks.committee.lat, marks.committee.lon);
    this.pin = this._toXY(marks.pin.lat, marks.pin.lon);
    this.zoneMeters = zoneMeters;
    this.onGrid = false;

    // Wind axis: leewardGreen -> windwardGreen, pointing upwind.
    const windward = this._toXY(marks.windwardGreen.lat, marks.windwardGreen.lon);
    const leeward = this._toXY(marks.leewardGreen.lat, marks.leewardGreen.lon);
    const windDx = windward.x - leeward.x;
    const windDy = windward.y - leeward.y;
    const windLen = Math.hypot(windDx, windDy) || 1;
    const windUx = windDx / windLen;
    const windUy = windDy / windLen;
    // Kept on the instance too (not just used locally below) - check()
    // reuses this same wind axis to reject anything on the windward/course
    // side of the line, see its own comment.
    this.windUx = windUx;
    this.windUy = windUy;

    // The wedge's two edges, both as unit vectors from committee: ray0 is
    // straight downwind (perpendicular to the start line, the wedge's near
    // edge - see the module comment on why it goes all the way to this,
    // not some offset short of it), ray60 is the wind axis rotated
    // WEDGE_OUTER_ANGLE_DEG toward whichever side actually leans toward
    // pin (checked via a dot product against the real committee->pin
    // direction, so this comes out right whichever way the course happens
    // to be laid, not assumed from a fixed compass sense).
    this.ray0x = -windUx;
    this.ray0y = -windUy;

    const angleRad = (WEDGE_OUTER_ANGLE_DEG * Math.PI) / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    const rotA = { x: -(windUx * cos - windUy * sin), y: -(windUx * sin + windUy * cos) };
    const rotB = { x: -(windUx * cos + windUy * sin), y: -(-windUx * sin + windUy * cos) };
    const pinDx = this.pin.x - this.committee.x;
    const pinDy = this.pin.y - this.committee.y;
    const ray60 = rotA.x * pinDx + rotA.y * pinDy >= rotB.x * pinDx + rotB.y * pinDy ? rotA : rotB;
    // Precomputed sign reference for _inApproachWedge's own side test -
    // which rotational side of ray0 the wedge (and therefore pin) is on.
    // ray60 itself doesn't need to be kept - only which side of ray0 it's
    // on matters from here.
    this.crossRay60 = this.ray0x * ray60.y - this.ray0y * ray60.x;
    this.cosOuterAngle = cos;
  }

  // Call with every new fix's lat/lon. Returns 'ongrid' every time the boat
  // is currently in the zone (not just on the transition in - a fix that
  // arrives while already on-grid still re-fires it), 'offgrid' once on the
  // transition out, or null if it was outside and still is (nothing to
  // report - repeating "still not there" on every fix would just be noise).
  check(lat, lon) {
    const p = this._toXY(lat, lon);
    // A genuine pre-start boat sits behind (leeward of) the line, never in
    // the course area beyond it - crossing early would be OCS. Projected
    // onto the wind axis, relative to committee: positive means toward
    // windward (the course side), so anything more than
    // ONGRID_EDGE_MARGIN_M past the line on that side is rejected outright,
    // same small tolerance as the "between pin and committee" check gives
    // right at the marks themselves.
    const windwardOfLine = (p.x - this.committee.x) * this.windUx + (p.y - this.committee.y) * this.windUy;
    // See the module comment above for the other exclusion: a boat only
    // counts as on-grid if it's also in the start zone and NOT in the
    // starboard-tack final-approach wedge into committee.
    const inside =
      windwardOfLine <= ONGRID_EDGE_MARGIN_M &&
      this._isInZone(p, this.committee, this.pin, this.zoneMeters) &&
      !this._inApproachWedge(p);
    const wasInside = this.onGrid;
    this.onGrid = inside;
    if (inside) return 'ongrid';
    return wasInside ? 'offgrid' : null;
  }

  // Standard point-to-segment distance, but deliberately NOT clamped to
  // treat "close to an endpoint" as in-zone - "between a and b" is read
  // literally, so a point well off either end of the segment (even if
  // within zoneMeters of a mark) doesn't count, only within the segment's
  // own span, plus ONGRID_EDGE_MARGIN_M of slack right at either end (see
  // its own comment).
  _isInZone(p, a, b, zoneMeters) {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const lenSq = abx * abx + aby * aby;
    if (lenSq === 0) return false; // degenerate: marks on top of each other
    const len = Math.sqrt(lenSq);
    const marginT = ONGRID_EDGE_MARGIN_M / len; // meters -> fraction of the line's length
    const t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
    if (t < -marginT || t > 1 + marginT) return false;
    // Clamped to the segment itself (not the margin-extended range) so the
    // distance check below measures from the nearest point actually on the
    // line/between the marks, not from an extrapolated point past either end.
    const clampedT = Math.min(1, Math.max(0, t));
    const projX = a.x + clampedT * abx;
    const projY = a.y + clampedT * aby;
    const dist = Math.hypot(p.x - projX, p.y - projY);
    return dist <= zoneMeters;
  }

  // Is p in the wedge - within WEDGE_OUTER_ANGLE_DEG of ray0 (straight
  // downwind from committee) AND on the same rotational side as ray60 (the
  // pin side, not mirrored toward finish)? A point exactly at committee has
  // no defined bearing - not excluded by this check (nothing else excludes
  // it either now; see the module comment on why that's an accepted
  // trade-off).
  _inApproachWedge(p) {
    const dx = p.x - this.committee.x;
    const dy = p.y - this.committee.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return false;
    const cosFromRay0 = (dx * this.ray0x + dy * this.ray0y) / len;
    if (cosFromRay0 < this.cosOuterAngle) return false;
    // Exactly on ray0 itself (cross=0) counts as in-wedge too - that's the
    // "perpendicular to the start line" edge, inclusive by design.
    const crossPoint = this.ray0x * dy - this.ray0y * dx;
    return crossPoint === 0 || (crossPoint > 0) === (this.crossRay60 > 0);
  }
}

module.exports = { OnGridWatcher };
