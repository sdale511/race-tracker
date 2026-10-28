// Course marks can be edited outside the base - RegattaUp writes the same Redis keys the base reads at startup. The base
// compares its in-memory marks with Redis every so often (baseStation.js's syncMarksFromRedis); this is the comparison.

// A position within ~1 cm (1e-7 degrees) of the other is the same place. Only lat/lon count: assignedBoatId/assignedAt
// change all the time while a mark-mode rover posts the mark, and are not a move.
const SAME_PLACE_DEG = 1e-7;

function samePlace(a, b) {
  return !!a && !!b && Math.abs(a.lat - b.lat) <= SAME_PLACE_DEG && Math.abs(a.lon - b.lon) <= SAME_PLACE_DEG;
}

// Names (in `names` order) of the marks whose position in `fresh` (from Redis) differs from `current` (in memory).
// A mark Redis does not have is not a change: the base keeps what it knows rather than dropping a mark from the course.
function changedMarks(current, fresh, names) {
  return names.filter((name) => fresh[name] && !samePlace(current[name], fresh[name]));
}

module.exports = { changedMarks, samePlace };
