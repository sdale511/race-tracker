#include "status_page.h"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cstring>

namespace {

const char* const PAGE = R"HTML(<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rover status</title>
<style>
:root { --bg: #fff; --fg: #1d1d1f; --muted: #6e6e73; --line: #e5e5ea; }
@media (prefers-color-scheme: dark) { :root { --bg: #161618; --fg: #f2f2f7; --muted: #98989f; --line: #2c2c2e; } }
body { background: var(--bg); color: var(--fg); font: 14px/1.4 -apple-system, system-ui, sans-serif; margin: 0 auto; padding: 16px; max-width: 900px; }
h1 { font-size: 18px; margin: 0; } .sub { color: var(--muted); margin: 2px 0 16px; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 24px; }
h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 0 0 6px; }
table { width: 100%; border-collapse: collapse; }
td { padding: 4px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
td:first-child { color: var(--muted); padding-right: 12px; white-space: nowrap; }
td:last-child { font-family: ui-monospace, Menlo, monospace; font-size: 13px; word-break: break-all; }
#err { color: #d70015; }
</style></head><body>
<h1 id="title">Rover</h1><div class="sub"><span id="sub"></span> <span id="err"></span></div>
<div class="cols"><section><h2>Status</h2><table id="status"></table></section>
<section><h2>Config</h2><table id="config"></table></section></div>
<script>
function fill(id, rows) {
  const t = document.getElementById(id);
  t.replaceChildren(...rows.map(([k, v]) => { const tr = document.createElement('tr');
    for (const x of [k, v]) { const td = document.createElement('td'); td.textContent = x; tr.append(td); } return tr; }));
}
async function update() {
  try {
    const s = await (await fetch('status.json', { cache: 'no-store' })).json();
    document.title = s.title; document.getElementById('title').textContent = s.title;
    document.getElementById('sub').textContent = s.subtitle; document.getElementById('err').textContent = '';
    fill('status', s.status); fill('config', s.config);
  } catch { document.getElementById('err').textContent = '- the rover is not answering'; }
}
update(); setInterval(update, 1000);
</script></body></html>
)HTML";

std::string jsonString(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') o += '\\', o += (char)c;
    else if (c < 0x20) {
      char b[8];
      snprintf(b, sizeof b, "\\u%04x", c);
      o += b;
    } else o += (char)c;
  }
  return o + "\"";
}

std::string jsonItems(const StatusPage::Items& items) {
  std::string o = "[";
  for (size_t i = 0; i < items.size(); i++) o += (i ? "," : "") + std::string("[") + jsonString(items[i].first) + "," + jsonString(items[i].second) + "]";
  return o + "]";
}

void respond(int c, const char* status, const char* type, const std::string& body) {
  std::string r = std::string("HTTP/1.0 ") + status + "\r\nContent-Type: " + type + "\r\nCache-Control: no-store\r\nContent-Length: " +
                  std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" + body;
  size_t off = 0;
  while (off < r.size()) {
    const ssize_t n = write(c, r.data() + off, r.size() - off);
    if (n <= 0) break;
    off += (size_t)n;
  }
}

}  // namespace

// Only on this machine: the page is for the person at the Mac, not the network
bool StatusPage::listen(uint16_t port) {
  fd_ = socket(AF_INET, SOCK_STREAM, 0);
  if (fd_ < 0) return false;
  const int on = 1;
  setsockopt(fd_, SOL_SOCKET, SO_REUSEADDR, &on, sizeof on);
  struct sockaddr_in a = {};
  a.sin_family = AF_INET;
  a.sin_port = htons(port);
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(fd_, (struct sockaddr*)&a, sizeof a) != 0 || ::listen(fd_, 8) != 0) {
    close(fd_);
    fd_ = -1;
    return false;
  }
  fcntl(fd_, F_SETFL, O_NONBLOCK);
  return true;
}

void StatusPage::serve(const std::function<Snapshot()>& snapshot) {
  if (fd_ < 0) return;
  for (;;) {
    const int c = accept(fd_, nullptr, nullptr);
    if (c < 0) return;
    // the request line is all that matters; a browser sends it at once
    char req[1024];
    struct pollfd p = {c, POLLIN, 0};
    ssize_t n = poll(&p, 1, 200) > 0 ? read(c, req, sizeof req - 1) : 0;
    req[n > 0 ? n : 0] = 0;
    if (!std::strncmp(req, "GET /status.json", 16)) {
      const Snapshot s = snapshot();
      respond(c, "200 OK", "application/json",
              "{\"title\":" + jsonString(s.title) + ",\"subtitle\":" + jsonString(s.subtitle) + ",\"status\":" + jsonItems(s.status) +
                  ",\"config\":" + jsonItems(s.config) + "}");
    } else if (!std::strncmp(req, "GET / ", 6)) {
      respond(c, "200 OK", "text/html; charset=utf-8", PAGE);
    } else {
      respond(c, "404 Not Found", "text/plain", "not found\n");
    }
    close(c);
  }
}
