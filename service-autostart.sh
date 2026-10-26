#!/usr/bin/env bash
set -euo pipefail

# Controls whether a mode's service starts automatically on boot,
# independent of whether it's running right now (see service-start.sh/
# service-stop.sh for that). Mirrors `systemctl enable`/`disable` but as a
# one-word command that's hard to get backwards. One script for all five
# modes (see README's "Running" section) instead of a separate
# boat-autostart.sh/base-autostart.sh pair.
#
# Usage:
#   sudo ./service-autostart.sh [MODE] on    # enable  (will start on next boot)
#   sudo ./service-autostart.sh [MODE] off   # disable (won't start on next boot)
#   sudo ./service-autostart.sh [MODE]       # show current status
#
# MODE defaults to the one race-tracker service installed on this machine (service-mode.sh).

if [ "$(id -u)" -ne 0 ]; then
  echo "error: changing a systemd unit's boot-enable state needs root - run with sudo" >&2
  echo "usage: sudo $0 [MODE] [on|off]" >&2
  exit 1
fi

# The first argument is the mode, unless it's already the action (MODE left out)
case "${1:-}" in
  on | off | "") MODE=""; ACTION="${1:-}" ;;
  *) MODE="$1"; ACTION="${2:-}" ;;
esac
# shellcheck source=service-mode.sh
source "$(dirname "${BASH_SOURCE[0]}")/service-mode.sh"
resolve_mode "$MODE" "sudo $0 [MODE] [on|off]"

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
    echo "usage: sudo $0 [MODE] [on|off]" >&2
    exit 1
    ;;
esac
