#!/usr/bin/env bash
set -euo pipefail

# setup-gps-uart.sh
#
# Gets /dev/ttyAMA0 fully ready for this app to read GPS fixes from:
#   1. Frees the Pi's hardware UART (GPIO14/15) from the serial console and
#      Bluetooth - automates README's "Wiring notes" section.
#   2. Configures the GPS module itself over that UART (UBX-NAV-PVT on,
#      NMEA off) - automates README's "GPS configuration" section.
#   3. Makes sure the user this app actually runs as (see
#      install-service.sh) can open the port at all - dialout group
#      membership, not just the device node existing.
# Idempotent and safe to re-run: each step only changes what isn't already
# set the way it wants.
#
# THIS NEEDS A REBOOT PARTWAY THROUGH. config.txt/cmdline.txt changes only
# apply at boot, so step 1 and step 2 can't happen in the same run the
# first time - the script detects which phase it's in and tells you what
# to do next:
#   sudo ./setup-gps-uart.sh            # phase 1: free the UART (may reboot)
#   sudo reboot                         # only if phase 1 changed anything
#   sudo ./setup-gps-uart.sh            # phase 2: configure the GPS module
#
# Env vars (all optional):
#   GPS_PORT      - default /dev/ttyAMA0
#   GPS_BAUD      - default 115200 - the module's CURRENT baud, needed to
#                   talk to it via ubxtool in the first place. This script
#                   does NOT blindly assume it - if connecting at this baud
#                   fails, it tries the other common ones and tells you
#                   which one actually worked, matching README's "GPS
#                   configuration" verification step.
#   GPS_UART      - which UART NUMBER on the module your wiring reaches (1
#                   or 2) - default 1. Depends on the board/breakout, not
#                   something this script can know - see README's "Wiring
#                   notes" on ArduSimple's simpleRTK2B routing UART2 to its
#                   XBee socket, so a direct wire to a general breakout pin
#                   is more likely UART1, but verify (see this script's own
#                   output at the end) rather than assume.
#   DISABLE_NMEA  - default 1 (turn NMEA off on this UART once UBX-NAV-PVT
#                   is on, to stop wasting airtime/bandwidth on unneeded
#                   chatter). Set to 0 to leave NMEA on - the app's own UBX
#                   parser isn't confused by NMEA sharing the line either
#                   way, so this is purely a bandwidth choice, not a
#                   correctness one.
#   SERVICE_USER  - the non-root user this app actually runs as (see
#                   install-service.sh) - added to the dialout group
#                   so it can open $GPS_PORT at all. Defaults to whoever
#                   invoked sudo, falling back to "jycadmin" if that's
#                   unset (this script's own default - install-service.sh
#                   requires a real SUDO_USER explicitly instead).

if [ "$(id -u)" -ne 0 ]; then
  echo "error: this needs root - run with sudo" >&2
  echo "usage: sudo $0" >&2
  exit 1
fi

GPS_PORT="${GPS_PORT:-/dev/ttyAMA0}"
GPS_BAUD="${GPS_BAUD:-115200}"
GPS_UART="${GPS_UART:-1}"
DISABLE_NMEA="${DISABLE_NMEA:-1}"
SERVICE_USER="${SERVICE_USER:-${SUDO_USER:-jycadmin}}"

# Bookworm+ moved these under /boot/firmware/ - fall back to the older
# /boot/ location so this doesn't silently edit nothing on an older image.
CONFIG_TXT="/boot/firmware/config.txt"
CMDLINE_TXT="/boot/firmware/cmdline.txt"
if [ ! -f "$CONFIG_TXT" ]; then CONFIG_TXT="/boot/config.txt"; fi
if [ ! -f "$CMDLINE_TXT" ]; then CMDLINE_TXT="/boot/cmdline.txt"; fi

echo "config: $CONFIG_TXT"
echo "cmdline: $CMDLINE_TXT"
echo

NEEDS_REBOOT=0

# --- Phase 1: free the hardware UART for GPIO14/15 ---

# "serial port hardware enabled = Yes" in raspi-config terms - ensures the
# UART is actually enabled and the mini-UART's clock is fixed to the CPU's
# real frequency (matters even once ttyAMA0 is freed, since the mini-UART
# doesn't just disappear).
if ! grep -q '^enable_uart=1' "$CONFIG_TXT"; then
  echo "enable_uart=1" >> "$CONFIG_TXT"
  echo "Added enable_uart=1 to $CONFIG_TXT"
  NEEDS_REBOOT=1
fi

# "login shell over serial = No" - cmdline.txt ships with a
# console=serial0,115200 (or console=ttyAMA0,...) token by default, which
# claims the UART for a login shell instead of leaving it free for the GPS.
if grep -qE 'console=(serial0|ttyAMA0),[0-9]+' "$CMDLINE_TXT"; then
  sed -i -E 's/console=(serial0|ttyAMA0),[0-9]+ ?//g' "$CMDLINE_TXT"
  echo "Removed serial console from $CMDLINE_TXT"
  NEEDS_REBOOT=1
fi

# On any Pi with onboard Bluetooth (Zero 2 W, 3A+/3B+, 4, etc.), the above
# alone isn't enough - GPIO14/15 default to the mini-UART (ttyS0), not the
# real hardware UART (ttyAMA0), because Bluetooth occupies the real one.
if ! grep -q '^dtoverlay=disable-bt' "$CONFIG_TXT"; then
  echo "dtoverlay=disable-bt" >> "$CONFIG_TXT"
  echo "Added dtoverlay=disable-bt to $CONFIG_TXT"
  NEEDS_REBOOT=1
fi

# Safe to run every time regardless of NEEDS_REBOOT - a plain "already
# disabled" no-op if these were already off from a previous run.
systemctl disable --now hciuart 2>/dev/null || true
systemctl disable --now bluealsa.service 2>/dev/null || true
systemctl disable --now bluetooth.service 2>/dev/null || true

# Group membership takes effect on this user's NEXT login/session, same as
# config.txt needs a reboot - safe to do now regardless of which phase
# we're in, so it's not forgotten on a run where nothing else needed it.
if id "$SERVICE_USER" >/dev/null 2>&1 && ! id -nG "$SERVICE_USER" | grep -qw dialout; then
  usermod -aG dialout "$SERVICE_USER"
  echo "Added $SERVICE_USER to the dialout group (needed to open $GPS_PORT at all - takes"
  echo "effect on that user's next login/service restart, not this shell session)."
fi

if [ "$NEEDS_REBOOT" -eq 1 ]; then
  echo
  echo "Config changed - reboot required before continuing (config.txt/cmdline.txt"
  echo "changes only take effect at boot, editing them doesn't do anything live):"
  echo "  sudo reboot"
  echo "Then re-run this script to finish configuring the GPS module itself."
  exit 0
fi

echo "UART already freed (enable_uart=1, no serial console, Bluetooth disabled)."
echo

# --- Phase 2 (only reached once phase 1 needs no further changes, i.e.
# this is a re-run after reboot): configure the GPS module itself. ---

# ubxtool comes from gpsd's client tools (gpsd-clients/python3-gps), not
# gpsd itself.
if ! command -v ubxtool >/dev/null 2>&1; then
  echo "Installing gpsd/gpsd-clients/python3-gps for ubxtool..."
  apt-get update
  apt-get install -y gpsd gpsd-clients python3-gps
fi

# gpsd auto-starts and holds the port open the moment it's installed (or on
# every boot after) - this app (and ubxtool below) needs exclusive access.
systemctl disable --now gpsd.socket gpsd 2>/dev/null || true

if [ ! -e "$GPS_PORT" ]; then
  echo "error: $GPS_PORT still doesn't exist after freeing the UART." >&2
  echo "  Check: ls -la /dev/ttyAMA0 /dev/ttyS0 /dev/serial0 /dev/serial1" >&2
  exit 1
fi

# Find whatever baud the module is ACTUALLY at right now - a wrong guess
# here doesn't error, it just silently talks past the module (ubxtool would
# hang/timeout with no useful message), so this never assumes GPS_BAUD
# (the TARGET below) is already correct.
find_working_baud() {
  local b
  for b in "$GPS_BAUD" 9600 19200 38400 57600 115200; do
    stty -F "$GPS_PORT" "$b" raw -echo
    # Switching stty's baud only changes how FUTURE incoming bits get
    # sampled - it does nothing to bytes already sitting in the kernel's
    # receive buffer, which the UART hardware deserialized in real time at
    # whatever baud was set when they physically arrived (i.e. the
    # PREVIOUS, wrong, candidate). Without draining those stale/garbled
    # bytes first, the very next read below returns leftover noise from
    # the last candidate instead of genuine data at this one - this is
    # exactly why a quick manual one-shot test at the right baud can work
    # fine while this loop, cycling through several baud candidates back
    # to back, was missing the correct one.
    timeout 0.3 head -c 4096 "$GPS_PORT" >/dev/null 2>&1 || true
    if timeout 2 head -c 256 "$GPS_PORT" 2>/dev/null | grep -qaE '\$GN|\$GP|\xb5\x62'; then
      echo "$b"
      return 0
    fi
  done
  return 1
}

echo "Finding $GPS_PORT's current baud (target is GPS_BAUD=$GPS_BAUD)..."
CURRENT_BAUD="$(find_working_baud || true)"
if [ -z "$CURRENT_BAUD" ]; then
  echo "error: got no recognizable NMEA/UBX data on $GPS_PORT at any common baud." >&2
  echo "  This means the UART side is fine but nothing usable is coming from the module -" >&2
  echo "  check TX/RX/GND wiring, that the module has power, and that it's not still" >&2
  echo "  routed to a different UART (GPS_UART=$GPS_UART may be the wrong number for" >&2
  echo "  your wiring - try the other one)." >&2
  exit 1
fi
echo "Module is currently at $CURRENT_BAUD baud."

# Raise it to the target (GPS_BAUD) if it isn't there already - persisted
# to RAM+BBR+Flash (,7) so it survives a power cycle. Connects at the
# CURRENT (just-detected) baud to issue this, since that's the only speed
# the module is actually listening at right now; every ubxtool command
# after this one uses GPS_BAUD instead, since the module switches the
# instant this command takes effect.
if [ "$CURRENT_BAUD" != "$GPS_BAUD" ]; then
  echo "Raising UART${GPS_UART} baud from $CURRENT_BAUD to $GPS_BAUD..."
  ubxtool -f "$GPS_PORT" -s "$CURRENT_BAUD" -P 27.11 -z "CFG-UART${GPS_UART}-BAUDRATE,${GPS_BAUD},7"
  # Confirm it actually took - same drain-then-read approach as
  # find_working_baud above, now expecting the NEW baud specifically.
  stty -F "$GPS_PORT" "$GPS_BAUD" raw -echo
  timeout 0.3 head -c 4096 "$GPS_PORT" >/dev/null 2>&1 || true
  if ! timeout 2 head -c 256 "$GPS_PORT" 2>/dev/null | grep -qaE '\$GN|\$GP|\xb5\x62'; then
    echo "error: module isn't answering at $GPS_BAUD after the baud-raise command." >&2
    echo "  It may still be at $CURRENT_BAUD (the CFG-UART${GPS_UART}-BAUDRATE key name/layer" >&2
    echo "  bitmask may not match this module's firmware) - re-run with GPS_BAUD=$CURRENT_BAUD" >&2
    echo "  to confirm it's still reachable there before troubleshooting further." >&2
    exit 1
  fi
  echo "Confirmed: module now answering at $GPS_BAUD."
else
  echo "Already at the target baud ($GPS_BAUD) - nothing to raise."
fi

echo
echo "Configuring the GPS module on $GPS_PORT @ $GPS_BAUD baud, UART$GPS_UART..."

# Enable UBX-NAV-PVT on the module's UART the wiring reaches, persisted to
# RAM+BBR+Flash (the trailing ,7 - layer bitmask RAM=1/BBR=2/Flash=4, 7
# writes all three) so it survives a power cycle, not just this session.
ubxtool -f "$GPS_PORT" -s "$GPS_BAUD" -P 27.11 -z "CFG-MSGOUT-UBX_NAV_PVT_UART${GPS_UART},1,7"

if [ "$DISABLE_NMEA" = "1" ]; then
  ubxtool -f "$GPS_PORT" -s "$GPS_BAUD" -P 27.11 -z "CFG-UART${GPS_UART}OUTPROT-NMEA,0,7"
fi

echo
echo "Done. Verify:"
echo "  stty -F $GPS_PORT $GPS_BAUD raw -echo && cat $GPS_PORT"
echo "    -> expect quiet gaps with a short binary burst about once a second, no NMEA text"
echo "    -> if it's still readable NMEA text instead, GPS_UART=$GPS_UART is the wrong UART"
echo "       number for your wiring - undo it (CFG-MSGOUT-UBX_NAV_PVT_UART${GPS_UART},0,7) and"
echo "       re-run with the other UART number (GPS_UART=1 or 2)"
echo "  GPS_PORT=$GPS_PORT GPS_BAUD=$GPS_BAUD npm run boat"
echo "    -> the check that actually matters: watch for [gps] lines with real"
echo "       fixType/numSV values, not just raw bytes 'looking' correct - and confirm"
echo "       it's running as $SERVICE_USER (or whoever install-service.sh set up),"
echo "       not root, so the dialout group membership above actually gets exercised"
