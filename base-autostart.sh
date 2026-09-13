#!/usr/bin/env bash
set -euo pipefail

# Controls whether base-station starts automatically on boot, independent of
# whether it's running right now (see base-start.sh/base-stop.sh for that).
# Mirrors `systemctl enable`/`disable` but as a one-word command that's hard
# to get backwards.
#
# Usage:
#   sudo ./base-autostart.sh on    # enable  (will start on next boot)
#   sudo ./base-autostart.sh off   # disable (won't start on next boot)
#   sudo ./base-autostart.sh       # show current status

if [ "$(id -u)" -ne 0 ]; then
  echo "error: changing a systemd unit's boot-enable state needs root - run with sudo" >&2
  echo "usage: sudo $0 [on|off]" >&2
  exit 1
fi

MODE="${1:-}"

case "$MODE" in
  on)
    systemctl enable base-station
    echo "base-station will now start automatically on boot."
    ;;
  off)
    systemctl disable base-station
    echo "base-station will NOT start automatically on boot."
    echo "(it keeps running now if it's already running - use ./base-stop.sh to stop it too.)"
    ;;
  "")
    if systemctl is-enabled --quiet base-station 2>/dev/null; then
      echo "base-station: autostart is ON (will start on next boot)"
    else
      echo "base-station: autostart is OFF (won't start on next boot)"
    fi
    if systemctl is-active --quiet base-station 2>/dev/null; then
      echo "base-station: currently RUNNING"
    else
      echo "base-station: currently STOPPED"
    fi
    ;;
  *)
    echo "error: unrecognized argument \"$MODE\"" >&2
    echo "usage: sudo $0 [on|off]" >&2
    exit 1
    ;;
esac
