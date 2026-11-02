#include "power_policy.h"

#include <cmath>

#include "js_math.h"

namespace rover {

namespace {
constexpr double RAD = M_PI / 180;
constexpr double DAY_MS = 86400000;
constexpr int64_t FIX_STALE_MS = 120000;  // powerSchedule.js
constexpr double KNOTS_PER_MS = 1.943844;
// a boat woken by motion outside its window, with no shutdown rule to say how long "stopped" is
constexpr double MOTION_IDLE_MIN = 10;
constexpr double MOTION_IDLE_KN = 0.5;

int64_t daysFromCivil(int64_t y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = (unsigned)(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + (int64_t)doe - 719468;
}
}  // namespace

SunTimes sunTimes(int year, int month, int day, double latDeg, double lonDeg) {
  const double solarNoonUtc = (double)daysFromCivil(year, month, day) * DAY_MS + 12 * 3600000.0 - (lonDeg / 15) * 3600000;
  const double n = jsRound(solarNoonUtc / DAY_MS + 2440587.5 - 2451545.0);
  const double jStar = n - lonDeg / 360;
  const double M = std::fmod(357.5291 + 0.98560028 * jStar, 360);
  const double C = 1.9148 * std::sin(M * RAD) + 0.02 * std::sin(2 * M * RAD) + 0.0003 * std::sin(3 * M * RAD);
  const double lambda = std::fmod(M + C + 180 + 102.9372, 360);
  const double jTransit = 2451545.0 + jStar + 0.0053 * std::sin(M * RAD) - 0.0069 * std::sin(2 * lambda * RAD);
  const double delta = std::asin(std::sin(lambda * RAD) * std::sin(23.4397 * RAD));
  const double cosOmega = (std::sin(-0.833 * RAD) - std::sin(latDeg * RAD) * std::sin(delta)) / (std::cos(latDeg * RAD) * std::cos(delta));
  SunTimes t;
  if (cosOmega > 1 || cosOmega < -1) return t;
  const double omega = std::acos(cosOmega) / RAD;
  auto toMs = [](double j) { return (int64_t)jsRound((j - 2440587.5) * DAY_MS); };
  t.ok = true;
  t.sunrise = toMs(jTransit - omega / 360);
  t.sunset = toMs(jTransit + omega / 360);
  return t;
}

GateResult evaluateGate(int shutdownAtMin, double speedKn, double idleMinutes, bool requireIdle, bool idle, int64_t idleSince, const Pvt* lastFix,
                        int64_t now, const LocalClock& clock) {
  GateResult r;
  const LocalDate today = clock.toLocal(now);
  if (now < clock.fromLocal(today.year, today.month, today.day, shutdownAtMin)) return r;  // not yet time today
  if (!requireIdle) {
    r.shouldShutDown = true;
    return r;
  }
  const bool fresh = lastFix && now - lastFix->timestamp < FIX_STALE_MS;
  const double kn = fresh ? (lastFix->gSpeedMmS / 1000.0) * KNOTS_PER_MS : 0;
  if (fresh && !(kn < speedKn)) return r;  // moving
  r.idle = true;
  r.idleSince = idle ? idleSince : now;
  r.shouldShutDown = (double)(now - r.idleSince) >= idleMinutes * 60000;
  return r;
}

bool PowerPolicy::inWindow(int64_t now) const {
  if (!windowManaged()) return true;
  const LocalDate d = clock_.toLocal(now);
  if (schedule_.wittyMode == 1) {
    const int s = schedule_.startMin, e = schedule_.endMin;
    return s < e ? (d.minutes >= s && d.minutes < e) : (d.minutes >= s || d.minutes < e);
  }
  const SunTimes t = sunTimes(d.year, d.month, d.day, schedule_.lat, schedule_.lon);
  if (!t.ok) return true;  // polar day or night: no window to keep to
  return now >= t.sunrise - schedule_.beforeMin * 60000LL && now < t.sunset + schedule_.afterMin * 60000LL;
}

int64_t PowerPolicy::nextWindowStart(int64_t now) const {
  if (!windowManaged()) return 0;
  const LocalDate d = clock_.toLocal(now);
  for (int ahead = 0; ahead < 3; ahead++) {
    // the local date `ahead` days on (noon, so a DST change can't push it into the wrong day)
    const LocalDate day = ahead == 0 ? d : clock_.toLocal(clock_.fromLocal(d.year, d.month, d.day + ahead, 720));
    int64_t start;
    if (schedule_.wittyMode == 1) {
      start = clock_.fromLocal(day.year, day.month, day.day, schedule_.startMin);
    } else {
      const SunTimes t = sunTimes(day.year, day.month, day.day, schedule_.lat, schedule_.lon);
      if (!t.ok) continue;
      start = t.sunrise - schedule_.beforeMin * 60000LL;
    }
    if (start > now) return start;
  }
  return 0;
}

bool PowerPolicy::idleFor(int64_t now, const Pvt* lastFix, double idleMinutes, double speedKn) {
  const bool fresh = lastFix && now - lastFix->timestamp < FIX_STALE_MS;
  const bool stopped = !fresh || (lastFix->gSpeedMmS / 1000.0) * KNOTS_PER_MS < speedKn;
  if (!stopped) {
    idle_ = false;
    return false;
  }
  if (!idle_) {
    idle_ = true;
    idleSince_ = now;
  }
  return (double)(now - idleSince_) >= idleMinutes * 60000;
}

PowerPolicy::Decision PowerPolicy::evaluate(int64_t now, const Pvt* lastFix, bool suspended, bool motionWoken) {
  Decision d;
  if (suspended) {  // radio sleep mode silences the GPS on purpose - see powerSchedule.js's isSuspended
    idle_ = false;
    return d;
  }
  const bool outside = windowManaged() && !inWindow(now);
  if (outside && motionWoken) {
    // woken by motion outside the window: up until stopped for a while, whatever the schedule says
    const double minutes = schedule_.hasShutdown ? schedule_.idleMinutes : MOTION_IDLE_MIN;
    const double kn = schedule_.hasShutdown ? schedule_.speedKn : MOTION_IDLE_KN;
    if (idleFor(now, lastFix, minutes, kn)) d.reason = "woken by motion outside the on window, now stopped";
  } else if (outside && !schedule_.haltItself) {
    d.reason = "outside the on window";
  } else if (schedule_.hasShutdown && schedule_.shutdownEnabled) {
    const GateResult g = evaluateGate(schedule_.shutdownMin, schedule_.speedKn, schedule_.idleMinutes, schedule_.whenIdle, idle_, idleSince_,
                                      lastFix, now, clock_);
    idle_ = g.idle;
    idleSince_ = g.idleSince;
    if (g.shouldShutDown) d.reason = schedule_.whenIdle ? "past the shutdown time and stopped" : "past the shutdown time";
  }
  if (d.reason.empty()) return d;
  d.sleep = true;
  d.wakeAt = nextWindowStart(now);
  d.hasWakeAt = d.wakeAt != 0;
  return d;
}

}  // namespace rover
