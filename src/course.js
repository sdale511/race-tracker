// Shared windward-leeward course geometry. Used by both the boat simulator
// (simGps.js, so the boats actually round the marks) and the base station
// (to publish the marks' real lat/lon into Redis) - centralized here so
// both always agree on exactly where the marks are, rather than each
// computing its own copy of the same math.
const METERS_PER_DEG_LAT = 111320;
const NM_TO_M = 1852;

// Windward mark sits due north of the leeward mark (course laid square to
// the wind, the usual convention). COURSE_LENGTH_NM is the OVERALL
// leewardBlack<->windwardBlack distance - so a full lap on the long course
// (leeward -> windward -> leeward) is roughly 2 * COURSE_LENGTH_NM.
// SIM_COURSE_LENGTH_NM shortens this for quick testing (a full 1nm beat/run
// takes several real minutes even at raised sim speeds) - read directly
// here rather than via config.js since this fixes the course geometry once
// at process start for both boatAgent.js and baseStation.js, same as every
// other constant in this file.
const COURSE_LENGTH_NM = parseFloat(process.env.SIM_COURSE_LENGTH_NM || '1');
const COURSE_LENGTH_M = COURSE_LENGTH_NM * NM_TO_M;
const WIND_FROM_DEG = 0; // wind blows from true north, down the course axis

const FEET_TO_M = 0.3048;

// Real committee-run courses typically lay out two windward marks and two
// leeward marks on the same north-south axis - a closer "green" pair (the
// short course) and a further-out "black" pair (the long course), so the
// committee can call either course depending on conditions without
// re-laying marks. The green pair isn't independently configurable - there's
// no separate "how far apart are the green marks" knob to set, they're
// always exactly halfway between the center and their respective black mark
// (see getMarks below), so shortening SIM_COURSE_LENGTH_NM shrinks both
// pairs together, in the same fixed 2:1 proportion, with no separate
// setting that could put them out of that proportion. Which pair the
// simulator actually races is configurable per end (SIM_COURSE_MARKS, see
// config.js/deriveGeometry/getRaceMarks below) - pin/committeeStart/
// committeeFinish/finish are never targeted by the tacking logic directly,
// regardless.

// The start/finish complex used to be a single "committee" mark shared by
// both lines (pin<->committee for the start, committee<->finish for the
// finish gate) - split into committeeStart/committeeFinish so a real
// operator can run the two lines from separate committee boats, not just
// two ends of the same physical line. committeeFinish sits straight east of
// committeeStart (same north - the finish line doesn't sit anywhere
// different along the beat than the start line, just off to the side) by
// this one distance. Defaults to 6m, not 0 - a real committeeStart<->
// committeeFinish gap exists out of the box, matching two actually-separate
// committee boats (the realistic case) instead of one physically
// impossible zero-length segment. foulWatcher.js's "through committee gap"
// foul, and SIM_FOUL's own third crossing (see simGps.js's
// _foulWaypoints), both need a real gap to have anything to detect/cross -
// previously that required explicitly setting this, easy to forget and
// silently get zero gap fouls instead. Set SIM_COMMITTEE_GAP_M=0
// explicitly to go back to a single shared committee mark.
const COMMITTEE_GAP_M = parseFloat(process.env.SIM_COMMITTEE_GAP_M || '6');

// Canonical mark list/order - shared by redisStore.js (Redis key names),
// protocol.js (the base's mark-broadcast radio frame), and getMarks() below,
// so there's exactly one place that says what marks exist and in what order.
const MARK_NAMES = [
  'windwardGreen',
  'windwardBlack',
  'leewardGreen',
  'leewardBlack',
  'pin',
  'committeeStart',
  'committeeFinish',
  'finish',
];

// Redis key name for the pin boundary gate's computed, published endpoint -
// see getPinBoundaryFarPoint below. Not one of the real MARK_NAMES: nothing
// ever sets this by dragging it on the map, it's derived automatically
// (from pin/committeeStart, whenever the operator's "pin boundary gate"
// checkbox - see adminServer.js - is on) and republished any time pin,
// committeeStart, or the checkbox itself changes. Published under this
// mark:* key anyway so RegattaUp's own saveRaceMarks function (which
// generically scans every mark:* key in Redis, no hardcoded list) picks it
// up and can draw the gate on its own map with zero backend changes there -
// see redisStore.js's setMark/deleteMark calls for it.
const PIN_BOUNDARY_MARK = 'pinBoundary';

// How far past pin the gate's published/rendered endpoint reaches, continuing
// the committeeStart->pin bearing - i.e. the start line's own axis, extended
// outward. The actual foul/avoidance logic (foulWatcher.js's segment
// intersection test) needs a real, finite endpoint to test against - a
// literal Infinity would break that math - but the gate is meant to be
// effectively indefinite (no racer should be able to sail around it,
// regardless of course size), so this reaches WAY past anything a boat could
// plausibly need to clear: 50x the start line's own length, floored at 500m
// so an unusually short line still gets a gate that's clearly not just "a
// bit past pin." simGps.js's own avoidance doesn't use this at all - it
// checks the true unbounded ray directly (see its own comment) - this is
// only for foulWatcher.js's segment test and for drawing/publishing the gate
// somewhere concrete on a map.
const PIN_BOUNDARY_REACH_MULTIPLIER = 50;
const PIN_BOUNDARY_MIN_REACH_M = 500;

// Fixed per-mark colors, shared between the base and rover admin
// dashboards' map pages (adminServer.js, roverAdminServer.js) so markers
// stay visually consistent between the two. Green/black marks are colored
// to match their real on-the-water color, not an arbitrary UI choice - a
// green windward and green leeward mark are the same color for the same
// reason they are on the water: position (top vs bottom of the course)
// tells them apart, not color.
const MARK_COLORS = {
  windwardGreen: '#3fb950',
  windwardBlack: '#000000',
  leewardGreen: '#3fb950',
  leewardBlack: '#000000',
  pin: '#e3b341',
  committeeStart: '#bc8cff',
  committeeFinish: '#a371f7',
  finish: '#58a6ff',
  // Red, not one of the other marks' own hues - this is a no-go boundary,
  // not a mark boats round or a line they start/finish across, and red is
  // this app's existing "alert" color elsewhere (dashboardFormat.js's disk
  // card, adminServer.js's dot-red).
  pinBoundary: '#f85149',
};

// A pure black dot/marker would disappear against this app's dark UI (map
// tiles, dashboard cards) - black marks get a light stroke so they stay
// visible; every other mark's stroke just matches its own fill, which
// renders as no visible border at all.
function markStroke(name) {
  return name.endsWith('Black') ? '#e6e9ef' : MARK_COLORS[name];
}

// Where the start/finish complex sits along the beat, as a percentage of
// the overall (black) course: 0 = right at leewardBlack, 100 = right at
// windwardBlack, 50 (the default) = dead center - equidistant from both the
// green AND the black windward/leeward marks (see getMarks below). A
// percentage rather than a fixed distance so it stays proportionally in the
// same place as SIM_COURSE_LENGTH_NM changes the overall course length,
// same reasoning as START_SIDE_LENGTH_M/FINISH_SIDE_LENGTH_M below being
// fractions rather than fixed distances. Two independent committee boats
// (committeeStart, committeeFinish) instead of one shared mark - the usual
// reason a committee runs two lines: starts and finishes don't cross paths
// at the same line, and a real operator may run them from two entirely
// different boats/positions, not just two ends of one physical line.
//   - "start side": pin <-> committeeStart, boats start spread out along this.
//   - "finish side": committeeFinish <-> finish, boats must cross through
//     this gate each lap to have it count (see simGps.js).
const START_LINE_POSITION = parseFloat(process.env.SIM_START_LINE_POSITION || '50');
if (!Number.isFinite(START_LINE_POSITION) || START_LINE_POSITION < 0 || START_LINE_POSITION > 100) {
  throw new Error(`SIM_START_LINE_POSITION must be a number 0-100 (percent up the course) - got "${process.env.SIM_START_LINE_POSITION}"`);
}
// -COURSE_LENGTH_M/2 (leewardBlack) at 0%, +COURSE_LENGTH_M/2 (windwardBlack)
// at 100%.
const START_LINE_NORTH_M = (START_LINE_POSITION / 100) * COURSE_LENGTH_M - COURSE_LENGTH_M / 2;
// START_SIDE_LENGTH_M/FINISH_SIDE_LENGTH_M/BOAT_START_SPACING_M are
// expressed as fractions of COURSE_LENGTH_M (matching their real
// 200ft/180ft/25ft proportions at the canonical 1nm course) rather than
// fixed distances - fixed absolute values would keep the start/finish
// line's own width constant even as SIM_COURSE_LENGTH_NM shrinks the beat/
// run length around it, which breaks down once the two become comparable
// (e.g. at a very short test course, a fixed ~180ft-wide gate can end up
// wider than the beat itself, well past anything the tacking logic in
// simGps.js was tuned to handle). Scaling together keeps the same
// qualitative geometry - and the same tacking behavior - at any course
// length.
const START_SIDE_LENGTH_M = COURSE_LENGTH_M * ((200 * FEET_TO_M) / NM_TO_M);
const FINISH_SIDE_LENGTH_M = COURSE_LENGTH_M * ((180 * FEET_TO_M) / NM_TO_M);
const BOAT_START_SPACING_M = COURSE_LENGTH_M * ((25 * FEET_TO_M) / NM_TO_M); // boats start proportionally spaced, from the pin end

function offsetToLatLon(centerLat, centerLon, { north, east }) {
  const lat = centerLat + north / METERS_PER_DEG_LAT;
  const lon = centerLon + east / (METERS_PER_DEG_LAT * Math.cos((centerLat * Math.PI) / 180));
  return { lat, lon };
}

// Inverse of offsetToLatLon's flat-earth approximation - distance in meters
// between two lat/lon points, fine at course-length scales.
function distanceMeters(a, b) {
  const north = (b.lat - a.lat) * METERS_PER_DEG_LAT;
  const east = (b.lon - a.lon) * METERS_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt(north * north + east * east);
}

// Compass bearing (degrees, 0=north, clockwise) from point a to point b -
// same flat-earth approximation as distanceMeters above, fine at
// course-length scales. deriveGeometry uses this so the simulator sails
// toward wherever the windward mark actually is, not wherever it would be
// if it were still due north of leeward - an operator can drag it (or any
// mark) anywhere via the map's "edit marks" column (see adminServer.js),
// and getMarks' own "due north" layout is only the *initial* generated
// position, not a standing assumption the rest of the app can keep making.
function bearingDeg(a, b) {
  const north = (b.lat - a.lat) * METERS_PER_DEG_LAT;
  const east = (b.lon - a.lon) * METERS_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180);
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}

// The pin boundary gate's far endpoint - continuing the committeeStart->pin
// bearing (the start line's own axis) outward past pin by PIN_BOUNDARY_
// REACH_MULTIPLIER x the line's own length (floored at PIN_BOUNDARY_MIN_
// REACH_M) - see those constants' own comment. Purely a derived value, never
// stored as anything an operator can independently edit: baseStation.js
// recomputes and republishes it fresh any time pin, committeeStart, or the
// pin-boundary checkbox itself changes, so it's never at risk of going stale
// against wherever those two marks actually are right now.
function getPinBoundaryFarPoint(pin, committeeStart) {
  const bearing = bearingDeg(committeeStart, pin);
  const reachM = Math.max(distanceMeters(pin, committeeStart) * PIN_BOUNDARY_REACH_MULTIPLIER, PIN_BOUNDARY_MIN_REACH_M);
  const bearingRad = (bearing * Math.PI) / 180;
  return offsetToLatLon(pin.lat, pin.lon, { north: reachM * Math.cos(bearingRad), east: reachM * Math.sin(bearingRad) });
}

// Standard 16-point compass rose abbreviation for a bearingDeg() result -
// used by the map pages' course-info card (adminServer.js/
// roverAdminServer.js) to show "11° N" / "15° NNE" alongside the raw
// degrees, not just the number. Each point spans 22.5 degrees, centered on
// its own exact heading (N centered on 0, NNE on 22.5, ...), so the
// boundary between two points sits at odd multiples of 11.25.
const COMPASS_POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
function compassDir(bearingDegrees) {
  const index = Math.round(bearingDegrees / 22.5) % 16;
  return COMPASS_POINTS[index];
}

// The configured center point (SIM_CENTER_LAT/LON) is the true geometric
// center of the whole course - equidistant from leewardBlack/windwardBlack
// AND from leewardGreen/windwardGreen, and where the start/finish complex
// sits by default (SIM_START_LINE_POSITION=50, i.e. dead center - see its
// own comment above for the other positions). Black windward/leeward sit
// COURSE_LENGTH_M/2 on either side of it (the long course, the overall
// length SIM_COURSE_LENGTH_NM actually sets); green windward/leeward are
// NOT independently configurable - they always sit exactly halfway between
// the center and their respective black mark (COURSE_LENGTH_M/4 on either
// side), so the short course is always exactly half the long course's
// length, no separate knob to put the two pairs out of that proportion.
// `committeeStart` sits on the same axis at START_LINE_NORTH_M; `pin` is
// START_SIDE_LENGTH_M to its west. `committeeFinish` sits COMMITTEE_GAP_M
// straight east of committeeStart, same north - two actually-separate
// committee boats side by side, not one shared mark; explicitly zero it to
// go back to co-located - `finish` is FINISH_SIDE_LENGTH_M further east of
// *that*, so the whole finish gate moves as a unit when the committee gap
// changes, rather than the gate's own width changing.
function getMarks(centerLat, centerLon) {
  return {
    leewardGreen: offsetToLatLon(centerLat, centerLon, { north: -COURSE_LENGTH_M / 4, east: 0 }),
    leewardBlack: offsetToLatLon(centerLat, centerLon, { north: -COURSE_LENGTH_M / 2, east: 0 }),
    windwardGreen: offsetToLatLon(centerLat, centerLon, { north: COURSE_LENGTH_M / 4, east: 0 }),
    windwardBlack: offsetToLatLon(centerLat, centerLon, { north: COURSE_LENGTH_M / 2, east: 0 }),
    committeeStart: offsetToLatLon(centerLat, centerLon, { north: START_LINE_NORTH_M, east: 0 }),
    pin: offsetToLatLon(centerLat, centerLon, { north: START_LINE_NORTH_M, east: -START_SIDE_LENGTH_M }),
    committeeFinish: offsetToLatLon(centerLat, centerLon, { north: START_LINE_NORTH_M, east: COMMITTEE_GAP_M }),
    finish: offsetToLatLon(centerLat, centerLon, { north: START_LINE_NORTH_M, east: COMMITTEE_GAP_M + FINISH_SIDE_LENGTH_M }),
  };
}

// How much of the pin<->committeeStart line simulated boats can spread
// across. Used to be capped at 0.4 (the pin half) specifically to stay
// clear of onGridWatcher.js's own COMMITTEE_TRIANGLE_MAX_FRACTION (0.5,
// base-station-only ambiguous-with-a-finishing-boat zone) - back when a
// single shared committee mark meant a boat queuing near it could look like
// one finishing. Now that start and finish each have their own mark, that
// specific ambiguity is gone by construction, but the fraction stays at 1
// (full line) regardless - real test lines can be short (tens of meters),
// and a large simulated fleet needs the room.
const SIM_START_SAFE_MAX_FRACTION = 1;

// How far, in real meters, a boat's start position stays clear of EITHER
// end of the pin<->committeeStart line - not just the committeeStart end.
// A boat sitting essentially AT committeeStart can fall inside
// onGridWatcher.js's own committee-corner exclusion (a real ambiguity zone,
// not a bug - see its own HYPOTENUSE_ANGLE_DEG/onGridZoneM), and a boat
// sitting essentially AT pin has similarly little headroom against
// _isInZone's own small edge margin; keeping the whole fleet a fixed
// real-world distance off both ends avoids either regardless of how long
// the line actually is. 20m comfortably clears onGridWatcher's own default
// exclusion reach (onGridZoneM=10, HYPOTENUSE_ANGLE_DEG=25 -> ~21.5m) with
// a small margin, without needing this file to import that file's own
// constants just to stay in sync - if onGridZoneM is configured much
// larger than its own default, REGATTAUP_ONGRID_ZONE_M's own operator can
// raise this to match. Starting conservative (5m, not the ~21.5m that
// would fully guarantee clearing the default exclusion) - wide enough to
// keep boats visibly off the marks themselves without eating too much of
// a short line's own spread; raise it if boats are still landing inside
// the exclusion zone in practice.
const SIM_START_LINE_END_MARGIN_M = parseFloat(process.env.SIM_START_LINE_END_MARGIN_M || '5');

// Returns a 0 (pin) to 1 (committeeStart) FRACTION along the line, not an
// absolute north/east - unlike windward/leeward (always exactly on
// simGps.js's own rotated local-north axis, by definition of how that
// rotation is derived), pin/committeeStart can be edited independently of
// the beat axis (see adminServer.js's "edit marks" column) and end up
// anywhere. simGps.js interpolates this fraction against pin/committeeStart's
// own true local positions (each independently measured, not assumed),
// so a boat's start position stays correct regardless.
//
// frac (0-1) is boatAgent.js's own call: this boat's index/fleetSize when
// spawned as part of a fleet (even spacing across the whole fleet, no
// collision risk at all) or a random draw when running standalone - either
// way, purely a fraction-of-safe-zone by the time it reaches here, this
// function's only job is confining it to that zone. An earlier version
// instead took a raw slot number and quantized it into a small fixed count
// of discrete, realistically-spaced (25ft) positions - fine for a couple of
// boats, but a larger simulated fleet (fleetSim.js routinely runs 20-30)
// wrapped around and landed many boats on an EXACT duplicate of an earlier
// boat's position, not just visually close.
//
// lineLenM (the real, measured pin<->committeeStart distance - simGps.js
// has this on hand already, from the same local positions it uses for
// everything else) converts SIM_START_LINE_END_MARGIN_M into a fraction of
// THIS line specifically, then confines the 0..SIM_START_SAFE_MAX_FRACTION
// spread to the sub-range that stays that far off both ends. Capped at 0.45
// per side so a line shorter than 2x the margin still spreads boats across
// its own middle rather than collapsing them onto a single point.
function getStartFraction(frac, lineLenM) {
  const raw = frac * SIM_START_SAFE_MAX_FRACTION;
  if (!lineLenM) return raw; // caller didn't measure a real line - no margin to apply
  const marginFrac = Math.min(0.45, SIM_START_LINE_END_MARGIN_M / lineLenM);
  return marginFrac + raw * (1 - 2 * marginFrac);
}

// Which windward/leeward mark the simulator actually races - see
// config.js's sim.courseMarks. Two letters, windward first, each 'G'
// (green, the short-course mark) or 'B' (black, the long-course mark) - so
// 'GG' is the plain short course, 'BB' the plain long course, and 'BG'/'GB'
// mix a long beat on one end with a short one on the other (a real
// committee-run course with two windward/leeward pairs on the same axis
// supports exactly these combinations, see getMarks' own comment).
const COURSE_MARK_CODE_PATTERN = /^[GB]{2}$/;

// Resolves a two-letter code into the actual mark NAMES to race - a
// separate step from getRaceMarks below so a caller that only needs the
// names (e.g. boatAgent.js's own log line) doesn't need a full marks object
// in hand.
function parseCourseMarks(code) {
  const normalized = (code || 'GG').toUpperCase();
  if (!COURSE_MARK_CODE_PATTERN.test(normalized)) {
    throw new Error(`invalid course mark code "${code}" - must be 2 letters, each G (green) or B (black), e.g. GG/BB/BG/GB`);
  }
  return {
    windwardName: normalized[0] === 'G' ? 'windwardGreen' : 'windwardBlack',
    leewardName: normalized[1] === 'G' ? 'leewardGreen' : 'leewardBlack',
  };
}

// Resolves a two-letter code (see parseCourseMarks above) against an actual
// marks object into the real windward/leeward mark the simulator should
// race this run - used by both deriveGeometry (below) and boatAgent.js
// (which also needs the resolved leeward mark's own lat/lon as
// SimGpsSource's local-frame origin, see its own comment).
function getRaceMarks(marks, code) {
  const { windwardName, leewardName } = parseCourseMarks(code);
  return { windward: marks[windwardName], leeward: marks[leewardName], windwardName, leewardName };
}

// Derives the course's actual geometry by measuring the marks themselves,
// rather than trusting this process's own SIM_COURSE_LENGTH_NM to agree
// with whatever course was actually published to Redis - marks could have
// been published earlier by a *different* process running at a different
// course length (or, on a real boat, by an actual race operator who set
// them some other way entirely). Every simulator-side geometry decision
// (tacking, mark rounding, gate targeting) should follow whatever the marks
// actually say, not this process's own environment - that's the only way
// a boat and the marks it's racing against are guaranteed to agree.
//
// courseMarks (see parseCourseMarks above) picks WHICH windward/leeward
// pair to measure - defaults to 'BB' (the plain long/overall course,
// matching config.js's own default) so any existing caller that doesn't
// pass this gets the actual overall course length. Measuring the actual
// distance/bearing between whichever pair is chosen, rather than assuming
// COURSE_LENGTH_M, is what makes a mixed pair like 'BG' just work: the beat
// comes out shorter on whichever end is actually green, with no separate
// case needed here.
function deriveGeometry(marks, courseMarks = 'BB') {
  const { windward, leeward } = getRaceMarks(marks, courseMarks);
  const courseLengthM = distanceMeters(leeward, windward);
  // The actual compass direction from leeward to windward - NOT assumed to
  // be true north (0). Only the freshly-generated layout (getMarks above)
  // puts them exactly on a north-south axis; once an operator edits a mark,
  // the real bearing can be anything. simGps.js rotates its whole (locally
  // north-relative) tacking model by this before converting to lat/lon, so
  // the simulated boat actually sails toward wherever the real windward
  // mark actually is.
  const courseBearingDeg = bearingDeg(leeward, windward);
  // Only the pin<->committeeStart distance is still needed here (by
  // getStartFraction, for boat start spacing) - simGps.js measures
  // committeeStart/committeeFinish/finish's own true positions directly
  // (see its _toLocal), not via a scalar distance/assumed-perpendicular-
  // offset from this file, so there's no longer a startLineNorthM/
  // finishSideLengthM this module needs to hand it.
  const startSideLengthM = distanceMeters(marks.committeeStart, marks.pin);
  // Boat-to-boat start spacing isn't a mark - keep it proportional to the
  // measured course length (same ratio as getMarks uses when first
  // defining a course), so it still makes sense at whatever scale the
  // marks turn out to be.
  const boatStartSpacingM = courseLengthM * ((25 * FEET_TO_M) / NM_TO_M);
  return { courseLengthM, courseBearingDeg, startSideLengthM, boatStartSpacingM };
}

// Picks the center point a freshly-created course should be built around.
// An operator's explicit SIM_CENTER_LAT/SIM_CENTER_LON always wins (callers
// pass regattaLat/regattaLon as undefined when either env var is set, so
// this just falls through to fallbackLat/fallbackLon - config.js's own
// SIM_CENTER_LAT/LON defaults) - otherwise prefers the currently-selected
// regatta's own venue coordinates (RegattaUp's default_lat/default_lon on
// the regatta entity - see getActiveRegattas) when present and shaped like
// real coordinates. RegattaUp entities are third-party data this app
// doesn't control (a draft regatta can have these unset, or malformed - see
// baseStation.js's own comment on why this is validated at all) - an
// invalid value here falls back to fallbackLat/fallbackLon rather than
// silently building a nonsensical course somewhere off the map.
function resolveCourseCenter(regattaLat, regattaLon, fallbackLat, fallbackLon) {
  if (Number.isFinite(regattaLat) && Number.isFinite(regattaLon) && Math.abs(regattaLat) <= 90 && Math.abs(regattaLon) <= 180) {
    return { lat: regattaLat, lon: regattaLon };
  }
  return { lat: fallbackLat, lon: fallbackLon };
}

module.exports = {
  METERS_PER_DEG_LAT,
  NM_TO_M,
  COURSE_LENGTH_NM,
  COURSE_LENGTH_M,
  COMMITTEE_GAP_M,
  WIND_FROM_DEG,
  START_LINE_POSITION,
  START_LINE_NORTH_M,
  START_SIDE_LENGTH_M,
  FINISH_SIDE_LENGTH_M,
  BOAT_START_SPACING_M,
  MARK_NAMES,
  PIN_BOUNDARY_MARK,
  MARK_COLORS,
  markStroke,
  offsetToLatLon,
  distanceMeters,
  bearingDeg,
  compassDir,
  getMarks,
  getStartFraction,
  getPinBoundaryFarPoint,
  deriveGeometry,
  parseCourseMarks,
  getRaceMarks,
  resolveCourseCenter,
};
