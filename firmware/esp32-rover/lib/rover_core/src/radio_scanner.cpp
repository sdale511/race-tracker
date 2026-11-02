#include "radio_scanner.h"

namespace rover {

using namespace protocol;

bool RadioScanner::isSync(uint8_t b) {
  switch (b) {
    case SYNC:
    case MARKS_SYNC:
    case PING_SYNC:
    case POWER_SCHEDULE_SYNC:
    case HELLO_SYNC:
    case STATUS_HELLO_SYNC:
    case BATCH_SYNC:
    case SET_MARK_SYNC:
    case MARK_LOG_SYNC:
    case POWER_SYNC:
    case DELTA_SYNC:
    case SLOT_TABLE_SYNC:
    case RTCM_SYNC:
      return true;
    default:
      return false;
  }
}

size_t RadioScanner::lenFor(const uint8_t* buf, size_t avail) {
  switch (buf[0]) {
    case SYNC: return FRAME_LEN;
    case MARKS_SYNC: return MARKS_FRAME_LEN;
    case PING_SYNC: return PING_FRAME_LEN;
    case POWER_SCHEDULE_SYNC: return POWER_SCHEDULE_FRAME_LEN;
    case HELLO_SYNC: return HELLO_FRAME_LEN;
    case STATUS_HELLO_SYNC: return STATUS_HELLO_FRAME_LEN;
    case BATCH_SYNC: return batchFrameLenFromHeader(buf, avail);
    case SET_MARK_SYNC: return SET_MARK_FRAME_LEN;
    case MARK_LOG_SYNC: return MARK_LOG_FRAME_LEN;
    case POWER_SYNC: return powerFrameLenFromHeader(buf, avail);
    case DELTA_SYNC: return deltaFrameLenFromHeader(buf, avail);
    case SLOT_TABLE_SYNC: return slotTableFrameLenFromHeader(buf, avail);
    case RTCM_SYNC: return rtcmFrameLenFromHeader(buf, avail);
    default: return 0;
  }
}

// True if buf is a valid frame of the type its first byte says (and hands it to its callback).
bool RadioScanner::dispatch(const uint8_t* buf, size_t len) {
  switch (buf[0]) {
    case MARKS_SYNC: {
      Marks m;
      if (!decodeMarks(buf, len, m)) return false;
      if (onMarks) onMarks(m);
      return true;
    }
    case PING_SYNC:
      if (!validPing(buf, len)) return false;
      if (onPing) onPing();
      return true;
    case POWER_SYNC: {
      Power p;
      if (!decodePower(buf, len, p)) return false;
      if (onPower) onPower(p);
      return true;
    }
    case SLOT_TABLE_SYNC: {
      SlotTable t;
      if (!decodeSlotTable(buf, len, t)) return false;
      if (onSlotTable) onSlotTable(t);
      return true;
    }
    case POWER_SCHEDULE_SYNC: {
      PowerSchedule s;
      if (!decodePowerSchedule(buf, len, s)) return false;
      if (onPowerSchedule) onPowerSchedule(s);
      return true;
    }
    case RTCM_SYNC: {
      Rtcm r;
      if (!decodeRtcm(buf, len, r)) return false;
      if (onRtcm) onRtcm(r, buf);
      return true;
    }
    case SYNC: return validPosition(buf, len);
    case HELLO_SYNC: return validHello(buf, len);
    case STATUS_HELLO_SYNC: return validStatusHello(buf, len);
    case BATCH_SYNC: return validBatch(buf, len);
    case SET_MARK_SYNC: return validSetMark(buf, len);
    case MARK_LOG_SYNC: return validMarkLog(buf, len);
    case DELTA_SYNC: return validDelta(buf, len);
    default: return false;
  }
}

void RadioScanner::write(const uint8_t* data, size_t len) {
  buf_.insert(buf_.end(), data, data + len);
  size_t start = 0;  // consumed bytes, erased once at the end
  while (start < buf_.size()) {
    size_t syncIdx = start;
    while (syncIdx < buf_.size() && !isSync(buf_[syncIdx])) syncIdx++;
    if (syncIdx == buf_.size()) {
      start = buf_.size();
      break;
    }
    start = syncIdx;
    const uint8_t* at = buf_.data() + start;
    const size_t avail = buf_.size() - start;
    const size_t frameLen = lenFor(at, avail);
    if (frameLen == 0 || avail < frameLen) break;  // wait for the rest of this frame
    if (dispatch(at, frameLen)) {
      frames++;
      start += frameLen;
    } else {
      syncErrors++;
      if (onSyncError) onSyncError();
      start += 1;
    }
  }
  buf_.erase(buf_.begin(), buf_.begin() + start);
  if (buf_.size() > MAX_BUF) buf_.erase(buf_.begin(), buf_.end() - MAX_BUF / 2);
}

}  // namespace rover
