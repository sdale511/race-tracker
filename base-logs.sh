#!/usr/bin/env bash
set -euo pipefail

# Shorthand for `journalctl -u base-station -f` - follows the base-station
# systemd service's live console output (see install-base-service.sh).
# Extra args pass straight through, e.g. `./base-logs.sh -n 200` to also
# show the last 200 lines before following.
#
# May need sudo depending on this machine's journal permissions - if you
# get a permission error, retry as `sudo ./base-logs.sh`.

exec journalctl -u base-station -f "$@"
