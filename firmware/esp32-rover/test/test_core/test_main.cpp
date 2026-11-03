// lib/rover_core against what the Node code produces (test/vectors/node_vectors.h, written by tools/gen_vectors.js), plus a few
// end-to-end checks of the rover itself. Run with `pio test -e native`.
#include <unity.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "../vectors/node_vectors.h"
#include "course_watchers.h"
#include "power_policy.h"
#include "protocol.h"
#include "radio_scanner.h"
#include "rover.h"
#include "rover_diag.h"
#include "settings.h"
#include "slot_table.h"
#include "thin_fixes.h"
#include "ubx.h"
#include "xbee_at.h"

using namespace rover;

void setUp() {}
void tearDown() {}

static Pvt toPvt(const vec::PvtV& v) {
  Pvt p;
  p.timestamp = v.ts;
  p.lat = v.lat;
  p.lon = v.lon;
  p.gSpeedMmS = v.speed;
  p.headMotDeg = v.head;
  p.gnssFixOk = v.fixOk;
  p.carrSoln = v.carr;
  p.numSV = v.numSV;
  return p;
}

static std::vector<Pvt> track(int from, int to) {
  std::vector<Pvt> out;
  for (int i = from; i < to; i++) out.push_back(toPvt(vec::TRACK[i]));
  return out;
}

static void assertBytes(const std::vector<uint8_t>& want, const std::vector<uint8_t>& got) {
  TEST_ASSERT_EQUAL_UINT32(want.size(), got.size());
  TEST_ASSERT_EQUAL_UINT8_ARRAY(want.data(), got.data(), want.size());
}

static void assertClose(double want, double got) { TEST_ASSERT_TRUE_MESSAGE(std::fabs(want - got) <= 1e-9 * (1 + std::fabs(want)), "value differs from Node"); }

// ---- frames the rover sends ----

void test_position_frames_match_node() {
  for (size_t i = 0; i < sizeof vec::PVTS / sizeof vec::PVTS[0]; i++) assertBytes(vec::ENCODE[i], protocol::encode(vec::BOAT, toPvt(vec::PVTS[i])));
}

void test_status_hello_matches_node() {
  for (size_t i = 0; i < sizeof vec::HELLOS / sizeof vec::HELLOS[0]; i++) {
    const auto& h = vec::HELLOS[i];
    protocol::StatusHello s;
    s.boatId = vec::BOAT;
    s.flags = h.flags;
    s.power = h.power;
    s.numSV = h.numSV;
    s.hasPvt = h.hasPvt;
    s.fixType = h.fixType;
    s.carrSoln = h.carrSoln;
    s.build = h.build;
    s.dirty = h.dirty;
    assertBytes(vec::HELLO_FRAMES[i], protocol::encodeStatusHello(s));
  }
}

void test_batch_frames_match_node() {
  assertBytes(vec::BATCH_FRAMES[0], protocol::encodeBatch(vec::BOAT, track(0, 4)));
  assertBytes(vec::BATCH_FRAMES[1], protocol::encodeBatch(vec::BOAT, track(10, 11)));
}

void test_delta_frames_match_node() {
  for (size_t c = 0; c < sizeof vec::DELTA_CASES / sizeof vec::DELTA_CASES[0]; c++) {
    const auto frames = protocol::encodeDeltaFrames(vec::BOAT, track(vec::DELTA_CASES[c].from, vec::DELTA_CASES[c].to));
    TEST_ASSERT_EQUAL_UINT32(vec::DELTA_FRAMES[c].size(), frames.size());
    for (size_t f = 0; f < frames.size(); f++) {
      assertBytes(vec::DELTA_FRAMES[c][f], frames[f].buf);
      TEST_ASSERT_EQUAL_INT(vec::DELTA_COUNTS[c][f], (int)frames[f].count);
    }
  }
}

// ---- frames the rover reads ----

void test_marks_decode_like_node() {
  protocol::Marks m;
  TEST_ASSERT_TRUE(protocol::decodeMarks(vec::MARKS_FRAME.data(), vec::MARKS_FRAME.size(), m));
  for (size_t i = 0; i < protocol::MARK_COUNT; i++) {
    assertClose(vec::MARKS_LATLON[i * 2], m.mark[i].lat);
    assertClose(vec::MARKS_LATLON[i * 2 + 1], m.mark[i].lon);
  }
  TEST_ASSERT_TRUE(m.pinBoundaryEnabled);
  TEST_ASSERT_EQUAL_STRING(vec::MARKS_REGATTA, m.regattaName.c_str());
  TEST_ASSERT_EQUAL_UINT16(vec::MARKS_PORTS[0], m.basePort);
  TEST_ASSERT_EQUAL_UINT16(vec::MARKS_PORTS[1], m.baseAdminPort);
  auto bad = vec::MARKS_FRAME;
  bad[20] ^= 1;
  TEST_ASSERT_FALSE(protocol::decodeMarks(bad.data(), bad.size(), m));
}

void test_power_and_slot_tables_decode_like_node() {
  for (size_t i = 0; i < vec::POWER_FRAMES.size(); i++) {
    protocol::Power p;
    TEST_ASSERT_TRUE(protocol::decodePower(vec::POWER_FRAMES[i].data(), vec::POWER_FRAMES[i].size(), p));
    TEST_ASSERT_EQUAL(vec::POWERS[i].sleep, p.sleep);
    TEST_ASSERT_EQUAL_UINT8(vec::POWERS[i].sleepS, p.sleepS);
    TEST_ASSERT_EQUAL(vec::POWERS[i].all, p.all);
    TEST_ASSERT_EQUAL_INT(vec::POWERS[i].ids, (int)p.boatIds.size());
  }
  for (size_t i = 0; i < vec::SLOT_TABLE_FRAMES.size(); i++) {
    protocol::SlotTable t;
    TEST_ASSERT_TRUE(protocol::decodeSlotTable(vec::SLOT_TABLE_FRAMES[i].data(), vec::SLOT_TABLE_FRAMES[i].size(), t));
    TEST_ASSERT_EQUAL_UINT8(vec::TABLES[i].version, t.version);
    TEST_ASSERT_EQUAL(vec::TABLES[i].practice, t.practice);
    TEST_ASSERT_EQUAL_UINT8(vec::TABLES[i].slotCount, t.slotCount);
    TEST_ASSERT_EQUAL_UINT8(vec::TABLES[i].slotWidthMs, t.slotWidthMs);
    TEST_ASSERT_EQUAL_UINT8(vec::TABLES[i].joinSlots, t.joinSlots);
    TEST_ASSERT_EQUAL_INT(vec::TABLES[i].entries, (int)t.entries.size());
  }
  protocol::PowerSchedule s;
  TEST_ASSERT_TRUE(protocol::decodePowerSchedule(vec::POWER_SCHEDULE_FRAME.data(), vec::POWER_SCHEDULE_FRAME.size(), s));
  TEST_ASSERT_EQUAL_UINT32(vec::POWER_SCHEDULE_STAMP, s.stamp);
}

void test_rtcm_decode_and_crc_like_node() {
  for (size_t i = 0; i < vec::RTCM_FRAMES.size(); i++) {
    protocol::Rtcm r;
    TEST_ASSERT_TRUE(protocol::decodeRtcm(vec::RTCM_FRAMES[i].data(), vec::RTCM_FRAMES[i].size(), r));
    TEST_ASSERT_EQUAL_UINT16(vec::RTCM_TYPES[i], r.type);
  }
  TEST_ASSERT_EQUAL_UINT32(vec::CRC24Q_OF_MARKS, protocol::crc24q(vec::MARKS_FRAME.data(), vec::MARKS_FRAME.size()));
}

void test_radio_stream_scans_like_radiolink() {
  RadioScanner s;
  std::vector<int> events;
  s.onMarks = [&](const protocol::Marks&) { events.push_back(1); };
  s.onPing = [&]() { events.push_back(2); };
  s.onPower = [&](const protocol::Power&) { events.push_back(3); };
  s.onSlotTable = [&](const protocol::SlotTable&) { events.push_back(4); };
  s.onPowerSchedule = [&](const protocol::PowerSchedule&) { events.push_back(5); };
  s.onRtcm = [&](const protocol::Rtcm&, const uint8_t*) { events.push_back(6); };
  size_t at = 0;
  for (int n : vec::RADIO_CHUNKS) {
    s.write(vec::RADIO_STREAM.data() + at, n);
    at += n;
  }
  TEST_ASSERT_EQUAL_UINT32(vec::RADIO_EVENTS.size(), events.size());
  TEST_ASSERT_EQUAL_INT_ARRAY(vec::RADIO_EVENTS.data(), events.data(), events.size());
  TEST_ASSERT_EQUAL_UINT32(vec::RADIO_FRAMES, s.frames);
  TEST_ASSERT_EQUAL_UINT32(vec::RADIO_SYNC_ERRORS, s.syncErrors);
}

// ---- the GPS ----

void test_ubx_nav_pvt_decodes_like_node() {
  ubx::Parser p;
  std::vector<Pvt> got;
  p.wallMs = []() { return (int64_t)0; };
  p.onPvt = [&](const Pvt& f) { got.push_back(f); };
  for (uint8_t b : vec::UBX_STREAM) p.write(&b, 1);  // a byte at a time: frames split everywhere
  const size_t n = sizeof vec::UBX_PVTS / sizeof vec::UBX_PVTS[0];
  TEST_ASSERT_EQUAL_UINT32(n, got.size());
  for (size_t i = 0; i < n; i++) {
    const auto& w = vec::UBX_PVTS[i];
    TEST_ASSERT_EQUAL_INT64(w.ts, got[i].timestamp);
    assertClose(w.lat, got[i].lat);
    assertClose(w.lon, got[i].lon);
    TEST_ASSERT_EQUAL_INT32(w.speed, got[i].gSpeedMmS);
    assertClose(w.head, got[i].headMotDeg);
    TEST_ASSERT_EQUAL(w.fixOk, got[i].gnssFixOk);
    TEST_ASSERT_EQUAL(w.diff, got[i].diffSoln);
    TEST_ASSERT_EQUAL_UINT8(w.carr, got[i].carrSoln);
    TEST_ASSERT_EQUAL_UINT8(w.numSV, got[i].numSV);
    TEST_ASSERT_EQUAL_UINT8(w.fixType, got[i].fixType);
    TEST_ASSERT_EQUAL_UINT32(w.hAcc, got[i].hAccMm);
  }
}

void test_ubx_commands_match_node() {
  assertBytes(vec::PMREQ, ubx::encodePmreq(0, false));
  assertBytes(vec::PMREQ_FORCE, ubx::encodePmreq(0, true));
  assertBytes(vec::POLL_NAV_SIG, ubx::encodePollRequest(0x01, 0x43));
}

// ---- radio timing ----

void test_burst_tracker_and_gate_match_node() {
  BurstTracker t;
  for (const auto& m : vec::BURSTS) t.onRtcm(m.type, m.t, m.size);
  assertClose(vec::BURST_PERIOD, t.period());
  TEST_ASSERT_EQUAL_UINT32(vec::BURST_ANCHOR_CORRECTIONS, t.anchorCorrections);
  TxGate g(t);
  for (const auto& p : vec::GATE_PROBES) {
    TEST_ASSERT_EQUAL(p.active, t.isActive(p.t));
    assertClose(p.startAtOrBefore, t.startAtOrBefore(p.t));
    assertClose(p.wait26, g.waitMs(26, p.t));
    assertClose(p.wait83, g.waitMs(83, p.t));
  }
}

void test_slot_count_matches_node() {
  BurstTracker t;
  TxGate g(t);
  TEST_ASSERT_EQUAL_INT(vec::AUTO_SLOT_COUNT_2S, autoSlotCount(2, 2, 45, g));
  TEST_ASSERT_EQUAL_INT(vec::AUTO_SLOT_COUNT_1S, autoSlotCount(2, 1, 35, g));
}

void test_join_backoff_matches_node() {
  size_t i = 0;
  const size_t n = sizeof vec::JOIN_RANDS / sizeof vec::JOIN_RANDS[0];
  JoinBackoff jb(15000, {0, 1000, 2000, 4000, 8000}, []() { return 0.0; }, [&]() { return vec::JOIN_RANDS[i++ % n]; });
  for (double want : vec::JOIN_NEXT_AT) {
    jb.sent();
    assertClose(want, jb.nextDueAt());
  }
}

// ---- thinning and geometry ----

static std::vector<int> indexesOf(const std::vector<Pvt>& list, const std::vector<Pvt>& kept) {
  std::vector<int> out;
  for (const Pvt& k : kept)
    for (size_t i = 0; i < list.size(); i++)
      if (list[i].timestamp == k.timestamp) {
        out.push_back((int)i);
        break;
      }
  return out;
}

void test_thinning_keeps_what_node_keeps() {
  for (const auto& c : vec::THIN_CASES) {
    const auto list = track(c.from, c.to);
    Pvt anchor = c.anchor >= 0 ? toPvt(vec::TRACK[c.anchor]) : Pvt();
    ProtectFn protect = nullptr;
    if (c.protect) protect = [](const Pvt& f) { return f.lat > vec::THIN_PROTECT_LAT; };
    const auto kept = indexesOf(list, thinForTurns(list, c.cap, c.anchor >= 0 ? &anchor : nullptr, 480, protect));
    TEST_ASSERT_EQUAL_UINT32(c.kept.size(), kept.size());
    TEST_ASSERT_EQUAL_INT_ARRAY(c.kept.data(), kept.data(), kept.size());
  }
  const auto held = track(0, 12);
  const auto kept = indexesOf(held, thinBackfill(held));
  TEST_ASSERT_EQUAL_UINT32(vec::BACKFILL_KEPT.size(), kept.size());
  TEST_ASSERT_EQUAL_INT_ARRAY(vec::BACKFILL_KEPT.data(), kept.data(), kept.size());
}

void test_distances_match_node() {
  const double m[] = {vec::MARKS_LATLON[8], vec::MARKS_LATLON[9], vec::MARKS_LATLON[0], vec::MARKS_LATLON[1]};
  assertClose(vec::DISTANCES[0], distanceMeters({m[0], m[1]}, {m[2], m[3]}));
  assertClose(vec::DISTANCES[1], distanceMeters({vec::MARKS_LATLON[6], vec::MARKS_LATLON[7]}, {-33.8, 151.2}));
  assertClose(vec::DISTANCES[2], distanceMeters({0, 179.9}, {0.1, -179.9}));
  assertClose(vec::SEG_DIST, distanceToSegmentM({vec::MARKS_LATLON[0], vec::MARKS_LATLON[1]}, {vec::MARKS_LATLON[12], vec::MARKS_LATLON[13]},
                                                {vec::MARKS_LATLON[14], vec::MARKS_LATLON[15]}));
}

void test_course_watchers_match_node() {
  protocol::Marks m;
  TEST_ASSERT_TRUE(protocol::decodeMarks(vec::MARKS_FRAME.data(), vec::MARKS_FRAME.size(), m));
  const size_t n = sizeof vec::WATCH_PATH / sizeof vec::WATCH_PATH[0];
  for (int pass = 0; pass < 2; pass++) {
    m.pinBoundaryEnabled = pass == 0;
    OnGridWatcher grid(m, 10);
    FinishLineWatcher fin(m);
    FoulWatcher foul(m);
    FinishApproachWatcher approach(m);
    EventBoost boost(m, 10);
    for (size_t i = 0; i < n; i++) {
      const Pvt p = toPvt(vec::WATCH_PATH[i]);
      const vec::WatchV& w = vec::WATCH[pass * n + i];
      char at[48];
      std::snprintf(at, sizeof at, "pass %d fix %u", pass, (unsigned)i);
      TEST_ASSERT_EQUAL_INT_MESSAGE(w.grid, (int)grid.check(p.lat, p.lon), at);
      TEST_ASSERT_EQUAL_MESSAGE(w.pastLine, grid.pastLine, at);
      const bool crossed = i > 0 && grid.crossedStartLine(vec::WATCH_PATH[i - 1].lat, vec::WATCH_PATH[i - 1].lon, p.lat, p.lon);
      TEST_ASSERT_EQUAL_MESSAGE(w.crossedStart, crossed, at);
      TEST_ASSERT_EQUAL_MESSAGE(w.finish, fin.check(p.lat, p.lon, p.timestamp), at);
      TEST_ASSERT_EQUAL_MESSAGE(w.foul, foul.check(p.lat, p.lon, p.timestamp), at);
      TEST_ASSERT_EQUAL_MESSAGE(w.approaching, approach.isApproachingUpwind(p.lat, p.lon, 30), at);
      const EventBoost::Result b = boost.onFix(p);
      TEST_ASSERT_EQUAL_MESSAGE(w.urgent, b.urgent, at);
      TEST_ASSERT_EQUAL_INT_MESSAGE(w.before, (int)b.before.size(), at);
    }
  }
}

void test_diag_flags_match_node() {
  for (const auto& c : vec::DIAG_CASES) {
    diag::State s;
    s.since = c.since;
    s.gpsReal = c.gpsReal;
    s.gpsAsleep = c.gpsAsleep;
    s.gpsPortOpen = c.gpsPortOpen;
    s.lastGpsBytesAt = c.bytes;
    s.lastUbxAt = c.ubx;
    s.lastPvtAt = c.pvt;
    s.lastRxmRtcmAt = c.rxm;
    s.lastBaseRxAt = c.base;
    s.watchBursts = c.watch;
    s.burstsHeard = c.heard;
    TEST_ASSERT_EQUAL_HEX8(c.flags, diag::computeFlags(s, c.now));
  }
}

// ---- the rover end to end ----

static LocalClock utcClock();

struct Harness {
  double t = 1000;
  bool slept = false;
  PowerPolicy::Decision sleepDecision;
  std::vector<std::vector<uint8_t>> sent;
  std::vector<std::vector<uint8_t>> toGps;
  bool radioAsleep = false;
  std::unique_ptr<Rover> rover;

  explicit Harness(RoverConfig cfg = RoverConfig()) {
    if (cfg.boatId.empty()) cfg.boatId = vec::BOAT;
    cfg.txDistanceM = 0;  // the test track moves about 0.3 m a fix: let every fix through the distance gate
    RoverHal hal;
    hal.radioWrite = [this](const uint8_t* d, size_t n) {
      sent.emplace_back(d, d + n);
      return true;
    };
    hal.gpsWrite = [this](const uint8_t* d, size_t n) {
      toGps.emplace_back(d, d + n);
      return true;
    };
    hal.canSleep = true;
    hal.setRadioSleeping = [this](bool s) { radioAsleep = s; };
    hal.monoMs = [this]() { return t; };
    hal.wallMs = [this]() { return (int64_t)t; };
    hal.random = []() { return 0.5; };
    hal.log = [](const std::string&) {};
    hal.clock = utcClock();
    hal.requestDeepSleep = [this](const PowerPolicy::Decision& d) {
      slept = true;
      sleepDecision = d;
    };
    rover.reset(new Rover(cfg, hal));
    rover->setGpsPortOpen(true);
    rover->begin();
  }
  void run(double ms) {
    for (double end = t + ms; t < end; t += 1) rover->tick();
  }
  size_t count(uint8_t sync) const {
    size_t n = 0;
    for (const auto& f : sent) n += f[0] == sync;
    return n;
  }
};

void test_rover_says_hello_then_sends_fixes_in_delta_frames() {
  Harness h;
  h.run(2000);  // the hello's startup jitter (0.5 x 3000 ms)
  TEST_ASSERT_EQUAL_UINT32(1, h.count(protocol::STATUS_HELLO_SYNC));
  // with no correction bursts heard, fixes are batched to TX_BATCH_SIZE (8) and go out as one delta frame
  for (int i = 0; i < 8; i++) {
    h.rover->handlePvtForTest(toPvt(vec::TRACK[i]));
    h.run(100);
  }
  TEST_ASSERT_EQUAL_UINT32(1, h.count(protocol::DELTA_SYNC));
  assertBytes(vec::DELTA_FRAMES[0][0], h.sent.back());
}

void test_rover_sleeps_and_wakes_on_power_frames() {
  Harness h;
  h.run(2000);
  const auto& sleepAll = vec::POWER_FRAMES[0];  // sleep, everyone, 30 s
  h.rover->onRadioBytes(sleepAll.data(), sleepAll.size());
  TEST_ASSERT_TRUE(h.rover->sleeping());
  TEST_ASSERT_TRUE(h.radioAsleep);
  TEST_ASSERT_TRUE(h.rover->gpsAsleep());
  assertBytes(vec::PMREQ, h.toGps.back());  // the GPS went into backup
  const size_t before = h.sent.size();
  for (int i = 0; i < 8; i++) h.rover->handlePvtForTest(toPvt(vec::TRACK[i]));
  TEST_ASSERT_EQUAL_UINT32(before, h.sent.size());  // nothing goes out asleep
  h.run(30500);  // a listen window opens after 30 s, for 1.5 s
  TEST_ASSERT_FALSE(h.radioAsleep);
  const auto& wakeMe = vec::POWER_FRAMES[1];  // wake, names this boat
  h.rover->onRadioBytes(wakeMe.data(), wakeMe.size());
  TEST_ASSERT_FALSE(h.rover->sleeping());
  TEST_ASSERT_EQUAL_UINT8(0xff, h.toGps.back()[0]);  // the wake byte
  h.run(2000);
  TEST_ASSERT_TRUE(h.count(protocol::STATUS_HELLO_SYNC) >= 2);  // it announces itself again
}

void test_rover_follows_the_slot_table_and_sends_in_its_slot() {
  Harness h;
  // two seconds of bursts so the slots mean something: 1077 at the start of each
  auto rtcm = vec::RTCM_FRAMES[0];
  for (int b = 0; b < 4; b++) {
    h.rover->onRadioBytes(rtcm.data(), rtcm.size());
    h.run(2000);
  }
  TEST_ASSERT_TRUE(h.rover->burstsHeard());
  const auto& table = vec::SLOT_TABLE_FRAMES[0];  // this boat -> slot 20 of 41, 45 ms
  h.rover->onRadioBytes(table.data(), table.size());
  TEST_ASSERT_EQUAL_INT(20, h.rover->assignedSlot());
  // a cycle of fixes, then the slot: everything goes out once it opens, about 30 + 20 x 45 ms after the burst
  h.sent.clear();
  h.rover->onRadioBytes(rtcm.data(), rtcm.size());
  const double burstAt = h.t;
  for (int i = 0; i < 12; i++) {
    h.rover->handlePvtForTest(toPvt(vec::TRACK[i]));
    h.run(10);
  }
  TEST_ASSERT_EQUAL_UINT32(0, h.count(protocol::DELTA_SYNC));  // held for the slot
  double sentAt = -1;
  while (h.t < burstAt + 1900 && h.count(protocol::DELTA_SYNC) == 0) {
    h.run(1);
    if (h.count(protocol::DELTA_SYNC)) sentAt = h.t;
  }
  TEST_ASSERT_TRUE_MESSAGE(sentAt > 0, "the held fixes never went out");
  const double slotOpens = burstAt + 30 + 20 * 45;
  TEST_ASSERT_TRUE_MESSAGE(sentAt >= slotOpens && sentAt <= slotOpens + 45, "sent outside its slot");
}

void test_rover_parks_on_the_start_grid_and_reports_sparsely() {
  Harness h;
  h.rover->onRadioBytes(vec::MARKS_FRAME.data(), vec::MARKS_FRAME.size());
  auto rtcm = vec::RTCM_FRAMES[0];
  for (int b = 0; b < 4; b++) {
    h.rover->onRadioBytes(rtcm.data(), rtcm.size());
    h.run(2000);
  }
  // stopped, 3 m behind the middle of the start line
  Pvt p;
  p.lat = 40.780523;
  p.lon = -119.20425;
  p.gnssFixOk = true;
  p.numSV = 30;
  p.carrSoln = 2;
  p.timestamp = 1793639000000;
  h.rover->handlePvtForTest(p);
  TEST_ASSERT_TRUE(h.rover->parked());
  // a minute on the grid at 10 Hz: the first report within 2 s, its repeat, then about one every 15 s - not 600
  h.sent.clear();
  for (int i = 0; i < 600; i++) {
    if (i % 20 == 0) h.rover->onRadioBytes(rtcm.data(), rtcm.size());
    p.timestamp += 100;
    h.rover->handlePvtForTest(p);
    h.run(100);
  }
  const size_t reports = h.count(protocol::SYNC) + h.count(protocol::DELTA_SYNC);
  TEST_ASSERT_TRUE_MESSAGE(reports >= 3 && reports <= 8, "a parked boat should report only now and then");
  // under way and off the grid: three fixes outside and it unparks
  for (int i = 0; i < 3; i++) {
    p.lat += 0.001;
    p.gSpeedMmS = 3000;
    p.timestamp += 100;
    h.rover->handlePvtForTest(p);
  }
  TEST_ASSERT_FALSE(h.rover->parked());
}

// ---- the power schedule ----

// Local time = UTC, like the vectors (gen_vectors.js pins TZ=UTC)
static LocalClock utcClock() {
  LocalClock c;
  c.toLocal = [](int64_t ms) {
    int64_t days = ms / 86400000 - (ms % 86400000 < 0);
    const int minutes = (int)((ms - days * 86400000) / 60000);
    // civil_from_days
    days += 719468;
    const int64_t era = (days >= 0 ? days : days - 146096) / 146097;
    const unsigned doe = (unsigned)(days - era * 146097);
    const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const unsigned mp = (5 * doy + 2) / 153;
    const unsigned d = doy - (153 * mp + 2) / 5 + 1;
    const unsigned m = mp < 10 ? mp + 3 : mp - 9;
    return LocalDate{(int)(yoe + era * 400 + (m <= 2)), (int)m, (int)d, minutes};
  };
  c.fromLocal = [](int y, int m, int d, int minutes) {
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = (unsigned)(y - era * 400);
    const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + 1 - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    const int64_t days = era * 146097 + (int64_t)doe - 719468 + (d - 1);  // an out-of-range day rolls over, like Date
    return days * 86400000 + (int64_t)minutes * 60000;
  };
  return c;
}

void test_power_schedule_decodes_like_node() {
  for (size_t i = 0; i < vec::FULL_SCHEDULE_FRAMES.size(); i++) {
    protocol::PowerSchedule s;
    const auto& f = vec::FULL_SCHEDULE_FRAMES[i];
    const auto& w = vec::SCHEDULES[i];
    TEST_ASSERT_TRUE(protocol::decodePowerSchedule(f.data(), f.size(), s));
    TEST_ASSERT_EQUAL_UINT32(w.stamp, s.stamp);
    TEST_ASSERT_EQUAL(w.hasWitty, s.hasWitty);
    TEST_ASSERT_EQUAL(w.hasShutdown, s.hasShutdown);
    if (w.hasWitty) {
      TEST_ASSERT_EQUAL_INT(w.mode, s.wittyMode);
      TEST_ASSERT_EQUAL(w.halt, s.haltItself);
      TEST_ASSERT_EQUAL_INT(w.start, s.startMin);
      TEST_ASSERT_EQUAL_INT(w.end, s.endMin);
      assertClose(w.lat, s.lat);
      assertClose(w.lon, s.lon);
      TEST_ASSERT_EQUAL_INT(w.before, s.beforeMin);
      TEST_ASSERT_EQUAL_INT(w.after, s.afterMin);
      TEST_ASSERT_EQUAL_INT(w.days, s.days);
    }
    if (w.hasShutdown) {
      TEST_ASSERT_EQUAL(w.enabled, s.shutdownEnabled);
      TEST_ASSERT_EQUAL(w.whenIdle, s.whenIdle);
      TEST_ASSERT_EQUAL_INT(w.time, s.shutdownMin);
      TEST_ASSERT_EQUAL_INT(w.idle, s.idleMinutes);
      assertClose(w.speed, s.speedKn);
    }
  }
}

void test_shutdown_gate_matches_node() {
  const LocalClock clock = utcClock();
  for (const auto& c : vec::GATES) {
    Pvt fix;
    fix.timestamp = (int64_t)c.fixTs;
    fix.gSpeedMmS = c.fixSpeed;
    const GateResult r = evaluateGate(c.at, c.kn, c.idle, c.req, c.hasIdle, (int64_t)c.idleSince, c.hasFix ? &fix : nullptr, (int64_t)c.now, clock);
    TEST_ASSERT_EQUAL(c.resIdle, r.idle);
    if (c.resIdle) TEST_ASSERT_EQUAL_INT64((int64_t)c.resIdleSince, r.idleSince);
    TEST_ASSERT_EQUAL(c.shut, r.shouldShutDown);
  }
}

void test_sun_times_match_node() {
  for (const auto& c : vec::SUNS) {
    const SunTimes t = sunTimes(c.y, c.m, c.d, c.lat, c.lon);
    TEST_ASSERT_EQUAL(c.ok, t.ok);
    if (!c.ok) continue;
    TEST_ASSERT_EQUAL_INT64((int64_t)c.sunrise, t.sunrise);
    TEST_ASSERT_EQUAL_INT64((int64_t)c.sunset, t.sunset);
  }
}

void test_power_policy_sleeps_outside_the_window_and_wakes_at_its_start() {
  PowerPolicy p(utcClock());
  protocol::PowerSchedule s;
  s.hasWitty = true;
  s.wittyMode = 1;   // daily
  s.startMin = 540;  // 09:00
  s.endMin = 1020;   // 17:00
  p.setSchedule(s);
  const int64_t day = 1793577600000LL;  // 2026-11-02 00:00 UTC
  Pvt moving;
  moving.gSpeedMmS = 3000;
  moving.timestamp = day + 12 * 3600000;
  TEST_ASSERT_FALSE(p.evaluate(day + 12 * 3600000, &moving, false, false).sleep);  // noon: in the window
  moving.timestamp = day + 17 * 3600000 + 60000;
  auto d = p.evaluate(day + 17 * 3600000 + 60000, &moving, false, false);  // 17:01, even under way: the hard stop
  TEST_ASSERT_TRUE(d.sleep);
  TEST_ASSERT_TRUE(d.hasWakeAt);
  TEST_ASSERT_EQUAL_INT64(day + 86400000 + 9 * 3600000, d.wakeAt);  // tomorrow 09:00
  // woken by motion at 20:00 and being sailed: stays up; stopped for 10 minutes: back to sleep
  moving.timestamp = day + 20 * 3600000;
  TEST_ASSERT_FALSE(p.evaluate(day + 20 * 3600000, &moving, false, true).sleep);
  Pvt stopped;
  stopped.timestamp = day + 20 * 3600000 + 60000;
  TEST_ASSERT_FALSE(p.evaluate(stopped.timestamp, &stopped, false, true).sleep);
  stopped.timestamp += 10 * 60000;
  TEST_ASSERT_TRUE(p.evaluate(stopped.timestamp, &stopped, false, true).sleep);
  // in radio sleep mode nothing counts
  TEST_ASSERT_FALSE(p.evaluate(day + 23 * 3600000, nullptr, true, false).sleep);
}

void test_power_policy_follows_the_shutdown_rule() {
  PowerPolicy p(utcClock());
  protocol::PowerSchedule s;
  s.hasShutdown = true;
  s.shutdownEnabled = true;
  s.whenIdle = true;
  s.shutdownMin = 21 * 60;
  s.idleMinutes = 10;
  s.speedKn = 0.5;
  p.setSchedule(s);
  const int64_t t = 1793577600000LL + 22 * 3600000;
  Pvt stopped;
  stopped.timestamp = t;
  TEST_ASSERT_FALSE(p.evaluate(t, &stopped, false, false).sleep);
  stopped.timestamp = t + 600000;
  auto d = p.evaluate(t + 600000, &stopped, false, false);
  TEST_ASSERT_TRUE(d.sleep);
  TEST_ASSERT_FALSE(d.hasWakeAt);  // no on window: only motion wakes it
}

void test_rover_sleeps_when_the_base_schedule_says_so() {
  Harness h;
  // daily 09:00-17:30 with a hard stop, shutdown after 21:00 (see gen_vectors.js)
  h.rover->onRadioBytes(vec::POWER_SCHEDULE_FRAME.data(), vec::POWER_SCHEDULE_FRAME.size());
  Pvt p;
  p.utcValid = true;
  p.gnssFixOk = true;
  p.lat = 40.7864;
  p.lon = -119.2066;
  p.timestamp = 1793577600000LL + 12 * 3600000;  // noon UTC: inside the window
  h.rover->handlePvtForTest(p);
  h.run(6000);
  TEST_ASSERT_FALSE(h.slept);
  p.timestamp = 1793577600000LL + 18 * 3600000;  // 18:00: outside it
  h.rover->handlePvtForTest(p);
  h.run(6000);
  TEST_ASSERT_TRUE(h.slept);
  TEST_ASSERT_TRUE(h.sleepDecision.hasWakeAt);
  TEST_ASSERT_EQUAL_INT64(1793577600000LL + 86400000 + 9 * 3600000, h.sleepDecision.wakeAt);
  assertBytes(vec::PMREQ, h.toGps.back());  // the GPS went into backup first
}

// A pretend XBee: replies to +++ and AT commands the way the module does (xbeeAt.js's tests use the same exchange)
struct FakeXbee {
  std::string ni;
  std::string pending;
  std::vector<std::string> written;
  bool saved = false;
  xbee::Io io() {
    xbee::Io x;
    x.write = [this](const std::string& s) {
      written.push_back(s);
      if (s == "+++") pending += "\x01\x02 frame bytes\rOK\r";  // air traffic, a stray \r, then the OK
      else if (s == "ATNI\r") pending += ni + "\r";
      else if (s.rfind("ATNI", 0) == 0) {
        ni = s.substr(4, s.size() - 5);
        pending += "OK\r";
      } else if (s == "ATWR\r") {
        saved = true;
        pending += "OK\r";
      } else if (s == "ATCN\r") pending += "OK\r";
    };
    x.read = [this](std::string& buf, unsigned) {
      if (pending.empty()) return false;
      buf += pending;
      pending.clear();
      return true;
    };
    x.sleep = [](unsigned) {};
    return x;
  }
};

void test_xbee_node_identifier_is_set_once() {
  FakeXbee radio;
  radio.ni = "old name";
  auto r = xbee::setNodeIdentifier(radio.io(), "QXZRA");
  TEST_ASSERT_TRUE(r.ok);
  TEST_ASSERT_TRUE(r.changed);
  TEST_ASSERT_EQUAL_STRING("old name", r.previous.c_str());
  TEST_ASSERT_EQUAL_STRING("QXZRA", radio.ni.c_str());
  TEST_ASSERT_TRUE(radio.saved);
  TEST_ASSERT_EQUAL_STRING("ATCN\r", radio.written.back().c_str());
  // already right: nothing written to the radio's flash
  radio.saved = false;
  r = xbee::setNodeIdentifier(radio.io(), "QXZRA");
  TEST_ASSERT_TRUE(r.ok);
  TEST_ASSERT_FALSE(r.changed);
  TEST_ASSERT_FALSE(radio.saved);
  // no XBee there at all
  xbee::Io silent;
  silent.write = [](const std::string&) {};
  silent.read = [](std::string&, unsigned) { return false; };
  silent.sleep = [](unsigned) {};
  TEST_ASSERT_FALSE(xbee::setNodeIdentifier(silent, "QXZRA").ok);
}

// ---- settings ----

// every setting, for every value in the vectors, holds what config.js holds; and the list is settings.cpp's, in order
void test_settings_parse_like_config_js() {
  const auto& all = rover::settings::all();
  const size_t n = sizeof vec::SETTING_NAMES / sizeof vec::SETTING_NAMES[0];
  TEST_ASSERT_EQUAL(n, all.size());
  for (size_t i = 0; i < n; i++) TEST_ASSERT_EQUAL_STRING(vec::SETTING_NAMES[i], all[i].name);
  for (const auto& sc : vec::SETTING_CASES) {
    rover::RoverConfig cfg;
    rover::settings::apply(cfg, [&](const char*) { return sc.value; });
    for (size_t i = 0; i < n; i++) {
      char msg[96];
      snprintf(msg, sizeof msg, "%s=\"%s\"", vec::SETTING_NAMES[i], sc.value ? sc.value : "(unset)");
      TEST_ASSERT_EQUAL_STRING_MESSAGE(sc.held[i], rover::settings::current(cfg, vec::SETTING_NAMES[i]).c_str(), msg);
    }
  }
}

// the console is stricter than config.js: a typo is refused, not quietly read as a default or a prefix
void test_settings_console_check() {
  std::string err;
  TEST_ASSERT_TRUE(rover::settings::check("TX_DISTANCE_M", "2.5", err));
  TEST_ASSERT_TRUE(rover::settings::check("TX_INTERVAL_S", "1e3", err));
  TEST_ASSERT_FALSE(rover::settings::check("TX_DISTANCE_M", "12x", err));
  TEST_ASSERT_FALSE(rover::settings::check("TX_DISTANCE_M", "abc", err));
  TEST_ASSERT_FALSE(rover::settings::check("TX_DISTANCE_M", "0x10", err));
  TEST_ASSERT_FALSE(rover::settings::check("TX_DISTANCE_M", "", err));
  TEST_ASSERT_TRUE(rover::settings::check("TX_DELTA", "false", err));
  TEST_ASSERT_FALSE(rover::settings::check("TX_DELTA", "yes", err));
  TEST_ASSERT_FALSE(rover::settings::check("TX_DISTANCE", "1", err));
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_position_frames_match_node);
  RUN_TEST(test_status_hello_matches_node);
  RUN_TEST(test_batch_frames_match_node);
  RUN_TEST(test_delta_frames_match_node);
  RUN_TEST(test_marks_decode_like_node);
  RUN_TEST(test_power_and_slot_tables_decode_like_node);
  RUN_TEST(test_rtcm_decode_and_crc_like_node);
  RUN_TEST(test_radio_stream_scans_like_radiolink);
  RUN_TEST(test_ubx_nav_pvt_decodes_like_node);
  RUN_TEST(test_ubx_commands_match_node);
  RUN_TEST(test_burst_tracker_and_gate_match_node);
  RUN_TEST(test_slot_count_matches_node);
  RUN_TEST(test_join_backoff_matches_node);
  RUN_TEST(test_thinning_keeps_what_node_keeps);
  RUN_TEST(test_distances_match_node);
  RUN_TEST(test_course_watchers_match_node);
  RUN_TEST(test_diag_flags_match_node);
  RUN_TEST(test_rover_says_hello_then_sends_fixes_in_delta_frames);
  RUN_TEST(test_rover_sleeps_and_wakes_on_power_frames);
  RUN_TEST(test_rover_follows_the_slot_table_and_sends_in_its_slot);
  RUN_TEST(test_rover_parks_on_the_start_grid_and_reports_sparsely);
  RUN_TEST(test_xbee_node_identifier_is_set_once);
  RUN_TEST(test_power_schedule_decodes_like_node);
  RUN_TEST(test_shutdown_gate_matches_node);
  RUN_TEST(test_sun_times_match_node);
  RUN_TEST(test_power_policy_sleeps_outside_the_window_and_wakes_at_its_start);
  RUN_TEST(test_power_policy_follows_the_shutdown_rule);
  RUN_TEST(test_rover_sleeps_when_the_base_schedule_says_so);
  RUN_TEST(test_settings_parse_like_config_js);
  RUN_TEST(test_settings_console_check);
  return UNITY_END();
}
