// ESP32-S3 rover: the Arduino glue around lib/rover_core. Wiring (see README.md):
//   ZED-F9P UART1  <-> Serial1 on the Feather's RX/TX pins (UBX at GPS_BAUD)
//   XBee DOUT/DIN  <-> Serial2 on XBEE_RX_PIN/XBEE_TX_PIN (at RADIO_BAUD); the XBee's DOUT also goes to the ZED's UART2 RX for RTCM
//   XBee SLEEP_RQ  <-  RADIO_SLEEP_PIN (high = asleep), with a 10k pull-down so the radio stays awake while the ESP32 boots
// The boat id and the last course marks are kept in NVS (Preferences).

#include <Arduino.h>
#include <Preferences.h>
#include <esp_random.h>

#include "rover.h"

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
#ifndef ROVER_BUILD
#define ROVER_BUILD 0
#endif

using rover::Rover;
using rover::RoverConfig;
using rover::RoverHal;

namespace {

Preferences prefs;
Rover* theRover = nullptr;

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

// The course marks in NVS: the 16 coordinates and the pin boundary flag
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

// Like radioLink.js's _writable: a frame that doesn't fit the UART's transmit buffer is refused, not queued behind a backlog
bool radioWrite(const uint8_t* data, size_t len) {
  if ((size_t)Serial2.availableForWrite() < len) return false;
  return Serial2.write(data, len) == len;
}

bool gpsWrite(const uint8_t* data, size_t len) { return Serial1.write(data, len) == len; }

uint32_t lastStatusAt = 0;
void logStatus() {
  const rover::Pvt* p = theRover->lastPvt();
  Serial.printf("[status] fix=%s sv=%u carr=%u bursts=%s slot=%d sent=%u queued=%u syncErr=%u%s\n",
                p ? (p->gnssFixOk ? "ok" : "none") : "-", p ? p->numSV : 0, p ? p->carrSoln : 0, theRover->burstsHeard() ? "yes" : "no",
                theRover->assignedSlot(), (unsigned)theRover->framesSent(),
                (unsigned)(theRover->scheduler() ? theRover->scheduler()->queued() : 0), (unsigned)theRover->scanner().syncErrors,
                theRover->sleeping() ? " SLEEPING" : "");
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(500);
  prefs.begin("rover", false);

  if (RADIO_SLEEP_PIN >= 0) {
    pinMode(RADIO_SLEEP_PIN, OUTPUT);
    digitalWrite(RADIO_SLEEP_PIN, LOW);  // start awake, whatever the pin was left at
  }

  Serial1.setRxBufferSize(4096);  // a NAV-SIG can run to a kilobyte
  Serial1.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Serial2.setRxBufferSize(2048);
  Serial2.setTxBufferSize(512);
  Serial2.begin(RADIO_BAUD, SERIAL_8N1, XBEE_RX_PIN, XBEE_TX_PIN);

  RoverConfig cfg;
  cfg.boatId = loadBoatId();
  cfg.build = ROVER_BUILD;

  RoverHal hal;
  hal.radioWrite = radioWrite;
  hal.gpsWrite = gpsWrite;
  hal.canSleep = RADIO_SLEEP_PIN >= 0;
  hal.setRadioSleeping = [](bool sleeping) {
    if (RADIO_SLEEP_PIN >= 0) digitalWrite(RADIO_SLEEP_PIN, sleeping ? HIGH : LOW);
  };
  hal.monoMs = []() { return micros() / 1000.0; };
  hal.wallMs = []() { return (int64_t)millis(); };  // no clock until the GPS has UTC - such a fix has no position to send anyway
  hal.random = []() { return esp_random() / 4294967296.0; };
  hal.log = [](const std::string& m) { Serial.println(m.c_str()); };
  hal.saveMarks = saveMarks;
  hal.loadMarks = loadMarks;

  Serial.printf("[rover] boatId=%s gps=Serial1@%d radio=Serial2@%d (rx %d, tx %d) sleepPin=%d\n", cfg.boatId.c_str(), GPS_BAUD, RADIO_BAUD,
                XBEE_RX_PIN, XBEE_TX_PIN, RADIO_SLEEP_PIN);
  theRover = new Rover(cfg, hal);
  theRover->setGpsPortOpen(true);
  theRover->begin();
}

void loop() {
  uint8_t buf[256];
  size_t n;
  while ((n = Serial1.read(buf, min((int)sizeof buf, Serial1.available()))) > 0) theRover->onGpsBytes(buf, n);
  while ((n = Serial2.read(buf, min((int)sizeof buf, Serial2.available()))) > 0) theRover->onRadioBytes(buf, n);
  theRover->tick();
  if (millis() - lastStatusAt > 30000) {
    lastStatusAt = millis();
    logStatus();
  }
}
