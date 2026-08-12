// Detects when a boat is in the "on-grid" pre-start zone: the area between
// the pin and committee marks (the start line itself), within a
// configurable distance of the line (see config.js's regattaup.onGridZoneM)
// - used to tell RegattaUp a boat is queued up for the start. Distinct from
// finishLineWatcher.js's one-shot crossing detection - 'ongrid' re-fires on
// every fix for as long as the boat stays in the zone (so RegattaUp sees a
// live signal tied to actual incoming position updates, not one stale event
// for however long the boat sits there), while 'offgrid' only fires once,
// on the transition out - there's no reason to keep affirming "still not
// there."
const METERS_PER_DEG_LAT = 111320;

// A boat genuinely sitting at either mark (a real committee boat or pin,
// or a simulated one via getStartPosition in simGps.js, which places every
// start slot exactly on the line by construction) should always count as
// on-grid - but "exactly on the line" from one source (real GPS noise, or
// a different flat-earth projection upstream - simGps.js's own
// offsetToLatLon uses a different origin than this file's toXY below) can
// land a hair past 0 or 1 in _isInZone's projection. This absorbs that
// without meaningfully loosening "between the marks" - one meter of slack
// at either end of a real start line is not the difference between a boat
// that's on the grid and one that isn't.
const ONGRID_EDGE_MARGIN_M = 1;

// Same flat-earth approximation as finishLineWatcher.js - fine at the
// meter-scale distances a start line and its surrounding zone span.
function toXY(originLat, originLon, lat, lon) {
  const y = (lat - originLat) * METERS_PER_DEG_LAT;
  const x = (lon - originLon) * METERS_PER_DEG_LAT * Math.cos((originLat * Math.PI) / 180);
  return { x, y };
}

class OnGridWatcher {
  // marks: { committee: {lat, lon}, pin: {lat, lon} }. zoneMeters: how far
  // to either side of the line still counts as on-grid.
  constructor(marks, zoneMeters) {
    const originLat = marks.committee.lat;
    const originLon = marks.committee.lon;
    this._toXY = (lat, lon) => toXY(originLat, originLon, lat, lon);
    this.committee = this._toXY(marks.committee.lat, marks.committee.lon);
    this.pin = this._toXY(marks.pin.lat, marks.pin.lon);
    this.zoneMeters = zoneMeters;
    this.onGrid = false;
  }

  // Call with every new fix's lat/lon. Returns 'ongrid' every time the boat
  // is currently in the zone (not just on the transition in - a fix that
  // arrives while already on-grid still re-fires it), 'offgrid' once on the
  // transition out, or null if it was outside and still is (nothing to
  // report - repeating "still not there" on every fix would just be noise).
  check(lat, lon) {
    const inside = this._isInZone(this._toXY(lat, lon));
    const wasInside = this.onGrid;
    this.onGrid = inside;
    if (inside) return 'ongrid';
    return wasInside ? 'offgrid' : null;
  }

  // Standard point-to-segment distance, but deliberately NOT clamped to
  // treat "close to an endpoint" as in-zone - "between the committee and
  // pin" is read literally, so a boat well off the end of the line (even
  // if within zoneMeters of a mark) doesn't count, only within the
  // segment's own span between the two marks, plus ONGRID_EDGE_MARGIN_M of
  // slack right at either end (see its own comment).
  _isInZone(p) {
    const a = this.committee;
    const b = this.pin;
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
    return dist <= this.zoneMeters;
  }
}

module.exports = { OnGridWatcher };
