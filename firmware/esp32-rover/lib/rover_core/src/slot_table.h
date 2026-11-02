// The boat side of src/slotTable.js: following the base's slot table, the pacing of a boat without a slot of its own (JoinBackoff)
// or parked on the start grid (ParkedReporter, ZoneState), and the slot count a boat assumes before it hears a table.
// The base's SlotAllocator is not ported - only the base runs it.
#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "protocol.h"
#include "tx_gate.h"
#include "tx_scheduler.h"

namespace rover {

constexpr int MAX_SLOTS = 250;

int slotCountForPeriod(double periodMs, double widthMs, const TxGate& gate);
// slotTable.js's autoSlotCount: what the base works out from the correction interval - a boat must assume the same
int autoSlotCount(int joinSlots, double rtcmIntervalS, double widthMs, const TxGate& gate);

class ZoneState {
 public:
  explicit ZoneState(int unparkFixes = 3, double dwellMs = 0) : unparkFixes(unparkFixes < 1 ? 1 : unparkFixes), dwellMs(dwellMs < 0 ? 0 : dwellMs) {}
  bool update(bool inZone, bool pastLine, double nowMs, bool stationary);
  bool parked = false;
  bool crossedLine = false;

 private:
  int unparkFixes;
  double dwellMs;
  int outside = 0;
  bool entered = false;
  double enteredAt = 0;
};

// The pacing a boat applies to its reports (ParkedReporter / JoinBackoff both look like this to the boat)
class Pacer {
 public:
  virtual ~Pacer() {}
  virtual bool due() const = 0;
  virtual void sent() = 0;
};

class ParkedReporter : public Pacer {
 public:
  ParkedReporter(double intervalMs, double firstMs, double repeatMs, std::function<double()> now, std::function<double()> rand,
                 double jitter = 0.25)
      : intervalMs(intervalMs), firstMs(firstMs), repeatMs(repeatMs), jitter(jitter), now(std::move(now)), rand(std::move(rand)) {}
  void reset();
  bool due() const override { return now() >= nextAt; }
  void sent() override;
  bool wantsRepeat() const { return firstDone && repeatsLeft > 0 && due(); }

 private:
  double interval() const { return intervalMs * (1 - jitter + 2 * jitter * rand()); }
  double repeatDelay() const { return repeatMs * (1 - jitter + 2 * jitter * rand()); }
  double intervalMs, firstMs, repeatMs, jitter;  // firstMs < 0: unset
  std::function<double()> now, rand;
  double nextAt = 0;
  bool firstDone = false;
  int repeatsLeft = 0;
};

class JoinBackoff : public Pacer {
 public:
  JoinBackoff(double maxMs, std::vector<double> steps, std::function<double()> now, std::function<double()> rand, double jitter = 0.25);
  void reset() {
    step = 0;
    nextAt = 0;
  }
  bool due() const override { return now() >= nextAt; }
  void sent() override;
  double nextDueAt() const { return nextAt; }

 private:
  std::vector<double> steps;
  double jitter;
  std::function<double()> now, rand;
  size_t step = 0;
  double nextAt = 0;
};

class SlotTableFollower {
 public:
  SlotTableFollower(std::string boatId, TxScheduler& scheduler, bool pinned, std::function<double()> now,
                    std::function<void(const std::string&)> log, double revertAfterMs = 35 * 1000)
      : boatId(std::move(boatId)), scheduler(scheduler), pinned(pinned), now(std::move(now)), log(std::move(log)), revertAfterMs(revertAfterMs) {}

  void setParked(bool parked);
  bool onTable(const protocol::SlotTable& table);

  std::function<void(int slot)> onAssigned;
  std::function<void(bool practice)> onPractice;

  int assigned = -1;  // the slot the base gave us, once heard (-1 = none)
  bool practice = false;
  uint32_t tablesHeard = 0;
  int lastVersion = -1;

 private:
  void toJoinSlots(int slotCount, double widthMs, int joinSlots);

  std::string boatId;
  TxScheduler& scheduler;
  bool pinned;
  std::function<double()> now;
  std::function<void(const std::string&)> log;
  double revertAfterMs;
  bool parked = false;
  bool hasLayout = false;
  int layoutSlotCount = 0, layoutJoinSlots = 0;
  double layoutWidthMs = 0;
  bool hasLastEntry = false;
  double lastEntryAt = 0;
  int tablesSince = 0;
};

}  // namespace rover
