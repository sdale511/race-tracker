#!/usr/bin/env bash
set -euo pipefail

# Installs (or updates) the base station as a systemd service - same idea as
# install-boat-service.sh, but for src/baseStation.js instead. Unlike the
# boat Pis (identical units, always at the same fixed path/user - see that
# script's own REPO_DIR), a base station can run on any of several different
# machines (a dedicated Pi, or a laptop with a USB radio - see README.md's
# "Base station" section), so this derives its install location from where
# this script itself is actually being run from, rather than a hardcoded
# path.
#
# GPS_LOG=0 is the one exception to "everything else defaults" below - it's
# on by default for an interactive `npm run base` session, but under
# systemd stdout isn't a TTY, so the console line's in-place-overwrite never
# kicks in and every single GPS fix becomes its own permanent journal entry
# instead - noisy and pointless without a terminal watching it live.
#
# REGATTAUP_REGATTA_ID has no fallback needed here the way BOAT_ID does for
# boats: omit it and this base auto-selects whichever active/future regatta
# is closest to today the first time it starts with nothing else resolved
# (see baseStation.js's pickClosestRegatta), same as it already does for a
# plain `npm run base` with no TTY attached - fully overridable afterward
# from the admin dashboard's own Regatta card either way.
#
# Everything else this app reads (GPS_PORT, RADIO_PORT, LOG_DIR, ...) is
# left unset here on purpose - config.js's own defaults are correct for a
# normal install, see README.md's "Tuning knobs" if this particular
# machine actually needs one overridden (edit the generated unit directly,
# or export it before running `npm run base` by hand instead).
#
# Usage:
#   sudo ./install-base-service.sh [REGATTAUP_REGATTA_ID]
#
# Safe to re-run: a second run (with or without a REGATTAUP_REGATTA_ID)
# regenerates the unit and restarts the service to pick it up.

if [ "$(id -u)" -ne 0 ]; then
  echo "error: installing a systemd unit needs root - run with sudo" >&2
  echo "usage: sudo $0 [REGATTAUP_REGATTA_ID]" >&2
  exit 1
fi

# Wherever this checkout actually lives on this machine - not hardcoded,
# see the module comment above.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="base-station"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# REGATTAUP_REGATTA_ID: positional arg wins, then an already-exported
# REGATTAUP_REGATTA_ID, then unset (auto-picked on this base's first run -
# see the usage comment above). No format check - unlike BOAT_ID this isn't
# a fixed-width wire-protocol field, just an opaque RegattaUp id matched
# against its own live list at startup.
REGATTAUP_REGATTA_ID="${1:-${REGATTAUP_REGATTA_ID:-}}"

# Runs as whoever actually invoked sudo, so anything the app writes
# (race-logs/, node_modules/) doesn't end up root-owned - unlike the boat
# script's own SERVICE_USER, there's no single fixed fallback account that
# makes sense across every machine a base might run on, so this insists on
# a real SUDO_USER instead of guessing one.
SERVICE_USER="${SUDO_USER:-}"
if [ -z "$SERVICE_USER" ] || [ "$SERVICE_USER" = "root" ]; then
  echo "error: run this via sudo as the user who should own the service (not directly as root) - e.g. \`sudo $0\`" >&2
  exit 1
fi

NODE_BIN="$(command -v node || echo /usr/bin/node)"

if [ ! -d "$REPO_DIR/node_modules" ]; then
  echo "node_modules missing - running npm install as $SERVICE_USER..."
  sudo -u "$SERVICE_USER" npm --prefix "$REPO_DIR" install
fi

# Only pinned into the unit when actually given - an empty
# REGATTAUP_REGATTA_ID means baseStation.js resolves its own default itself
# (whatever's persisted in regatta-id.txt, then an automatic closest-to-
# today pick - see the module comment above), same "absent, not
# present-but-blank" reasoning as install-boat-service.sh's own BOAT_ID_LINE.
REGATTA_ID_LINE=""
if [ -n "$REGATTAUP_REGATTA_ID" ]; then
  REGATTA_ID_LINE="Environment=REGATTAUP_REGATTA_ID=$REGATTAUP_REGATTA_ID"
fi

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Race Tracker Base Station
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$REPO_DIR
$REGATTA_ID_LINE
Environment=GPS_LOG=0
ExecStart=$NODE_BIN $REPO_DIR/src/baseStation.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

echo
if [ -n "$REGATTAUP_REGATTA_ID" ]; then
  echo "base-station installed and running for REGATTAUP_REGATTA_ID=$REGATTAUP_REGATTA_ID (user $SERVICE_USER, $REPO_DIR)."
else
  echo "base-station installed and running (user $SERVICE_USER, $REPO_DIR)."
  echo "no REGATTAUP_REGATTA_ID given - it'll pick up regatta-id.txt if present, otherwise auto-select the closest active/future regatta to today."
  echo "change it any time from the admin dashboard's Regatta card."
fi
echo "  status:    systemctl status $SERVICE_NAME"
echo "  logs:      ./base-logs.sh   (or: journalctl -u $SERVICE_NAME -f)"
echo "  restart:   sudo ./base-restart.sh   (or: sudo systemctl restart $SERVICE_NAME)"
echo "  stop:      sudo ./base-stop.sh   (or: sudo systemctl stop $SERVICE_NAME)"
echo "  start:     sudo ./base-start.sh   (or: sudo systemctl start $SERVICE_NAME)"
echo "  autostart: sudo ./base-autostart.sh [on|off]   (or: sudo systemctl enable|disable $SERVICE_NAME)"
echo
echo "To change REGATTAUP_REGATTA_ID later, just re-run this script (or pick a different one from the admin dashboard - no restart needed for that)."
