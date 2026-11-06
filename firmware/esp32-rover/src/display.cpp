#include "display.h"

#ifdef HAS_TFT

#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <Arduino.h>

#ifndef SCREEN_BUTTON_PIN
#define SCREEN_BUTTON_PIN 1  // the D1 button, high when pressed: the full status page
#endif
#ifndef BIG_BUTTON_PIN
#define BIG_BUTTON_PIN 0  // the D0 (BOOT) button, low when pressed: the large page
#endif
#ifndef VERSION_BUTTON_PIN
#define VERSION_BUTTON_PIN 2  // the D2 button, high when pressed: the firmware version
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
enum Page { FULL, BIG, VERSION };
Page page = FULL;          // D1, D0, D2
std::string version;       // tools/version.py's label: "v0.1.290 (abc1234, 2026-11-06) + local changes"
std::string bigShown[3];   // what each large line shows now, so only a changed line is cleared and redrawn

void light(bool on) {
  lit = on;
  digitalWrite(TFT_BACKLITE, on ? HIGH : LOW);
  if (on) litAt = millis();
}

// lights the screen on a page, redrawing at once; a press on the page already shown keeps it lit for another SCREEN_ON_MS
void show(Page p) {
  if (p != page) {
    page = p;
    tft.fillScreen(ST77XX_BLACK);
    for (auto& s : bigShown) s.clear();
    drawnAt = 0;
  }
  if (!lit) drawnAt = 0;
  light(true);
}

void line(int y, uint16_t color, const char* text) {
  tft.setTextSize(2);
  tft.setCursor(4, y);
  tft.setTextColor(color, ST77XX_BLACK);
  tft.print(text);
  // clear what a longer previous line left behind
  for (int i = strlen(text); i < 19; i++) tft.print(' ');
}

// size 5: 30x40 px characters, 8 to a line, centred; three lines fill the 135 px
void bigLine(int i, uint16_t color, const std::string& text) {
  const std::string t = text.substr(0, 8);
  const std::string key = t + '/' + std::to_string(color);  // a change of colour alone redraws too
  if (bigShown[i] == key) return;
  bigShown[i] = key;
  const int y = 4 + i * 44;
  tft.fillRect(0, y, 240, 40, ST77XX_BLACK);
  tft.setTextSize(5);
  tft.setTextColor(color);
  tft.setCursor((240 - (int)t.size() * 30) / 2, y);
  tft.print(t.c_str());
}

// the one word that matters most: asleep, then no fix, then the first thing still needed from the base, then the fix
void bigStatus(const Status& s, std::string& text, uint16_t& color) {
  if (s.sleeping) text = "ASLEEP", color = ST77XX_WHITE;
  else if (!s.fix) text = "NO FIX", color = ST77XX_RED;
  else if (!s.ready) {
    std::string first = s.need.substr(0, s.need.find(' '));
    for (char& c : first) c = toupper(c);
    text = first.empty() ? "WAITING" : "NO " + first, color = ST77XX_YELLOW;
  } else if (s.carrSoln == 2) text = "READY", color = ST77XX_GREEN;
  else text = s.carrSoln == 1 ? "RTK FLT" : "GPS ONLY", color = ST77XX_YELLOW;
}

void drawBig(const Status& s) {
  bigLine(0, s.sleeping ? ST77XX_WHITE : s.ready ? ST77XX_GREEN : ST77XX_YELLOW, s.boatId);  // coloured as the full page's top line
  char b[16];
  if (s.batteryPct >= 0) snprintf(b, sizeof b, "%d%%", s.batteryPct);
  else snprintf(b, sizeof b, "BAT ?");
  bigLine(1, s.batteryPct >= 0 && s.batteryPct < 20 ? ST77XX_RED : ST77XX_WHITE, b);
  std::string text;
  uint16_t color;
  bigStatus(s, text, color);
  bigLine(2, color, text);
}

// the version label split to fit: the number large, then the commit and date, then "+ local changes" (a build from edited files)
void drawVersion(const Status& s) {
  const size_t paren = version.find(" (");
  const size_t close = version.find(')', paren);
  const std::string number = version.substr(0, paren);
  std::string details = paren == std::string::npos || close == std::string::npos ? "" : version.substr(paren + 2, close - paren - 2);
  const size_t comma = details.find(", ");
  if (comma != std::string::npos) details.replace(comma, 2, " ");
  const bool dirty = version.find("+ local changes") != std::string::npos;
  line(0, ST77XX_WHITE, s.boatId.c_str());
  line(17, ST77XX_CYAN, "firmware");
  tft.setTextSize(4);  // 24x32 px: 9 characters to a line
  tft.setTextColor(ST77XX_GREEN, ST77XX_BLACK);
  tft.setCursor(4, 40);
  tft.print(number.substr(0, 9).c_str());
  line(85, ST77XX_WHITE, details.substr(0, 19).c_str());
  line(102, ST77XX_YELLOW, dirty ? "+ local changes" : "");
}

void drawFull(const Status& s) {
  char b[32];
  snprintf(b, sizeof b, "%s %s", s.boatId.c_str(), s.sleeping ? "ASLEEP" : s.ready ? "READY" : "waiting");
  line(0, s.sleeping ? ST77XX_WHITE : s.ready ? ST77XX_GREEN : ST77XX_YELLOW, b);
  const char* fix = !s.fix ? "no fix" : s.carrSoln == 2 ? "RTK fixed" : s.carrSoln == 1 ? "RTK float" : "GPS only";
  snprintf(b, sizeof b, "%s  %d sv", fix, s.numSV);
  line(17, !s.fix ? ST77XX_RED : s.carrSoln == 2 ? ST77XX_GREEN : ST77XX_YELLOW, b);
  line(34, s.bursts ? ST77XX_GREEN : ST77XX_RED, s.bursts ? "corrections heard" : "no corrections");
  if (s.parked) snprintf(b, sizeof b, "parked on the grid");
  else if (s.slot >= 0) snprintf(b, sizeof b, "slot %d", s.slot);
  else snprintf(b, sizeof b, "no slot yet");
  line(51, ST77XX_CYAN, b);
  if (s.batteryPct >= 0) snprintf(b, sizeof b, "battery %d%% %.2fV", s.batteryPct, s.batteryV);
  else snprintf(b, sizeof b, "battery ?");
  line(68, s.batteryPct >= 0 && s.batteryPct < 20 ? ST77XX_RED : ST77XX_WHITE, b);
  snprintf(b, sizeof b, "sent %u", s.framesSent);
  line(85, ST77XX_WHITE, b);
  line(102, ST77XX_YELLOW, s.note.substr(0, 19).c_str());
  // what the base hasn't sent yet, the bottom line so "waiting" always says why
  line(119, ST77XX_YELLOW, s.ready || s.sleeping ? "" : ("need " + s.need).substr(0, 19).c_str());
}
}  // namespace

void begin(const char* firmwareVersion) {
  version = firmwareVersion;
  pinMode(SCREEN_BUTTON_PIN, INPUT_PULLDOWN);
  pinMode(VERSION_BUTTON_PIN, INPUT_PULLDOWN);
  pinMode(BIG_BUTTON_PIN, INPUT_PULLUP);
  pinMode(TFT_BACKLITE, OUTPUT);
  tft.init(135, 240);
  tft.setRotation(3);
  tft.setTextWrap(false);
  tft.fillScreen(ST77XX_BLACK);  // full page: size 2, 12x16 px - 19 characters (after the 4 px margin) by 8 lines, 17 px apart
  light(true);
}

void update(const Status& s) {
  const uint32_t now = millis();
  if (digitalRead(SCREEN_BUTTON_PIN) == HIGH) show(FULL);
  if (digitalRead(BIG_BUTTON_PIN) == LOW) show(BIG);
  if (digitalRead(VERSION_BUTTON_PIN) == HIGH) show(VERSION);
  if (lit && now - litAt > SCREEN_ON_MS) light(false);
  if (!lit || (drawnAt && now - drawnAt < 1000)) return;
  drawnAt = now;
  if (page == BIG) drawBig(s);
  else if (page == VERSION) drawVersion(s);
  else drawFull(s);
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
void begin(const char*) {}
void update(const Status&) {}
void off() {}
}  // namespace display

#endif
