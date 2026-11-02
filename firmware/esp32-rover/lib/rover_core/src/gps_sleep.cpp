#include "gps_sleep.h"

#include <cstdio>

#include "ubx.h"

namespace rover {

namespace {
std::string seconds(double ms) {
  char b[16];
  std::snprintf(b, sizeof b, "%.1f", ms / 1000);
  return b;
}
}  // namespace

void GpsSleep::sleep() {
  if (!supported || asleep) return;
  asleep = true;
  sleptAt = now();
  waking = false;
  lastFirstFixMs = -1;
  lastRtkFixMs = -1;
  warnedStillSending = false;
  retryAt = -1;
  if (!write(ubx::encodePmreq(0, forceUsb))) log("[gps] could not send the backup (sleep) command - GPS port not open");
  log("[gps] sleeping (software backup)");
}

void GpsSleep::wake() {
  if (!supported || !asleep) return;
  asleep = false;
  waking = true;
  wakeAt = now();
  retries = 0;
  log("[gps] waking");
  sendWakeByte();
  armRetry();
}

void GpsSleep::sendWakeByte() {
  if (!write(std::vector<uint8_t>{0xff})) log("[gps] could not send the wake byte - GPS port not open");
}

void GpsSleep::tick() {
  if (retryAt < 0 || now() < retryAt) return;
  retryAt = -1;
  if (!waking || lastFirstFixMs >= 0) return;
  if (++retries > WAKE_MAX_RETRIES) {
    log("[gps] no fix " + std::to_string((long)((now() - wakeAt) / 1000)) + "s after waking - giving up resending the wake byte");
    return;
  }
  log("[gps] no fix yet after waking - resending wake byte (" + std::to_string(retries) + "/" + std::to_string(WAKE_MAX_RETRIES) + ")");
  sendWakeByte();
  armRetry();
}

bool GpsSleep::shouldDrop(bool valid, bool rtkFixed) {
  const double t = now();
  if (asleep) {
    if (t - sleptAt > SLEEP_ENTRY_GRACE_MS && !warnedStillSending) {
      warnedStillSending = true;
      log("[gps] still producing fixes while \"asleep\" - the receiver refused backup mode (USB connected? set GPS_SLEEP_FORCE_USB)");
    }
    return true;
  }
  if (waking) {
    if (valid && lastFirstFixMs < 0) {
      lastFirstFixMs = t - wakeAt;
      retryAt = -1;
      log("[gps] first valid fix " + seconds(lastFirstFixMs) + "s after waking" +
          (lastFirstFixMs > 15000 ? " - slow, the receiver probably cold-started" : ""));
    }
    if (rtkFixed && lastRtkFixMs < 0) {
      lastRtkFixMs = t - wakeAt;
      log("[gps] RTK fixed " + seconds(lastRtkFixMs) + "s after waking");
      waking = false;
    }
  }
  return false;
}

}  // namespace rover
