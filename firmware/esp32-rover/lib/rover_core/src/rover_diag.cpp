#include "rover_diag.h"

namespace rover {
namespace diag {

uint8_t computeFlags(const State& s, double now) {
  auto stale = [&](double t, double ms) { return now - (t != NEVER ? t : s.since) > ms; };
  uint8_t flags = 0;
  if (s.gpsReal && !s.gpsAsleep) {
    if (!s.gpsPortOpen) flags |= GPS_PORT_CLOSED;
    else if (stale(s.lastGpsBytesAt, GPS_STALE_MS)) flags |= GPS_NO_DATA;
    else if (stale(s.lastUbxAt, GPS_STALE_MS)) flags |= GPS_NO_UBX;
    else if (stale(s.lastPvtAt, GPS_STALE_MS)) flags |= GPS_NO_PVT;
  }
  const bool pastGrace = now - s.since > BURST_GRACE_MS;
  if (s.watchBursts && pastGrace && !s.burstsHeard) flags |= NO_BURSTS;
  if (s.gpsReal && !s.gpsAsleep && s.burstsHeard && !(flags & 0x0f) && stale(s.lastRxmRtcmAt, RXM_RTCM_STALE_MS)) flags |= RTCM_NOT_REACHING_GPS;
  if (stale(s.lastBaseRxAt, BASE_RX_STALE_MS)) flags |= NO_BASE_RX;
  return flags;
}

std::string problemKey(const Report& d) {
  // roverDiag.js: `${flags}/${power & (UNDERVOLT_NOW | THROTTLED_NOW)}/${no satellites ? 'nosv' : ''}`
  return std::to_string(d.flags) + "/" + std::to_string(d.power & 0x05) + "/" + (d.hasPvt && d.numSV == 0 ? "nosv" : "");
}

bool hasProblem(const Report& d) { return d.flags != 0 || d.power != 0 || (d.hasPvt && d.numSV == 0); }

}  // namespace diag
}  // namespace rover
