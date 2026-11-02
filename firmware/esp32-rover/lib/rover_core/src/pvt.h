// One GNSS fix as the rover handles it - the fields of a decoded UBX-NAV-PVT that the rover logic and the radio protocol use.
// The C++ twin of the pvt object ubxParser.js's _decodePvt returns; field names match so the two read side by side.
#pragma once

#include <cstdint>

namespace rover {

struct Pvt {
  int64_t timestamp = 0;  // ms since the unix epoch, GPS-derived once utcValid (see ubx.cpp)
  double lat = 0;         // degrees
  double lon = 0;         // degrees
  int32_t gSpeedMmS = 0;  // ground speed
  double headMotDeg = 0;  // heading of motion
  bool gnssFixOk = false;
  bool diffSoln = false;
  uint8_t carrSoln = 0;  // 0 none, 1 float, 2 fixed
  uint8_t fixType = 0;   // 0 no fix, 2 2D, 3 3D
  uint8_t numSV = 0;
  uint32_t hAccMm = 0;
  bool utcValid = false;
};

struct LatLon {
  double lat = 0;
  double lon = 0;
};

}  // namespace rover
