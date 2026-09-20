{ pkgs ? import <nixpkgs> {} }:
pkgs.mkShell {
  nativeBuildInputs = with pkgs; [
    nodejs_24 # keep in sync with .nvmrc
    go # `task` deliberately comes from bootstrap.sh, which pins its version
    watchman
    playwright-driver.browsers
    # Maestro (`task test-mobile-e2e`) is a JVM CLI that bundles no runtime of
    # its own. Maestro itself is deliberately not here — it is a ~300MB download
    # that is useless without an Android emulator, which nix would have to
    # provide too — but the JDK is cheap and is the non-obvious half of the
    # requirement, so `./scripts/check-maestro.sh` only has to tell you about
    # the parts you actually choose to install.
    jdk
  ];
  shellHook = ''
    export PLAYWRIGHT_BROWSERS_PATH=${pkgs.playwright-driver.browsers}
    export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
    export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
    export PATH="$(go env GOPATH)/bin:$PATH"

    # Setup lives in exactly one place. Everything nix does not provide (npm
    # dependencies, and `task` itself outside this shell) comes from here.
    repo_root="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
    "$repo_root/scripts/bootstrap.sh" || true
  '';
}
