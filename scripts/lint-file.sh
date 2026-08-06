#!/usr/bin/env bash
#
# lint-file.sh — lint a single file, for use as a Claude Code PostToolUse hook.
#
# The point is the feedback loop. Without this, a lint error written at the
# start of a task is found by `task check` at the end of it, minutes later,
# with the cause buried under everything edited since. This reports it against
# the edit that caused it, in about a second.
#
# It reads the hook's JSON payload on stdin and lints `tool_input.file_path`.
# Exit 2 hands stderr back to the agent as blocking feedback; exit 0 is silent.
# Anything it cannot lint — docs, YAML, JSON, a workspace whose node_modules is
# missing — is a silent pass, because a hook that complains about files it was
# never meant to check just teaches people to turn it off.
#
# It is a fast subset, not a replacement for `task check`: single-file ESLint
# only, so nothing that needs whole-project type information (`tsc --noEmit`,
# `task check-translations`) is covered here.
#
# Run it by hand with:
#   echo '{"tool_input":{"file_path":"server/main.go"}}' | ./scripts/lint-file.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT

command -v node >/dev/null 2>&1 || exit 0

payload="$(cat)"

# `|| exit 0` covers a malformed or unexpected payload: a hook is not the place
# to fail a session over its own input.
file_path="$(printf '%s' "$payload" | node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try {
      const input = JSON.parse(raw);
      process.stdout.write(input?.tool_input?.file_path ?? "");
    } catch {
      process.stdout.write("");
    }
  });
' 2>/dev/null)" || exit 0

[ -n "$file_path" ] || exit 0
[ -f "$file_path" ] || exit 0

# Normalise to a repo-relative path so the workspace match below is anchored,
# and a file outside the repo drops out.
abs_path="$(cd "$(dirname "$file_path")" && pwd)/$(basename "$file_path")"
case "$abs_path" in
  "$REPO_ROOT"/*) rel_path="${abs_path#"$REPO_ROOT"/}" ;;
  *) exit 0 ;;
esac

# Report a failure and hand the output back to the agent.
report() {
  printf '%s lint failed for %s:\n\n%s\n' "$1" "$rel_path" "$2" >&2
  exit 2
}

lint_go() {
  # golangci-lint type-checks the whole package to lint one file in it, so this
  # is only fast on a warm build cache — which bootstrap.sh now warms.
  local output
  if ! output="$(cd "$REPO_ROOT/server" && go tool golangci-lint run "${abs_path}" 2>&1)"; then
    report "golangci-lint" "$output"
  fi
}

lint_eslint() {
  local workspace="$1" output
  [ -d "$REPO_ROOT/$workspace/node_modules" ] || exit 0
  if ! output="$(cd "$REPO_ROOT/$workspace" && npx --no-install eslint "$abs_path" 2>&1)"; then
    report "ESLint" "$output"
  fi
}

case "$rel_path" in
  # Generated — swag owns server/docs, and rewriting it by hand is the bug.
  server/docs/*) exit 0 ;;
  server/*.go) lint_go ;;
  webapp/*.ts | webapp/*.tsx | webapp/*.js | webapp/*.jsx) lint_eslint webapp ;;
  mobile/*.ts | mobile/*.tsx | mobile/*.js | mobile/*.jsx) lint_eslint mobile ;;
  shared/*.ts | shared/*.js) lint_eslint shared ;;
  *) exit 0 ;;
esac
