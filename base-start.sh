#!/usr/bin/env bash
set -euo pipefail

# Shorthand for `sudo systemctl start base-station` (see
# install-base-service.sh) - starts the service without touching whether it
# auto-starts on boot (see base-autostart.sh for that).

if [ "$(id -u)" -ne 0 ]; then
  echo "error: starting a systemd service needs root - run with sudo" >&2
  echo "usage: sudo $0" >&2
  exit 1
fi

systemctl start base-station
systemctl status base-station --no-pager -l
