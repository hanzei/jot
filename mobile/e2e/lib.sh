# lib.sh — failure classification shared by run.sh and ci-run.sh. Sourced, not
# run; lib_test.sh covers it (`task test-mobile-e2e-scripts`), because the retry
# paths that depend on it only execute when a device flake happens.

# Failure markers that mean the on-device Maestro driver (the uiautomator gRPC
# server) or the emulator dropped out, rather than an assertion failing.
# Kept in step with the signatures seen failing master (runs #27/#30/#163): a
# Maestro DeviceServerDiedException, the gRPC "UNAVAILABLE: End of stream"
# underneath it, the bare "<failure>Unknown error" Maestro writes when it cannot
# classify a driver death, and adbd's "failed to connect to socket" when the
# driver port drops. A genuine assertion failure carries none of these and is
# NOT retried, so a real regression still fails fast and loud.
# shellcheck disable=SC2034 # read by the sourcing scripts
readonly INFRA_FAILURE_RE='DeviceServerDied|Device server died|UNAVAILABLE: End of stream|StatusRuntimeException|Unknown error|failed to connect to socket|io\.grpc'

# Stack frames Maestro passes through while setting a flow up, before its first
# command runs (Orchestra.runFlow → initJsEngine → cachedDeviceInfo, run #163),
# and the frames commands run under (names checked against Maestro 2.10.0's
# Orchestra). `[.$]` because coroutine frames print as Orchestra$executeCommands$1.
readonly PRESTART_FRAME_RE='Orchestra[.$]initJsEngine|Maestro[.$]getCachedDeviceInfo'
readonly COMMAND_FRAME_RE='Orchestra[.$](executeCommand|runSubFlow|runFlowCommand)'

# is_infra_failure FILE... — true when any of the files (JUnit reports, logcat)
# shows a device-driver death. grep reads the files itself rather than through a
# pipe: with pipefail, `cat … | grep -q` returns 141 when grep exits on an early
# match while cat is still writing, so the check failed exactly when it should
# pass (run #163). Missing files are not an error.
is_infra_failure() {
  grep -Eqs "$INFRA_FAILURE_RE" "$@"
}

# is_prestart_driver_death REPORT — true when a flow's JUnit report shows the
# driver dying while Maestro was still setting the flow up, before any command
# ran. Nothing on the device changed, so that one flow can be re-run on its own,
# whereas a death mid-flow leaves state behind and needs the whole-run retry.
is_prestart_driver_death() {
  local report="$1"
  is_infra_failure "$report" &&
    grep -Eqs "$PRESTART_FRAME_RE" "$report" &&
    ! grep -Eqs "$COMMAND_FRAME_RE" "$report"
}

# ci_warning MESSAGE — a GitHub Actions warning annotation in CI, so a flake a
# retry absorbed still shows on the run summary; a plain log line elsewhere.
ci_warning() {
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    printf '::warning title=Mobile e2e retry::%s\n' "$1"
  else
    printf '==> WARNING: %s\n' "$1"
  fi
}
