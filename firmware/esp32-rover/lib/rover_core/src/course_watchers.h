// The course-geometry detectors a rover runs on its own fixes - ports of src/onGridWatcher.js (the start-grid zone and the start-line
// crossing), src/finishLineWatcher.js, src/foulWatcher.js, src/finishApproach.js's FinishApproachWatcher and src/eventBoost.js. They use
// the same flat-earth local frame as the Node code (course.js's toXY), so a fix lands on the same side of every line in both.
#pragma once

#include <cstdint>
#include <deque>
#include <memory>
#include <vector>

#include "protocol.h"
#include "pvt.h"

namespace rover {

struct XY {
  double x, y;
};

XY toXY(double originLat, double originLon, double lat, double lon);
LatLon getPinBoundaryFarPoint(const LatLon& pin, const LatLon& committeeStart);  // course.js

class OnGridWatcher {
 public:
  // marks in MARK_NAMES order; zoneMeters: how far behind the start line still counts as on the grid
  OnGridWatcher(const protocol::Marks& marks, double zoneMeters);

  enum Result { NONE, ONGRID, OFFGRID };
  Result check(double lat, double lon);
  bool crossedStartLine(double prevLat, double prevLon, double lat, double lon) const;

  bool onGrid = false;
  bool pastLine = false;

 private:
  XY local(double lat, double lon) const { return toXY(originLat_, originLon_, lat, lon); }
  bool isInZone(const XY& p) const;
  bool inCommitteeTriangle(const XY& p) const;
  bool inPinTriangle(const XY& p) const;

  double originLat_, originLon_, zoneMeters_;
  XY committeeStart_, pin_;
  double crossLineUx_, crossLineUy_, hypUx_, hypUy_, pinHypUx_, pinHypUy_;
  int excludedSideSign_, pinExcludedSideSign_;
  bool excludeTriangle_;
};

class FinishLineWatcher {
 public:
  explicit FinishLineWatcher(const protocol::Marks& marks);
  bool check(double lat, double lon, int64_t timestamp);  // true on an upwind crossing of the finish gate
  uint32_t lapCount = 0;

 private:
  double originLat_, originLon_;
  XY committeeFinish_, finish_, upwindRef_;
  bool hasPrev_ = false;
  XY prev_{0, 0};
};

class FoulWatcher {
 public:
  explicit FoulWatcher(const protocol::Marks& marks);
  bool check(double lat, double lon, int64_t timestamp);  // true when the path crosses the line complex the wrong way
  uint32_t foulCount = 0;

 private:
  enum Reason { START, GAP, FINISH, PIN_BOUNDARY };
  struct Segment {
    Reason reason;
    bool requireDownwind;
    XY a, b, upwindRef;
  };
  double originLat_, originLon_;
  std::vector<Segment> segments_;
  bool hasPrev_ = false;
  XY prev_{0, 0};
  int64_t prevTimestamp_ = 0;
  bool hasFinish_ = false;
  double lastFinishCrossingTime_ = 0;
};

// finishApproach.js: closing on the finish line from downwind, within approachZoneM
class FinishApproachWatcher {
 public:
  explicit FinishApproachWatcher(const protocol::Marks& marks);
  bool isApproachingUpwind(double lat, double lon, double approachZoneM);

 private:
  double originLat_, originLon_;
  XY committeeFinish_, finish_;
  double gateLengthM_;
  int upwindSign_;
  bool hasPrev_ = false;
  double prevAbsDistanceM_ = 0;
};

// eventBoost.js: the boat runs the base's line detectors on its own full-rate fixes so the pair straddling a start, finish or foul
// crossing is always sent, whatever its gates would have dropped
class EventBoost {
 public:
  EventBoost(const protocol::Marks& marks, double zoneM, size_t beforeFixes = 2, double windowMs = 600, size_t keep = 8);

  struct Result {
    bool urgent = false;
    std::vector<Pvt> before;
    bool finish = false, start = false, foul = false;
  };
  Result onFix(const Pvt& fix);
  bool isUrgent(int64_t timestamp) const { return hasUrgent_ && timestamp <= urgentUntil_; }

 private:
  FinishLineWatcher finish_;
  FoulWatcher foul_;
  OnGridWatcher start_;
  size_t beforeFixes_, keep_;
  double windowMs_;
  std::deque<Pvt> recent_;
  bool hasUrgent_ = false;
  double urgentUntil_ = 0;
};

}  // namespace rover
