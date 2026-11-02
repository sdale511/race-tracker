// Which fixes to send when a cycle has more than the slot can carry - a port of src/thinFixes.js: the fix closest to the line between
// its neighbours goes first, so straight legs are thinned and turns keep their fixes.
#pragma once

#include <functional>
#include <vector>

#include "pvt.h"

namespace rover {

using ProtectFn = std::function<bool(const Pvt&)>;

std::vector<Pvt> thinForTurns(const std::vector<Pvt>& list, size_t cap, const Pvt* anchor = nullptr, double maxGapMs = 480,
                              const ProtectFn& protect = nullptr, bool strictGap = false);
std::vector<Pvt> thinBackfill(const std::vector<Pvt>& held, const ProtectFn& protect = nullptr, double maxGapMs = 500);

}  // namespace rover
