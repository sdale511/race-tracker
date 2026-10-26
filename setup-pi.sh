#!/usr/bin/env bash
set -euo pipefail

# setup-pi.sh
#
# Sets up a Raspberry Pi to run race-tracker, from a fresh Raspberry Pi OS image to a running systemd service, in sections
# that can each be run on their own. Every section is safe to re-run: it checks first and only changes what isn't already
# the way it wants (apt upgrades whatever is new, which is the point of running it again).
#
#   update   apt update + full-upgrade, and the tools the rest needs (git, curl)
#   node     Node.js LTS from NodeSource, unless node $NODE_MIN_MAJOR+ is already installed
#   repo     git pull --ff-only this checkout (skipped when it has local changes)
#   deps     npm ci --omit=dev, only when package-lock.json or the node version changed since the last run
#   uart     frees the Pi's hardware UART for the GPS (serial console and Bluetooth off, dialout group) - needs a reboot
#            the first time
#   wifi     saves the event WiFi networks (set-wifi.sh) - ones already saved with the same password are left alone - and
#            installs race-tracker-wifi.service, which puts back any of them that went missing at every boot
#   service  installs and starts the systemd service for --mode (install-service.sh)
#   verify   read-only: checks all of the above and says what's missing (no sudo needed)
#   fix      runs verify, re-runs just the sections behind what failed or warned, then verifies again
#   run      runs the mode in the foreground (npm run <mode>) for a manual test - not part of "all"
#   autoupdate  installs race-tracker-update.service: at every boot, before the app starts, a git pull and node_modules
#            update when the Pi has a network (see boot-pull) - every mode
#   all      update node repo deps uart wifi service autoupdate verify, in that order
#
# Usage:
#   sudo ./setup-pi.sh all --mode boat              # a whole boat Pi
#   sudo ./setup-pi.sh all --mode boat --id 7       # pinned BOAT_ID 00007 (see install-service.sh for --id per mode)
#   sudo ./setup-pi.sh deps service --mode base     # just those sections
#   sudo ./setup-pi.sh wifi --ssid "Club" --password "secret"
#   ./setup-pi.sh verify                            # what's set up and what isn't
#   sudo ./setup-pi.sh fix                          # put right whatever verify found
#   sudo ./setup-pi.sh run --mode boat              # foreground test run (stop the service first)
#
# Options:
#   --mode MODE     boat | base | rtk | basertk | mark - needed by service and run; verify and run find it from an
#                   installed service when there is exactly one
#   --id ARG        the mode's extra argument for install-service.sh (BOAT_ID / REGATTAUP_REGATTA_ID / MARK_NAME)
#   --ssid S        wifi: save just this network (with --password, or set-wifi.sh's known password, or a prompt)
#   --password P    wifi: the password for --ssid ("" for an open network)
#   --reboot        reboot at the end if anything needs it (the UART changes, a new kernel)
#
# On a fresh Pi, the checkout has to come first:
#   sudo apt update && sudo apt install -y git
#   git clone https://github.com/sdale511/race-tracker.git && cd race-tracker
#   sudo ./setup-pi.sh all --mode boat --reboot
#   ./setup-pi.sh verify                            # after the reboot
#
# Env vars: NODE_MIN_MAJOR (default 20), GPS_PORT (default /dev/ttyAMA0).

NODE_MIN_MAJOR="${NODE_MIN_MAJOR:-20}"
GPS_PORT="${GPS_PORT:-/dev/ttyAMA0}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$REPO_DIR/$(basename "${BASH_SOURCE[0]}")"
ALL_SECTIONS=(update node repo deps uart wifi service autoupdate verify)
MODES="boat base rtk basertk mark"
# Set by the uart section when the boot config changed; /run is cleared at boot, so it goes away with the reboot it asks for.
REBOOT_MARKER="/run/race-tracker-setup-reboot"
# Runs set-wifi.sh at every boot, so a default network whose profile went missing is saved again (see do_wifi).
WIFI_UNIT="race-tracker-wifi"
# Pulls the latest code at every boot, before the app's service starts (see do_autoupdate and do_boot_pull).
UPDATE_UNIT="race-tracker-update"
# How long boot-pull waits for a network that reaches GitHub before giving up and letting the app start on the code it has.
BOOT_PULL_WAIT_S="${BOOT_PULL_WAIT_S:-45}"
# Written into node_modules by the deps section: the lock file's hash and node's major version it was installed with.
DEPS_STAMP="$REPO_DIR/node_modules/.setup-pi-stamp"

ORIGINAL_ARGS=("$@")
SECTIONS=()
MODE=""
EXTRA_ARG=""
WIFI_SSID=""
WIFI_PASSWORD=""
WIFI_PASSWORD_SET=0
DO_REBOOT=0

usage() {
  # the header comment above, from its first line after the shebang/set to the first non-comment line
  awk 'NR >= 4 && /^#/ { sub(/^# ?/, ""); print; next } NR >= 4 { exit }' "$SCRIPT_PATH"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --id) EXTRA_ARG="${2:-}"; shift 2 ;;
    --ssid) WIFI_SSID="${2:-}"; shift 2 ;;
    --password) WIFI_PASSWORD="${2:-}"; WIFI_PASSWORD_SET=1; shift 2 ;;
    --reboot) DO_REBOOT=1; shift ;;
    -h | --help | help) usage; exit 0 ;;
    all) SECTIONS+=("${ALL_SECTIONS[@]}"); shift ;;
    update | node | repo | deps | uart | wifi | service | autoupdate | boot-pull | verify | fix | run) SECTIONS+=("$1"); shift ;;
    *) echo "error: unknown section or option \"$1\"" >&2; echo "sections: ${ALL_SECTIONS[*]} run all   (--help for more)" >&2; exit 1 ;;
  esac
done

if [ ${#SECTIONS[@]} -eq 0 ]; then
  usage
  exit 1
fi
if [ -n "$MODE" ] && ! [[ " $MODES " == *" $MODE "* ]]; then
  echo "error: --mode must be one of: $MODES (got \"$MODE\")" >&2
  exit 1
fi
# Caught before anything runs rather than halfway through.
if [[ " ${SECTIONS[*]} " == *" service "* ]] && [ -z "$MODE" ]; then
  echo "error: the service section needs --mode ($MODES)" >&2
  exit 1
fi
for s in "${SECTIONS[@]}"; do
  case "$s" in
    verify | run) ;;
    *)
      if [ "$(id -u)" -ne 0 ]; then
        echo "error: section \"$s\" needs root - run with sudo (only verify works without it)" >&2
        exit 1
      fi
      ;;
  esac
done

# ---- output ----------------------------------------------------------------------------------------------------------

FAILS=0
WARNS=0
section() { printf '\n== %s ==\n' "$1"; }
info() { printf '   %s\n' "$*"; }
ok() { printf '   ok    %s\n' "$*"; }
warn() { printf '   WARN  %s\n' "$*"; WARNS=$((WARNS + 1)); needs_section "$*"; }
bad() { printf '   FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); needs_section "$*"; }

# A check's message names the section that puts it right - "(section: uart)" - and fix re-runs those sections.
FIX_SECTIONS=()
needs_section() {
  local s
  s="$(printf '%s' "$1" | sed -nE 's/.*\(section: ([a-z]+).*/\1/p')"
  [ -n "$s" ] || return 0
  [[ " ${FIX_SECTIONS[*]:-} " == *" $s "* ]] || FIX_SECTIONS+=("$s")
}
die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }

# ---- helpers ---------------------------------------------------------------------------------------------------------

is_root() { [ "$(id -u)" -eq 0 ]; }

# The user the app runs as: whoever invoked sudo (install-service.sh insists on the same), or the current user for verify.
if [ -n "${SUDO_USER:-}" ]; then
  SERVICE_USER="$SUDO_USER"
elif [ "$(id -u)" -eq 0 ] && [ -d "$REPO_DIR/.git" ]; then
  # Run by systemd at boot (boot-pull), not through sudo: the checkout's owner is the app's user
  SERVICE_USER="$(stat -c %U "$REPO_DIR" 2>/dev/null || id -un)"
else
  SERVICE_USER="$(id -un)"
fi

need_root() {
  is_root || die "section \"$1\" needs root - run with sudo"
  if [ "$SERVICE_USER" = "root" ]; then
    die "run via sudo as the user who should own the app (not directly as root), e.g. sudo $0 $1"
  fi
}

as_user() {
  if is_root; then sudo -u "$SERVICE_USER" -H "$@"; else "$@"; fi
}

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -v | sed -E 's/^v([0-9]+).*/\1/'
}

deps_stamp() {
  local lock="$REPO_DIR/package-lock.json"
  [ -f "$lock" ] || lock="$REPO_DIR/package.json"
  echo "$(sha256sum "$lock" | cut -d' ' -f1) node$(node_major)"
}

# unit_for_mode and installed_modes are shared with the service-*.sh scripts
# shellcheck source=service-mode.sh
source "$REPO_DIR/service-mode.sh"

# The mode of the one installed race-tracker service, when there is exactly one.
detect_mode() {
  local found
  found="$(installed_modes)"
  [ -n "$found" ] && [[ "$found" != *" "* ]] && echo "$found"
}

boot_file() {
  if [ -f "/boot/firmware/$1" ]; then echo "/boot/firmware/$1"; else echo "/boot/$1"; fi
}

reboot_pending() { [ -f "$REBOOT_MARKER" ] || [ -f /var/run/reboot-required ]; }

# ---- sections --------------------------------------------------------------------------------------------------------

do_update() {
  section "update: apt packages"
  need_root update
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold full-upgrade
  apt-get install -y git curl ca-certificates
  ok "packages up to date"
  if [ -f /var/run/reboot-required ]; then info "the upgrade needs a reboot (a new kernel or firmware)"; fi
}

do_node() {
  section "node: Node.js $NODE_MIN_MAJOR+"
  local major
  major="$(node_major)"
  if [ "$major" -ge "$NODE_MIN_MAJOR" ]; then
    ok "node $(node -v) already installed, npm $(npm -v)"
    return
  fi
  need_root node
  info "node $([ "$major" -eq 0 ] && echo "not installed" || node -v) - installing the current LTS from NodeSource"
  command -v curl >/dev/null 2>&1 || apt-get install -y curl ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
  apt-get install -y nodejs
  major="$(node_major)"
  [ "$major" -ge "$NODE_MIN_MAJOR" ] || die "node is still $(node -v 2>/dev/null || echo missing) after the install"
  ok "node $(node -v), npm $(npm -v)"
}

do_repo() {
  section "repo: $REPO_DIR"
  [ -d "$REPO_DIR/.git" ] || die "$REPO_DIR is not a git checkout - clone it first (see --help)"
  local branch before after
  branch="$(as_user git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)"
  if [ "$branch" = "HEAD" ]; then
    warn "detached HEAD - not pulling"
    return
  fi
  if [ -n "$(as_user git -C "$REPO_DIR" status --porcelain --untracked-files=no)" ]; then
    warn "local changes in the checkout - not pulling (git -C $REPO_DIR status)"
    return
  fi
  before="$(sha256sum "$SCRIPT_PATH" | cut -d' ' -f1)"
  as_user git -C "$REPO_DIR" pull --ff-only
  ok "$branch at $(as_user git -C "$REPO_DIR" log -1 --format='%h %s' | cut -c1-80)"
  after="$(sha256sum "$SCRIPT_PATH" | cut -d' ' -f1)"
  if [ "$before" != "$after" ] && [ -z "${SETUP_PI_REEXEC:-}" ]; then
    # This script itself changed: carry on with the new copy rather than the old one bash already has open.
    info "setup-pi.sh was updated - re-running the new copy for the remaining sections"
    REEXEC=1
  fi
}

do_deps() {
  section "deps: node_modules"
  need_root deps
  [ "$(node_major)" -ge "$NODE_MIN_MAJOR" ] || die "node $NODE_MIN_MAJOR+ is needed first (run the node section)"
  local want
  want="$(deps_stamp)"
  if [ -d "$REPO_DIR/node_modules" ] && [ -f "$DEPS_STAMP" ] && [ "$(cat "$DEPS_STAMP")" = "$want" ]; then
    ok "node_modules already matches package-lock.json"
    return
  fi
  if [ -f "$REPO_DIR/package-lock.json" ]; then
    as_user npm --prefix "$REPO_DIR" ci --omit=dev
  else
    as_user npm --prefix "$REPO_DIR" install --omit=dev
  fi
  echo "$want" | as_user tee "$DEPS_STAMP" >/dev/null
  ok "installed"
}

# Frees the Pi's hardware UART (GPIO14/15, $GPS_PORT) for the GPS and lets the app's user open it. It does not configure the
# GPS module or the radios - the rovers only read; the ZED-F9P is set up from a computer with ubx_config_set.py and the XBee
# with xbee_configure_at.py (README's "GPS configuration"). config.txt/cmdline.txt changes only apply at boot.
do_uart() {
  section "uart: GPS serial port"
  need_root uart
  local cfg cmd changed=0
  cfg="$(boot_file config.txt)"
  cmd="$(boot_file cmdline.txt)"
  [ -f "$cfg" ] && [ -f "$cmd" ] || die "no $cfg / $cmd - not a Raspberry Pi?"
  # The UART on, with the mini-UART's clock fixed to the CPU's real frequency
  if ! grep -q '^enable_uart=1' "$cfg"; then
    echo "enable_uart=1" >> "$cfg"
    info "added enable_uart=1 to $cfg"
    changed=1
  fi
  # No login shell on the serial port: cmdline.txt ships with console=serial0,115200, which claims the UART
  if grep -qE 'console=(serial0|ttyAMA0),[0-9]+' "$cmd"; then
    sed -i -E 's/console=(serial0|ttyAMA0),[0-9]+ ?//g' "$cmd"
    info "removed the serial console from $cmd"
    changed=1
  fi
  # On a Pi with onboard Bluetooth, GPIO14/15 get the mini-UART (ttyS0) while Bluetooth has the real one (ttyAMA0)
  if ! grep -q '^dtoverlay=disable-bt' "$cfg"; then
    echo "dtoverlay=disable-bt" >> "$cfg"
    info "added dtoverlay=disable-bt to $cfg"
    changed=1
  fi
  local svc
  for svc in hciuart bluealsa bluetooth; do
    systemctl disable --now "$svc" >/dev/null 2>&1 || true
  done
  # The app's user can open the port (applies from its next login or service restart)
  if ! id -nG "$SERVICE_USER" | grep -qw dialout; then
    usermod -aG dialout "$SERVICE_USER"
    info "added $SERVICE_USER to the dialout group"
  fi
  if [ "$changed" -eq 1 ]; then
    sync
    touch "$REBOOT_MARKER"
    info "the UART is freed at the next boot"
  elif [ -e "$GPS_PORT" ]; then
    ok "UART free, $GPS_PORT present"
  elif reboot_pending; then
    info "UART set up; $GPS_PORT appears after the pending reboot"
  else
    die "$GPS_PORT still missing with the UART freed - check: ls -la /dev/ttyAMA0 /dev/ttyS0 /dev/serial0 /dev/serial1"
  fi
}

do_wifi() {
  section "wifi: saved networks"
  need_root wifi
  if [ -n "$WIFI_SSID" ]; then
    if [ "$WIFI_PASSWORD_SET" -eq 1 ]; then
      "$REPO_DIR/set-wifi.sh" "$WIFI_SSID" "$WIFI_PASSWORD"
    else
      "$REPO_DIR/set-wifi.sh" "$WIFI_SSID"
    fi
  else
    "$REPO_DIR/set-wifi.sh"
  fi
  # Saved profiles sometimes vanish from a boat Pi - a power cut before the profile reached the SD card, or an older
  # set-wifi.sh run cut short between its delete and add. This unit re-runs set-wifi.sh at every boot, before the app
  # starts: networks already saved are left alone (so it never drops a connection), missing defaults are saved again.
  # Only set-wifi.sh's default networks - one added with --ssid is not restored.
  local unit_file="/etc/systemd/system/$WIFI_UNIT.service"
  local want
  want="[Unit]
Description=Race Tracker: restore the default WiFi networks (set-wifi.sh)
Wants=NetworkManager.service
After=NetworkManager.service

[Service]
Type=oneshot
ExecStart=$REPO_DIR/set-wifi.sh

[Install]
WantedBy=multi-user.target"
  if [ -f "$unit_file" ] && [ "$(cat "$unit_file")" = "$want" ] && systemctl is-enabled --quiet "$WIFI_UNIT" 2>/dev/null; then
    ok "$WIFI_UNIT.service already restores the networks at boot"
  else
    printf '%s\n' "$want" > "$unit_file"
    systemctl daemon-reload
    systemctl enable "$WIFI_UNIT" >/dev/null 2>&1
    ok "$WIFI_UNIT.service installed: restores the default networks at every boot"
  fi
}

do_service() {
  section "service"
  need_root service
  [ -n "$MODE" ] || die "the service section needs --mode ($MODES)"
  [ "$(node_major)" -ge "$NODE_MIN_MAJOR" ] || die "node $NODE_MIN_MAJOR+ is needed first (run the node section)"
  if [ -n "$EXTRA_ARG" ]; then
    "$REPO_DIR/install-service.sh" "$MODE" "$EXTRA_ARG"
  else
    "$REPO_DIR/install-service.sh" "$MODE"
  fi
}

# Installs race-tracker-update.service, which runs boot-pull at every boot, ordered before every mode's app service so the app
# starts on the new code (nothing to restart). It doesn't hold the app back for long: boot-pull gives up on the network after
# BOOT_PULL_WAIT_S, and the app starts whether it succeeded or not. sudo systemctl disable race-tracker-update turns it off.
do_autoupdate() {
  section "autoupdate: git pull at boot"
  need_root autoupdate
  local unit_file="/etc/systemd/system/$UPDATE_UNIT.service" units="" m want
  for m in $SERVICE_MODES; do units="$units $(unit_for_mode "$m").service"; done
  want="[Unit]
Description=Race Tracker: git pull and update node_modules at boot, before the app starts (setup-pi.sh boot-pull)
Wants=NetworkManager.service
After=NetworkManager.service
Before=${units# }

[Service]
Type=oneshot
ExecStart=$SCRIPT_PATH boot-pull
TimeoutStartSec=600

[Install]
WantedBy=multi-user.target"
  if [ -f "$unit_file" ] && [ "$(cat "$unit_file")" = "$want" ] && systemctl is-enabled --quiet "$UPDATE_UNIT" 2>/dev/null; then
    ok "$UPDATE_UNIT.service already pulls at boot"
  else
    printf '%s\n' "$want" > "$unit_file"
    systemctl daemon-reload
    systemctl enable "$UPDATE_UNIT" >/dev/null 2>&1
    ok "$UPDATE_UNIT.service installed: pulls the latest code at every boot, before the app starts"
  fi
}

# Run by race-tracker-update.service at boot (or by hand). Waits up to BOOT_PULL_WAIT_S for a network that reaches GitHub -
# a boat out on the playa has none, and then the app simply starts on the code it has. Then the repo and deps sections:
# git pull --ff-only (skipped if the checkout has local changes) and npm ci when package-lock.json changed. If that npm ci
# fails, the old node_modules and the old commit are put back together, so the app never starts on code whose packages
# didn't install. When run by hand with the app already running, the app is restarted if the code changed. Never fails:
# whatever happens, the app still starts.
do_boot_pull() {
  section "boot-pull: latest code before the app starts"
  is_root || die "boot-pull needs root"
  [ "$SERVICE_USER" != "root" ] || die "can't tell which user owns $REPO_DIR"
  local waited=0
  until as_user timeout 15 git -C "$REPO_DIR" ls-remote -q origin HEAD >/dev/null 2>&1; do
    if [ "$waited" -ge "$BOOT_PULL_WAIT_S" ]; then
      info "no network to GitHub after ${BOOT_PULL_WAIT_S}s - starting on the code already here"
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
  local before after
  before="$(as_user git -C "$REPO_DIR" rev-parse HEAD)"
  # Each step in a subshell so its die can't stop the boot, with errexit switched back on inside it - bash ignores set -e in a
  # subshell used as an if/|| condition, which would let a failed step carry on as if it had worked
  local rc
  set +e; ( set -e; do_repo ); rc=$?; set -e
  if [ "$rc" -ne 0 ]; then warn "git pull failed - starting on the code already here"; return 0; fi
  after="$(as_user git -C "$REPO_DIR" rev-parse HEAD)"
  if [ "$before" = "$after" ]; then
    ok "already up to date"
    return 0
  fi
  if [ -d "$REPO_DIR/node_modules" ] && [ -f "$DEPS_STAMP" ] && [ "$(cat "$DEPS_STAMP")" = "$(deps_stamp)" ]; then
    ok "node_modules unchanged"
  else
    # npm ci empties node_modules first: keep the old one aside until the new one is in
    rm -rf "$REPO_DIR/node_modules.previous"
    [ ! -d "$REPO_DIR/node_modules" ] || mv "$REPO_DIR/node_modules" "$REPO_DIR/node_modules.previous"
    set +e; ( set -e; do_deps ); rc=$?; set -e
    if [ "$rc" -eq 0 ]; then
      rm -rf "$REPO_DIR/node_modules.previous"
    else
      warn "npm ci failed - putting back the previous commit and node_modules"
      rm -rf "$REPO_DIR/node_modules"
      [ ! -d "$REPO_DIR/node_modules.previous" ] || mv "$REPO_DIR/node_modules.previous" "$REPO_DIR/node_modules"
      as_user git -C "$REPO_DIR" reset -q --keep "$before" || warn "couldn't move back to ${before:0:7}"
      return 0
    fi
  fi
  ok "updated ${before:0:7} -> ${after:0:7}"
  # By hand, with the app already running: restart it onto the new code (at boot it hasn't started yet)
  local m unit
  for m in $(installed_modes); do
    unit="$(unit_for_mode "$m")"
    if systemctl is-active --quiet "$unit" 2>/dev/null; then
      systemctl restart "$unit"
      info "restarted $unit"
    fi
  done
}

do_run() {
  section "run: npm run ${MODE:-?} in the foreground (Ctrl-C to stop)"
  [ -n "$MODE" ] || MODE="$(detect_mode || true)"
  [ -n "$MODE" ] || die "the run section needs --mode ($MODES)"
  local unit
  unit="$(unit_for_mode "$MODE")"
  if systemctl is-active --quiet "$unit" 2>/dev/null; then
    die "$unit is running and has the serial ports - stop it first: sudo ./service-stop.sh $MODE"
  fi
  cd "$REPO_DIR"
  as_user npm run "$MODE"
}

do_verify() {
  section "verify"
  local major unit mode restarts cfg cmd
  local pending=0
  reboot_pending && pending=1

  # node
  major="$(node_major)"
  if [ "$major" -ge "$NODE_MIN_MAJOR" ]; then ok "node $(node -v), npm $(npm -v 2>/dev/null || echo missing)"
  elif [ "$major" -eq 0 ]; then bad "node not installed (section: node)"
  else bad "node $(node -v) is older than $NODE_MIN_MAJOR (section: node)"; fi

  # repo
  if [ -d "$REPO_DIR/.git" ]; then
    ok "checkout $(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null) at $(git -C "$REPO_DIR" log -1 --format='%h %cr' 2>/dev/null)"
    [ -z "$(git -C "$REPO_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ] || warn "the checkout has local changes"
  else
    bad "$REPO_DIR is not a git checkout"
  fi

  # deps
  if [ ! -d "$REPO_DIR/node_modules" ]; then bad "node_modules missing (section: deps)"
  elif [ "$major" -gt 0 ] && [ -f "$DEPS_STAMP" ] && [ "$(cat "$DEPS_STAMP")" = "$(deps_stamp)" ]; then ok "node_modules matches package-lock.json"
  else warn "node_modules may be out of date with package-lock.json (section: deps)"; fi

  # uart
  cfg="$(boot_file config.txt)"
  cmd="$(boot_file cmdline.txt)"
  if [ -f "$cfg" ]; then
    if grep -q '^enable_uart=1' "$cfg" && grep -q '^dtoverlay=disable-bt' "$cfg"; then ok "UART enabled, Bluetooth off ($cfg)"
    else bad "UART not freed in $cfg (section: uart)"; fi
    if grep -qE 'console=(serial0|ttyAMA0),[0-9]+' "$cmd"; then bad "serial console still on in $cmd (section: uart)"
    else ok "no serial console"; fi
  else
    warn "no $cfg - not a Raspberry Pi?"
  fi
  if [ -e "$GPS_PORT" ]; then ok "$GPS_PORT present"
  elif [ "$pending" -eq 1 ]; then warn "$GPS_PORT not there yet - reboot first"
  else bad "$GPS_PORT missing (section: uart, then reboot)"; fi
  if id -nG "$SERVICE_USER" 2>/dev/null | grep -qw dialout; then ok "$SERVICE_USER is in the dialout group"
  else bad "$SERVICE_USER is not in the dialout group (section: uart)"; fi

  # wifi: every default network saved, each in a file on the SD card (one under /run is in memory only and gone at the next
  # boot), and the boot-time restore enabled
  if command -v nmcli >/dev/null 2>&1; then
    local names missing="" ssid file volatile="" active
    names="$(nmcli -t -f NAME connection show 2>/dev/null)"
    while IFS= read -r ssid; do
      [ -n "$ssid" ] || continue
      if ! printf '%s\n' "$names" | grep -Fxq "$ssid"; then
        missing="$missing \"$ssid\""
        continue
      fi
      file="$(nmcli -g connection.filename connection show "$ssid" 2>/dev/null || true)"
      case "$file" in /run/*) volatile="$volatile \"$ssid\"" ;; esac
    done < <("$REPO_DIR/set-wifi.sh" --list-defaults)
    active="$(nmcli -t -f NAME,TYPE,ACTIVE connection show 2>/dev/null | awk -F: '($2 == "802-11-wireless" || $2 == "wifi") && $3 == "yes" { printf "on \"%s\" now", $1 }')"
    if [ -z "$missing" ]; then ok "all default WiFi networks saved${active:+ - $active}"
    else bad "default WiFi networks missing:$missing (section: wifi)"; fi
    [ -z "$volatile" ] || bad "WiFi networks kept in memory only, lost at the next boot:$volatile (section: wifi)"
  else
    warn "nmcli not found - can't check WiFi"
  fi
  if systemctl is-enabled --quiet "$WIFI_UNIT" 2>/dev/null; then ok "$WIFI_UNIT.service restores them at boot"
  else warn "$WIFI_UNIT.service not installed - missing networks aren't restored at boot (section: wifi)"; fi

  # service
  mode="${MODE:-$(detect_mode || true)}"
  if [ -z "$mode" ]; then
    warn "no service to check - none installed, or more than one (pass --mode)"
  else
    unit="$(unit_for_mode "$mode")"
    if [ ! -f "/etc/systemd/system/$unit.service" ]; then bad "$unit not installed (section: service --mode $mode)"
    else
      if systemctl is-enabled --quiet "$unit" 2>/dev/null; then ok "$unit starts at boot"; else warn "$unit does not start at boot (./service-autostart.sh $mode on)"; fi
      if systemctl is-active --quiet "$unit" 2>/dev/null; then
        restarts="$(systemctl show -p NRestarts --value "$unit" 2>/dev/null || echo 0)"
        if [ "${restarts:-0}" -gt 3 ]; then warn "$unit is running but has restarted $restarts times - check ./service-logs.sh $mode"
        else ok "$unit running"; fi
      elif [ "$pending" -eq 1 ]; then warn "$unit not running - reboot first"
      else bad "$unit not running (./service-logs.sh $mode)"; fi
    fi
  fi

  if systemctl is-enabled --quiet "$UPDATE_UNIT" 2>/dev/null; then ok "$UPDATE_UNIT.service pulls the latest code at boot"
  else warn "$UPDATE_UNIT.service not installed - the code isn't updated at boot (section: autoupdate)"; fi

  [ "$pending" -eq 0 ] || warn "a reboot is pending (sudo reboot)"
}

do_fix() {
  do_verify
  if [ ${#FIX_SECTIONS[@]} -eq 0 ]; then
    if [ "$FAILS" -gt 0 ]; then
      echo
      echo "Nothing here can be fixed by re-running a section - see the FAIL lines above (a reboot, the service's logs)."
    fi
    return
  fi
  # In setup order (node before deps, uart before service), whatever order verify found them in
  local todo=() s
  for s in "${ALL_SECTIONS[@]}"; do
    if [[ " ${FIX_SECTIONS[*]} " == *" $s "* ]]; then todo+=("$s"); fi
  done
  if [[ " ${todo[*]} " == *" service "* ]] && [ -z "$MODE" ]; then
    MODE="$(detect_mode || true)"
    if [ -z "$MODE" ]; then
      echo
      echo "The service needs installing, but which mode? Re-run with --mode ($MODES)."
      todo=(${todo[@]/service/})
    fi
  fi
  echo
  echo "Fixing: ${todo[*]}"
  for s in "${todo[@]}"; do "do_$s"; done
  # Check again, counting only this second pass
  FAILS=0
  WARNS=0
  FIX_SECTIONS=()
  do_verify
}

# ---- run -------------------------------------------------------------------------------------------------------------

REEXEC=0
DONE=()
for s in "${SECTIONS[@]}"; do
  "do_${s//-/_}"
  DONE+=("$s")
  if [ "$REEXEC" -eq 1 ]; then
    # The rest of the run, with the new copy: the same options, minus the sections already done.
    REST=()
    skip=${#DONE[@]}
    for a in "${ORIGINAL_ARGS[@]}"; do
      case "$a" in all | update | node | repo | deps | uart | wifi | service | autoupdate | boot-pull | verify | fix | run) ;; *) REST+=("$a") ;; esac
    done
    for s2 in "${SECTIONS[@]:$skip}"; do REST+=("$s2"); done
    [ ${#SECTIONS[@]} -gt "$skip" ] || exit 0
    SETUP_PI_REEXEC=1 exec "$SCRIPT_PATH" "${REST[@]}"
  fi
done

echo
if reboot_pending; then
  if [ "$DO_REBOOT" -eq 1 ] && is_root; then
    echo "Rebooting to finish (then: ./setup-pi.sh verify)"
    rm -f "$REBOOT_MARKER"
    systemctl reboot
    exit 0
  fi
  echo "A reboot is needed to finish: sudo reboot   then: ./setup-pi.sh verify"
fi
if [ "$FAILS" -gt 0 ]; then
  echo "$FAILS check(s) failed, $WARNS warning(s)."
  exit 1
fi
[ "$WARNS" -eq 0 ] || echo "$WARNS warning(s)."
echo "Done: ${SECTIONS[*]}"
