#!/usr/bin/env bash
#
# lib_test.sh — tests for lib.sh's failure classification. The retries built on
# it only run when a device flake happens, so a broken check otherwise goes
# unnoticed until it fails to absorb one (run #163). Needs no emulator.
#
# Run via `task test-mobile-e2e-scripts`.

# The same shell options as ci-run.sh, the stricter of the two callers: the
# SIGPIPE bug only showed under pipefail.
set -uo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$E2E_DIR/lib.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/jot-e2e-lib-test-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; failures=$((failures + 1)); }

# expect 0|1 NAME CMD... — run CMD and compare "matched" (0) or "did not" (1).
expect() {
  local want="$1" name="$2"
  shift 2
  local got=0
  "$@" || got=$?
  [ "$got" -ne 0 ] && got=1
  if [ "$got" -eq "$want" ]; then pass "$name"; else fail "$name (got $got, want $want)"; fi
}

# Run #163's report, trimmed: the driver died in Maestro's flow setup.
cat >"$TMP/prestart.xml" <<'EOF'
<testcase id="04-share-intent" status="ERROR">
  <failure>maestro.android.DeviceServerDiedException: Device server died during 'deviceInfo' on emulator-5554
	at maestro.drivers.AndroidDriver.deviceInfo(AndroidDriver.kt:202)
	at maestro.Maestro.getCachedDeviceInfo(Maestro.kt:54)
	at maestro.orchestra.Orchestra._init_$lambda$12(Orchestra.kt:160)
	at maestro.orchestra.Orchestra.initJsEngine(Orchestra.kt:372)
	at maestro.orchestra.Orchestra.runFlow(Orchestra.kt:201)
Caused by: io.grpc.StatusRuntimeException: UNAVAILABLE
  </failure>
</testcase>
EOF

# The same death, but while a command ran: state may have changed.
cat >"$TMP/midflow.xml" <<'EOF'
<testcase id="02-offline-write" status="ERROR">
  <failure>maestro.android.DeviceServerDiedException: Device server died during 'viewHierarchy'
	at maestro.orchestra.Orchestra.executeCommand(Orchestra.kt:420)
	at maestro.orchestra.Orchestra$executeCommands$1.invokeSuspend(Orchestra.kt:300)
	at maestro.orchestra.Orchestra.initJsEngine(Orchestra.kt:372)
  </failure>
</testcase>
EOF

# A genuine assertion failure.
cat >"$TMP/assertion.xml" <<'EOF'
<testcase id="04-share-intent" status="ERROR">
  <failure>Assertion is false: id: note-content-input is visible</failure>
</testcase>
EOF

# Far bigger than a pipe buffer, with no signature of its own: the old
# `cat report logcat | grep -q` returned 141 here when the report matched.
yes 'I/ActivityManager: unrelated logcat line' | head -c 2000000 >"$TMP/logcat.txt"

expect 0 "infra: report signature beside a large logcat" \
  is_infra_failure "$TMP/prestart.xml" "$TMP/logcat.txt"
expect 0 "infra: signature only in logcat" \
  is_infra_failure "$TMP/assertion.xml" "$TMP/logcat.txt" <(echo "adbd: failed to connect to socket 'tcp:39775'")
expect 1 "infra: assertion failure is not infra" \
  is_infra_failure "$TMP/assertion.xml" "$TMP/logcat.txt"
expect 1 "infra: missing files are not infra" \
  is_infra_failure "$TMP/nope-*.xml" "$TMP/nope.txt"

expect 0 "prestart: driver died in flow setup" \
  is_prestart_driver_death "$TMP/prestart.xml"
expect 1 "prestart: driver died while a command ran" \
  is_prestart_driver_death "$TMP/midflow.xml"
expect 1 "prestart: assertion failure" \
  is_prestart_driver_death "$TMP/assertion.xml"
expect 1 "prestart: no report written" \
  is_prestart_driver_death "$TMP/missing.xml"

out="$(GITHUB_ACTIONS=true ci_warning 'flow 04 retried')"
if [ "$out" = '::warning title=Mobile e2e retry::flow 04 retried' ]; then
  pass "ci_warning: annotation in GitHub Actions"
else
  fail "ci_warning: annotation in GitHub Actions (got: $out)"
fi
out="$(GITHUB_ACTIONS='' ci_warning 'flow 04 retried')"
if [ "$out" = '==> WARNING: flow 04 retried' ]; then
  pass "ci_warning: plain line elsewhere"
else
  fail "ci_warning: plain line elsewhere (got: $out)"
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures test(s) failed" >&2
  exit 1
fi
