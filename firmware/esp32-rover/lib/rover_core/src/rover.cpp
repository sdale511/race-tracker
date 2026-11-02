#include "rover.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

#include "js_math.h"
#include "thin_fixes.h"

namespace rover {

namespace {
// windwardGreen, windwardBlack, leewardGreen, leewardBlack - boatAgent.js's ROUNDING_MARKS, as MARK_NAMES indexes
constexpr int ROUNDING_MARKS[] = {0, 1, 2, 3};
constexpr int COMMITTEE_FINISH = 6;
constexpr int FINISH = 7;
}  // namespace

Rover::Rover(RoverConfig config, RoverHal hal)
    : cfg_(std::move(config)),
      hal_(std::move(hal)),
      tracker_(),
      gate_(tracker_, cfg_.blockBeforeMs, cfg_.blockAfterMs, cfg_.guardMs),
      sleeper_(hal_.canSleep, cfg_.sleepListenMs, cfg_.sleepCycleS, hal_.setRadioSleeping, hal_.monoMs, hal_.log),
      gpsSleep_(
          true, [this](const std::vector<uint8_t>& b) { return hal_.gpsWrite(b.data(), b.size()); }, cfg_.gpsSleepForceUsb, hal_.monoMs,
          hal_.log),
      distanceGate_(cfg_.txIntervalMs),
      maxFixesPerFrame_(cfg_.txDelta ? (int)protocol::MAX_DELTA_COUNT : (int)protocol::MAX_BATCH_COUNT) {
  auto rnd = hal_.random;
  auto mono = hal_.monoMs;
  joinBackoff_.reset(new JoinBackoff(cfg_.joinReportS * 1000, {0, 1000, 2000, 4000, 8000}, mono, rnd));
  movingBackoff_.reset(new JoinBackoff(4000, {0, 2000}, mono, rnd));
  diagState_.since = now();
  diagState_.watchBursts = cfg_.txGateEnabled && cfg_.rtcmWatch;

  if (cfg_.txGateEnabled) {
    // Until a table arrives the boat assumes the layout the base works out from the same settings (see boatAgent.js)
    const int slotCount = cfg_.slotCount > 0 ? cfg_.slotCount : autoSlotCount(cfg_.joinSlots, cfg_.rtcmIntervalS, cfg_.slotWidthMs, gate_);
    const int pinned = cfg_.slotIndex >= 0 ? cfg_.slotIndex % slotCount : -1;
    const int joinSlots = std::min(cfg_.joinSlots, slotCount - 1);
    SlotConfig slot;
    slot.enabled = cfg_.slotEnabled;
    slot.count = slotCount;
    slot.widthMs = cfg_.slotWidthMs;
    slot.index = pinned >= 0 ? pinned : slotCount - 1;
    if (pinned < 0 && joinSlots > 0) {
      slot.hasJoin = true;
      slot.join = {slotCount - joinSlots, joinSlots};
    }
    if (cfg_.slotEnabled) {
      log(pinned >= 0 ? "[txgate] slot mode: slot " + std::to_string(pinned) + " of " + std::to_string(slotCount) + " (set by TX_SLOT; the base's slot table is ignored)"
                      : "[txgate] slot mode: waiting for the base's slot table - sharing the last " + std::to_string(joinSlots) + " of " + std::to_string(slotCount) +
                            " slots until a slot is assigned");
    }
    scheduler_.reset(new TxScheduler([this](const std::vector<uint8_t>& b) { return rawSend(b); }, tracker_, gate_, slot, cfg_.maxQueue,
                                     cfg_.maxAgeMs, mono, rnd, hal_.log));
    // a frame the scheduler gives up on must not leave its fixes counted as reported (see boatAgent.js)
    scheduler_->onSent = [this](const TxFrame& f) {
      if (f.hasFix) distanceGate_.sent(f.lastFix);
    };
    scheduler_->onDropped = [this](const TxFrame&) { distanceGate_.failed(); };
    if (cfg_.slotEnabled) {
      follower_.reset(new SlotTableFollower(cfg_.boatId, *scheduler_, pinned >= 0, mono, hal_.log));
      follower_->onPractice = [this](bool on) {
        practiceMode_ = on;
        log(on ? "[slots] the base is in practice mode - no start-grid parking, any moving boat gets a slot"
               : "[slots] the base left practice mode - start-grid parking is back");
      };
      follower_->onAssigned = [this](int) {
        joinBackoff_->reset();
        movingBackoff_->reset();
      };
      scheduler_->startSlotFlush([this]() { flushPendingBatch(true, false); });
    }
  }
  parkingEnabled_ = cfg_.txGateEnabled && cfg_.slotEnabled && cfg_.slotIndex < 0;

  // the radio's receive side
  scanner_.onMarks = [this](const protocol::Marks& m) {
    diagState_.lastBaseRxAt = now();
    const bool first = !freshMarksReceived_;
    marks_ = m;
    hasMarks_ = true;
    freshMarksReceived_ = true;
    if (hal_.saveMarks) hal_.saveMarks(m);
    if (first) log("[rover] received course marks from base station");
  };
  scanner_.onPing = [this]() {
    diagState_.lastBaseRxAt = now();
    if (!hasLastPvt_ || !hasValidFix(lastPvt_)) return;
    after(hal_.random() * cfg_.pingResponseJitterMs, [this]() { transmitFix(lastPvt_); });
  };
  scanner_.onPower = [this](const protocol::Power& p) {
    diagState_.lastBaseRxAt = now();
    sleeper_.handlePower(p, cfg_.boatId);
  };
  scanner_.onSlotTable = [this](const protocol::SlotTable& t) {
    diagState_.lastBaseRxAt = now();
    if (follower_) follower_->onTable(t);
  };
  scanner_.onPowerSchedule = [this](const protocol::PowerScheduleStamp& s) {
    diagState_.lastBaseRxAt = now();
    if (hasPowerStamp_ && s.stamp == lastPowerStamp_) return;
    hasPowerStamp_ = true;
    lastPowerStamp_ = s.stamp;
    log("[power] heard the base's power schedule - not applied: the ESP32 rover has no Witty Pi or shutdown rule yet");
  };
  scanner_.onRtcm = [this](const protocol::Rtcm& r, const uint8_t* raw) {
    tracker_.onRtcm(r.type, now(), r.length);
    // never into a sleeping receiver: any byte wakes it (see gpsSleep.js)
    if (cfg_.rtcmForward && !sleeper_.isSleeping() && !gpsSleep_.isAsleep()) hal_.gpsWrite(raw, r.length);
  };

  // the GPS
  // A fix without valid UTC is stamped from the clock the last fix with valid UTC set, else the HAL's (an ESP32 has no clock of its own)
  ubxParser_.wallMs = [this]() -> int64_t {
    if (hasWallOffset_) return (int64_t)jsRound(now() + wallOffsetMs_);
    return hal_.wallMs ? hal_.wallMs() : (int64_t)now();
  };
  ubxParser_.onFrame = [this](uint8_t, uint8_t) { diagState_.lastUbxAt = now(); };
  ubxParser_.onPvt = [this](const Pvt& p) { onGpsFix(p); };
  ubxParser_.onRxmRtcm = [this](const ubx::RxmRtcm&) { diagState_.lastRxmRtcmAt = now(); };

  // sleep
  sleeper_.onSleep = [this]() {
    pendingBatch_.clear();
    announceNextFix_ = false;
    gpsSleep_.sleep();
  };
  sleeper_.onWake = [this]() {
    diagState_.since = now();
    gpsSleep_.wake();
    announceNextFix_ = true;
    after(hal_.random() * cfg_.pingResponseJitterMs, [this]() { sendHello(true); });
  };

  // the last-known course, so a restart has one at once
  if (hal_.loadMarks && hal_.loadMarks(marks_)) {
    hasMarks_ = true;
    log("[rover] loaded last-known course marks");
  }
}

void Rover::begin() { startHelloAnnounce(); }

void Rover::setGpsPortOpen(bool open) {
  diagState_.gpsPortOpen = open;
  if (open) gpsSleep_.wakeOnStartup();
}

void Rover::onRadioBytes(const uint8_t* data, size_t len) { scanner_.write(data, len); }

void Rover::onGpsBytes(const uint8_t* data, size_t len) {
  diagState_.lastGpsBytesAt = now();
  ubxParser_.write(data, len);
}

// Nothing transmits while the rover is in sleep mode - including during a listen window
bool Rover::rawSend(const std::vector<uint8_t>& buf) {
  if (sleeper_.isSleeping()) return false;
  return hal_.radioWrite(buf.data(), buf.size());
}

bool Rover::send(TxFrame frame) {
  if (scheduler_) return scheduler_->submit(std::move(frame));
  return rawSend(frame.buf);
}

void Rover::after(double delayMs, std::function<void()> fn) { timers_.push_back({now() + delayMs, std::move(fn)}); }

void Rover::tick() {
  if (scheduler_) scheduler_->tick();
  sleeper_.tick();
  gpsSleep_.tick();
  const double t = now();
  if (helloNextAt_ >= 0 && t >= helloNextAt_) {
    const bool first = !helloStarted_;
    helloStarted_ = true;
    helloNextAt_ = t + HELLO_RETRY_MS;
    sendHello(first);
  }
  // run what is due; a timer can add more, so take the due ones out first
  std::vector<Timer> due;
  for (auto it = timers_.begin(); it != timers_.end();) {
    if (t >= it->at) {
      due.push_back(std::move(*it));
      it = timers_.erase(it);
    } else {
      ++it;
    }
  }
  for (auto& d : due) d.fn();
  checkRtcmWatchdog();
}

// ---- fixes ----

void Rover::onGpsFix(const Pvt& pvt) {
  diagState_.lastPvtAt = now();
  if (pvt.utcValid) {
    wallOffsetMs_ = (double)pvt.timestamp - now();
    hasWallOffset_ = true;
  }
  diagPvt_ = pvt;
  hasDiagPvt_ = true;
  if (gpsSleep_.shouldDrop(hasValidFix(pvt), pvt.carrSoln == 2)) return;
  handlePvt(pvt);
  if (announceNextFix_ && hasValidFix(pvt) && !sleeper_.isSleeping()) {
    announceNextFix_ = false;
    if (!pendingBatch_.empty()) flushPendingBatch(false, false);
    else if (!hasLastTx_ || lastTxTime_ != pvt.timestamp) transmitFix(pvt);
  }
}

void Rover::handlePvt(const Pvt& pvt) {
  lastPvt_ = pvt;
  hasLastPvt_ = true;
  const bool clearedTxGate = distanceGate_.cleared(pvt, cfg_.txDistanceM);
  if (!clearedTxGate) return;
  if (hasValidFix(pvt)) {
    distanceGate_.advance(pvt);
    if (cfg_.txBatchSize > 1) queueFixForTx(pvt);
    else transmitFix(pvt);
  } else if (now() - lastInvalidFixWarnAt_ > INVALID_FIX_WARN_INTERVAL_MS) {
    lastInvalidFixWarnAt_ = now();
    log("[gps] no valid fix (gnssFixOk=" + std::string(pvt.gnssFixOk ? "true" : "false") + ") - not transmitting");
  }
}

bool Rover::isNearRoundingMark(const Pvt& fix) const {
  if (!cfg_.markZoneM || !hasMarks_) return false;
  for (int i : ROUNDING_MARKS)
    if (distanceMeters(marks_.mark[i], latLonOf(fix)) <= cfg_.markZoneM) return true;
  const LatLon& cf = marks_.mark[COMMITTEE_FINISH];
  const LatLon& f = marks_.mark[FINISH];
  return distanceToSegmentM(latLonOf(fix), cf, f) <= cfg_.markZoneM && headingUpwind(fix, cf, f);
}

bool Rover::joinThrottleActive() const {
  return cfg_.joinReportS > 0 && parkingEnabled_ && scheduler_ && scheduler_->slot().hasJoin && scheduler_->slotAligned();
}

// The pacing that applies to this boat's radio sends right now, or null for none: sharing the join slots without a slot of its own.
// (Parking on the start grid is not ported yet, so the parked pacer never applies.)
Pacer* Rover::sendPacer() {
  if (joinThrottleActive()) {
    if (hasLastPvt_ && speedKnots(lastPvt_) > MOVING_UNTHROTTLED_KN) return isNearRoundingMark(lastPvt_) ? nullptr : movingBackoff_.get();
    return joinBackoff_.get();
  }
  return nullptr;
}

void Rover::transmitFix(const Pvt& pvt) {
  if (sleeper_.isSleeping()) return;
  Pacer* pacer = sendPacer();
  if (pacer) {
    if (!pacer->due()) {
      distanceGate_.failed();
      return;
    }
    pacer->sent();
  }
  TxFrame frame{protocol::encode(cfg_.boatId, pvt), true, pvt};
  const bool sent = send(std::move(frame));
  if (sent) {
    hasLastTx_ = true;
    lastTxTime_ = pvt.timestamp;
    if (!scheduler_) distanceGate_.sent(pvt);
    framesSent_++;
  } else {
    distanceGate_.failed();
    log("[radio] dropped a frame (" + std::string(sleeper_.isSleeping() ? "asleep" : "not written") + ")");
  }
}

void Rover::queueFixForTx(const Pvt& pvt) {
  Pacer* pacer = sendPacer();
  if (pacer) {
    if (isWaitingPacer(pacer)) holdWhileWaiting(pendingBatch_);
    pendingBatch_.assign(1, pvt);
    return;
  }
  pendingBatch_.push_back(pvt);
  const bool slotHeld = scheduler_ && scheduler_->slotAligned() && pendingBatch_.size() < SLOT_PENDING_CAP;
  const bool batchFull = !slotHeld && (int)pendingBatch_.size() >= cfg_.txBatchSize;
  const bool batchStale = cfg_.txIntervalMs > 0 && pvt.timestamp - pendingBatch_.front().timestamp >= cfg_.txIntervalMs;
  if (batchFull || batchStale) flushPendingBatch(false, false);
}

void Rover::holdWhileWaiting(const std::vector<Pvt>& list) {
  if (list.empty()) return;
  waitingFixes_.insert(waitingFixes_.end(), list.begin(), list.end());
  const int64_t cutoff = waitingFixes_.back().timestamp - BACKFILL_MAX_AGE_MS;
  auto keep = std::find_if(waitingFixes_.begin(), waitingFixes_.end(), [cutoff](const Pvt& f) { return f.timestamp >= cutoff; });
  waitingFixes_.erase(waitingFixes_.begin(), keep);
}

void Rover::flushPendingBatch(bool forSlot, bool final) {
  std::vector<Pvt> fixes;
  fixes.swap(pendingBatch_);
  bool backfilled = false;
  if (fixes.empty()) return;
  if (sleeper_.isSleeping()) return;
  auto protect = [this](const Pvt& f) { return isNearRoundingMark(f); };
  Pacer* pacer = final ? nullptr : sendPacer();
  if (pacer) {
    const bool waiting = isWaitingPacer(pacer);
    if (!waiting) waitingFixes_.clear();
    if (!pacer->due()) {
      if (waiting) holdWhileWaiting(fixes);
      pendingBatch_.assign(1, fixes.back());  // keep the newest for when the report is due (see boatAgent.js)
      return;
    }
    pacer->sent();
    if (waiting) holdWhileWaiting(std::vector<Pvt>(fixes.begin(), fixes.end() - 1));
    fixes.assign(1, fixes.back());
  } else if (!waitingFixes_.empty()) {
    if (forSlot && !final) {
      std::vector<Pvt> held;
      for (const Pvt& f : waitingFixes_)
        if (f.timestamp < fixes.front().timestamp && f.timestamp >= fixes.front().timestamp - BACKFILL_MAX_AGE_MS) held.push_back(f);
      backfilled = !held.empty();
      std::vector<Pvt> kept = thinBackfill(held, protect);
      if (backfilled)
        log("[slots] first cycle in the slot: " + std::to_string(held.size()) + " fixes held while waiting, thinned to " + std::to_string(kept.size()));
      kept.insert(kept.end(), fixes.begin(), fixes.end());
      fixes.swap(kept);
    }
    waitingFixes_.clear();
  }

  // the slot's frame budget - see boatAgent.js's flushPendingBatch
  if (forSlot && !final && cfg_.maxHz > 0 && scheduler_ && tracker_.period() != BurstTracker::NONE) {
    const double period = tracker_.period();
    const int byRate = std::max(1, (int)jsRound((cfg_.maxHz * period) / 1000));
    const int framesInSlot =
        std::max(1, (int)std::floor((scheduler_->slot().widthMs - gate_.guardMs) / airMs(protocol::deltaFrameLen(protocol::MAX_DELTA_COUNT))));
    const int perFrameMax = maxFixesPerFrame_;
    const bool nearMark = std::any_of(fixes.begin(), fixes.end(), protect);
    const bool wholeSlot = nearMark || backfilled;
    const int bySlot = perFrameMax * (wholeSlot ? framesInSlot : std::max(1, framesInSlot - cfg_.reserveFrames));
    const int cap = wholeSlot ? bySlot : std::min(byRate, bySlot);
    if ((int)fixes.size() > cap) {
      const Pvt* anchor = hasLastBatchFix_ && fixes.front().timestamp - lastBatchFix_.timestamp < 5000 ? &lastBatchFix_ : nullptr;
      fixes = thinForTurns(fixes, cap, anchor, 480, protect);
    }
  }
  lastBatchFix_ = fixes.back();
  hasLastBatchFix_ = true;
  const size_t perFrame = forSlot ? maxFixesPerFrame_ : std::max(1, cfg_.txBatchSize);
  for (size_t i = 0; i < fixes.size(); i += perFrame)
    sendFixes(std::vector<Pvt>(fixes.begin() + i, fixes.begin() + std::min(fixes.size(), i + perFrame)));
}

void Rover::sendFixes(const std::vector<Pvt>& fixes) {
  std::vector<protocol::Frame> frames;
  if (fixes.size() == 1) frames.push_back({protocol::encode(cfg_.boatId, fixes[0]), 1});
  else if (cfg_.txDelta) frames = protocol::encodeDeltaFrames(cfg_.boatId, fixes);
  else frames.push_back({protocol::encodeBatch(cfg_.boatId, fixes), fixes.size()});
  size_t consumed = 0;
  for (auto& f : frames) {
    consumed += f.count;
    const Pvt& last = fixes[consumed - 1];
    const bool sent = send(TxFrame{std::move(f.buf), true, last});
    if (sent) {
      hasLastTx_ = true;
      lastTxTime_ = last.timestamp;
      if (!scheduler_) distanceGate_.sent(last);
      framesSent_++;
    } else {
      distanceGate_.failed();
      log("[radio] dropped " + std::string(f.count == 1 ? "a frame" : "a batch of " + std::to_string(f.count) + " fixes"));
    }
  }
}

// ---- hello ----

diag::Report Rover::currentDiag() const {
  diag::State s = diagState_;
  s.gpsAsleep = gpsSleep_.isAsleep();
  s.burstsHeard = tracker_.isActive(now());
  diag::Report r;
  r.flags = diag::computeFlags(s, now());
  r.power = 0;
  r.hasPvt = hasDiagPvt_;
  r.numSV = hasDiagPvt_ ? diagPvt_.numSV : 0;
  r.fixType = hasDiagPvt_ ? diagPvt_.fixType : 0;
  return r;
}

void Rover::sendHello(bool force) {
  if (sleeper_.isSleeping()) return;
  const diag::Report d = currentDiag();
  const std::string key = diag::problemKey(d);
  const double t = now();
  const bool due = force || !hasLastTx_ || !hasLastHelloKey_ || key != lastHelloKey_ || (diag::hasProblem(d) && t - lastHelloAt_ >= HELLO_PROBLEM_MS);
  if (!due) return;
  protocol::StatusHello h;
  h.boatId = cfg_.boatId;
  h.flags = d.flags;
  h.power = d.power;
  h.numSV = d.numSV;
  h.hasPvt = d.hasPvt;
  h.fixType = d.fixType;
  h.carrSoln = hasDiagPvt_ ? diagPvt_.carrSoln : 0;
  h.build = cfg_.build;
  h.dirty = cfg_.dirty;
  if (send(TxFrame{protocol::encodeStatusHello(h), false, Pvt()})) {
    lastHelloAt_ = t;
    lastHelloKey_ = key;
    hasLastHelloKey_ = true;
  } else {
    log("[radio] dropped a hello frame (will keep retrying)");
  }
}

// a random delay before the first hello so a fleet powered up together doesn't key up together; then every HELLO_RETRY_MS, which
// sendHello turns into "only when there is something to say" once a fix has gone out
void Rover::startHelloAnnounce() {
  helloStarted_ = false;
  helloNextAt_ = now() + hal_.random() * cfg_.helloStartupJitterMs;
}

// rtcmWatchdog.js, reduced to its console warning: the correction bursts are not heard
void Rover::checkRtcmWatchdog() {
  if (!cfg_.txGateEnabled || !cfg_.rtcmWatch || sleeper_.isSleeping() || gpsSleep_.isAsleep()) return;
  const double t = now();
  if (tracker_.isActive(t) || t - diagState_.since < cfg_.rtcmWarnS * 1000) return;
  if (t - rtcmWarnedAt_ < cfg_.rtcmRepeatS * 1000) return;
  rtcmWarnedAt_ = t;
  log("[rtcm] no correction bursts heard on the radio - no RTK, and no transmit slot timing");
}

}  // namespace rover
