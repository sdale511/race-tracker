#include "rover.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>

#include "js_math.h"
#include "thin_fixes.h"

namespace rover {

namespace {
// windwardGreen, windwardBlack, leewardGreen, leewardBlack - boatAgent.js's ROUNDING_MARKS, as MARK_NAMES indexes
constexpr int ROUNDING_MARKS[] = {0, 1, 2, 3};
constexpr int COMMITTEE_FINISH = 6;
constexpr int FINISH = 7;

// A number as JavaScript prints it in a template string: 1, 0.3, 40.897 (the shortest digits that read back the same)
std::string num(double v) {
  char b[32];
  if (v == std::floor(v) && std::fabs(v) < 1e15) {
    std::snprintf(b, sizeof b, "%lld", (long long)v);
    return b;
  }
  for (int prec = 1; prec <= 17; prec++) {
    std::snprintf(b, sizeof b, "%.*g", prec, v);
    if (std::strtod(b, nullptr) == v) break;
  }
  return b;
}
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
      policy_(hal_.clock),
      maxFixesPerFrame_(cfg_.txDelta ? (int)protocol::MAX_DELTA_COUNT : (int)protocol::MAX_BATCH_COUNT) {
  auto rnd = hal_.random;
  auto mono = hal_.monoMs;
  joinBackoff_.reset(new JoinBackoff(cfg_.joinReportS * 1000, {0, 1000, 2000, 4000, 8000}, mono, rnd));
  movingBackoff_.reset(new JoinBackoff(4000, {0, 2000}, mono, rnd));
  zoneState_ = ZoneState(cfg_.unparkFixes, cfg_.parkDwellS * 1000);
  parkedReporter_.reset(new ParkedReporter(cfg_.parkedReportS * 1000, cfg_.parkedFirstS * 1000, cfg_.parkedRepeatS * 1000, mono, rnd));
  diagState_.since = now();
  diagState_.watchBursts = cfg_.txGateEnabled && cfg_.rtcmWatch;
  rtcmStartedAt_ = now();
  // Until a table arrives the boat assumes the layout the base works out from the same settings (see boatAgent.js)
  if (cfg_.txGateEnabled)
    slotCount_ = cfg_.slotCount > 0 ? cfg_.slotCount : autoSlotCount(cfg_.joinSlots, cfg_.rtcmIntervalS, cfg_.slotWidthMs, gate_);
  logStartup();

  if (cfg_.txGateEnabled) {
    const int slotCount = slotCount_;
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
      log(pinned >= 0 ? "[txgate] slot mode: slot " + std::to_string(pinned) + " of " + std::to_string(slotCount) + ", " + num(cfg_.slotWidthMs) +
                            " ms each (set by TX_SLOT; the base's slot table is ignored)"
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
        if (on && parked_) {
          parked_ = false;
          follower_->setParked(false);
        }
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
    rebuildWatchers();
    lastMarksAt_ = now();
    if (hal_.saveMarks) hal_.saveMarks(m);
    if (first) log("[boatAgent] received course marks from base station");
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
    lastSlotTableAt_ = now();
    lastSlotTableVersion_ = t.version;
    if (follower_) follower_->onTable(t);
  };
  scanner_.onPowerSchedule = [this](const protocol::PowerSchedule& s) {
    diagState_.lastBaseRxAt = now();
    lastScheduleAt_ = now();
    scheduleFromStorage_ = false;
    // the base repeats it every minute or so: apply (and keep, for the next boot) only a new version
    if (hasPowerStamp_ && s.stamp == lastPowerStamp_) return;
    hasPowerStamp_ = true;
    lastPowerStamp_ = s.stamp;
    policy_.setSchedule(s);
    if (hal_.saveSchedule) hal_.saveSchedule(s);
    log("[power] heard the base's power schedule (" + std::string(cfg_.radioDesc.rfind("simulated", 0) == 0 ? "simulated radio" : "radio") +
        ") - Witty Pi: " + (s.hasWitty ? describeWitty(s) : "not set by the base") + "; shutdown: " + (s.hasShutdown ? describeShutdown(s) : "not set by the base") +
        " - applied as deep sleep");
  };
  scanner_.onRtcm = [this](const protocol::Rtcm& r, const uint8_t* raw) {
    tracker_.onRtcm(r.type, now(), r.length);
    // never into a sleeping receiver: any byte wakes it (see gpsSleep.js)
    if (cfg_.rtcmForward && !sleeper_.isSleeping() && !gpsSleep_.isAsleep()) hal_.gpsWrite(raw, r.length);
  };

  // the GPS
  // A fix without valid UTC is stamped from the clock the last fix with valid UTC set, else the HAL's (an ESP32 has no clock of its own)
  ubxParser_.wallMs = [this]() -> int64_t {
    int64_t w;
    return wallNow(w) ? w : (hal_.wallMs ? hal_.wallMs() : (int64_t)now());
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
  // the base's last power schedule, so a boat that wakes from deep sleep keeps to it before it hears the base again
  protocol::PowerSchedule saved;
  if (hal_.loadSchedule && hal_.loadSchedule(saved)) {
    policy_.setSchedule(saved);
    hasPowerStamp_ = true;
    lastPowerStamp_ = saved.stamp;
    scheduleFromStorage_ = true;
  }
  if (hal_.loadMarks && hal_.loadMarks(marks_)) {
    hasMarks_ = true;
    marksFromStorage_ = true;
    rebuildWatchers();
    std::string names;
    for (size_t i = 0; i < protocol::MARK_COUNT; i++) names += (i ? ", " : "") + std::string(protocol::MARK_NAMES[i]);
    log("[boatAgent] loaded last-known course marks from storage: " + names);
  }
}

// Rebuilt whenever the marks change, so they always describe the course as it is now (boatAgent.js's rebuildFinishApproachWatcher /
// rebuildZoneWatcher). A marks frame always carries every mark, so all of them can be built.
void Rover::rebuildWatchers() {
  finishApproach_.reset(new FinishApproachWatcher(marks_));
  eventBoost_.reset(new EventBoost(marks_, cfg_.onGridZoneM));
  zoneWatcher_.reset(new OnGridWatcher(marks_, cfg_.onGridZoneM));
}

// Parked: inside the on-grid zone behind the start line, the boat takes no slot and reports in the join slots only every parkedReportS
// (see boatAgent.js's updateParked)
void Rover::updateParked(const Pvt& pvt) {
  if (practiceMode_ || !parkingEnabled_ || !zoneWatcher_ || !hasValidFix(pvt)) return;
  const bool inZone = zoneWatcher_->check(pvt.lat, pvt.lon) == OnGridWatcher::ONGRID;
  const bool stationary = speedKnots(pvt) < cfg_.movingKn;
  const bool now = zoneState_.update(inZone, false, (double)pvt.timestamp, stationary);
  if (now == parked_) return;
  parked_ = now;
  if (follower_) follower_->setParked(parked_);
  if (parked_) parkedReporter_->reset();
  log(parked_ ? "[slots] on the start grid - parked: no slot, reporting every ~" + std::to_string((int)cfg_.parkedReportS) + " s in the shared join slots"
              : "[slots] left the start grid - waiting for the base to assign a slot");
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
  checkPower();
  maybeLogStatus();
  maybeLogReady();
}

bool Rover::wallNow(int64_t& out) const {
  if (hasWallOffset_) {
    out = (int64_t)jsRound(now() + wallOffsetMs_);
    return true;
  }
  // after a deep sleep the ESP32's RTC still has the time the GPS last set
  if (hal_.wallClockValid && hal_.wallClockValid()) {
    out = hal_.wallMs();
    return true;
  }
  return false;
}

// The power schedule, every few seconds once the time is known (see power_policy.h). Asks for deep sleep once; the HAL does it.
void Rover::checkPower() {
  const double t = now();
  if (sleepRequested_ || t - lastPowerCheckAt_ < POWER_CHECK_MS || !hal_.requestDeepSleep || !hal_.clock.toLocal) return;
  lastPowerCheckAt_ = t;
  int64_t wall;
  if (!wallNow(wall)) return;
  const PowerPolicy::Decision d = policy_.evaluate(wall, hasLastPvt_ ? &lastPvt_ : nullptr, sleeper_.isSleeping(), cfg_.motionWoken);
  if (!d.sleep) return;
  sleepRequested_ = true;
  log("[power] going to sleep: " + d.reason + (d.hasWakeAt ? ", waking when the on window opens" : ", waking on motion"));
  if (scheduler_) scheduler_->flushNow();
  gpsSleep_.sleep();
  hal_.requestDeepSleep(d);
}

namespace {
std::string hhmm(int m) {
  char b[16];
  std::snprintf(b, sizeof b, "%02d:%02d", m / 60, m % 60);
  return b;
}
}  // namespace

// wittySchedule.js's describe
std::string Rover::describeWitty(const protocol::PowerSchedule& s) {
  if (s.wittyMode == 0) return "no schedule";
  const std::string tail = s.haltItself ? ", the boat halts itself when idle" : ", the Witty Pi shuts the Pi down at the end";
  if (s.wittyMode == 1) return "on " + hhmm(s.startMin) + " to " + hhmm(s.endMin) + " every day" + tail;
  return "on " + std::to_string(s.beforeMin) + " min before sunrise to " + std::to_string(s.afterMin) + " min after sunset at " + num(s.lat) + ", " +
         num(s.lon) + tail;
}

// fleetShutdown.js's describe
std::string Rover::describeShutdown(const protocol::PowerSchedule& s) {
  if (!s.shutdownEnabled) return "disabled";
  if (!s.whenIdle) return "at " + hhmm(s.shutdownMin) + " local time, whatever the boat is doing";
  return "after " + hhmm(s.shutdownMin) + " local time, once stopped (under " + num(s.speedKn) + " kn) for " + std::to_string(s.idleMinutes) + " min";
}

// ---- fixes ----

void Rover::onGpsFix(const Pvt& pvt) {
  diagState_.lastPvtAt = now();
  lastPvtAt_ = now();
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
  updateParked(pvt);
  // closing on the finish line upwind: a tighter distance gate (TX_FINISH_APPROACH_ZONE_M, off by default)
  const double distanceM = cfg_.txFinishApproachZoneM > 0 && finishApproach_ &&
                                   finishApproach_->isApproachingUpwind(pvt.lat, pvt.lon, cfg_.txFinishApproachZoneM)
                               ? cfg_.txFinishDistanceM
                               : cfg_.txDistanceM;
  // a start, finish or foul crossing seen on the boat's own fixes: the fixes just before it go back in the batch and everything just
  // after goes through, so the base sees the pair that straddles the line (see eventBoost.js)
  bool urgent = false;
  if (eventBoost_ && hasValidFix(pvt)) {
    const EventBoost::Result boost = eventBoost_->onFix(pvt);
    urgent = boost.urgent;
    const int64_t lastQueuedAt = pendingBatch_.empty() ? INT64_MIN : pendingBatch_.back().timestamp;
    for (const Pvt& f : boost.before)
      if (f.timestamp > lastQueuedAt) pendingBatch_.push_back(f);
  }
  const bool clearedTxGate = urgent || distanceGate_.cleared(pvt, distanceM) || (parked_ && parkedReporter_->wantsRepeat());
  // GPS_LOG: every fix gets a console line, as boatAgent.js's (scrolling; no in-place overwrite)
  if (cfg_.gpsLog) {
    const int64_t ms = ((pvt.timestamp % 86400000) + 86400000) % 86400000;
    char b[160];
    std::snprintf(b, sizeof b, "[gps] %02d:%02d:%02d.%03d %.6f,%.6f fixType=%d diffSoln=%s carrSoln=%d numSV=%d hAcc=%.2fm", (int)(ms / 3600000),
                  (int)(ms / 60000 % 60), (int)(ms / 1000 % 60), (int)(ms % 1000), pvt.lat, pvt.lon, pvt.fixType, pvt.diffSoln ? "true" : "false",
                  pvt.carrSoln, pvt.numSV, pvt.hAccMm / 1000.0);
    log(b);
  }
  if (!clearedTxGate) return;
  if (hasValidFix(pvt)) {
    distanceGate_.advance(pvt);
    if (cfg_.txBatchSize > 1) queueFixForTx(pvt);
    else transmitFix(pvt);
  } else if (now() - lastInvalidFixWarnAt_ > INVALID_FIX_WARN_INTERVAL_MS) {
    lastInvalidFixWarnAt_ = now();
    log("[gps] no valid fix (gnssFixOk=" + std::string(pvt.gnssFixOk ? "true" : "false") + " lat=" + num(pvt.lat) + " lon=" + num(pvt.lon) +
        ") - not transmitting");
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
  return !parked_ && cfg_.joinReportS > 0 && parkingEnabled_ && scheduler_ && scheduler_->slot().hasJoin && scheduler_->slotAligned();
}

// The pacing that applies to this boat's radio sends right now, or null for none: parked on the start grid, or sharing the join slots
// without a slot of its own
Pacer* Rover::sendPacer() {
  if (eventBoost_ && hasLastPvt_ && eventBoost_->isUrgent(lastPvt_.timestamp)) return nullptr;  // a line crossing must be seen
  if (parked_ && cfg_.parkedReportS > 0 && scheduler_ && scheduler_->slotAligned()) return parkedReporter_.get();
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
    lastTxAt_ = now();
    if (!scheduler_) distanceGate_.sent(pvt);
    framesSent_++;
  } else {
    distanceGate_.failed();
    log("[radio] " + radioDropReason() + ", dropped a frame");
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
  std::string backfillLog;  // what the first cycle in a slot did with the fixes held while waiting - logged once below
  size_t backfillTotal = 0;
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
      if (backfilled) {
        char b[160];
        std::snprintf(b, sizeof b, "[slots] first cycle in the slot: %zu fixes held over %.1f s while waiting, thinned to %zu; with this cycle's %zu that is %zu",
                      held.size(), (held.back().timestamp - held.front().timestamp) / 1000.0, kept.size(), fixes.size(), kept.size() + fixes.size());
        backfillLog = b;
        backfillTotal = kept.size() + fixes.size();
      }
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
  if (!backfillLog.empty()) {
    (void)backfillTotal;
    log(backfillLog + ", sending " + std::to_string(fixes.size()) + " (about " + std::to_string((fixes.size() + maxFixesPerFrame_ - 1) / maxFixesPerFrame_) +
        " frame(s))");
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
      lastTxAt_ = now();
      if (!scheduler_) distanceGate_.sent(last);
      framesSent_++;
    } else {
      distanceGate_.failed();
      log("[radio] " + radioDropReason() + ", dropped " + (f.count == 1 ? std::string("a frame") : "a batch of " + std::to_string(f.count) + " frames"));
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
    log("[radio] " + radioDropReason() + ", dropped a hello frame (will keep retrying)");
  }
}

// a random delay before the first hello so a fleet powered up together doesn't key up together; then every HELLO_RETRY_MS, which
// sendHello turns into "only when there is something to say" once a fix has gone out
void Rover::startHelloAnnounce() {
  helloStarted_ = false;
  helloNextAt_ = now() + hal_.random() * cfg_.helloStartupJitterMs;
}

// rtcmWatchdog.js: warns once the correction bursts have been missing for RTCM_WATCHDOG_WARN_S (counted from the start if none were
// ever heard), repeats every RTCM_WATCHDOG_REPEAT_S, says so when they come back; paused while the radio or GPS sleeps. Every 5 s.
void Rover::checkRtcmWatchdog() {
  if (!cfg_.txGateEnabled || !cfg_.rtcmWatch) return;
  const double t = now();
  if (t - rtcmCheckedAt_ < 5000) return;
  rtcmCheckedAt_ = t;
  if (sleeper_.isSleeping() || gpsSleep_.isAsleep()) {
    rtcmStartedAt_ = t;
    rtcmMissing_ = false;
    return;
  }
  if (tracker_.isActive(t)) {
    if (rtcmMissing_) log("[rtcm] correction bursts heard again after " + std::to_string((long)jsRound((t - rtcmMissingSince_) / 1000)) + " s");
    rtcmMissing_ = false;
    return;
  }
  const double last = tracker_.lastStart();
  const bool heard = last != BurstTracker::NONE && last >= rtcmStartedAt_;
  const double since = heard ? last : rtcmStartedAt_;
  const double silentMs = t - since;
  if (silentMs < cfg_.rtcmWarnS * 1000) return;
  if (!rtcmMissing_) {
    rtcmMissing_ = true;
    rtcmMissingSince_ = since;
  }
  if (t - rtcmLastWarnAt_ < cfg_.rtcmRepeatS * 1000) return;
  rtcmLastWarnAt_ = t;
  const std::string secs = std::to_string((long)jsRound(silentMs / 1000));
  log((heard ? "[rtcm] WARNING: no correction bursts heard for " + secs + " s - out of range of the base, or its correction radio is off. "
             : "[rtcm] WARNING: no correction bursts heard since this boat started (" + secs + " s) - is the base's correction radio on and in range? ") +
      "Transmit slots cannot be timed (this boat sends unslotted) and RTK corrections are probably not arriving");
}

// ---- the console and the status page ----

namespace {
std::string onOff(bool b) { return b ? "on" : "off"; }

// boatAgent.js's ageStr: "Xs"/"Xm" ago, or "never"
std::string ageStr(double nowMs, double atMs) {
  if (atMs < 0) return "never";
  const long s = std::max(0L, (long)jsRound((nowMs - atMs) / 1000));
  return s < 60 ? std::to_string(s) + "s" : std::to_string((long)jsRound(s / 60.0)) + "m";
}

std::string fixLabel(const Pvt* p) {
  if (!p) return "none";
  if (p->carrSoln == 2) return "RTK-fixed";
  if (p->carrSoln == 1) return "RTK-float";
  static const char* const LABELS[] = {"no-fix", "dead-reckoning", "2D", "3D", "GNSS+DR", "time-only"};
  return p->fixType <= 5 ? LABELS[p->fixType] : "type" + std::to_string(p->fixType);
}
}  // namespace

// boatAgent.js's startup summary, then the settings it doesn't print but a C++ port might get wrong
void Rover::logStartup() {
  log("[boatAgent] boatId=" + cfg_.boatId + ", race-tracker " + cfg_.version);
  if (cfg_.xbeeNi) log("[boatAgent] xbee node identifier (NI): setting to \"" + cfg_.boatId + "\" when " + cfg_.radioPort + " opens");
  log("[boatAgent] gps=" + cfg_.gpsDesc);
  log("[boatAgent] radio=" + cfg_.radioDesc + " txDistance=" + num(cfg_.txDistanceM) + "m txInterval=" + num(cfg_.txIntervalMs / 1000) + "s");
  std::string line = "[boatAgent] config:";
  for (const auto& kv : configItems()) line += " " + kv.first + "=" + kv.second;
  log(line);
}

Rover::Items Rover::configItems() const {
  Items c;
  c.push_back({"TX_DISTANCE_M", num(cfg_.txDistanceM)});
  c.push_back({"TX_INTERVAL_S", num(cfg_.txIntervalMs / 1000)});
  c.push_back({"TX_BATCH_SIZE", std::to_string(cfg_.txBatchSize)});
  c.push_back({"TX_DELTA", onOff(cfg_.txDelta)});
  c.push_back({"TX_GATE", onOff(cfg_.txGateEnabled)});
  if (cfg_.txGateEnabled) {
    c.push_back({"TX_SLOT_MODE", onOff(cfg_.slotEnabled)});
    c.push_back({"TX_SLOT", cfg_.slotIndex >= 0 ? std::to_string(cfg_.slotIndex) : "base"});
    c.push_back({"TX_SLOT_COUNT", std::to_string(slotCount_) + (cfg_.slotCount > 0 ? "" : " (auto)")});
    c.push_back({"TX_SLOT_MS", num(cfg_.slotWidthMs)});
    c.push_back({"TX_SLOT_JOIN", std::to_string(cfg_.joinSlots)});
    c.push_back({"TX_SLOT_MAX_HZ", num(cfg_.maxHz)});
    c.push_back({"TX_SLOT_MARK_ZONE_M", num(cfg_.markZoneM)});
    c.push_back({"TX_PARKED_REPORT_S", num(cfg_.parkedReportS)});
    c.push_back({"RTCM_WATCHDOG", onOff(cfg_.rtcmWatch)});
  }
  c.push_back({"REGATTAUP_ONGRID_ZONE_M", num(cfg_.onGridZoneM)});
  c.push_back({"TX_FINISH_APPROACH_ZONE_M", num(cfg_.txFinishApproachZoneM)});
  c.push_back({"RTCM_FORWARD", onOff(cfg_.rtcmForward)});
  c.push_back({"radioSleep", hal_.canSleep ? "on" : "off (no SLEEP_RQ)"});
  c.push_back({"GPS_LOG", onOff(cfg_.gpsLog)});
  return c;
}

Rover::Items Rover::statusItems() const {
  const double t = now();
  const Pvt* p = hasLastPvt_ ? &lastPvt_ : nullptr;
  char pos[48] = "none";
  if (p) std::snprintf(pos, sizeof pos, "%.6f,%.6f", p->lat, p->lon);
  char acc[16] = "-";
  if (p) std::snprintf(acc, sizeof acc, "%.2fm", p->hAccMm / 1000.0);
  Items s;
  s.push_back({"gps", fixLabel(p)});
  s.push_back({"acc", acc});
  s.push_back({"sv", std::to_string(p ? p->numSV : 0)});
  s.push_back({"pos", pos});
  s.push_back({"fixAge", ageStr(t, lastPvtAt_)});
  s.push_back({"marks", ageStr(t, lastMarksAt_)});
  s.push_back({"radio", sleeper_.isSleeping() ? "asleep" : "ok"});
  s.push_back({"txAge", ageStr(t, lastTxAt_)});
  // not on the console line
  const double period = tracker_.period();
  s.push_back({"corrections", tracker_.isActive(t) ? "heard" + (period != BurstTracker::NONE ? " (every " + num(jsRound(period) / 1000) + " s)" : std::string()) : "not heard"});
  s.push_back({"slot", parked_ ? "parked on the start grid" : assignedSlot() >= 0 ? std::to_string(assignedSlot()) : "none yet (join slots)"});
  s.push_back({"practice", onOff(practiceMode_)});
  s.push_back({"gpsSleep", gpsSleep_.isAsleep() ? "asleep (backup)" : "awake"});
  s.push_back({"framesSent", std::to_string(framesSent_)});
  s.push_back({"syncErrors", std::to_string(scanner_.syncErrors)});
  int64_t wall;
  s.push_back({"powerWindow", !wallNow(wall) ? "time unknown" : !policy_.windowManaged() ? "not managed" : policy_.inWindow(wall) ? "in the on window" : "outside the on window"});
  return s;
}

Rover::BaseData Rover::baseData() const {
  const double t = now();
  BaseData b;
  std::vector<std::string> missing;
  auto ago = [t](double at) { return ageStr(t, at) + " ago"; };

  std::string marks;
  if (lastMarksAt_ >= 0) marks = "heard " + ago(lastMarksAt_) + (marks_.regattaName.empty() ? "" : " (" + marks_.regattaName + ")");
  else if (marksFromStorage_) marks = "stored copy only - not heard from the base yet";
  else marks = "none";
  if (lastMarksAt_ < 0) missing.push_back("marks");
  b.items.push_back({"course marks", marks});

  const double lastBurst = tracker_.lastStart();
  const double period = tracker_.period();
  std::string bursts = tracker_.isActive(t) ? "heard " + ago(lastBurst) + (period != BurstTracker::NONE ? ", every " + num(jsRound(period) / 1000) + " s" : "")
                       : lastBurst != BurstTracker::NONE ? "not heard for " + ageStr(t, lastBurst)
                                                         : "not heard";
  if (!tracker_.isActive(t)) missing.push_back("corrections");
  b.items.push_back({"corrections", bursts});

  std::string table;
  if (!follower_) table = cfg_.txGateEnabled && cfg_.slotEnabled ? "not used (TX_SLOT pinned)" : "not used (slot mode off)";
  else if (cfg_.slotIndex >= 0) table = "not used (TX_SLOT pinned)";
  else if (lastSlotTableAt_ < 0) {
    table = "not heard";
    missing.push_back("slot table");
  } else {
    table = "heard " + ago(lastSlotTableAt_) + ", version " + std::to_string(lastSlotTableVersion_) + " - " +
            (parked_ ? "parked, no slot needed" : assignedSlot() >= 0 ? "slot " + std::to_string(assignedSlot()) : "not listed yet (join slots)");
  }
  b.items.push_back({"slot table", table});

  std::string power;
  if (lastScheduleAt_ >= 0 || scheduleFromStorage_) {
    const protocol::PowerSchedule& s = policy_.schedule();
    power = (scheduleFromStorage_ ? std::string("stored copy") : "heard " + ago(lastScheduleAt_)) + " - Witty Pi: " +
            (s.hasWitty ? describeWitty(s) : "not set") + "; shutdown: " + (s.hasShutdown ? describeShutdown(s) : "not set");
  } else {
    power = "not heard (the base sends one only when it has one set)";
  }
  b.items.push_back({"power schedule", power});

  b.ready = missing.empty();
  for (size_t i = 0; i < missing.size(); i++) b.missing += (i ? ", " : "") + missing[i];
  return b;
}

// Says so when the boat has everything it needs from the base, and when it loses any of it
void Rover::maybeLogReady() {
  if (readyCheckedAt_ > now() - 2000) return;
  readyCheckedAt_ = now();
  const BaseData b = baseData();
  const int state = b.ready ? 1 : 0;
  if (state == readyLogged_) return;
  if (b.ready) log("[boatAgent] ready: course marks, corrections" + std::string(follower_ && cfg_.slotIndex < 0 ? " and the slot table" : "") + " heard from the base");
  else if (readyLogged_ == 1) log("[boatAgent] no longer ready - waiting for " + b.missing + " from the base");
  readyLogged_ = state;
}

std::string Rover::statusLine() const {
  std::string line = "[status]";
  int n = 0;
  for (const auto& kv : statusItems()) {
    if (n++ == 8) break;  // boatAgent.js's fields (it adds uploadAge)
    line += " " + kv.first + "=" + kv.second;
  }
  return line;
}

std::string Rover::txgateStats() const {
  if (!scheduler_) return "";
  const auto& c = scheduler_->counters;
  return "[txgate-stats] submitted=" + std::to_string(c.submitted) + " held=" + std::to_string(c.held) + " dropped=" + std::to_string(c.dropped) +
         " expired=" + std::to_string(c.expired) + " spilled=" + std::to_string(c.spilled) + " queued=" + std::to_string(scheduler_->queued());
}

// boatAgent.js's statusKey: the discrete part of the status - logged at once when it changes, else every 60 s
std::string Rover::statusKey() const {
  const Pvt* p = hasLastPvt_ ? &lastPvt_ : nullptr;
  return fixLabel(p) + (sleeper_.isSleeping() ? "|asleep" : "|ok") + (p ? "|1" : "|0") + (lastMarksAt_ >= 0 ? "|1" : "|0") + (lastTxAt_ >= 0 ? "|1" : "|0");
}

void Rover::maybeLogStatus() {
  const double t = now();
  if (t - statusCheckedAt_ < 2000) return;
  statusCheckedAt_ = t;
  const std::string key = statusKey();
  if (key != lastStatusKey_ || t - lastStatusAt_ >= 60000) {
    log(statusLine());
    lastStatusKey_ = key;
    lastStatusAt_ = t;
  }
  if (!hasLastPvt_ && t - waitingLoggedAt_ >= 10000) {
    waitingLoggedAt_ = t;
    log("[boatAgent] waiting for first GPS fix...");
  }
}

}  // namespace rover
