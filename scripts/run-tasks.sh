#!/usr/bin/env bash
#
# run-tasks.sh — run several tasks in sequence, reporting every failure instead
# of stopping at the first.
#
# `task lint` and `task fmt` use this. The suites still run serially, so output stays
# attributable to one suite rather than interleaving; what changes is that a
# failure no longer hides the suites behind it. One pass tells you everything
# that is broken, which matters most when a change spans shared/ + webapp/ +
# mobile/ and each rerun costs minutes.
#
# `task test` deliberately does NOT use this: a broken shared/ or server/ makes
# the suites downstream of it fail for reasons that are not their own, so
# stopping at the first failure keeps the output honest there.
#
# Usage: ./scripts/run-tasks.sh lint-shared lint-server lint-webapp lint-mobile

set -uo pipefail

if [ $# -eq 0 ]; then
  echo "usage: $(basename "$0") <task> [task...]" >&2
  exit 2
fi

if ! command -v task >/dev/null 2>&1; then
  echo "task is not on PATH — run ./scripts/bootstrap.sh" >&2
  exit 1
fi

failed=()

for name in "$@"; do
  printf '\n\033[1m━━━ %s ━━━\033[0m\n' "$name"
  if ! task "$name"; then
    failed+=("$name")
  fi
done

printf '\n\033[1m━━━ summary ━━━\033[0m\n'

if [ ${#failed[@]} -eq 0 ]; then
  printf 'all %d passed: %s\n' "$#" "$*"
  exit 0
fi

printf '%d of %d failed:\n' "${#failed[@]}" "$#"
printf '  %s\n' "${failed[@]}"
printf '\nRerun one on its own to iterate: task %s\n' "${failed[0]}"
exit 1
