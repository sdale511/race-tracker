// When the ESP32 rover powers itself down - the fleet power schedule the base sends (protocol.js's 0xB5 frame) applied to an ESP32,
// where "off" is deep sleep and the board wakes itself on a timer or on the accelerometer, instead of a Pi halting and a Witty Pi
// switching it back on.
//
//   the shutdown rule  (fleetShutdown.js / powerSchedule.js's evaluateGate, ported exactly): past `time` local time and stopped for
//                      idleMinutes (or, without the idle gate, as soon as the time has passed) -> sleep
//   the on window      (wittySchedule.js's daily hours, or sunSchedule.js's sunrise to sunset): outside it the boat sleeps until the
//                      window next opens - at once (the Witty Pi's hard stop), or, with haltItself, only when the shutdown rule says so
//   motion             a boat woken by the accelerometer outside its window stays up until it has been stopped for idleMinutes, so a
//                      boat being sailed is never put to sleep under its crew
//
// Times: wall ms are unix ms; "local" is the boat's local time, which the HAL converts (an ESP32 has a POSIX TZ string, a Pi its zone).
#pragma once

#include <cstdint>
#include <functional>
#include <string>

#include "protocol.h"
#include "pvt.h"

namespace rover {

struct LocalDate {
  int year, month, day;  // month 1-12
  int minutes;           // minutes after local midnight
};

struct LocalClock {
  std::function<LocalDate(int64_t wallMs)> toLocal;
  std::function<int64_t(int year, int month, int day, int minutes)> fromLocal;  // normalises an out-of-range day, like Date
};

struct SunTimes {
  bool ok = false;  // false: polar day or night
  int64_t sunrise = 0, sunset = 0;
};
// sunSchedule.js's sunTimes for a local calendar day
SunTimes sunTimes(int year, int month, int day, double latDeg, double lonDeg);

// powerSchedule.js's evaluateGate, the shutdown rule's decision
struct GateResult {
  bool idle = false;  // idleSince is set
  int64_t idleSince = 0;
  bool shouldShutDown = false;
};
GateResult evaluateGate(int shutdownAtMin, double speedKn, double idleMinutes, bool requireIdle, bool idle, int64_t idleSince, const Pvt* lastFix,
                        int64_t now, const LocalClock& clock);

class PowerPolicy {
 public:
  explicit PowerPolicy(LocalClock clock) : clock_(std::move(clock)) {}

  void setSchedule(const protocol::PowerSchedule& s) {
    schedule_ = s;
    idle_ = false;
  }
  const protocol::PowerSchedule& schedule() const { return schedule_; }

  struct Decision {
    bool sleep = false;
    bool hasWakeAt = false;
    int64_t wakeAt = 0;  // wall ms the on window next opens
    std::string reason;
  };
  // Call every few seconds once the wall clock is known. suspended: the rover is in radio sleep mode (its GPS is silent on purpose, which
  // must not count as idle). motionWoken: this boot came from the accelerometer.
  Decision evaluate(int64_t now, const Pvt* lastFix, bool suspended, bool motionWoken);

  bool windowManaged() const { return schedule_.hasWitty && schedule_.wittyMode != 0; }
  bool inWindow(int64_t now) const;
  int64_t nextWindowStart(int64_t now) const;  // wall ms; 0 when there is no window (or the sun never rises)

 private:
  bool idleFor(int64_t now, const Pvt* lastFix, double idleMinutes, double speedKn);

  LocalClock clock_;
  protocol::PowerSchedule schedule_;
  bool idle_ = false;
  int64_t idleSince_ = 0;
};

}  // namespace rover
