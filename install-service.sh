#!/usr/bin/env bash
set -euo pipefail

# Installs (or updates) a race-tracker mode as a systemd service - one
# script for all six modes (see README's "Running" section), instead of a
# separate near-identical install-*-service.sh per mode.
#
# Usage:
#   sudo ./install-service.sh MODE [EXTRA_ARG]
#
# MODE is one of: boat base rtk basertk markset mark
#
# EXTRA_ARG's meaning depends on MODE - every mode besides these two takes
# no extra argument, reading config.js's own defaults for everything
# (GPS_PORT, RADIO_PORT, LOG_DIR, ...) - see README's "Tuning knobs" to
# override one, either by hand-editing the generated unit below afterward,
# or exporting it before running the npm script directly instead:
#   boat            BOAT_ID (optional - a plain number, zero-padded to the
#                   wire protocol's fixed width; omit to let this Pi
#                   generate/reuse its own persistent id)
#   base, basertk   REGATTAUP_REGATTA_ID (optional - omit to auto-select/
#                   remember one, same as running the npm script by hand)
#   mark            MARK_NAME (optional - omit to start unassigned and pick
#                   one from the map afterward)
#
# Examples:
#   sudo ./install-service.sh boat 7
#   sudo ./install-service.sh base
#   sudo ./install-service.sh basertk abc123
#   sudo ./install-service.sh rtk
#   sudo ./install-service.sh markset
#   sudo ./install-service.sh mark windwardBlack
#
# Safe to re-run: a second run (same or different EXTRA_ARG) regenerates
# the unit and restarts the service to pick it up.

if [ "$(id -u)" -ne 0 ]; then
  echo "error: installing a systemd unit needs root - run with sudo" >&2
  echo "usage: sudo $0 MODE [EXTRA_ARG]" >&2
  exit 1
fi

MODE="${1:-}"
EXTRA_ARG="${2:-}"

# Mode -> systemd unit name, entry file (must match package.json's own npm
# scripts), and a friendly label for the unit's Description= - the one
# place all six modes' install differences actually live; every control
# script below (service-start.sh and friends) shares this exact same
# mapping so `MODE` always resolves to the same unit everywhere.
case "$MODE" in
  boat)     SERVICE_NAME="boat-agent";      ENTRY="src/boatAgent.js";      LABEL="Boat Agent" ;;
  base)     SERVICE_NAME="base-station";    ENTRY="src/baseStation.js";    LABEL="Base Station" ;;
  rtk)      SERVICE_NAME="rtk-station";     ENTRY="src/rtkStation.js";     LABEL="RTK-Only" ;;
  basertk)  SERVICE_NAME="basertk-station"; ENTRY="src/baseRtkStation.js"; LABEL="Base + RTK Combined" ;;
  markset)  SERVICE_NAME="markset-station"; ENTRY="src/markSetStation.js"; LABEL="Mark-Set" ;;
  mark)     SERVICE_NAME="mark-station";    ENTRY="src/markStation.js";    LABEL="Mark" ;;
  *)
    echo "error: MODE must be one of: boat base rtk basertk markset mark (got \"$MODE\")" >&2
    echo "usage: sudo $0 MODE [EXTRA_ARG]" >&2
    exit 1
    ;;
esac
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# Wherever this checkout actually lives on this machine - derived from the
# script's own location, not the caller's cwd, so `sudo ./install-service.sh
# ...` works the same regardless of which directory it's invoked from, and
# regardless of which user's home this happens to be checked out under.
# (The old install-boat-service.sh instead hardcoded /home/jycadmin/
# race-tracker for boat Pis specifically - this derives it the same way
# install-base-service.sh always did for every other mode, which needs no
# fixed-path assumption at all.)
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Runs as whoever actually invoked sudo, so anything the app writes
# (fleet-logs/, boat-logs/, race-config/, node_modules/) doesn't end up root-owned. Insisted on explicitly (not guessed/defaulted
# to some fixed account) since there's no single fallback user that makes
# sense across every machine any of these six modes might run on.
SERVICE_USER="${SUDO_USER:-}"
if [ -z "$SERVICE_USER" ] || [ "$SERVICE_USER" = "root" ]; then
  echo "error: run this via sudo as the user who should own the service (not directly as root) - e.g. \`sudo $0 $MODE\`" >&2
  exit 1
fi

NODE_BIN="$(command -v node || echo /usr/bin/node)"

if [ ! -d "$REPO_DIR/node_modules" ]; then
  echo "node_modules missing - running npm install as $SERVICE_USER..."
  sudo -u "$SERVICE_USER" npm --prefix "$REPO_DIR" install
fi

# Mode-specific EXTRA_ARG handling - only pinned into the unit when
# actually given; an absent one means that mode resolves its own default
# itself at startup (a persisted id/assignment file, or an auto-pick - see
# each mode's own README section), so this must be genuinely absent from
# the unit, not present-but-blank.
EXTRA_LINE=""
DESCRIPTION_SUFFIX=""
case "$MODE" in
  boat)
    # Mirrors protocol.js's BOAT_ID_LEN (5) - not read from there directly
    # since this is a plain bash script with no node require, but both
    # values changing together is the whole point of a wire-format width,
    # so this isn't expected to drift.
    BOAT_ID_WIDTH=5
    if [ -n "$EXTRA_ARG" ]; then
      if ! [[ "$EXTRA_ARG" =~ ^[0-9]+$ ]]; then
        echo "error: BOAT_ID must be a positive integer, got \"$EXTRA_ARG\"" >&2
        exit 1
      fi
      if [ "${#EXTRA_ARG}" -gt "$BOAT_ID_WIDTH" ]; then
        echo "error: BOAT_ID \"$EXTRA_ARG\" is longer than $BOAT_ID_WIDTH digits - the wire protocol's boatId field can't fit it" >&2
        exit 1
      fi
      # Zero-pad to the fixed wire width (e.g. "7" -> "00007") - config.js
      # requires BOAT_ID to be exactly BOAT_ID_LEN characters and fails
      # loudly on a mismatch rather than padding it itself, so an unpadded
      # short numeric id here would crash-loop the service instead of
      # installing a working one.
      EXTRA_ARG="$(printf '%0*d' "$BOAT_ID_WIDTH" "$EXTRA_ARG")"
      EXTRA_LINE="Environment=BOAT_ID=$EXTRA_ARG"
      DESCRIPTION_SUFFIX=" (BOAT_ID=$EXTRA_ARG)"
    fi
    ;;
  base|basertk)
    # No format check - unlike BOAT_ID this isn't a fixed-width
    # wire-protocol field, just an opaque RegattaUp id matched against its
    # own live list at startup.
    if [ -n "$EXTRA_ARG" ]; then
      EXTRA_LINE="Environment=REGATTAUP_REGATTA_ID=$EXTRA_ARG"
      DESCRIPTION_SUFFIX=" (REGATTAUP_REGATTA_ID=$EXTRA_ARG)"
    fi
    ;;
  mark)
    # No format check here either - config.js's own resolveMarkName
    # validates against the real mark names at startup and fails loudly on
    # a typo, same "server-side is the check that actually matters" spirit
    # as REGATTAUP_REGATTA_ID above.
    if [ -n "$EXTRA_ARG" ]; then
      EXTRA_LINE="Environment=MARK_NAME=$EXTRA_ARG"
      DESCRIPTION_SUFFIX=" (MARK_NAME=$EXTRA_ARG)"
    fi
    ;;
  rtk|markset)
    if [ -n "$EXTRA_ARG" ]; then
      echo "error: $MODE takes no extra argument (got \"$EXTRA_ARG\")" >&2
      exit 1
    fi
    ;;
esac

# GPS_LOG=0 is the one setting overridden for every mode - it's on by
# default for an interactive `npm run <mode>` session, but under systemd
# stdout isn't a TTY, so the console line's in-place-overwrite never kicks
# in and every single GPS fix becomes its own permanent journal entry
# instead - noisy and pointless without a terminal watching it live.
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Race Tracker $LABEL$DESCRIPTION_SUFFIX
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$REPO_DIR
$EXTRA_LINE
Environment=GPS_LOG=0
ExecStart=$NODE_BIN $REPO_DIR/$ENTRY
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

echo
echo "$SERVICE_NAME installed and running (user $SERVICE_USER, $REPO_DIR)."
if [ -n "$EXTRA_LINE" ]; then
  echo "  $EXTRA_LINE"
else
  echo "  no extra argument given - this mode resolves its own default at startup (see its own README section)."
fi
echo "  status:    systemctl status $SERVICE_NAME"
echo "  logs:      ./service-logs.sh $MODE   (or: journalctl -u $SERVICE_NAME -f)"
echo "  restart:   sudo ./service-restart.sh $MODE   (or: sudo systemctl restart $SERVICE_NAME)"
echo "  stop:      sudo ./service-stop.sh $MODE   (or: sudo systemctl stop $SERVICE_NAME)"
echo "  start:     sudo ./service-start.sh $MODE   (or: sudo systemctl start $SERVICE_NAME)"
echo "  autostart: sudo ./service-autostart.sh $MODE [on|off]   (or: sudo systemctl enable|disable $SERVICE_NAME)"
echo
echo "To change $MODE's own settings later, just re-run this script."
