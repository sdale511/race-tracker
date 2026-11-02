// The Reverse TFT Feather's screen (#5691): the rover's status at a glance. Built only with -DHAS_TFT (the feather_s3_reversetft env).
// The backlight is the costly part, so it comes on for SCREEN_ON_MS after boot or a press of the D1 button and then goes off.
#pragma once

#include <string>

namespace display {

struct Status {
  std::string boatId;
  bool fix = false;
  int carrSoln = 0;  // 0 none, 1 float, 2 RTK fixed
  int numSV = 0;
  bool bursts = false;
  int slot = -1;
  bool parked = false;
  bool sleeping = false;
  int batteryPct = -1;  // -1 = no battery monitor reading
  float batteryV = 0;
  unsigned framesSent = 0;
  std::string note;  // a short last message, e.g. why it is about to sleep
};

void begin();
void update(const Status& s);  // call every loop pass; redraws about once a second while the screen is on
void off();                    // backlight and the TFT's power, before deep sleep

}  // namespace display
