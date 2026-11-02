// ESP32-S3 rover: the Arduino glue around lib/rover_core. Wiring (see README.md):
//   ZED-F9P UART1  <-> Serial1 on the Feather's RX/TX pins (UBX at GPS_BAUD)
//   XBee DOUT/DIN  <-> Serial2 on XBEE_RX_PIN/XBEE_TX_PIN (at RADIO_BAUD); the XBee's DOUT also goes to the ZED's UART2 RX for RTCM
//   XBee SLEEP_RQ  <-  RADIO_SLEEP_PIN (high = asleep), with a 10k pull-down so the radio stays awake while the ESP32 boots
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

#include "display.h"
#include "rover.h"
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
#define ROVER_BUILD 0
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

// boatIdFile.js's rule: exactly 5 letters A-Z, made up once and kept
std::string loadBoatId() {
  String id = prefs.getString("boatId", "");
  bool ok = id.length() == rover::protocol::BOAT_ID_LEN;
  for (size_t i = 0; ok && i < id.length(); i++) ok = id[i] >= 'A' && id[i] <= 'Z';
  if (!ok) {
    char b[rover::protocol::BOAT_ID_LEN + 1] = {0};
    for (size_t i = 0; i < rover::protocol::BOAT_ID_LEN; i++) b[i] = 'A' + esp_random() % 26;
    id = b;
    prefs.putString("boatId", id);
    Serial.printf("[rover] new boat id %s\n", id.c_str());
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

uint32_t lastStatusAt = 0;
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
  return s;
}

void logStatus(const display::Status& s) {
  Serial.printf("[status] fix=%s sv=%d carr=%d bursts=%s slot=%d%s battery=%d%% sent=%u syncErr=%u%s\n", s.fix ? "ok" : "none", s.numSV, s.carrSoln,
                s.bursts ? "yes" : "no", s.slot, s.parked ? " parked" : "", s.batteryPct, s.framesSent, (unsigned)theRover->scanner().syncErrors,
                s.sleeping ? " SLEEPING" : "");
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
  display::begin();

  Serial1.setRxBufferSize(4096);  // a NAV-SIG can run to a kilobyte
  Serial1.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Serial2.setRxBufferSize(2048);
  Serial2.setTxBufferSize(512);
  Serial2.begin(RADIO_BAUD, SERIAL_8N1, XBEE_RX_PIN, XBEE_TX_PIN);

  RoverConfig cfg;
  cfg.boatId = loadBoatId();
  cfg.build = ROVER_BUILD;
  cfg.motionWoken = motionWoken;

  Serial.printf("[rover] boatId=%s gps=Serial1@%d radio=Serial2@%d (rx %d, tx %d) sleepPin=%d accelInt=%d wake=%s\n", cfg.boatId.c_str(), GPS_BAUD,
                RADIO_BAUD, XBEE_RX_PIN, XBEE_TX_PIN, RADIO_SLEEP_PIN, ACCEL_INT_PIN,
                motionWoken ? "motion" : cause == ESP_SLEEP_WAKEUP_TIMER ? "timer" : "power on");
  if (SET_XBEE_NI) setNodeIdentifier(cfg.boatId);  // before anything is sent: telemetry in AT command mode would be read as commands

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

  theRover = new Rover(cfg, hal);
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
  keepRtc();
  const display::Status s = status();
  display::update(s);
  if (millis() - lastStatusAt > 30000) {
    lastStatusAt = millis();
    logStatus(s);
  }
}
