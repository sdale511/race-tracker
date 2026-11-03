// The rover's settings by their Node names (TX_DISTANCE_M, TX_SLOT_MAX_HZ, ...), parsed exactly as src/config.js parses its
// environment variables - the same defaults, clamps and fall-backs, checked against config.js by the vectors (tools/gen_vectors.js).
// host_rover reads them from the environment, the ESP32 from NVS (set over the serial console); both pass them in through get().
#pragma once

#include <functional>
#include <string>
#include <vector>

#include "rover.h"

namespace rover {
namespace settings {

struct Setting {
  const char* name;
  const char* help;
  bool isSwitch;  // 1/0/true/false rather than a number
};
const std::vector<Setting>& all();
const Setting* find(const std::string& name);

// Sets every setting in cfg from get(name): nullptr = not set, which is the config.js default (an empty string too, as there)
void apply(RoverConfig& cfg, const std::function<const char*(const char*)>& get);

// For a value typed at the console: a number setting must be a number (config.js would quietly take "12x" as 12, or "abc" as its
// default), a switch 1/0/true/false. TX_SLOT also takes an empty value (follow the base) - unset it for that.
bool check(const std::string& name, const std::string& value, std::string& error);

// The value in effect, as config.js would hold it ("auto" for an unset TX_SLOT_COUNT, "base" for an unset TX_SLOT)
std::string current(const RoverConfig& cfg, const std::string& name);

// JavaScript's parseFloat and parseInt(s, 10): the longest number at the start of s (after white space), NaN when there is none
double jsParseFloat(const char* s);
double jsParseInt(const char* s);

}  // namespace settings
}  // namespace rover
