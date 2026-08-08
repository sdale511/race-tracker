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
// complex). The simulator always races the green marks (see
// boatAgent.js/simGps.js) - black marks are published for reference only,
// same as pin/committee/finish are never targeted by the tacking logic
// directly.
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
function getStartPosition(slotIndex, geometry) {
  const { startLineNorthM, startSideLengthM, boatStartSpacingM } = geometry;
  const maxSlots = Math.max(1, Math.floor(startSideLengthM / boatStartSpacingM));
  const wrappedSlot = slotIndex % maxSlots;
  return {
    north: startLineNorthM,
    east: -startSideLengthM + boatStartSpacingM / 2 + wrappedSlot * boatStartSpacingM,
  };
}

// Derives the course's actual geometry by measuring the marks themselves,
// rather than trusting this process's own SIM_COURSE_LENGTH_NM to agree
// with whatever course was actually published to Redis - marks could have
// been published earlier by a *different* process running at a different
// course length (or, on a real boat, by an actual race operator who set
// them some other way entirely). Every simulator-side geometry decision
// (tacking, mark rounding, gate targeting) should follow whatever the marks
// actually say, not this process's own environment - that's the only way
// a boat and the marks it's racing against are guaranteed to agree. Always
// measured off the green marks - the simulator never races the black
// (long-course) marks, see getMarks' own comment.
function deriveGeometry(marks) {
  const courseLengthM = distanceMeters(marks.leewardGreen, marks.windwardGreen);
  const startLineNorthM = distanceMeters(marks.leewardGreen, marks.committee);
  const startSideLengthM = distanceMeters(marks.committee, marks.pin);
  const finishSideLengthM = distanceMeters(marks.committee, marks.finish);
  // Boat-to-boat start spacing isn't a mark - keep it proportional to the
  // measured course length (same ratio as getMarks uses when first
  // defining a course), so it still makes sense at whatever scale the
  // marks turn out to be.
  const boatStartSpacingM = courseLengthM * ((25 * FEET_TO_M) / NM_TO_M);
  return { courseLengthM, startLineNorthM, startSideLengthM, finishSideLengthM, boatStartSpacingM };
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
  getMarks,
  getStartPosition,
  deriveGeometry,
};
