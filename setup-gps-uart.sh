#!/usr/bin/env bash
set -euo pipefail

# setup-gps-uart.sh
#
# Frees the Pi's hardware UART (GPIO14/15) from the serial console and
# Bluetooth, then configures a u-blox GPS module wired to it (UBX-NAV-PVT
# on, NMEA off) - automates the manual steps in README's "Wiring notes"/
# "GPS configuration" sections. Idempotent and safe to re-run: it only ever
# changes what isn't already set the way it wants.
#
# THIS NEEDS A REBOOT PARTWAY THROUGH. config.txt/cmdline.txt changes only
# take effect at boot, so this script can't free the UART and configure the
# module in one pass - it detects which phase it's in and tells you what to
# do next:
#   sudo ./setup-gps-uart.sh            # phase 1: free the UART (may reboot)
#   sudo reboot                         # only if phase 1 changed anything
#   sudo ./setup-gps-uart.sh            # phase 2: configure the GPS module
#
# Env vars (all optional):
#   GPS_PORT      - default /dev/ttyAMA0
#   GPS_BAUD      - default 115200 (the module's CURRENT baud - this script
#                   doesn't change it, only matches it; see --detect-baud)
#   GPS_UART      - which UART NUMBER on the module your wiring reaches (1
#                   or 2) - default 1. Depends on the board/breakout, not
#                   something this script can know - see README's "Wiring
#                   notes" on ArduSimple's simpleRTK2B routing UART2 to its
#                   XBee socket, so a direct wire to a general breakout pin
#                   is more likely UART1, but verify (see the end of this
#                   script's own output) rather than assume.
#   DISABLE_NMEA  - default 1 (turn NMEA off on this UART once UBX-NAV-PVT
#                   is on, to stop wasting airtime/bandwidth on unneeded
#                   chatter). Set to 0 to leave NMEA on - the app's own UBX
#                   parser isn't confused by NMEA sharing the line either
#                   way, so this is purely a bandwidth choice, not a
#                   correctness one.
#
# Usage:
#   sudo ./setup-gps-uart.sh                 # normal run
#   sudo ./setup-gps-uart.sh --detect-baud   # phase 2 only: try common
#                                             # bauds against GPS_PORT and
#                                             # print which one gets clean
#                                             # NMEA text, instead of
#                                             # assuming GPS_BAUD is right

if [ "$(id -u)" -ne 0 ]; then
  echo "error: this needs root - run with sudo" >&2
  echo "usage: sudo $0 [--detect-baud]" >&2
  exit 1
fi

GPS_PORT="${GPS_PORT:-/dev/ttyAMA0}"
GPS_BAUD="${GPS_BAUD:-115200}"
GPS_UART="${GPS_UART:-1}"
DISABLE_NMEA="${DISABLE_NMEA:-1}"

# Bookworm+ moved these under /boot/firmware/ - fall back to the older
# /boot/ location so this doesn't silently edit nothing on an older image.
CONFIG_TXT="/boot/firmware/config.txt"
CMDLINE_TXT="/boot/firmware/cmdline.txt"
if [ ! -f "$CONFIG_TXT" ]; then CONFIG_TXT="/boot/config.txt"; fi
if [ ! -f "$CMDLINE_TXT" ]; then CMDLINE_TXT="/boot/cmdline.txt"; fi

if [ "${1:-}" = "--detect-baud" ]; then
  echo "Trying common bauds on $GPS_PORT - Ctrl-C once you see clean \$GNGGA/\$GNRMC/... text,"
  echo "or let each one run its 2s window if it's silent/garbled:"
  for b in 9600 19200 38400 57600 115200; do
    echo "--- $b ---"
    stty -F "$GPS_PORT" "$b" raw -echo
    timeout 2 cat "$GPS_PORT" || true
  done
  echo
  echo "Whichever baud showed clean text above is GPS_BAUD - re-run this script with it set."
  exit 0
fi

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

echo "Configuring the GPS module on $GPS_PORT @ $GPS_BAUD baud, UART$GPS_UART..."
echo "(don't assume this baud/UART number is right just because it worked over USB or"
echo "on a different Pi - each UART configures independently; use --detect-baud first"
echo "if you haven't confirmed GPS_BAUD against THIS wiring, and see the end of this"
echo "script's output for how to tell if GPS_UART is the wrong one.)"

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
echo "       fixType/numSV values, not just raw bytes 'looking' correct"
