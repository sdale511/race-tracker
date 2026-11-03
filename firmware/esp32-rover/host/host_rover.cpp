// The rover on a Mac (any POSIX machine): lib/rover_core - the same code the ESP32 runs - with a real XBee and ZED-F9P on USB serial, or
// on the SIMULATE=1 base's UDP "radio" with tools/sim_gps.js as the GPS. See README.md ("Running it on a Mac"). Stands in for src/main.cpp:
//   the radio      --radio /dev/cu.usbserial-X[@baud]  or  --radio udp[:port] (SimRadioLink's broadcast port, 41234)
//   the GPS        --gps /dev/cu.usbmodem-X[@baud]     or  --gps - (UBX on stdin)  or  --gps none
//   NVS            files in --state (the boat id, the last course marks, the base's last power schedule)
//   deep sleep     emulated: the radio and GPS are ignored until the wake time, or a SIGUSR1 (the accelerometer), then a fresh boot
//   a status page  http://localhost:8095 (--ui-port): the rover's settings and live state, refreshed every second
// The ESP32-only parts - SLEEP_RQ, the accelerometer, the battery chip, the screen - aren't here.

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#include <cerrno>
#include <climits>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <random>
#include <sstream>
#include <string>

#include "rover.h"
#include "status_page.h"
#include "xbee_at.h"

#ifndef ROVER_VERSION
#define ROVER_VERSION "unknown"  // tools/version.py sets these from git
#endif
#ifndef ROVER_BUILD
#define ROVER_BUILD 0
#endif
#ifndef ROVER_DIRTY
#define ROVER_DIRTY 0
#endif
#ifndef ROVER_REPO_DIR
#define ROVER_REPO_DIR "."  // the checkout this was built from, for race-config/boat_id.txt
#endif

using rover::Rover;
using rover::RoverConfig;
using rover::RoverHal;

namespace {

// ---- options ----

struct Options {
  std::string radio = "udp";
  std::string gps = "-";
  std::string boatId;
  std::string stateDir;
  bool rtcmForward = false;
  bool setNi = false;
  bool gpsSleepForceUsb = false;
  bool gpsLog = false;
  int uiPort = 8095;
};

void usage() {
  std::fprintf(stderr,
               "usage: host_rover [options]\n"
               "  --radio udp[:PORT] | DEVICE[@BAUD]  the SIMULATE=1 base's UDP port (41234), or the XBee's serial port (115200)\n"
               "  --gps - | none | DEVICE[@BAUD]      UBX on stdin (tools/sim_gps.js), no GPS, or the ZED-F9P's serial port (115200)\n"
               "  --boat-id ABCDE                     the boat id (default: BOAT_ID, else race-config/boat_id.txt - the Node rover's)\n"
               "  --state DIR                         where the marks and schedule are kept (default ~/.esp32-rover-host); a second\n                                      rover: its boat id is kept there too, so it is another boat\n"
               "  --rtcm-forward                      write the RTCM the radio hears to the GPS (an XBee on its own USB adapter)\n"
               "  --set-ni                            set the XBee's node identifier to the boat id at boot (writes the XBee's config)\n"
               "  --gps-sleep-force-usb               let the ZED go into backup with its USB connected (disables its USB until a power cycle)\n"
               "  --gps-log                           a console line for every fix (the Node rover's GPS_LOG=1)\n"
               "  --ui-port N                         the status page's port (8095; 0 = none)\n"
               "  kill -USR1 <pid> wakes an emulated deep sleep, as the accelerometer would\n");
}

bool parseArgs(int argc, char** argv, Options& o) {
  for (int i = 1; i < argc; i++) {
    const std::string a = argv[i];
    auto value = [&](std::string& out) {
      if (i + 1 >= argc) return false;
      out = argv[++i];
      return true;
    };
    std::string v;
    if (a == "--radio" && value(o.radio)) continue;
    if (a == "--gps" && value(o.gps)) continue;
    if (a == "--boat-id" && value(o.boatId)) continue;
    if (a == "--state" && value(o.stateDir)) continue;
    if (a == "--ui-port" && value(v)) {
      o.uiPort = std::atoi(v.c_str());
      continue;
    }
    if (a == "--rtcm-forward") o.rtcmForward = true;
    else if (a == "--gps-log") o.gpsLog = true;
    else if (a == "--set-ni") o.setNi = true;
    else if (a == "--gps-sleep-force-usb") o.gpsSleepForceUsb = true;
    else return false;
  }
  return true;
}

// ---- time and logging ----

double monoMs() {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

int64_t wallMs() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

void log(const std::string& m) {
  const int64_t now = wallMs();
  const time_t t = (time_t)(now / 1000);
  struct tm tm;
  localtime_r(&t, &tm);
  std::printf("%02d:%02d:%02d.%03d %s\n", tm.tm_hour, tm.tm_min, tm.tm_sec, (int)(now % 1000), m.c_str());
  std::fflush(stdout);
}

std::string fmt(const char* f, ...) __attribute__((format(printf, 1, 2)));
std::string fmt(const char* f, ...) {
  char b[512];
  va_list ap;
  va_start(ap, f);
  std::vsnprintf(b, sizeof b, f, ap);
  va_end(ap);
  return b;
}

// main.cpp's, with the Mac's own TZ (set TZ=... to run as a boat elsewhere)
rover::LocalDate toLocal(int64_t ms) {
  const time_t t = (time_t)(ms / 1000);
  struct tm tm;
  localtime_r(&t, &tm);
  return {tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour * 60 + tm.tm_min};
}

int64_t fromLocal(int year, int month, int day, int minutes) {
  struct tm tm = {};
  tm.tm_year = year - 1900;
  tm.tm_mon = month - 1;
  tm.tm_mday = day;
  tm.tm_hour = minutes / 60;
  tm.tm_min = minutes % 60;
  tm.tm_isdst = -1;
  return (int64_t)mktime(&tm) * 1000;
}

std::mt19937_64 rng{std::random_device{}()};
double random01() { return std::uniform_real_distribution<double>(0, 1)(rng); }

// ---- ports ----

struct Port {
  enum Kind { NONE, SERIAL, UDP, STDIN } kind = NONE;
  int fd = -1;
  uint16_t udpPort = 0;
  std::string name;
};

int openSerial(const std::string& path, int baud) {
  const int fd = open(path.c_str(), O_RDWR | O_NOCTTY | O_NONBLOCK);
  if (fd < 0) return -1;
  struct termios t;
  if (tcgetattr(fd, &t) != 0) {
    close(fd);
    return -1;
  }
  cfmakeraw(&t);
  t.c_cflag |= CLOCAL | CREAD;
  t.c_cflag &= ~(CRTSCTS | CSTOPB);
  cfsetspeed(&t, (speed_t)baud);  // macOS takes the baud itself
  if (tcsetattr(fd, TCSANOW, &t) != 0) {
    close(fd);
    return -1;
  }
  tcflush(fd, TCIOFLUSH);
  return fd;
}

// SimRadioLink's socket: every node binds the same port (SO_REUSEPORT, as libuv's reuseAddr does on macOS) and broadcasts to it
int openUdp(uint16_t port) {
  const int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) return -1;
  const int on = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof on);
  setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &on, sizeof on);
  setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &on, sizeof on);
  struct sockaddr_in a = {};
  a.sin_family = AF_INET;
  a.sin_port = htons(port);
  a.sin_addr.s_addr = htonl(INADDR_ANY);
  if (bind(fd, (struct sockaddr*)&a, sizeof a) != 0) {
    close(fd);
    return -1;
  }
  fcntl(fd, F_SETFL, O_NONBLOCK);
  return fd;
}

// "udp", "udp:PORT", "-", "none" or "DEVICE[@BAUD]"
bool openPort(const std::string& spec, Port& p) {
  p.name = spec;
  if (spec == "none") return true;
  if (spec == "-") {
    p.kind = Port::STDIN;
    p.fd = STDIN_FILENO;
    fcntl(p.fd, F_SETFL, fcntl(p.fd, F_GETFL) | O_NONBLOCK);
    return true;
  }
  if (spec.rfind("udp", 0) == 0) {
    p.kind = Port::UDP;
    p.udpPort = spec.size() > 4 ? (uint16_t)std::atoi(spec.c_str() + 4) : 41234;
    p.fd = openUdp(p.udpPort);
    return p.fd >= 0;
  }
  const size_t at = spec.find('@');
  const int baud = at == std::string::npos ? 115200 : std::atoi(spec.c_str() + at + 1);
  p.kind = Port::SERIAL;
  p.fd = openSerial(spec.substr(0, at), baud);
  return p.fd >= 0;
}

// > 0 bytes read, 0 nothing waiting, -1 closed
ssize_t readPort(const Port& p, uint8_t* buf, size_t cap) {
  if (p.fd < 0) return 0;
  const ssize_t n = p.kind == Port::UDP ? recv(p.fd, buf, cap, 0) : read(p.fd, buf, cap);
  if (n > 0) return n;
  if (n == 0 && p.kind != Port::UDP) return -1;
  if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) return -1;
  return 0;
}

// Like radioLink.js's _writable: a frame the port won't take whole is refused, not queued
bool writePort(const Port& p, const uint8_t* data, size_t len) {
  if (p.fd < 0 || p.kind == Port::STDIN) return p.kind == Port::STDIN;  // stdin GPS: polls and sleep commands go nowhere
  if (p.kind == Port::UDP) {
    struct sockaddr_in a = {};
    a.sin_family = AF_INET;
    a.sin_port = htons(p.udpPort);
    a.sin_addr.s_addr = htonl(INADDR_BROADCAST);
    return sendto(p.fd, data, len, 0, (struct sockaddr*)&a, sizeof a) == (ssize_t)len;
  }
  return write(p.fd, data, len) == (ssize_t)len;
}

// ---- the state dir (main.cpp's NVS) ----

std::string stateDir;

std::string statePath(const char* name) { return stateDir + "/" + name; }

bool readFile(const char* name, std::string& out) {
  std::ifstream f(statePath(name), std::ios::binary);
  if (!f) return false;
  std::stringstream ss;
  ss << f.rdbuf();
  out = ss.str();
  return true;
}

void writeFile(const char* name, const void* data, size_t len) {
  std::ofstream f(statePath(name), std::ios::binary | std::ios::trunc);
  f.write((const char*)data, (std::streamsize)len);
}

using rover::protocol::validBoatId;

// boatIdFile.js's getOrCreatePersistentBoatId, on the same file the Node rover uses (race-config/boat_id.txt), so the C++ and Node
// rovers on this Mac are the same boat. With --state the id is that state dir's own (a second rover is another boat).
std::string loadBoatId(const std::string& path) {
  std::string id;
  {
    std::ifstream f(path, std::ios::binary);
    if (f) std::getline(f, id);
  }
  while (!id.empty() && (id.back() == '\n' || id.back() == '\r' || id.back() == ' ')) id.pop_back();
  if (validBoatId(id)) return id;
  if (!id.empty()) log("[boatIdFile] " + path + " contains an invalid boat id - generating a fresh one");
  id = rover::protocol::makeBoatId([](uint32_t n) { return (uint32_t)(rng() % n); });
  std::ofstream f(path, std::ios::binary | std::ios::trunc);
  f << id;
  if (!f) log("[boatIdFile] failed to persist generated boat id to " + path);
  else log("[boatAgent] new boat id " + id + " (kept in " + path + ")");
  return id;
}

struct StoredMarks {
  double latLon[rover::protocol::MARK_COUNT * 2];
  uint8_t pinBoundary;
};

void saveMarks(const rover::protocol::Marks& m) {
  StoredMarks s = {};
  for (size_t i = 0; i < rover::protocol::MARK_COUNT; i++) {
    s.latLon[i * 2] = m.mark[i].lat;
    s.latLon[i * 2 + 1] = m.mark[i].lon;
  }
  s.pinBoundary = m.pinBoundaryEnabled;
  writeFile("marks.bin", &s, sizeof s);
}

bool loadMarks(rover::protocol::Marks& m) {
  std::string b;
  if (!readFile("marks.bin", b) || b.size() != sizeof(StoredMarks)) return false;
  StoredMarks s;
  std::memcpy(&s, b.data(), sizeof s);
  for (size_t i = 0; i < rover::protocol::MARK_COUNT; i++) m.mark[i] = {s.latLon[i * 2], s.latLon[i * 2 + 1]};
  m.pinBoundaryEnabled = s.pinBoundary;
  return true;
}

void saveSchedule(const rover::protocol::PowerSchedule& s) { writeFile("schedule.bin", &s, sizeof s); }
bool loadSchedule(rover::protocol::PowerSchedule& s) {
  std::string b;
  if (!readFile("schedule.bin", b) || b.size() != sizeof s) return false;
  std::memcpy(&s, b.data(), sizeof s);
  return true;
}

// ---- the rover ----

Options opts;
Port radio, gps;
Rover* theRover = nullptr;
bool radioAsleep = false;  // the UDP radio's stand-in for SLEEP_RQ, as SimRadioLink's setSleeping
bool deepAsleep = false;
int64_t wakeAt = INT64_MAX;
volatile sig_atomic_t motion = 0;
volatile sig_atomic_t stopping = 0;
StatusPage page;

void setNodeIdentifier(const std::string& boatId) {
  rover::xbee::Io io;
  io.write = [](const std::string& s) { writePort(radio, (const uint8_t*)s.data(), s.size()); };
  io.read = [](std::string& buf, unsigned timeoutMs) {
    struct pollfd pfd = {radio.fd, POLLIN, 0};
    if (poll(&pfd, 1, (int)timeoutMs) <= 0) return false;
    uint8_t b[256];
    ssize_t n;
    while ((n = readPort(radio, b, sizeof b)) > 0) buf.append((const char*)b, (size_t)n);
    return true;
  };
  io.sleep = [](unsigned ms) { usleep(ms * 1000); };
  const auto r = rover::xbee::setNodeIdentifier(io, boatId);
  if (!r.ok) log("[radio] could not set the xbee node identifier (NI) to \"" + boatId + "\": " + r.error + " - carrying on");
  else if (r.changed) log("[radio] xbee node identifier (NI) set to \"" + boatId + "\" (was \"" + r.previous + "\") and saved");
  else log("[radio] xbee node identifier (NI) already \"" + boatId + "\"");
}

void deepSleep(const rover::PowerPolicy::Decision& d) {
  log("[power] deep sleep (" + d.reason + ")" + (d.hasWakeAt ? "" : " until motion"));
  if (d.hasWakeAt) {
    const time_t t = (time_t)(d.wakeAt / 1000);
    char b[64];
    strftime(b, sizeof b, "%Y-%m-%d %H:%M:%S", localtime(&t));
    log(fmt("[power] (emulated) waking at %s, or on kill -USR1 %d", b, (int)getpid()));
  } else {
    log(fmt("[power] (emulated) waking on kill -USR1 %d", (int)getpid()));
  }
  deepAsleep = true;
  wakeAt = d.hasWakeAt ? d.wakeAt : INT64_MAX;
}

void boot(bool motionWoken) {
  delete theRover;
  radioAsleep = false;
  RoverConfig cfg;
  cfg.boatId = opts.boatId;
  cfg.motionWoken = motionWoken;
  cfg.rtcmForward = opts.rtcmForward;
  cfg.gpsSleepForceUsb = opts.gpsSleepForceUsb;
  cfg.gpsLog = opts.gpsLog;
  cfg.version = ROVER_VERSION;
  cfg.build = ROVER_BUILD;
  cfg.dirty = ROVER_DIRTY;
  auto desc = [](const Port& p) {
    return p.kind == Port::UDP     ? fmt("simulated udp:%u", p.udpPort)
           : p.kind == Port::STDIN ? std::string("simulated (UBX on stdin)")
           : p.kind == Port::NONE  ? std::string("none")
                                   : "real " + p.name + (p.name.find('@') == std::string::npos ? "@115200" : "");
  };
  cfg.gpsDesc = desc(gps);
  cfg.radioDesc = desc(radio);
  cfg.radioPort = radio.name;
  cfg.xbeeNi = opts.setNi && radio.kind == Port::SERIAL;

  RoverHal hal;
  hal.radioWrite = [](const uint8_t* d, size_t n) { return !radioAsleep && writePort(radio, d, n); };
  hal.gpsWrite = [](const uint8_t* d, size_t n) { return writePort(gps, d, n); };
  hal.canSleep = radio.kind == Port::UDP;  // a USB XBee has no SLEEP_RQ wired
  hal.setRadioSleeping = [](bool sleeping) { radioAsleep = sleeping; };
  hal.monoMs = monoMs;
  hal.wallMs = wallMs;
  hal.wallClockValid = []() { return true; };  // the Mac's clock is NTP-set
  hal.random = random01;
  hal.log = log;
  hal.saveMarks = saveMarks;
  hal.loadMarks = loadMarks;
  hal.clock.toLocal = toLocal;
  hal.clock.fromLocal = fromLocal;
  hal.saveSchedule = saveSchedule;
  hal.loadSchedule = loadSchedule;
  hal.requestDeepSleep = deepSleep;

  theRover = new Rover(cfg, hal);  // logs the startup summary; sends nothing until begin()
  log(fmt("[boatAgent] state=%s wake=%s%s", stateDir.c_str(), motionWoken ? "motion" : "power on",
          opts.uiPort > 0 ? fmt(" status page=http://localhost:%d", opts.uiPort).c_str() : ""));
  if (cfg.xbeeNi) setNodeIdentifier(cfg.boatId);  // before anything is sent
  theRover->setGpsPortOpen(gps.kind != Port::NONE);
  theRover->begin();
}

}  // namespace

int main(int argc, char** argv) {
  if (!parseArgs(argc, argv, opts)) {
    usage();
    return 2;
  }
  signal(SIGPIPE, SIG_IGN);
  signal(SIGUSR1, [](int) { motion = 1; });
  signal(SIGINT, [](int) { stopping = 1; });
  signal(SIGTERM, [](int) { stopping = 1; });

  const char* home = std::getenv("HOME");
  stateDir = !opts.stateDir.empty() ? opts.stateDir : std::string(home ? home : ".") + "/.esp32-rover-host";
  mkdir(stateDir.c_str(), 0755);
  // config.js's order: an explicit id (--boat-id, then BOAT_ID), else the stored one
  const char* envId = std::getenv("BOAT_ID");
  if (opts.boatId.empty() && envId && *envId) opts.boatId = envId;
  if (opts.boatId.empty()) {
    const std::string raceConfig = std::string(ROVER_REPO_DIR) + "/race-config";
    if (opts.stateDir.empty()) mkdir(raceConfig.c_str(), 0755);
    opts.boatId = loadBoatId(opts.stateDir.empty() ? raceConfig + "/boat_id.txt" : statePath("boat_id"));
  } else if (!validBoatId(opts.boatId)) {
    std::fprintf(stderr, "the boat id must be %zu of A-Z and 0-9 (got \"%s\")\n", rover::protocol::BOAT_ID_LEN, opts.boatId.c_str());
    return 2;
  }

  if (!openPort(opts.radio, radio)) {
    std::fprintf(stderr, "could not open the radio %s: %s\n", opts.radio.c_str(), std::strerror(errno));
    return 1;
  }
  if (!openPort(opts.gps, gps)) {
    std::fprintf(stderr, "could not open the GPS %s: %s\n", opts.gps.c_str(), std::strerror(errno));
    return 1;
  }

  boot(false);
  if (opts.uiPort > 0 && !page.listen((uint16_t)opts.uiPort))
    log(fmt("[boatAgent] status page: could not listen on port %d (%s) - carrying on without it", opts.uiPort, std::strerror(errno)));
  uint8_t buf[2048];
  for (;;) {
    if (stopping) {
      const std::string st = theRover->txgateStats();
      if (!st.empty()) log(st);
      log("[boatAgent] shutting down");
      return 0;
    }
    struct pollfd pfd[3];
    nfds_t n = 0;
    if (radio.fd >= 0) pfd[n++] = {radio.fd, POLLIN, 0};
    if (gps.fd >= 0) pfd[n++] = {gps.fd, POLLIN, 0};
    if (page.fd() >= 0) pfd[n++] = {page.fd(), POLLIN, 0};
    poll(pfd, n, 5);
    page.serve([]() {
      StatusPage::Snapshot s;
      s.title = "rover " + opts.boatId;
      s.subtitle = std::string("race-tracker ") + ROVER_VERSION + (deepAsleep ? " - in (emulated) deep sleep" : "");
      s.config = theRover->configItems();
      s.config.insert(s.config.begin(), {{"boatId", opts.boatId}, {"gps", gps.name}, {"radio", radio.name}, {"state", stateDir}});
      s.status = theRover->statusItems();
      const Rover::BaseData b = theRover->baseData();
      s.ready = b.ready;
      s.missing = b.missing;
      s.base = b.items;
      return s;
    });

    // the UDP radio delivers a datagram per read, which is one frame - as SimRadioLink hears it
    ssize_t got;
    while ((got = readPort(radio, buf, sizeof buf)) > 0)
      if (!deepAsleep && !radioAsleep) theRover->onRadioBytes(buf, (size_t)got);
    if (got < 0) {
      log("[radio] " + radio.name + " closed - exiting");
      return 1;
    }
    while ((got = readPort(gps, buf, sizeof buf)) > 0)
      if (!deepAsleep) theRover->onGpsBytes(buf, (size_t)got);
    if (got < 0) {
      log("[gps] " + gps.name + " closed - exiting");
      return 0;
    }

    if (deepAsleep) {
      if (!motion && wallMs() < wakeAt) continue;
      log(motion ? "[power] (emulated) woken by motion" : "[power] (emulated) woken by the timer");
      deepAsleep = false;
      boot(motion);
      motion = 0;
    }
    motion = 0;
    theRover->tick();
  }
}
