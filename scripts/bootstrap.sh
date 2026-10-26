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
#   * `npm ci` in shared/ -> webapp/ -> mobile/, skipping any package whose
#     node_modules is already stamped up to date with its package-lock.json
#   * installs the Chromium build the pinned `@playwright/test` expects, so
#     `task test-e2e` works without a separate manual step
#   * checks that `task test-server-postgres` has a Postgres to start (the
#     server binaries or a running Docker daemon), and warns if not
#   * warms the Go build cache so the first `task lint-server` is seconds
#     rather than minutes
#   * warns — loudly, without changing anything — when Node or Go is older than
#     what the repo expects
#
# What it deliberately does NOT do:
#   * install or switch Node/Go versions, or install PostgreSQL. Pulling in nvm/mise and reshaping the
#     shell environment is too invasive to do silently.
#
# Environment variables:
#   JOT_BOOTSTRAP_SKIP=1             skip everything (doc-only sessions)
#   JOT_BOOTSTRAP_SKIP_NPM=1         skip the npm installs, still install task
#   JOT_BOOTSTRAP_SKIP_PLAYWRIGHT=1  skip the Playwright browser install
#   JOT_BOOTSTRAP_SKIP_GO_CACHE=1    skip the Go build cache warm-up
#   JOT_TASK_VERSION=vX.Y.Z          override the pinned Task version

set -uo pipefail

readonly TASK_VERSION="${JOT_TASK_VERSION:-v3.52.0}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT

failures=0
# Best-effort steps that did not complete. They do not fail setup, but they are
# repeated in the closing summary so they are not lost in the install output.
warnings=()

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

# sha256_file PATH -> hex digest on stdout. sha256sum is the common case
# (Linux, and macOS with coreutils installed); shasum -a 256 is macOS's
# built-in equivalent when it isn't.
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
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

  # A hook runs in its own shell, so the export above only covers the rest of
  # this script. CLAUDE_ENV_FILE is how a Claude Code session inherits
  # environment changes from a SessionStart hook, so the session that follows
  # can run the documented commands with no manual step.
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PATH=\"$gobin:\$PATH\"" >>"$CLAUDE_ENV_FILE"
    log "added $gobin to PATH for this session"
    return
  fi

  # Outside such a session there is no hand-off: a child process cannot change
  # its parent shell's environment, and sourcing this script instead would leak
  # `set -u`/`pipefail` into an interactive shell. So print the one line that
  # fixes it, for now and for good.
  warn "task was installed to $gobin, which is not on your PATH." \
    "For this shell:      export PATH=\"$gobin:\$PATH\"" \
    "For every shell:     add that line to ~/.bashrc, ~/.zshrc, or your shell's profile."
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

  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    fail "cannot verify package-lock.json freshness: neither sha256sum nor shasum is available"
    return
  fi

  local pkg dir stamp lock_hash
  for pkg in shared webapp mobile; do
    dir="$REPO_ROOT/$pkg"
    stamp="$dir/node_modules/.package-lock.sha256"
    lock_hash="$(sha256_file "$dir/package-lock.json")"

    if [ -d "$dir/node_modules" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$lock_hash" ]; then
      log "$pkg/node_modules up to date — skipping"
      continue
    fi

    log "installing $pkg dependencies (npm ci)"
    if ! (cd "$dir" && npm ci --no-audit --no-fund); then
      fail "npm ci failed in $pkg/"
      continue
    fi
    echo "$lock_hash" >"$stamp"
  done
}

# ---------------------------------------------------------------------------
# Playwright's Chromium build — `npx playwright install chromium` already
# no-ops when the build the installed `@playwright/test` expects is present,
# so this is safe to run on every bootstrap rather than needing its own
# up-to-date stamp. check-playwright-browser.sh still runs before
# `task test-e2e` itself, as a safety net for JOT_BOOTSTRAP_SKIP_PLAYWRIGHT=1
# and for anyone who reaches test-e2e without ever running this script.
#
# Best-effort by design: a failed download here is `task test-e2e`'s problem
# to report, not a reason for the rest of setup to fail. It is still repeated
# as a warning in the closing summary, naming the host when a proxy blocked it.
# ---------------------------------------------------------------------------

install_playwright_browser() {
  if [ "${JOT_BOOTSTRAP_SKIP_PLAYWRIGHT:-}" = "1" ]; then
    log "JOT_BOOTSTRAP_SKIP_PLAYWRIGHT=1 — skipping Playwright browser install"
    return
  fi

  # Checked explicitly rather than just webapp/node_modules: without the local
  # CLI, `npx playwright` falls back to fetching an unpinned copy from the npm
  # registry instead of running the pinned @playwright/test.
  if [ ! -x "$REPO_ROOT/webapp/node_modules/.bin/playwright" ]; then
    log "webapp/node_modules/.bin/playwright missing — skipping Playwright browser install"
    return
  fi

  log "installing the Playwright Chromium build (no-ops if already up to date)"
  # Output is streamed and kept, so a blocked download host can be named below.
  local out
  out="$(mktemp)"
  if ! (cd "$REPO_ROOT/webapp" && npx playwright install chromium) 2>&1 | tee "$out"; then
    local host
    # A sandbox or corporate proxy that blocks the host fails the same way on
    # every run, unlike a network hiccup, so say what to allow.
    host="$(sed -nE 's/.*allows host "([^"]+)".*/\1/p' "$out" | head -n1)"
    if [ -n "$host" ]; then
      warnings+=("Playwright Chromium not installed: the network policy blocks $host." \
        "Allow that host, then re-run ./scripts/bootstrap.sh. Until then 'task test-e2e' cannot run.")
    else
      warnings+=("Playwright Chromium not installed (see the output above), so 'task test-e2e' cannot run." \
        "Re-run ./scripts/bootstrap.sh, or: cd webapp && npx playwright install chromium")
    fi
  fi
  rm -f "$out"
}

# ---------------------------------------------------------------------------
# Postgres — `task test-server-postgres` starts a throwaway server from the
# PostgreSQL binaries or Docker (see scripts/test-postgres.sh, which owns the
# lookup this mirrors). Only a warning: SQLite is the default, and installing a
# database server is not something setup should do silently.
# ---------------------------------------------------------------------------

check_postgres() {
  [ -n "${TEST_POSTGRES_DSN:-}" ] && return
  if command -v initdb >/dev/null 2>&1 && command -v pg_ctl >/dev/null 2>&1; then
    return
  fi
  local dir
  for dir in /usr/lib/postgresql/*/bin; do
    [ -x "$dir/initdb" ] && [ -x "$dir/pg_ctl" ] && return
  done
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && return

  warnings+=("No Postgres for 'task test-server-postgres': neither the PostgreSQL server binaries" \
    "(initdb, pg_ctl) nor a running Docker daemon was found. Install one (e.g. apt install postgresql)" \
    "or set TEST_POSTGRES_DSN. Everything else, including 'task test-server', works without it.")
}

# ---------------------------------------------------------------------------
# Go build cache — golangci-lint type-checks every package, so on a cold cache
# the first `task lint-server` spends ~2.5 minutes compiling before it reports
# anything (it is ~1s warm). That cost lands wherever the first lint happens,
# which is usually at the end of a change and always a surprise. Pay it here
# instead, where the wait is expected and already budgeted for.
#
# Best-effort by design: a compile error in the checkout is the caller's
# problem to see from `task`, not a reason for setup to fail.
# ---------------------------------------------------------------------------

warm_go_cache() {
  if [ "${JOT_BOOTSTRAP_SKIP_GO_CACHE:-}" = "1" ]; then
    log "JOT_BOOTSTRAP_SKIP_GO_CACHE=1 — skipping Go build cache warm-up"
    return
  fi

  command -v go >/dev/null 2>&1 || return

  log "warming the Go build cache (slow only the first time)"
  if ! (cd "$REPO_ROOT/server" && go build ./... >/dev/null 2>&1); then
    log "Go build cache warm-up did not complete — 'task lint-server' will report why"
  fi
}

check_node
check_go
install_task
install_npm_deps
install_playwright_browser
check_postgres
warm_go_cache

if [ "$failures" -gt 0 ]; then
  log "finished with $failures error(s) — see above"
  exit 1
fi

if [ "${#warnings[@]}" -gt 0 ]; then
  warn "${warnings[@]}"
  log "ready, with warnings (see above) — run 'task --list' to see the available commands"
else
  log "ready — run 'task --list' to see the available commands"
fi
