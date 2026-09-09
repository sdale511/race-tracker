#!/usr/bin/env bash
set -euo pipefail

# Shorthand for `sudo systemctl start boat-agent` (see
# install-boat-service.sh) - starts the service without touching whether it
# auto-starts on boot (see boat-autostart.sh for that).

if [ "$(id -u)" -ne 0 ]; then
  echo "error: starting a systemd service needs root - run with sudo" >&2
  echo "usage: sudo $0" >&2
  exit 1
fi

systemctl start boat-agent
systemctl status boat-agent --no-pager -l
