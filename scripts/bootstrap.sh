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
#   * builds the `covdata` Go tool when the active toolchain ships without it,
#     so `task coverage` works
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
# covdata — `task coverage` passes -coverpkg, which makes `go test` synthesize
# an empty profile for every package that has no tests of its own, and that
# shells out to the covdata tool. A full Go installation has it. A toolchain
# module — what Go downloads when the local go is older than server/go.mod's,
# as CI images and fresh agent containers usually are — ships a trimmed
# pkg/tool that omits it, and the coverage run dies with
# `go: no such tool "covdata"`. The module does carry the matching source, so
# build the tool with the very toolchain that is missing it.
# ---------------------------------------------------------------------------

install_covdata() {
  # check_go has already reported a missing go; nothing to add here.
  command -v go >/dev/null 2>&1 || return

  # Both queries run from server/, so Go resolves the same toolchain
  # `task coverage` will use. Asked from the repo root it answers for the
  # local installation instead — whose covdata the coverage run never touches.
  local goroot tooldir tmpdir tools
  # Empty when Go cannot resolve the toolchain at all (an old local go with no
  # network, say). check_go covers that case; leave it alone here.
  goroot="$(cd "$REPO_ROOT/server" && go env GOROOT 2>/dev/null)"
  [ -n "$goroot" ] || return

  # `go tool` lists what the toolchain actually has. Note the here-string:
  # piping into `grep -q` makes grep exit at the first match, `go tool` take a
  # SIGPIPE, and `pipefail` report the whole test as failed, which reads as
  # "covdata missing" on every run.
  tools="$(cd "$REPO_ROOT/server" && go tool)"
  if grep -qx covdata <<<"$tools"; then
    return
  fi

  if [ ! -d "$goroot/src/cmd/covdata" ]; then
    warn "The Go toolchain in $goroot has no covdata tool and no source to build one from." \
      "'task coverage' will fail with: go: no such tool \"covdata\"" \
      "Installing a full go$(cd "$REPO_ROOT/server" && go env GOVERSION | sed 's/^go//') distribution fixes it."
    return
  fi

  log "building covdata (the active Go toolchain ships without it; task coverage needs it)"

  tmpdir="$(mktemp -d)" || return
  if ! (cd "$goroot/src" && GOTOOLCHAIN=local GOFLAGS= "$goroot/bin/go" build -o "$tmpdir/covdata" cmd/covdata); then
    rm -rf "$tmpdir"
    warn "Could not build covdata — 'task coverage' will fail with: go: no such tool \"covdata\"" \
      "Everything else still works; a full Go distribution ships the tool."
    return
  fi

  # $goroot is under the module cache when it is a toolchain module, and Go
  # extracts that read-only. Widen just long enough to drop the tool in.
  tooldir="$goroot/pkg/tool/$(go env GOHOSTOS)_$(go env GOHOSTARCH)"
  local relocked=""
  if [ ! -w "$tooldir" ]; then
    if chmod u+w "$tooldir" 2>/dev/null; then
      relocked=1
    else
      rm -rf "$tmpdir"
      warn "Cannot write to $tooldir, so covdata could not be installed." \
        "'task coverage' will fail with: go: no such tool \"covdata\""
      return
    fi
  fi

  if cp "$tmpdir/covdata" "$tooldir/covdata"; then
    chmod 0555 "$tooldir/covdata"
    log "installed covdata into $tooldir"
  else
    warn "Could not install covdata into $tooldir — 'task coverage' will fail."
  fi

  [ -n "$relocked" ] && chmod u-w "$tooldir"
  rm -rf "$tmpdir"
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
install_covdata
install_npm_deps

if [ "$failures" -gt 0 ]; then
  log "finished with $failures error(s) — see above"
  exit 1
fi

log "ready — run 'task --list' to see the available commands"
