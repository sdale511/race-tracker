#include "thin_fixes.h"

#include <cmath>
#include <limits>

namespace rover {

namespace {
constexpr double M_PER_DEG = 111320;
constexpr double GAP_WEIGHT_M_PER_MS = 0.0004;
constexpr double INF = std::numeric_limits<double>::infinity();
}  // namespace

std::vector<Pvt> thinForTurns(const std::vector<Pvt>& list, size_t cap, const Pvt* anchor, double maxGapMs, const ProtectFn& protect,
                              bool strictGap) {
  if (list.size() <= cap) return list;
  std::vector<Pvt> kept;
  if (anchor) kept.push_back(*anchor);
  kept.insert(kept.end(), list.begin(), list.end());
  const size_t first = anchor ? 1 : 0;
  const double cosLat = std::cos((list.back().lat * M_PI) / 180);
  auto x = [&](const Pvt& f) { return f.lon * M_PER_DEG * cosLat; };
  auto y = [&](const Pvt& f) { return f.lat * M_PER_DEG; };
  size_t toRemove = list.size() - cap;

  auto costOf = [&](size_t i, bool ignoreGap, bool ignoreProtect) {
    if (!ignoreProtect && protect && protect(kept[i])) return INF;
    const Pvt &a = kept[i - 1], &b = kept[i], &c = kept[i + 1];
    const double span = (double)(c.timestamp - a.timestamp);
    if (!ignoreGap && span > maxGapMs) return INF;
    const double ax = x(a), ay = y(a), bx = x(b), by = y(b), cx = x(c), cy = y(c);
    const double dx = cx - ax, dy = cy - ay;
    const double len = std::hypot(dx, dy);
    const double dev = len < 1e-6 ? std::hypot(bx - ax, by - ay) : std::fabs(dx * (by - ay) - dy * (bx - ax)) / len;
    return dev + GAP_WEIGHT_M_PER_MS * span;
  };

  while (toRemove-- > 0) {
    long best = -1;
    double bestCost = INF;
    const size_t from = first > 1 ? first : 1;
    for (size_t i = from; i + 1 < kept.size(); i++) {
      const double c = costOf(i, false, false);
      if (c < bestCost) {
        bestCost = c;
        best = (long)i;
      }
    }
    if (best < 0 && strictGap) break;
    if (best < 0)
      for (size_t i = from; i + 1 < kept.size(); i++) {
        const double c = costOf(i, true, false);
        if (c < bestCost) {
          bestCost = c;
          best = (long)i;
        }
      }
    if (best < 0)
      for (size_t i = from; i + 1 < kept.size(); i++) {
        const double c = costOf(i, true, true);
        if (c < bestCost) {
          bestCost = c;
          best = (long)i;
        }
      }
    if (best < 0) break;
    kept.erase(kept.begin() + best);
  }
  if (anchor) kept.erase(kept.begin());
  return kept;
}

std::vector<Pvt> thinBackfill(const std::vector<Pvt>& held, const ProtectFn& protect, double maxGapMs) {
  if (held.size() < 3) return held;
  return thinForTurns(held, 2, nullptr, maxGapMs, protect, true);
}

}  // namespace rover
