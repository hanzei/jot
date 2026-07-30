{ pkgs ? import <nixpkgs> {} }:
pkgs.mkShell {
  nativeBuildInputs = with pkgs; [
    nodejs_24 # keep in sync with .nvmrc
    go
    go-task
    watchman
    playwright-driver.browsers
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
