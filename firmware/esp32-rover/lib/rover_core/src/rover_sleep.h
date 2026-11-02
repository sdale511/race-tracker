// Radio sleep mode - a port of src/roverSleep.js, with its two timers turned into a deadline that tick() checks.
//   awake      normal operation
//   asleep     radio off, waiting for the next listen window
//   listening  radio on for listenMs, still "sleeping" for the rest of the app - only a wake frame ends it
#pragma once

#include <functional>
#include <string>

#include "protocol.h"

namespace rover {

class RoverSleep {
 public:
  enum class State { Awake, Asleep, Listening };

  RoverSleep(bool canSleep, double listenMs, int defaultCycleS, std::function<void(bool)> setRadioSleeping, std::function<double()> now,
             std::function<void(const std::string&)> log)
      : canSleep(canSleep), listenMs(listenMs), defaultCycleS(defaultCycleS), cycleS(defaultCycleS),
        setRadioSleeping(std::move(setRadioSleeping)), now(std::move(now)), log(std::move(log)) {}

  bool isSleeping() const { return state != State::Awake; }
  void handlePower(const protocol::Power& p, const std::string& myBoatId);
  bool sleep(int cycleS);
  void wake();
  void tick();

  std::function<void()> onSleep;
  std::function<void()> onWake;

  State state = State::Awake;
  bool canSleep;
  uint32_t sleepCount = 0;

 private:
  void enterAsleep();
  void enterListening();

  double listenMs;
  int defaultCycleS;
  int cycleS;
  std::function<void(bool)> setRadioSleeping;
  std::function<double()> now;
  std::function<void(const std::string&)> log;
  double timerAt = -1;  // -1 = no timer
  double sleptAt = 0;
};

}  // namespace rover
