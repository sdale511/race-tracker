#!/usr/bin/env bash
set -euo pipefail

# Shorthand for `sudo systemctl restart base-station` (see
# install-base-service.sh) - e.g. after hand-editing the generated unit,
# or just to pick up a fresh boot.

if [ "$(id -u)" -ne 0 ]; then
  echo "error: restarting a systemd service needs root - run with sudo" >&2
  echo "usage: sudo $0" >&2
  exit 1
fi

systemctl restart base-station
systemctl status base-station --no-pager -l
