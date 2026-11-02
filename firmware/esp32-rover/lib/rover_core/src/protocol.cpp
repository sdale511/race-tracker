#include "protocol.h"

#include <cmath>
#include <cstring>

#include "js_math.h"

namespace rover {
namespace protocol {

const char* const MARK_NAMES[MARK_COUNT] = {"windwardGreen", "windwardBlack", "leewardGreen", "leewardBlack",
                                            "pin",           "committeeStart", "committeeFinish", "finish"};

namespace {

void putU16(uint8_t* p, uint32_t v) {
  p[0] = v & 0xff;
  p[1] = (v >> 8) & 0xff;
}
void putU32(uint8_t* p, uint32_t v) {
  p[0] = v & 0xff;
  p[1] = (v >> 8) & 0xff;
  p[2] = (v >> 16) & 0xff;
  p[3] = (v >> 24) & 0xff;
}
uint16_t getU16(const uint8_t* p) { return p[0] | (p[1] << 8); }
uint32_t getU32(const uint8_t* p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }
int32_t getI32(const uint8_t* p) { return (int32_t)getU32(p); }

void putBoatId(uint8_t* p, const std::string& boatId) {
  for (size_t i = 0; i < BOAT_ID_LEN; i++) p[i] = i < boatId.size() ? (uint8_t)boatId[i] : 0;
}

// sum of bytes [1, end) mod 256 - every frame's checksum
uint8_t sumFrom1(const uint8_t* buf, size_t end) {
  uint32_t sum = 0;
  for (size_t i = 1; i < end; i++) sum += buf[i];
  return sum & 0xff;
}
void seal(Bytes& buf) { buf.back() = sumFrom1(buf.data(), buf.size() - 1); }
bool sumOk(const uint8_t* buf, size_t len) { return sumFrom1(buf, len - 1) == buf[len - 1]; }

uint8_t statusByte(const Pvt& p) {
  return (p.gnssFixOk ? 1 : 0) | ((p.carrSoln & 0x03) << 1) | (((p.numSV > 31 ? 31 : p.numSV) & 0x1f) << 3);
}

uint16_t speedField(const Pvt& p) {
  const double v = jsRound(speedKnots(p) * 10);
  return v < 0 ? 0 : (v > 65535 ? 65535 : (uint16_t)v);
}

uint16_t headingField(const Pvt& p) {
  const double heading = std::fmod(std::fmod(p.headMotDeg, 360) + 360, 360);
  return (uint16_t)jsRound(heading * 10);
}

void writeFixFields(uint8_t* o, const Pvt& p) {
  // timestamps are always positive, so integer division and % match Math.floor and JS %
  putU32(o, (uint32_t)(p.timestamp / 1000));
  putU16(o + 4, (uint32_t)(p.timestamp % 1000));
  putU32(o + 6, (uint32_t)(int32_t)jsRound(p.lat * 1e7));
  putU32(o + 10, (uint32_t)(int32_t)jsRound(p.lon * 1e7));
  putU16(o + 14, speedField(p));
  putU16(o + 16, headingField(p));
  o[18] = statusByte(p);
}

// protocol.js's fixInts / deltaOf / applyDelta
struct FixInts {
  int64_t ts;
  int32_t lat, lon;
  int32_t speed, heading;
  uint8_t status;
};
FixInts fixInts(const Pvt& p) {
  return {p.timestamp, (int32_t)jsRound(p.lat * 1e7), (int32_t)jsRound(p.lon * 1e7), speedField(p), headingField(p), statusByte(p)};
}
struct Delta {
  int dt, dlat, dlon, dspeed, dheading;
  uint8_t status;
};
bool deltaOf(const FixInts& prev, const FixInts& next, Delta& d) {
  d.dt = (int)jsRound((double)(next.ts - prev.ts) / 2);
  const int64_t dlat = (int64_t)next.lat - prev.lat;
  const int64_t dlon = (int64_t)next.lon - prev.lon;
  d.dspeed = (int)jsRound((double)(next.speed - prev.speed) / 5);
  const int diff = ((((next.heading - prev.heading) % 3600) + 5400) % 3600) - 1800;
  d.dheading = (int)jsRound((double)diff / 20);
  if (d.dt < 0 || d.dt > 255) return false;
  if (dlat < -32768 || dlat > 32767 || dlon < -32768 || dlon > 32767) return false;
  if (d.dspeed < -128 || d.dspeed > 127) return false;
  if (d.dheading < -128 || d.dheading > 127) return false;
  d.dlat = (int)dlat;
  d.dlon = (int)dlon;
  d.status = next.status;
  return true;
}
FixInts applyDelta(const FixInts& prev, const Delta& d) {
  int32_t speed = prev.speed + d.dspeed * 5;
  speed = speed < 0 ? 0 : (speed > 65535 ? 65535 : speed);
  return {prev.ts + d.dt * 2, prev.lat + d.dlat, prev.lon + d.dlon, speed, (((prev.heading + d.dheading * 20) % 3600) + 3600) % 3600, d.status};
}

}  // namespace

Bytes encode(const std::string& boatId, const Pvt& pvt) {
  Bytes buf(FRAME_LEN, 0);
  buf[0] = SYNC;
  putBoatId(&buf[1], boatId);
  writeFixFields(&buf[1 + BOAT_ID_LEN], pvt);
  seal(buf);
  return buf;
}

Bytes encodeStatusHello(const StatusHello& d) {
  Bytes buf(STATUS_HELLO_FRAME_LEN, 0);
  size_t o = 0;
  buf[o++] = STATUS_HELLO_SYNC;
  putBoatId(&buf[o], d.boatId);
  o += BOAT_ID_LEN;
  buf[o++] = d.flags;
  buf[o++] = d.power;
  buf[o++] = d.numSV;
  buf[o++] = d.hasPvt ? ((d.fixType & 0x0f) | ((d.carrSoln & 0x0f) << 4)) : NO_PVT;
  putU16(&buf[o], ((d.build > 0x7fff ? 0x7fff : d.build) | (d.dirty ? 0x8000 : 0)) & 0xffff);
  seal(buf);
  return buf;
}

Bytes encodeBatch(const std::string& boatId, const std::vector<Pvt>& pvts) {
  const size_t len = batchFrameLen(pvts.size());
  Bytes buf(len, 0);
  buf[0] = BATCH_SYNC;
  buf[1] = (uint8_t)pvts.size();
  putBoatId(&buf[2], boatId);
  size_t offset = BATCH_HEADER_LEN;
  for (const Pvt& p : pvts) {
    writeFixFields(&buf[offset], p);
    offset += FIX_FIELDS_LEN;
  }
  seal(buf);
  return buf;
}

std::vector<Frame> encodeDeltaFrames(const std::string& boatId, const std::vector<Pvt>& pvts) {
  std::vector<Frame> out;
  size_t i = 0;
  while (i < pvts.size()) {
    const Pvt& first = pvts[i];
    std::vector<Delta> deltas;
    FixInts prev = fixInts(first);
    size_t j = i + 1;
    while (j < pvts.size() && deltas.size() < MAX_DELTA_COUNT - 1) {
      Delta d;
      if (!deltaOf(prev, fixInts(pvts[j]), d)) break;
      deltas.push_back(d);
      prev = applyDelta(prev, d);
      j++;
    }
    const size_t count = 1 + deltas.size();
    if (count == 1) {
      out.push_back({encode(boatId, first), 1});
    } else {
      const size_t len = deltaFrameLen(count);
      Bytes buf(len, 0);
      buf[0] = DELTA_SYNC;
      buf[1] = (uint8_t)count;
      putBoatId(&buf[2], boatId);
      writeFixFields(&buf[DELTA_HEADER_LEN], first);
      size_t offset = DELTA_HEADER_LEN + FIX_FIELDS_LEN;
      for (const Delta& d : deltas) {
        buf[offset] = (uint8_t)d.dt;
        putU16(&buf[offset + 1], (uint16_t)(int16_t)d.dlat);
        putU16(&buf[offset + 3], (uint16_t)(int16_t)d.dlon);
        buf[offset + 5] = (uint8_t)(int8_t)d.dspeed;
        buf[offset + 6] = (uint8_t)(int8_t)d.dheading;
        buf[offset + 7] = d.status;
        offset += DELTA_FIX_LEN;
      }
      seal(buf);
      out.push_back({std::move(buf), count});
    }
    i += count;
  }
  return out;
}

int markIndex(const char* name) {
  for (size_t i = 0; i < MARK_COUNT; i++)
    if (std::strcmp(MARK_NAMES[i], name) == 0) return (int)i;
  return -1;
}

bool decodeMarks(const uint8_t* buf, size_t len, Marks& out) {
  if (len != MARKS_FRAME_LEN || buf[0] != MARKS_SYNC || !sumOk(buf, len)) return false;
  size_t o = 1;
  for (size_t i = 0; i < MARK_COUNT; i++) {
    out.mark[i].lat = getI32(buf + o) / 1e7;
    out.mark[i].lon = getI32(buf + o + 4) / 1e7;
    o += 8;
  }
  for (int i = 0; i < 4; i++) out.baseIp[i] = buf[o + i];
  o += 4;
  out.basePort = getU16(buf + o);
  o += 2;
  out.baseAdminPort = getU16(buf + o);
  o += 2;
  out.pinBoundaryEnabled = buf[o] == 1;
  o += 1;
  out.regattaName.clear();
  for (size_t i = 0; i < REGATTA_NAME_LEN && buf[o + i] != 0; i++) out.regattaName += (char)buf[o + i];
  return true;
}

bool decodePower(const uint8_t* buf, size_t len, Power& out) {
  if (len < POWER_HEADER_LEN + 1 || buf[0] != POWER_SYNC) return false;
  if (buf[1] != 1 && buf[1] != 2) return false;
  const size_t count = buf[3];
  if (count > MAX_POWER_IDS || len != powerFrameLen(count) || !sumOk(buf, len)) return false;
  out.sleep = buf[1] == 1;
  out.sleepS = buf[2];
  out.all = count == 0;
  out.boatIds.clear();
  for (size_t i = 0; i < count; i++) out.boatIds.emplace_back((const char*)buf + POWER_HEADER_LEN + i * BOAT_ID_LEN, BOAT_ID_LEN);
  return true;
}

bool decodeSlotTable(const uint8_t* buf, size_t len, SlotTable& out) {
  if (len < SLOT_TABLE_HEADER_LEN + 1 || buf[0] != SLOT_TABLE_SYNC) return false;
  const size_t count = buf[5];
  if (count > MAX_SLOT_ENTRIES || len != slotTableFrameLen(count) || !sumOk(buf, len)) return false;
  const uint8_t slotCount = buf[2], slotWidthMs = buf[3], joinSlots = buf[4];
  if (slotCount < 1 || slotWidthMs < 1 || joinSlots >= slotCount) return false;
  const uint8_t assignable = slotCount - joinSlots;
  std::vector<SlotEntry> entries;
  for (size_t i = 0; i < count; i++) {
    const uint8_t* at = buf + SLOT_TABLE_HEADER_LEN + i * SLOT_TABLE_ENTRY_LEN;
    const uint8_t slot = at[BOAT_ID_LEN];
    if (slot >= assignable) return false;
    entries.push_back({std::string((const char*)at, BOAT_ID_LEN), slot});
  }
  out.version = buf[1] & 0x7f;
  out.practice = (buf[1] & 0x80) != 0;
  out.slotCount = slotCount;
  out.slotWidthMs = slotWidthMs;
  out.joinSlots = joinSlots;
  out.entries = std::move(entries);
  return true;
}

bool decodePowerSchedule(const uint8_t* buf, size_t len, PowerScheduleStamp& out) {
  if (len != POWER_SCHEDULE_FRAME_LEN || buf[0] != POWER_SCHEDULE_SYNC || !sumOk(buf, len)) return false;
  if ((buf[2] & 0x03) == 3) return false;  // not one of WITTY_MODES
  out.managed = buf[1];
  out.stamp = getU32(buf + 4);
  return true;
}

uint32_t crc24q(const uint8_t* buf, size_t end) {
  uint32_t crc = 0;
  for (size_t i = 0; i < end; i++) {
    crc ^= (uint32_t)buf[i] << 16;
    for (int b = 0; b < 8; b++) {
      crc <<= 1;
      if (crc & 0x1000000) crc ^= 0x1864cfb;
    }
  }
  return crc & 0xffffff;
}

bool decodeRtcm(const uint8_t* buf, size_t len, Rtcm& out) {
  if (len < 8 || buf[0] != RTCM_SYNC || rtcmFrameLenFromHeader(buf, len) != len) return false;
  const size_t end = len - 3;
  const uint32_t crc = ((uint32_t)buf[end] << 16) | (buf[end + 1] << 8) | buf[end + 2];
  if (crc24q(buf, end) != crc) return false;
  out.type = (buf[3] << 4) | (buf[4] >> 4);
  out.length = len;
  return true;
}

size_t batchFrameLenFromHeader(const uint8_t* buf, size_t avail) {
  if (avail < BATCH_HEADER_LEN) return 0;
  const size_t count = buf[1];
  if (count < 1 || count > MAX_BATCH_COUNT) return BATCH_HEADER_LEN + 1;
  return batchFrameLen(count);
}

size_t deltaFrameLenFromHeader(const uint8_t* buf, size_t avail) {
  if (avail < DELTA_HEADER_LEN) return 0;
  const size_t count = buf[1];
  if (count < 2 || count > MAX_DELTA_COUNT) return DELTA_HEADER_LEN + 1;
  return deltaFrameLen(count);
}

size_t powerFrameLenFromHeader(const uint8_t* buf, size_t avail) {
  if (avail < POWER_HEADER_LEN) return 0;
  const size_t count = buf[3];
  if (count > MAX_POWER_IDS) return POWER_HEADER_LEN + 1;
  return powerFrameLen(count);
}

size_t slotTableFrameLenFromHeader(const uint8_t* buf, size_t avail) {
  if (avail < SLOT_TABLE_HEADER_LEN) return 0;
  const size_t count = buf[5];
  if (count > MAX_SLOT_ENTRIES) return SLOT_TABLE_HEADER_LEN + 1;
  return slotTableFrameLen(count);
}

size_t rtcmFrameLenFromHeader(const uint8_t* buf, size_t avail) {
  if (avail < 3) return 0;
  if ((buf[1] & 0xfc) != 0) return 3;
  const size_t length = ((buf[1] & 0x03) << 8) | buf[2];
  if (length < 2 || length > RTCM_MAX_PAYLOAD) return 3;
  return 3 + length + 3;
}

bool validPosition(const uint8_t* buf, size_t len) { return len == FRAME_LEN && buf[0] == SYNC && sumOk(buf, len); }
bool validPing(const uint8_t* buf, size_t len) { return len == PING_FRAME_LEN && buf[0] == PING_SYNC && sumOk(buf, len); }
bool validHello(const uint8_t* buf, size_t len) { return len == HELLO_FRAME_LEN && buf[0] == HELLO_SYNC && sumOk(buf, len); }
bool validStatusHello(const uint8_t* buf, size_t len) {
  return len == STATUS_HELLO_FRAME_LEN && buf[0] == STATUS_HELLO_SYNC && sumOk(buf, len);
}
bool validBatch(const uint8_t* buf, size_t len) {
  if (len < BATCH_HEADER_LEN + 1 || buf[0] != BATCH_SYNC) return false;
  const size_t count = buf[1];
  return count >= 1 && count <= MAX_BATCH_COUNT && len == batchFrameLen(count) && sumOk(buf, len);
}
bool validDelta(const uint8_t* buf, size_t len) {
  if (len < DELTA_HEADER_LEN + 1 || buf[0] != DELTA_SYNC) return false;
  const size_t count = buf[1];
  return count >= 2 && count <= MAX_DELTA_COUNT && len == deltaFrameLen(count) && sumOk(buf, len);
}
bool validSetMark(const uint8_t* buf, size_t len) {
  if (len != SET_MARK_FRAME_LEN || buf[0] != SET_MARK_SYNC || !sumOk(buf, len)) return false;
  if (buf[1 + BOAT_ID_LEN] >= MARK_COUNT) return false;
  const double lat = getI32(buf + 1 + BOAT_ID_LEN + 2) / 1e7;
  const double lon = getI32(buf + 1 + BOAT_ID_LEN + 6) / 1e7;
  return std::fabs(lat) <= 90 && std::fabs(lon) <= 180;
}
bool validMarkLog(const uint8_t* buf, size_t len) { return len == MARK_LOG_FRAME_LEN && buf[0] == MARK_LOG_SYNC && sumOk(buf, len); }

}  // namespace protocol
}  // namespace rover
