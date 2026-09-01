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
#   sudo ./install-boat-service.sh [BOAT_ID]
#
# BOAT_ID is optional, same as running `npm run boat` by hand - omit it and
# this Pi generates (or reuses, on a re-run) its own persistent id the same
# way boatAgent.js already does unconfigured (see boatIdFile.js's
# getOrCreatePersistentBoatId - written to boat_id.txt in REPO_DIR, survives
# restarts). Pass a plain number to assign one deliberately instead (e.g. for
# committee boats an operator wants numbered predictably); it's zero-padded
# to the wire protocol's fixed BOAT_ID width below, so "7" and "00007" both
# work - see protocol.js's BOAT_ID_LEN, the actual source of truth this
# script's own BOAT_ID_WIDTH mirrors.

if [ "$(id -u)" -ne 0 ]; then
  echo "error: installing a systemd unit needs root - run with sudo" >&2
  echo "usage: sudo $0 [BOAT_ID]" >&2
  exit 1
fi

# Fixed rather than derived from where this script happens to be invoked
# from - this is where the repo actually lives on the boat Pi's own disk,
# and the generated unit needs that same fixed path regardless of what
# directory `sudo ./install-boat-service.sh` was run from.
REPO_DIR="/home/jycadmin/race-tracker"
SERVICE_NAME="boat-agent"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# Mirrors protocol.js's BOAT_ID_LEN (5) - not read from there directly since
# this is a plain bash script with no node require, but both values changing
# together is the whole point of a wire-format width, so this isn't expected
# to drift.
BOAT_ID_WIDTH=5

# BOAT_ID: positional arg wins, then an already-exported BOAT_ID, then unset
# (auto-generated on this Pi's first run - see the usage comment above). No
# prompt: an omitted BOAT_ID is a legitimate, common choice now, not a
# mistake to catch.
BOAT_ID="${1:-${BOAT_ID:-}}"
if [ -n "$BOAT_ID" ]; then
  if ! [[ "$BOAT_ID" =~ ^[0-9]+$ ]]; then
    echo "error: BOAT_ID must be a positive integer, got \"$BOAT_ID\"" >&2
    exit 1
  fi
  if [ "${#BOAT_ID}" -gt "$BOAT_ID_WIDTH" ]; then
    echo "error: BOAT_ID \"$BOAT_ID\" is longer than $BOAT_ID_WIDTH digits - the wire protocol's boatId field can't fit it" >&2
    exit 1
  fi
  # Zero-pad to the fixed wire width (e.g. "7" -> "00007") - config.js
  # requires BOAT_ID to be exactly BOAT_ID_LEN characters and fails loudly on
  # a mismatch rather than padding it itself, so an unpadded short numeric id
  # here would crash-loop the service instead of installing a working one.
  BOAT_ID="$(printf '%0*d' "$BOAT_ID_WIDTH" "$BOAT_ID")"
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

# Only pinned into the unit when actually given - an empty BOAT_ID means
# boatAgent.js resolves its own persistent id itself (see resolveBoatId's
# own comment: unset is the trigger for that fallback, not an empty string),
# so this must be genuinely absent from the unit, not present-but-blank.
BOAT_ID_LINE=""
DESCRIPTION="Race Tracker Boat Agent"
if [ -n "$BOAT_ID" ]; then
  BOAT_ID_LINE="Environment=BOAT_ID=$BOAT_ID"
  DESCRIPTION="Race Tracker Boat Agent (BOAT_ID=$BOAT_ID)"
fi

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=$DESCRIPTION
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$REPO_DIR
$BOAT_ID_LINE
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
if [ -n "$BOAT_ID" ]; then
  echo "boat-agent installed and running as BOAT_ID=$BOAT_ID (user $SERVICE_USER, $REPO_DIR)."
else
  echo "boat-agent installed and running (user $SERVICE_USER, $REPO_DIR)."
  echo "no BOAT_ID given - this Pi will generate (or reuse, if already present) its own id in $REPO_DIR/boat_id.txt."
fi
echo "  status:  systemctl status $SERVICE_NAME"
echo "  logs:    ./boat-logs.sh   (or: journalctl -u $SERVICE_NAME -f)"
echo "  restart: sudo ./boat-restart.sh   (or: sudo systemctl restart $SERVICE_NAME)"
echo
echo "To change BOAT_ID later, just re-run this script."
