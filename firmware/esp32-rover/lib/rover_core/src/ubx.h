// The u-blox UBX side of the GPS link - the parts of src/ubxParser.js a rover uses: the stream parser (NAV-PVT, RXM-RTCM, and
// "any valid UBX frame" for the diagnosis) and the two commands a rover sends (a poll, and RXM-PMREQ for GPS sleep).
#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <vector>

#include "pvt.h"

namespace rover {
namespace ubx {

constexpr uint8_t SYNC1 = 0xb5;
constexpr uint8_t SYNC2 = 0x62;
constexpr uint8_t CLASS_NAV = 0x01;
constexpr uint8_t ID_NAV_PVT = 0x07;
constexpr uint8_t CLASS_RXM = 0x02;
constexpr uint8_t ID_RXM_RTCM = 0x32;
constexpr uint8_t ID_RXM_PMREQ = 0x41;
constexpr size_t PVT_LENGTH = 92;
constexpr size_t RXM_RTCM_LENGTH = 8;

std::vector<uint8_t> buildFrame(uint8_t msgClass, uint8_t msgId, const uint8_t* payload, size_t len);
std::vector<uint8_t> encodePollRequest(uint8_t msgClass, uint8_t msgId);
// Software backup until a byte arrives on the receiver's UART RX - see gpsSleep.js
std::vector<uint8_t> encodePmreq(uint32_t durationMs = 0, bool force = false);

// ubxParser.js's _decodePvt. nowWallMs: the timestamp used while the receiver's UTC is not valid yet (Date.now() in Node).
Pvt decodePvt(const uint8_t* payload, int64_t nowWallMs);

struct RxmRtcm {
  bool crcFailed;
  uint8_t msgUsed;  // 0 unknown, 1 not used, 2 used
  uint16_t msgType;
};

class Parser {
 public:
  std::function<int64_t()> wallMs;  // for decodePvt's fallback timestamp
  std::function<void(const Pvt&)> onPvt;
  std::function<void(const RxmRtcm&)> onRxmRtcm;
  std::function<void(uint8_t msgClass, uint8_t msgId)> onFrame;  // any valid UBX frame
  uint32_t checksumErrors = 0;

  void write(const uint8_t* data, size_t len);

 private:
  std::vector<uint8_t> buf_;
  static constexpr size_t MAX_BUF = 4096;  // a NAV-SIG can run to a kilobyte; nothing longer is expected
};

}  // namespace ubx
}  // namespace rover
