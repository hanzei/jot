#!/usr/bin/env bash
#
# bootstrap.sh — provision a Jot checkout so the documented `task ...` commands
# work as the *first* command in a fresh shell or agent session.
#
# This is the single source of truth for local setup. `.claude/settings.json`
# runs it from a SessionStart hook, `shell.nix` runs it on shell entry, and the
# README points humans at it. Add setup steps here, not in those three places.
#
# What it does:
#   * installs `task` (the Taskfile runner) if it is missing
#   * `npm ci` in shared/ -> webapp/ -> mobile/, skipping any that already have
#     node_modules
#   * warns — loudly, without changing anything — when Node or Go is older than
#     what the repo expects
#
# What it deliberately does NOT do:
#   * install Playwright browsers. That is the slowest step by far and most
#     sessions never touch e2e, so `task test-e2e` checks for the browser and
#     prints the install command instead (see check-playwright-browser.sh).
#   * install or switch Node/Go versions. Pulling in nvm/mise and reshaping the
#     shell environment is too invasive to do silently.
#
# Environment variables:
#   JOT_BOOTSTRAP_SKIP=1      skip everything (doc-only sessions)
#   JOT_BOOTSTRAP_SKIP_NPM=1  skip the npm installs, still install task
#   JOT_TASK_VERSION=vX.Y.Z   override the pinned Task version

set -uo pipefail

readonly TASK_VERSION="${JOT_TASK_VERSION:-v3.52.0}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT

failures=0

log() { printf '[bootstrap] %s\n' "$*"; }

warn() {
  printf '\n' >&2
  printf '[bootstrap] !! %s\n' "$@" >&2
  printf '\n' >&2
}

fail() {
  printf '[bootstrap] ERROR: %s\n' "$*" >&2
  failures=$((failures + 1))
}

# version_lt A B -> true when version A sorts strictly before version B.
version_lt() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$1" ]
}

if [ "${JOT_BOOTSTRAP_SKIP:-}" = "1" ]; then
  log "JOT_BOOTSTRAP_SKIP=1 — skipping setup"
  exit 0
fi

# ---------------------------------------------------------------------------
# Node — expected major version lives in .nvmrc
# ---------------------------------------------------------------------------

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    fail "node is not installed — see the Prerequisites section of README.md"
    return
  fi

  local expected actual
  expected="$(tr -d '[:space:]v' <"$REPO_ROOT/.nvmrc")"
  actual="$(node --version)"
  actual="${actual#v}"

  # .nvmrc pins a major only, so compare majors — v24.3 and v24.9 are both fine.
  if [ "${actual%%.*}" != "${expected%%.*}" ]; then
    warn "Node version mismatch: this repo expects v${expected} (.nvmrc, Dockerfile, CI), this machine has v${actual}." \
      "Not changing it — switch with your own version manager (nvm use ${expected}) if builds behave oddly."
  fi
}

# ---------------------------------------------------------------------------
# Go — minimum version lives in server/go.mod
# ---------------------------------------------------------------------------

check_go() {
  if ! command -v go >/dev/null 2>&1; then
    fail "go is not installed — see the Prerequisites section of README.md"
    return
  fi

  local expected actual
  expected="$(awk '/^go /{print $2; exit}' "$REPO_ROOT/server/go.mod")"
  actual="$(go env GOVERSION)"
  actual="${actual#go}"

  # Newer Go is fine; only an older toolchain is worth warning about.
  if version_lt "$actual" "$expected"; then
    warn "Go version mismatch: server/go.mod requires go${expected}, this machine has go${actual}." \
      "Builds still work via Go's toolchain auto-download, but the first one stalls for minutes" \
      "and fails outright without network access. Installing go${expected} avoids both."
  fi
}

# ---------------------------------------------------------------------------
# Task — the runner every documented command goes through, so it cannot itself
# be installed with a task. It is a Go program, so `go install` is enough.
# ---------------------------------------------------------------------------

install_task() {
  if command -v task >/dev/null 2>&1; then
    log "task $(task --version) already installed"
    return
  fi

  if ! command -v go >/dev/null 2>&1; then
    fail "cannot install task: go is not installed"
    return
  fi

  local gobin
  gobin="$(go env GOBIN)"
  [ -n "$gobin" ] || gobin="$(go env GOPATH)/bin"

  if [ -x "$gobin/task" ]; then
    log "task already installed at $gobin/task"
  else
    log "installing task $TASK_VERSION (this takes a minute on a cold module cache)"
    if ! go install "github.com/go-task/task/v3/cmd/task@$TASK_VERSION"; then
      fail "failed to install task — install it manually: go install github.com/go-task/task/v3/cmd/task@$TASK_VERSION"
      return
    fi
  fi

  export PATH="$gobin:$PATH"

  # A hook runs in its own shell, so exporting PATH here is not enough for the
  # session that follows. CLAUDE_ENV_FILE is how a Claude Code session inherits
  # environment changes from a SessionStart hook.
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PATH=\"$gobin:\$PATH\"" >>"$CLAUDE_ENV_FILE"
    log "added $gobin to PATH for this session"
  else
    warn "task was installed to $gobin, which is not on your PATH." \
      "Add it to use the documented commands: export PATH=\"$gobin:\$PATH\""
  fi
}

# ---------------------------------------------------------------------------
# npm workspaces — shared first: webapp and mobile both depend on it through
# `file:../shared`, so installing them first links an empty directory.
# ---------------------------------------------------------------------------

install_npm_deps() {
  if [ "${JOT_BOOTSTRAP_SKIP_NPM:-}" = "1" ]; then
    log "JOT_BOOTSTRAP_SKIP_NPM=1 — skipping npm installs"
    return
  fi

  if ! command -v npm >/dev/null 2>&1; then
    fail "npm is not installed — see the Prerequisites section of README.md"
    return
  fi

  local pkg
  for pkg in shared webapp mobile; do
    if [ -d "$REPO_ROOT/$pkg/node_modules" ]; then
      log "$pkg/node_modules present — skipping"
      continue
    fi

    log "installing $pkg dependencies (npm ci)"
    if ! (cd "$REPO_ROOT/$pkg" && npm ci --no-audit --no-fund); then
      fail "npm ci failed in $pkg/"
    fi
  done
}

check_node
check_go
install_task
install_npm_deps

if [ "$failures" -gt 0 ]; then
  log "finished with $failures error(s) — see above"
  exit 1
fi

log "ready — run 'task --list' to see the available commands"
