// The radio frames the rover sends and the ones it reads - a C++ port of the parts of src/protocol.js a rover uses. The wire
// format is protocol.js's: every layout comment there applies here unchanged, and tools/gen_vectors.js checks the two agree.
//
// Sent:  position (0xAA), status hello (0x9D), batch (0xEE), delta batch (0xE7).
// Read:  marks (0xBB), ping (0xCC), power (0x99), slot table (0xA7), RTCM3 (0xD3), power schedule (0xB5, recognised only).
// Every other frame type on the air (other boats' frames) is recognised by radio_scanner.cpp so its bytes never read as noise.
#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "pvt.h"

namespace rover {
namespace protocol {

using Bytes = std::vector<uint8_t>;

constexpr size_t BOAT_ID_LEN = 5;
// boatIdFile.js's ALPHABET: a made-up id is BOAT_ID_LEN of these, and a stored or given one must be too (config.js only checks the
// length of an explicit BOAT_ID; this is the stored-id rule, which is what a boat's own id has to pass)
constexpr const char* BOAT_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
bool validBoatId(const std::string& id);
// random(n) returns a number in [0, n)
std::string makeBoatId(const std::function<uint32_t(uint32_t)>& random);
constexpr size_t FIX_FIELDS_LEN = 19;
constexpr size_t RADIO_MAX_PAYLOAD = 100;

constexpr uint8_t SYNC = 0xaa;
constexpr size_t FRAME_LEN = 1 + BOAT_ID_LEN + FIX_FIELDS_LEN + 1;  // 26

constexpr size_t MARK_COUNT = 8;  // course.js's MARK_NAMES
extern const char* const MARK_NAMES[MARK_COUNT];
constexpr uint8_t MARKS_SYNC = 0xbb;
constexpr size_t REGATTA_NAME_LEN = 16;
constexpr size_t MARKS_FRAME_LEN = 1 + MARK_COUNT * 8 + 4 + 2 + 2 + 1 + REGATTA_NAME_LEN + 1;  // 91

constexpr uint8_t PING_SYNC = 0xcc;
constexpr size_t PING_FRAME_LEN = 6;

constexpr uint8_t POWER_SCHEDULE_SYNC = 0xb5;
constexpr size_t POWER_SCHEDULE_FRAME_LEN = 31;

constexpr uint8_t HELLO_SYNC = 0xdd;
constexpr size_t HELLO_FRAME_LEN = 1 + BOAT_ID_LEN + 1;

constexpr uint8_t STATUS_HELLO_SYNC = 0x9d;
constexpr size_t STATUS_HELLO_FRAME_LEN = 1 + BOAT_ID_LEN + 6 + 1;  // 13
// the same hello with the fuel gauge's reading added (protocol.js's battery hello)
constexpr uint8_t STATUS_HELLO_BATTERY_SYNC = 0x9e;
constexpr size_t STATUS_HELLO_BATTERY_FRAME_LEN = STATUS_HELLO_FRAME_LEN + 2;  // 15
constexpr double BATTERY_V_STEP = 0.02;
constexpr uint8_t NO_PVT = 0xff;

constexpr uint8_t BATCH_SYNC = 0xee;
constexpr size_t BATCH_HEADER_LEN = 1 + 1 + BOAT_ID_LEN;
constexpr size_t MAX_BATCH_COUNT = 4;
inline size_t batchFrameLen(size_t count) { return BATCH_HEADER_LEN + count * FIX_FIELDS_LEN + 1; }

constexpr uint8_t SET_MARK_SYNC = 0xff;
constexpr size_t SET_MARK_FRAME_LEN = 1 + BOAT_ID_LEN + 1 + 1 + 4 + 4 + 1;

constexpr uint8_t MARK_LOG_SYNC = 0x88;
constexpr size_t MARK_LOG_LABEL_LEN = 20;
constexpr size_t MARK_LOG_FRAME_LEN = 1 + BOAT_ID_LEN + MARK_LOG_LABEL_LEN + 1;

constexpr uint8_t DELTA_SYNC = 0xe7;
constexpr size_t DELTA_HEADER_LEN = 1 + 1 + BOAT_ID_LEN;
constexpr size_t DELTA_FIX_LEN = 8;
constexpr size_t MAX_DELTA_COUNT = 8;
inline size_t deltaFrameLen(size_t count) { return DELTA_HEADER_LEN + FIX_FIELDS_LEN + (count - 1) * DELTA_FIX_LEN + 1; }

constexpr uint8_t POWER_SYNC = 0x99;
constexpr size_t POWER_HEADER_LEN = 4;
constexpr size_t MAX_POWER_IDS = 18;
inline size_t powerFrameLen(size_t count) { return POWER_HEADER_LEN + count * BOAT_ID_LEN + 1; }

constexpr uint8_t SLOT_TABLE_SYNC = 0xa7;
constexpr size_t SLOT_TABLE_HEADER_LEN = 6;
constexpr size_t SLOT_TABLE_ENTRY_LEN = BOAT_ID_LEN + 1;
constexpr size_t MAX_SLOT_ENTRIES = 15;
inline size_t slotTableFrameLen(size_t count) { return SLOT_TABLE_HEADER_LEN + count * SLOT_TABLE_ENTRY_LEN + 1; }

constexpr uint8_t RTCM_SYNC = 0xd3;
constexpr size_t RTCM_MAX_PAYLOAD = 300;

// ---- encoding (boat -> base) ----

Bytes encode(const std::string& boatId, const Pvt& pvt);

struct StatusHello {
  std::string boatId;
  uint8_t flags = 0;
  uint8_t power = 0;
  uint8_t numSV = 0;
  bool hasPvt = false;  // false: fixType goes out as NO_PVT
  uint8_t fixType = 0;
  uint8_t carrSoln = 0;
  uint16_t build = 0;
  bool dirty = false;
  bool hasBattery = false;  // true: the battery hello, with the two fields below
  double batteryPct = 0;
  double batteryV = 0;
};
Bytes encodeStatusHello(const StatusHello& d);

Bytes encodeBatch(const std::string& boatId, const std::vector<Pvt>& pvts);

struct Frame {
  Bytes buf;
  size_t count;  // fixes it carries
};
// protocol.js's encodeDeltaFrames: as few frames as possible, a new one wherever a fix's change does not fit; a lone fix
// becomes the plain position frame.
std::vector<Frame> encodeDeltaFrames(const std::string& boatId, const std::vector<Pvt>& pvts);

// ---- decoding (base -> boats) ----

struct Marks {
  LatLon mark[MARK_COUNT];  // in MARK_NAMES order
  bool pinBoundaryEnabled = false;
  uint8_t baseIp[4] = {0, 0, 0, 0};
  uint16_t basePort = 0;
  uint16_t baseAdminPort = 0;
  std::string regattaName;
};
bool decodeMarks(const uint8_t* buf, size_t len, Marks& out);
int markIndex(const char* name);  // -1 if unknown

struct Power {
  bool sleep = false;  // false: wake
  uint8_t sleepS = 0;
  bool all = true;
  std::vector<std::string> boatIds;
};
bool decodePower(const uint8_t* buf, size_t len, Power& out);

struct SlotEntry {
  std::string boatId;
  uint8_t slot;
};
struct SlotTable {
  uint8_t version = 0;
  bool practice = false;
  uint8_t slotCount = 0;
  uint8_t slotWidthMs = 0;
  uint8_t joinSlots = 0;
  std::vector<SlotEntry> entries;
};
bool decodeSlotTable(const uint8_t* buf, size_t len, SlotTable& out);

// protocol.js's decodePowerSchedule: each part only when the base manages it (hasWitty / hasShutdown)
struct PowerSchedule {
  uint32_t stamp = 0;
  bool hasWitty = false;
  uint8_t wittyMode = 0;  // 0 off, 1 daily hours, 2 sunrise to sunset
  bool haltItself = false;
  int startMin = 0, endMin = 0;  // minutes after local midnight (daily)
  double lat = 0, lon = 0;       // sun mode
  int beforeMin = 0, afterMin = 0, days = 0;
  bool hasShutdown = false;
  bool shutdownEnabled = false;
  bool whenIdle = true;
  int shutdownMin = 0;  // minutes after local midnight
  int idleMinutes = 0;
  double speedKn = 0;
};
bool decodePowerSchedule(const uint8_t* buf, size_t len, PowerSchedule& out);

uint32_t crc24q(const uint8_t* buf, size_t end);
struct Rtcm {
  uint16_t type;
  size_t length;  // the whole frame
};
bool decodeRtcm(const uint8_t* buf, size_t len, Rtcm& out);

// The header-only length functions the byte-stream scanner needs (protocol.js's *FrameLenFromHeader): 0 = not enough bytes
// to tell yet, otherwise the full frame length (a small one when the header can't be real, so the decode fails fast).
size_t batchFrameLenFromHeader(const uint8_t* buf, size_t avail);
size_t deltaFrameLenFromHeader(const uint8_t* buf, size_t avail);
size_t powerFrameLenFromHeader(const uint8_t* buf, size_t avail);
size_t slotTableFrameLenFromHeader(const uint8_t* buf, size_t avail);
size_t rtcmFrameLenFromHeader(const uint8_t* buf, size_t avail);

// Checksum-and-shape checks for the frame types a rover hears but does not act on (other boats' frames).
bool validPosition(const uint8_t* buf, size_t len);
bool validPing(const uint8_t* buf, size_t len);
bool validHello(const uint8_t* buf, size_t len);
bool validStatusHello(const uint8_t* buf, size_t len);
bool validBatch(const uint8_t* buf, size_t len);
bool validDelta(const uint8_t* buf, size_t len);
bool validSetMark(const uint8_t* buf, size_t len);
bool validMarkLog(const uint8_t* buf, size_t len);

}  // namespace protocol
}  // namespace rover
