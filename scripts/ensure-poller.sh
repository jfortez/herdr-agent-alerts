#!/usr/bin/env bash
# Spawn the detached Telegram command poller, once.
#
# Herdr runs the [[startup]] hook on server start and again on live handoff, so
# this script has to be idempotent: it exits immediately when
# ALHERDR_TELEGRAM_COMMANDS is off, and exits while a live poller already holds
# the PID file. It never prints to stdout; the poller's own output is what goes
# to the log file.
#
# File names must stay in step with src/poller.mjs.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${HERDR_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
CONFIG_DIR="${HERDR_PLUGIN_CONFIG_DIR:-$ROOT}"
STATE_DIR="${HERDR_PLUGIN_STATE_DIR:-$ROOT/state}"

PID_FILE="$STATE_DIR/telegram-poller.pid"
LOG_FILE="$STATE_DIR/telegram-poller.log"

NODE_BIN="${ALHERDR_POLLER_NODE:-node}"
POLLER_ENTRY="${ALHERDR_POLLER_ENTRY:-$ROOT/src/poller.mjs}"

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

pid=""
if [ -f "$PID_FILE" ]; then
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
fi
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  exit 0
fi

mkdir -p "$STATE_DIR"

if command -v setsid >/dev/null 2>&1; then
  setsid "$NODE_BIN" "$POLLER_ENTRY" >>"$LOG_FILE" 2>&1 </dev/null &
else
  nohup "$NODE_BIN" "$POLLER_ENTRY" >>"$LOG_FILE" 2>&1 </dev/null &
fi
child=$!
printf '%s\n' "$child" > "$PID_FILE"
