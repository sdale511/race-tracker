# service-mode.sh - sourced (not run) by the service-*.sh scripts and setup-pi.sh: the mode -> systemd unit names, the same
# as install-service.sh's, and which mode to act on when none is given - the one race-tracker service installed on this
# machine. A Pi normally has exactly one, so `sudo ./service-restart.sh` is enough.

SERVICE_MODES="boat base rtk basertk mark"

# The unit a mode installs as (install-service.sh), or nothing for an unknown mode
unit_for_mode() {
  case "$1" in
    boat) echo boat-agent ;;
    base) echo base-station ;;
    rtk) echo rtk-station ;;
    basertk) echo basertk-station ;;
    mark) echo mark-station ;;
  esac
}

# The modes with a service installed here, space-separated
installed_modes() {
  local m found=""
  for m in $SERVICE_MODES; do
    if [ -f "/etc/systemd/system/$(unit_for_mode "$m").service" ]; then found="$found $m"; fi
  done
  echo "${found# }"
}

# Sets MODE and SERVICE_NAME from $1 when it names a mode, else from the one installed service. Exits with a message when
# $1 is given but isn't a mode, or when there isn't exactly one service installed to fall back on. $2 is the usage line.
resolve_mode() {
  local given="${1:-}" usage="${2:-}" installed
  if [ -n "$given" ]; then
    if [ -z "$(unit_for_mode "$given")" ]; then
      echo "error: MODE must be one of: $SERVICE_MODES (got \"$given\")" >&2
      [ -z "$usage" ] || echo "usage: $usage" >&2
      exit 1
    fi
    MODE="$given"
  else
    installed="$(installed_modes)"
    case "$installed" in
      "")
        echo "error: no race-tracker service is installed here - give the MODE ($SERVICE_MODES), or install one with install-service.sh" >&2
        [ -z "$usage" ] || echo "usage: $usage" >&2
        exit 1
        ;;
      *" "*)
        echo "error: more than one race-tracker service is installed here ($installed) - give the MODE" >&2
        [ -z "$usage" ] || echo "usage: $usage" >&2
        exit 1
        ;;
    esac
    MODE="$installed"
  fi
  SERVICE_NAME="$(unit_for_mode "$MODE")"
}
