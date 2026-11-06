#!/usr/bin/env bash
#
# run-tasks.sh — run several tasks in sequence, reporting every failure instead
# of stopping at the first.
#
# `task fmt` uses this serially; `task lint` and `task test` use it with
# --parallel. Either way output stays attributable to one suite rather than
# interleaving, and a failure no longer hides the suites behind it. One pass
# tells you everything that is broken, which matters most when a change spans
# shared/ + webapp/ + mobile/ and each rerun costs minutes.
#
# --parallel starts every task at once, buffers each one's output, and prints it
# in the order given. Put the upstream suite first (shared before the clients
# that compile it): a broken shared/ makes the suites after it fail for reasons
# that are not their own, so read the report top-down and fix the first failure.
# Only use it for tasks that touch disjoint files — `fmt` and `check-docs`
# write to the tree, so they stay serial.
#
# Usage: ./scripts/run-tasks.sh [--parallel] lint-shared lint-server lint-webapp lint-mobile

set -uo pipefail

parallel=0
if [ "${1:-}" = "--parallel" ]; then
  parallel=1
  shift
fi

if [ $# -eq 0 ]; then
  echo "usage: $(basename "$0") [--parallel] <task> [task...]" >&2
  exit 2
fi

if ! command -v task >/dev/null 2>&1; then
  echo "task is not on PATH — run ./scripts/bootstrap.sh" >&2
  exit 1
fi

failed=()

if [ $parallel -eq 1 ]; then
  tmp="$(mktemp -d)"
  pids=()
  trap 'kill "${pids[@]}" 2>/dev/null; rm -rf "$tmp"' EXIT
  trap 'exit 130' INT TERM

  for name in "$@"; do
    task "$name" >"$tmp/$name.log" 2>&1 &
    pids+=($!)
  done

  i=0
  for name in "$@"; do
    printf '\n\033[1m━━━ %s ━━━\033[0m\n' "$name"
    if ! wait "${pids[$i]}"; then
      failed+=("$name")
    fi
    cat "$tmp/$name.log"
    i=$((i + 1))
  done
else
  for name in "$@"; do
    printf '\n\033[1m━━━ %s ━━━\033[0m\n' "$name"
    if ! task "$name"; then
      failed+=("$name")
    fi
  done
fi

printf '\n\033[1m━━━ summary ━━━\033[0m\n'

if [ ${#failed[@]} -eq 0 ]; then
  printf 'all %d passed: %s\n' "$#" "$*"
  exit 0
fi

printf '%d of %d failed:\n' "${#failed[@]}" "$#"
printf '  %s\n' "${failed[@]}"
printf '\nRerun one on its own to iterate: task %s\n' "${failed[0]}"
exit 1
