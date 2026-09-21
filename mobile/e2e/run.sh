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

# Fire a real OS intent via adb between flows — the same constraint that forces
# set_airplane_mode out of the flows (Maestro's runScript is a GraalJS sandbox
# with no child_process) applies to intent delivery too, which is why the flows
# are numbered and the intent is sequenced here. Passing the target package to
# `am start` alongside the action resolves the intent to the app's own
# intent-filtered activity with no chooser; the running app receives it via
# onNewIntent.
send_share_intent() {
  echo "==> Sending share intent (text: $MAESTRO_JOT_SHARE_TEXT)"
  # expo-share-intent's plugin registers the ACTION_SEND text/* filter (app.json).
  # -W blocks until the launch completes, so the intent is delivered and the app
  # is foregrounded before flow 04 attaches (the flow does not relaunch); flow
  # 04's extendedWaitUntil then absorbs the async editor navigation.
  adb shell am start -W -a android.intent.action.SEND -t text/plain \
    --es android.intent.extra.TEXT "$MAESTRO_JOT_SHARE_TEXT" com.jot.app
}

send_deep_link() {
  echo "==> Sending deep-link intent ($DEEP_LINK_URL)"
  # -W blocks until the activity launch completes, so the VIEW intent has been
  # delivered to the running app (onNewIntent → the Linking 'url' handler) before
  # run.sh returns and starts flow 06. That handler stashes the link
  # asynchronously — two SecureStore reads (getStoredServerUrl, listServers)
  # before setPendingDeepLink sets its in-memory mirror synchronously — and flow
  # 06 only reads it back after Maestro's ~10s flow startup plus the sign-in
  # round-trip, so the stash is in place with a wide margin before the replay
  # effect runs on the isAuthenticated flip.
  # The jot:// scheme filter comes from app.json's `scheme`. The URL is one
  # unquoted token (no spaces); the device shell passes an unmatched glob (the
  # `?`) through literally, so `am start` receives the URL intact.
  adb shell am start -W -a android.intent.action.VIEW -d "$DEEP_LINK_URL" com.jot.app
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
# No spaces: the share text is passed to `adb shell am start --es ...`, whose
# argument survives the adb-shell → device-sh hop only as a single unquoted
# token. Hyphens keep it one token end to end.
MAESTRO_JOT_SHARE_TEXT="Shared-intent-note-${RUN_ID}"
# Distinct from the 02 offline note so the process-kill trio (07-09) exercises
# its own undrained write, independent of the one 03 already drained.
MAESTRO_JOT_KILL_NOTE="Kill-persist note ${RUN_ID}"
# Created out-of-band via the server API (create_note_via_api) while the app is
# backgrounded and its SSE stream is torn down, for the catch-up resync scenario
# (10-11). No spaces: the card matches on this exact content text, and keeping it
# one token mirrors the other note titles here.
MAESTRO_JOT_SSE_NOTE="SSE-resync-note-${RUN_ID}"
# Deep link delivered signed out (flow 05) that must resolve after sign-in (06).
# The ?server= param is canonicalized identically on both sides so it matches the
# known server (no "unknown server" prompt fires); `settings` is a protected path
# that needs no pre-existing entity to resolve.
DEEP_LINK_URL="jot://settings?server=${SERVER_URL_FROM_EMULATOR}"
readonly RUN_ID MAESTRO_JOT_USERNAME MAESTRO_JOT_PASSWORD MAESTRO_JOT_NOTE_TITLE \
  MAESTRO_JOT_OFFLINE_NOTE MAESTRO_JOT_SHARE_TEXT MAESTRO_JOT_KILL_NOTE \
  MAESTRO_JOT_SSE_NOTE DEEP_LINK_URL

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
    -e MAESTRO_JOT_SHARE_TEXT="$MAESTRO_JOT_SHARE_TEXT" \
    -e MAESTRO_JOT_KILL_NOTE="$MAESTRO_JOT_KILL_NOTE" \
    -e MAESTRO_JOT_SSE_NOTE="$MAESTRO_JOT_SSE_NOTE" \
    --format junit \
    --output "$E2E_DIR/report-$(basename "$flow" .yaml).xml" \
    "$@" \
    "$E2E_DIR/flows/$flow"
}

# Bounded wait for a queued note to reach the server, given its content text as
# $1. The flows prove the UI recovered on reconnect; this proves the queued write
# actually synced (not just that it still renders from the local database).
# Deterministic where a fixed sleep would be flaky. Uses the same account flow 01
# registered. Two call sites: the offline round-trip (03) and the process-kill
# trio (09).
assert_note_synced() {
  local note_text="$1"
  echo "==> Verifying the note reached the server ($note_text)"
  local api="http://localhost:${JOT_E2E_PORT}/api/v1"
  local jar="$RUN_DIR/cookies.txt"
  if ! curl "${READY_CURL_OPTS[@]}" -c "$jar" -H 'Content-Type: application/json' \
      -d "{\"username\":\"${MAESTRO_JOT_USERNAME}\",\"password\":\"${MAESTRO_JOT_PASSWORD}\"}" \
      "$api/login" >/dev/null 2>&1; then
    echo "Could not log in to verify the note synced." >&2
    return 1
  fi
  for _ in $(seq 1 30); do
    if curl "${READY_CURL_OPTS[@]}" -b "$jar" "$api/notes" 2>/dev/null \
        | grep -qF "$note_text"; then
      echo "Note synced to the server."
      return 0
    fi
    sleep 1
  done
  echo "Note never reached the server within 30s." >&2
  return 1
}

# Kill the app between flows, so a subsequent launchApp is a cold start from a
# dead process rather than a clean relaunch. Same sequenced-from-run.sh constraint
# as the airplane and intent helpers: Maestro's runScript is a GraalJS sandbox
# with no child_process, so the force-stop cannot live in a flow. force-stop
# succeeds whether or not the app is running, so this needs no running-state guard.
force_stop_app() {
  echo "==> Force-stopping com.jot.app"
  adb shell am force-stop com.jot.app
}

# Background the app by sending it to the launcher (adb HOME) — the same
# sequenced-from-run.sh constraint as the helpers above (Maestro's runScript is a
# GraalJS sandbox with no child_process). This is deliberately *not* a force-stop:
# the process stays alive, so useSSE's AppState 'background' handler runs
# stopConnection() and tears the live SSE stream down, while React state (notably
# useSSE's hasConnectedOnceRef) survives. The short settle lets the 'background'
# transition and the stream teardown land before we mutate server state.
background_app() {
  echo "==> Backgrounding com.jot.app (HOME)"
  adb shell input keyevent KEYCODE_HOME
  sleep 3
}

# Foreground the app with a launcher intent. MainActivity is singleTask (Expo's
# scheme/deep-link support requires it — the jot:// flows rely on the same), so a
# LAUNCHER intent to the still-alive backgrounded task *warm-resumes* the existing
# instance (onNewIntent → onResume) rather than cold-starting it. That preserves
# the running JS state, so useSSE reopens the stream and — because the process
# already connected once — fires the catch-up resync. A cold relaunch would reset
# hasConnectedOnceRef and reload the note list from scratch, masking the bug.
foreground_app() {
  echo "==> Foregrounding com.jot.app (warm resume)"
  adb shell monkey -p com.jot.app -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
}

# Create a note directly against the server API, out-of-band from the app, given
# its content text as $1. Used by the SSE catch-up scenario (10-11) to mutate
# server state while the app is backgrounded and its stream is down, so the note
# is one the app never received an SSE event for. Logs in with the same account
# flow 01 registered (reusing assert_note_synced's cookie jar) and POSTs a text
# note; the server replies 201 with the created note.
create_note_via_api() {
  local note_text="$1"
  echo "==> Creating a note out-of-band via the API ($note_text)"
  local api="http://localhost:${JOT_E2E_PORT}/api/v1"
  local jar="$RUN_DIR/cookies.txt"
  if ! curl "${READY_CURL_OPTS[@]}" -c "$jar" -H 'Content-Type: application/json' \
      -d "{\"username\":\"${MAESTRO_JOT_USERNAME}\",\"password\":\"${MAESTRO_JOT_PASSWORD}\"}" \
      "$api/login" >/dev/null 2>&1; then
    echo "Could not log in to create the out-of-band note." >&2
    return 1
  fi
  if ! curl "${READY_CURL_OPTS[@]}" -b "$jar" -H 'Content-Type: application/json' \
      -d "{\"content\":\"${note_text}\",\"note_type\":\"text\"}" \
      "$api/notes" >/dev/null 2>&1; then
    echo "Could not create the out-of-band note." >&2
    return 1
  fi
  echo "Out-of-band note created on the server."
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
assert_note_synced "$MAESTRO_JOT_OFFLINE_NOTE"

# 04 — share intent (OS integration). A real ACTION_SEND text intent, fired here
# because Maestro cannot shell out, opens a new note pre-filled with the shared
# text. The flow does not relaunch — that would drop the just-delivered intent —
# so the intent is sent immediately before it. Continues the signed-in session.
send_share_intent
maestro_flow 04-share-intent.yaml "$@"

# 05-06 — deep link delivered while signed out must still resolve after sign-in
# (the #854 regression). 05 signs out and lands on the login screen; the jot://
# VIEW intent is delivered *here*, while signed out, so useDeepLinkRouting stashes
# it; 06 signs back in and asserts the stashed link resolved to the target screen.
maestro_flow 05-deep-link-signout.yaml "$@"
send_deep_link
maestro_flow 06-deep-link-replay.yaml "$@"

# 07-09 — process-kill persistence (follow-up to the 02/03 round-trip). The
# stronger guarantee: an offline write survives a process *kill* while the sync
# queue still holds it, then drains on the next reconnect — the mid-drain window
# 03's clean relaunch never hits. 07 creates the note offline (queued, undrained);
# the force-stop below kills the app with the queue non-empty and before any
# reconnect; 08 relaunches from that dead process, still offline, and asserts the
# note is read back from SQLite (the server never had it); then airplane mode goes
# off and 09 asserts it drains without dead-lettering, with the API poll below as
# the authoritative "actually synced" proof. Continues the signed-in session; the
# adb steps are sequenced here for the reason on set_airplane_mode/force_stop_app.
set_airplane_mode enable
maestro_flow 07-kill-offline-write.yaml "$@"
force_stop_app
maestro_flow 08-kill-survives-relaunch.yaml "$@"
set_airplane_mode disable
maestro_flow 09-kill-drains.yaml "$@"
assert_note_synced "$MAESTRO_JOT_KILL_NOTE"

# 10-11 — SSE catch-up resync on foreground-after-drop (#987; related bug #481).
# The guarantee: an event that arrived while the stream was down (e.g. while
# backgrounded) is re-pulled when the app is foregrounded, *without* a cold
# relaunch masking it. 10 arms the scenario in the still-running signed-in
# session (SSE connected). Then the app is backgrounded (HOME) — which tears the
# stream down client-side — a note is created out-of-band via the server API
# while the stream is down, and the app is warm-resumed with a launcher intent
# (no cold start); 11 asserts the out-of-band note appears via the reconnect
# resync. The adb/API steps are sequenced here for the reason on
# set_airplane_mode/force_stop_app (Maestro cannot shell out mid-flow).
maestro_flow 10-sse-resync-arm.yaml "$@"
background_app
create_note_via_api "$MAESTRO_JOT_SSE_NOTE"
foreground_app
maestro_flow 11-sse-resync-catchup.yaml "$@"
