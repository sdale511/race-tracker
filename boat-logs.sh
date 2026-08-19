#!/usr/bin/env bash
set -euo pipefail

# Shorthand for `journalctl -u boat-agent -f` - follows the boat-agent
# systemd service's live console output (see install-boat-service.sh).
# Extra args pass straight through, e.g. `./boat-logs.sh -n 200` to also
# show the last 200 lines before following.
#
# May need sudo depending on this Pi's journal permissions - if you get a
# permission error, retry as `sudo ./boat-logs.sh`.

exec journalctl -u boat-agent -f "$@"
