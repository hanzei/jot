#!/usr/bin/env bash
#
# check-changed.sh — the pre-PR gate, scoped to what the branch touches.
#
# `task check` runs everything (~1 min); most PRs touch one workspace. This maps
# the files changed since master (committed, uncommitted, untracked) to
# workspaces, applies formatting there, then runs only their lint and tests (in
# parallel), the cheap docs/migration/translation gates, and any e2e spec the
# branch adds or edits. CI runs everything, so this is the fast first line.
#
#   shared/**                           -> shared + webapp + mobile (clients compile it)
#   shared/src/listToMarkdownCases.json -> also server (the Go export is pinned to it)
#   server/**, .golangci.yml            -> server
#   webapp/**, mobile/**                -> that workspace
#   README.md, CLAUDE.md, docs/**, .claude/** -> nothing
#   anything else                       -> `task fmt` + full `task check`
#                                          (Taskfile, scripts/, .github/, root config)
#
# Not covered: e2e specs broken by a server or page-object change (CI), and
# `task test-server-postgres` after a schema or query change.
#
# Usage: ./scripts/check-changed.sh [--dry-run]
#        JOT_CHECK_BASE=<ref> overrides the comparison point.

set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
cd "$root"
dry=0
[ "${1:-}" = "--dry-run" ] && dry=1

specs=()

# `task check` plus any changed e2e spec (empty when the diff was never read).
full_gate() {
  local note=""
  [ ${#specs[@]} -gt 0 ] && note=" and e2e: ${specs[*]}"
  echo "check-changed: $1 — running the full gate${note}"
  if [ $dry -eq 1 ]; then echo "plan: task fmt, then task check${note}"; exit 0; fi
  # An unfixable lint error fails fmt; let `task check` report it with the rest.
  task fmt || echo "check-changed: task fmt failed — continuing so the gate reports everything"
  local rc=0
  task check || rc=1
  if [ ${#specs[@]} -gt 0 ]; then task test-e2e -- "${specs[@]}" || rc=1; fi
  exit $rc
}

base="${JOT_CHECK_BASE:-}"
if [ -z "$base" ]; then
  for ref in origin/master master; do
    if git rev-parse --verify -q "$ref^{commit}" >/dev/null; then
      base="$(git merge-base HEAD "$ref")"
      break
    fi
  done
fi
# No origin/master, or no merge base (e.g. a shallow clone that cannot reach the fork point).
[ -n "$base" ] || full_gate "cannot find a merge base with master"

files="$({ git diff --name-only --no-renames "$base"; git ls-files --others --exclude-standard; } | sort -u)"

if [ -z "$files" ]; then
  echo "check-changed: no changes relative to ${base:0:12} — nothing to run"
  exit 0
fi

server=0 shared=0 webapp=0 mobile=0 full=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    README.md|CLAUDE.md|*/CLAUDE.md|docs/*|.claude/*) ;;
    shared/src/listToMarkdownCases.json) shared=1 server=1 ;;
    shared/*) shared=1 ;;
    server/*|.golangci.yml) server=1 ;;
    webapp/*) webapp=1
      case "$f" in webapp/e2e/tests/*.spec.ts) [ -f "$f" ] && specs+=("${f#webapp/}") ;; esac ;;
    mobile/*) mobile=1 ;;
    *) full="the diff touches files outside any workspace" ;;
  esac
done <<<"$files"

# After the loop, so a changed spec elsewhere in the diff is still run.
[ -n "$full" ] && full_gate "$full"

[ $shared -eq 1 ] && webapp=1 mobile=1

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

# Avoid ${specs[*]:+...} (also in full_gate): an empty array trips `set -u` on bash < 4.4 (macOS ships 3.2).
e2e_note=""
[ ${#specs[@]} -gt 0 ] && e2e_note=", then e2e: ${specs[*]}"
echo "check-changed: fmt (${fmt[*]}), then ${par[*]} in parallel, then ${ser[*]}${e2e_note}"
[ $dry -eq 1 ] && exit 0

rc=0
# Disjoint workspaces, so the formatters can run side by side. A formatter that
# cannot fix something is a lint error; the lint run below reports it properly.
"$here/run-tasks.sh" --parallel "${fmt[@]}" >/dev/null 2>&1 || true
"$here/run-tasks.sh" --parallel "${par[@]}" || rc=1
"$here/run-tasks.sh" "${ser[@]}" || rc=1
if [ ${#specs[@]} -gt 0 ]; then
  task test-e2e -- "${specs[@]}" || rc=1
fi
exit $rc
