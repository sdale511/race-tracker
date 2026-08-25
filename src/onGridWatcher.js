// Detects when a boat is in the "on-grid" pre-start zone: the area between
// the pin and committeeStart marks (the start line itself), within a
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
// on the real pin<->committeeStart line by construction) should always
// count as on-grid - but "exactly on the line" from one source (real GPS
// noise, or a different flat-earth projection upstream - simGps.js's own
// offsetToLatLon uses a different origin than this file's toXY below) can
// land a hair past 0 or 1 in _isInZone's projection. This absorbs that
// without meaningfully loosening "between the marks" - one meter of slack
// at either end of a real start line is not the difference between a boat
// that's on the grid and one that isn't.
const ONGRID_EDGE_MARGIN_M = 1;

// A boat finishing upwind on STARBOARD tack near the committeeStart end
// approaches from the southwest, briefly on the geometric "pin side" of
// committeeStart while still south of the line, before crossing just past
// it - indistinguishable from genuine pre-start queuing by the ordinary
// "between pin and committeeStart, within the zone" check alone. This used
// to matter because a single shared committee mark also anchored the finish
// gate; now that start and finish are separate marks (committeeStart vs.
// committeeFinish), a boat actually finishing is nowhere near this zone at
// all - but the geometric exclusion stays anyway, since a boat legitimately
// sailing the course (not finishing, just passing through on this tack) can
// still produce the same false "queued for the start" read near this corner.
//
// Cut out with a straight line, not an arc: a right triangle, its
// hypotenuse starting exactly at committeeStart and running
// HYPOTENUSE_ANGLE_DEG below the start line itself (not the wind axis) down
// into the zone, continuing until it reaches the far (leeward) edge of the
// zone - equivalently, the entire bottom-right corner of the on-grid box is
// cut off: the triangle's two legs are the zone's own right edge (straight
// down from committeeStart, length zoneMeters) and its own bottom edge
// (length zoneMeters / tan(HYPOTENUSE_ANGLE_DEG)), with the hypotenuse as
// the third side. A boat only counts as on-grid if it's on the pin side of
// that hypotenuse.
//
// The mirror-image port-tack case near the pin end doesn't need the
// equivalent treatment, since a boat approaching there is already excluded
// by the ordinary "between pin and committeeStart" bound (see _isInZone)
// well before it'd ever look on-grid.
//
// A steeper angle here (closer to 90, closer to straight downwind) reaches
// its own leeward zoneMeters depth after less along-line travel (see the
// along-line-reach comment below) - a deliberately narrower exclusion, so
// fewer genuinely-queuing boats near committeeStart get caught by it.
const HYPOTENUSE_ANGLE_DEG = 55;

// The hypotenuse's own along-line reach (zoneMeters / tan(HYPOTENUSE_ANGLE_DEG),
// ~11.92m at the 10m default) is a FIXED distance, independent of how long
// the actual pin<->committeeStart line is - real start lines (tens of
// meters) are comfortably longer than that, but a short test course
// (SIM_COURSE_LENGTH_NM well under 1) can have a start line shorter than
// the hypotenuse's own reach, in which case the uncapped half-plane test
// below sweeps past pin's own position before ever reaching the zone's
// leeward edge, excluding the ENTIRE zone - pin end included - not just
// the committeeStart corner it's meant for. Capped here at
// COMMITTEE_TRIANGLE_MAX_FRACTION of the line's own actual length,
// regardless of onGridZoneM/HYPOTENUSE_ANGLE_DEG, so the pin half of the
// line is always guaranteed clear (matching this file's own stated
// assumption above that the pin end never needs this treatment) no matter
// how short the course.
const COMMITTEE_TRIANGLE_MAX_FRACTION = 0.5;

// The exclusion above only exists because a boat finishing (or otherwise
// sailing upwind) near committeeStart could be confused with one queuing -
// now that start and finish are independent marks, that's only actually
// possible when committeeFinish is genuinely close to committeeStart (the
// default, unconfigured case - see course.js's FINISH_OFFSET_NORTH_M/
// FINISH_OFFSET_EAST_M). Once an operator moves committeeFinish far enough
// away, a finishing/upwind-sailing boat's real approach is nowhere near
// this corner at all, and the exclusion becomes pure cost with no
// remaining benefit - most visible at a short SIM_COURSE_LENGTH_NM test
// course, where the exclusion's own onGridZoneM-scaled reach (a fixed
// real-world distance, not scaled down with the course - see
// HYPOTENUSE_ANGLE_DEG's own comment) can end up capped at eating HALF the
// entire line (COMMITTEE_TRIANGLE_MAX_FRACTION) even though nothing is
// actually finishing anywhere nearby. `zoneMeters` itself (not a separate
// constant) sets the bar for "close enough to matter" - the same distance
// already used to decide how close behind the line still counts as
// queued, so a committeeFinish further than SAFE_FINISH_SEPARATION_MULTIPLE
// zone-widths away is unambiguously clear of it.
const SAFE_FINISH_SEPARATION_MULTIPLE = 2;

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
// marks: { committeeStart, committeeFinish, pin, windwardGreen, leewardGreen }
// (all {lat, lon}) - committeeFinish is optional (a caller with only the
// older mark set is treated the same as "not safely separated," keeping
// the exclusion active, same as before that mark existed at all).
function computeGeometry(marks, zoneMeters) {
  const originLat = marks.committeeStart.lat;
  const originLon = marks.committeeStart.lon;
  const toLocal = (lat, lon) => toXY(originLat, originLon, lat, lon);
  const committeeStart = toLocal(marks.committeeStart.lat, marks.committeeStart.lon);
  const pin = toLocal(marks.pin.lat, marks.pin.lon);

  // See SAFE_FINISH_SEPARATION_MULTIPLE's own comment - skip the whole
  // committee-corner exclusion once committeeFinish is far enough away
  // that a boat finishing (or sailing upwind generally) near it couldn't
  // possibly be mistaken for one queuing at committeeStart.
  const committeeFinishSeparationM = marks.committeeFinish
    ? Math.hypot(...Object.values(toLocal(marks.committeeFinish.lat, marks.committeeFinish.lon)))
    : 0;
  const excludeTriangle = committeeFinishSeparationM < zoneMeters * SAFE_FINISH_SEPARATION_MULTIPLE;

  // The start line's own direction (committeeStart -> pin) - NOT the wind
  // axis. A real start line is set by an operator (or GPS-migrated/edited
  // marks), never guaranteed perfectly square to the wind - in one real
  // course, committeeStart sat a few centimeters off pin's own north, an
  // entirely ordinary real-world imprecision. The on-grid zone is defined
  // relative to the LINE itself ("behind the line," "along the line"), so
  // its own geometry (below) is built from this direction, not the wind
  // axis - using the wind axis for it made the zone's effective width
  // balloon (or vanish) the further a boat sat from committeeStart,
  // proportional to however not-quite-square the line happened to be:
  // confirmed live, a boat safely on the line's own pin end read as
  // several meters past it, rejected outright as if it had crossed early.
  const pinDx = pin.x - committeeStart.x;
  const pinDy = pin.y - committeeStart.y;
  const pinLen = Math.hypot(pinDx, pinDy) || 1;
  const pinUx = pinDx / pinLen;
  const pinUy = pinDy / pinLen;

  // Wind axis: leewardGreen -> windwardGreen - used ONLY to pick which of
  // the line's own two perpendiculars actually faces the course side (the
  // line's two marks alone can't say which side that is), never to
  // measure any distance directly - that's crossLine below, not this.
  const windward = toLocal(marks.windwardGreen.lat, marks.windwardGreen.lon);
  const leeward = toLocal(marks.leewardGreen.lat, marks.leewardGreen.lon);
  const windDx = windward.x - leeward.x;
  const windDy = windward.y - leeward.y;
  const windLen = Math.hypot(windDx, windDy) || 1;
  const windUx = windDx / windLen;
  const windUy = windDy / windLen;

  // The line's own perpendicular, oriented toward the course (windward)
  // side - of the two candidates, whichever actually leans toward the
  // wind axis wins, so this comes out right whichever way the course
  // happens to be laid, not assumed from a fixed compass sense. This (not
  // the wind axis itself) is what check() measures "windward of the line"
  // against below.
  const candA = { x: -pinUy, y: pinUx };
  const candB = { x: pinUy, y: -pinUx };
  const crossLine = candA.x * windUx + candA.y * windUy >= candB.x * windUx + candB.y * windUy ? candA : candB;
  const crossLineUx = crossLine.x;
  const crossLineUy = crossLine.y;
  // "down" (leeward, into the pre-start zone) is simply the opposite of
  // the line's own windward-facing perpendicular above - used to orient
  // the hypotenuse (below) and, by zonePolygon, to place the zone's own
  // far corner.
  const downX = -crossLineUx;
  const downY = -crossLineUy;

  // The hypotenuse direction: the committeeStart->pin direction (the start
  // line itself), rotated HYPOTENUSE_ANGLE_DEG down into the zone. Both
  // rotations of committeeStart->pin are computed and whichever one
  // actually leans toward leeward (down into the box, using the line's
  // own leeward perpendicular above as the reference) is kept.
  const angleRad = (HYPOTENUSE_ANGLE_DEG * Math.PI) / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const rotA = { x: pinUx * cos - pinUy * sin, y: pinUx * sin + pinUy * cos };
  const rotB = { x: pinUx * cos + pinUy * sin, y: -pinUx * sin + pinUy * cos };
  const hyp = rotA.x * downX + rotA.y * downY >= rotB.x * downX + rotB.y * downY ? rotA : rotB;

  // Which side of the hypotenuse counts as "excluded" - the side the box's
  // own bottom-right corner (straight downwind from committeeStart, any
  // positive distance out) falls on, precomputed as a sign so check() only
  // needs a dot/cross per fix, not this whole setup.
  const excludedSideSign = Math.sign(hyp.x * downY - hyp.y * downX);

  return {
    originLat,
    originLon,
    toLocal,
    committeeStart,
    pin,
    crossLineUx,
    crossLineUy,
    hypUx: hyp.x,
    hypUy: hyp.y,
    sinAngle: sin,
    excludedSideSign,
    excludeTriangle,
  };
}

// The on-grid zone's own boundary as a lat/lon polygon - for drawing it on
// a map (see adminServer.js/roverAdminServer.js), not for detection itself
// (OnGridWatcher.check still does that per-fix). A quadrilateral: pin ->
// committeeStart -> the point where the hypotenuse reaches the zone's far
// (leeward) edge -> the equivalent point straight out from pin -> back to
// pin. Built from the exact same computeGeometry() the detector itself
// uses, so this can never show a different zone than what actually gets
// detected.
function zonePolygon(marks, zoneMeters) {
  const geo = computeGeometry(marks, zoneMeters);
  const downX = -geo.crossLineUx;
  const downY = -geo.crossLineUy;
  // Distance along the hypotenuse to travel before its own leeward
  // (downwind) component reaches zoneMeters - the hypotenuse makes
  // HYPOTENUSE_ANGLE_DEG with the (horizontal) start line, so a unit step
  // along it has a leeward component of sin(that angle).
  const hypLengthM = zoneMeters / geo.sinAngle;
  const far = {
    x: geo.committeeStart.x + geo.hypUx * hypLengthM,
    y: geo.committeeStart.y + geo.hypUy * hypLengthM,
  };
  const pinFar = {
    x: geo.pin.x + downX * zoneMeters,
    y: geo.pin.y + downY * zoneMeters,
  };
  return [
    marks.pin,
    marks.committeeStart,
    toLatLon(geo.originLat, geo.originLon, far.x, far.y),
    toLatLon(geo.originLat, geo.originLon, pinFar.x, pinFar.y),
  ];
}

class OnGridWatcher {
  // marks: { committeeStart, pin, windwardGreen, leewardGreen } (all {lat, lon}).
  // zoneMeters: how far behind (leeward of) the line still counts as
  // on-grid - one-sided, not either side: check() rejects anything past
  // the line on the windward/course side outright (see its own comment),
  // so this only ever extends into the pre-start area.
  constructor(marks, zoneMeters) {
    const geo = computeGeometry(marks, zoneMeters);
    this._toXY = geo.toLocal;
    this.committeeStart = geo.committeeStart;
    this.pin = geo.pin;
    this.zoneMeters = zoneMeters;
    this.onGrid = false;
    // check() reuses this - the line's own perpendicular, not the wind
    // axis (see computeGeometry's own comment) - to reject anything past
    // the line on the windward/course side outright, see check() itself.
    this.crossLineUx = geo.crossLineUx;
    this.crossLineUy = geo.crossLineUy;
    this.hypUx = geo.hypUx;
    this.hypUy = geo.hypUy;
    this.excludedSideSign = geo.excludedSideSign;
    // See SAFE_FINISH_SEPARATION_MULTIPLE's own comment - skips
    // _inCommitteeTriangle entirely once committeeFinish is far enough from
    // committeeStart that the ambiguity it guards against can't happen.
    this.excludeTriangle = geo.excludeTriangle;
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
    // onto the LINE's own perpendicular (not the wind axis - see
    // computeGeometry's own comment on why), relative to committeeStart:
    // positive means toward windward (the course side), so anything more
    // than ONGRID_EDGE_MARGIN_M past the line on that side is rejected
    // outright, same small tolerance as the "between pin and
    // committeeStart" check gives right at the marks themselves.
    const windwardOfLine =
      (p.x - this.committeeStart.x) * this.crossLineUx + (p.y - this.committeeStart.y) * this.crossLineUy;
    // See the module comment above for the other exclusion: a boat only
    // counts as on-grid if it's also in the start zone and NOT in the
    // starboard-tack triangle cut from committeeStart's corner.
    const inside =
      windwardOfLine <= ONGRID_EDGE_MARGIN_M &&
      this._isInZone(p, this.committeeStart, this.pin, this.zoneMeters) &&
      (!this.excludeTriangle || !this._inCommitteeTriangle(p));
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

  // Is p on the excluded (committeeStart/bottom-right-corner) side of the
  // hypotenuse line through committeeStart? A pure half-plane test - the
  // triangle shape itself falls out of combining this with the zone's own
  // existing bounds (between pin and committeeStart, within zoneMeters),
  // not anything this method needs to bound on its own. A point exactly at
  // committeeStart is on the line itself (cross=0) - excluded, consistent
  // with committeeStart being the triangle's own vertex. Also capped at
  // COMMITTEE_TRIANGLE_MAX_FRACTION of the line's own length (see that
  // constant's own comment) - the half-plane test alone has no notion of
  // the line's actual finite length, so without this a short enough course
  // would have the hypotenuse exclude the pin end too, not just
  // committeeStart's own corner.
  _inCommitteeTriangle(p) {
    const dx = p.x - this.committeeStart.x;
    const dy = p.y - this.committeeStart.y;
    const crossVal = this.hypUx * dy - this.hypUy * dx;
    const sign = Math.sign(crossVal);
    if (sign !== 0 && sign !== this.excludedSideSign) return false;
    const pinDx = this.pin.x - this.committeeStart.x;
    const pinDy = this.pin.y - this.committeeStart.y;
    const pinLenSq = pinDx * pinDx + pinDy * pinDy;
    if (pinLenSq === 0) return true; // degenerate: marks on top of each other
    const t = (dx * pinDx + dy * pinDy) / pinLenSq; // 0=committeeStart, 1=pin
    return t <= COMMITTEE_TRIANGLE_MAX_FRACTION;
  }
}

module.exports = { OnGridWatcher, zonePolygon };
