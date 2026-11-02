// The RTK correction bursts as heard on the shared radio - a port of src/burstTracker.js (see there for why the start of a burst is
// the fleet's shared clock). Times are milliseconds on a monotonic clock.
#pragma once

#include <cstddef>
#include <cstdint>
#include <deque>
#include <map>
#include <vector>

namespace rover {

class BurstTracker {
 public:
  static constexpr double BURST_GAP_MS = 400;
  static constexpr size_t KEEP_STARTS = 16;
  static constexpr size_t KEEP_OFFSETS = 24;
  static constexpr double MIN_PERIOD_MS = 400;
  static constexpr double MAX_PERIOD_MS = 15000;
  static constexpr size_t MIN_BURST_MSG_BYTES = 40;
  static constexpr double NONE = -1;  // "null" for period/lastStart/startAtOrBefore

  explicit BurstTracker(double gapMs = BURST_GAP_MS) : gapMs_(gapMs) {}

  // every RTCM message the radio decodes; size = the whole frame's bytes (0 = unknown: every message counts)
  void onRtcm(uint16_t type, double t, size_t size = 0);

  double period() const;  // NONE until two bursts have been heard
  double lastStart() const { return starts_.empty() ? NONE : starts_.back(); }
  bool isActive(double t) const;
  double nextStart(double after) const;
  double startAtOrBefore(double t) const;

  uint32_t bursts = 0;
  uint32_t anchorCorrections = 0;

 private:
  void closeBurst();
  int usualFirstType() const;  // -1 = none

  struct Msg {
    uint16_t type;
    double t;
  };
  struct Burst {
    double start;
    uint16_t firstType;
    std::vector<Msg> msgs;
  };

  double gapMs_;
  std::deque<double> starts_;
  bool hasCur_ = false;
  Burst cur_;
  double lastMsgAt_ = -1e300;
  std::map<uint16_t, std::deque<double>> offsets_;
  std::deque<uint16_t> firstTypes_;
};

double median(std::vector<double> xs);  // NONE for an empty list

}  // namespace rover
