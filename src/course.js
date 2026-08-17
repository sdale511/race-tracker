// Shared windward-leeward course geometry. Used by both the boat simulator
// (simGps.js, so the boats actually round the marks) and the base station
// (to publish the marks' real lat/lon into Redis) - centralized here so
// both always agree on exactly where the marks are, rather than each
// computing its own copy of the same math.
const METERS_PER_DEG_LAT = 111320;
const NM_TO_M = 1852;

// Windward mark sits due north of the leeward mark (course laid square to
// the wind, the usual convention), COURSE_LENGTH_NM apart one-way - so a
// full lap (leeward -> windward -> leeward) is roughly 2 * COURSE_LENGTH_NM.
// SIM_COURSE_LENGTH_NM shortens this for quick testing (a full 1nm beat/run
// takes several real minutes even at raised sim speeds) - read directly
// here rather than via config.js since this fixes the course geometry once
// at process start for both boatAgent.js and baseStation.js, same as every
// other constant in this file. This is specifically the green-mark
// (short-course) distance - see the windward/leeward pair comment below.
const COURSE_LENGTH_NM = parseFloat(process.env.SIM_COURSE_LENGTH_NM || '1');
const COURSE_LENGTH_M = COURSE_LENGTH_NM * NM_TO_M;
const WIND_FROM_DEG = 0; // wind blows from true north, down the course axis

const FEET_TO_M = 0.3048;

// Real committee-run courses typically lay out two windward marks and two
// leeward marks on the same north-south axis - a closer "green" pair (the
// short course) and a further-out "black" pair (the long course), so the
// committee can call either course depending on conditions without
// re-laying marks. SIM_LONG_COURSE_EXTRA_NM is how much further out the
// black marks sit beyond the green ones, on each end - black windward
// extends COURSE_LENGTH_M + this beyond leewardGreen, black leeward sits
// this far on the far side of leewardGreen (away from the start/finish
// complex). Which pair the simulator actually races is configurable per
// end (SIM_COURSE_MARKS, see config.js/deriveGeometry/getRaceMarks below) -
// pin/committee/finish are never targeted by the tacking logic directly,
// regardless.
const LONG_COURSE_EXTRA_NM = parseFloat(process.env.SIM_LONG_COURSE_EXTRA_NM || '0.25');
const LONG_COURSE_EXTRA_M = LONG_COURSE_EXTRA_NM * NM_TO_M;

// Canonical mark list/order - shared by redisStore.js (Redis key names),
// protocol.js (the base's mark-broadcast radio frame), and getMarks() below,
// so there's exactly one place that says what marks exist and in what order.
const MARK_NAMES = ['windwardGreen', 'windwardBlack', 'leewardGreen', 'leewardBlack', 'pin', 'committee', 'finish'];

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
  committee: '#bc8cff',
  finish: '#58a6ff',
};

// A pure black dot/marker would disappear against this app's dark UI (map
// tiles, dashboard cards) - black marks get a light stroke so they stay
// visible; every other mark's stroke just matches its own fill, which
// renders as no visible border at all.
function markStroke(name) {
  return name.endsWith('Black') ? '#e6e9ef' : MARK_COLORS[name];
}

// The start/finish complex sits halfway between the windward/leeward marks,
// with the committee boat in the middle of two separate sides (perpendicular
// to the course axis, east-west) - the usual reason a committee runs two
// lines: starts and finishes don't cross paths at the same line.
//   - "start side": pin <-> committee, boats start spread out along this.
//   - "finish side": committee <-> finish, boats must cross through this
//     gate each lap to have it count (see simGps.js).
//
// These are expressed as fractions of COURSE_LENGTH_M (matching their real
// 200ft/180ft/25ft proportions at the canonical 1nm course) rather than
// fixed distances - fixed absolute values would keep the start/finish
// line's own width constant even as SIM_COURSE_LENGTH_NM shrinks the beat/
// run length around it, which breaks down once the two become comparable
// (e.g. at a very short test course, a fixed ~180ft-wide gate can end up
// wider than the beat itself, well past anything the tacking logic in
// simGps.js was tuned to handle). Scaling together keeps the same
// qualitative geometry - and the same tacking behavior - at any course
// length.
const START_LINE_NORTH_M = COURSE_LENGTH_M / 2;
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

// The green leeward mark sits exactly at the configured center point
// (SIM_CENTER_LAT/LON) - this is the one point that hasn't moved as this
// function grew from a single windward/leeward pair to green+black pairs,
// so SIM_CENTER_LAT/LON keeps meaning exactly what it always has. Green
// windward is COURSE_LENGTH_M due north of it (the short course); black
// windward/leeward extend LONG_COURSE_EXTRA_M further out on each end (the
// long course), on the same north-south axis. `committee` sits on that
// same axis at the start/finish complex's position (halfway up the green
// course); `pin` is START_SIDE_LENGTH_M to its west (the start side),
// `finish` is FINISH_SIDE_LENGTH_M to its east (the finish side).
function getMarks(centerLat, centerLon) {
  return {
    leewardGreen: offsetToLatLon(centerLat, centerLon, { north: 0, east: 0 }),
    leewardBlack: offsetToLatLon(centerLat, centerLon, { north: -LONG_COURSE_EXTRA_M, east: 0 }),
    windwardGreen: offsetToLatLon(centerLat, centerLon, { north: COURSE_LENGTH_M, east: 0 }),
    windwardBlack: offsetToLatLon(centerLat, centerLon, { north: COURSE_LENGTH_M + LONG_COURSE_EXTRA_M, east: 0 }),
    committee: offsetToLatLon(centerLat, centerLon, { north: START_LINE_NORTH_M, east: 0 }),
    pin: offsetToLatLon(centerLat, centerLon, { north: START_LINE_NORTH_M, east: -START_SIDE_LENGTH_M }),
    finish: offsetToLatLon(centerLat, centerLon, { north: START_LINE_NORTH_M, east: FINISH_SIDE_LENGTH_M }),
  };
}

// Where start slot `slotIndex` (0-based, assigned by registration order via
// redisStore.getOrAssignStartSlot() - NOT the boat's own ID/sail number,
// which could be any value like 51 or 52 and isn't a small sequential
// count) lines up on the start side (pin <-> committee), spaced
// geometry.boatStartSpacingM apart. Shifted inward by half a spacing
// increment so slot 0 starts strictly between the two ends, not sitting
// exactly on top of the pin mark itself.
//
// The slot index itself is registration order since Redis was first asked
// (getOrAssignStartSlot's counter), not "how many boats are racing right
// now" - it only ever grows, so over a long test session with many
// different throwaway boat IDs it can climb well past how many actually
// fit on the line. Wrapped via modulo the number of spacing increments the
// start side actually holds, so a boat always lands somewhere on the real
// line (cycling positions past that point) instead of overflowing out past
// committee or even the finish mark.
//
// Restricts simulated start slots to the pin half of the line, staying
// comfortably clear of onGridWatcher.js's own COMMITTEE_TRIANGLE_MAX_FRACTION
// (0.5, base-station-only - never imported here, this app's boat/sim side
// has no business reaching into base-only detection internals, so this is
// an independently-chosen, deliberately smaller value, not a shared
// constant). That committee-corner exclusion is real and correct - a boat
// genuinely close to committee IS ambiguous with a finishing boat rounding
// it - but a simulated boat's start slot is picked at random with no
// notion of "avoid looking like a finish," so without this, purely by
// chance, some fraction of simulated boats would start in a position the
// on-grid detector is SUPPOSED to treat as ambiguous, and never register
// as on-grid at all - not a detection bug, just bad luck for testing,
// where the whole point is usually "is the fleet on the line," not
// exercising the finish-disambiguation edge case.
const SIM_START_SAFE_MAX_FRACTION = 0.4;

// Returns a 0 (pin) to 1 (committee) FRACTION along the line, not an
// absolute north/east - unlike windward/leeward (always exactly on
// simGps.js's own rotated local-north axis, by definition of how that
// rotation is derived), pin/committee can be edited independently of the
// beat axis (see adminServer.js's "edit marks" column) and end up
// anywhere. simGps.js interpolates this fraction against pin/committee's
// own true local positions (each independently measured, not assumed),
// so a boat's start position stays correct regardless.
function getStartFraction(slotIndex, geometry) {
  const { startSideLengthM, boatStartSpacingM } = geometry;
  const maxSlots = Math.max(1, Math.floor(startSideLengthM / boatStartSpacingM));
  // Confined to SIM_START_SAFE_MAX_FRACTION of the line's own slots (see
  // that constant's own comment) - the modulo wraparound below still maps
  // any slotIndex onto a real, always-on-grid-safe position, it just never
  // reaches the committee half of the line at all.
  const safeMaxSlots = Math.max(1, Math.floor(maxSlots * SIM_START_SAFE_MAX_FRACTION));
  const wrappedSlot = slotIndex % safeMaxSlots;
  return (boatStartSpacingM / 2 + wrappedSlot * boatStartSpacingM) / startSideLengthM;
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
// pair to measure - defaults to 'GG' (the plain short course, the old
// hardcoded behavior) so any existing caller that doesn't pass this keeps
// today's behavior. Measuring the actual distance/bearing between whichever
// pair is chosen, rather than assuming COURSE_LENGTH_M/LONG_COURSE_EXTRA_M,
// is what makes a mixed pair like 'BG' just work: the beat comes out longer
// on whichever end is actually black, with no separate case needed here.
function deriveGeometry(marks, courseMarks = 'GG') {
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
  // Only the pin<->committee distance is still needed here (by
  // getStartFraction, for boat start spacing) - simGps.js measures
  // committee/finish's own true positions directly (see its _toLocal), not
  // via a scalar distance/assumed-perpendicular-offset from this file, so
  // there's no longer a startLineNorthM/finishSideLengthM this module needs
  // to hand it.
  const startSideLengthM = distanceMeters(marks.committee, marks.pin);
  // Boat-to-boat start spacing isn't a mark - keep it proportional to the
  // measured course length (same ratio as getMarks uses when first
  // defining a course), so it still makes sense at whatever scale the
  // marks turn out to be.
  const boatStartSpacingM = courseLengthM * ((25 * FEET_TO_M) / NM_TO_M);
  return { courseLengthM, courseBearingDeg, startSideLengthM, boatStartSpacingM };
}

module.exports = {
  METERS_PER_DEG_LAT,
  NM_TO_M,
  COURSE_LENGTH_NM,
  COURSE_LENGTH_M,
  LONG_COURSE_EXTRA_NM,
  LONG_COURSE_EXTRA_M,
  WIND_FROM_DEG,
  START_LINE_NORTH_M,
  START_SIDE_LENGTH_M,
  FINISH_SIDE_LENGTH_M,
  BOAT_START_SPACING_M,
  MARK_NAMES,
  MARK_COLORS,
  markStroke,
  offsetToLatLon,
  distanceMeters,
  bearingDeg,
  compassDir,
  getMarks,
  getStartFraction,
  deriveGeometry,
  parseCourseMarks,
  getRaceMarks,
};
