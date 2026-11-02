// The GPS board's sleep while the rover sleeps - a port of src/gpsSleep.js for a real receiver (u-blox software backup, woken by a
// byte on its UART RX). Its retry timer becomes a deadline tick() checks.
#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "pvt.h"

namespace rover {

class GpsSleep {
 public:
  using WriteFn = std::function<bool(const std::vector<uint8_t>&)>;

  GpsSleep(bool supported, WriteFn write, bool forceUsb, std::function<double()> now, std::function<void(const std::string&)> log)
      : supported(supported), write(std::move(write)), forceUsb(forceUsb), now(std::move(now)), log(std::move(log)) {}

  bool isAsleep() const { return asleep; }
  void sleep();
  void wake();
  void wakeOnStartup() {
    if (supported) sendWakeByte();
  }
  bool shouldDrop(bool valid, bool rtkFixed);
  void tick();

  bool supported;
  double lastFirstFixMs = -1;
  double lastRtkFixMs = -1;

 private:
  void sendWakeByte();
  void armRetry() { retryAt = now() + WAKE_RETRY_MS; }

  static constexpr double SLEEP_ENTRY_GRACE_MS = 2500;
  static constexpr double WAKE_RETRY_MS = 5000;
  static constexpr int WAKE_MAX_RETRIES = 3;

  WriteFn write;
  bool forceUsb;
  std::function<double()> now;
  std::function<void(const std::string&)> log;
  bool asleep = false;
  double sleptAt = 0;
  bool waking = false;  // from wake() until both first-fix times are measured
  double wakeAt = 0;
  double retryAt = -1;
  int retries = 0;
  bool warnedStillSending = false;
};

}  // namespace rover
