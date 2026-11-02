// The boat's "is this fix worth sending" gate - a port of src/distanceGate.js (see there for why the reference is the last fix that
// cleared the gate, not the last one sent).
#pragma once

#include <cstdint>

#include "js_math.h"
#include "pvt.h"

namespace rover {

class DistanceGate {
 public:
  explicit DistanceGate(double intervalMs = 0) : intervalMs(intervalMs) {}

  bool cleared(const Pvt& fix, double distanceM) const {
    if (!hasRef) return true;
    if (distanceMeters({refLat, refLon}, latLonOf(fix)) >= distanceM) return true;
    return intervalMs > 0 && fix.timestamp - refTs >= intervalMs;
  }
  void advance(const Pvt& fix) {
    hasRef = true;
    refLat = fix.lat;
    refLon = fix.lon;
    refTs = fix.timestamp;
  }
  void sent(const Pvt& fix) {
    hasSent = true;
    sentLat = fix.lat;
    sentLon = fix.lon;
    sentTs = fix.timestamp;
  }
  void failed() {
    hasRef = hasSent;
    refLat = sentLat;
    refLon = sentLon;
    refTs = sentTs;
  }

  double intervalMs;

 private:
  bool hasRef = false, hasSent = false;
  double refLat = 0, refLon = 0, sentLat = 0, sentLon = 0;
  int64_t refTs = 0, sentTs = 0;
};

}  // namespace rover
