#!/usr/bin/env bash
set -euo pipefail

# Controls whether a mode's service starts automatically on boot,
# independent of whether it's running right now (see service-start.sh/
# service-stop.sh for that). Mirrors `systemctl enable`/`disable` but as a
# one-word command that's hard to get backwards. One script for all six
# modes (see README's "Running" section) instead of a separate
# boat-autostart.sh/base-autostart.sh pair.
#
# Usage:
#   sudo ./service-autostart.sh MODE on    # enable  (will start on next boot)
#   sudo ./service-autostart.sh MODE off   # disable (won't start on next boot)
#   sudo ./service-autostart.sh MODE       # show current status

if [ "$(id -u)" -ne 0 ]; then
  echo "error: changing a systemd unit's boot-enable state needs root - run with sudo" >&2
  echo "usage: sudo $0 MODE [on|off]" >&2
  exit 1
fi

MODE="${1:-}"
ACTION="${2:-}"
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
    echo "usage: sudo $0 MODE [on|off]" >&2
    exit 1
    ;;
esac

case "$ACTION" in
  on)
    systemctl enable "$SERVICE_NAME"
    echo "$SERVICE_NAME will now start automatically on boot."
    ;;
  off)
    systemctl disable "$SERVICE_NAME"
    echo "$SERVICE_NAME will NOT start automatically on boot."
    echo "(it keeps running now if it's already running - use ./service-stop.sh $MODE to stop it too.)"
    ;;
  "")
    if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
      echo "$SERVICE_NAME: autostart is ON (will start on next boot)"
    else
      echo "$SERVICE_NAME: autostart is OFF (won't start on next boot)"
    fi
    if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
      echo "$SERVICE_NAME: currently RUNNING"
    else
      echo "$SERVICE_NAME: currently STOPPED"
    fi
    ;;
  *)
    echo "error: unrecognized argument \"$ACTION\"" >&2
    echo "usage: sudo $0 MODE [on|off]" >&2
    exit 1
    ;;
esac
