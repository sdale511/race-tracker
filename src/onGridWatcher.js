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
// ordinary "between pin and committee, within the zone" check alone.
//
// Cut out with a straight line, not an arc: a right triangle, its
// hypotenuse starting exactly at committee and running HYPOTENUSE_ANGLE_DEG
// below the start line itself (not the wind axis) down into the zone,
// continuing until it reaches the far (leeward) edge of the zone -
// equivalently, the entire bottom-right corner of the on-grid box is cut
// off: the triangle's two legs are the zone's own right edge (straight
// down from committee, length zoneMeters) and its own bottom edge (length
// zoneMeters / tan(HYPOTENUSE_ANGLE_DEG)), with the hypotenuse as the third
// side. A boat only counts as on-grid if it's on the pin side of that
// hypotenuse.
//
// The mirror-image port-tack case near the pin end doesn't need the
// equivalent treatment, since a boat approaching there is already excluded
// by the ordinary "between pin and committee" bound (see _isInZone) well
// before it'd ever look on-grid.
const HYPOTENUSE_ANGLE_DEG = 40;

// Same flat-earth approximation as finishLineWatcher.js - fine at the
// meter-scale distances a start line and its surrounding zone span.
function toXY(originLat, originLon, lat, lon) {
  const y = (lat - originLat) * METERS_PER_DEG_LAT;
  const x = (lon - originLon) * METERS_PER_DEG_LAT * Math.cos((originLat * Math.PI) / 180);
  return { x, y };
}

// Inverse of toXY - local {x,y} meters back to {lat,lon}, same origin
// convention. Only zonePolygon (below) needs this - check() only ever
// converts fixes lat/lon -> local, never the other way.
function toLatLon(originLat, originLon, x, y) {
  return {
    lat: originLat + y / METERS_PER_DEG_LAT,
    lon: originLon + x / (METERS_PER_DEG_LAT * Math.cos((originLat * Math.PI) / 180)),
  };
}

// Shared by the constructor and zonePolygon (below) - the one place this
// geometry actually gets computed, so a drawn zone (see zonePolygon) can
// never drift out of sync with what check() actually detects against.
// marks: { committee, pin, windwardGreen, leewardGreen } (all {lat, lon}).
function computeGeometry(marks) {
  const originLat = marks.committee.lat;
  const originLon = marks.committee.lon;
  const toLocal = (lat, lon) => toXY(originLat, originLon, lat, lon);
  const committee = toLocal(marks.committee.lat, marks.committee.lon);
  const pin = toLocal(marks.pin.lat, marks.pin.lon);

  // Wind axis: leewardGreen -> windwardGreen, pointing upwind.
  const windward = toLocal(marks.windwardGreen.lat, marks.windwardGreen.lon);
  const leeward = toLocal(marks.leewardGreen.lat, marks.leewardGreen.lon);
  const windDx = windward.x - leeward.x;
  const windDy = windward.y - leeward.y;
  const windLen = Math.hypot(windDx, windDy) || 1;
  const windUx = windDx / windLen;
  const windUy = windDy / windLen;

  // The hypotenuse direction: the committee->pin direction (the start
  // line itself), rotated HYPOTENUSE_ANGLE_DEG down into the zone. Both
  // rotations of committee->pin are computed and whichever one actually
  // leans toward leeward (down into the box, using straight-downwind -
  // the negated wind axis - as the reference) is kept, so this comes out
  // right whichever way the course happens to be laid, not assumed from
  // a fixed compass sense.
  const downX = -windUx;
  const downY = -windUy;
  const pinDx = pin.x - committee.x;
  const pinDy = pin.y - committee.y;
  const pinLen = Math.hypot(pinDx, pinDy) || 1;
  const pinUx = pinDx / pinLen;
  const pinUy = pinDy / pinLen;

  const angleRad = (HYPOTENUSE_ANGLE_DEG * Math.PI) / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const rotA = { x: pinUx * cos - pinUy * sin, y: pinUx * sin + pinUy * cos };
  const rotB = { x: pinUx * cos + pinUy * sin, y: -pinUx * sin + pinUy * cos };
  const hyp = rotA.x * downX + rotA.y * downY >= rotB.x * downX + rotB.y * downY ? rotA : rotB;

  // Which side of the hypotenuse counts as "excluded" - the side the box's
  // own bottom-right corner (straight downwind from committee, any
  // positive distance out) falls on, precomputed as a sign so check() only
  // needs a dot/cross per fix, not this whole setup.
  const excludedSideSign = Math.sign(hyp.x * downY - hyp.y * downX);

  return { originLat, originLon, toLocal, committee, pin, windUx, windUy, hypUx: hyp.x, hypUy: hyp.y, sinAngle: sin, excludedSideSign };
}

// The on-grid zone's own boundary as a lat/lon polygon - for drawing it on
// a map (see adminServer.js/roverAdminServer.js), not for detection itself
// (OnGridWatcher.check still does that per-fix). A quadrilateral: pin ->
// committee -> the point where the hypotenuse reaches the zone's far
// (leeward) edge -> the equivalent point straight out from pin -> back to
// pin. Built from the exact same computeGeometry() the detector itself
// uses, so this can never show a different zone than what actually gets
// detected.
function zonePolygon(marks, zoneMeters) {
  const geo = computeGeometry(marks);
  const downX = -geo.windUx;
  const downY = -geo.windUy;
  // Distance along the hypotenuse to travel before its own leeward
  // (downwind) component reaches zoneMeters - the hypotenuse makes
  // HYPOTENUSE_ANGLE_DEG with the (horizontal) start line, so a unit step
  // along it has a leeward component of sin(that angle).
  const hypLengthM = zoneMeters / geo.sinAngle;
  const far = {
    x: geo.committee.x + geo.hypUx * hypLengthM,
    y: geo.committee.y + geo.hypUy * hypLengthM,
  };
  const pinFar = {
    x: geo.pin.x + downX * zoneMeters,
    y: geo.pin.y + downY * zoneMeters,
  };
  return [
    marks.pin,
    marks.committee,
    toLatLon(geo.originLat, geo.originLon, far.x, far.y),
    toLatLon(geo.originLat, geo.originLon, pinFar.x, pinFar.y),
  ];
}

class OnGridWatcher {
  // marks: { committee, pin, windwardGreen, leewardGreen } (all {lat, lon}).
  // zoneMeters: how far behind (leeward of) the line still counts as
  // on-grid - one-sided, not either side: check() rejects anything past
  // the line on the windward/course side outright (see its own comment),
  // so this only ever extends into the pre-start area.
  constructor(marks, zoneMeters) {
    const geo = computeGeometry(marks);
    this._toXY = geo.toLocal;
    this.committee = geo.committee;
    this.pin = geo.pin;
    this.zoneMeters = zoneMeters;
    this.onGrid = false;
    // check() reuses this wind axis to reject anything on the
    // windward/course side of the line, see its own comment.
    this.windUx = geo.windUx;
    this.windUy = geo.windUy;
    this.hypUx = geo.hypUx;
    this.hypUy = geo.hypUy;
    this.excludedSideSign = geo.excludedSideSign;
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
    // starboard-tack triangle cut from committee's corner.
    const inside =
      windwardOfLine <= ONGRID_EDGE_MARGIN_M &&
      this._isInZone(p, this.committee, this.pin, this.zoneMeters) &&
      !this._inCommitteeTriangle(p);
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

  // Is p on the excluded (committee/bottom-right-corner) side of the
  // hypotenuse line through committee? A pure half-plane test - the
  // triangle shape itself falls out of combining this with the zone's own
  // existing bounds (between pin and committee, within zoneMeters), not
  // anything this method needs to bound on its own. A point exactly at
  // committee is on the line itself (cross=0) - excluded, consistent with
  // committee being the triangle's own vertex.
  _inCommitteeTriangle(p) {
    const dx = p.x - this.committee.x;
    const dy = p.y - this.committee.y;
    const crossVal = this.hypUx * dy - this.hypUy * dx;
    const sign = Math.sign(crossVal);
    return sign === 0 || sign === this.excludedSideSign;
  }
}

module.exports = { OnGridWatcher, zonePolygon };
