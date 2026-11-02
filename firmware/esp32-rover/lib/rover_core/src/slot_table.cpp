#include "slot_table.h"

#include <algorithm>
#include <cmath>

namespace rover {

int slotCountForPeriod(double periodMs, double widthMs, const TxGate& gate) {
  const double usable = periodMs - gate.afterMs() - gate.beforeMs(84);
  return std::max(1, std::min(MAX_SLOTS, (int)std::floor(usable / widthMs)));
}

int autoSlotCount(int joinSlots, double rtcmIntervalS, double widthMs, const TxGate& gate) {
  return std::max(joinSlots + 1, slotCountForPeriod(rtcmIntervalS * 1000, widthMs, gate) - 1);
}

bool ZoneState::update(bool inZone, bool pastLine, double nowMs, bool stationary) {
  if (inZone) {
    if (!entered) {
      entered = true;
      enteredAt = nowMs;
    }
    outside = 0;
    crossedLine = false;
    if (stationary || nowMs - enteredAt >= dwellMs) parked = true;
  } else if (parked) {
    if (pastLine) crossedLine = true;
    if (++outside >= unparkFixes) {
      parked = false;
      outside = 0;
      entered = false;
    }
  } else if (entered && ++outside >= unparkFixes) {
    entered = false;
    outside = 0;
  }
  return parked;
}

void ParkedReporter::reset() {
  nextAt = now() + (firstMs < 0 ? interval() : rand() * firstMs);
  firstDone = false;
  repeatsLeft = repeatMs > 0 ? 1 : 0;
}

void ParkedReporter::sent() {
  if (!firstDone) {
    firstDone = true;
    nextAt = now() + (repeatsLeft > 0 ? repeatDelay() : interval());
  } else if (repeatsLeft > 0) {
    repeatsLeft--;
    nextAt = now() + interval();
  } else {
    nextAt = now() + interval();
  }
}

JoinBackoff::JoinBackoff(double maxMs, std::vector<double> stepsIn, std::function<double()> now, std::function<double()> rand, double jitter)
    : jitter(jitter), now(std::move(now)), rand(std::move(rand)) {
  stepsIn.push_back(maxMs);
  for (double x : stepsIn) steps.push_back(std::min(x, maxMs));
}

void JoinBackoff::sent() {
  const double base = steps[std::min(step, steps.size() - 1)];
  nextAt = now() + base * (1 - jitter + 2 * jitter * rand());
  step++;
}

void SlotTableFollower::toJoinSlots(int slotCount, double widthMs, int joinSlots) {
  scheduler.setSlotJoin(slotCount, widthMs, SlotJoin{slotCount - joinSlots, joinSlots});
}

void SlotTableFollower::setParked(bool p) {
  if (pinned || p == parked) return;
  parked = p;
  if (parked && hasLayout && layoutJoinSlots > 0) {
    assigned = -1;
    toJoinSlots(layoutSlotCount, layoutWidthMs, layoutJoinSlots);
  }
}

bool SlotTableFollower::onTable(const protocol::SlotTable& table) {
  if (pinned) return false;
  tablesHeard++;
  lastVersion = table.version;
  if (table.practice != practice) {
    practice = table.practice;
    if (onPractice) onPractice(practice);
  }
  hasLayout = true;
  layoutSlotCount = table.slotCount;
  layoutWidthMs = table.slotWidthMs;
  layoutJoinSlots = table.joinSlots;
  const SlotConfig& cur = scheduler.slot();
  const protocol::SlotEntry* mine = nullptr;
  if (!parked)
    for (const auto& e : table.entries)
      if (e.boatId == boatId) {
        mine = &e;
        break;
      }
  if (mine) {
    hasLastEntry = true;
    lastEntryAt = now();
    tablesSince = 0;
  } else if (assigned >= 0 && !parked) {
    tablesSince++;
    if (hasLastEntry && now() - lastEntryAt >= revertAfterMs && tablesSince >= 3) {
      assigned = -1;
      if (layoutJoinSlots > 0) toJoinSlots(layoutSlotCount, layoutWidthMs, layoutJoinSlots);
      log("[slots] the base no longer lists this boat - back to the shared join slots");
    }
  }
  if (!mine) {
    if (assigned >= 0 || table.joinSlots < 1) return false;
    const int first = table.slotCount - table.joinSlots;
    if (cur.count == table.slotCount && cur.widthMs == table.slotWidthMs && cur.hasJoin && cur.join.first == first && cur.join.n == table.joinSlots)
      return false;
    toJoinSlots(table.slotCount, table.slotWidthMs, table.joinSlots);
    return false;
  }
  if (assigned == mine->slot && !cur.hasJoin && cur.index == mine->slot && cur.count == table.slotCount && cur.widthMs == table.slotWidthMs)
    return false;
  assigned = mine->slot;
  scheduler.setSlotIndex(mine->slot, table.slotCount, table.slotWidthMs);
  log("[slots] base assigned slot " + std::to_string(mine->slot) + " of " + std::to_string(table.slotCount - table.joinSlots) + " (" +
      std::to_string(table.slotWidthMs) + " ms each), table v" + std::to_string(table.version));
  if (onAssigned) onAssigned(mine->slot);
  return true;
}

}  // namespace rover
