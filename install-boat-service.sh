#!/usr/bin/env bash
set -euo pipefail

# Installs (or updates) the boat agent as a systemd service on this Pi -
# same unit systemd/boat-agent.service already shipped as a static
# example, generated here instead so BOAT_ID (and, if needed, the other
# per-Pi settings that already varied in that file - GPS_PORT, RADIO_PORT,
# etc.) can be set without hand-editing a unit file. Safe to re-run: a
# second run with a different BOAT_ID regenerates the unit and restarts
# the service to pick it up.
#
# Usage:
#   sudo ./install-boat-service.sh <BOAT_ID>
#   sudo BOAT_ID=3 GPS_PORT=/dev/ttyACM1 ./install-boat-service.sh
#
# Any of the same env vars config.js reads (see README.md's "Tuning
# knobs") can be exported before running this to override the defaults
# below - e.g. GPS_PORT/RADIO_PORT differ by Pi depending on what a given
# device enumerates as. Only BOAT_ID has no fallback: every boat has to
# actually be told apart, so this refuses to silently default it.

if [ "$(id -u)" -ne 0 ]; then
  echo "error: installing a systemd unit needs root - run with sudo" >&2
  echo "usage: sudo $0 <BOAT_ID>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

# Everything else - same values systemd/boat-agent.service's static example
# already used, overridable by exporting the same var before running this
# (e.g. `sudo GPS_PORT=/dev/ttyACM1 -E ./install-boat-service.sh 3`, -E so
# sudo preserves the exported var).
GPS_PORT="${GPS_PORT:-/dev/ttyACM0}"
GPS_BAUD="${GPS_BAUD:-38400}"
RADIO_PORT="${RADIO_PORT:-/dev/ttyUSB0}"
RADIO_BAUD="${RADIO_BAUD:-115200}"
TX_DISTANCE_M="${TX_DISTANCE_M:-1}"
LOG_DIR="${LOG_DIR:-/home/pi/race-logs}"

# Runs as whoever actually owns the checked-out repo, so LOG_DIR/
# node_modules don't end up root-owned - the user who invoked sudo,
# falling back to "pi" (this project's usual Pi username) if that's unset.
SERVICE_USER="${SUDO_USER:-pi}"

NODE_BIN="$(command -v node || echo /usr/bin/node)"

mkdir -p "$LOG_DIR"
chown "$SERVICE_USER" "$LOG_DIR"

if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "node_modules missing - running npm install as $SERVICE_USER..."
  sudo -u "$SERVICE_USER" npm --prefix "$SCRIPT_DIR" install
fi

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Race Tracker Boat Agent (BOAT_ID=$BOAT_ID)
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$SCRIPT_DIR
Environment=GPS_PORT=$GPS_PORT
Environment=GPS_BAUD=$GPS_BAUD
Environment=RADIO_PORT=$RADIO_PORT
Environment=RADIO_BAUD=$RADIO_BAUD
Environment=BOAT_ID=$BOAT_ID
Environment=TX_DISTANCE_M=$TX_DISTANCE_M
Environment=LOG_DIR=$LOG_DIR
ExecStart=$NODE_BIN $SCRIPT_DIR/src/boatAgent.js
Restart=always
RestartSec=3
StandardOutput=append:$LOG_DIR/boat-agent.log
StandardError=append:$LOG_DIR/boat-agent.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

echo
echo "boat-agent installed and running as BOAT_ID=$BOAT_ID (user $SERVICE_USER, $SCRIPT_DIR)."
echo "  status:  systemctl status $SERVICE_NAME"
echo "  logs:    tail -f $LOG_DIR/boat-agent.log"
echo "  restart: sudo systemctl restart $SERVICE_NAME"
echo
echo "To change BOAT_ID (or any of GPS_PORT/GPS_BAUD/RADIO_PORT/RADIO_BAUD/"
echo "TX_DISTANCE_M/LOG_DIR) later, just re-run this script."
