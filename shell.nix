{ pkgs ? import <nixpkgs> {} }:
pkgs.mkShell {
  nativeBuildInputs = with pkgs; [
    nodejs_24 # keep in sync with .nvmrc
    go # `task` deliberately comes from bootstrap.sh, which pins its version
    watchman
    playwright-driver.browsers
    # For Maestro (`task test-mobile-e2e`), which bundles no runtime. Maestro
    # itself stays out: useless without an emulator nix would also have to
    # provide, and check-maestro.sh explains how to install both.
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
