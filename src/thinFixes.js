// Picks which fixes to send when a cycle has more than the slot can carry (the rest stay on the SD card). Instead of
// spreading the kept fixes evenly, it drops the fixes that matter least to the shape of the track: the one that lies
// closest to the line between its neighbours goes first, so a straight leg is thinned hard and a turn keeps its
// fixes (a mark rounding, a tack, a gybe). Among near-equal candidates it prefers to open the smallest time gap, so
// straight legs still come out evenly spaced. No kept fix is ever more than maxGapMs after the one before it (a
// delta frame cannot span more than 510 ms without starting a new frame) unless the cap makes that impossible.
// `protect(fix)` marks fixes (those near a course mark) that go last, after everything else has been thinned.

const M_PER_DEG = 111320;
const GAP_WEIGHT_M_PER_MS = 0.0004; // a 100 ms difference in the gap that removal opens weighs the same as 4 cm of deviation

// `list` oldest first, fixes with { timestamp (ms), lat, lon (degrees) }. `anchor` is the last fix already sent
// (or null): it is not part of the result but keeps the first fix in the list from being judged without a neighbour.
function thinForTurns(list, cap, { anchor = null, maxGapMs = 480, protect = null } = {}) {
  if (list.length <= cap) return list;
  const kept = anchor ? [anchor, ...list] : list.slice();
  const first = anchor ? 1 : 0; // index below which nothing may be removed
  const cosLat = Math.cos((list[list.length - 1].lat * Math.PI) / 180);
  const xy = (f) => [f.lon * M_PER_DEG * cosLat, f.lat * M_PER_DEG];
  let toRemove = list.length - cap;

  const costOf = (i, ignoreGap, ignoreProtect) => {
    if (!ignoreProtect && protect && protect(kept[i])) return Infinity;
    const a = kept[i - 1], b = kept[i], c = kept[i + 1];
    const span = c.timestamp - a.timestamp;
    if (!ignoreGap && span > maxGapMs) return Infinity;
    const [ax, ay] = xy(a), [bx, by] = xy(b), [cx, cy] = xy(c);
    const dx = cx - ax, dy = cy - ay;
    const len = Math.hypot(dx, dy);
    const dev = len < 1e-6 ? Math.hypot(bx - ax, by - ay) : Math.abs(dx * (by - ay) - dy * (bx - ax)) / len;
    return dev + GAP_WEIGHT_M_PER_MS * span;
  };

  while (toRemove-- > 0) {
    let best = -1, bestCost = Infinity;
    for (let i = Math.max(first, 1); i < kept.length - 1; i++) {
      const c = costOf(i, false);
      if (c < bestCost) { bestCost = c; best = i; }
    }
    if (best < 0) {
      for (let i = Math.max(first, 1); i < kept.length - 1; i++) {
        const c = costOf(i, true);
        if (c < bestCost) { bestCost = c; best = i; }
      }
    }
    if (best < 0) {
      for (let i = Math.max(first, 1); i < kept.length - 1; i++) {
        const c = costOf(i, true, true);
        if (c < bestCost) { bestCost = c; best = i; }
      }
    }
    if (best < 0) break;
    kept.splice(best, 1);
  }
  return anchor ? kept.slice(1) : kept;
}

module.exports = { thinForTurns };
