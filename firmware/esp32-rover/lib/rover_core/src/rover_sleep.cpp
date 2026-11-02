#include "rover_sleep.h"

#include <cmath>

namespace rover {

void RoverSleep::handlePower(const protocol::Power& p, const std::string& myBoatId) {
  if (!p.all) {
    bool named = false;
    for (const auto& id : p.boatIds) named = named || id == myBoatId;
    if (!named) return;
  }
  if (p.sleep) sleep(p.sleepS ? p.sleepS : defaultCycleS);
  else wake();
}

bool RoverSleep::sleep(int cycle) {
  if (!canSleep) {
    log("[sleep] sleep command ignored - this radio has no sleep control (no SLEEP_RQ pin set)");
    return false;
  }
  timerAt = -1;
  cycleS = cycle;
  if (state == State::Awake) {
    sleptAt = now();
    sleepCount++;
    log("[sleep] radio asleep - listening for a wake frame for " + std::to_string((long)listenMs) + "ms every " + std::to_string(cycleS) + "s");
    if (onSleep) onSleep();
  }
  enterAsleep();
  return true;
}

void RoverSleep::wake() {
  if (state == State::Awake) return;
  timerAt = -1;
  setRadioSleeping(false);
  state = State::Awake;
  log("[sleep] wake frame heard after " + std::to_string((long)std::lround((now() - sleptAt) / 1000)) + "s asleep - radio awake");
  if (onWake) onWake();
}

void RoverSleep::enterAsleep() {
  setRadioSleeping(true);
  state = State::Asleep;
  timerAt = now() + cycleS * 1000.0;
}

void RoverSleep::enterListening() {
  setRadioSleeping(false);
  state = State::Listening;
  timerAt = now() + listenMs;
}

void RoverSleep::tick() {
  if (timerAt < 0 || now() < timerAt) return;
  timerAt = -1;
  if (state == State::Asleep) enterListening();
  else if (state == State::Listening) enterAsleep();
}

}  // namespace rover
