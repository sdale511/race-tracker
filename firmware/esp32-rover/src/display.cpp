#include "display.h"

#ifdef HAS_TFT

#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <Arduino.h>

#ifndef SCREEN_BUTTON_PIN
#define SCREEN_BUTTON_PIN 1  // the D1 button, high when pressed
#endif
#ifndef SCREEN_ON_MS
#define SCREEN_ON_MS 30000
#endif

namespace display {

namespace {
Adafruit_ST7789 tft(TFT_CS, TFT_DC, TFT_RST);
bool lit = false;
uint32_t litAt = 0;
uint32_t drawnAt = 0;

void light(bool on) {
  lit = on;
  digitalWrite(TFT_BACKLITE, on ? HIGH : LOW);
  if (on) litAt = millis();
}

void line(int y, uint16_t color, const char* text) {
  tft.setCursor(4, y);
  tft.setTextColor(color, ST77XX_BLACK);
  tft.print(text);
  // clear what a longer previous line left behind
  for (int i = strlen(text); i < 20; i++) tft.print(' ');
}
}  // namespace

void begin() {
  pinMode(SCREEN_BUTTON_PIN, INPUT_PULLDOWN);
  pinMode(TFT_BACKLITE, OUTPUT);
  tft.init(135, 240);
  tft.setRotation(3);
  tft.fillScreen(ST77XX_BLACK);
  tft.setTextSize(2);  // 12x16 px: 20 characters by 8 lines
  light(true);
}

void update(const Status& s) {
  const uint32_t now = millis();
  if (digitalRead(SCREEN_BUTTON_PIN) == HIGH && !lit) light(true);
  if (lit && now - litAt > SCREEN_ON_MS) light(false);
  if (!lit || now - drawnAt < 1000) return;
  drawnAt = now;
  char b[32];
  snprintf(b, sizeof b, "%s %s", s.boatId.c_str(), s.sleeping ? "ASLEEP" : "");
  line(0, ST77XX_WHITE, b);
  const char* fix = !s.fix ? "no fix" : s.carrSoln == 2 ? "RTK fixed" : s.carrSoln == 1 ? "RTK float" : "GPS only";
  snprintf(b, sizeof b, "%s  %d sv", fix, s.numSV);
  line(18, !s.fix ? ST77XX_RED : s.carrSoln == 2 ? ST77XX_GREEN : ST77XX_YELLOW, b);
  line(36, s.bursts ? ST77XX_GREEN : ST77XX_RED, s.bursts ? "corrections heard" : "no corrections");
  if (s.parked) snprintf(b, sizeof b, "parked on the grid");
  else if (s.slot >= 0) snprintf(b, sizeof b, "slot %d", s.slot);
  else snprintf(b, sizeof b, "no slot yet");
  line(54, ST77XX_CYAN, b);
  if (s.batteryPct >= 0) snprintf(b, sizeof b, "battery %d%% %.2fV", s.batteryPct, s.batteryV);
  else snprintf(b, sizeof b, "battery ?");
  line(72, s.batteryPct >= 0 && s.batteryPct < 20 ? ST77XX_RED : ST77XX_WHITE, b);
  snprintf(b, sizeof b, "sent %u", s.framesSent);
  line(90, ST77XX_WHITE, b);
  line(108, ST77XX_YELLOW, s.note.substr(0, 19).c_str());
}

void off() {
  light(false);
#ifdef TFT_I2C_POWER
  digitalWrite(TFT_I2C_POWER, LOW);
#endif
}

}  // namespace display

#else

namespace display {
void begin() {}
void update(const Status&) {}
void off() {}
}  // namespace display

#endif
