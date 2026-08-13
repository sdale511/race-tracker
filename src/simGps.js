const { EventEmitter } = require('events');
const { WIND_FROM_DEG, offsetToLatLon, getStartFraction } = require('./course');

const METERS_PER_DEG_LAT = 111320;

// Fraction (0=a, 1=b) of point p's projection onto segment a->b - all three
// as {north, east} in this file's own local (course-relative, rotated)
// frame. Used to test whether a local point falls between two other local
// points (the start/finish line's own marks) - same idea as
// onGridWatcher.js's zone check, just in local coordinates instead of real
// lat/lon.
function projectFraction(a, b, p) {
  const abNorth = b.north - a.north;
  const abEast = b.east - a.east;
  const lenSq = abNorth * abNorth + abEast * abEast;
  if (lenSq === 0) return 0; // degenerate: a and b on top of each other
  const apNorth = p.north - a.north;
  const apEast = p.east - a.east;
  return (apNorth * abNorth + apEast * abEast) / lenSq;
}

// Course geometry (courseLengthM, courseBearingDeg, boatStartSpacingM - see
// the constructor) is passed in, derived by the caller from the actual
// marks (course.js's deriveGeometry), not imported as fixed module
// constants here - this process's own SIM_COURSE_LENGTH_NM might not agree
// with whatever course was actually published to Redis (published earlier,
// by a different process, possibly at a different length), and every
// tacking/rounding/gate decision below needs to follow whatever the marks
// actually say, not this process's own environment. pin/committee/finish's
// own true positions (see the constructor) are measured the same way, for
// the same reason.
//
// Upwind crossings of the start/finish line must pass through the finish
// gate (committee <-> finish, on the east side of the rhumb line - see
// course.js) to count a lap. Aiming for the gate's center is what makes
// that achievable.
//
// Downwind crossings can go anywhere EXCEPT through the start side (pin <->
// committee) or finish side (committee <-> finish) - those two occupy the
// whole strip from pin to finish with no gap between them, so "anywhere
// else" means crossing outside that strip entirely. There's no requirement
// to be near either mark - the target (see _targetWaypoint()) is picked
// dynamically off whichever side of the strip the boat's current position
// already sits on, so the boat clears past the nearest edge of the strip
// rather than converging toward a fixed point next to a mark.
// DOWNWIND_CLEAR_MARGIN_M pushes that target just past the strip's edge so
// the crossing is a clean pass rather than a graze - no more margin than
// that is needed, since the only actual requirement is not sailing through
// the strip.
const DOWNWIND_CLEAR_MARGIN_M = 15;

// Once the boat reaches a mark's latitude (ordinary north/leeward
// threshold, no special overshoot needed), it heads due east or west - a
// short, perfectly horizontal leg at that exact latitude - until it's
// passed the mark's longitude by this much, then turns into the next
// phase's departure. Simpler and more reliable than trying to solve an
// angled approach that lands precisely on the correct side: this can't
// miss, since "clear of it" is just "traveled far enough in a straight
// line," not a target that depends on the boat's angle or approach
// history. Windward clears heading east (mark ends up on the right/
// starboard side while northbound); leeward clears heading west (same
// result while southbound, since starboard is on the opposite compass side
// when heading the opposite direction).
const MARK_CLEARANCE_M = 5;

// Once the final lap's finish-line crossing is detected, the boat keeps
// sailing straight on its current tack/heading for this much farther
// before the simulation actually stops - a real boat eases across the
// line and keeps some way on rather than stopping dead exactly at it.
const FINISH_COAST_M = 20;

// Fake GPS source for hardware-free testing: emits synthetic fixes in the
// same shape UbxParser emits from real hardware (see ubxParser.js
// _decodePvt), so boatAgent doesn't need to know the difference.
//
// Simulates a boat sailing a windward-leeward course (geometry shared with
// baseStation.js via course.js): beating upwind to the windward mark on
// alternating tacks, then running downwind back to the leeward mark on
// alternating gybes, repeating indefinitely. The boat always sails at its
// full close-hauled/run angle off the wind - real boats can't point higher
// than close-hauled or reduce a run's angle arbitrarily, so precision comes
// entirely from *which tack* and *how long on it*, never from softening the
// angle. Once close to a target (the finish gate, the downwind clearance
// point, or a mark's latitude), an exact two-tack solve (still always at the
// full fixed angle) picks tack lengths that land on it - and degenerates to
// a single final tack exactly when the boat has crossed its layline, same
// as a real boat "laying the mark"; until then it free-tacks, always
// favoring whichever side reduces its current cross-track error. Rounding a
// mark itself is simpler still - once north reaches the mark's latitude, a
// short explicit east/west leg clears it (see MARK_CLEARANCE_M). Leg
// lengths (and how many tacks/gybes a beat/run gets) are randomized, so no
// two laps trace the same path.

const CLOSE_HAULED_DEG = 40; // typical modern-raceboat beating angle off the wind
const RUN_DEG = 15; // angle off dead downwind while gybing down
// Wider angle off dead downwind used only to clear the start/finish strip
// (see _tick()'s downwind crossing check) - a real "head up" maneuver for
// more lateral speed while still making some forward progress, not a
// frozen pure-reach. Bears away back to RUN_DEG the moment it's clear.
const DOWNWIND_CLEAR_HEAD_UP_DEG = 60;
const HEADING_JITTER_DEG = 4; // +/- per free-tack heading variation, so tacks/gybes aren't identical
const LEG_JITTER_FRAC = 0.3; // +/-30% around the target leg length

// Legs aren't length-randomized directly - each beat/run is given a target
// tack/gybe count, and the leg length is derived from that so the leg
// actually ends up with roughly that many maneuvers rather than however many
// a fixed meter range happens to produce.
const UPWIND_MIN_TACKS = 3;
const UPWIND_MAX_TACKS = 4;
const DOWNWIND_MIN_GYBES = 2;
const DOWNWIND_MAX_GYBES = 3;

// Real boats stall coming out of a tack/gybe rather than instantly holding
// full speed - ramp back up over a few seconds instead of snapping to speed.
const MANEUVER_RECOVERY_S = 4;
const MANEUVER_MIN_SPEED_FRAC = 0.45;

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

// Linear interpolation for the east position at the exact moment north
// crossed targetNorth, given the positions before and after the tick that
// crossed it - a single tick's travel distance can exceed the width of the
// start/finish line itself at a short SIM_COURSE_LENGTH_NM, so checking the
// post-tick position directly isn't precise enough to reliably tell whether
// a crossing landed inside the gate/strip.
function interpolateEastAt(prevNorth, prevEast, curNorth, curEast, targetNorth) {
  const frac = (targetNorth - prevNorth) / (curNorth - prevNorth);
  return prevEast + frac * (curEast - prevEast);
}

class SimGpsSource extends EventEmitter {
  // geometry: { courseLengthM, courseBearingDeg, boatStartSpacingM } - see
  // course.js's deriveGeometry. Measured from the actual marks by the
  // caller, not assumed from this process's own SIM_COURSE_LENGTH_NM (see
  // module comment above).
  //
  // pin/committee/finish: the REAL lat/lon of the start/finish complex.
  // windward/leeward always sit exactly on this file's own local north
  // axis, by definition of how courseBearingDeg is derived (the leeward
  // -> windward bearing) - but pin/committee/finish are NOT guaranteed to,
  // since an operator can drag any mark independently of any other (see
  // adminServer.js's "edit marks" column). Their true position in this
  // local frame has to be measured (see _toLocal below), not assumed to
  // sit at some fixed offset perpendicular to the beat axis - otherwise an
  // edited windward mark rotates the beat axis right out from under a
  // *stationary* real finish line, and the boat stops crossing it
  // entirely (the bug this whole approach exists to avoid).
  constructor({ centerLat, centerLon, upwindSpeedKn, downwindSpeedKn, hz, startSlot, lapCount, geometry, startOnly, pin, committee, finish }) {
    super();
    this.centerLat = centerLat;
    this.centerLon = centerLon;
    // See _tick() - when true, every other field this constructor sets up
    // (phase, side, leg targets, lap counting, ...) is simply never read.
    this.startOnly = !!startOnly;
    this.courseLengthM = geometry.courseLengthM;
    // Everything below (phase/tacking/leg targets/gate checks) works
    // entirely in this local, course-relative frame - "north" always means
    // "toward windwardGreen," matching WIND_FROM_DEG=0's own assumption, so
    // none of that logic needs to know or care which way the course
    // actually points in the real world. Only _toLatLon() (see below)
    // needs the real bearing, to rotate this local frame into a true
    // north/east offset right before it becomes an actual lat/lon fix.
    this.courseBearingDeg = geometry.courseBearingDeg;

    // pin/committee/finish's TRUE position in this same local frame -
    // their real offset from leewardGreen, rotated by -courseBearingDeg
    // (the inverse of _toLatLon's own rotation). At courseBearingDeg=0
    // (unedited layout) this reduces to exactly the old assumed values
    // (committee at local (startLineNorthM, 0), etc.) - it's a
    // generalization, not a behavior change, for the common case.
    this.pinLocal = this._toLocal(pin.lat, pin.lon);
    this.committeeLocal = this._toLocal(committee.lat, committee.lon);
    this.finishLocal = this._toLocal(finish.lat, finish.lon);
    // The gate's actual center - what the boat steers toward on its final
    // upwind approach (see _targetWaypoint()), replacing the old assumed
    // "(startLineNorthM, finishSideLengthM/2)" point.
    this.gateCenterLocal = {
      north: (this.committeeLocal.north + this.finishLocal.north) / 2,
      east: (this.committeeLocal.east + this.finishLocal.east) / 2,
    };

    // Each boat has its own fixed "speed personality" (+/-10%, drawn once,
    // not per-tick) applied to both upwind and downwind speed, so a fleet
    // of simulated boats doesn't all finish in lockstep.
    const speedFactor = randRange(0.9, 1.1);
    this.upwindSpeedMS = upwindSpeedKn * 0.514444 * speedFactor; // knots -> m/s
    this.downwindSpeedMS = downwindSpeedKn * 0.514444 * speedFactor;
    this.intervalMs = 1000 / hz;

    // Position relative to the leeward mark, which sits at the configured
    // center point (SIM_CENTER_LAT/LON). Boats start spread out along the
    // start/finish line (see course.js), not at a mark - startOnly keeps
    // this same per-slot spread (still useful to see multiple simulated
    // boats sitting at their own distinct positions along the line, e.g.
    // testing a fleet start) rather than collapsing every boat onto the
    // same point. `startSlot` is a 0-based registration-order slot (see
    // redisStore.getOrAssignStartSlot), not the boat's own ID/sail number.
    //
    // Interpolated against the TRUE local pin/committee positions (not a
    // simple east offset - see course.js's getStartFraction), so every
    // slot lands exactly on the real pin<->committee line regardless of
    // whether that line happens to be perpendicular to the beat axis.
    const startFrac = getStartFraction(startSlot, geometry);
    this.north = this.pinLocal.north + startFrac * (this.committeeLocal.north - this.pinLocal.north);
    this.east = this.pinLocal.east + startFrac * (this.committeeLocal.east - this.pinLocal.east);
    this.phase = 'upwind'; // 'upwind' (beating) | 'downwind' (running)
    this.side = Math.random() < 0.5 ? 1 : -1;
    this.timeSinceManeuverS = 999;
    this.clearingHeadingDeg = null; // set mid-mark-rounding (due east/west) or mid-line-clear (headed up), see _tick()
    this.clearingDirection = null; // +1 (clearing east) or -1 (clearing west) - which way clearingTargetEastM is being approached from
    this.clearingIsLineCross = false; // true when clearingHeadingDeg is clearing the start/finish strip, not a mark

    // A lap completes when the boat crosses the start/finish line heading
    // upwind, through the finish gate (see _tick()). Once lapCount laps are
    // done, the simulation stops. `crossedLineThisLeg` starts true because
    // the boat starts sitting right on the line already (on the start side)
    // - its initial departure isn't a "crossing" to detect or count, and it
    // heads straight for the windward mark like any other post-crossing leg.
    this.lapsCompleted = 0;
    this.lapTarget = lapCount;
    this.crossedLineThisLeg = true;
    this.finishCoastRemainingM = null; // set once the final lap's crossing is detected, see _tick()

    // Leg/target setup is irrelevant in startOnly mode - _tick() below
    // never reads any of it, so skip it entirely rather than run setup for
    // state that'll never be used.
    if (!this.startOnly) {
      this._setLegTarget();
      this._startNewLeg();
    }
    this._timer = setInterval(() => this._tick(), this.intervalMs);
  }

  stop() {
    clearInterval(this._timer);
  }

  // The (north, east) point the boat is currently steering toward: the
  // start/finish line's latitude while still approaching it this leg -
  // through the finish gate's center if upwind (required to count a lap) -
  // or the mark being rounded (dead on the rhumb line, east=0) after that.
  //
  // Downwind before crossing the line has no gate requirement and no reason
  // to be near either mark, so this just gives the rhumb line as a plain
  // free-tacking bias (see needsPrecisionTarget in _startNewLeg() - no
  // convergence is applied toward it downwind). The only thing that
  // actually guards against sailing through the forbidden strip is the
  // line-clear leg in _tick(), triggered only if a crossing would otherwise
  // land inside it.
  _targetWaypoint() {
    if (!this.crossedLineThisLeg) {
      // Upwind aims at the gate's TRUE center (both north and east - see
      // gateCenterLocal); downwind keeps the old plain rhumb-line bias
      // (east=0), just measured against committeeLocal's own true north
      // instead of an assumed scalar.
      return this.phase === 'upwind'
        ? { targetNorth: this.gateCenterLocal.north, targetEastM: this.gateCenterLocal.east }
        : { targetNorth: this.committeeLocal.north, targetEastM: 0 };
    }
    return { targetNorth: this.phase === 'upwind' ? this.courseLengthM : 0, targetEastM: 0 };
  }

  // Sets up a leg on a specific tack/gybe, always at the FULL close-hauled/
  // run angle for the phase (never softened) - `jitterDeg` adds a small
  // per-tack heading wobble for visual variety on free legs, and is 0 for
  // the exact-solve precision legs, where it would throw off the math.
  _setLeg(side, lengthM, jitterDeg = 0) {
    this.side = side;
    this.headingJitterDeg = jitterDeg;
    this.legRemainingM = Math.max(1, lengthM);
    this.timeSinceManeuverS = 0;
  }

  // Starts the next tack/gybe. The boat always sails at the full
  // close-hauled/run angle (see module comment) - real boats can't point
  // higher or reduce a run's angle just because less correction is needed,
  // so precision comes entirely from picking the right tack and sailing it
  // the right distance. Precision targeting (the two-tack solve below) only
  // applies to the start/finish line approach (the finish gate, or
  // downwind's clear-of-the-strip target) - a mark just needs ordinary free
  // tacking to reach its latitude, since _tick() handles precisely clearing
  // it with an explicit east/west leg once north gets there (see
  // MARK_CLEARANCE_M above).
  //
  // The departure leg right after rounding a mark (`justRoundedMark`) is
  // forced to side=-1 - part of always rounding marks to starboard (the
  // mark stays on the boat's right side through the turn, the standard
  // racing convention) - verified by working out the actual turn geometry:
  // side=-1 gives the shortest, most natural rotation off the clearing
  // leg's heading, vs. 200+ degrees the other way.
  _startNewLeg() {
    const maxAngleDeg = this.phase === 'upwind' ? CLOSE_HAULED_DEG : RUN_DEG;

    if (this.justRoundedMark) {
      this.justRoundedMark = false;
      // Deliberately shorter than a normal tack (not targetLegM's full
      // range): this leg is forced (starboard rounding) and thus entirely
      // uncorrected, so its own swing is pure drift the rest of the
      // beat/run then has to recover from. A full-length departure could
      // drift 400-500m on its own, occasionally leaving too little of the
      // beat/run remaining for even a fully-correcting tack to recover
      // before the next crossing/rounding, since that tack can get cut
      // short if it reaches the threshold before finishing.
      const lengthM = randRange(this.targetLegM * 0.35, this.targetLegM * 0.6);
      this._setLeg(-1, lengthM, randRange(-HEADING_JITTER_DEG, HEADING_JITTER_DEG));
      return;
    }

    const { targetNorth, targetEastM } = this._targetWaypoint();
    const dNorth = Math.abs(targetNorth - this.north);
    const dEast = targetEastM - this.east;
    const maxAngleRad = (maxAngleDeg * Math.PI) / 180;
    // A positive lean angle off the base heading increases east when the
    // base is 0 (upwind) but *decreases* it when the base is 180 (downwind)
    // - sin(180+x) = -sin(x) - so correcting for this once here means every
    // formula below can treat "positive corrected dEast -> prefer side +1"
    // uniformly regardless of phase.
    const signCorrection = this.phase === 'upwind' ? 1 : -1;
    const dEastCorrected = signCorrection * dEast;
    const northPerM = Math.cos(maxAngleRad);

    // Precision targeting only applies to the upwind gate (must land within
    // a specific spot at the exact instant north crosses the line) and to a
    // mark (looser - the explicit clearing leg in _tick() mops up whatever
    // small residual is left, see MARK_CLEARANCE_M). Downwind, before
    // crossing the line, there's nothing to converge toward - no gate
    // requirement and no reason to be near either mark - so it free-tacks
    // the same as any other leg, and _tick()'s crossing check is what
    // actually guards against ending up in the forbidden strip (see the
    // line-clear leg there), not this targeting.
    const needsPrecisionTarget = this.crossedLineThisLeg || this.phase === 'upwind';

    // Once close enough, use an exact two-tack solve: side+1 for Lplus,
    // side-1 for Lminus, sailed one after the other, lands exactly on the
    // target (verified: for fixed angle theta, (Lplus+Lminus)*cos(theta)
    // covers dNorth and (Lplus-Lminus)*sin(theta) covers dEastCorrected).
    // Recomputed fresh every call, so after sailing whichever tack goes
    // first, the next call naturally finds ~0 remaining on that tack and
    // the rest on the other. This is also exactly what "reaching the
    // layline" means for a mark: the degenerate case below (Lminus close to
    // 0) is precisely the moment a single tack at the FULL fixed angle,
    // sailed the rest of the way, lands on the target - the same thing a
    // real sailor means by "laying the mark" - so no separate layline
    // detection is needed, this solve already produces it.
    const closeEnough = needsPrecisionTarget && dNorth <= this.targetLegM * 2.5 * northPerM;
    if (closeEnough) {
      const S = dNorth / northPerM;
      const Diff = dEastCorrected / Math.sin(maxAngleRad);
      const Lplus = (S + Diff) / 2;
      const Lminus = (S - Diff) / 2;
      // A tack this short isn't worth a separate leg of its own - below
      // this, skip straight to sailing the other (longer) tack in full,
      // rather than a near-instant leg that would immediately re-trigger
      // another _startNewLeg() call. Scaled to the course (not a fixed
      // distance) for the same reason course.js scales the start/finish
      // line's own width - a fixed value stops being "negligible" once the
      // whole course shrinks enough - but capped at 2m absolute regardless
      // of course length: the tacking angle is exactly known, so anything
      // above a couple meters is a real, visible correction actually worth
      // sailing, not noise to approximate away. This used to be 5% of
      // targetLegM (4-5m on a typical course) - large enough to regularly
      // discard a real tack's worth of lateral correction, which is
      // exactly why the finish gate crossing was landing meters off instead
      // of exactly on target.
      const NEAR_ZERO_M = Math.min(this.targetLegM * 0.01, 2);

      if (Lplus >= -NEAR_ZERO_M && Lminus >= -NEAR_ZERO_M) {
        if (Lminus <= NEAR_ZERO_M) {
          this._setLeg(1, Math.max(Lplus, 1));
        } else if (Lplus <= NEAR_ZERO_M) {
          this._setLeg(-1, Math.max(Lminus, 1));
        } else {
          this._setLeg(-1, Lminus);
        }
        return;
      }

      // Close enough to be trying to converge, but the needed correction
      // still exceeds what's reachable in a clean two-tack solve at this
      // angle - always take the correcting side at full angle, so this
      // makes real progress across possibly several legs. Monotonic (never
      // picks the "wrong" side for variety), so this reliably shrinks the
      // error leg over leg until the exact solve above becomes reachable.
      const correctingSide = dEastCorrected >= 0 ? 1 : -1;
      // Already guaranteed positive and proportional to targetLegM (which
      // itself scales with the course length) - no separate floor needed;
      // a fixed one (e.g. 50m) would force tacks longer than intended once
      // targetLegM itself gets small (a short SIM_COURSE_LENGTH_NM course).
      const lengthM = randRange(this.targetLegM * (1 - LEG_JITTER_FRAC), this.targetLegM * (1 + LEG_JITTER_FRAC));
      // Capped below the distance that would actually reach the target's
      // own north coordinate (0.8x, leaving room to still be shrinking on
      // the next call rather than re-triggering this same degenerate
      // branch immediately) - otherwise this leg can sail straight through
      // the crossing threshold before finishing, locking in whatever
      // partly-corrected east it happened to be at instead of the several
      // legs of refinement this branch is meant to produce (the "possibly
      // several legs" above only actually happens if a leg stops short of
      // the line - one that overshoots past it ends the approach on the
      // spot, cutting off every leg after the first).
      const maxLengthM = Math.max((dNorth / northPerM) * 0.8, 1);
      this._setLeg(correctingSide, Math.min(lengthM, maxLengthM));
      return;
    }

    // Free tacking: always take the side that currently reduces cross-track
    // error - not an arbitrary 50/50 alternation. A leg at full
    // close-hauled/run angle can swing the boat several hundred meters
    // sideways on its own (that's just the geometry), and with only 3-4
    // tacks total per beat/run there isn't room to recover several of those
    // going the "wrong" way in a row, which an alternation (even a biased
    // one) risks. This still produces a natural zigzag, not a straight
    // line: once a tack overshoots past the target's east value, the
    // correcting side flips on its own on the next leg. Once close enough
    // to the target, the branches above take over for the final tack(s).
    let side = dEastCorrected >= 0 ? 1 : -1;

    // Downwind, before crossing the line: check *before* committing to this
    // tack whether sailing it all the way to the start line's latitude
    // would carry the boat through the forbidden strip, and take the other
    // tack instead if so - the course correction needs to happen here,
    // while still on the windward side of the line with room to change
    // course, not reactively after already crossing into it (the crossing
    // check in _tick() still exists as a last-resort safety net, but
    // shouldn't normally need to fire once this is in place).
    if (this.phase === 'downwind' && !this.crossedLineThisLeg) {
      const projected = this._projectedCrossingEast(side);
      const wouldViolate = this._inLocalStrip(this.committeeLocal.north, projected);
      if (wouldViolate) {
        const otherProjected = this._projectedCrossingEast(-side);
        const otherViolates = this._inLocalStrip(this.committeeLocal.north, otherProjected);
        if (!otherViolates) side = -side;
        // If both tacks project into the strip (only possible very close
        // to the line with little room left to redirect), leave side as
        // chosen above - the reactive check in _tick() is the fallback.
      }
    }

    // See the comment on the equivalent line above - already positive and
    // proportional to targetLegM, no separate fixed floor needed.
    const legM = randRange(this.targetLegM * (1 - LEG_JITTER_FRAC), this.targetLegM * (1 + LEG_JITTER_FRAC));
    this._setLeg(side, legM, randRange(-HEADING_JITTER_DEG, HEADING_JITTER_DEG));
  }

  // Where the boat would cross the start/finish line's latitude if it kept
  // sailing the given side/tack (at the phase's full fixed angle, no
  // heading jitter) all the way there from its current position - used to
  // decide, before actually committing to a tack, whether it needs to be
  // avoided because it would carry the boat through the forbidden strip
  // (see the downwind pre-crossing check in _startNewLeg()).
  _projectedCrossingEast(side) {
    const maxAngleDeg = this.phase === 'upwind' ? CLOSE_HAULED_DEG : RUN_DEG;
    const baseDeg = this.phase === 'upwind' ? WIND_FROM_DEG : (WIND_FROM_DEG + 180) % 360;
    const headingRad = (((baseDeg + side * maxAngleDeg) % 360) * Math.PI) / 180;
    const dNorth = this.committeeLocal.north - this.north;
    const distance = dNorth / Math.cos(headingRad);
    return this.east + distance * Math.sin(headingRad);
  }

  // Called once per beat/run, right as a mark is rounded (and once up front
  // for the very first beat), to pick how many tacks/gybes it should have -
  // normally 3-4 upwind, 2-3 downwind - and derive a target leg length from
  // that.
  _setLegTarget() {
    const angleDeg = this.phase === 'upwind' ? CLOSE_HAULED_DEG : RUN_DEG;
    const legDistM = this.courseLengthM / Math.cos((angleDeg * Math.PI) / 180);
    const [minCount, maxCount] =
      this.phase === 'upwind' ? [UPWIND_MIN_TACKS, UPWIND_MAX_TACKS] : [DOWNWIND_MIN_GYBES, DOWNWIND_MAX_GYBES];

    // A short SIM_COURSE_LENGTH_NM can shrink even the minimum tack count's
    // own leg length down to only a few multiples of MARK_CLEARANCE_M (a
    // small, fixed distance) - once a "normal" tack is no longer
    // comfortably larger than that, the precision-targeting math (the
    // two-tack solve, mark clearing) is trying to resolve positions finer
    // than the course's own scale can reliably support. Rather than chase
    // that with ever-finer tuning, just sail the beat/run as a single tack/
    // gybe instead of the usual multiple - one tack needs far less
    // precision to land correctly than several.
    const normalMinLegM = legDistM / (minCount + 1);
    const maneuverCount = normalMinLegM < MARK_CLEARANCE_M * 10 ? 1 : Math.random() < 0.5 ? minCount : maxCount;
    this.targetLegM = legDistM / (maneuverCount + 1);
  }

  _heading() {
    const baseDeg = this.phase === 'upwind' ? WIND_FROM_DEG : (WIND_FROM_DEG + 180) % 360;
    const angleDeg = this.phase === 'upwind' ? CLOSE_HAULED_DEG : RUN_DEG;
    return (((baseDeg + this.side * angleDeg + this.headingJitterDeg) % 360) + 360) % 360;
  }

  // Converts a local (course-relative, "north"=toward windwardGreen)
  // offset into a real lat/lon, rotating by courseBearingDeg first so the
  // fix lands on the course's actual real-world orientation, not wherever
  // it would be if windwardGreen were still due north of leewardGreen (see
  // the constructor's own comment). A rotation, not a re-derivation - all
  // the tacking/leg logic upstream still computed north/east purely in the
  // local frame, unaware this rotation even happens. At courseBearingDeg=0
  // (the freshly-generated, unedited layout) this is the identity
  // transform - north/east pass through unchanged.
  _toLatLon(north, east) {
    const rad = (this.courseBearingDeg * Math.PI) / 180;
    const trueNorth = north * Math.cos(rad) - east * Math.sin(rad);
    const trueEast = north * Math.sin(rad) + east * Math.cos(rad);
    return offsetToLatLon(this.centerLat, this.centerLon, { north: trueNorth, east: trueEast });
  }

  // Inverse of _toLatLon (rotates by -courseBearingDeg instead of
  // +courseBearingDeg) - converts a REAL lat/lon (pin/committee/finish)
  // into this file's own local frame, so the start/finish complex's true
  // position can be compared directly against the boat's own north/east,
  // instead of assuming it sits at some fixed offset from the beat axis
  // (see the constructor's own comment on why that assumption breaks once
  // marks are edited independently).
  _toLocal(lat, lon) {
    const realNorth = (lat - this.centerLat) * METERS_PER_DEG_LAT;
    const realEast = (lon - this.centerLon) * METERS_PER_DEG_LAT * Math.cos((this.centerLat * Math.PI) / 180);
    const rad = (this.courseBearingDeg * Math.PI) / 180;
    return {
      north: realNorth * Math.cos(rad) + realEast * Math.sin(rad),
      east: -realNorth * Math.sin(rad) + realEast * Math.cos(rad),
    };
  }

  // Is local point (north, east) within the forbidden start/finish strip -
  // pinLocal<->committeeLocal (start side) or committeeLocal<->finishLocal
  // (finish side), the two together spanning pin to finish with no gap
  // (see module comment). Projects onto each in turn (projectFraction) and
  // accepts either landing in [0,1] - not assumed to be one straight
  // horizontal segment the way the old scalar bounds check was, since pin/
  // committee/finish aren't guaranteed collinear once edited independently.
  _inLocalStrip(north, east) {
    const p = { north, east };
    const tStart = projectFraction(this.pinLocal, this.committeeLocal, p);
    const tFinish = projectFraction(this.committeeLocal, this.finishLocal, p);
    return (tStart >= 0 && tStart <= 1) || (tFinish >= 0 && tFinish <= 1);
  }

  _tick() {
    if (this.finished) return; // stop() already called; ignore any stray timer fire

    if (this.startOnly) {
      // Sits at the start position forever - north/east never change, so
      // this is the same lat/lon on every tick. Still a fully valid,
      // continuously-updating fix stream (fresh timestamp each time, real
      // fix-quality fields) - just stationary, not a synthetic race.
      const { lat, lon } = this._toLatLon(this.north, this.east);
      this.emit('nav-pvt', {
        fixType: 3,
        gnssFixOk: true,
        diffSoln: true,
        carrSoln: 2,
        numSV: 14,
        lat,
        lon,
        heightMm: 5000,
        hAccMm: 15,
        gSpeedMmS: 0,
        headMotDeg: 0,
        timestamp: Date.now(),
      });
      return;
    }

    const dt = this.intervalMs / 1000;
    this.timeSinceManeuverS += dt;

    const recoveryFrac = Math.min(1, this.timeSinceManeuverS / MANEUVER_RECOVERY_S);
    const speedFrac = MANEUVER_MIN_SPEED_FRAC + (1 - MANEUVER_MIN_SPEED_FRAC) * recoveryFrac;
    const nominalSpeedMS = this.phase === 'upwind' ? this.upwindSpeedMS : this.downwindSpeedMS;
    const speedMS = nominalSpeedMS * speedFrac;

    const headingDeg = this.clearingHeadingDeg ?? this._heading();
    const rawDistM = speedMS * dt;
    // Clamped to the leg's own remaining length, but only during normal
    // tack/gybe progress - not mid-clearing or coasting to a stop, where
    // legRemainingM is just stale leftover from whatever leg was in
    // progress when the clearing/finish trigger fired, not a real distance
    // budget for this movement. Without this clamp, a tick could overshoot
    // a precisely-computed tack (see _startNewLeg()'s two-tack solve) by
    // up to this tick's own full distance - and that overshoot propagated
    // into the NEXT leg's own precision recalculation, compounding tick by
    // tick into a real, multi-meter miss on the actual finish-gate
    // crossing (the tacking angle is exactly known, so there's no reason
    // this shouldn't land precisely).
    const distM =
      this.finishCoastRemainingM == null && this.clearingHeadingDeg == null
        ? Math.min(rawDistM, this.legRemainingM)
        : rawDistM;
    const headingRad = (headingDeg * Math.PI) / 180;
    const prevNorth = this.north;
    const prevEast = this.east;
    this.north += distM * Math.cos(headingRad);
    this.east += distM * Math.sin(headingRad);
    this.legRemainingM -= distM;

    if (this.finishCoastRemainingM != null) {
      // Race is over (see the crossing check below) - coast straight ahead
      // on whatever heading/tack it was already on for a bit rather than
      // stopping dead exactly at the line, more like a real boat easing up
      // after finishing than an instant stop. No mark/leg/clearing logic
      // applies anymore, just this countdown.
      this.finishCoastRemainingM -= distM;
    } else if (this.clearingHeadingDeg != null) {
      // Mid clearing leg - a mark rounding (heading frozen due east/west,
      // clearingDirection +1/-1) or (see clearingIsLineCross) heading up to
      // clear the start/finish strip (a real, wider-than-normal angle, not
      // frozen - see where this gets set below). Either way, "cleared"
      // means east has reached the target in clearingDirection.
      const cleared =
        this.clearingDirection === 1 ? this.east >= this.clearingTargetEastM : this.east <= this.clearingTargetEastM;
      if (cleared) {
        this.clearingHeadingDeg = null;
        if (this.clearingIsLineCross) {
          this.clearingIsLineCross = false;
          this.crossedLineThisLeg = true; // doesn't count a lap, just marks the crossing handled
          this._startNewLeg();
        } else {
          this.phase = this.phase === 'upwind' ? 'downwind' : 'upwind';
          this.crossedLineThisLeg = false; // approaching the line again next
          this.justRoundedMark = true; // force a starboard-rounding departure tack
          this._setLegTarget();
          this._startNewLeg();
        }
      }
    } else if (this.phase === 'upwind' && this.north >= this.courseLengthM) {
      // Reached the windward mark's latitude - clear it heading due east
      // (see MARK_CLEARANCE_M above) before actually rounding.
      this.clearingHeadingDeg = 90;
      this.clearingDirection = 1;
      this.clearingTargetEastM = MARK_CLEARANCE_M;
      this.timeSinceManeuverS = 0;
    } else if (this.phase === 'downwind' && this.north <= 0) {
      // Reached the leeward mark's latitude - clear it heading due west.
      this.clearingHeadingDeg = 270;
      this.clearingDirection = -1;
      this.clearingTargetEastM = -MARK_CLEARANCE_M;
      this.timeSinceManeuverS = 0;
    } else if (this.legRemainingM <= 0) {
      this._startNewLeg(); // tack or gybe
    }

    // Crossing the start/finish line's latitude: upwind crossings complete a
    // lap and must go through the finish gate; downwind crossings must NOT
    // go through either side of the strip (no requirement to be near it
    // otherwise - see needsPrecisionTarget in _startNewLeg()). _startNewLeg()
    // aims the upwind approach at the gate, so that lands correctly most of
    // the time, but isn't hard-enforced - `inGate` on the emitted event says
    // whether it did.
    //
    // Skipped entirely while mid-clearing-leg (north frozen, see above) or
    // already coasting to a stop past the finish - the crossing that
    // triggered a clearing leg (mark rounding, or a downwind crossing
    // already being corrected below) was already handled when it happened;
    // re-checking a frozen north against the same threshold every
    // subsequent tick is not just redundant but, since north hasn't moved,
    // would divide by zero in interpolateEastAt.
    if (
      this.finishCoastRemainingM == null &&
      this.clearingHeadingDeg == null &&
      this.phase === 'upwind' &&
      !this.crossedLineThisLeg &&
      this.north > this.committeeLocal.north
    ) {
      this.crossedLineThisLeg = true;
      this.lapsCompleted++;
      // Interpolated east position at the exact moment north crossed
      // committee's own true north level, not just wherever this tick's
      // discrete step happened to land - at a short SIM_COURSE_LENGTH_NM
      // the finish gate can be narrower than a single tick's own travel
      // distance, so checking the post-step position directly would
      // report "missed the gate" even when the true crossing point was
      // well inside it.
      const crossingEast = interpolateEastAt(prevNorth, prevEast, this.north, this.east, this.committeeLocal.north);
      // Projected onto the TRUE committeeLocal<->finishLocal segment
      // (projectFraction), not an assumed scalar bound - see the
      // constructor's comment on why pin/committee/finish can't be
      // assumed to sit at simple offsets from the beat axis once edited
      // independently. This is also what actually matters for the base
      // station's own lap detection (finishLineWatcher.js, watching the
      // boat's real transmitted fixes) to agree with what the simulator
      // itself thinks happened - since _targetWaypoint() now steers at
      // this exact same gateCenterLocal, the boat's real sailed path
      // should actually reach it, not just be checked against it after
      // the fact.
      const t = projectFraction(this.committeeLocal, this.finishLocal, { north: this.committeeLocal.north, east: crossingEast });
      const inGate = t >= 0 && t <= 1;
      this.emit('lap', { lap: this.lapsCompleted, inGate, eastM: crossingEast });
      if (this.lapsCompleted >= this.lapTarget) {
        // Race is over - start coasting (see above) instead of planning
        // another leg toward the windward mark.
        this.finishCoastRemainingM = FINISH_COAST_M;
      } else {
        // The target just changed (start/finish line -> the mark) -
        // recompute this leg now instead of continuing on a heading aimed
        // at the old target for however much of it happens to remain.
        this._startNewLeg();
      }
    } else if (
      this.finishCoastRemainingM == null &&
      this.clearingHeadingDeg == null &&
      this.phase === 'downwind' &&
      !this.crossedLineThisLeg &&
      this.north < this.committeeLocal.north
    ) {
      // Same interpolation as the upwind gate check above - but here it
      // isn't just a diagnostic: avoiding the strip is a hard requirement,
      // so the boat's own reported position is snapped back to this exact
      // crossing point (see below) rather than left at wherever this
      // tick's discrete step happened to land. Without that, a large
      // enough per-tick step (relative to the strip's own width) could
      // interpolate as "just outside, no clearing needed" while the raw
      // tick-end position had already carried a little further into the
      // strip than the interpolated point - reporting a violating fix even
      // though the crossing itself looked clean.
      const crossingEast = interpolateEastAt(prevNorth, prevEast, this.north, this.east, this.committeeLocal.north);
      this.north = this.committeeLocal.north;
      this.east = crossingEast;
      const inStrip = this._inLocalStrip(this.north, this.east);
      if (inStrip) {
        // Free-tacking wasn't aiming for a particular spot here (there's no
        // reason to be near either mark downwind), so it can occasionally
        // land inside the forbidden strip by chance - clear it by heading
        // up toward whichever edge is nearer: a real, wider-than-normal
        // angle off dead downwind (more lateral speed, but still making
        // some forward progress, not frozen sideways like a mark rounding)
        // that bears away back to the normal run angle the instant it's
        // clear (handled above, same as any other tack/gybe transition).
        const distToFinishSide = this.finishLocal.east - this.east;
        const distToStartSide = this.east - this.pinLocal.east;
        this.clearingDirection = distToFinishSide <= distToStartSide ? 1 : -1;
        // sin(180+x) = -sin(x) - a lean off the downwind base heading (180)
        // moves east/west opposite of the same lean off the upwind base
        // (0), so clearingDirection needs a flipped sign here to still mean
        // "+1 -> increasing east" (see _startNewLeg's signCorrection for
        // the same issue elsewhere in this file).
        const downwindBaseDeg = (WIND_FROM_DEG + 180) % 360;
        this.clearingHeadingDeg = (downwindBaseDeg - this.clearingDirection * DOWNWIND_CLEAR_HEAD_UP_DEG + 360) % 360;
        this.clearingTargetEastM =
          this.clearingDirection === 1
            ? this.finishLocal.east + DOWNWIND_CLEAR_MARGIN_M
            : this.pinLocal.east - DOWNWIND_CLEAR_MARGIN_M;
        this.clearingIsLineCross = true;
        this.timeSinceManeuverS = 0;
      } else {
        this.crossedLineThisLeg = true; // doesn't count a lap, just marks the crossing handled
        this._startNewLeg();
      }
    }

    const { lat, lon } = this._toLatLon(this.north, this.east);

    this.emit('nav-pvt', {
      fixType: 3,
      gnssFixOk: true,
      diffSoln: true,
      carrSoln: 2, // RTK fixed - simulate a healthy link
      numSV: 14,
      lat,
      lon,
      heightMm: 5000,
      hAccMm: 15,
      gSpeedMmS: Math.round(speedMS * 1000),
      headMotDeg: headingDeg,
      timestamp: Date.now(),
    });

    if (this.finishCoastRemainingM != null && this.finishCoastRemainingM <= 0) {
      this.finished = true;
      this.stop();
      this.emit('finished', { laps: this.lapsCompleted });
    }
  }
}

module.exports = { SimGpsSource };
