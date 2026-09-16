#!/usr/bin/env bash
set -euo pipefail

# Shorthand for `journalctl -u <mode's unit> -f` (see install-service.sh) -
# follows that systemd service's live console output. One script for all
# six modes (see README's "Running" section) instead of a separate
# boat-logs.sh/base-logs.sh pair.
#
# Usage:
#   ./service-logs.sh MODE [extra journalctl args...]
#
# Extra args pass straight through, e.g. `./service-logs.sh base -n 200` to
# also show the last 200 lines before following.
#
# May need sudo depending on this machine's journal permissions - if you
# get a permission error, retry as `sudo ./service-logs.sh MODE`.

MODE="${1:-}"
shift || true
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
    echo "usage: $0 MODE [extra journalctl args...]" >&2
    exit 1
    ;;
esac

exec journalctl -u "$SERVICE_NAME" -f "$@"
