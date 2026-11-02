// When a frame can be written to the shared radio without hitting a correction burst - a port of src/txGate.js (the measured
// conflict window is explained there).
#pragma once

#include <algorithm>
#include <cstddef>

#include "burst_tracker.h"

namespace rover {

class TxGate {
 public:
  static constexpr double REFERENCE_BYTES = 26;
  static constexpr double SERIAL_MS_PER_BYTE = 0.087;

  TxGate(const BurstTracker& tracker, double blockBeforeMs = 40, double blockAfterMs = 20, double guardMs = 10)
      : tracker(tracker), blockBeforeMs(blockBeforeMs), blockAfterMs(blockAfterMs), guardMs(guardMs) {}

  double beforeMs(size_t bytes) const { return blockBeforeMs + std::max(0.0, (double)bytes - REFERENCE_BYTES) * SERIAL_MS_PER_BYTE + guardMs; }
  double afterMs() const { return blockAfterMs + guardMs; }

  // ms to wait before writing a frame of `bytes` (0 = go now); always 0 while no bursts are heard
  double waitMs(size_t bytes, double t) const {
    if (!tracker.isActive(t)) return 0;
    const double p = tracker.period();
    const double prev = tracker.startAtOrBefore(t);
    const double next = prev + p;
    if (t <= prev + afterMs()) return prev + afterMs() - t;
    if (t >= next - beforeMs(bytes)) return next + afterMs() - t;
    return 0;
  }

  const BurstTracker& tracker;
  double blockBeforeMs, blockAfterMs, guardMs;
};

}  // namespace rover
