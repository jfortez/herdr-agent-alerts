#!/usr/bin/env bash
# Supervise the detached Telegram command poller.
#
# `ensure-poller.sh` starts this script detached (setsid/nohup, with the shared
# log file on stdout/stderr). It runs one poller in the background and waits
# for it:
#   - exit 0: a deliberate stop (a signal, ALHERDR_TELEGRAM_COMMANDS off, or
#     losing the claim race) -> exit 0 and stay stopped.
#   - exit non-zero: an unexpected fatal error -> log it and restart after a
#     short delay, so a crash does not wait for the next Herdr server start.
# TERM/INT kills the child and exits 0, so stopping the supervisor stops the
# poller. Two concurrent supervisors self-resolve: the loser's poller exits 0
# on the lock, so its supervisor exits with it.
#
# A child command may be injected as arguments (the tests use this, so no test
# starts a real poller). Without arguments it runs
# `$ALHERDR_POLLER_NODE $ALHERDR_POLLER_ENTRY`, resolved against
# HERDR_PLUGIN_ROOT. Bash 3.2 (macOS) only: no `wait -n`, no `flock`, no
# `mapfile`, no associative arrays.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${HERDR_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DELAY="${ALHERDR_POLLER_RESTART_DELAY:-5}"

if [ "$#" -gt 0 ]; then
  CHILD=("$@")
else
  CHILD=("${ALHERDR_POLLER_NODE:-node}" "${ALHERDR_POLLER_ENTRY:-$ROOT/src/poller.mjs}")
fi

child_pid=""
stopping=0

stop() {
  stopping=1
  if [ -n "$child_pid" ]; then
    kill "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
    child_pid=""
  fi
}
trap stop TERM INT

while :; do
  "${CHILD[@]}" &
  child_pid=$!
  # 2>/dev/null: bash's locale-dependent "killed by signal" job note would
  # otherwise land in the shared log; the exit code still reaches us.
  wait "$child_pid" 2>/dev/null
  code=$?
  child_pid=""
  if [ "$stopping" -ne 0 ]; then
    exit 0
  fi
  if [ "$code" -eq 0 ]; then
    exit 0
  fi
  printf '[alherdr] supervisor: poller exited %s; restarting in %ss\n' "$code" "$DELAY"
  sleep "$DELAY" &
  wait $! 2>/dev/null || true
  if [ "$stopping" -ne 0 ]; then
    exit 0
  fi
done
