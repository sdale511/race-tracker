// Detects when a boat enters or leaves the "on-grid" pre-start zone: the
// area between the pin and committee marks (the start line itself), within
// a configurable distance of the line (see config.js's
// regattaup.onGridZoneM) - used to tell RegattaUp a boat is queued up for
// the start. Distinct from finishLineWatcher.js's one-shot crossing
// detection - this is a continuous in/out state, reported only on the
// transitions (entering -> 'ongrid', leaving -> 'offgrid'), not on every
// fix.
const METERS_PER_DEG_LAT = 111320;

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

  // Call with every new fix's lat/lon. Returns 'ongrid'/'offgrid' the
  // instant the boat's in/out state actually changes, null otherwise (the
  // common case - a boat sits solidly on the grid or solidly off it far
  // more often than it's actually transitioning).
  check(lat, lon) {
    const inside = this._isInZone(this._toXY(lat, lon));
    if (inside === this.onGrid) return null;
    this.onGrid = inside;
    return inside ? 'ongrid' : 'offgrid';
  }

  // Standard point-to-segment distance, but deliberately NOT clamped to
  // treat "close to an endpoint" as in-zone - "between the committee and
  // pin" is read literally, so a boat off the end of the line (even if
  // within zoneMeters of a mark) doesn't count, only within the segment's
  // own span between the two marks.
  _isInZone(p) {
    const a = this.committee;
    const b = this.pin;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const lenSq = abx * abx + aby * aby;
    if (lenSq === 0) return false; // degenerate: marks on top of each other
    const t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
    if (t < 0 || t > 1) return false;
    const projX = a.x + t * abx;
    const projY = a.y + t * aby;
    const dist = Math.hypot(p.x - projX, p.y - projY);
    return dist <= this.zoneMeters;
  }
}

module.exports = { OnGridWatcher };
