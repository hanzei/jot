#!/usr/bin/env bash
#
# check-changed.sh — the pre-PR gate, scoped to what the branch touches.
#
# `task check` runs everything (~2.5 min); most PRs touch one workspace. This
# maps the changed files to workspaces and runs only their lint and tests, plus
# the cheap docs/migration/translation gates, plus any e2e spec the branch adds
# or edits. CI still runs everything, so this is a fast first line, not the last.
#
# Mapping:
#   shared/**                      -> shared, webapp, mobile (both compile it)
#   shared/src/listToMarkdownCases.json -> also server (the Go export is pinned to it)
#   server/**, .golangci.yml       -> server
#   webapp/**  / mobile/**         -> that workspace
#   *.md, docs/**, .claude/**      -> nothing (docs only)
#   anything else                  -> full `task check` (Taskfile, scripts/,
#                                     .github/, root config: unknown blast radius)
#
# Formatting is applied first (fmt-* for the touched workspaces), so a stray
# semicolon or quote style is fixed instead of failing a minute-long lint run.
# It only rewrites layout, and only in workspaces you already changed.
#
# Limits worth knowing: e2e runs only specs the branch changes, not specs that a
# server or page-object change could break — CI covers those. A schema or query
# change still wants `task test-server-postgres`.
#
# Usage: ./scripts/check-changed.sh [--dry-run]   (--dry-run prints the plan)

set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
dry=0
[ "${1:-}" = "--dry-run" ] && dry=1

if ! files="$("$here/changed-files.sh")"; then
  echo "check-changed: cannot tell what changed — running the full gate" >&2
  if [ $dry -eq 1 ]; then echo "plan: task fmt, then task check"; exit 0; fi
  task fmt || exit 1
  exec task check
fi

server=0 shared=0 webapp=0 mobile=0 full=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    README.md|CLAUDE.md|*/CLAUDE.md|docs/*|.claude/*) ;;
    shared/src/listToMarkdownCases.json) shared=1 server=1 ;;
    shared/*) shared=1 ;;
    server/*|.golangci.yml) server=1 ;;
    webapp/*) webapp=1 ;;
    mobile/*) mobile=1 ;;
    *) full=1 ;;
  esac
done <<<"$files"

if [ $full -eq 1 ]; then
  echo "check-changed: the diff touches files outside any workspace — running the full gate"
  if [ $dry -eq 1 ]; then echo "plan: task fmt, then task check"; exit 0; fi
  task fmt || exit 1
  exec task check
fi

# Both clients compile @jot/shared from source.
if [ $shared -eq 1 ]; then webapp=1 mobile=1; fi

fmt=() par=()
[ $shared -eq 1 ] && fmt+=(fmt-shared) par+=(lint-shared test-shared)
[ $server -eq 1 ] && fmt+=(fmt-server) par+=(lint-server test-server)
[ $webapp -eq 1 ] && fmt+=(fmt-webapp) par+=(lint-webapp test-webapp)
[ $mobile -eq 1 ] && fmt+=(fmt-mobile) par+=(lint-mobile test-mobile test-mobile-e2e-scripts)

if [ ${#par[@]} -eq 0 ]; then
  echo "check-changed: only docs/notes changed — nothing to run"
  exit 0
fi

# Seconds each, and each catches a class of failure the suites cannot see.
ser=(check-docs check-migrations check-translations)

# Only a spec the branch adds or edits; the rest of the suite is CI's.
e2e=0
while IFS= read -r f; do
  case "$f" in
    webapp/e2e/tests/*.spec.ts) [ -f "$f" ] && e2e=1 ;;
  esac
done <<<"$files"

echo "check-changed: formatting (${fmt[*]}), then running ${par[*]} (in parallel), then ${ser[*]}$([ $e2e -eq 1 ] && echo ", then test-e2e-changed")"
if [ $dry -eq 1 ]; then exit 0; fi

rc=0
# Disjoint workspaces, so the formatters can run side by side. A formatter that
# cannot fix something is a lint error; the lint run below reports it properly.
"$here/run-tasks.sh" --parallel "${fmt[@]}" >/dev/null 2>&1 || true
"$here/run-tasks.sh" --parallel "${par[@]}" || rc=1
"$here/run-tasks.sh" "${ser[@]}" || rc=1
if [ $e2e -eq 1 ]; then
  "$here/run-tasks.sh" test-e2e-changed || rc=1
fi
exit $rc
