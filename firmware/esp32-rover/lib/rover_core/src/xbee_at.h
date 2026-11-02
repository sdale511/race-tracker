// Sets the XBee's node identifier (NI) to the boat id over AT command mode - a port of src/xbeeAt.js. Blocking: the ESP32 runs it once at
// boot, before anything is sent, so no telemetry byte can land in command mode. The IO is injected so the host tests can play the radio.
#pragma once

#include <functional>
#include <string>

namespace rover {
namespace xbee {

constexpr unsigned GUARD_MS = 1100;  // must exceed the module's guard time (GT, 1000 ms by default)
constexpr unsigned RESPONSE_TIMEOUT_MS = 2000;
constexpr size_t NI_MAX_LEN = 20;

struct Io {
  std::function<void(const std::string&)> write;
  // whatever the radio has sent within timeoutMs, appended to buf; returns false when nothing more arrived in time
  std::function<bool(std::string& buf, unsigned timeoutMs)> read;
  std::function<void(unsigned ms)> sleep;
};

struct Result {
  bool ok = false;
  bool changed = false;
  std::string previous;
  std::string error;
};

Result setNodeIdentifier(const Io& io, const std::string& ni, unsigned guardMs = GUARD_MS, unsigned timeoutMs = RESPONSE_TIMEOUT_MS);

}  // namespace xbee
}  // namespace rover
