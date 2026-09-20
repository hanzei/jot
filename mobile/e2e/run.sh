#!/usr/bin/env bash
#
# run.sh — start a throwaway Jot server and run the Maestro flows against it.
# The mobile counterpart to Playwright's `webServer` block.
#
# Maestro cannot shell out mid-flow (`runScript` is a GraalJS sandbox with no
# child_process), so anything needing adb — airplane mode, share intents — is
# sequenced from here, between flows. Flows are numbered for that reason.
#
# Run it via `task test-mobile-e2e`, which checks prerequisites first.

set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$E2E_DIR/../.." && pwd)"
readonly E2E_DIR REPO_ROOT

# 10.0.2.2 is the emulator's alias for the host loopback, and already what
# getDefaultBaseUrl() returns on Android — app default and fixture agree.
JOT_E2E_PORT="${JOT_E2E_PORT:-8080}"
SERVER_URL_FROM_EMULATOR="http://10.0.2.2:${JOT_E2E_PORT}"

# A directory, not a bare file: SQLite leaves `-wal` and `-shm` beside the
# database, which removing the `.db` alone would strand.
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/jot-mobile-e2e-XXXXXX")"
DB_DSN="$RUN_DIR/jot.db"
# The server refuses to start without its static dir, and defaults to
# webapp/build. The mobile app never touches the SPA, so point it at an empty
# directory rather than depend on `task build-webapp`.
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
# Built rather than `go run` so the readiness wait measures startup, not a
# cold compile — same reasoning as `warm-server-build`.
(cd "$REPO_ROOT/server" && go build -buildvcs=false -o "$REPO_ROOT/server/jot-e2e" .)

echo "==> Starting the server on port $JOT_E2E_PORT (db: $DB_DSN)"
(
  cd "$REPO_ROOT/server"
  # Rate limiting off because the flows register in a tight loop; cookies
  # non-Secure because the emulator talks plain HTTP.
  JOT_DB_DSN="$DB_DSN" \
  JOT_STATIC_DIR="$STATIC_DIR" \
  JOT_PORT="$JOT_E2E_PORT" \
  JOT_COOKIE_SECURE=false \
  JOT_RATE_LIMIT_ENABLED=false \
    ./jot-e2e
) &
SERVER_PID=$!

echo "==> Waiting for /readyz"
# Bounded: without a timeout, a server that accepts the connection but never
# answers makes "60 attempts" a bound on nothing.
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

# Fresh per run, so the suite survives a server that was not torn down.
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
