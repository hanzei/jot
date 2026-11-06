#!/usr/bin/env bash
#
# changed-files.sh — list the files this branch changes relative to master:
# committed work since the merge base, plus uncommitted and untracked files.
#
# Used by check-changed.sh and test-e2e-changed.sh to scope the pre-PR checks.
# Deleted files are listed too (a deletion can still break a workspace); callers
# that need a file to exist test for it. Override the comparison point with
# JOT_CHECK_BASE=<ref>. Exits 3 when no base can be found (a checkout with
# neither origin/master nor master), so callers can fall back to checking all.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

base="${JOT_CHECK_BASE:-}"
if [ -z "$base" ]; then
  for ref in origin/master master; do
    if git rev-parse --verify -q "$ref^{commit}" >/dev/null; then
      base="$(git merge-base HEAD "$ref")"
      break
    fi
  done
fi

if [ -z "$base" ]; then
  echo "changed-files: no origin/master or master to compare against" >&2
  exit 3
fi

{
  git diff --name-only --no-renames "$base"
  git ls-files --others --exclude-standard
} | sort -u
