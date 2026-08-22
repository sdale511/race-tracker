#!/usr/bin/env bash
set -euo pipefail

# Sets (or changes) which WiFi network this Pi joins from the command line -
# no desktop/raspi-config UI needed. For a boat Pi, this is normally the
# base station's own WiFi (see README's "Log upload over WiFi" - that's
# what lets uploadClient.js actually reach the base whenever in range).
#
# Usage:
#   sudo ./set-wifi.sh "<SSID>" "<PASSWORD>"
#   sudo ./set-wifi.sh                        # adds every default network below
#   sudo ./set-wifi.sh "<SSID>"                # prompts for password, unless SSID is a default
#
# Leave PASSWORD empty (just press enter at the prompt, or pass "") for an
# open network with no password.
#
# With no SSID given at all, adds every network in DEFAULT_SSIDS/
# DEFAULT_PASSWORDS below rather than prompting - the common case for a
# fresh boat Pi, and safe to re-run any time (see the module comment above:
# this only ever adds/updates the profile(s) it's given, never touches
# other saved networks).
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

# Known networks for this event, in matching order - a no-argument run adds
# ALL of these (see main() below), and typing one of these SSIDs explicitly
# with no PASSWORD arg looks its password up here instead of prompting.
DEFAULT_SSIDS=("JYC RC" "Rustybit" "Bondi-Van" "JYC Outer")
DEFAULT_PASSWORDS=("headjudge" "gogoshop" "gogobondi" "jycsailing")

# Prints the known password for $1 on stdout and returns 0, or returns 1 if
# it's not one of DEFAULT_SSIDS above.
default_password_for() {
  local ssid="$1" i
  for i in "${!DEFAULT_SSIDS[@]}"; do
    if [ "${DEFAULT_SSIDS[$i]}" = "$ssid" ]; then
      printf '%s' "${DEFAULT_PASSWORDS[$i]}"
      return 0
    fi
  done
  return 1
}

# Adds/updates one network profile ($1 SSID, $2 password - may be empty for
# an open network). Split out so the no-argument case below can call this
# once per default network instead of duplicating the raspi-config/nmcli
# dispatch.
set_one_wifi() {
  local ssid="$1" password="$2"
  if command -v raspi-config >/dev/null 2>&1; then
    if [ -n "$password" ]; then
      raspi-config nonint do_wifi_ssid_passphrase "$ssid" "$password"
    else
      raspi-config nonint do_wifi_ssid_passphrase "$ssid"
    fi
    echo "WiFi set via raspi-config: \"$ssid\""
  elif command -v nmcli >/dev/null 2>&1; then
    if [ -n "$password" ]; then
      nmcli dev wifi connect "$ssid" password "$password"
    else
      nmcli dev wifi connect "$ssid"
    fi
    echo "WiFi set via NetworkManager: \"$ssid\""
  else
    echo "error: neither raspi-config nor nmcli found - don't know how to configure WiFi on this system" >&2
    exit 1
  fi
}

if [ $# -eq 0 ]; then
  # No SSID given at all - add every default network rather than prompting.
  for i in "${!DEFAULT_SSIDS[@]}"; do
    set_one_wifi "${DEFAULT_SSIDS[$i]}" "${DEFAULT_PASSWORDS[$i]}"
  done
  exit 0
fi

SSID="$1"

if [ $# -ge 2 ]; then
  PASSWORD="$2"
elif PASSWORD="$(default_password_for "$SSID")"; then
  : # known network - password resolved above, nothing to prompt for
else
  read -rsp "WiFi password (leave blank for an open network): " PASSWORD
  echo
fi

set_one_wifi "$SSID" "$PASSWORD"
