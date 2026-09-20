#!/usr/bin/env bash
#
# check-maestro.sh — verify the prerequisites for the mobile device-test suite
# before running it.
#
# Unlike Playwright's browser, bootstrap.sh deliberately does not install
# Maestro: a ~300 MB JVM CLI that is useless without an emulator, which most
# sessions never need. Without this check that choice surfaces as a wall of
# failing flows instead of one command to run.
#
# `task test-mobile-e2e` runs this first.

set -uo pipefail

# Pinned: `latest` moved 2.8.0 -> 2.10.0 in under two months, and a suite that
# changes behaviour because upstream shipped is worse than no suite.
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

# Maestro bundles no JRE. Checked before invoking it, so the failure names Java
# instead of surfacing as "maestro --version printed nothing".
if [ -z "${JAVA_HOME:-}" ] && ! command -v java >/dev/null 2>&1; then
  cat >&2 <<EOF

Maestro needs a Java runtime, and neither JAVA_HOME nor a 'java' command is set.
Maestro does not bundle one.

Install a JDK (17 or newer), e.g.:
  apt install default-jdk        # Debian/Ubuntu
  brew install openjdk           # macOS
  nix-shell -p jdk               # nix, outside this repo's shell.nix

EOF
  exit 1
fi

installed="$(maestro --version 2>/dev/null | tail -1 | tr -d '[:space:]')"
if [ -z "$installed" ]; then
  echo "Could not determine the installed Maestro version ('maestro --version' printed nothing)." >&2
  exit 1
fi

# Warning, not failure: CI installs the pin exactly, and hard-failing would
# block debugging a flow against a newer Maestro locally.
if [ "$installed" != "$MAESTRO_VERSION" ]; then
  cat >&2 <<EOF
Warning: Maestro $installed is installed, but this suite is pinned to $MAESTRO_VERSION.
Flows may behave differently. Pin in scripts/check-maestro.sh if you are bumping it.

EOF
fi

# Without this, `maestro test` fails deep in a flow run with a driver message.
if ! command -v adb >/dev/null 2>&1; then
  cat >&2 <<EOF

adb is not on PATH, so Maestro cannot find an emulator.

Install the Android SDK platform-tools and put them on PATH, e.g.:
  export ANDROID_HOME="\$HOME/Android/Sdk"
  export PATH="\$ANDROID_HOME/platform-tools:\$ANDROID_HOME/emulator:\$PATH"

EOF
  exit 1
fi

# Skip the header row; a still-booting device lists as "offline", not "device".
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

# Emulators only: the suite points the app at 10.0.2.2, which reaches nothing
# from a physical device. Supporting one needs `adb reverse` and a different URL.
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
