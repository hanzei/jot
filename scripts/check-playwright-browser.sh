#!/usr/bin/env bash
#
# check-playwright-browser.sh — verify the Chromium build that the pinned
# @playwright/test expects is actually present before running e2e tests.
#
# bootstrap.sh deliberately does not download browsers: it is the slowest setup
# step and most sessions never run e2e. The cost of skipping it is that a
# missing or version-mismatched browser otherwise surfaces as every spec failing
# with "Executable doesn't exist at ...", which reads like a broken test suite
# rather than a one-command fix. This turns it into that one command.
#
# `task test-e2e` runs this first. Run it directly with:
#   ./scripts/check-playwright-browser.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT

if [ ! -d "$REPO_ROOT/webapp/node_modules" ]; then
  cat >&2 <<EOF

webapp/node_modules is missing, so Playwright is not installed.
Run ./scripts/bootstrap.sh first.
EOF
  exit 1
fi

# --dry-run reports the exact install path for every browser the installed
# Playwright version wants, honouring PLAYWRIGHT_BROWSERS_PATH. Asking
# Playwright beats hardcoding a layout that changes between releases.
if ! dry_run="$(cd "$REPO_ROOT/webapp" && npx playwright install --dry-run chromium 2>&1)"; then
  printf '%s\n' "$dry_run" >&2
  echo "Could not determine the expected Playwright browser paths (see output above)." >&2
  exit 1
fi

expected=()
missing=()
while read -r location; do
  expected+=("$location")
  [ -d "$location" ] || missing+=("$location")
done < <(printf '%s\n' "$dry_run" | awk '/Install location:/ {print $NF}')

# Fail loudly rather than silently passing if a future Playwright release
# changes the --dry-run output this parses.
if [ ${#expected[@]} -eq 0 ]; then
  printf '%s\n' "$dry_run" >&2
  echo "Could not parse any browser install locations from the output above — update scripts/check-playwright-browser.sh." >&2
  exit 1
fi

if [ ${#missing[@]} -gt 0 ]; then
  cat >&2 <<EOF

Playwright browser missing or version-mismatched. Expected but not found:
EOF
  printf '  %s\n' "${missing[@]}" >&2
  cat >&2 <<EOF

Install it (once per machine, a few hundred MB):
  cd webapp && npx playwright install chromium

Add --with-deps on a bare Linux box to also pull the system libraries:
  cd webapp && npx playwright install --with-deps chromium

EOF

  # Inside nix-shell, PLAYWRIGHT_BROWSERS_PATH points into the read-only nix
  # store, so the commands above cannot write there. Telling someone to install
  # into an immutable path just trades this error for a confusing permission
  # one.
  case "${PLAYWRIGHT_BROWSERS_PATH:-}" in
    /nix/store/*)
      cat >&2 <<EOF
PLAYWRIGHT_BROWSERS_PATH points into the read-only nix store
($PLAYWRIGHT_BROWSERS_PATH), so those commands cannot write there. Either bump
nixpkgs so playwright-driver.browsers matches the pinned @playwright/test, or
install into a writable cache for this shell:
  PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright npx playwright install chromium
and keep that same value set when running the tests.

EOF
      ;;
  esac
  exit 1
fi
