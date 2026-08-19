#!/usr/bin/env bash
set -euo pipefail

# Installs (or updates) the boat agent as a systemd service on this Pi -
# same unit systemd/boat-agent.service already shipped as a static
# example, generated here instead so BOAT_ID can be set without hand-
# editing a unit file. Everything else this app reads (GPS_PORT, RADIO_PORT,
# LOG_DIR, ...) is left unset here on purpose - config.js's own defaults are
# correct for a normal install, see README.md's "Tuning knobs" if a given
# Pi actually needs one overridden (edit the generated unit directly, or
# export it before running `npm run boat` by hand instead).
#
# GPS_LOG=0 is the one exception - it's on by default for an interactive
# `npm run boat` session, but under systemd stdout isn't a TTY, so the
# console line's in-place-overwrite never kicks in and every single GPS fix
# becomes its own permanent journal entry instead - noisy and pointless
# without a terminal watching it live. Safe to re-run: a second run with a
# different BOAT_ID regenerates the unit and restarts the service to pick
# it up.
#
# Usage:
#   sudo ./install-boat-service.sh <BOAT_ID>
#
# BOAT_ID has no fallback: every boat has to actually be told apart, so
# this refuses to silently default it.

if [ "$(id -u)" -ne 0 ]; then
  echo "error: installing a systemd unit needs root - run with sudo" >&2
  echo "usage: sudo $0 <BOAT_ID>" >&2
  exit 1
fi

# Fixed rather than derived from where this script happens to be invoked
# from - this is where the repo actually lives on the boat Pi's own disk,
# and the generated unit needs that same fixed path regardless of what
# directory `sudo ./install-boat-service.sh` was run from.
REPO_DIR="/home/jycadmin/race-tracker"
SERVICE_NAME="boat-agent"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# BOAT_ID: positional arg wins, then an already-exported BOAT_ID, then ask.
BOAT_ID="${1:-${BOAT_ID:-}}"
if [ -z "$BOAT_ID" ]; then
  read -rp "Boat ID for this Pi: " BOAT_ID
fi
if ! [[ "$BOAT_ID" =~ ^[0-9]+$ ]]; then
  echo "error: BOAT_ID must be a positive integer, got \"$BOAT_ID\"" >&2
  exit 1
fi

# Runs as whoever actually owns the checked-out repo, so anything the app
# writes (race-logs/, node_modules/) doesn't end up root-owned - the user
# who invoked sudo, falling back to "jycadmin" (who owns REPO_DIR above)
# if that's unset.
SERVICE_USER="${SUDO_USER:-jycadmin}"

NODE_BIN="$(command -v node || echo /usr/bin/node)"

if [ ! -d "$REPO_DIR/node_modules" ]; then
  echo "node_modules missing - running npm install as $SERVICE_USER..."
  sudo -u "$SERVICE_USER" npm --prefix "$REPO_DIR" install
fi

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Race Tracker Boat Agent (BOAT_ID=$BOAT_ID)
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$REPO_DIR
Environment=BOAT_ID=$BOAT_ID
Environment=GPS_LOG=0
ExecStart=$NODE_BIN $REPO_DIR/src/boatAgent.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

echo
echo "boat-agent installed and running as BOAT_ID=$BOAT_ID (user $SERVICE_USER, $REPO_DIR)."
echo "  status:  systemctl status $SERVICE_NAME"
echo "  logs:    ./boat-logs.sh   (or: journalctl -u $SERVICE_NAME -f)"
echo "  restart: sudo ./boat-restart.sh   (or: sudo systemctl restart $SERVICE_NAME)"
echo
echo "To change BOAT_ID later, just re-run this script."
