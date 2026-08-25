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
  // Degenerate: a and b on top of each other - a real, not just
  // theoretical, case now that committeeStart/committeeFinish can be
  // independently positioned (see course.js's FINISH_OFFSET_NORTH_M/
  // FINISH_OFFSET_EAST_M) and default to the exact same spot. Every
  // caller of this function uses the result as a membership test
  // (t>=0 && t<=1) against a real segment's span - a zero-length "segment"
  // has zero span, so it should never match ANY point, not even its own
  // location (a single point has no interior to be "inside"). Returning 0
  // here instead would read as "always inside," which previously made
  // _inLocalStrip report every point on the entire course as being in the
  // forbidden strip whenever committeeStart and committeeFinish were
  // co-located (the default) - confirmed live: boats sailing straight
  // through the actual finish gate downwind, because the reactive
  // violation-avoidance leg meant to catch exactly that was permanently
  // short-circuited by that same "always violating" bug on its OTHER,
  // unrelated segment checks (see _inLocalStrip's own comment).
  if (lenSq === 0) return Infinity;
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
// actually say, not this process's own environment. pin/committeeStart/
// committeeFinish/finish's own true positions (see the constructor) are
// measured the same way, for the same reason.
//
// Upwind crossings of the start/finish line must pass through the finish
// gate (committeeFinish <-> finish, on the east side of the rhumb line -
// see course.js) to count a lap - never the start side, never beyond
// either mark. Aiming for the gate's center (see _targetWaypoint()) is what
// usually gets it there, but it's also hard-enforced: a crossing found to
// land outside the gate is never committed to (see _tick()'s upwind
// crossing check) - the tick rolls back to the last known-good position and
// re-aims instead of reporting a fix on the wrong side of the line.
//
// Downwind crossings can go anywhere EXCEPT through the start side (pin <->
// committeeStart), the finish side (committeeFinish <-> finish), or the gap
// directly between the two committee boats (committeeStart <->
// committeeFinish - not a legal way through the complex either). These used
// to reduce to one continuous strip from pin to finish, no gap, back when a
// single committee mark anchored both start and finish (the middle segment
// was zero-length) - now that committeeStart/committeeFinish can sit at
// different positions entirely (see course.js's FINISH_OFFSET_NORTH_M/
// FINISH_OFFSET_EAST_M), all three are independent segments, each checked
// against its own threshold as the boat reaches it (see _tick()'s downwind
// crossing check and passedStartSide/passedFinishSide/passedMiddleSection
// below) - there's no requirement to be near either mark otherwise. The
// target (see _targetWaypoint()) is picked dynamically off whichever side
// of a segment the boat's current position already sits on, so the boat
// clears past the nearest edge rather than converging toward a fixed point
// next to a mark. Also hard-enforced the same way as the upwind gate above
// - a crossing found to land inside any of the three segments is rolled
// back rather than committed to.
// DOWNWIND_CLEAR_MARGIN_M pushes the clearing target just past the
// segment's edge so the crossing is a clean pass rather than a graze - no
// more margin than that is needed, since the only actual requirement is not
// sailing through the segment.
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

// Confines each boat's own randomized finish-gate crossing point (see the
// constructor's gateTargetLocal) to comfortably inside both ends of the
// committeeFinish<->finish segment, not the literal edges - same concern as
// course.js's SIM_START_SAFE_MAX_FRACTION for the start line, staying off
// both edges since this is the finish gate specifically, not the whole
// start/finish complex.
const GATE_CROSS_SAFE_MIN_FRAC = 0.15;
const GATE_CROSS_SAFE_MAX_FRAC = 0.85;

// How far leeward (behind, not on top of) the pin<->committeeStart line a
// boat's starting/pending position sits - a boat genuinely queuing for the
// start stands off the line a little, not straddling it exactly, and it
// gives on-grid detection (see onGridWatcher.js) real margin against the
// leeward-side check's own ONGRID_EDGE_MARGIN_M (1m): a boat placed
// *exactly* on the line has zero headroom against any small numerical
// difference between this file's own lat/lon math (offsetToLatLon, a
// different origin/rotation than onGridWatcher.js's independent toXY) and
// the detector's - 2m of real standoff comfortably absorbs that regardless.
const PENDING_LINE_OFFSET_M = 2;

// Once the final lap's finish-line crossing is detected, the boat keeps
// sailing straight on its current tack/heading for this much farther
// before the simulation actually stops - a real boat eases across the
// line and keeps some way on rather than stopping dead exactly at it.
const FINISH_COAST_M = 20;

// After crossing the finish line with MORE laps still to go, the boat keeps
// sailing straight on whatever tack it was already on for a random distance
// in this range before _startNewLeg() picks the new tack toward the
// windward mark - same "real boat doesn't stop dead at the line" idea as
// FINISH_COAST_M, just for a mid-race crossing instead of the final one, so
// the boat doesn't snap-tack right at the gate every lap.
const LAP_COAST_MIN_M = 15;
const LAP_COAST_MAX_M = 40;

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
  // pin/committeeStart/committeeFinish/finish: the REAL lat/lon of the
  // start/finish complex. windward/leeward always sit exactly on this
  // file's own local north axis, by definition of how courseBearingDeg is
  // derived (the leeward -> windward bearing) - but pin/committeeStart/
  // committeeFinish/finish are NOT guaranteed to, since an operator can
  // drag any mark independently of any other (see adminServer.js's "edit
  // marks" column), and committeeStart/committeeFinish in particular can
  // now be entirely different positions by design (see course.js's
  // FINISH_OFFSET_NORTH_M/FINISH_OFFSET_EAST_M). Their true position in
  // this local frame has to be measured (see _toLocal below), not assumed
  // to sit at some fixed offset perpendicular to the beat axis - otherwise
  // an edited windward mark rotates the beat axis right out from under a
  // *stationary* real finish line, and the boat stops crossing it
  // entirely (the bug this whole approach exists to avoid).
  constructor({
    centerLat,
    centerLon,
    upwindSpeedKn,
    downwindSpeedKn,
    hz,
    startFrac,
    lapCount,
    geometry,
    startOnly,
    prestartDwellS,
    holdForStart,
    pin,
    committeeStart,
    committeeFinish,
    finish,
  }) {
    super();
    this.centerLat = centerLat;
    this.centerLon = centerLon;
    // See _tick() - when true, every other field this constructor sets up
    // (phase, side, leg targets, lap counting, ...) is simply never read.
    this.startOnly = !!startOnly;
    // Like startOnly, but releasable (see release() below) instead of
    // permanent - the boat holds at its start position until something
    // outside this class calls release(), rather than either a fixed timer
    // (prestartDwellS) or forever. Takes priority over prestartDwellS: the
    // whole point of a manual hold is not departing on a timer.
    this.holdForStart = !this.startOnly && !!holdForStart;
    // How many seconds of _tick() calls remain before the boat actually
    // starts moving - see _tick()'s own comment. Meaningless (and unused)
    // when startOnly is set, which dwells forever via its own separate
    // path; Infinity when holdForStart is set, since only an explicit
    // release() call (never a countdown) should end that hold; defaults to
    // 0 (no dwell, departs immediately) if omitted, so existing callers
    // that don't pass this keep today's behavior.
    this.dwellRemainingS = this.startOnly ? 0 : this.holdForStart ? Infinity : Math.max(0, prestartDwellS || 0);
    this.courseLengthM = geometry.courseLengthM;
    // Everything below (phase/tacking/leg targets/gate checks) works
    // entirely in this local, course-relative frame - "north" always means
    // "toward windwardGreen," matching WIND_FROM_DEG=0's own assumption, so
    // none of that logic needs to know or care which way the course
    // actually points in the real world. Only _toLatLon() (see below)
    // needs the real bearing, to rotate this local frame into a true
    // north/east offset right before it becomes an actual lat/lon fix.
    this.courseBearingDeg = geometry.courseBearingDeg;

    // pin/committeeStart/committeeFinish/finish's TRUE position in this
    // same local frame - their real offset from leewardGreen, rotated by
    // -courseBearingDeg (the inverse of _toLatLon's own rotation). At
    // courseBearingDeg=0 (unedited layout) this reduces to exactly the old
    // assumed values (committeeStart/committeeFinish at local
    // (startLineNorthM, 0), etc.) - it's a generalization, not a behavior
    // change, for the common case.
    this.pinLocal = this._toLocal(pin.lat, pin.lon);
    this.committeeStartLocal = this._toLocal(committeeStart.lat, committeeStart.lon);
    this.committeeFinishLocal = this._toLocal(committeeFinish.lat, committeeFinish.lon);
    this.finishLocal = this._toLocal(finish.lat, finish.lon);
    // Which of the three downwind strip segments (see the module comment)
    // this boat has already sailed cleanly past this leg - reset every
    // time it enters a new downwind leg (see the mark-rounding handler in
    // _tick()). Only meaningful downwind; the upwind gate check only ever
    // cares about the finish side (gateTargetLocal below). The third
    // segment, committeeStart<->committeeFinish, is the gap BETWEEN the two
    // committee boats themselves - now that they aren't necessarily the
    // same point, a boat could otherwise cut straight between them without
    // ever crossing either actual line, which isn't a legal way through the
    // complex.
    this.passedStartSide = false;
    this.passedFinishSide = false;
    this.passedMiddleSection = false;
    // Where THIS boat steers toward on its final upwind approach (see
    // _targetWaypoint()) - a random point along the committeeFinish<->finish
    // segment, not always the exact center. Drawn once per boat (like
    // speedFactor below), not per-crossing, so the same boat crosses in
    // roughly the same spot every lap rather than a different one each
    // time - real boats have some individual consistency in where they
    // cross too, it's not independently random every lap. Confined to
    // GATE_CROSS_SAFE_MIN_FRAC..GATE_CROSS_SAFE_MAX_FRAC (comfortably
    // inside both ends) rather than the full 0..1 range - a fleet
    // literally converging on the exact midpoint every lap looked like a
    // funnel.
    const gateCrossFrac = randRange(GATE_CROSS_SAFE_MIN_FRAC, GATE_CROSS_SAFE_MAX_FRAC);
    this.gateTargetLocal = {
      north: this.committeeFinishLocal.north + gateCrossFrac * (this.finishLocal.north - this.committeeFinishLocal.north),
      east: this.committeeFinishLocal.east + gateCrossFrac * (this.finishLocal.east - this.committeeFinishLocal.east),
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
    // this same per-boat spread (still useful to see multiple simulated
    // boats sitting at their own distinct positions along the line, e.g.
    // testing a fleet start) rather than collapsing every boat onto the
    // same point. `startFrac` (0-1) is this boat's own index/fleetSize when
    // spawned as part of a fleet (even spacing), or a random draw when
    // running standalone (see boatAgent.js) - not the boat's own ID/sail
    // number.
    //
    // Interpolated against the TRUE local pin/committeeStart positions (not
    // a simple east offset - see course.js's getStartFraction), so every
    // boat lands along the real pin<->committeeStart line regardless of
    // whether that line happens to be perpendicular to the beat axis -
    // then pulled PENDING_LINE_OFFSET_M leeward (south, in this local
    // frame) of it, not left sitting exactly on top of the line (see that
    // constant's own comment). The real, measured line length (not
    // START_SIDE_LENGTH_M - an operator-edited line isn't guaranteed to
    // match its own computed default) is what lets getStartFraction keep
    // the whole fleet SIM_START_LINE_END_MARGIN_M clear of both ends.
    const lineLenM = Math.hypot(
      this.committeeStartLocal.north - this.pinLocal.north,
      this.committeeStartLocal.east - this.pinLocal.east
    );
    const startLineFrac = getStartFraction(startFrac, lineLenM);
    this.north =
      this.pinLocal.north + startLineFrac * (this.committeeStartLocal.north - this.pinLocal.north) - PENDING_LINE_OFFSET_M;
    this.east = this.pinLocal.east + startLineFrac * (this.committeeStartLocal.east - this.pinLocal.east);
    this.phase = 'upwind'; // 'upwind' (beating) | 'downwind' (running)
    this.side = Math.random() < 0.5 ? 1 : -1;
    this.timeSinceManeuverS = 999;
    this.clearingHeadingDeg = null; // set mid-mark-rounding (due east/west) or mid-line-clear (headed up), see _tick()
    this.clearingDirection = null; // +1 (clearing east) or -1 (clearing west) - which way clearingTargetEastM is being approached from
    this.clearingIsLineCross = false; // true when clearingHeadingDeg is clearing the start/finish strip, not a mark
    this.clearingSegmentPassedKeys = []; // which passedStartSide/passedFinishSide/passedMiddleSection this clear covers, see where it's set
    this.steeringDirect = false; // true once close enough to the gate/a mark to steer directly at it instead of a fixed-angle tack, see _startNewLeg()
    // Freezes the heading during finishCoastRemainingM/lapCoastRemainingM
    // (coast straight after a gate crossing) when that crossing happened
    // while steeringDirect - normally coasting "just keeps working" because
    // _heading()'s fixed-angle formula only depends on phase/side/jitter,
    // none of which change until the next real _setLeg() call, so it
    // naturally keeps reproducing the same value with no explicit freeze
    // needed. steeringDirect has no such fixed inputs (its heading is
    // continuously recomputed toward whatever's currently being targeted),
    // so without this, "coasting" would keep steering toward the NEW target
    // that crossedLineThisLeg switches to the instant the gate is crossed
    // (the windward mark) instead of actually going straight. Set right at
    // the crossing (see _tick()) and cleared by _setLeg() once real tacking
    // resumes.
    this.coastHeadingDeg = null;

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
    this.lapCoastRemainingM = null; // set once a non-final lap's crossing is detected, see _tick()

    // Leg/target setup is irrelevant in startOnly mode - _tick() below
    // never reads any of it, so skip it entirely rather than run setup for
    // state that'll never be used.
    if (!this.startOnly) {
      this._setLegTarget();
      this._startNewLeg();
    }
    this._timer = setInterval(() => this._tick(), this.intervalMs);
  }

  // Emits the real, correct starting position immediately rather than
  // waiting for the first setInterval tick above (which by definition
  // doesn't fire until a full intervalMs later, e.g. up to a second at
  // 1Hz). boatAgent.js reports 'on-grid' to fleetSim.js the instant the
  // constructor returns - with 30 boats' timers not perfectly synchronized,
  // whichever one's first tick happens to land last would otherwise show
  // "on-grid" in the simulator's own count while still transmitting its
  // pre-marks placeholder position (the marks-ping midpoint sent before
  // this boat ever had a real fix to report) on the map. Only meaningful
  // for the dwelling/stationary paths - a boat that starts racing
  // immediately gets its first real tick from the interval exactly as
  // before, so there's no risk of double-applying movement.
  //
  // Deliberately a separate method the CALLER invokes, not folded into the
  // constructor itself: gps.on('nav-pvt', handlePvt) is only attached after
  // `new SimGpsSource(...)` returns (see boatAgent.js), so emitting from
  // inside the constructor would fire with zero listeners attached yet and
  // be silently lost - same class of bug this method exists to fix, just
  // moved earlier instead of solved.
  emitInitialFixIfDwelling() {
    if (this.startOnly || this.dwellRemainingS > 0) this._emitStationaryFix();
  }

  stop() {
    clearInterval(this._timer);
  }

  // Ends a holdForStart hold, letting the boat depart on its very next
  // tick - called once, from outside, in response to the operator's own
  // "start the race" signal (see boatAgent.js). A no-op under startOnly
  // (which never departs, by design) or once already racing/finished, so a
  // stray extra call can't do anything unexpected.
  release() {
    if (this.startOnly) return;
    this.dwellRemainingS = 0;
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
      // gateTargetLocal); downwind keeps the old plain rhumb-line bias
      // (east=0), just measured against whichever downwind strip segment
      // is further north (encountered first while descending) instead of
      // an assumed scalar - a loose directional bias only (no precision
      // convergence applies downwind, see needsPrecisionTarget below), so
      // it doesn't need to be exact.
      return this.phase === 'upwind'
        ? { targetNorth: this.gateTargetLocal.north, targetEastM: this.gateTargetLocal.east }
        : { targetNorth: Math.max(this.committeeStartLocal.north, this.committeeFinishLocal.north), targetEastM: 0 };
    }
    return { targetNorth: this.phase === 'upwind' ? this.courseLengthM : 0, targetEastM: 0 };
  }

  // Sets up a leg on a specific tack/gybe, always at the FULL close-hauled/
  // run angle for the phase (never softened) - `jitterDeg` adds a small
  // per-tack heading wobble for visual variety on free legs. Every real
  // tack goes through here, so it's also where steeringDirect/
  // coastHeadingDeg (see the constructor's own comments) get cleared -
  // ordinary fixed-angle tacking is resuming, so neither should linger.
  _setLeg(side, lengthM, jitterDeg = 0) {
    this.side = side;
    this.headingJitterDeg = jitterDeg;
    this.legRemainingM = Math.max(1, lengthM);
    this.timeSinceManeuverS = 0;
    this.steeringDirect = false;
    this.coastHeadingDeg = null;
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
      let lengthM = randRange(this.targetLegM * 0.35, this.targetLegM * 0.6);
      // targetLegM itself isn't always "a fraction of a multi-tack beat" -
      // on a short course (or one that's collapsed to single-tack mode, see
      // _setLegTarget), targetLegM can be close to HALF the entire
      // beat/run's own north distance, so 35-60% of it can still consume
      // most of the north-distance available for the whole leg - leaving
      // too little dNorth for the normal precision-targeting logic
      // afterward to recover whatever lateral drift this forced,
      // uncorrected tack itself introduces. Unlike every other leg's own
      // overshoot risk (which just costs a bit of precision), an
      // unrecoverable one here is a real correctness problem: at a fixed
      // tacking angle, once dNorth runs out there is no later tack that can
      // still fix it - exactly the "missed layline with no north left to
      // recover on" case _tick()'s crossing checks now catch and reject.
      // Capped against the ACTUAL remaining dNorth to the line (not just
      // targetLegM) at a conservative fraction, so meaningfully more
      // runway is always left after this leg than it itself used.
      const { targetNorth: departureTargetNorth } = this._targetWaypoint();
      const departureDNorth = Math.abs(departureTargetNorth - this.north);
      const departureNorthPerM = Math.cos((maxAngleDeg * Math.PI) / 180);
      const maxByRunwayM = (departureDNorth * 0.4) / departureNorthPerM;
      lengthM = Math.min(lengthM, Math.max(maxByRunwayM, 1));
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
      // Exact two-tack solve: side-1 for Lminus sailed first, then side+1
      // for Lplus, lands precisely on target (verified: for fixed angle
      // theta, (Lplus+Lminus)*cos(theta) covers dNorth and
      // (Lplus-Lminus)*sin(theta) covers dEastCorrected). Lminus~0 is
      // exactly "on the layline already" - a single final tack (Lplus) at
      // the normal angle reaches the target with no correction needed, the
      // same thing a real sailor means by "laying the mark." Below that
      // threshold, steer straight at the target instead of setting up a
      // literal near-zero-length leg (see steeringDirect below).
      const S = dNorth / northPerM;
      const Diff = dEastCorrected / Math.sin(maxAngleRad);
      const Lplus = (S + Diff) / 2;
      const Lminus = (S - Diff) / 2;
      const NEAR_ZERO_M = Math.min(this.targetLegM * 0.01, 2);

      if (Lminus > NEAR_ZERO_M && Lplus > NEAR_ZERO_M) {
        // Not on the layline yet - sail the corrective tack now, sized so
        // exactly Lplus is left after it (by construction, precisely one
        // more tack from landing on target - the layline, not a guess).
        // An ordinary, bounded _setLeg() - _tick()'s legRemainingM<=0 check
        // calls _startNewLeg() again once it completes, which finds
        // Lminus~0 next time and switches to steering straight in from
        // there, with no pinch at all since that's now the normal angle.
        this._setLeg(-1, Lminus);
        return;
      }

      // Either already on the layline (Lminus/Lplus ~0 - the common case)
      // or the correction needed exceeds what two tacks can cover within
      // dNorth (Lminus or Lplus negative - rare, only when closeEnough's
      // own distance threshold was reached with an unusually large
      // cross-track error still outstanding). Either way, steer straight
      // at the target now: on the layline this is the normal angle, no
      // pinch; the rare oversized-correction case is a geometry-forced
      // minimum necessary to actually reach it, not avoidable by more
      // tacking (there isn't room left for another tack regardless of
      // technique) - recomputed every tick in _tick() (see
      // this.steeringDirect there), so it self-corrects continuously and
      // always converges. This is also the safety net an earlier, simpler
      // version of this fix relied on for the ENTIRE close-enough case,
      // not just these two - unconditional unclamped steering never
      // stalls, but pinches far more than necessary; the two-tack solve
      // above is what actually eliminates pinching for the normal case.
      this.steeringDirect = true;
      this.legRemainingM = Infinity;
      // Doesn't go through _setLeg() (no fixed tack to set up), which is
      // where coastHeadingDeg normally gets cleared - if _startNewLeg() is
      // called again while a stale one is still set (e.g. re-entering this
      // branch right after a coast ends), it would otherwise keep
      // overriding steeringDirect's own fresh heading with the old frozen
      // one via _tick()'s priority chain.
      this.coastHeadingDeg = null;
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
      // Check against every downwind strip segment this boat hasn't
      // already sailed cleanly past this leg (see passedStartSide/
      // passedFinishSide) - start and finish can now sit at different
      // norths (see the module comment), so a tack that clears one segment
      // can still run through the other.
      const pendingNorths = this._pendingStripTriggerNorths();
      const violatesAt = (s) => pendingNorths.some((n) => this._inLocalStrip(n, this._projectedCrossingEast(s, n)));
      if (violatesAt(side) && !violatesAt(-side)) side = -side;
      // If both tacks violate at least one pending segment (only possible
      // very close to the line with little room left to redirect), leave
      // side as chosen above - the reactive check in _tick() is the
      // fallback.
    }

    // See the comment on the equivalent line above - already positive and
    // proportional to targetLegM, no separate fixed floor needed.
    const legM = randRange(this.targetLegM * (1 - LEG_JITTER_FRAC), this.targetLegM * (1 + LEG_JITTER_FRAC));
    this._setLeg(side, legM, randRange(-HEADING_JITTER_DEG, HEADING_JITTER_DEG));
  }

  // Where the boat would cross the given target latitude if it kept
  // sailing the given side/tack (at the phase's full fixed angle, no
  // heading jitter) all the way there from its current position - used to
  // decide, before actually committing to a tack, whether it needs to be
  // avoided because it would carry the boat through a forbidden strip
  // segment (see the downwind pre-crossing check in _startNewLeg()).
  // targetNorth is whichever strip segment's own threshold is being
  // checked (see _pendingStripTriggerNorths()) - the two can differ now
  // that committeeStart/committeeFinish aren't guaranteed the same north.
  _projectedCrossingEast(side, targetNorth) {
    const maxAngleDeg = this.phase === 'upwind' ? CLOSE_HAULED_DEG : RUN_DEG;
    const baseDeg = this.phase === 'upwind' ? WIND_FROM_DEG : (WIND_FROM_DEG + 180) % 360;
    const headingRad = (((baseDeg + side * maxAngleDeg) % 360) * Math.PI) / 180;
    const dNorth = targetNorth - this.north;
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

  // Straight-line compass bearing (0=N, clockwise) from the boat's current
  // position to whatever it's currently targeting (the finish gate, or a
  // mark) - used only while this.steeringDirect is true (see
  // _startNewLeg()'s two-tack solve, which only turns this on once already
  // on the layline or when the correction genuinely can't wait for another
  // tack). No clamping here: an earlier version clamped this bearing to the
  // sailing envelope instead of gating when steeringDirect turns on -
  // reverted, since clamping breaks the property that makes this
  // stall-free. Unclamped, the boat converges on north AND east
  // simultaneously by definition (pointed exactly at the target); clamped,
  // it can reach the target's latitude while still meaningfully off to one
  // side, right back into the same reject-and-retry stall this whole
  // mechanism exists to avoid.
  _headingToTarget() {
    const { targetNorth, targetEastM } = this._targetWaypoint();
    const dNorth = targetNorth - this.north;
    const dEast = targetEastM - this.east;
    return (((Math.atan2(dEast, dNorth) * 180) / Math.PI) + 360) % 360;
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
  // +courseBearingDeg) - converts a REAL lat/lon (pin/committeeStart/
  // committeeFinish/finish) into this file's own local frame, so the
  // start/finish complex's true position can be compared directly against
  // the boat's own north/east, instead of assuming it sits at some fixed
  // offset from the beat axis (see the constructor's own comment on why
  // that assumption breaks once marks are edited independently).
  _toLocal(lat, lon) {
    const realNorth = (lat - this.centerLat) * METERS_PER_DEG_LAT;
    const realEast = (lon - this.centerLon) * METERS_PER_DEG_LAT * Math.cos((this.centerLat * Math.PI) / 180);
    const rad = (this.courseBearingDeg * Math.PI) / 180;
    return {
      north: realNorth * Math.cos(rad) + realEast * Math.sin(rad),
      east: -realNorth * Math.sin(rad) + realEast * Math.cos(rad),
    };
  }

  // Is local point (north, east) within any of the three forbidden
  // start/finish strip segments - pinLocal<->committeeStartLocal (start
  // side), committeeFinishLocal<->finishLocal (finish side), or
  // committeeStartLocal<->committeeFinishLocal (the gap between the two
  // committee boats themselves - not a legal way through the complex
  // either, see the constructor's own comment). These used to be one
  // single continuous strip (no gap) when a single committee mark anchored
  // both start and finish; now they're independent segments, possibly at
  // different norths (see module comment) - checked independently here
  // regardless, same as before. Projects onto each in turn (projectFraction)
  // and accepts any landing in [0,1] - not assumed to be one straight
  // horizontal segment the way the old scalar bounds check was, since pin/
  // committeeStart/committeeFinish/finish aren't guaranteed collinear once
  // edited independently.
  _inLocalStrip(north, east) {
    const p = { north, east };
    const tStart = projectFraction(this.pinLocal, this.committeeStartLocal, p);
    const tFinish = projectFraction(this.committeeFinishLocal, this.finishLocal, p);
    const tMiddle = projectFraction(this.committeeStartLocal, this.committeeFinishLocal, p);
    return (tStart >= 0 && tStart <= 1) || (tFinish >= 0 && tFinish <= 1) || (tMiddle >= 0 && tMiddle <= 1);
  }

  // The committeeStart<->committeeFinish segment's own trigger north -
  // unlike the start/finish segments (where pin sits at roughly the same
  // north as committeeStart, and finish at roughly the same north as
  // committeeFinish, by construction of a gate laid perpendicular to the
  // course axis), this segment directly connects the two committee marks,
  // which can be at ANY two norths relative to each other. Using the
  // larger of the two as the trigger means the check activates once the
  // boat has descended past at least the nearer end of the segment -
  // whichever end that turns out to be, the actual violation test
  // (_inLocalStrip, a plain projection) is exact regardless of the
  // segment's orientation; this only picks when to bother running it.
  _middleSectionTriggerNorth() {
    return Math.max(this.committeeStartLocal.north, this.committeeFinishLocal.north);
  }

  // Which downwind strip segment(s) this boat still needs to check for a
  // violation this leg, as their own trigger norths - the segment(s) it
  // hasn't already sailed cleanly past (see passedStartSide/
  // passedFinishSide/passedMiddleSection, cleared each time a new downwind
  // leg starts). All three are checked independently since none are
  // guaranteed the same north (see module comment).
  _pendingStripTriggerNorths() {
    const norths = [];
    if (!this.passedStartSide) norths.push(this.committeeStartLocal.north);
    if (!this.passedFinishSide) norths.push(this.committeeFinishLocal.north);
    if (!this.passedMiddleSection) norths.push(this._middleSectionTriggerNorth());
    return norths;
  }

  // Sits at the current position, emitting a fresh but otherwise stationary
  // fix - shared by startOnly's permanent dwell and the prestart dwell
  // below, which is the same thing for a limited time instead of forever.
  // `stationary: true` lets boatAgent.js's own console logging (handlePvt)
  // recognize a repeated, no-new-information fix and stop scrolling it -
  // at full SIM_GPS_HZ, a fleet of several boats all dwelling at once
  // floods the terminal with lines that never actually change, easily
  // burying a one-line SIM_HOLD_FOR_START prompt within a second or two.
  _emitStationaryFix() {
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
      // A real stationary GPS fix genuinely can't derive heading from zero
      // speed, but for display this should still show the direction the
      // boat's actually oriented - its own assigned close-hauled tack (same
      // _heading() used once it actually starts sailing), not due north for
      // every boat regardless of which way it's really facing on the line.
      headMotDeg: this._heading(),
      timestamp: Date.now(),
      // Real GPS hardware's timestamp is now GPS-derived, not local-clock
      // (see ubxParser.js's own comment) - receivedAt is the field
      // staleness checks actually want, so the simulator emits both, same
      // shape as a real fix.
      receivedAt: Date.now(),
      stationary: true,
    });
  }

  _tick() {
    if (this.finished) return; // stop() already called; ignore any stray timer fire

    if (this.startOnly) {
      // Sits at the start position forever - north/east never change, so
      // this is the same lat/lon on every tick. Still a fully valid,
      // continuously-updating fix stream (fresh timestamp each time, real
      // fix-quality fields) - just stationary, not a synthetic race.
      this._emitStationaryFix();
      return;
    }

    const dt = this.intervalMs / 1000;

    if (this.dwellRemainingS > 0) {
      // Same stationary fix as startOnly above, just for a limited time -
      // see the constructor's own comment on why this exists at all
      // (mainly so on-grid detection gets a genuine window to observe in
      // an ordinary test race, not just under SIM_START_ONLY). Every other
      // field (phase, leg targets, ...) was already set up in the
      // constructor and stays exactly as it was for whenever the dwell
      // actually ends - departing is just the normal tick logic below
      // picking up right where it would have started immediately.
      this.dwellRemainingS -= dt;
      this._emitStationaryFix();
      return;
    }

    this.timeSinceManeuverS += dt;

    const recoveryFrac = Math.min(1, this.timeSinceManeuverS / MANEUVER_RECOVERY_S);
    const speedFrac = MANEUVER_MIN_SPEED_FRAC + (1 - MANEUVER_MIN_SPEED_FRAC) * recoveryFrac;
    const nominalSpeedMS = this.phase === 'upwind' ? this.upwindSpeedMS : this.downwindSpeedMS;
    const speedMS = nominalSpeedMS * speedFrac;

    const headingDeg =
      this.clearingHeadingDeg ?? this.coastHeadingDeg ?? (this.steeringDirect ? this._headingToTarget() : this._heading());
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
      this.finishCoastRemainingM == null && this.lapCoastRemainingM == null && this.clearingHeadingDeg == null
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
    } else if (this.lapCoastRemainingM != null) {
      // More laps to go, coasting on the current tack after the crossing
      // (see the crossing check below) - once the coast distance is used
      // up, _startNewLeg() picks the actual new tack toward the windward
      // mark. Same no-mark/leg/clearing-logic-applies idea as the finish
      // coast above, just resuming normal tacking afterward instead of
      // stopping.
      this.lapCoastRemainingM -= distM;
      if (this.lapCoastRemainingM <= 0) {
        this.lapCoastRemainingM = null;
        this._startNewLeg();
      }
    } else if (this.clearingHeadingDeg != null) {
      // Mid clearing leg - a mark rounding (heading frozen due east/west,
      // clearingDirection +1/-1) or (see clearingIsLineCross) heading up to
      // clear the start/finish strip (a real, wider-than-normal angle, not
      // frozen - see where this gets set below). "Cleared" means east has
      // reached the target in clearingDirection.
      const reachedTarget =
        this.clearingDirection === 1 ? this.east >= this.clearingTargetEastM : this.east <= this.clearingTargetEastM;
      // For a line-cross clear specifically, reaching the precomputed
      // target isn't sufficient on its own - the target was sized against
      // the segments known to be pending when the leg started, but the
      // straight-line PATH to get there can still cut through one of
      // THOSE segments' own span partway there (they can sit directly
      // adjacent to each other, e.g. whenever committeeStart and
      // committeeFinish are at or near the same spot - the default - so
      // clearing distance one way can pass straight through the other
      // segment's own territory before ever reaching the target).
      // _inLocalStrip is the simulator's own ground truth for "is this
      // exact point forbidden" - requiring it to say no, not just trusting
      // the precomputed target, is what actually guarantees the boat
      // never finishes this leg still standing inside one. If the target's
      // reached but this still says yes, the leg simply keeps running at
      // the same wide angle rather than stopping short - eventually either
      // more east progress or the ongoing north progress clears it for
      // real. Mark-rounding clears don't need this - they're not
      // navigating around a segment, just squaring away from one mark's
      // own longitude.
      const cleared = reachedTarget && (!this.clearingIsLineCross || !this._inLocalStrip(this.north, this.east));
      if (cleared) {
        this.clearingHeadingDeg = null;
        if (this.clearingIsLineCross) {
          this.clearingIsLineCross = false;
          // Every segment this leg was sized to clear (see its own
          // comment on clearingSegmentPassedKeys) is actually behind the
          // boat now - the leg's target was the union of all of them, not
          // just whichever one triggered it. Same "only fully done once
          // every segment is passed" rule as the clean-pass case above,
          // for whatever's left outside this list (there shouldn't be
          // anything, but a segment reached mid-clear by pure north
          // progress rather than this leg's own east target stays
          // possible in principle).
          for (const key of this.clearingSegmentPassedKeys) this[key] = true;
          this.clearingSegmentPassedKeys = [];
          if (this._pendingStripTriggerNorths().length === 0) {
            this.crossedLineThisLeg = true; // doesn't count a lap, just marks the crossing handled
            this._startNewLeg();
          }
        } else {
          this.phase = this.phase === 'upwind' ? 'downwind' : 'upwind';
          this.crossedLineThisLeg = false; // approaching the line again next
          // Only meaningful downwind (see _pendingStripTriggerNorths), but
          // harmless to reset unconditionally here rather than special-case
          // which direction this rounding just started.
          this.passedStartSide = false;
          this.passedFinishSide = false;
          this.passedMiddleSection = false;
          this.justRoundedMark = true; // force a starboard-rounding departure tack
          this._setLegTarget();
          this._startNewLeg();
        }
      }
    } else if (this.phase === 'upwind' && this.north >= this.courseLengthM) {
      // Reached the windward mark's latitude - clear it heading due east
      // (see MARK_CLEARANCE_M above) before actually rounding.
      this.steeringDirect = false;
      this.clearingHeadingDeg = 90;
      this.clearingDirection = 1;
      this.clearingTargetEastM = MARK_CLEARANCE_M;
      this.timeSinceManeuverS = 0;
    } else if (this.phase === 'downwind' && this.north <= 0) {
      // Reached the leeward mark's latitude - clear it heading due west.
      this.steeringDirect = false;
      this.clearingHeadingDeg = 270;
      this.clearingDirection = -1;
      this.clearingTargetEastM = -MARK_CLEARANCE_M;
      this.timeSinceManeuverS = 0;
    } else if (this.legRemainingM <= 0) {
      this._startNewLeg(); // tack or gybe
    }

    // Crossing the start/finish line's latitude: upwind crossings must go
    // through the finish gate specifically (not the start side, and not
    // beyond either mark) to count a lap; downwind crossings must NOT go
    // through either side of the strip at all. Both are hard requirements,
    // not just "usually lands right because _startNewLeg() aims for it" -
    // either check below can find the raw crossing landed somewhere
    // forbidden, in which case that position is never actually reported:
    // the tick rolls back to the last known-good position (prevNorth/
    // prevEast, still on the correct side of the line) and redirects from
    // there instead, so a bad crossing never makes it into an emitted fix
    // even for one tick, and downstream consumers watching this boat's real
    // transmitted position (like the base's own finishLineWatcher.js) never
    // see it either.
    //
    // Skipped entirely while mid-clearing-leg (north frozen, see above) or
    // already coasting to a stop past the finish - the crossing that
    // triggered a clearing leg (mark rounding, or a crossing already being
    // corrected below) was already handled when it happened; re-checking a
    // frozen north against the same threshold every subsequent tick is not
    // just redundant but, since north hasn't moved, would divide by zero in
    // interpolateEastAt.
    if (
      this.finishCoastRemainingM == null &&
      this.clearingHeadingDeg == null &&
      this.phase === 'upwind' &&
      !this.crossedLineThisLeg &&
      this.north > this.gateTargetLocal.north
    ) {
      // Interpolated east position at the exact moment north crossed the
      // SAME gateTargetLocal.north _targetWaypoint() steers at - not
      // committeeFinishLocal.north, which this used to check against
      // despite the boat sailing toward gateTargetLocal instead (a real,
      // structural mismatch whenever committeeFinish and finish aren't at
      // exactly the same north, which independently-edited marks routinely
      // aren't - the boat could be steering perfectly at gateTargetLocal
      // and still get rejected every single time, since the crossing was
      // being evaluated at a different latitude than the one it was
      // actually aiming for. Confirmed live: a boat can get stuck
      // oscillating between the same two positions forever, never
      // crossing, since rolling back to exactly where it started and
      // recomputing steeringDirect's heading from there deterministically
      // reproduces the exact same rejected attempt every time - not a
      // precision problem steering better could ever fix, a
      // reference-point mismatch no amount of precision could).
      // Not just checking the post-tick position directly - at a short
      // SIM_COURSE_LENGTH_NM the finish gate can be narrower than a single
      // tick's own travel distance, so that would report "missed the gate"
      // even when the true crossing point was well inside it.
      const crossingEast = interpolateEastAt(prevNorth, prevEast, this.north, this.east, this.gateTargetLocal.north);
      // Projected onto the TRUE committeeFinishLocal<->finishLocal segment
      // (projectFraction), not an assumed scalar bound - see the
      // constructor's comment on why pin/committeeStart/committeeFinish/
      // finish can't be assumed to sit at simple offsets from the beat
      // axis once edited independently. This is also what actually matters
      // for the base station's own lap detection (finishLineWatcher.js,
      // watching the boat's real transmitted fixes) to agree with what the
      // simulator itself thinks happened.
      const t = projectFraction(this.committeeFinishLocal, this.finishLocal, {
        north: this.gateTargetLocal.north,
        east: crossingEast,
      });
      const inGate = t >= 0 && t <= 1;
      if (inGate) {
        this.north = this.gateTargetLocal.north;
        this.east = crossingEast;
        // Freeze the heading for the coast below (see coastHeadingDeg's own
        // comment) using headingDeg - the actual heading this very tick's
        // movement just sailed on, computed above BEFORE this snap to the
        // gate's exact position - not a fresh _headingToTarget() call here,
        // which would recompute the bearing to the gate center from a
        // position that's now essentially ON it (dNorth/dEast both near
        // zero, an inherently unstable calculation - the gate center's own
        // north can differ slightly from the exact crossing point's, which
        // was enough to occasionally produce a bearing pointing backward,
        // sending the boat in reverse during what's supposed to be a
        // straight coast past the line). Only needed when that heading was
        // actually computed by steering directly (ordinary fixed-angle
        // tacking already continues correctly on its own - see the field's
        // comment in the constructor).
        if (this.steeringDirect) this.coastHeadingDeg = headingDeg;
        this.steeringDirect = false;
        this.crossedLineThisLeg = true;
        this.lapsCompleted++;
        this.emit('lap', { lap: this.lapsCompleted, inGate: true, eastM: crossingEast });
        if (this.lapsCompleted >= this.lapTarget) {
          // Race is over - start coasting (see above) instead of planning
          // another leg toward the windward mark.
          this.finishCoastRemainingM = FINISH_COAST_M;
        } else {
          // More laps to go. Don't immediately recompute toward the
          // windward mark - legRemainingM is already ~0 here (this leg's
          // target WAS the gate it just reached), so without this the very
          // next tick's legRemainingM<=0 check would call _startNewLeg()
          // anyway, effectively forcing a tack right at the line every lap.
          // Coast on the current tack for a bit first instead, same idea as
          // FINISH_COAST_M for the final crossing - see _tick()'s handling
          // of lapCoastRemainingM below.
          this.lapCoastRemainingM = randRange(LAP_COAST_MIN_M, LAP_COAST_MAX_M);
        }
      } else {
        // Would cross the line, but outside the finish gate (the start
        // side, or beyond either mark) - not a valid finish. Roll back to
        // the pre-tick position (still short of the line) rather than
        // commit to this crossing.
        this.north = prevNorth;
        this.east = prevEast;
        // Forces guaranteed convergence directly rather than calling
        // _startNewLeg() (which would re-run the normal two-tack solve and
        // could pick the same corrective tack again - exactly what led to
        // this rejected crossing in the first place, recomputing the same
        // answer from essentially the same position and getting cut off
        // the same way every retry, a permanent stall, confirmed live).
        // This path should be rare - the two-tack solve's own corrective
        // tack is sized to reach the layline without overshooting past the
        // threshold, so the normal approach shouldn't reach here at all -
        // so the pinch this can require is an acceptable, bounded recovery
        // cost for a case that shouldn't come up often, not the normal
        // sailing behavior.
        this.steeringDirect = true;
        this.legRemainingM = Infinity;
        this.coastHeadingDeg = null;
      }
    } else if (
      this.finishCoastRemainingM == null &&
      this.clearingHeadingDeg == null &&
      this.phase === 'downwind' &&
      !this.crossedLineThisLeg &&
      this._pendingStripTriggerNorths().some((n) => this.north < n)
    ) {
      // Start side (pin<->committeeStartLocal) and finish side
      // (committeeFinishLocal<->finishLocal) can now sit at different
      // norths (committeeFinish may be offset from committeeStart - see
      // course.js) - no longer one continuous strip at a single latitude,
      // so each side gets its own independent crossing check at its own
      // threshold (see module comment). Whichever is further north is
      // reached first while descending - sorted so `segments[0]` below is
      // always that one; the tick truncates its movement to that segment's
      // own crossing point (same "don't overshoot past a precisely-checked
      // point" idea as every other line-related event in this file), and
      // marks it passed (passedStartSide/passedFinishSide) so a later tick
      // picks up the OTHER segment once the boat actually reaches it,
      // rather than assuming both happen the same tick.
      const segments = [
        { aLocal: this.pinLocal, bLocal: this.committeeStartLocal, triggerNorth: this.committeeStartLocal.north, passedKey: 'passedStartSide' },
        { aLocal: this.committeeFinishLocal, bLocal: this.finishLocal, triggerNorth: this.committeeFinishLocal.north, passedKey: 'passedFinishSide' },
        // The gap between the two committee boats themselves - not a legal
        // way through the complex either (see the constructor's own
        // comment on passedMiddleSection).
        {
          aLocal: this.committeeStartLocal,
          bLocal: this.committeeFinishLocal,
          triggerNorth: this._middleSectionTriggerNorth(),
          passedKey: 'passedMiddleSection',
        },
      ]
        .filter((s) => !this[s.passedKey] && this.north < s.triggerNorth)
        .sort((a, b) => b.triggerNorth - a.triggerNorth);
      const seg = segments[0];

      // Same interpolation as the upwind gate check above, just at this
      // segment's own threshold north instead of a single shared one.
      const crossingEast = interpolateEastAt(prevNorth, prevEast, this.north, this.east, seg.triggerNorth);
      const inStrip = this._inLocalStrip(seg.triggerNorth, crossingEast);
      if (inStrip) {
        // Avoiding the strip is a hard requirement - the crossing point
        // itself is inside it, so it can't be committed to even as a
        // transient position (unlike the clean-crossing case below, this
        // one rolls back to prevNorth/prevEast, still on the correct side
        // of the line, rather than snapping to the violating point and
        // correcting from there - that would still report one fix sitting
        // inside the forbidden strip before ever redirecting).
        this.north = prevNorth;
        this.east = prevEast;
        // The clearing leg below runs for multiple ticks with the crossing
        // check itself switched off (see clearingHeadingDeg!=null in the
        // phase-management chain above) - it doesn't re-check against
        // anything while under way. Clearing toward whichever edge of just
        // THIS segment was nearer (the original approach) sized the leg to
        // dodge only the segment that happened to trigger it - if another
        // pending segment's own east-range overlapped the path to that
        // edge, the leg could sail straight through THAT one instead, with
        // no check left running to catch it (confirmed live: a boat
        // clearing the committeeStart<->committeeFinish gap sailing
        // straight through the actual finish gate a moment later). Sized
        // against the UNION of every still-pending segment's east-range
        // instead - once east clears past the far side of all of them at
        // once, the leg can't still be sailing through any of them,
        // regardless of which one's own north threshold triggered it.
        const pending = [
          { aLocal: this.pinLocal, bLocal: this.committeeStartLocal, passedKey: 'passedStartSide' },
          { aLocal: this.committeeFinishLocal, bLocal: this.finishLocal, passedKey: 'passedFinishSide' },
          { aLocal: this.committeeStartLocal, bLocal: this.committeeFinishLocal, passedKey: 'passedMiddleSection' },
        ].filter((s) => !this[s.passedKey]);
        const minEast = Math.min(...pending.map((s) => Math.min(s.aLocal.east, s.bLocal.east)));
        const maxEast = Math.max(...pending.map((s) => Math.max(s.aLocal.east, s.bLocal.east)));
        const distToMax = maxEast - crossingEast;
        const distToMin = crossingEast - minEast;
        this.clearingDirection = distToMax <= distToMin ? 1 : -1;
        // sin(180+x) = -sin(x) - a lean off the downwind base heading (180)
        // moves east/west opposite of the same lean off the upwind base
        // (0), so clearingDirection needs a flipped sign here to still mean
        // "+1 -> increasing east" (see _startNewLeg's signCorrection for
        // the same issue elsewhere in this file).
        const downwindBaseDeg = (WIND_FROM_DEG + 180) % 360;
        this.clearingHeadingDeg = (downwindBaseDeg - this.clearingDirection * DOWNWIND_CLEAR_HEAD_UP_DEG + 360) % 360;
        this.clearingTargetEastM =
          this.clearingDirection === 1 ? maxEast + DOWNWIND_CLEAR_MARGIN_M : minEast - DOWNWIND_CLEAR_MARGIN_M;
        this.clearingIsLineCross = true;
        // Remembered so the clearing-leg completion handler (_tick()'s
        // clearingHeadingDeg!=null branch, a later tick) can mark every
        // segment this leg was actually sized to clear as passed, not just
        // the one that triggered it.
        this.clearingSegmentPassedKeys = pending.map((s) => s.passedKey);
        this.timeSinceManeuverS = 0;
      } else {
        this.north = seg.triggerNorth;
        this.east = crossingEast;
        this[seg.passedKey] = true;
        // Only fully past the start/finish complex (and thus done checking
        // for this leg) once EVERY segment has been cleared - if the other
        // one is still ahead (still unpassed), stay in this phase without
        // calling _startNewLeg(), so the boat just keeps sailing its
        // current tack and this check naturally re-fires once it reaches
        // the remaining segment's own threshold on a later tick.
        if (this._pendingStripTriggerNorths().length === 0) {
          this.crossedLineThisLeg = true; // doesn't count a lap, just marks the crossing handled
          this._startNewLeg();
        }
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
      // Real GPS hardware's timestamp is now GPS-derived, not local-clock
      // (see ubxParser.js's own comment) - receivedAt is the field
      // staleness checks actually want, so the simulator emits both, same
      // shape as a real fix.
      receivedAt: Date.now(),
    });

    if (this.finishCoastRemainingM != null && this.finishCoastRemainingM <= 0) {
      this.finished = true;
      this.stop();
      this.emit('finished', { laps: this.lapsCompleted });
    }
  }
}

module.exports = { SimGpsSource };
