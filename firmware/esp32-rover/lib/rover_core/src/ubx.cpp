#include "ubx.h"

#include "js_math.h"

namespace rover {
namespace ubx {

namespace {

uint16_t u16(const uint8_t* p) { return p[0] | (p[1] << 8); }
uint32_t u32(const uint8_t* p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }
int32_t i32(const uint8_t* p) { return (int32_t)u32(p); }

// Date.UTC for a valid civil date: days since 1970-01-01 (Howard Hinnant's days_from_civil)
int64_t daysFromCivil(int64_t y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = (unsigned)(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + (int64_t)doe - 719468;
}

}  // namespace

std::vector<uint8_t> buildFrame(uint8_t msgClass, uint8_t msgId, const uint8_t* payload, size_t len) {
  std::vector<uint8_t> f = {SYNC1, SYNC2, msgClass, msgId, (uint8_t)(len & 0xff), (uint8_t)((len >> 8) & 0xff)};
  f.insert(f.end(), payload, payload + len);
  uint8_t ckA = 0, ckB = 0;
  for (size_t i = 2; i < f.size(); i++) {
    ckA += f[i];
    ckB += ckA;
  }
  f.push_back(ckA);
  f.push_back(ckB);
  return f;
}

std::vector<uint8_t> encodePollRequest(uint8_t msgClass, uint8_t msgId) { return buildFrame(msgClass, msgId, nullptr, 0); }

std::vector<uint8_t> encodePmreq(uint32_t durationMs, bool force) {
  uint8_t p[16] = {0};
  p[4] = durationMs & 0xff;
  p[5] = (durationMs >> 8) & 0xff;
  p[6] = (durationMs >> 16) & 0xff;
  p[7] = (durationMs >> 24) & 0xff;
  p[8] = 0x02 | (force ? 0x04 : 0);  // backup, force
  p[12] = 0x08;                       // wake on UART RX
  return buildFrame(CLASS_RXM, ID_RXM_PMREQ, p, sizeof p);
}

Pvt decodePvt(const uint8_t* p, int64_t nowWallMs) {
  Pvt out;
  const uint8_t flags = p[21];
  const uint8_t valid = p[11];
  out.utcValid = (valid & 0x01) && (valid & 0x02);
  out.fixType = p[20];
  out.gnssFixOk = flags & 0x01;
  out.diffSoln = flags & 0x02;
  out.carrSoln = (flags >> 6) & 0x03;
  out.numSV = p[23];
  out.lon = i32(p + 24) * 1e-7;
  out.lat = i32(p + 28) * 1e-7;
  out.hAccMm = u32(p + 40);
  out.gSpeedMmS = i32(p + 60);
  out.headMotDeg = i32(p + 64) * 1e-5;
  if (out.utcValid) {
    const int64_t days = daysFromCivil(u16(p + 4), p[6], p[7]);
    const int64_t ms = ((days * 24 + p[8]) * 60 + p[9]) * 60000 + (int64_t)p[10] * 1000;
    out.timestamp = (int64_t)jsRound((double)ms + i32(p + 16) / 1e6);
  } else {
    out.timestamp = nowWallMs;
  }
  return out;
}

void Parser::write(const uint8_t* data, size_t len) {
  buf_.insert(buf_.end(), data, data + len);
  size_t start = 0;
  while (true) {
    size_t sync = start;
    while (sync + 1 < buf_.size() && !(buf_[sync] == SYNC1 && buf_[sync + 1] == SYNC2)) sync++;
    if (sync + 1 >= buf_.size()) {
      // keep at most one trailing byte in case it's a split sync marker
      start = buf_.size() > start ? buf_.size() - 1 : start;
      break;
    }
    start = sync;
    if (buf_.size() - start < 6) break;
    const uint8_t* f = buf_.data() + start;
    const size_t length = u16(f + 4);
    const size_t frameLen = 6 + length + 2;
    if (frameLen > MAX_BUF) {  // an impossible length read off noise - skip this sync rather than wait on it
      start += 2;
      continue;
    }
    if (buf_.size() - start < frameLen) break;
    uint8_t ckA = 0, ckB = 0;
    for (size_t i = 2; i < frameLen - 2; i++) {
      ckA += f[i];
      ckB += ckA;
    }
    if (ckA == f[frameLen - 2] && ckB == f[frameLen - 1]) {
      const uint8_t cls = f[2], id = f[3];
      if (onFrame) onFrame(cls, id);
      if (cls == CLASS_NAV && id == ID_NAV_PVT && length == PVT_LENGTH) {
        if (onPvt) onPvt(decodePvt(f + 6, wallMs ? wallMs() : 0));
      } else if (cls == CLASS_RXM && id == ID_RXM_RTCM && length == RXM_RTCM_LENGTH) {
        const uint8_t* pl = f + 6;
        if (onRxmRtcm) onRxmRtcm({(pl[1] & 0x01) != 0, (uint8_t)((pl[1] >> 1) & 0x03), u16(pl + 6)});
      }
    } else {
      checksumErrors++;
    }
    start += frameLen;
  }
  buf_.erase(buf_.begin(), buf_.begin() + start);
}

}  // namespace ubx
}  // namespace rover
