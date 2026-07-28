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
const COURSE_LENGTH_NM = 1;
const COURSE_LENGTH_M = COURSE_LENGTH_NM * NM_TO_M;
const WIND_FROM_DEG = 0; // wind blows from true north, down the course axis

const FEET_TO_M = 0.3048;

// The start/finish complex sits halfway between the windward/leeward marks,
// with the committee boat in the middle of two separate sides (perpendicular
// to the course axis, east-west) - the usual reason a committee runs two
// lines: starts and finishes don't cross paths at the same line.
//   - "start side": pin <-> committee, boats start spread out along this.
//   - "finish side": committee <-> finish, boats must cross through this
//     gate each lap to have it count (see simGps.js).
const START_LINE_NORTH_M = COURSE_LENGTH_M / 2;
const START_SIDE_LENGTH_M = 200 * FEET_TO_M;
const FINISH_SIDE_LENGTH_M = 180 * FEET_TO_M;
const BOAT_START_SPACING_M = 25 * FEET_TO_M; // boats start 25ft apart, from the pin end

function offsetToLatLon(centerLat, centerLon, { north, east }) {
  const lat = centerLat + north / METERS_PER_DEG_LAT;
  const lon = centerLon + east / (METERS_PER_DEG_LAT * Math.cos((centerLat * Math.PI) / 180));
  return { lat, lon };
}

// The leeward mark sits at the configured center point (SIM_CENTER_LAT/LON);
// the windward mark is COURSE_LENGTH_M due north of it. `committee` sits on
// the course's rhumb line at the start/finish complex's north position;
// `pin` is START_SIDE_LENGTH_M to its west (the start side), `finish` is
// FINISH_SIDE_LENGTH_M to its east (the finish side).
function getMarks(centerLat, centerLon) {
  return {
    leeward: offsetToLatLon(centerLat, centerLon, { north: 0, east: 0 }),
    windward: offsetToLatLon(centerLat, centerLon, { north: COURSE_LENGTH_M, east: 0 }),
    committee: offsetToLatLon(centerLat, centerLon, { north: START_LINE_NORTH_M, east: 0 }),
    pin: offsetToLatLon(centerLat, centerLon, { north: START_LINE_NORTH_M, east: -START_SIDE_LENGTH_M }),
    finish: offsetToLatLon(centerLat, centerLon, { north: START_LINE_NORTH_M, east: FINISH_SIDE_LENGTH_M }),
  };
}

// Where start slot `slotIndex` (0-based, assigned by registration order via
// redisStore.getOrAssignStartSlot() - NOT the boat's own ID/sail number,
// which could be any value like 51 or 52 and isn't a small sequential
// count) lines up on the start side (pin <-> committee), spaced
// BOAT_START_SPACING_M apart. Shifted inward by half a spacing increment so
// slot 0 starts strictly between the two ends, not sitting exactly on top
// of the pin mark itself.
function getStartPosition(slotIndex) {
  return {
    north: START_LINE_NORTH_M,
    east: -START_SIDE_LENGTH_M + BOAT_START_SPACING_M / 2 + slotIndex * BOAT_START_SPACING_M,
  };
}

module.exports = {
  METERS_PER_DEG_LAT,
  NM_TO_M,
  COURSE_LENGTH_NM,
  COURSE_LENGTH_M,
  WIND_FROM_DEG,
  START_LINE_NORTH_M,
  START_SIDE_LENGTH_M,
  FINISH_SIDE_LENGTH_M,
  BOAT_START_SPACING_M,
  offsetToLatLon,
  getMarks,
  getStartPosition,
};
