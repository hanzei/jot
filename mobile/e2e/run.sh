#!/usr/bin/env bash
#
# run.sh — start a throwaway Jot server and run the Maestro flows against it.
#
# This is the mobile counterpart to Playwright's `webServer` block in
# webapp/playwright.config.ts: the suite owns its own server on a throwaway
# database so runs never depend on, or corrupt, whatever is running locally.
#
# It also exists because Maestro cannot shell out mid-flow — `runScript` runs in
# a GraalJS sandbox with no child_process. So anything requiring adb (toggling
# connectivity for the offline-replay flow, delivering a share intent) has to be
# sequenced from out here, between flows, rather than inside one. The flows are
# numbered so that ordering is explicit when that day comes.
#
# Run it through `task test-mobile-e2e` rather than directly, so the
# prerequisite checks happen first.

set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$E2E_DIR/../.." && pwd)"
readonly E2E_DIR REPO_ROOT

# The emulator reaches the host loopback at 10.0.2.2 — which is exactly what
# getDefaultBaseUrl() in src/api/client.ts already returns on Android, so the
# app's default and the suite's fixture agree with no extra configuration.
JOT_E2E_PORT="${JOT_E2E_PORT:-8080}"
SERVER_URL_FROM_EMULATOR="http://10.0.2.2:${JOT_E2E_PORT}"
# An owned directory rather than a name in shared /tmp: mktemp -d creates it
# atomically with private permissions, so the path cannot have been pre-created
# as a symlink pointing somewhere else. It also makes cleanup complete — SQLite
# leaves `-wal` and `-shm` files beside the database, which removing the `.db`
# alone would strand.
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/jot-mobile-e2e-XXXXXX")"
DB_DSN="$RUN_DIR/jot.db"
# The server refuses to start if its static directory is missing, and it
# defaults to webapp/build — which only exists after a webapp build. The mobile
# app never touches the SPA, so point it at an empty directory instead of making
# this suite depend on `task build-webapp`.
STATIC_DIR="$RUN_DIR/static"
mkdir -p "$STATIC_DIR"
readonly JOT_E2E_PORT SERVER_URL_FROM_EMULATOR RUN_DIR DB_DSN STATIC_DIR

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT

echo "==> Building the server"
# Built rather than `go run` so the readiness wait below is bounded by startup
# time and not by a cold compile, same reasoning as `warm-server-build` for the
# webapp e2e suite.
(cd "$REPO_ROOT/server" && go build -buildvcs=false -o "$REPO_ROOT/server/jot-e2e" .)

echo "==> Starting the server on port $JOT_E2E_PORT (db: $DB_DSN)"
(
  cd "$REPO_ROOT/server"
  # Mirrors the webapp e2e server env. Rate limiting is off because the flows
  # register users in a tight loop, which trips the per-IP auth limit almost
  # immediately; cookies are non-Secure because the emulator talks plain HTTP.
  JOT_DB_DSN="$DB_DSN" \
  JOT_STATIC_DIR="$STATIC_DIR" \
  JOT_PORT="$JOT_E2E_PORT" \
  JOT_COOKIE_SECURE=false \
  JOT_RATE_LIMIT_ENABLED=false \
    ./jot-e2e
) &
SERVER_PID=$!

echo "==> Waiting for /readyz"
# Bounded so a server that accepts the connection but never answers costs one
# second per attempt rather than hanging the loop indefinitely — without a
# timeout the "60 attempts" below is not a bound on anything.
readonly READY_CURL_OPTS=(--connect-timeout 2 --max-time 5 -fsS)
for _ in $(seq 1 60); do
  if curl "${READY_CURL_OPTS[@]}" "http://localhost:${JOT_E2E_PORT}/readyz" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server exited before becoming ready." >&2
    exit 1
  fi
  sleep 1
done

if ! curl "${READY_CURL_OPTS[@]}" "http://localhost:${JOT_E2E_PORT}/readyz" >/dev/null 2>&1; then
  echo "Server did not become ready within 60s." >&2
  exit 1
fi

# A fresh username per run keeps the suite re-runnable against a server that was
# not torn down (a local emulator session, a retried CI job). The password is
# well over any JOT_PASSWORD_MIN_LENGTH default.
RUN_ID="$(date +%s)$$"
MAESTRO_JOT_USERNAME="e2e${RUN_ID}"
MAESTRO_JOT_PASSWORD="maestro-e2e-password"
MAESTRO_JOT_NOTE_TITLE="Smoke note ${RUN_ID}"

echo "==> Running Maestro flows"
maestro test \
  -e MAESTRO_JOT_SERVER_URL="$SERVER_URL_FROM_EMULATOR" \
  -e MAESTRO_JOT_USERNAME="$MAESTRO_JOT_USERNAME" \
  -e MAESTRO_JOT_PASSWORD="$MAESTRO_JOT_PASSWORD" \
  -e MAESTRO_JOT_NOTE_TITLE="$MAESTRO_JOT_NOTE_TITLE" \
  --format junit \
  --output "$E2E_DIR/report.xml" \
  "$@" \
  "$E2E_DIR/flows"
