#include "settings.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "protocol.h"

namespace rover {
namespace settings {

namespace {

bool isSpace(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; }

// config.js's `process.env.X || 'default'`: unset and empty both mean the default
const char* orDefault(const char* v, const char* d) { return v && *v ? v : d; }
// `parseFloat(...) || fallback`: NaN and 0 both fall back
double orNum(double v, double fallback) { return std::isnan(v) || v == 0 ? fallback : v; }
bool notOff(const char* v) { return !v || (std::strcmp(v, "0") != 0 && std::strcmp(v, "false") != 0); }
bool isOn(const char* v) { return v && (std::strcmp(v, "1") == 0 || std::strcmp(v, "true") == 0); }
double pf(const char* v, const char* d) { return jsParseFloat(orDefault(v, d)); }
double pi(const char* v, const char* d) { return jsParseInt(orDefault(v, d)); }

// a number as JavaScript prints it (1, 0.3, NaN)
std::string num(double v) {
  if (std::isnan(v)) return "NaN";
  char b[32];
  if (v == std::floor(v) && std::fabs(v) < 1e15) {
    std::snprintf(b, sizeof b, "%lld", (long long)v);
    return b;
  }
  for (int prec = 1; prec <= 17; prec++) {
    std::snprintf(b, sizeof b, "%.*g", prec, v);
    if (std::strtod(b, nullptr) == v) break;
  }
  return b;
}
std::string onOff(bool b) { return b ? "1" : "0"; }

// How config.js reads each one. F: parseFloat(v || def); I: parseInt(v || def, 10); then, with a fallback, `|| fallback` (NaN or 0)
// and clamped to [lo, hi]. ON: on unless "0"/"false"; OFF: off unless "1"/"true". Kept as data, not a function per setting: that
// is ~90 KB of flash on the ESP32.
enum Kind : uint8_t { F, I, ON, OFF };
constexpr double NONE = NAN;
struct Rule {
  Setting info;
  Kind kind;
  const char* def;
  double fallback;  // NONE = no `|| fallback`
  double lo, hi;    // NONE = no clamp
};
// in this order: TX_BATCH_SIZE's cap depends on TX_DELTA, read before it
const Rule RULES[] = {
    {{"TX_DISTANCE_M", "send a fix once the boat has moved this far (m)", false}, F, "1", NONE, NONE, NONE},
    {{"TX_INTERVAL_S", "heartbeat: send at least this often while stopped (s)", false}, F, "60", NONE, NONE, NONE},
    {{"TX_DELTA", "send batches as delta frames", true}, ON, nullptr, NONE, NONE, NONE},
    {{"TX_BATCH_SIZE", "fixes per batch outside slot mode", false}, I, "8", 8, 1, NONE},  // hi: MAX_DELTA_COUNT or MAX_BATCH_COUNT
    {{"TX_FINISH_APPROACH_ZONE_M", "tighter distance gate this far below the finish line, upwind (m; 0 = off)", false}, F, "0", NONE, NONE, NONE},
    {{"TX_FINISH_DISTANCE_M", "the distance gate inside the finish approach zone (m)", false}, F, "0.3", NONE, NONE, NONE},
    {{"PING_RESPONSE_JITTER_MS", "random delay before answering a ping (ms)", false}, I, "3000", NONE, NONE, NONE},
    {{"HELLO_STARTUP_JITTER_MS", "random delay before the first hello (ms)", false}, I, "3000", NONE, NONE, NONE},
    {{"TX_GATE", "keep telemetry clear of the base's correction bursts", true}, ON, nullptr, NONE, NONE, NONE},
    {{"TX_GATE_BEFORE_MS", "no sending this long before a burst (ms)", false}, I, "40", NONE, NONE, NONE},
    {{"TX_GATE_AFTER_MS", "no sending this long after a burst starts (ms)", false}, I, "20", NONE, NONE, NONE},
    {{"TX_GATE_GUARD_MS", "margin at the end of a slot (ms)", false}, I, "10", NONE, NONE, NONE},
    {{"TX_GATE_MAX_QUEUE", "frames held waiting for the radio", false}, I, "12", NONE, NONE, NONE},
    {{"TX_GATE_MAX_AGE_MS", "a held frame older than this is dropped (ms)", false}, I, "5000", NONE, NONE, NONE},
    {{"RTCM_WATCHDOG", "warn when the correction bursts are not heard", true}, ON, nullptr, NONE, NONE, NONE},
    {{"RTCM_WATCHDOG_WARN_S", "warn after this long without bursts (s)", false}, F, "20", 20, 1, NONE},
    {{"RTCM_WATCHDOG_REPEAT_S", "repeat the warning this often (s)", false}, F, "30", 30, 5, NONE},
    {{"RTCM_FORWARD", "write the RTCM heard on the radio to the GPS", true}, OFF, nullptr, NONE, NONE, NONE},
    {{"TX_SLOT_MODE", "send in a slot of its own", true}, ON, nullptr, NONE, NONE, NONE},
    {{"TX_SLOT", "a fixed slot, ignoring the base's table (unset = follow the base)", false}, I, nullptr, NONE, NONE, NONE},
    {{"TX_SLOT_COUNT", "slots in the cycle (unset = worked out as the base does)", false}, I, "25", 25, 1, NONE},
    {{"TX_SLOT_MS", "slot width (ms)", false}, I, "45", 45, 5, NONE},
    {{"TX_SLOT_JOIN", "shared join slots at the end of the cycle", false}, I, "2", 0, 0, NONE},
    {{"RTCM_INTERVAL_S", "the base's correction burst period, for the slot count (s)", false}, F, "2", 2, 0.1, NONE},
    {{"TX_SLOT_MAX_HZ", "fixes per second sent from a slot (0 = no cap)", false}, F, "4", 0, 0, NONE},
    {{"TX_SLOT_RESERVE_FRAMES", "frames of the slot kept free for a backlog", false}, I, "1", 0, 0, NONE},
    {{"TX_SLOT_MARK_ZONE_M", "full rate this close to a mark or the finish line (m)", false}, F, "80", 0, 0, NONE},
    {{"TX_JOIN_REPORT_S", "report this often while waiting for a slot (s)", false}, F, "15", 0, 0, NONE},
    {{"TX_PARKED_REPORT_S", "report this often parked on the start grid (s)", false}, F, "15", 0, 0, NONE},
    {{"TX_PARKED_FIRST_S", "first report this soon after parking (s)", false}, F, "2", 0, 0, NONE},
    {{"TX_PARKED_REPEAT_S", "a parked boat that moves reports again after (s)", false}, F, "10", 0, 0, NONE},
    {{"TX_SLOT_UNPARK_FIXES", "fixes outside the zone before leaving the grid", false}, I, "3", 3, 1, NONE},
    {{"TX_SLOT_PARK_DWELL_S", "a moving boat parks after this long in the zone (s)", false}, F, "5", 0, 0, NONE},
    {{"TX_SLOT_MOVING_KN", "slower than this counts as stopped (kn)", false}, F, "1.5", 0, 0, NONE},
    {{"REGATTAUP_ONGRID_ZONE_M", "the on-grid zone behind the start line (m)", false}, F, "10", NONE, NONE, NONE},
    {{"SLEEP_CYCLE_S", "radio sleep: listen for a wake frame every (s)", false}, I, "10", 10, 1, 255},
    {{"SLEEP_LISTEN_MS", "radio sleep: listen this long (ms)", false}, I, "1500", NONE, NONE, NONE},
    {{"GPS_SLEEP_FORCE_USB", "put the GPS in backup even with its USB connected", true}, OFF, nullptr, NONE, NONE, NONE},
    {{"GPS_LOG", "a console line for every fix", true}, OFF, nullptr, NONE, NONE, NONE},
};
constexpr size_t RULE_COUNT = sizeof RULES / sizeof RULES[0];

// the RoverConfig field behind RULES[i]; an int field can't hold config.js's NaN and reads 0 (a double field keeps it)
int toInt(double v) { return std::isnan(v) ? 0 : (int)v; }
void store(RoverConfig& c, size_t i, double v) {
  switch (i) {
    case 0: c.txDistanceM = v; break;
    case 1: c.txIntervalMs = v * 1000; break;
    case 2: c.txDelta = v != 0; break;
    case 3: c.txBatchSize = toInt(v); break;
    case 4: c.txFinishApproachZoneM = v; break;
    case 5: c.txFinishDistanceM = v; break;
    case 6: c.pingResponseJitterMs = v; break;
    case 7: c.helloStartupJitterMs = v; break;
    case 8: c.txGateEnabled = v != 0; break;
    case 9: c.blockBeforeMs = v; break;
    case 10: c.blockAfterMs = v; break;
    case 11: c.guardMs = v; break;
    case 12: c.maxQueue = (size_t)std::max(0, toInt(v)); break;
    case 13: c.maxAgeMs = v; break;
    case 14: c.rtcmWatch = v != 0; break;
    case 15: c.rtcmWarnS = v; break;
    case 16: c.rtcmRepeatS = v; break;
    case 17: c.rtcmForward = v != 0; break;
    case 18: c.slotEnabled = v != 0; break;
    case 19: c.slotIndex = std::isnan(v) || v < 0 ? -1 : (int)v; break;  // no "null" here: unset, garbage or negative follow the base
    case 20: c.slotCount = toInt(v); break;                                 // 0 = auto
    case 21: c.slotWidthMs = v; break;
    case 22: c.joinSlots = toInt(v); break;
    case 23: c.rtcmIntervalS = v; break;
    case 24: c.maxHz = v; break;
    case 25: c.reserveFrames = toInt(v); break;
    case 26: c.markZoneM = v; break;
    case 27: c.joinReportS = v; break;
    case 28: c.parkedReportS = v; break;
    case 29: c.parkedFirstS = v; break;
    case 30: c.parkedRepeatS = v; break;
    case 31: c.unparkFixes = toInt(v); break;
    case 32: c.parkDwellS = v; break;
    case 33: c.movingKn = v; break;
    case 34: c.onGridZoneM = v; break;
    case 35: c.sleepCycleS = toInt(v); break;
    case 36: c.sleepListenMs = v; break;
    case 37: c.gpsSleepForceUsb = v != 0; break;
    case 38: c.gpsLog = v != 0; break;
  }
}

double load(const RoverConfig& c, size_t i) {
  switch (i) {
    case 0: return c.txDistanceM;
    case 1: return c.txIntervalMs / 1000;
    case 2: return c.txDelta;
    case 3: return c.txBatchSize;
    case 4: return c.txFinishApproachZoneM;
    case 5: return c.txFinishDistanceM;
    case 6: return c.pingResponseJitterMs;
    case 7: return c.helloStartupJitterMs;
    case 8: return c.txGateEnabled;
    case 9: return c.blockBeforeMs;
    case 10: return c.blockAfterMs;
    case 11: return c.guardMs;
    case 12: return (double)c.maxQueue;
    case 13: return c.maxAgeMs;
    case 14: return c.rtcmWatch;
    case 15: return c.rtcmWarnS;
    case 16: return c.rtcmRepeatS;
    case 17: return c.rtcmForward;
    case 18: return c.slotEnabled;
    case 19: return c.slotIndex;
    case 20: return c.slotCount;
    case 21: return c.slotWidthMs;
    case 22: return c.joinSlots;
    case 23: return c.rtcmIntervalS;
    case 24: return c.maxHz;
    case 25: return c.reserveFrames;
    case 26: return c.markZoneM;
    case 27: return c.joinReportS;
    case 28: return c.parkedReportS;
    case 29: return c.parkedFirstS;
    case 30: return c.parkedRepeatS;
    case 31: return c.unparkFixes;
    case 32: return c.parkDwellS;
    case 33: return c.movingKn;
    case 34: return c.onGridZoneM;
    case 35: return c.sleepCycleS;
    case 36: return c.sleepListenMs;
    case 37: return c.gpsSleepForceUsb;
    case 38: return c.gpsLog;
  }
  return NAN;
}

int indexOf(const std::string& name) {
  for (size_t i = 0; i < RULE_COUNT; i++)
    if (name == RULES[i].info.name) return (int)i;
  return -1;
}

double parse(const Rule& r, const char* v, bool txDelta) {
  if (r.kind == ON) return notOff(v);
  if (r.kind == OFF) return isOn(v);
  if (!r.def) return v && *v ? jsParseInt(v) : NAN;  // TX_SLOT: no default, null when unset
  double x = r.kind == F ? pf(v, r.def) : pi(v, r.def);
  if (!std::isnan(r.fallback)) x = orNum(x, r.fallback);
  double hi = r.hi;
  if (!std::strcmp(r.info.name, "TX_BATCH_SIZE")) hi = txDelta ? protocol::MAX_DELTA_COUNT : protocol::MAX_BATCH_COUNT;
  if (!std::isnan(hi)) x = std::min(hi, x);
  if (!std::isnan(r.lo)) x = std::max(r.lo, x);
  return x;
}

}  // namespace

double jsParseFloat(const char* s) {
  while (isSpace(*s)) s++;
  const char* p = s;
  if (*p == '+' || *p == '-') p++;
  if (std::strncmp(p, "Infinity", 8) == 0) return *s == '-' ? -INFINITY : INFINITY;
  bool digits = false;
  while (std::isdigit((unsigned char)*p)) p++, digits = true;
  if (*p == '.') {
    p++;
    while (std::isdigit((unsigned char)*p)) p++, digits = true;
  }
  if (!digits) return NAN;
  if (*p == 'e' || *p == 'E') {
    const char* q = p + 1;
    if (*q == '+' || *q == '-') q++;
    if (std::isdigit((unsigned char)*q)) {
      while (std::isdigit((unsigned char)*q)) q++;
      p = q;
    }
  }
  return std::strtod(std::string(s, p).c_str(), nullptr);
}

double jsParseInt(const char* s) {
  while (isSpace(*s)) s++;
  bool neg = false;
  if (*s == '+' || *s == '-') neg = *s++ == '-';
  if (!std::isdigit((unsigned char)*s)) return NAN;
  double v = 0;
  while (std::isdigit((unsigned char)*s)) v = v * 10 + (*s++ - '0');
  return neg ? -v : v;
}

const std::vector<Setting>& all() {
  static const std::vector<Setting> list = [] {
    std::vector<Setting> l;
    for (const Rule& r : RULES) l.push_back(r.info);
    return l;
  }();
  return list;
}

const Setting* find(const std::string& name) {
  const int i = indexOf(name);
  return i < 0 ? nullptr : &RULES[i].info;
}

void apply(RoverConfig& cfg, const std::function<const char*(const char*)>& get) {
  for (size_t i = 0; i < RULE_COUNT; i++) {
    const char* v = get(RULES[i].info.name);
    // TX_SLOT_COUNT: unset is "auto" (0), not its default of 25 (config.js's countAuto)
    if (!std::strcmp(RULES[i].info.name, "TX_SLOT_COUNT") && !(v && *v)) store(cfg, i, 0);
    else store(cfg, i, parse(RULES[i], v, cfg.txDelta));
  }
}

bool check(const std::string& name, const std::string& value, std::string& error) {
  const int i = indexOf(name);
  if (i < 0) {
    error = "unknown setting " + name + " (\"settings\" lists them)";
    return false;
  }
  if (RULES[i].info.isSwitch) {
    if (value == "1" || value == "0" || value == "true" || value == "false") return true;
    error = name + " is a switch: 1, 0, true or false";
    return false;
  }
  char* end = nullptr;
  std::strtod(value.c_str(), &end);
  if (value.empty() || *end != 0 || std::isnan(jsParseFloat(value.c_str())) || value.find_first_of("xXnN") != std::string::npos) {
    error = name + " needs a number (got \"" + value + "\")";
    return false;
  }
  return true;
}

std::string current(const RoverConfig& cfg, const std::string& name) {
  const int i = indexOf(name);
  if (i < 0) return "";
  const double v = load(cfg, (size_t)i);
  if (!std::strcmp(RULES[i].info.name, "TX_SLOT")) return v >= 0 ? num(v) : "base";
  if (!std::strcmp(RULES[i].info.name, "TX_SLOT_COUNT")) return v > 0 ? num(v) : "auto";
  return RULES[i].info.isSwitch ? onOff(v != 0) : num(v);
}

}  // namespace settings
}  // namespace rover
