// The byte-stream scanner for the radio's receive side - radioLink.js's _onData. Every frame type on the shared radio has its own
// sync byte; the earliest sync byte in the buffer decides which frame is expected next, a frame that fails its checksum drops
// one byte and resyncs. Frames a rover acts on go to the callbacks; the rest (other boats' frames) are just consumed.
#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <vector>

#include "protocol.h"

namespace rover {

class RadioScanner {
 public:
  std::function<void(const protocol::Marks&)> onMarks;
  std::function<void()> onPing;
  std::function<void(const protocol::Power&)> onPower;
  std::function<void(const protocol::SlotTable&)> onSlotTable;
  std::function<void(const protocol::PowerScheduleStamp&)> onPowerSchedule;
  // the whole RTCM3 frame, for forwarding to the GPS untouched
  std::function<void(const protocol::Rtcm&, const uint8_t* raw)> onRtcm;
  std::function<void()> onSyncError;

  void write(const uint8_t* data, size_t len);

  uint32_t frames = 0;
  uint32_t syncErrors = 0;

 private:
  static bool isSync(uint8_t b);
  // the full frame length for the sync byte at buf[0], or 0 when the header isn't all in hand yet
  static size_t lenFor(const uint8_t* buf, size_t avail);
  bool dispatch(const uint8_t* buf, size_t len);

  std::vector<uint8_t> buf_;
  static constexpr size_t MAX_BUF = 2048;  // a stuck partial frame can never grow the buffer past this
};

}  // namespace rover
