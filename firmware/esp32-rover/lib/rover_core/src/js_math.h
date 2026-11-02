// Arithmetic that has to come out exactly as it does in the Node code, so a frame built here is byte-for-byte the frame
// protocol.js builds from the same fix (test/test_vectors checks this against vectors written by tools/gen_vectors.js).
#pragma once

#include <cmath>

#include "pvt.h"

namespace rover {

// JavaScript's Math.round: halves go up (towards +infinity), so Math.round(-2.5) is -2. std::round goes away from zero
// (-3), which would change the last unit of a negative latitude or a speed change.
inline double jsRound(double x) { return std::floor(x + 0.5); }

constexpr double METERS_PER_DEG_LAT = 111320;  // course.js
constexpr double KNOTS_PER_MM_S = 1.94384 / 1000;

inline double speedKnots(const Pvt& p) { return (p.gSpeedMmS / 1000.0) * 1.94384; }

// course.js's distanceMeters: flat-earth, fine at course-length scales.
inline double distanceMeters(const LatLon& a, const LatLon& b) {
  const double north = (b.lat - a.lat) * METERS_PER_DEG_LAT;
  const double east = (b.lon - a.lon) * METERS_PER_DEG_LAT * std::cos((a.lat * M_PI) / 180);
  return std::sqrt(north * north + east * east);
}

inline LatLon latLonOf(const Pvt& p) { return {p.lat, p.lon}; }

// course.js's distanceToSegmentM: distance from p to the segment a-b.
inline double distanceToSegmentM(const LatLon& p, const LatLon& a, const LatLon& b) {
  const double kx = METERS_PER_DEG_LAT * std::cos((a.lat * M_PI) / 180);
  const double bx = (b.lon - a.lon) * kx;
  const double by = (b.lat - a.lat) * METERS_PER_DEG_LAT;
  const double px = (p.lon - a.lon) * kx;
  const double py = (p.lat - a.lat) * METERS_PER_DEG_LAT;
  const double len2 = bx * bx + by * by;
  double u = len2 == 0 ? 0 : (px * bx + py * by) / len2;
  u = u < 0 ? 0 : (u > 1 ? 1 : u);
  return std::hypot(px - u * bx, py - u * by);
}

// finishApproach.js's headingUpwind: whether a moving boat's heading has an upwind component across the finish line
// (upwind = 90 degrees counter-clockwise from committeeFinish -> finish).
inline bool headingUpwind(const Pvt& fix, const LatLon& committeeFinish, const LatLon& finish, double minKn = 1) {
  if (!(speedKnots(fix) >= minKn)) return false;
  const double vy = (finish.lat - committeeFinish.lat) * METERS_PER_DEG_LAT;
  const double vx = (finish.lon - committeeFinish.lon) * METERS_PER_DEG_LAT * std::cos((committeeFinish.lat * M_PI) / 180);
  const double h = (fix.headMotDeg * M_PI) / 180;
  return std::sin(h) * -vy + std::cos(h) * vx > 0;
}

}  // namespace rover
