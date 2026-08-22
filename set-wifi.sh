#!/usr/bin/env bash
set -euo pipefail

# Sets (or changes) which WiFi network this Pi joins from the command line -
# no desktop/raspi-config UI needed. For a boat Pi, this is normally the
# base station's own WiFi (see README's "Log upload over WiFi" - that's
# what lets uploadClient.js actually reach the base whenever in range).
#
# Usage:
#   sudo ./set-wifi.sh "<SSID>" "<PASSWORD>"
#   sudo ./set-wifi.sh                        # saves every default network below
#   sudo ./set-wifi.sh "<SSID>"                # prompts for password, unless SSID is a default
#   ./set-wifi.sh -list                        # lists saved networks (no sudo needed)
#
# Leave PASSWORD empty (just press enter at the prompt, or pass "") for an
# open network with no password.
#
# With no SSID given at all, saves every network in DEFAULT_SSIDS/
# DEFAULT_PASSWORDS below rather than prompting - the common case for a
# fresh boat Pi, and safe to re-run any time (this only ever adds/updates
# the profile(s) it's given, never touches other saved networks).
#
# Prefers `nmcli` (NetworkManager, the backend on current Raspberry Pi OS) to
# SAVE the credentials as a connection profile rather than connect right
# now - the network does NOT need to be in range for this, unlike `nmcli
# device wifi connect` (or raspi-config's own do_wifi_ssid_passphrase, which
# delegates to that same "connect now" call on current Raspberry Pi OS
# images - confirmed by "Error: No network with SSID '...' found." when it
# isn't). NetworkManager auto-joins a saved profile itself the moment that
# SSID actually comes into range, so this is exactly what pre-provisioning
# several event networks at once needs, even when the Pi isn't near most of
# them yet. Falls back to raspi-config directly only if nmcli isn't
# installed (an older, non-NetworkManager Pi OS image) - that path saves to
# wpa_supplicant.conf directly, which is likewise range-independent.
#
# If the Pi won't associate with anything at all afterward, it may not
# have a WiFi country code set yet (some regulatory domains refuse to
# scan/transmit until one is) - `sudo raspi-config nonint do_wifi_country US`
# (swap in the right country code) fixes that; not something this script
# sets automatically since it's a one-time thing, not per-network.

# Known networks for this event, in matching order - a no-argument run saves
# ALL of these, and typing one of these SSIDs explicitly with no PASSWORD
# arg looks its password up here instead of prompting.
DEFAULT_SSIDS=("JYC RC" "Rustybit" "Bondi-Van" "JYC Outer")
DEFAULT_PASSWORDS=("headjudge" "gogoshop" "gogobondi" "jycsailing")

# Prints every saved WiFi network's name (and whether it's the one currently
# connected) - read-only, so unlike everything below it doesn't need sudo.
list_wifi() {
  if command -v nmcli >/dev/null 2>&1; then
    echo "Saved WiFi networks (NetworkManager):"
    # TYPE reads "802-11-wireless" on older nmcli, "wifi" on newer - match
    # both rather than assume one. ACTIVE=yes marks the one actually joined
    # right now, if any.
    nmcli -t -f NAME,TYPE,ACTIVE connection show | awk -F: '
      $2 == "802-11-wireless" || $2 == "wifi" {
        printf "  %-24s %s\n", $1, ($3 == "yes" ? "(connected now)" : "")
      }'
  elif command -v raspi-config >/dev/null 2>&1; then
    if [ -f /etc/wpa_supplicant/wpa_supplicant.conf ]; then
      echo "Saved WiFi networks (wpa_supplicant):"
      grep -oP '(?<=ssid=").*(?=")' /etc/wpa_supplicant/wpa_supplicant.conf | sed 's/^/  /'
    else
      echo "No saved networks found (/etc/wpa_supplicant/wpa_supplicant.conf missing)"
    fi
  else
    echo "error: neither nmcli nor raspi-config found - don't know how to list WiFi on this system" >&2
    exit 1
  fi
}

for arg in "$@"; do
  case "$arg" in
    -list | --list)
      list_wifi
      exit 0
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "error: configuring WiFi needs root - run with sudo" >&2
  echo "usage: sudo $0 <SSID> [PASSWORD]" >&2
  exit 1
fi

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

# Adds/updates one saved network profile ($1 SSID, $2 password - may be
# empty for an open network). Split out so the no-argument case below can
# call this once per default network instead of duplicating the nmcli/
# raspi-config dispatch. Returns the underlying tool's own exit status - the
# caller relies on this (see the no-argument loop below, which treats a
# nonzero return as "skip this one, keep going") rather than the "WiFi
# saved" line alone, which is only ever printed on an actual success.
set_one_wifi() {
  local ssid="$1" password="$2" rc
  if command -v nmcli >/dev/null 2>&1; then
    # Delete-then-add rather than modify-in-place, so re-running this for an
    # SSID whose password changed always ends up with exactly the given
    # credentials, not a stale mix of old+new fields. Not an error if no
    # profile with this name exists yet (the common case).
    nmcli connection delete "$ssid" >/dev/null 2>&1 || true
    if [ -n "$password" ]; then
      nmcli connection add type wifi con-name "$ssid" ifname '*' ssid "$ssid" \
        wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$password" >/dev/null
    else
      nmcli connection add type wifi con-name "$ssid" ifname '*' ssid "$ssid" >/dev/null
    fi
    rc=$?
    [ "$rc" -eq 0 ] && echo "WiFi saved (auto-joins once in range): \"$ssid\""
    return "$rc"
  elif command -v raspi-config >/dev/null 2>&1; then
    if [ -n "$password" ]; then
      raspi-config nonint do_wifi_ssid_passphrase "$ssid" "$password"
    else
      raspi-config nonint do_wifi_ssid_passphrase "$ssid"
    fi
    rc=$?
    [ "$rc" -eq 0 ] && echo "WiFi set via raspi-config: \"$ssid\""
    return "$rc"
  else
    echo "error: neither nmcli nor raspi-config found - don't know how to configure WiFi on this system" >&2
    exit 1
  fi
}

if [ $# -eq 0 ]; then
  # No SSID given at all - save every default network. Each one is isolated
  # (a failure on one doesn't abort the rest) mainly as a safety net now
  # that range is no longer a concern - see set_one_wifi's own comment.
  for i in "${!DEFAULT_SSIDS[@]}"; do
    if ! set_one_wifi "${DEFAULT_SSIDS[$i]}" "${DEFAULT_PASSWORDS[$i]}"; then
      echo "warning: failed to set \"${DEFAULT_SSIDS[$i]}\" - continuing with the rest" >&2
    fi
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
