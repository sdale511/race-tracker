#!/usr/bin/env bash
set -euo pipefail

# Controls whether boat-agent starts automatically on boot, independent of
# whether it's running right now (see boat-start.sh/boat-stop.sh for that).
# Mirrors `systemctl enable`/`disable` but as a one-word command that's hard
# to get backwards.
#
# Usage:
#   sudo ./boat-autostart.sh on    # enable  (will start on next boot)
#   sudo ./boat-autostart.sh off   # disable (won't start on next boot)
#   sudo ./boat-autostart.sh       # show current status

if [ "$(id -u)" -ne 0 ]; then
  echo "error: changing a systemd unit's boot-enable state needs root - run with sudo" >&2
  echo "usage: sudo $0 [on|off]" >&2
  exit 1
fi

MODE="${1:-}"

case "$MODE" in
  on)
    systemctl enable boat-agent
    echo "boat-agent will now start automatically on boot."
    ;;
  off)
    systemctl disable boat-agent
    echo "boat-agent will NOT start automatically on boot."
    echo "(it keeps running now if it's already running - use ./boat-stop.sh to stop it too.)"
    ;;
  "")
    if systemctl is-enabled --quiet boat-agent 2>/dev/null; then
      echo "boat-agent: autostart is ON (will start on next boot)"
    else
      echo "boat-agent: autostart is OFF (won't start on next boot)"
    fi
    if systemctl is-active --quiet boat-agent 2>/dev/null; then
      echo "boat-agent: currently RUNNING"
    else
      echo "boat-agent: currently STOPPED"
    fi
    ;;
  *)
    echo "error: unrecognized argument \"$MODE\"" >&2
    echo "usage: sudo $0 [on|off]" >&2
    exit 1
    ;;
esac
