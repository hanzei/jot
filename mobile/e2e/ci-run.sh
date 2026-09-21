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
# shellcheckable.
#
# Preconditions the workflow guarantees: a booted emulator on adb, and the debug
# APK already downloaded to the path passed as $1 (default apk/app-release.apk,
# relative to the workspace root this runs from).
set -uo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APK="${1:-apk/app-release.apk}"
readonly E2E_DIR APK

echo "==> Installing $APK"
adb install -r -g "$APK"

# Best-effort screen recording for the failure video (screenrecord caps at 180s).
adb shell screenrecord --bit-rate 4000000 --time-limit 180 /sdcard/e2e.mp4 &
rec_pid=$!

# run.sh starts the throwaway server and runs the flows. Capture its status
# instead of letting a failure abort this driver, so the diagnostics below always
# run on a red flow.
status=0
"$E2E_DIR/run.sh" || status=$?

adb shell pkill -INT screenrecord 2>/dev/null || true
wait "$rec_pid" 2>/dev/null || true
adb pull /sdcard/e2e.mp4 "$E2E_DIR/e2e-video.mp4" 2>/dev/null || true

if [ "$status" -ne 0 ]; then
  echo "==> Flow failed (status $status); collecting on-screen diagnostics"
  # adb is guaranteed here, so this never depends on Maestro's own artifact
  # layout. Maestro's per-step dump (~/.maestro/tests) is copied too when present.
  adb exec-out screencap -p > "$E2E_DIR/failure-screenshot.png" 2>/dev/null || true
  adb shell uiautomator dump /sdcard/ui.xml 2>/dev/null || true
  adb pull /sdcard/ui.xml "$E2E_DIR/ui-hierarchy.xml" 2>/dev/null || true
  # logcat distinguishes a native/JS crash (AndroidRuntime/ReactNativeJS FATAL)
  # from a Maestro assertion failure — the two need different fixes.
  adb logcat -d > "$E2E_DIR/logcat.txt" 2>/dev/null || true
  cp -r "$HOME/.maestro/tests" "$E2E_DIR/maestro-debug" 2>/dev/null || true
  # Echo the interesting lines into the job log too, so a failure is diagnosable
  # without downloading the artifact.
  echo "==> logcat highlights:"
  grep -iE 'cleartext|androidruntime|reactnativejs|fatal|econnrefused|failed to connect|jotmobile' \
    "$E2E_DIR/logcat.txt" 2>/dev/null | tail -40 || true
fi

exit "$status"
