#!/usr/bin/env bash
#
# ci-run.sh — CI-only driver for the Maestro emulator job (.github/workflows/mobile-e2e.yml).
#
# reactivecircus/android-emulator-runner executes its `script:` input line by
# line as separate `sh -c` calls and stops at the first non-zero line, so inline
# multi-line control flow, variable persistence, backgrounding, and post-failure
# cleanup all break there (a bare `set -o pipefail` even fails outright — dash).
# Keeping the logic in one script means one shell: `set`, the screenrecord
# background job, $status, and the on-failure diagnostics all work, and it stays
# clean under shellcheck.
#
# Preconditions the workflow guarantees: a booted emulator on adb, and the debug
# APK already downloaded to the path passed as $1 (default apk/app-release.apk,
# relative to the workspace root this runs from).
#
# The whole flow set (run.sh) is retried once by default on a transient
# device-driver death — see the retry loop at the bottom and is_infra_failure.
set -uo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APK="${1:-apk/app-release.apk}"
# One retry by default. run.sh is a self-contained session (its own throwaway
# server + DB, and flow 01 does `launchApp: clearState`), so re-running the
# whole thing is a clean reset — which is why the retry is whole-run rather than
# per-flow: the flows share state, so flow N cannot be re-run without 1..N-1.
MAX_ATTEMPTS="${E2E_MAX_ATTEMPTS:-2}"
if ! [[ "$MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  echo "E2E_MAX_ATTEMPTS must be a positive integer, got: '$MAX_ATTEMPTS'" >&2
  exit 2
fi
readonly E2E_DIR APK MAX_ATTEMPTS

# Failure markers that mean the on-device Maestro driver (the uiautomator gRPC
# server) or the emulator dropped out mid-flow, rather than an assertion failing.
# Kept in step with the signatures seen failing master (runs #27/#30): a Maestro
# DeviceServerDiedException, the gRPC "UNAVAILABLE: End of stream" underneath it,
# the bare "<failure>Unknown error" Maestro writes when it cannot classify a
# driver death, and adbd's "failed to connect to socket" when the driver port
# drops. A genuine assertion failure carries none of these and is NOT retried, so
# a real regression still fails fast and loud.
readonly INFRA_FAILURE_RE='DeviceServerDied|Device server died|UNAVAILABLE: End of stream|StatusRuntimeException|Unknown error|failed to connect to socket|io\.grpc'

# android-emulator-runner only starts this script once the emulator reports
# booted, but the window manager and launcher can still be settling, and the
# first viewHierarchy dump racing that is one way the driver dies early. Wait
# explicitly for boot to complete (then a short settle); if it never does within
# the bound the emulator is stuck, so fail with a clear message rather than
# install onto a half-booted device and hit a confusing downstream failure.
echo "==> Waiting for the emulator to finish booting"
adb wait-for-device
booted=0
for _ in $(seq 1 60); do
  if [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '[:space:]')" = "1" ]; then
    booted=1
    break
  fi
  sleep 2
done
if [ "$booted" -ne 1 ]; then
  echo "Emulator did not finish booting within 120s (sys.boot_completed never became 1)." >&2
  exit 1
fi
sleep 5

echo "==> Installing $APK"
adb install -r -g "$APK"

# Collect on-screen and log diagnostics for the attempt that just failed.
# Overwrites per attempt, so the uploaded artifact reflects the final attempt —
# and, crucially, writes logcat.txt before is_infra_failure reads it.
collect_diagnostics() {
  local status="$1"
  echo "==> Flow run failed (status $status); collecting on-screen diagnostics"
  # adb is guaranteed here, so this never depends on Maestro's own artifact
  # layout. Maestro's per-step dump (~/.maestro/tests) is copied too when present.
  adb exec-out screencap -p > "$E2E_DIR/failure-screenshot.png" 2>/dev/null || true
  adb shell uiautomator dump /sdcard/ui.xml 2>/dev/null || true
  adb pull /sdcard/ui.xml "$E2E_DIR/ui-hierarchy.xml" 2>/dev/null || true
  # logcat distinguishes a native/JS crash (AndroidRuntime/ReactNativeJS FATAL)
  # from a Maestro assertion failure — the two need different fixes.
  adb logcat -d > "$E2E_DIR/logcat.txt" 2>/dev/null || true
  cp -r "$HOME/.maestro/tests" "$E2E_DIR/maestro-debug" 2>/dev/null || true
  # The per-command assertion error (which step failed, and why) goes to the
  # JUnit report, not Maestro's stdout, so echo the failing report(s) here — the
  # emulator artifacts are awkward to pull after the fact. Each flow's report is
  # tiny, so cat the whole thing rather than trying to parse out the <failure>.
  echo "==> Maestro JUnit report(s) with failures:"
  for report in "$E2E_DIR"/report-*.xml; do
    [ -f "$report" ] || continue
    grep -q '<\(failure\|error\)' "$report" || continue
    echo "--- $(basename "$report")"
    cat "$report"
  done
  # Echo the interesting lines into the job log too, so a failure is diagnosable
  # without downloading the artifact.
  echo "==> logcat highlights:"
  grep -iE 'cleartext|androidruntime|reactnativejs|fatal|econnrefused|failed to connect|jotmobile' \
    "$E2E_DIR/logcat.txt" 2>/dev/null | tail -40 || true
  # The on-screen widgets (resource-id | text) show which screen we are stuck on
  # and any error text — e.g. the server-setup input's current value and the
  # login-server-setup-error message when server validation rejects the URL.
  echo "==> UI hierarchy (resource-id | text):"
  sed 's/></>\n</g' "$E2E_DIR/ui-hierarchy.xml" 2>/dev/null \
    | sed -nE 's/.*text="([^"]*)".*resource-id="([^"]*)".*/\2 | \1/p' \
    | grep -vE '^ \| $' | head -80 || true
}

# True when the just-collected reports/logcat show a device-driver death rather
# than an assertion failure. Reads the files collect_diagnostics wrote.
is_infra_failure() {
  { cat "$E2E_DIR"/report-*.xml 2>/dev/null; cat "$E2E_DIR/logcat.txt" 2>/dev/null; } \
    | grep -Eq "$INFRA_FAILURE_RE"
}

# Force a clean slate before a retry. run.sh's own EXIT trap already disables any
# airplane mode it toggled, but a driver death can leave the radio or the app in
# an odd state; reset both so the next attempt's flow 01 (launchApp clearState)
# starts from the same place the first attempt did.
reset_device_state() {
  adb shell cmd connectivity airplane-mode disable >/dev/null 2>&1 || true
  adb shell am force-stop com.jot.app >/dev/null 2>&1 || true
}

# One pass over the whole flow set. run.sh starts the throwaway server and runs
# the flows; capture its status instead of letting a failure abort this driver so
# the diagnostics/retry logic below always runs. Stale reports from a prior
# attempt are cleared first so is_infra_failure and the artifact reflect this one.
run_attempt() {
  rm -f "$E2E_DIR"/report-*.xml
  # Clear the device log buffer so logcat.txt — and the is_infra_failure scan
  # over it — reflects only this attempt, not a driver death from a prior one
  # (adb logcat -d dumps the whole ring buffer, which otherwise persists across
  # attempts and could misclassify a genuine failure as infra and retry it).
  adb logcat -c 2>/dev/null || true
  # Best-effort screen recording for the failure video (screenrecord caps at 180s).
  adb shell screenrecord --bit-rate 4000000 --time-limit 180 /sdcard/e2e.mp4 &
  local rec_pid=$!
  local status=0
  "$E2E_DIR/run.sh" || status=$?
  adb shell pkill -INT screenrecord 2>/dev/null || true
  wait "$rec_pid" 2>/dev/null || true
  adb pull /sdcard/e2e.mp4 "$E2E_DIR/e2e-video.mp4" 2>/dev/null || true
  return "$status"
}

status=0
attempt=1
while : ; do
  echo "==> Running Maestro flows (attempt $attempt/$MAX_ATTEMPTS)"
  status=0
  run_attempt || status=$?
  [ "$status" -eq 0 ] && break

  collect_diagnostics "$status"

  if [ "$attempt" -lt "$MAX_ATTEMPTS" ] && is_infra_failure; then
    echo "==> Failure matches a transient device-driver signature; retrying (attempt $((attempt + 1))/$MAX_ATTEMPTS)."
    reset_device_state
    attempt=$((attempt + 1))
    continue
  fi
  break
done

exit "$status"
