#include "course_watchers.h"

#include <algorithm>
#include <cmath>

#include "js_math.h"

namespace rover {

namespace {

// MARK_NAMES indexes - prefixed, because FoulWatcher has START/FINISH reasons of its own that would shadow them
constexpr int M_WINDWARD_GREEN = 0, M_LEEWARD_GREEN = 2, M_PIN = 4, M_COMMITTEE_START = 5, M_COMMITTEE_FINISH = 6, M_FINISH = 7;

// onGridWatcher.js
constexpr double ONGRID_EDGE_MARGIN_M = 1;
constexpr double HYPOTENUSE_ANGLE_DEG = 55;
constexpr double COMMITTEE_TRIANGLE_MAX_FRACTION = 0.5;
constexpr double SAFE_FINISH_SEPARATION_MULTIPLE = 2;
// foulWatcher.js
constexpr double FINISH_GRACE_MS = 120000;
// course.js
constexpr double PIN_BOUNDARY_REACH_MULTIPLIER = 50;
constexpr double PIN_BOUNDARY_MIN_REACH_M = 500;

int sign(double v) { return v > 0 ? 1 : (v < 0 ? -1 : 0); }  // Math.sign (never NaN here)

double cross(const XY& o, const XY& a, const XY& b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }
int sideOf(const XY& a, const XY& b, const XY& p) { return sign(cross(a, b, p)); }
bool segmentsIntersect(const XY& p1, const XY& p2, const XY& p3, const XY& p4) {
  const double d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2), d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
  return (d1 > 0) != (d2 > 0) && (d3 > 0) != (d4 > 0);
}
XY upwindRefOf(const XY& a, const XY& b) { return {a.x - (b.y - a.y), a.y + (b.x - a.x)}; }

double bearingDeg(const LatLon& a, const LatLon& b) {
  const double north = (b.lat - a.lat) * METERS_PER_DEG_LAT;
  const double east = (b.lon - a.lon) * METERS_PER_DEG_LAT * std::cos((a.lat * M_PI) / 180);
  return std::fmod((std::atan2(east, north) * 180) / M_PI + 360, 360);
}

}  // namespace

XY toXY(double originLat, double originLon, double lat, double lon) {
  return {(lon - originLon) * METERS_PER_DEG_LAT * std::cos((originLat * M_PI) / 180), (lat - originLat) * METERS_PER_DEG_LAT};
}

LatLon getPinBoundaryFarPoint(const LatLon& pin, const LatLon& committeeStart) {
  const double bearing = bearingDeg(committeeStart, pin);
  const double reachM = std::max(distanceMeters(pin, committeeStart) * PIN_BOUNDARY_REACH_MULTIPLIER, PIN_BOUNDARY_MIN_REACH_M);
  const double rad = (bearing * M_PI) / 180;
  const double north = reachM * std::cos(rad), east = reachM * std::sin(rad);
  return {pin.lat + north / METERS_PER_DEG_LAT, pin.lon + east / (METERS_PER_DEG_LAT * std::cos((pin.lat * M_PI) / 180))};
}

// ---- OnGridWatcher (onGridWatcher.js's computeGeometry + constructor) ----

OnGridWatcher::OnGridWatcher(const protocol::Marks& marks, double zoneMeters) : zoneMeters_(zoneMeters) {
  originLat_ = marks.mark[M_COMMITTEE_START].lat;
  originLon_ = marks.mark[M_COMMITTEE_START].lon;
  committeeStart_ = local(marks.mark[M_COMMITTEE_START].lat, marks.mark[M_COMMITTEE_START].lon);
  pin_ = local(marks.mark[M_PIN].lat, marks.mark[M_PIN].lon);

  const XY cf = local(marks.mark[M_COMMITTEE_FINISH].lat, marks.mark[M_COMMITTEE_FINISH].lon);
  excludeTriangle_ = std::hypot(cf.x, cf.y) < zoneMeters * SAFE_FINISH_SEPARATION_MULTIPLE;

  const double pinDx = pin_.x - committeeStart_.x, pinDy = pin_.y - committeeStart_.y;
  double pinLen = std::hypot(pinDx, pinDy);
  if (pinLen == 0) pinLen = 1;
  const double pinUx = pinDx / pinLen, pinUy = pinDy / pinLen;

  const XY windward = local(marks.mark[M_WINDWARD_GREEN].lat, marks.mark[M_WINDWARD_GREEN].lon);
  const XY leeward = local(marks.mark[M_LEEWARD_GREEN].lat, marks.mark[M_LEEWARD_GREEN].lon);
  const double windDx = windward.x - leeward.x, windDy = windward.y - leeward.y;
  double windLen = std::hypot(windDx, windDy);
  if (windLen == 0) windLen = 1;
  const double windUx = windDx / windLen, windUy = windDy / windLen;

  const XY candA{-pinUy, pinUx}, candB{pinUy, -pinUx};
  const XY crossLine = candA.x * windUx + candA.y * windUy >= candB.x * windUx + candB.y * windUy ? candA : candB;
  crossLineUx_ = crossLine.x;
  crossLineUy_ = crossLine.y;
  const double downX = -crossLineUx_, downY = -crossLineUy_;

  const double angleRad = (HYPOTENUSE_ANGLE_DEG * M_PI) / 180;
  const double c = std::cos(angleRad), s = std::sin(angleRad);
  const XY rotA{pinUx * c - pinUy * s, pinUx * s + pinUy * c};
  const XY rotB{pinUx * c + pinUy * s, -pinUx * s + pinUy * c};
  const XY hyp = rotA.x * downX + rotA.y * downY >= rotB.x * downX + rotB.y * downY ? rotA : rotB;
  hypUx_ = hyp.x;
  hypUy_ = hyp.y;
  excludedSideSign_ = sign(hyp.x * downY - hyp.y * downX);

  const double startUx = -pinUx, startUy = -pinUy;
  const XY rotC{startUx * c - startUy * s, startUx * s + startUy * c};
  const XY rotD{startUx * c + startUy * s, -startUx * s + startUy * c};
  const XY pinHyp = rotC.x * downX + rotC.y * downY >= rotD.x * downX + rotD.y * downY ? rotC : rotD;
  pinHypUx_ = pinHyp.x;
  pinHypUy_ = pinHyp.y;
  pinExcludedSideSign_ = sign(pinHyp.x * downY - pinHyp.y * downX);
}

OnGridWatcher::Result OnGridWatcher::check(double lat, double lon) {
  const XY p = local(lat, lon);
  const double windwardOfLine = (p.x - committeeStart_.x) * crossLineUx_ + (p.y - committeeStart_.y) * crossLineUy_;
  const bool inside = windwardOfLine <= ONGRID_EDGE_MARGIN_M && isInZone(p) && (!excludeTriangle_ || !inCommitteeTriangle(p)) && !inPinTriangle(p);
  pastLine = windwardOfLine > ONGRID_EDGE_MARGIN_M;
  const bool wasInside = onGrid;
  onGrid = inside;
  if (inside) return ONGRID;
  return wasInside ? OFFGRID : NONE;
}

bool OnGridWatcher::crossedStartLine(double prevLat, double prevLon, double lat, double lon) const {
  const XY a = local(prevLat, prevLon), b = local(lat, lon);
  auto side = [this](const XY& p) { return (p.x - committeeStart_.x) * crossLineUx_ + (p.y - committeeStart_.y) * crossLineUy_; };
  const double da = side(a), db = side(b);
  if (!(da <= 0 && db > 0)) return false;
  const double t = da / (da - db);
  const double px = a.x + t * (b.x - a.x), py = a.y + t * (b.y - a.y);
  const double lx = pin_.x - committeeStart_.x, ly = pin_.y - committeeStart_.y;
  double len2 = lx * lx + ly * ly;
  if (len2 == 0) len2 = 1;
  const double u = ((px - committeeStart_.x) * lx + (py - committeeStart_.y) * ly) / len2;
  return u >= -0.02 && u <= 1.02;
}

bool OnGridWatcher::isInZone(const XY& p) const {
  const XY& a = committeeStart_;
  const XY& b = pin_;
  const double abx = b.x - a.x, aby = b.y - a.y;
  const double lenSq = abx * abx + aby * aby;
  if (lenSq == 0) return false;
  const double marginT = ONGRID_EDGE_MARGIN_M / std::sqrt(lenSq);
  const double t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  if (t < -marginT || t > 1 + marginT) return false;
  const double ct = std::min(1.0, std::max(0.0, t));
  return std::hypot(p.x - (a.x + ct * abx), p.y - (a.y + ct * aby)) <= zoneMeters_;
}

bool OnGridWatcher::inCommitteeTriangle(const XY& p) const {
  const double dx = p.x - committeeStart_.x, dy = p.y - committeeStart_.y;
  const int s = sign(hypUx_ * dy - hypUy_ * dx);
  if (s != 0 && s != excludedSideSign_) return false;
  const double pinDx = pin_.x - committeeStart_.x, pinDy = pin_.y - committeeStart_.y;
  const double pinLenSq = pinDx * pinDx + pinDy * pinDy;
  if (pinLenSq == 0) return true;
  return (dx * pinDx + dy * pinDy) / pinLenSq <= COMMITTEE_TRIANGLE_MAX_FRACTION;
}

bool OnGridWatcher::inPinTriangle(const XY& p) const {
  const double dx = p.x - pin_.x, dy = p.y - pin_.y;
  const int s = sign(pinHypUx_ * dy - pinHypUy_ * dx);
  if (s != 0 && s != pinExcludedSideSign_) return false;
  const double csDx = committeeStart_.x - pin_.x, csDy = committeeStart_.y - pin_.y;
  const double csLenSq = csDx * csDx + csDy * csDy;
  if (csLenSq == 0) return true;
  return (dx * csDx + dy * csDy) / csLenSq <= COMMITTEE_TRIANGLE_MAX_FRACTION;
}

// ---- FinishLineWatcher ----

FinishLineWatcher::FinishLineWatcher(const protocol::Marks& marks) {
  originLat_ = marks.mark[M_COMMITTEE_FINISH].lat;
  originLon_ = marks.mark[M_COMMITTEE_FINISH].lon;
  committeeFinish_ = toXY(originLat_, originLon_, marks.mark[M_COMMITTEE_FINISH].lat, marks.mark[M_COMMITTEE_FINISH].lon);
  finish_ = toXY(originLat_, originLon_, marks.mark[M_FINISH].lat, marks.mark[M_FINISH].lon);
  upwindRef_ = upwindRefOf(committeeFinish_, finish_);
}

bool FinishLineWatcher::check(double lat, double lon, int64_t) {
  const XY cur = toXY(originLat_, originLon_, lat, lon);
  bool crossed = false;
  if (hasPrev_ && segmentsIntersect(prev_, cur, committeeFinish_, finish_) &&
      sideOf(committeeFinish_, finish_, cur) == sideOf(committeeFinish_, finish_, upwindRef_)) {
    lapCount++;
    crossed = true;
  }
  prev_ = cur;
  hasPrev_ = true;
  return crossed;
}

// ---- FoulWatcher ----

FoulWatcher::FoulWatcher(const protocol::Marks& marks) {
  originLat_ = marks.mark[M_COMMITTEE_START].lat;
  originLon_ = marks.mark[M_COMMITTEE_START].lon;
  auto local = [this](const LatLon& m) { return toXY(originLat_, originLon_, m.lat, m.lon); };
  const XY pin = local(marks.mark[M_PIN]), cs = local(marks.mark[M_COMMITTEE_START]), cf = local(marks.mark[M_COMMITTEE_FINISH]),
           finish = local(marks.mark[M_FINISH]);
  segments_.push_back({START, true, pin, cs, upwindRefOf(pin, cs)});
  segments_.push_back({GAP, false, cs, cf, upwindRefOf(cs, cf)});
  segments_.push_back({FINISH, true, cf, finish, upwindRefOf(cf, finish)});
  if (marks.pinBoundaryEnabled) {
    const XY far = local(getPinBoundaryFarPoint(marks.mark[M_PIN], marks.mark[M_COMMITTEE_START]));
    segments_.push_back({PIN_BOUNDARY, true, far, pin, upwindRefOf(far, pin)});
  }
}

bool FoulWatcher::check(double lat, double lon, int64_t timestamp) {
  const XY cur = toXY(originLat_, originLon_, lat, lon);
  bool fouled = false;
  if (hasPrev_) {
    for (const Segment& seg : segments_) {
      if (!segmentsIntersect(prev_, cur, seg.a, seg.b)) continue;
      const double d1 = cross(seg.a, seg.b, prev_), d2 = cross(seg.a, seg.b, cur);
      const double t = d1 / (d1 - d2);
      const double crossingTime = prevTimestamp_ + t * (double)(timestamp - prevTimestamp_);
      if (seg.requireDownwind && sideOf(seg.a, seg.b, cur) == sideOf(seg.a, seg.b, seg.upwindRef)) {
        if (seg.reason == FINISH) {
          hasFinish_ = true;
          lastFinishCrossingTime_ = crossingTime;
        }
        continue;
      }
      if (seg.reason == PIN_BOUNDARY && hasFinish_ && timestamp - lastFinishCrossingTime_ <= FINISH_GRACE_MS) continue;
      foulCount++;
      fouled = true;
      break;
    }
  }
  prev_ = cur;
  prevTimestamp_ = timestamp;
  hasPrev_ = true;
  return fouled;
}

// ---- FinishApproachWatcher ----

FinishApproachWatcher::FinishApproachWatcher(const protocol::Marks& marks) {
  originLat_ = marks.mark[M_COMMITTEE_FINISH].lat;
  originLon_ = marks.mark[M_COMMITTEE_FINISH].lon;
  committeeFinish_ = toXY(originLat_, originLon_, marks.mark[M_COMMITTEE_FINISH].lat, marks.mark[M_COMMITTEE_FINISH].lon);
  finish_ = toXY(originLat_, originLon_, marks.mark[M_FINISH].lat, marks.mark[M_FINISH].lon);
  gateLengthM_ = std::hypot(finish_.x - committeeFinish_.x, finish_.y - committeeFinish_.y);
  upwindSign_ = sign(cross(committeeFinish_, finish_, upwindRefOf(committeeFinish_, finish_)));
}

bool FinishApproachWatcher::isApproachingUpwind(double lat, double lon, double approachZoneM) {
  const XY pos = toXY(originLat_, originLon_, lat, lon);
  const double signedDistanceM = gateLengthM_ > 0 ? cross(committeeFinish_, finish_, pos) / gateLengthM_ : 0;
  const bool downwindSide = sign(signedDistanceM) != upwindSign_;
  const double absDistanceM = std::fabs(signedDistanceM);
  const bool closing = hasPrev_ && absDistanceM < prevAbsDistanceM_;
  prevAbsDistanceM_ = absDistanceM;
  hasPrev_ = true;
  return downwindSide && absDistanceM <= approachZoneM && closing;
}

// ---- EventBoost ----

EventBoost::EventBoost(const protocol::Marks& marks, double zoneM, size_t beforeFixes, double windowMs, size_t keep)
    : finish_(marks), foul_(marks), start_(marks, zoneM), beforeFixes_(beforeFixes), keep_(keep), windowMs_(windowMs) {}

EventBoost::Result EventBoost::onFix(const Pvt& fix) {
  Result r;
  r.finish = finish_.check(fix.lat, fix.lon, fix.timestamp);
  r.start = !recent_.empty() && start_.crossedStartLine(recent_.back().lat, recent_.back().lon, fix.lat, fix.lon);
  r.foul = foul_.check(fix.lat, fix.lon, fix.timestamp);
  if (r.finish || r.start || r.foul) {
    hasUrgent_ = true;
    urgentUntil_ = (double)fix.timestamp + windowMs_;
    const size_t n = std::min(beforeFixes_, recent_.size());
    r.before.assign(recent_.end() - n, recent_.end());
  }
  recent_.push_back(fix);
  if (recent_.size() > keep_) recent_.pop_front();
  r.urgent = isUrgent(fix.timestamp);
  return r;
}

}  // namespace rover
