#!/usr/bin/env bash
set -euo pipefail

# Sets (or changes) which WiFi network this Pi joins from the command line -
# no desktop/raspi-config UI needed. For a boat Pi, this is normally the
# base station's own WiFi (see README's "Log upload over WiFi" - that's
# what lets uploadClient.js actually reach the base whenever in range).
#
# Usage:
#   sudo ./set-wifi.sh "<SSID>" "<PASSWORD>"
#   sudo ./set-wifi.sh                        # prompts for both
#   sudo ./set-wifi.sh "<SSID>"                # prompts for password only
#
# Leave PASSWORD empty (just press enter at the prompt, or pass "") for an
# open network with no password.
#
# Prefers `raspi-config`'s own non-interactive helper, since it adapts to
# whichever network backend this particular OS image actually uses
# (NetworkManager on current Raspberry Pi OS, wpa_supplicant/dhcpcd on
# older ones) instead of this script having to guess; falls back to nmcli
# directly if raspi-config isn't installed.
#
# If the Pi won't associate with anything at all afterward, it may not
# have a WiFi country code set yet (some regulatory domains refuse to
# scan/transmit until one is) - `sudo raspi-config nonint do_wifi_country US`
# (swap in the right country code) fixes that; not something this script
# sets automatically since it's a one-time thing, not per-network.

if [ "$(id -u)" -ne 0 ]; then
  echo "error: configuring WiFi needs root - run with sudo" >&2
  echo "usage: sudo $0 <SSID> [PASSWORD]" >&2
  exit 1
fi

SSID="${1:-}"
if [ -z "$SSID" ]; then
  read -rp "WiFi network name (SSID): " SSID
fi
if [ -z "$SSID" ]; then
  echo "error: SSID cannot be empty" >&2
  exit 1
fi

if [ $# -ge 2 ]; then
  PASSWORD="$2"
else
  read -rsp "WiFi password (leave blank for an open network): " PASSWORD
  echo
fi

if command -v raspi-config >/dev/null 2>&1; then
  if [ -n "$PASSWORD" ]; then
    raspi-config nonint do_wifi_ssid_passphrase "$SSID" "$PASSWORD"
  else
    raspi-config nonint do_wifi_ssid_passphrase "$SSID"
  fi
  echo "WiFi set via raspi-config: \"$SSID\""
elif command -v nmcli >/dev/null 2>&1; then
  if [ -n "$PASSWORD" ]; then
    nmcli dev wifi connect "$SSID" password "$PASSWORD"
  else
    nmcli dev wifi connect "$SSID"
  fi
  echo "WiFi set via NetworkManager: \"$SSID\""
else
  echo "error: neither raspi-config nor nmcli found - don't know how to configure WiFi on this system" >&2
  exit 1
fi
