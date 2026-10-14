#!/usr/bin/env bash
set -euo pipefail

# setup-gps-uart.sh
#
# Gets /dev/ttyAMA0 ready for this app to read GPS fixes from:
#   1. Frees the Pi's hardware UART (GPIO14/15) from the serial console and
#      Bluetooth - automates README's "Wiring notes" section.
#   2. Makes sure the user this app actually runs as (see
#      install-service.sh) can open the port at all - dialout group
#      membership, not just the device node existing.
# Idempotent and safe to re-run: each step only changes what isn't already
# set the way it wants.
#
# It does NOT configure the GPS module or the radios. The rovers only read:
# the ZED-F9P is set up from a computer with ubx_config_set.py (--role
# rover) and the XBee with xbee_configure_at.py - see README's "GPS
# configuration". Nothing here installs gpsd/ubxtool.
#
# THIS NEEDS A REBOOT. config.txt/cmdline.txt changes only apply at boot:
#   sudo ./setup-gps-uart.sh            # frees the UART (may ask for a reboot)
#   sudo reboot                         # only if it changed anything
#   sudo ./setup-gps-uart.sh            # re-run to confirm the port is there
#
# Env vars (all optional):
#   GPS_PORT      - default /dev/ttyAMA0 - only used for the final check that
#                   the port exists.
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
  echo "Config changed - reboot required before the UART is free (config.txt/cmdline.txt"
  echo "changes only take effect at boot, editing them doesn't do anything live):"
  echo "  sudo reboot"
  echo "Then re-run this script to confirm $GPS_PORT is there."
  exit 0
fi

echo "UART already freed (enable_uart=1, no serial console, Bluetooth disabled)."
echo

if [ ! -e "$GPS_PORT" ]; then
  echo "error: $GPS_PORT still doesn't exist after freeing the UART." >&2
  echo "  Check: ls -la /dev/ttyAMA0 /dev/ttyS0 /dev/serial0 /dev/serial1" >&2
  exit 1
fi

echo "$GPS_PORT is present. This script does not configure the GPS module - the rover only reads it."
echo "Next:"
echo "  1. Set the ZED-F9P up from a computer (see README's \"GPS configuration\"):"
echo "       python3 ubx_config_set.py --port <the board's USB port> --role rover --dry-run"
echo "  2. Check the Pi sees fixes:"
echo "       stty -F $GPS_PORT 115200 raw -echo && cat $GPS_PORT"
echo "         -> expect quiet gaps with a short binary burst, no NMEA text"
echo "       GPS_PORT=$GPS_PORT GPS_BAUD=115200 npm run boat"
echo "         -> watch for [gps] lines with real fixType/numSV values, running as $SERVICE_USER, not root"
