#!/usr/bin/env bash
set -euo pipefail

# Shorthand for `sudo systemctl restart <mode's unit>` (see
# install-service.sh) - e.g. after hand-editing the generated unit, or just
# to pick up a fresh boot. One script for all six modes (see README's
# "Running" section) instead of a separate boat-restart.sh/base-restart.sh
# pair.
#
# Usage:
#   sudo ./service-restart.sh MODE

if [ "$(id -u)" -ne 0 ]; then
  echo "error: restarting a systemd service needs root - run with sudo" >&2
  echo "usage: sudo $0 MODE" >&2
  exit 1
fi

MODE="${1:-}"
# Same mode -> unit-name mapping as install-service.sh - see its own
# comment on why this small case statement is duplicated per script rather
# than sourced from one shared file.
case "$MODE" in
  boat)     SERVICE_NAME="boat-agent" ;;
  base)     SERVICE_NAME="base-station" ;;
  rtk)      SERVICE_NAME="rtk-station" ;;
  basertk)  SERVICE_NAME="basertk-station" ;;
  markset)  SERVICE_NAME="markset-station" ;;
  mark)     SERVICE_NAME="mark-station" ;;
  *)
    echo "error: MODE must be one of: boat base rtk basertk markset mark (got \"$MODE\")" >&2
    echo "usage: sudo $0 MODE" >&2
    exit 1
    ;;
esac

systemctl restart "$SERVICE_NAME"
systemctl status "$SERVICE_NAME" --no-pager -l
