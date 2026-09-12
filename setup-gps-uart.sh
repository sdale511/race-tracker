#!/usr/bin/env bash
set -euo pipefail

# setup-gps-uart.sh
#
# Frees the Pi's hardware UART (GPIO14/15, /dev/ttyAMA0) from the serial
# console and Bluetooth - automates the manual steps in README's "Wiring
# notes" section. Idempotent and safe to re-run: it only ever changes what
# isn't already set the way it wants. Doesn't touch the GPS module itself
# (baud/UBX-NAV-PVT/NMEA) - see README's "GPS configuration" section for
# that, once the UART is confirmed working.
#
# THIS NEEDS A REBOOT TO TAKE EFFECT. config.txt/cmdline.txt changes only
# apply at boot - editing them (or running this script) doesn't do
# anything live:
#   sudo ./setup-gps-uart.sh
#   sudo reboot
#   ls -la /dev/ttyAMA0 /dev/ttyS0 /dev/serial0 /dev/serial1   # confirm

if [ "$(id -u)" -ne 0 ]; then
  echo "error: this needs root - run with sudo" >&2
  echo "usage: sudo $0" >&2
  exit 1
fi

# Bookworm+ moved these under /boot/firmware/ - fall back to the older
# /boot/ location so this doesn't silently edit nothing on an older image.
CONFIG_TXT="/boot/firmware/config.txt"
CMDLINE_TXT="/boot/firmware/cmdline.txt"
if [ ! -f "$CONFIG_TXT" ]; then CONFIG_TXT="/boot/config.txt"; fi
if [ ! -f "$CMDLINE_TXT" ]; then CMDLINE_TXT="/boot/cmdline.txt"; fi

echo "config: $CONFIG_TXT"
echo "cmdline: $CMDLINE_TXT"
echo

CHANGED=0

# "serial port hardware enabled = Yes" in raspi-config terms - ensures the
# UART is actually enabled and the mini-UART's clock is fixed to the CPU's
# real frequency (matters even once ttyAMA0 is freed, since the mini-UART
# doesn't just disappear).
if ! grep -q '^enable_uart=1' "$CONFIG_TXT"; then
  echo "enable_uart=1" >> "$CONFIG_TXT"
  echo "Added enable_uart=1 to $CONFIG_TXT"
  CHANGED=1
fi

# "login shell over serial = No" - cmdline.txt ships with a
# console=serial0,115200 (or console=ttyAMA0,...) token by default, which
# claims the UART for a login shell instead of leaving it free for the GPS.
if grep -qE 'console=(serial0|ttyAMA0),[0-9]+' "$CMDLINE_TXT"; then
  sed -i -E 's/console=(serial0|ttyAMA0),[0-9]+ ?//g' "$CMDLINE_TXT"
  echo "Removed serial console from $CMDLINE_TXT"
  CHANGED=1
fi

# On any Pi with onboard Bluetooth (Zero 2 W, 3A+/3B+, 4, etc.), the above
# alone isn't enough - GPIO14/15 default to the mini-UART (ttyS0), not the
# real hardware UART (ttyAMA0), because Bluetooth occupies the real one.
if ! grep -q '^dtoverlay=disable-bt' "$CONFIG_TXT"; then
  echo "dtoverlay=disable-bt" >> "$CONFIG_TXT"
  echo "Added dtoverlay=disable-bt to $CONFIG_TXT"
  CHANGED=1
fi

# Safe to run every time regardless of CHANGED - a plain "already disabled"
# no-op if these were already off from a previous run.
systemctl disable --now hciuart 2>/dev/null || true
systemctl disable --now bluealsa.service 2>/dev/null || true
systemctl disable --now bluetooth.service 2>/dev/null || true

echo
if [ "$CHANGED" -eq 1 ]; then
  echo "Config changed - reboot required before /dev/ttyAMA0 exists correctly:"
  echo "  sudo reboot"
  echo "Then confirm: ls -la /dev/ttyAMA0 /dev/ttyS0 /dev/serial0 /dev/serial1"
else
  echo "Already configured (enable_uart=1, no serial console, Bluetooth disabled)."
  echo "If /dev/ttyAMA0 still doesn't behave as expected, it's already had its reboot -"
  echo "check the actual device nodes: ls -la /dev/ttyAMA0 /dev/ttyS0 /dev/serial0 /dev/serial1"
fi
