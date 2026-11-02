// host_rover's status page: one HTML page that shows the rover's settings and live state as two tables, fetching /status.json
// every second. A tiny HTTP/1.0 server polled from the main loop - no threads, one short request at a time.
#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <utility>
#include <vector>

class StatusPage {
 public:
  using Items = std::vector<std::pair<std::string, std::string>>;
  struct Snapshot {
    std::string title, subtitle;
    Items config, status;
  };

  bool listen(uint16_t port);  // false: the port is taken (errno says why)
  int fd() const { return fd_; }
  // answers whatever requests are waiting; snapshot is called only for /status.json
  void serve(const std::function<Snapshot()>& snapshot);

 private:
  int fd_ = -1;
};
