#include "xbee_at.h"

#include <vector>

namespace rover {
namespace xbee {

namespace {

// xbeeAt.js's readReply: collect until a reply line ending in "\r" (or `until`) has arrived; the last printable line, or "" with
// timedOut set. `until` is for the OK after +++: until command mode starts the radio still passes on frames from the air, whose
// binary bytes can include a "\r".
std::string readReply(const Io& io, unsigned timeoutMs, const char* until, bool& timedOut) {
  std::string buf;
  timedOut = false;
  while (true) {
    const bool done = until ? buf.find(until) != std::string::npos : buf.find('\r') != std::string::npos;
    if (done) break;
    if (!io.read(buf, timeoutMs)) {
      timedOut = true;
      return "";
    }
  }
  if (until) return "OK";
  std::vector<std::string> lines;
  std::string cur;
  for (char ch : buf + "\r") {
    if (ch == '\r') {
      // keep printable characters, trim
      std::string clean;
      for (char c : cur)
        if (c >= 0x20 && c <= 0x7e) clean += c;
      const size_t a = clean.find_first_not_of(' '), b = clean.find_last_not_of(' ');
      if (a != std::string::npos) lines.push_back(clean.substr(a, b - a + 1));
      cur.clear();
    } else {
      cur += ch;
    }
  }
  return lines.empty() ? "" : lines.back();
}

std::string command(const Io& io, const std::string& cmd, unsigned timeoutMs, bool& timedOut) {
  io.write(cmd + "\r");
  return readReply(io, timeoutMs, nullptr, timedOut);
}

}  // namespace

Result setNodeIdentifier(const Io& io, const std::string& ni, unsigned guardMs, unsigned timeoutMs) {
  Result r;
  bool printable = !ni.empty() && ni.size() <= NI_MAX_LEN;
  for (char c : ni) printable = printable && c >= 0x20 && c <= 0x7e;
  if (!printable) {
    r.error = "\"" + ni + "\" is not a valid node identifier (1-20 printable characters)";
    return r;
  }
  io.sleep(guardMs);
  io.write("+++");
  bool timedOut;
  readReply(io, timeoutMs, "OK\r", timedOut);
  if (timedOut) {
    r.error = "no \"OK\" after +++ (not an XBee in transparent mode, or the wrong baud?)";
    return r;
  }
  r.previous = command(io, "ATNI", timeoutMs, timedOut);
  if (timedOut) {
    r.error = "no reply to ATNI";
  } else if (r.previous == ni) {
    r.ok = true;
  } else if (command(io, "ATNI" + ni, timeoutMs, timedOut) != "OK") {
    r.error = "ATNI" + ni + " was not accepted";
  } else if (command(io, "ATWR", timeoutMs, timedOut) != "OK") {
    r.error = "ATWR (save) was not accepted";
  } else {
    r.ok = true;
    r.changed = true;
  }
  // always leave command mode (it would also time out on its own after CT, 10 s by default)
  command(io, "ATCN", timeoutMs, timedOut);
  return r;
}

}  // namespace xbee
}  // namespace rover
