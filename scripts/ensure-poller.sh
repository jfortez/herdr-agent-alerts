#!/usr/bin/env bash
# Spawn the detached Telegram poller supervisor, once.
#
# Herdr runs the [[startup]] hook on server start and again on live handoff, so
# this script has to be idempotent: it exits immediately when
# ALHERDR_TELEGRAM_COMMANDS is off. Ownership of "exactly one poller" lives in
# the poller itself, which claims the `telegram-poller.lock/pid` file
# atomically with O_CREAT|O_EXCL (see src/poller.mjs); this script never writes
# the lock or its pid. The liveness read below is only a cheap optimisation to
# skip the spawn;
# even when it races, a duplicate poller loses the claim and exits 0, and its
# supervisor exits with it. It never prints to stdout; the supervisor's and
# poller's output is what goes to the log file.
#
# File names must stay in step with src/poller.mjs.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${HERDR_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
CONFIG_DIR="${HERDR_PLUGIN_CONFIG_DIR:-$ROOT}"
STATE_DIR="${HERDR_PLUGIN_STATE_DIR:-$ROOT/state}"

LOCK_PID_FILE="$STATE_DIR/telegram-poller.lock/pid"
LOG_FILE="$STATE_DIR/telegram-poller.log"
SUPERVISOR="$SCRIPT_DIR/run-poller.sh"

# Read KEY from a dotenv file, last assignment wins. Mirrors the subset of
# src/config.mjs that this decision needs: `export ` prefixes, single or double
# quotes, and surrounding whitespace. Real environment variables win over it.
read_env_value() {
  local key="$1" file="$2" line value
  [ -f "$file" ] || return 1
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$file" 2>/dev/null | tail -n 1)"
  [ -n "$line" ] || return 1
  value="${line#*=}"
  value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

commands="${ALHERDR_TELEGRAM_COMMANDS-}"
if [ -z "$commands" ]; then
  commands="$(read_env_value ALHERDR_TELEGRAM_COMMANDS "$CONFIG_DIR/.env")" || commands=""
fi
if [ -z "$commands" ] && [ "$ROOT/.env" != "$CONFIG_DIR/.env" ]; then
  commands="$(read_env_value ALHERDR_TELEGRAM_COMMANDS "$ROOT/.env")" || commands=""
fi

case "$(printf '%s' "$commands" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) ;;
  *) exit 0 ;;
esac

# Cheap pre-check only: the poller owns the lock, and a stale one is cleaned up
# by the new poller itself.
pid=""
if [ -f "$LOCK_PID_FILE" ]; then
  pid="$(cat "$LOCK_PID_FILE" 2>/dev/null || true)"
fi
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  exit 0
fi

mkdir -p "$STATE_DIR"

if command -v setsid >/dev/null 2>&1; then
  setsid bash "$SUPERVISOR" >>"$LOG_FILE" 2>&1 </dev/null &
else
  nohup bash "$SUPERVISOR" >>"$LOG_FILE" 2>&1 </dev/null &
fi
exit 0
