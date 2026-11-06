#!/usr/bin/env bash
#
# test-e2e-changed.sh — run only the Playwright specs this branch adds or edits.
#
# The full suite is ~8 minutes and CI runs it; a new or edited spec is the one
# thing worth proving locally before the PR exists, and takes seconds to a minute.
# A change to a page object or fixture is not detected here — CI covers it.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(git rev-parse --show-toplevel)"

specs=()
while IFS= read -r f; do
  case "$f" in
    webapp/e2e/tests/*.spec.ts) [ -f "$root/$f" ] && specs+=("${f#webapp/}") ;;
  esac
done < <("$here/changed-files.sh")

if [ ${#specs[@]} -eq 0 ]; then
  echo "test-e2e-changed: no e2e spec added or edited on this branch — nothing to run"
  exit 0
fi

echo "test-e2e-changed: ${specs[*]}"
cd "$root"
exec task test-e2e -- "${specs[@]}"
