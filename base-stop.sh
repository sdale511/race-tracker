#!/usr/bin/env bash
set -euo pipefail

# Shorthand for `sudo systemctl stop base-station` (see
# install-base-service.sh) - stops the service without touching whether it
# auto-starts on boot (see base-autostart.sh for that) - it'll come back on
# the next boot, or the next `Restart=always` respawn is moot since a clean
# stop doesn't count as a crash.

if [ "$(id -u)" -ne 0 ]; then
  echo "error: stopping a systemd service needs root - run with sudo" >&2
  echo "usage: sudo $0" >&2
  exit 1
fi

systemctl stop base-station
systemctl status base-station --no-pager -l
