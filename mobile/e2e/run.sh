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
# Set once the offline flow puts the device in airplane mode, so cleanup only
# touches the radio when this script was the one that changed it — a flow that
# fails while offline must not leave a local emulator stuck that way.
AIRPLANE_TOGGLED=0
cleanup() {
  if [ "$AIRPLANE_TOGGLED" -eq 1 ]; then
    adb shell cmd connectivity airplane-mode disable >/dev/null 2>&1 || true
  fi
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT

# `cmd connectivity airplane-mode` is the API 30+ spelling and works from the adb
# shell user on the emulator. The flows cannot do this themselves: Maestro's
# runScript is a GraalJS sandbox with no child_process, so radio changes are
# sequenced here, between flows (which is why the flows are numbered).
set_airplane_mode() {
  echo "==> Airplane mode: $1"
  adb shell cmd connectivity airplane-mode "$1"
  if [ "$1" = "enable" ]; then
    AIRPLANE_TOGGLED=1
  else
    AIRPLANE_TOGGLED=0
  fi
}

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
MAESTRO_JOT_OFFLINE_NOTE="Offline note ${RUN_ID}"
readonly RUN_ID MAESTRO_JOT_USERNAME MAESTRO_JOT_PASSWORD MAESTRO_JOT_NOTE_TITLE \
  MAESTRO_JOT_OFFLINE_NOTE

# One flow at a time so airplane mode can be toggled between them. Each flow gets
# its own JUnit report (report-<flow>.xml) so a multi-flow run does not clobber
# earlier results; the CI artifact glob is report*.xml. `$@` forwards any extra
# maestro flags (e.g. --debug-output) to every flow.
maestro_flow() {
  local flow="$1"
  shift
  maestro test \
    -e MAESTRO_JOT_SERVER_URL="$SERVER_URL_FROM_EMULATOR" \
    -e MAESTRO_JOT_USERNAME="$MAESTRO_JOT_USERNAME" \
    -e MAESTRO_JOT_PASSWORD="$MAESTRO_JOT_PASSWORD" \
    -e MAESTRO_JOT_NOTE_TITLE="$MAESTRO_JOT_NOTE_TITLE" \
    -e MAESTRO_JOT_OFFLINE_NOTE="$MAESTRO_JOT_OFFLINE_NOTE" \
    --format junit \
    --output "$E2E_DIR/report-$(basename "$flow" .yaml).xml" \
    "$@" \
    "$E2E_DIR/flows/$flow"
}

# Bounded wait for the offline-created note to reach the server. The flows prove
# the UI recovered on reconnect; this proves the queued write actually synced
# (not just that it still renders from the local database). Deterministic where a
# fixed sleep would be flaky. Uses the same account flow 01 registered.
assert_offline_note_synced() {
  echo "==> Verifying the offline note reached the server"
  local api="http://localhost:${JOT_E2E_PORT}/api/v1"
  local jar="$RUN_DIR/cookies.txt"
  if ! curl "${READY_CURL_OPTS[@]}" -c "$jar" -H 'Content-Type: application/json' \
      -d "{\"username\":\"${MAESTRO_JOT_USERNAME}\",\"password\":\"${MAESTRO_JOT_PASSWORD}\"}" \
      "$api/login" >/dev/null 2>&1; then
    echo "Could not log in to verify the offline note synced." >&2
    return 1
  fi
  for _ in $(seq 1 30); do
    if curl "${READY_CURL_OPTS[@]}" -b "$jar" "$api/notes" 2>/dev/null \
        | grep -qF "$MAESTRO_JOT_OFFLINE_NOTE"; then
      echo "Offline note synced to the server."
      return 0
    fi
    sleep 1
  done
  echo "Offline note never reached the server within 30s." >&2
  return 1
}

echo "==> Running Maestro flows"

# 01 — harness smoke test: register, create a note online, land on the notes list.
maestro_flow 01-smoke.yaml "$@"

# 02-03 — offline round-trip, continuing the session 01 left logged in. A note
# created while the device is offline (02) must survive the reconnect and reach
# the server (03 + the API check below). Airplane mode wraps the offline flow;
# it is toggled here rather than in the flows for the reason on set_airplane_mode.
# The cleanup trap re-enables the radio if a flow fails while offline, so a failed
# local run does not leave the emulator stuck in airplane mode.
set_airplane_mode enable
maestro_flow 02-offline-write.yaml "$@"
set_airplane_mode disable
maestro_flow 03-online-sync.yaml "$@"
assert_offline_note_synced
