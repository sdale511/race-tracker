#!/usr/bin/env bash
set -euo pipefail

# Shorthand for `sudo systemctl restart <mode's unit>` (see
# install-service.sh) - e.g. after hand-editing the generated unit, or just
# to pick up a fresh boot. One script for all five modes (see README's
# "Running" section) instead of a separate boat-restart.sh/base-restart.sh
# pair.
#
# Usage:
#   sudo ./service-restart.sh [MODE]
#
# MODE defaults to the one race-tracker service installed on this machine (service-mode.sh).

if [ "$(id -u)" -ne 0 ]; then
  echo "error: restarting a systemd service needs root - run with sudo" >&2
  echo "usage: sudo $0 [MODE]" >&2
  exit 1
fi

MODE="${1:-}"
# shellcheck source=service-mode.sh
source "$(dirname "${BASH_SOURCE[0]}")/service-mode.sh"
resolve_mode "$MODE" "sudo $0 [MODE]"

systemctl restart "$SERVICE_NAME"
systemctl status "$SERVICE_NAME" --no-pager -l
