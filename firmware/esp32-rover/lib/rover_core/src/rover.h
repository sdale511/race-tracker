// The rover itself - the racing path of src/boatAgent.js, with the hardware behind a small interface (RoverHal) so the same code runs
// on the ESP32 (src/main.cpp) and in the host tests. Defaults in RoverConfig are config.js's.
//
// Ported: GPS fixes -> distance gate -> batching -> delta frames -> the shared-radio scheduler (burst gate, slots, the base's slot table,
// the join-slot back-off, thinning to the slot's budget, backfill after waiting for a slot), the status hello with the rover's diagnosis,
// ping replies, the course marks (kept across a restart), radio and GPS sleep, RTCM from the radio (counted for the burst timing, and
// optionally forwarded to the GPS), start-grid parking, the event boost at line crossings, the finish approach gate, and the power
// schedule as a deep sleep the HAL carries out.
// Not here: mark mode / set-mark / mark-log, the L1/L2 signal check, SD logging, log uploads, the local UDP broadcast and the admin page.
// See firmware/esp32-rover/README.md. The HAL is implemented by src/main.cpp (the ESP32), host/host_rover.cpp (a Mac) and the tests.
#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "burst_tracker.h"
#include "course_watchers.h"
#include "distance_gate.h"
#include "gps_sleep.h"
#include "power_policy.h"
#include "protocol.h"
#include "radio_scanner.h"
#include "rover_diag.h"
#include "rover_sleep.h"
#include "slot_table.h"
#include "tx_gate.h"
#include "tx_scheduler.h"
#include "ubx.h"

namespace rover {

struct RoverConfig {
  std::string boatId;
  double txDistanceM = 1;            // TX_DISTANCE_M
  double txIntervalMs = 60000;       // TX_INTERVAL_S
  int txBatchSize = 8;               // TX_BATCH_SIZE
  bool txDelta = true;               // TX_DELTA
  double helloStartupJitterMs = 3000;
  double pingResponseJitterMs = 3000;
  bool rtcmForward = false;          // RTCM_FORWARD: the XBee's DOUT also feeds the ZED's UART2 directly, so off by default
  // TX gate (TX_GATE_*)
  bool txGateEnabled = true;
  double blockBeforeMs = 40, blockAfterMs = 20, guardMs = 10;
  size_t maxQueue = 12;
  double maxAgeMs = 5000;
  // slots (TX_SLOT_*)
  bool slotEnabled = true;
  int slotIndex = -1;                // TX_SLOT; -1 = follow the base's table
  int slotCount = 0;                 // TX_SLOT_COUNT; 0 = work it out like the base (autoSlotCount)
  double slotWidthMs = 45;
  int joinSlots = 2;
  double rtcmIntervalS = 2;
  double maxHz = 4;
  int reserveFrames = 1;
  double markZoneM = 80;
  double joinReportS = 15;
  // start-grid parking (TX_PARKED_*, TX_SLOT_UNPARK_FIXES, TX_SLOT_PARK_DWELL_S, TX_SLOT_MOVING_KN) and the zone (REGATTAUP_ONGRID_ZONE_M)
  double parkedReportS = 15;
  double parkedFirstS = 2;
  double parkedRepeatS = 10;
  int unparkFixes = 3;
  double parkDwellS = 5;
  double movingKn = 1.5;
  double onGridZoneM = 10;
  // TX_FINISH_APPROACH_ZONE_M (0 = off) / TX_FINISH_DISTANCE_M
  double txFinishApproachZoneM = 0;
  double txFinishDistanceM = 0.3;
  // RTCM watchdog
  bool rtcmWatch = true;
  double rtcmWarnS = 20, rtcmRepeatS = 30;
  // sleep
  double sleepListenMs = 1500;
  int sleepCycleS = 10;
  bool gpsSleepForceUsb = false;
  // the status hello's build field (version.js's commit count); 0 = unknown
  uint16_t build = 0;
  bool dirty = false;
  // this boot came from the accelerometer (see power_policy.h)
  bool motionWoken = false;
  // for boatAgent.js's startup summary, filled in by the platform: "v0.1.290 (abc1234, 2026-11-02)", how the GPS and radio are
  // connected ("real /dev/cu.usbmodem1@115200", "simulated udp:41234"), whether the XBee's node identifier is set at boot
  std::string version = "unknown";
  std::string gpsDesc;
  std::string radioDesc;
  std::string radioPort;
  bool xbeeNi = false;
  bool gpsLog = false;  // GPS_LOG: a console line for every fix
};

struct RoverHal {
  std::function<bool(const uint8_t*, size_t)> radioWrite;  // false = not written (port closed, backed up)
  std::function<bool(const uint8_t*, size_t)> gpsWrite;
  std::function<void(bool sleeping)> setRadioSleeping;     // SLEEP_RQ high = asleep
  bool canSleep = false;                                   // a SLEEP_RQ pin is wired
  std::function<double()> monoMs;                          // monotonic (millis)
  std::function<int64_t()> wallMs;                         // best guess of unix ms, for a fix with no valid UTC yet
  std::function<double()> random;                          // [0, 1)
  std::function<void(const std::string&)> log;
  std::function<void(const protocol::Marks&)> saveMarks;   // persist the course across a restart
  std::function<bool(protocol::Marks&)> loadMarks;
  // the power schedule (see power_policy.h): local time, the RTC's clock across a deep sleep, the base's last schedule, and the sleep
  LocalClock clock;
  std::function<bool()> wallClockValid;                    // wallMs is real time (the GPS set the RTC)
  std::function<void(const protocol::PowerSchedule&)> saveSchedule;
  std::function<bool(protocol::PowerSchedule&)> loadSchedule;
  std::function<void(const PowerPolicy::Decision&)> requestDeepSleep;  // the GPS has been put in backup; the HAL does the rest
};

class Rover {
 public:
  Rover(RoverConfig config, RoverHal hal);

  void begin();                                 // the radio is up: starts the hello announcements
  void onRadioBytes(const uint8_t* data, size_t len);
  void onGpsBytes(const uint8_t* data, size_t len);
  void setGpsPortOpen(bool open);
  void tick();                                  // every loop pass

  // for status displays
  bool sleeping() const { return sleeper_.isSleeping(); }
  bool gpsAsleep() const { return gpsSleep_.isAsleep(); }
  bool burstsHeard() const { return tracker_.isActive(now()); }
  int assignedSlot() const { return follower_ ? follower_->assigned : -1; }
  bool parked() const { return parked_; }
  bool hasMarks() const { return hasMarks_; }
  const Pvt* lastPvt() const { return hasLastPvt_ ? &lastPvt_ : nullptr; }
  uint32_t framesSent() const { return framesSent_; }
  const TxScheduler* scheduler() const { return scheduler_.get(); }
  const RadioScanner& scanner() const { return scanner_; }

  // The settings and the live state as name/value pairs, for a status page; the console's startup summary and [status] line are
  // made from the same values
  using Items = std::vector<std::pair<std::string, std::string>>;
  Items configItems() const;
  Items statusItems() const;
  std::string statusLine() const;  // boatAgent.js's [status] line
  std::string txgateStats() const;  // boatAgent.js's [txgate-stats] line, for shutting down

  // exposed for the tests
  void handlePvtForTest(const Pvt& p) { onGpsFix(p); }

 private:
  double now() const { return hal_.monoMs(); }
  void log(const std::string& m) const { hal_.log(m); }
  bool rawSend(const std::vector<uint8_t>& buf);
  bool send(TxFrame frame);
  static bool hasValidFix(const Pvt& p) { return p.gnssFixOk && !(p.lat == 0 && p.lon == 0); }

  void onGpsFix(const Pvt& pvt);
  void handlePvt(const Pvt& pvt);
  void transmitFix(const Pvt& pvt);
  void queueFixForTx(const Pvt& pvt);
  void holdWhileWaiting(const std::vector<Pvt>& list);
  void flushPendingBatch(bool forSlot, bool final);
  void sendFixes(const std::vector<Pvt>& fixes);
  bool isNearRoundingMark(const Pvt& fix) const;
  Pacer* sendPacer();
  bool joinThrottleActive() const;
  bool isWaitingPacer(const Pacer* p) const { return p == joinBackoff_.get() || p == movingBackoff_.get(); }
  void rebuildWatchers();
  void updateParked(const Pvt& pvt);

  diag::Report currentDiag() const;
  void sendHello(bool force);
  void startHelloAnnounce();
  void checkRtcmWatchdog();

  void after(double delayMs, std::function<void()> fn);
  void checkPower();
  static std::string describeWitty(const protocol::PowerSchedule& s);
  static std::string describeShutdown(const protocol::PowerSchedule& s);
  std::string radioDropReason() const { return sleeper_.isSleeping() ? "asleep (radio sleep mode)" : "backed up (congested link?)"; }

 public:
  bool wallNow(int64_t& out) const;  // unix ms, false until the time is known
  const PowerPolicy& powerPolicy() const { return policy_; }

 private:

  RoverConfig cfg_;
  RoverHal hal_;
  BurstTracker tracker_;
  TxGate gate_;
  std::unique_ptr<TxScheduler> scheduler_;
  std::unique_ptr<SlotTableFollower> follower_;
  RoverSleep sleeper_;
  GpsSleep gpsSleep_;
  DistanceGate distanceGate_;
  PowerPolicy policy_;
  bool sleepRequested_ = false;
  double lastPowerCheckAt_ = -1e300;
  static constexpr double POWER_CHECK_MS = 5000;
  RadioScanner scanner_;
  ubx::Parser ubxParser_;
  std::unique_ptr<JoinBackoff> joinBackoff_;
  std::unique_ptr<JoinBackoff> movingBackoff_;
  bool parkingEnabled_ = false;
  bool practiceMode_ = false;
  bool parked_ = false;
  ZoneState zoneState_;
  std::unique_ptr<ParkedReporter> parkedReporter_;
  std::unique_ptr<OnGridWatcher> zoneWatcher_;
  std::unique_ptr<EventBoost> eventBoost_;
  std::unique_ptr<FinishApproachWatcher> finishApproach_;
  int maxFixesPerFrame_;

  protocol::Marks marks_;
  bool hasMarks_ = false;
  bool freshMarksReceived_ = false;

  Pvt lastPvt_;
  bool hasLastPvt_ = false;
  Pvt diagPvt_;
  bool hasDiagPvt_ = false;
  bool hasLastTx_ = false;
  int64_t lastTxTime_ = 0;
  bool announceNextFix_ = false;
  std::vector<Pvt> pendingBatch_;
  std::vector<Pvt> waitingFixes_;
  Pvt lastBatchFix_;
  bool hasLastBatchFix_ = false;
  uint32_t framesSent_ = 0;
  double lastInvalidFixWarnAt_ = -1e300;
  bool hasWallOffset_ = false;
  double wallOffsetMs_ = 0;  // unix ms minus monotonic ms, from the last fix with valid UTC

  diag::State diagState_;
  double helloNextAt_ = -1;
  bool helloStarted_ = false;
  double lastHelloAt_ = 0;
  std::string lastHelloKey_;
  bool hasLastHelloKey_ = false;

  // rtcmWatchdog.js
  double rtcmStartedAt_ = 0;
  bool rtcmMissing_ = false;
  double rtcmLastWarnAt_ = -1e300;
  double rtcmMissingSince_ = 0;
  double rtcmCheckedAt_ = -1e300;
  uint32_t lastPowerStamp_ = 0;
  bool hasPowerStamp_ = false;

  // the console's [status] line and the status page
  int slotCount_ = 0;
  double lastMarksAt_ = -1;  // monotonic ms, -1 = not this run
  double lastTxAt_ = -1;
  double lastPvtAt_ = -1;
  std::string lastStatusKey_;
  double lastStatusAt_ = -1e300;
  double statusCheckedAt_ = -1e300;
  double waitingLoggedAt_ = 0;
  std::string statusKey() const;
  void maybeLogStatus();
  void logStartup();

  struct Timer {
    double at;
    std::function<void()> fn;
  };
  std::vector<Timer> timers_;

  static constexpr double HELLO_RETRY_MS = 30000;
  static constexpr double HELLO_PROBLEM_MS = 60000;
  static constexpr double INVALID_FIX_WARN_INTERVAL_MS = 30000;
  static constexpr size_t SLOT_PENDING_CAP = 200;
  static constexpr int64_t BACKFILL_MAX_AGE_MS = 15000;
  static constexpr double MOVING_UNTHROTTLED_KN = 3;
};

}  // namespace rover
