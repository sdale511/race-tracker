// The rover's own diagnosis for the status hello - a port of src/roverDiag.js's computeFlags/problemKey/hasProblem. The FLAGS bits are
// part of the wire format (the base's roverDiag.describe reads them). An ESP32 has no Pi power record, so `power` is always 0.
#pragma once

#include <cstdint>
#include <string>

namespace rover {
namespace diag {

constexpr uint8_t GPS_PORT_CLOSED = 0x01;
constexpr uint8_t GPS_NO_DATA = 0x02;
constexpr uint8_t GPS_NO_UBX = 0x04;
constexpr uint8_t GPS_NO_PVT = 0x08;
constexpr uint8_t NO_BURSTS = 0x10;
constexpr uint8_t RTCM_NOT_REACHING_GPS = 0x20;
constexpr uint8_t NO_BASE_RX = 0x40;

constexpr double GPS_STALE_MS = 5000;
constexpr double RXM_RTCM_STALE_MS = 15000;
constexpr double BURST_GRACE_MS = 20000;
constexpr double BASE_RX_STALE_MS = 150 * 1000;

constexpr double NEVER = -1;  // "null" for the timestamps below

// What computeFlags looks at (see roverDiag.js) - every time a ms timestamp on one clock, or NEVER
struct State {
  double since = 0;
  bool gpsReal = true;
  bool gpsAsleep = false;
  bool gpsPortOpen = false;
  double lastGpsBytesAt = NEVER;
  double lastUbxAt = NEVER;
  double lastPvtAt = NEVER;
  double lastRxmRtcmAt = NEVER;
  double lastBaseRxAt = NEVER;
  bool watchBursts = true;
  bool burstsHeard = false;
};

uint8_t computeFlags(const State& s, double now);

struct Report {
  uint8_t flags = 0;
  uint8_t power = 0;
  uint8_t numSV = 0;
  bool hasPvt = false;
  uint8_t fixType = 0;
};
std::string problemKey(const Report& d);
bool hasProblem(const Report& d);

}  // namespace diag
}  // namespace rover
