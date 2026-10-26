#!/usr/bin/env bash
set -euo pipefail

# Shorthand for `journalctl -u <mode's unit> -f` (see install-service.sh) -
# follows that systemd service's live console output. One script for all
# five modes (see README's "Running" section) instead of a separate
# boat-logs.sh/base-logs.sh pair.
#
# Usage:
#   ./service-logs.sh [MODE] [extra journalctl args...]
#
# MODE defaults to the one race-tracker service installed on this machine (service-mode.sh).
#
# Extra args pass straight through, e.g. `./service-logs.sh base -n 200` to
# also show the last 200 lines before following.
#
# May need sudo depending on this machine's journal permissions - if you
# get a permission error, retry as `sudo ./service-logs.sh`.

# The first argument is the mode, unless it's left out and the journalctl args start straight away (-n 200)
MODE=""
case "${1:-}" in
  -* | "") ;;
  *) MODE="$1"; shift ;;
esac
# shellcheck source=service-mode.sh
source "$(dirname "${BASH_SOURCE[0]}")/service-mode.sh"
resolve_mode "$MODE" "$0 [MODE] [extra journalctl args...]"

exec journalctl -u "$SERVICE_NAME" -f "$@"
