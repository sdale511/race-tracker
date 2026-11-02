// Holds radio writes clear of the correction bursts and, in slot mode, releases position frames only in this boat's slot - a port
// of src/txScheduler.js (the boat side of it: the base's supersede/coalescing is left out). Node's timers become two deadlines
// that tick() checks, so the scheduler runs from the firmware's main loop.
#pragma once

#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <string>
#include <vector>

#include "burst_tracker.h"
#include "pvt.h"
#include "tx_gate.h"

namespace rover {

double airMs(size_t bytes);  // 8 ms per packet + 0.04 ms per byte

// A frame on its way to the radio. lastFix is the newest fix it carries, so the boat's distance gate can hear whether it went out.
struct TxFrame {
  std::vector<uint8_t> buf;
  bool hasFix = false;
  Pvt lastFix;
};

struct SlotJoin {
  int first = 0;
  int n = 0;
};

struct SlotConfig {
  bool enabled = false;
  int index = 0;
  int count = 25;
  double widthMs = 35;
  bool hasJoin = false;
  SlotJoin join;
};

class TxScheduler {
 public:
  using SendFn = std::function<bool(const std::vector<uint8_t>&)>;

  TxScheduler(SendFn send, const BurstTracker& tracker, const TxGate& gate, SlotConfig slot, size_t maxQueue, double maxAgeMs,
              std::function<double()> now, std::function<double()> rand, std::function<void(const std::string&)> log);

  std::function<void(const TxFrame&)> onSent;
  std::function<void(const TxFrame&)> onDropped;

  // setSlot: only the fields given change (txScheduler.js's setSlot({...}) with defaults from the current slot)
  void setSlotIndex(int index, int count, double widthMs);
  void setSlotJoin(int count, double widthMs, SlotJoin join);

  bool slotAligned() const;
  void startSlotFlush(std::function<void()> fn);
  bool submit(TxFrame frame);
  size_t flushNow();

  // Runs whatever is due (the pump and the slot flush). Call often - every loop pass.
  void tick();

  const SlotConfig& slot() const { return slot_; }
  size_t queued() const { return queue_.size(); }

  struct Counters {
    uint32_t submitted = 0, passedThrough = 0, held = 0, dropped = 0, expired = 0, slotted = 0, spilled = 0;
    double heldMsTotal = 0, heldMsMax = 0;
  } counters;

  const BurstTracker& tracker;
  const TxGate& gate;

 private:
  struct Entry {
    TxFrame frame;
    size_t bytes;
    double at;
    bool slotted;
  };
  struct JoinChoice {
    double start;
    int index;
  };
  void checkSlotFit();
  void warnIfSlotsOverrun();
  int slotIndexFor(double cycleStart);
  void armFlush();
  void flushTick(bool wasAligned);
  void schedule(double delayMs);
  bool slotFits(int index, size_t bytes);
  double slotWaitMs(size_t bytes, double t);
  double waitFor(size_t bytes, bool slotted, double t);
  void markSlotUsed(size_t bytes, double t);
  void pump();
  void sendHead(double t);
  bool write(const TxFrame& f);
  static bool isSlottedSync(uint8_t b) { return b == 0xaa || b == 0xee || b == 0xe7; }

  SendFn rawSend_;
  SlotConfig slot_;
  size_t maxQueue_;
  double maxAgeMs_;
  std::function<double()> now_;
  std::function<double()> rand_;
  std::function<void(const std::string&)> log_;

  std::deque<Entry> queue_;
  static constexpr double NO_TIMER = -1;
  double pumpAt_ = NO_TIMER;
  double flushAt_ = NO_TIMER;
  bool flushArmedAligned_ = false;
  std::function<void()> flushFn_;
  bool flushWasAligned_ = false;
  bool wasActive_ = false;
  double windowStart_ = NO_TIMER;  // the slot window being filled (NO_TIMER = none)
  double windowUsed_ = 0;
  double slotFitNeededMs_ = 0;
  double lastSlotWarnAt_ = -1e300;
  double lastNoFitWarnAt_ = -1e300;
  std::deque<double> recentSpills_;
  std::vector<JoinChoice> joinChoices_;
};

}  // namespace rover
