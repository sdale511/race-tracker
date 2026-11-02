// lib/rover_core against what the Node code produces (test/vectors/node_vectors.h, written by tools/gen_vectors.js), plus a few
// end-to-end checks of the rover itself. Run with `pio test -e native`.
#include <unity.h>

#include <cmath>
#include <cstring>
#include <string>
#include <vector>

#include "../vectors/node_vectors.h"
#include "protocol.h"
#include "radio_scanner.h"
#include "rover.h"
#include "rover_diag.h"
#include "slot_table.h"
#include "thin_fixes.h"
#include "ubx.h"

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
  protocol::PowerScheduleStamp s;
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
  s.onPowerSchedule = [&](const protocol::PowerScheduleStamp&) { events.push_back(5); };
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

struct Harness {
  double t = 1000;
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
  RUN_TEST(test_diag_flags_match_node);
  RUN_TEST(test_rover_says_hello_then_sends_fixes_in_delta_frames);
  RUN_TEST(test_rover_sleeps_and_wakes_on_power_frames);
  RUN_TEST(test_rover_follows_the_slot_table_and_sends_in_its_slot);
  return UNITY_END();
}
