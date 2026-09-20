#!/usr/bin/env bash
#
# check-maestro.sh — verify the prerequisites for the mobile device-test suite
# are present before running it.
#
# Unlike Playwright's browser, Maestro is deliberately NOT installed by
# bootstrap.sh: it is a ~300 MB JVM CLI, it needs a running emulator to be of
# any use, and the overwhelming majority of sessions never run device tests.
# The cost of leaving it out is that a missing Maestro or a dead emulator
# otherwise surfaces as a wall of failing flows, which reads like a broken
# suite rather than a one-command fix. This turns it into that one command.
#
# `task test-mobile-e2e` runs this first. Run it directly with:
#   ./scripts/check-maestro.sh

set -uo pipefail

# Pinned on purpose. `latest` moved 2.8.0 -> 2.10.0 in under two months, and a
# suite whose behaviour changes because upstream shipped a release is worse
# than no suite. Bump this deliberately, and re-run the flows when you do.
MAESTRO_VERSION="2.10.0"
readonly MAESTRO_VERSION

if ! command -v maestro >/dev/null 2>&1; then
  cat >&2 <<EOF

Maestro is not on PATH, so the mobile device tests cannot run.

Install it (once per machine, ~300 MB):
  curl -Ls "https://get.maestro.mobile.dev" | bash

If that host is blocked (some proxies return 403), take the release zip instead:
  curl -fsSL -o /tmp/maestro.zip \\
    https://github.com/mobile-dev-inc/maestro/releases/download/v$MAESTRO_VERSION/maestro.zip
  unzip -q /tmp/maestro.zip -d "\$HOME/.maestro-dist"
  export PATH="\$HOME/.maestro-dist/maestro/bin:\$PATH"

This suite is pinned to Maestro $MAESTRO_VERSION.

EOF
  exit 1
fi

installed="$(maestro --version 2>/dev/null | tail -1 | tr -d '[:space:]')"
if [ -z "$installed" ]; then
  echo "Could not determine the installed Maestro version ('maestro --version' printed nothing)." >&2
  exit 1
fi

# A mismatch is a warning, not a failure: pinning exists to keep CI reproducible
# and to make a behaviour change traceable, not to stop someone debugging a flow
# against a newer build on their own machine. CI installs the pin exactly, so
# this stays quiet there.
if [ "$installed" != "$MAESTRO_VERSION" ]; then
  cat >&2 <<EOF
Warning: Maestro $installed is installed, but this suite is pinned to $MAESTRO_VERSION.
Flows may behave differently. Pin in scripts/check-maestro.sh if you are bumping it.

EOF
fi

# `maestro test` against no device fails deep inside a flow run with a message
# about a driver, which is a poor way to learn the emulator never booted.
if ! command -v adb >/dev/null 2>&1; then
  cat >&2 <<EOF

adb is not on PATH, so Maestro cannot find an emulator.

Install the Android SDK platform-tools and put them on PATH, e.g.:
  export ANDROID_HOME="\$HOME/Android/Sdk"
  export PATH="\$ANDROID_HOME/platform-tools:\$ANDROID_HOME/emulator:\$PATH"

EOF
  exit 1
fi

# `adb devices` prints a header line plus one line per device; a device that is
# still booting shows as "offline", which is not usable yet.
devices="$(adb devices | awk 'NR>1 && $2 == "device" {print $1}')"
if [ -z "$devices" ]; then
  cat >&2 <<EOF

No booted Android device or emulator is attached ('adb devices' lists none as
"device"). Maestro drives a real device or emulator; it cannot run headless on
its own.

Start one, e.g.:
  emulator -avd <your-avd> -no-window -no-audio &
  adb wait-for-device

'adb devices' shows what is attached. A device listed as "offline" is still
booting — wait for it to flip to "device".

EOF
  exit 1
fi

# Emulators only, deliberately. The suite points the app at 10.0.2.2, which is
# the emulator's alias for the host loopback and means nothing on a physical
# device — there it resolves to some unrelated host (or nothing), and the flows
# fail at the server-setup step with a connection error that says nothing about
# the real cause. Supporting a physical device needs `adb reverse` plus a
# different URL, which is worth adding when someone actually wants it.
emulators="$(printf '%s\n' "$devices" | grep '^emulator-' || true)"
if [ -z "$emulators" ]; then
  cat >&2 <<EOF

Only physical devices are attached:
$(printf '%s\n' "$devices" | sed 's/^/  /')

This suite targets an emulator: it points the app at 10.0.2.2, the emulator's
alias for the host loopback, which does not resolve to your machine on a
physical device.

Start an emulator instead:
  emulator -avd <your-avd> -no-window -no-audio &
  adb wait-for-device

EOF
  exit 1
fi

exit 0
