// ESP32-S3 rover: the Arduino glue around lib/rover_core. Wiring (see README.md):
//   ZED-F9P UART1  <-> Serial1 on the Feather's RX/TX pins (UBX at GPS_BAUD)
//   XBee DOUT/DIN  <-> Serial2 on XBEE_RX_PIN/XBEE_TX_PIN (at RADIO_BAUD). With the XBee in the ArduSimple's socket: through its
//                      "XBEE TX / GPS RX2" and "XBEE RX / GPS TX2" pins, the ZED's UART2 off and RTCM_FORWARD=1 (the socket build).
//                      With the XBee on a breakout: the XBee's DOUT also goes to the ZED's UART2 RX for RTCM
//   XBee SLEEP_RQ  <-  RADIO_SLEEP_PIN (high = asleep), with a 10k pull-down so the radio stays awake while the ESP32 boots;
//                      breakout only - the ArduSimple's socket doesn't bring it out
//   LIS3DH         on the Feather's I2C (SDA/SCL, address ACCEL_ADDR), powered from 3V; its INT1 to ACCEL_INT_PIN (an RTC GPIO)
//   GPS_POWER_PIN / RADIO_POWER_PIN (optional): the enable pins of the GPS board's and the XBee's regulators, so deep sleep cuts them
// The boat id, the last course marks and the base's last power schedule are kept in NVS (Preferences).

#include <Arduino.h>
#include <Adafruit_MAX1704X.h>
#include <Preferences.h>
#include <Wire.h>
#include <driver/gpio.h>
#include <driver/rtc_io.h>
#include <esp_random.h>
#include <esp_sleep.h>
#include <sys/time.h>
#include <time.h>

#include <cmath>
#include <map>

#include "display.h"
#include "rover.h"
#include "settings.h"
#include "xbee_at.h"

#ifndef GPS_BAUD
#define GPS_BAUD 115200
#endif
#ifndef RADIO_BAUD
#define RADIO_BAUD 115200
#endif
#ifndef GPS_RX_PIN
#define GPS_RX_PIN RX  // the Feather's RX pin, from the ZED's TX1
#endif
#ifndef GPS_TX_PIN
#define GPS_TX_PIN TX  // the Feather's TX pin, to the ZED's RX1
#endif
#ifndef XBEE_RX_PIN
#define XBEE_RX_PIN 5  // from the XBee's DOUT (pin 2)
#endif
#ifndef XBEE_TX_PIN
#define XBEE_TX_PIN 6  // to the XBee's DIN (pin 3)
#endif
#ifndef RADIO_SLEEP_PIN
#define RADIO_SLEEP_PIN 9  // to the XBee's SLEEP_RQ (pin 9); -1 = not wired
#endif
#ifndef ACCEL_INT_PIN
#define ACCEL_INT_PIN 10  // from the LIS3DH's INT1; -1 = no accelerometer
#endif
#ifndef ACCEL_ADDR
#define ACCEL_ADDR 0x18  // the Adafruit LIS3DH breakout's default
#endif
#ifndef ACCEL_THRESHOLD_MG
#define ACCEL_THRESHOLD_MG 250  // how hard a jolt wakes the boat; raise it if wind on a parked boat wakes it
#endif
#ifndef GPS_POWER_PIN
#define GPS_POWER_PIN -1
#endif
#ifndef RADIO_POWER_PIN
#define RADIO_POWER_PIN -1
#endif
#ifndef SET_XBEE_NI
#define SET_XBEE_NI 1  // set the XBee's node identifier to the boat id at boot (xbeeAt.js)
#endif
#ifndef ROVER_TZ
#define ROVER_TZ "PST8PDT,M3.2.0,M11.1.0"  // the boat's local time, as a POSIX TZ string - the power schedule's times are local
#endif
#ifndef ROVER_BUILD
#define ROVER_BUILD 0  // tools/version.py sets these from git
#endif
#ifndef ROVER_VERSION
#define ROVER_VERSION "unknown"
#endif
#ifndef ROVER_DIRTY
#define ROVER_DIRTY 0
#endif
#ifndef GPS_LOG
#define GPS_LOG 0  // a console line for every fix, as the Node rover's GPS_LOG=1
#endif

using rover::Rover;
using rover::RoverConfig;
using rover::RoverHal;

namespace {

Preferences prefs;
Rover* theRover = nullptr;
Adafruit_MAX17048 battery;
bool batteryOk = false;
std::string lastNote;

// The RTC keeps time through a deep sleep; this says the GPS has set it
RTC_DATA_ATTR bool rtcClockSet = false;

// ---- NVS ----

// boatIdFile.js's rule: 5 of A-Z and 0-9, made up once and kept in NVS
std::string loadBoatId() {
  String id = prefs.getString("boatId", "");
  if (!rover::protocol::validBoatId(id.c_str())) {
    id = rover::protocol::makeBoatId([](uint32_t n) { return esp_random() % n; }).c_str();
    prefs.putString("boatId", id);
    Serial.printf("[boatAgent] new boat id %s\n", id.c_str());
  }
  return id.c_str();
}

// The course marks: the 16 coordinates and the pin boundary flag
struct StoredMarks {
  double latLon[rover::protocol::MARK_COUNT * 2];
  uint8_t pinBoundary;
};

void saveMarks(const rover::protocol::Marks& m) {
  StoredMarks s;
  for (size_t i = 0; i < rover::protocol::MARK_COUNT; i++) {
    s.latLon[i * 2] = m.mark[i].lat;
    s.latLon[i * 2 + 1] = m.mark[i].lon;
  }
  s.pinBoundary = m.pinBoundaryEnabled;
  prefs.putBytes("marks", &s, sizeof s);
}

bool loadMarks(rover::protocol::Marks& m) {
  StoredMarks s;
  if (prefs.getBytesLength("marks") != sizeof s || prefs.getBytes("marks", &s, sizeof s) != sizeof s) return false;
  for (size_t i = 0; i < rover::protocol::MARK_COUNT; i++) m.mark[i] = {s.latLon[i * 2], s.latLon[i * 2 + 1]};
  m.pinBoundaryEnabled = s.pinBoundary;
  return true;
}

// The rover settings set at the console (TX_DISTANCE_M=2 ...), one "NAME=value" line each in one NVS string - the names are longer
// than NVS's 15-character keys. Read at boot as config.js reads its environment (see settings.h).
std::map<std::string, std::string> loadSettings() {
  std::map<std::string, std::string> m;
  const std::string all = prefs.getString("settings", "").c_str();
  size_t start = 0;
  while (start < all.size()) {
    size_t end = all.find('\n', start);
    if (end == std::string::npos) end = all.size();
    const std::string line = all.substr(start, end - start);
    const size_t eq = line.find('=');
    if (eq != std::string::npos && rover::settings::find(line.substr(0, eq))) m[line.substr(0, eq)] = line.substr(eq + 1);
    start = end + 1;
  }
  return m;
}

#ifndef ROVER_SETTINGS
#define ROVER_SETTINGS ""  // this build's own defaults, "NAME=value NAME=value" (e.g. RTCM_FORWARD=1 for the XBee in the ArduSimple's socket)
#endif

// ROVER_SETTINGS as a map - unknown names left out, as in NVS
const std::map<std::string, std::string>& buildSettings() {
  static std::map<std::string, std::string> m;
  static bool parsed = false;
  if (!parsed) {
    parsed = true;
    const std::string all = ROVER_SETTINGS;
    size_t i = 0;
    while (i < all.size()) {
      while (i < all.size() && all[i] == ' ') i++;
      size_t j = all.find(' ', i);
      if (j == std::string::npos) j = all.size();
      const std::string word = all.substr(i, j - i);
      const size_t eq = word.find('=');
      if (eq != std::string::npos && rover::settings::find(word.substr(0, eq))) m[word.substr(0, eq)] = word.substr(eq + 1);
      i = j;
    }
  }
  return m;
}

// A setting's value as settings::apply wants it: set at the console, else this build's default, else unset (config.js's default)
std::function<const char*(const char*)> settingsSource(const std::map<std::string, std::string>& saved) {
  return [&saved](const char* n) {
    auto it = saved.find(n);
    if (it != saved.end()) return it->second.c_str();
    auto b = buildSettings().find(n);
    return b == buildSettings().end() ? (const char*)nullptr : b->second.c_str();
  };
}

void saveSettings(const std::map<std::string, std::string>& m) {
  std::string all;
  for (const auto& kv : m) all += kv.first + "=" + kv.second + "\n";
  prefs.putString("settings", all.c_str());
}

// PowerSchedule is plain data, kept as its bytes (a size change after a firmware update just reads as "none")
void saveSchedule(const rover::protocol::PowerSchedule& s) { prefs.putBytes("schedule", &s, sizeof s); }
bool loadSchedule(rover::protocol::PowerSchedule& s) {
  return prefs.getBytesLength("schedule") == sizeof s && prefs.getBytes("schedule", &s, sizeof s) == sizeof s;
}

// ---- the radio and the GPS ----

// Like radioLink.js's _writable: a frame that doesn't fit the UART's transmit buffer is refused, not queued behind a backlog
bool radioWrite(const uint8_t* data, size_t len) {
  if ((size_t)Serial2.availableForWrite() < len) return false;
  return Serial2.write(data, len) == len;
}

bool gpsWrite(const uint8_t* data, size_t len) { return Serial1.write(data, len) == len; }

void setNodeIdentifier(const std::string& boatId) {
  rover::xbee::Io io;
  io.write = [](const std::string& s) { Serial2.write((const uint8_t*)s.data(), s.size()); };
  io.read = [](std::string& buf, unsigned timeoutMs) {
    const uint32_t start = millis();
    while (!Serial2.available())
      if (millis() - start > timeoutMs) return false;
    while (Serial2.available()) buf += (char)Serial2.read();
    return true;
  };
  io.sleep = [](unsigned ms) { delay(ms); };
  const auto r = rover::xbee::setNodeIdentifier(io, boatId);
  if (!r.ok) Serial.printf("[radio] could not set the xbee node identifier (NI) to \"%s\": %s - carrying on\n", boatId.c_str(), r.error.c_str());
  else if (r.changed) Serial.printf("[radio] xbee node identifier (NI) set to \"%s\" (was \"%s\") and saved\n", boatId.c_str(), r.previous.c_str());
  else Serial.printf("[radio] xbee node identifier (NI) already \"%s\"\n", boatId.c_str());
}

// ---- local time ----

rover::LocalDate toLocal(int64_t wallMs) {
  const time_t t = (time_t)(wallMs / 1000);
  struct tm tm;
  localtime_r(&t, &tm);
  return {tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour * 60 + tm.tm_min};
}

int64_t fromLocal(int year, int month, int day, int minutes) {
  struct tm tm = {};
  tm.tm_year = year - 1900;
  tm.tm_mon = month - 1;
  tm.tm_mday = day;  // mktime rolls an out-of-range day over, like Date
  tm.tm_hour = minutes / 60;
  tm.tm_min = minutes % 60;
  tm.tm_isdst = -1;
  return (int64_t)mktime(&tm) * 1000;
}

int64_t rtcMs() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

// The GPS's time into the RTC, so it survives a deep sleep (and the timer wake is set against real time)
uint32_t rtcSetAt = 0;
void keepRtc() {
  int64_t wall;
  if (!theRover->wallNow(wall) || (rtcClockSet && millis() - rtcSetAt < 60000)) return;
  if (!theRover->lastPvt() || !theRover->lastPvt()->utcValid) return;  // only the GPS's own time, not the RTC's echo of it
  struct timeval tv = {(time_t)(wall / 1000), (suseconds_t)((wall % 1000) * 1000)};
  settimeofday(&tv, nullptr);
  rtcClockSet = true;
  rtcSetAt = millis();
}

// ---- the accelerometer (LIS3DH registers; no library) ----

bool accelWrite(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(ACCEL_ADDR);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

int accelRead(uint8_t reg) {
  Wire.beginTransmission(ACCEL_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0 || Wire.requestFrom(ACCEL_ADDR, 1) != 1) return -1;
  return Wire.read();
}

// Motion on INT1: 10 Hz low-power, high-pass filtered (so gravity doesn't count), any axis over the threshold, latched until read
bool armAccelerometer() {
  if (ACCEL_INT_PIN < 0) return false;
  const int threshold = ACCEL_THRESHOLD_MG / 16;  // 16 mg per step at +-2 g
  const bool ok = accelWrite(0x20, 0x2f)          // CTRL_REG1: 10 Hz, low power, X/Y/Z
                  && accelWrite(0x21, 0x09)       // CTRL_REG2: high-pass filter on INT1
                  && accelWrite(0x22, 0x40)       // CTRL_REG3: IA1 to INT1
                  && accelWrite(0x23, 0x00)       // CTRL_REG4: +-2 g
                  && accelWrite(0x24, 0x08)       // CTRL_REG5: latch INT1
                  && accelWrite(0x32, threshold < 1 ? 1 : threshold > 127 ? 127 : threshold)  // INT1_THS
                  && accelWrite(0x33, 0x01);      // INT1_DURATION: one sample (100 ms)
  if (!ok) return false;
  delay(200);
  accelRead(0x26);  // REFERENCE: settles the high-pass filter to the board's resting position
  accelRead(0x31);  // INT1_SRC: clears anything latched while settling
  return accelWrite(0x30, 0x2a);  // INT1_CFG: X, Y or Z high
}

// ---- deep sleep ----

void powerPin(int pin, bool on) {
  if (pin < 0) return;
  gpio_hold_dis((gpio_num_t)pin);
  pinMode(pin, OUTPUT);
  digitalWrite(pin, on ? HIGH : LOW);
}

void deepSleep(const rover::PowerPolicy::Decision& d) {
  lastNote = "sleep: " + d.reason;
  Serial.printf("[power] deep sleep (%s)%s\n", d.reason.c_str(), d.hasWakeAt ? "" : " until motion");
  Serial.flush();
  Serial2.flush();
  delay(200);  // the GPS's backup command (sent by the rover) on its way out
  // the XBee asleep, the GPS and radio supplies off, all held through the sleep
  if (RADIO_SLEEP_PIN >= 0) {
    digitalWrite(RADIO_SLEEP_PIN, HIGH);
    gpio_hold_en((gpio_num_t)RADIO_SLEEP_PIN);
  }
  for (int pin : {GPS_POWER_PIN, RADIO_POWER_PIN}) {
    if (pin < 0) continue;
    digitalWrite(pin, LOW);
    gpio_hold_en((gpio_num_t)pin);
  }
  gpio_deep_sleep_hold_en();
  display::off();
  if (armAccelerometer()) {
    rtc_gpio_pullup_dis((gpio_num_t)ACCEL_INT_PIN);
    rtc_gpio_pulldown_en((gpio_num_t)ACCEL_INT_PIN);
    esp_sleep_enable_ext0_wakeup((gpio_num_t)ACCEL_INT_PIN, 1);
  } else if (ACCEL_INT_PIN >= 0) {
    Serial.println("[power] the accelerometer did not answer - only the timer can wake this boat");
  }
  if (d.hasWakeAt) {
    const int64_t ms = d.wakeAt - rtcMs();
    esp_sleep_enable_timer_wakeup((uint64_t)(ms > 1000 ? ms : 1000) * 1000);
  }
  esp_deep_sleep_start();
}

// ---- status ----

display::Status status() {
  display::Status s;
  const rover::Pvt* p = theRover->lastPvt();
  s.fix = p && p->gnssFixOk;
  s.carrSoln = p ? p->carrSoln : 0;
  s.numSV = p ? p->numSV : 0;
  s.bursts = theRover->burstsHeard();
  s.slot = theRover->assignedSlot();
  s.parked = theRover->parked();
  s.sleeping = theRover->sleeping();
  if (batteryOk) {
    s.batteryPct = (int)battery.cellPercent();
    s.batteryV = battery.cellVoltage();
  }
  s.framesSent = theRover->framesSent();
  s.note = lastNote;
  s.boatId = theRover->boatId();
  const rover::Rover::BaseData base = theRover->baseData();
  s.ready = base.ready;
  // "marks, corrections, slot table" -> "marks rtcm slot", to fit the screen
  for (const auto& kv : {std::make_pair("marks", "marks"), std::make_pair("corrections", "rtcm"), std::make_pair("slot table", "slot")})
    if (base.missing.find(kv.first) != std::string::npos) s.need += (s.need.empty() ? "" : " ") + std::string(kv.second);
  return s;
}

// the rover logs its own [status] line; the battery is the ESP32's
uint32_t lastBatteryAt = 0;
void logBattery(const display::Status& s) {
  if (s.batteryPct >= 0) Serial.printf("[battery] %d%% %.2fV\n", s.batteryPct, s.batteryV);
  else Serial.println("[battery] no MAX17048 answering");
}

// ---- the serial console ----
// Typed at `pio device monitor`: rover settings by their Node names, saved in NVS and used from the next boot.
//   settings              every setting: the value in effect, and what is saved for the next boot if that differs
//   get NAME / set NAME VALUE / unset NAME
//   boatid [ID]           show, or change (from the next boot), the boat id
//   restart

RoverConfig activeCfg;  // what this boot is running with
std::string consoleLine;

void consoleHelp() {
  Serial.println("[console] settings | get NAME | set NAME VALUE | unset NAME | boatid [ID] | restart - settings take effect at the next boot");
}

void consoleCommand(const std::string& line) {
  std::vector<std::string> w;
  size_t i = 0;
  while (i < line.size()) {
    while (i < line.size() && line[i] == ' ') i++;
    size_t j = i;
    while (j < line.size() && line[j] != ' ') j++;
    if (j > i) w.push_back(line.substr(i, j - i));
    i = j;
  }
  if (w.empty()) return;
  for (auto& c : w[0]) c = tolower(c);
  if (w.size() > 1)
    for (auto& c : w[1]) c = toupper(c);
  std::map<std::string, std::string> saved = loadSettings();
  RoverConfig next;
  rover::settings::apply(next, settingsSource(saved));
  const auto origin = [&](const std::string& n) { return saved.count(n) ? " (set)" : buildSettings().count(n) ? " (this build)" : ""; };

  if (w[0] == "settings") {
    for (const auto& st : rover::settings::all()) {
      const std::string now = rover::settings::current(activeCfg, st.name), then = rover::settings::current(next, st.name);
      Serial.printf("  %-26s %-8s%s  %s\n", st.name, now.c_str(), then != now ? (" -> " + then + " at the next boot").c_str() : origin(st.name), st.help);
    }
  } else if (w[0] == "get" && w.size() == 2) {
    if (!rover::settings::find(w[1])) return (void)Serial.printf("[console] unknown setting %s\n", w[1].c_str());
    Serial.printf("[console] %s=%s%s\n", w[1].c_str(), rover::settings::current(activeCfg, w[1]).c_str(), *origin(w[1]) ? origin(w[1]) : " (default)");
  } else if (w[0] == "set" && w.size() == 3) {
    std::string err;
    if (!rover::settings::check(w[1], w[2], err)) return (void)Serial.printf("[console] %s\n", err.c_str());
    saved[w[1]] = w[2];
    saveSettings(saved);
    rover::settings::apply(next, settingsSource(saved));
    Serial.printf("[console] %s=%s saved - in effect at the next boot (restart)\n", w[1].c_str(), rover::settings::current(next, w[1]).c_str());
  } else if (w[0] == "unset" && w.size() == 2) {
    if (!saved.erase(w[1])) return (void)Serial.printf("[console] %s is not set\n", w[1].c_str());
    saveSettings(saved);
    Serial.printf("[console] %s back to %s from the next boot (restart)\n", w[1].c_str(), buildSettings().count(w[1]) ? "this build's default" : "its default");
  } else if (w[0] == "boatid" && w.size() == 1) {
    Serial.printf("[console] boat id %s\n", activeCfg.boatId.c_str());
  } else if (w[0] == "boatid" && w.size() == 2) {
    if (!rover::protocol::validBoatId(w[1])) return (void)Serial.printf("[console] a boat id is %u of A-Z and 0-9\n", (unsigned)rover::protocol::BOAT_ID_LEN);
    prefs.putString("boatId", w[1].c_str());
    Serial.printf("[console] boat id %s saved - in effect at the next boot (restart)\n", w[1].c_str());
  } else if (w[0] == "restart") {
    Serial.println("[console] restarting");
    Serial.flush();
    ESP.restart();
  } else {
    consoleHelp();
  }
}

// Echoes what is typed (a serial monitor doesn't, by default) and takes Backspace; CR, LF or CR LF ends a line
void pollConsole() {
  static bool lastCr = false;
  while (Serial.available()) {
    const char c = (char)Serial.read();
    if (c == '\n' && lastCr) {
      lastCr = false;
      continue;
    }
    lastCr = c == '\r';
    if (c == '\r' || c == '\n') {
      Serial.print("\r\n");
      if (!consoleLine.empty()) consoleCommand(consoleLine);
      consoleLine.clear();
    } else if (c == '\b' || c == 0x7f) {
      if (!consoleLine.empty()) {
        consoleLine.pop_back();
        Serial.print("\b \b");
      }
    } else if (c >= ' ' && c < 0x7f && consoleLine.size() < 120) {
      consoleLine += c;
      Serial.print(c);
    }
  }
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(500);
  const esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
  const bool motionWoken = cause == ESP_SLEEP_WAKEUP_EXT0;
  gpio_deep_sleep_hold_dis();
  setenv("TZ", ROVER_TZ, 1);
  tzset();
  prefs.begin("rover", false);

  // supplies on, the radio awake (whatever a deep sleep left the pins at)
  powerPin(GPS_POWER_PIN, true);
  powerPin(RADIO_POWER_PIN, true);
  if (RADIO_SLEEP_PIN >= 0) powerPin(RADIO_SLEEP_PIN, false);
#if defined(I2C_POWER)
  powerPin(I2C_POWER, true);  // the I2C pull-ups (and STEMMA QT)
#elif defined(TFT_I2C_POWER)
  powerPin(TFT_I2C_POWER, true);
#endif
  delay(10);
  Wire.begin();
  if (ACCEL_INT_PIN >= 0) {
    rtc_gpio_deinit((gpio_num_t)ACCEL_INT_PIN);
    accelRead(0x31);  // clear the latched motion that woke us
  }
  batteryOk = battery.begin();
  display::begin(ROVER_VERSION);

  Serial1.setRxBufferSize(4096);  // a NAV-SIG can run to a kilobyte
  Serial1.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Serial2.setRxBufferSize(2048);
  Serial2.setTxBufferSize(512);
  Serial2.begin(RADIO_BAUD, SERIAL_8N1, XBEE_RX_PIN, XBEE_TX_PIN);

  RoverConfig cfg;
  // the settings saved at the console (else this build's defaults), read as config.js reads its environment
  const std::map<std::string, std::string> saved = loadSettings();
  rover::settings::apply(cfg, settingsSource(saved));
  if (!buildSettings().empty()) Serial.printf("[boatAgent] this build's settings: %s (one set at the console wins)\n", ROVER_SETTINGS);
  cfg.boatId = loadBoatId();
  cfg.build = ROVER_BUILD;
  cfg.dirty = ROVER_DIRTY;
  cfg.version = ROVER_VERSION;
  cfg.motionWoken = motionWoken;
  if (GPS_LOG) cfg.gpsLog = true;
  char b[96];
  snprintf(b, sizeof b, "real Serial1@%d (rx %d, tx %d)", GPS_BAUD, GPS_RX_PIN, GPS_TX_PIN);
  cfg.gpsDesc = b;
  snprintf(b, sizeof b, "real Serial2@%d (rx %d, tx %d, SLEEP_RQ %d)", RADIO_BAUD, XBEE_RX_PIN, XBEE_TX_PIN, RADIO_SLEEP_PIN);
  cfg.radioDesc = b;
  cfg.radioPort = "Serial2";
  cfg.xbeeNi = SET_XBEE_NI;

  RoverHal hal;
  hal.radioWrite = radioWrite;
  hal.gpsWrite = gpsWrite;
  hal.canSleep = RADIO_SLEEP_PIN >= 0;
  hal.setRadioSleeping = [](bool sleeping) {
    if (RADIO_SLEEP_PIN >= 0) digitalWrite(RADIO_SLEEP_PIN, sleeping ? HIGH : LOW);
  };
  hal.monoMs = []() { return micros() / 1000.0; };
  hal.wallMs = rtcMs;
  hal.wallClockValid = []() { return rtcClockSet; };
  hal.random = []() { return esp_random() / 4294967296.0; };
  hal.log = [](const std::string& m) { Serial.println(m.c_str()); };
  hal.saveMarks = saveMarks;
  hal.loadMarks = loadMarks;
  hal.clock.toLocal = toLocal;
  hal.clock.fromLocal = fromLocal;
  hal.saveSchedule = saveSchedule;
  hal.loadSchedule = loadSchedule;
  hal.requestDeepSleep = deepSleep;
  // the MAX17048's reading goes to the base in the hello; a gauge that isn't answering reads 0 V or NaN
  hal.readBattery = [](double& pct, double& volts) {
    if (!batteryOk) return false;
    volts = battery.cellVoltage();
    pct = battery.cellPercent();
    return std::isfinite(volts) && std::isfinite(pct) && volts > 0.5;
  };

  activeCfg = cfg;
  theRover = new Rover(cfg, hal);  // logs the startup summary; sends nothing until begin()
  std::string set;
  for (const auto& kv : saved) set += (set.empty() ? "" : " ") + kv.first + "=" + kv.second;
  if (!set.empty()) Serial.printf("[boatAgent] settings saved at the console: %s\n", set.c_str());
  consoleHelp();
  Serial.printf("[power] %s, accelerometer INT on %d\n", motionWoken ? "woken by motion" : cause == ESP_SLEEP_WAKEUP_TIMER ? "woken by the timer" : "power on",
                ACCEL_INT_PIN);
  // before anything is sent: telemetry in AT command mode would be read as commands
  if (SET_XBEE_NI) setNodeIdentifier(cfg.boatId);
  theRover->setGpsPortOpen(true);
  theRover->begin();
  lastNote = motionWoken ? "woken by motion" : cause == ESP_SLEEP_WAKEUP_TIMER ? "woken by schedule" : "";
}

void loop() {
  uint8_t buf[256];
  size_t n;
  while ((n = Serial1.read(buf, min((int)sizeof buf, Serial1.available()))) > 0) theRover->onGpsBytes(buf, n);
  while ((n = Serial2.read(buf, min((int)sizeof buf, Serial2.available()))) > 0) theRover->onRadioBytes(buf, n);
  theRover->tick();
  pollConsole();
  keepRtc();
  // twice a second is plenty for the screen, and keeps the battery's I2C reads and the strings off the fast loop
  static display::Status s;
  static uint32_t statusAt = 0;
  if (statusAt == 0 || millis() - statusAt > 500) {
    statusAt = millis();
    s = status();
  }
  display::update(s);
  if (millis() - lastBatteryAt > 60000) {
    lastBatteryAt = millis();
    logBattery(s);
  }
}
