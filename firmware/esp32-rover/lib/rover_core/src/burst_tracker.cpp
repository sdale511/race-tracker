#include "burst_tracker.h"

#include <algorithm>
#include <cmath>

namespace rover {

double median(std::vector<double> xs) {
  if (xs.empty()) return BurstTracker::NONE;
  std::sort(xs.begin(), xs.end());
  const size_t mid = xs.size() >> 1;
  return xs.size() % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

void BurstTracker::onRtcm(uint16_t type, double t, size_t size) {
  const bool startsBurst = t - lastMsgAt_ > gapMs_ || !hasCur_;
  if (startsBurst && size > 0 && size < MIN_BURST_MSG_BYTES) return;  // a lone small message (a 1005) - see burstTracker.js
  if (startsBurst) {
    closeBurst();
    double start = t;
    const int usual = usualFirstType();
    if (usual >= 0 && type != usual) {
      auto it = offsets_.find(type);
      const double off = it == offsets_.end() ? NONE : median(std::vector<double>(it->second.begin(), it->second.end()));
      if (off != NONE && off > 0) {
        start = t - off;
        anchorCorrections++;
      }
    }
    cur_ = Burst{start, type, {}};
    hasCur_ = true;
    starts_.push_back(start);
    if (starts_.size() > KEEP_STARTS) starts_.pop_front();
    bursts++;
  }
  cur_.msgs.push_back({type, t});
  lastMsgAt_ = t;
}

void BurstTracker::closeBurst() {
  if (!hasCur_ || cur_.msgs.empty()) return;
  firstTypes_.push_back(cur_.firstType);
  if (firstTypes_.size() > KEEP_OFFSETS) firstTypes_.pop_front();
  if ((int)cur_.firstType != usualFirstType()) return;
  for (const Msg& m : cur_.msgs) {
    auto& arr = offsets_[m.type];
    arr.push_back(m.t - cur_.msgs[0].t);
    if (arr.size() > KEEP_OFFSETS) arr.pop_front();
  }
}

int BurstTracker::usualFirstType() const {
  if (firstTypes_.size() < 3) return firstTypes_.empty() ? -1 : firstTypes_.back();
  // the most frequent; ties go to the one seen first (Map insertion order + a stable sort in the JS)
  std::vector<std::pair<uint16_t, int>> counts;
  for (uint16_t t : firstTypes_) {
    auto it = std::find_if(counts.begin(), counts.end(), [t](const std::pair<uint16_t, int>& c) { return c.first == t; });
    if (it == counts.end()) counts.push_back({t, 1});
    else it->second++;
  }
  auto best = counts.begin();
  for (auto it = counts.begin(); it != counts.end(); ++it)
    if (it->second > best->second) best = it;
  return best->first;
}

double BurstTracker::period() const {
  std::vector<double> iv;
  for (size_t i = 1; i < starts_.size(); i++) {
    const double d = starts_[i] - starts_[i - 1];
    if (d >= MIN_PERIOD_MS && d <= MAX_PERIOD_MS) iv.push_back(d);
  }
  return median(iv);
}

bool BurstTracker::isActive(double t) const {
  const double p = period();
  if (p == NONE || starts_.empty()) return false;
  return t - lastStart() <= std::max(3 * p + 500, 3000.0);
}

double BurstTracker::nextStart(double after) const {
  const double p = period();
  if (p == NONE || starts_.empty()) return NONE;
  const double k = std::max(0.0, std::ceil((after - lastStart()) / p));
  return lastStart() + k * p;
}

double BurstTracker::startAtOrBefore(double t) const {
  const double p = period();
  if (p == NONE || starts_.empty()) return NONE;
  const double k = std::floor((t - lastStart()) / p);
  return lastStart() + k * p;
}

}  // namespace rover
