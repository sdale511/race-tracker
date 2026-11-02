#include "tx_scheduler.h"

#include <algorithm>
#include <cmath>

namespace rover {

namespace {
constexpr double AIR_MS_PER_PACKET = 8;
constexpr double AIR_MS_PER_BYTE = 0.04;
std::string num(double v) { return std::to_string((long long)std::llround(v)); }
}  // namespace

double airMs(size_t bytes) { return AIR_MS_PER_PACKET + bytes * AIR_MS_PER_BYTE; }

TxScheduler::TxScheduler(SendFn send, const BurstTracker& tracker, const TxGate& gate, SlotConfig slot, size_t maxQueue,
                         double maxAgeMs, std::function<double()> now, std::function<double()> rand,
                         std::function<void(const std::string&)> log)
    : tracker(tracker), gate(gate), rawSend_(std::move(send)), slot_(slot), maxQueue_(maxQueue), maxAgeMs_(maxAgeMs),
      now_(std::move(now)), rand_(std::move(rand)), log_(std::move(log)) {
  checkSlotFit();
}

void TxScheduler::checkSlotFit() {
  if (!slot_.enabled) return;
  slotFitNeededMs_ = gate.afterMs() + slot_.count * slot_.widthMs + gate.beforeMs(84);
}

void TxScheduler::setSlotIndex(int index, int count, double widthMs) {
  slot_.enabled = true;
  slot_.index = index;
  slot_.count = count;
  slot_.widthMs = widthMs;
  slot_.hasJoin = false;
  windowStart_ = NO_TIMER;
  windowUsed_ = 0;
  checkSlotFit();
  warnIfSlotsOverrun();
  if (!queue_.empty()) schedule(0);
  if (flushFn_) armFlush();
}

void TxScheduler::setSlotJoin(int count, double widthMs, SlotJoin join) {
  slot_.enabled = true;
  slot_.count = count;
  slot_.widthMs = widthMs;
  slot_.hasJoin = true;
  slot_.join = join;
  windowStart_ = NO_TIMER;
  windowUsed_ = 0;
  checkSlotFit();
  warnIfSlotsOverrun();
  if (!queue_.empty()) schedule(0);
  if (flushFn_) armFlush();
}

int TxScheduler::slotIndexFor(double cycleStart) {
  if (!slot_.hasJoin) return slot_.index;
  joinChoices_.erase(std::remove_if(joinChoices_.begin(), joinChoices_.end(),
                                    [&](const JoinChoice& c) { return !(std::fabs(c.start - cycleStart) < 3000 || c.start > cycleStart); }),
                     joinChoices_.end());
  for (const JoinChoice& c : joinChoices_)
    if (std::fabs(c.start - cycleStart) < 200) return c.index;
  JoinChoice c{cycleStart, slot_.join.first + (int)std::floor(rand_() * slot_.join.n)};
  joinChoices_.push_back(c);
  if (joinChoices_.size() > 8) joinChoices_.erase(joinChoices_.begin());
  return c.index;
}

void TxScheduler::warnIfSlotsOverrun() {
  const double p = tracker.period();
  if (slot_.enabled && p != BurstTracker::NONE && tracker.isActive(now_()) && slotFitNeededMs_ > p) {
    log_("[txgate] WARNING: " + std::to_string(slot_.count) + " slots of " + num(slot_.widthMs) + " ms need ~" + num(slotFitNeededMs_) +
         " ms but the burst period is " + num(p) + " ms - the last slots would overrun");
  }
}

bool TxScheduler::slotAligned() const { return slot_.enabled && tracker.isActive(now_()); }

void TxScheduler::startSlotFlush(std::function<void()> fn) {
  flushFn_ = std::move(fn);
  armFlush();
}

void TxScheduler::armFlush() {
  const double t = now_();
  const bool aligned = slotAligned();
  double delay = 500;  // not aligned: keep an eye out for the bursts (or slot mode) starting
  if (aligned) {
    const double p = tracker.period();
    const double base = tracker.startAtOrBefore(t);
    delay = -1;
    for (int k = 0; k < 3 && p != BurstTracker::NONE && p != 0; k++) {
      const int idx = slotIndexFor(base + k * p);
      const double start = base + k * p + gate.afterMs() + (slotFits(idx, 84) ? idx : 0) * slot_.widthMs;
      if (start > t + 0.5) {
        delay = start - t + 1;  // 1 ms after the slot opens
        break;
      }
    }
    if (delay < 0) delay = 250;
  }
  flushAt_ = t + delay;
  flushArmedAligned_ = aligned;
}

void TxScheduler::flushTick(bool wasAligned) {
  flushAt_ = NO_TIMER;
  const bool aligned = slotAligned();
  if (wasAligned || (flushWasAligned_ && !aligned)) {
    if (flushFn_) flushFn_();
  }
  flushWasAligned_ = aligned;
  armFlush();
}

bool TxScheduler::submit(TxFrame frame) {
  const double t = now_();
  counters.submitted++;
  const bool active = tracker.isActive(t);
  if (active != wasActive_) {
    wasActive_ = active;
    const double p = tracker.period();
    if (active) {
      std::string msg = "[txgate] correction bursts heard (every " + (p != BurstTracker::NONE ? num(p) : std::string("?")) +
                        " ms) - telemetry now keeps clear of them";
      if (slot_.enabled)
        msg += slot_.hasJoin ? ", no slot of its own yet - sharing the last " + std::to_string(slot_.join.n) + " of " + std::to_string(slot_.count)
                             : ", slot " + std::to_string(slot_.index) + " of " + std::to_string(slot_.count);
      log_(msg);
      warnIfSlotsOverrun();
    } else {
      log_("[txgate] no correction bursts heard - telemetry unrestricted");
    }
  }
  const size_t bytes = frame.buf.size();
  const bool slotted = slot_.enabled && !frame.buf.empty() && isSlottedSync(frame.buf[0]);
  if (queue_.empty()) {
    if (!active || waitFor(bytes, slotted, t) <= 0.5) {
      counters.passedThrough++;
      if (slotted && active) markSlotUsed(bytes, t);
      return write(frame);
    }
  }
  if (queue_.size() >= maxQueue_) {
    Entry gone = std::move(queue_.front());
    queue_.pop_front();
    counters.dropped++;
    if (onDropped) onDropped(gone.frame);
  }
  queue_.push_back({std::move(frame), bytes, t, slotted});
  schedule(0);
  return true;
}

void TxScheduler::schedule(double delayMs) { pumpAt_ = now_() + std::max(0.0, delayMs); }

bool TxScheduler::slotFits(int index, size_t bytes) {
  const double p = tracker.period();
  if (p == BurstTracker::NONE) return true;
  const bool fits = gate.afterMs() + index * slot_.widthMs + airMs(bytes) + gate.beforeMs(bytes) <= p;
  if (!fits && now_() - lastNoFitWarnAt_ > 60000) {
    lastNoFitWarnAt_ = now_();
    log_("[txgate] WARNING: slot " + std::to_string(index) + " of " + std::to_string(slot_.count) + " (" + num(slot_.widthMs) +
         " ms each) does not fit in the " + num(p) +
         " ms between correction bursts - sending outside slots (clear of the burst only). The slot count was sized for a longer "
         "correction interval than the one heard");
  }
  return fits;
}

double TxScheduler::slotWaitMs(size_t bytes, double t) {
  const double widthMs = slot_.widthMs;
  const double p = tracker.period();
  const double base = tracker.startAtOrBefore(t);
  const double need = airMs(bytes);
  for (int k = 0; k < 3; k++) {
    if (!slotFits(slotIndexFor(base + k * p), bytes)) return 0;
    const int index = slotIndexFor(base + k * p);
    const double start = base + k * p + gate.afterMs() + index * widthMs;
    const double end = start + widthMs;
    if (t >= end) continue;
    if (t >= start && end - t < std::min(need + gate.guardMs, widthMs - 3)) continue;
    const bool sameWindow = windowStart_ != NO_TIMER && std::fabs(windowStart_ - start) < 1;
    const double used = sameWindow ? windowUsed_ : 0;
    const bool fits = used == 0 || used + need <= widthMs - gate.guardMs;
    if (t >= start && fits) return 0;
    if (t >= start && !fits) {
      counters.spilled++;
      recentSpills_.push_back(t);
      while (!recentSpills_.empty() && t - recentSpills_.front() > 60000) recentSpills_.pop_front();
      if (recentSpills_.size() >= 4 && t - lastSlotWarnAt_ > 60000) {
        lastSlotWarnAt_ = t;
        const int room = std::max(1, (int)std::floor((widthMs - gate.guardMs) / need));
        log_("[txgate] WARNING: " + std::to_string(recentSpills_.size()) + " frames in the last minute did not fit slot " + std::to_string(index) +
             " (" + num(widthMs) + " ms: room for about " + std::to_string(room) + " frame(s) of " + std::to_string(bytes) +
             " bytes) and went out a cycle later - nothing was lost");
      }
      continue;
    }
    return start - t;
  }
  return 0;
}

double TxScheduler::waitFor(size_t bytes, bool slotted, double t) {
  double wait = gate.waitMs(bytes, t);
  if (slotted) wait += slotWaitMs(bytes, t + wait);
  return wait;
}

void TxScheduler::markSlotUsed(size_t bytes, double t) {
  const double base = tracker.startAtOrBefore(t);
  const double p = tracker.period();
  for (int k = 0; k < 3; k++) {
    const double start = base + k * p + gate.afterMs() + slotIndexFor(base + k * p) * slot_.widthMs;
    if (t < start + slot_.widthMs) {
      if (windowStart_ == NO_TIMER || std::fabs(windowStart_ - start) >= 1) {
        windowStart_ = start;
        windowUsed_ = 0;
      }
      windowUsed_ += airMs(bytes);
      return;
    }
  }
}

void TxScheduler::pump() {
  pumpAt_ = NO_TIMER;
  const double t0 = now_();
  while (!queue_.empty() && t0 - queue_.front().at > maxAgeMs_) {
    Entry gone = std::move(queue_.front());
    queue_.pop_front();
    counters.expired++;
    if (onDropped) onDropped(gone.frame);
  }
  if (!tracker.isActive(t0)) {
    while (!queue_.empty()) sendHead(t0);
    return;
  }
  while (!queue_.empty()) {
    const double t = now_();
    const Entry& head = queue_.front();
    const double wait = waitFor(head.bytes, head.slotted, t);
    if (wait > 0.5) {
      schedule(wait + 1);
      return;
    }
    sendHead(t);
  }
}

void TxScheduler::sendHead(double t) {
  Entry e = std::move(queue_.front());
  queue_.pop_front();
  const double heldMs = t - e.at;
  if (heldMs > 5) {
    counters.held++;
    counters.heldMsTotal += heldMs;
    counters.heldMsMax = std::max(counters.heldMsMax, heldMs);
  }
  if (e.slotted) {
    counters.slotted++;
    if (tracker.isActive(t)) markSlotUsed(e.bytes, t);
  }
  write(e.frame);
}

bool TxScheduler::write(const TxFrame& f) {
  const bool ok = rawSend_(f.buf);
  if (!ok) {
    if (onDropped) onDropped(f);
  } else if (onSent) {
    onSent(f);
  }
  return ok;
}

size_t TxScheduler::flushNow() {
  pumpAt_ = NO_TIMER;
  std::deque<Entry> held;
  held.swap(queue_);
  for (const Entry& e : held) write(e.frame);
  return held.size();
}

void TxScheduler::tick() {
  const double t = now_();
  if (pumpAt_ != NO_TIMER && t >= pumpAt_) pump();
  if (flushAt_ != NO_TIMER && t >= flushAt_) flushTick(flushArmedAligned_);
}

}  // namespace rover
