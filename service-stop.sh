#!/usr/bin/env bash
set -euo pipefail

# Shorthand for `sudo systemctl stop <mode's unit>` (see
# install-service.sh) - stops the service without touching whether it
# auto-starts on boot (see service-autostart.sh for that) - it'll come back
# on the next boot, or the next `Restart=always` respawn is moot since a
# clean stop doesn't count as a crash. One script for all five modes (see
# README's "Running" section) instead of a separate boat-stop.sh/
# base-stop.sh pair.
#
# Usage:
#   sudo ./service-stop.sh [MODE]
#
# MODE defaults to the one race-tracker service installed on this machine (service-mode.sh).

if [ "$(id -u)" -ne 0 ]; then
  echo "error: stopping a systemd service needs root - run with sudo" >&2
  echo "usage: sudo $0 [MODE]" >&2
  exit 1
fi

MODE="${1:-}"
# shellcheck source=service-mode.sh
source "$(dirname "${BASH_SOURCE[0]}")/service-mode.sh"
resolve_mode "$MODE" "sudo $0 [MODE]"

systemctl stop "$SERVICE_NAME"
systemctl status "$SERVICE_NAME" --no-pager -l
