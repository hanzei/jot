# Jot Development Agent Instructions

## Cursor Cloud specific instructions

### Services overview

Jot is a self-hosted note-taking app: a Go API server (port 8080) serves both the REST API and the compiled React SPA from `webapp/build/`. SQLite is the only data store (file-based, no external DB needed). A React Native/Expo mobile app also exists but is optional for web development.

### Running the server

Build and run from `server/`:

```bash
cd server && go build -buildvcs=false -o jot . && COOKIE_SECURE=false ./jot
```

`COOKIE_SECURE=false` is required for non-HTTPS local development (session cookies won't be set otherwise). The `task run-server` command also works if the `task` binary is available.

The webapp must be built first (`cd webapp && npm run build`) so the server can serve the static files from `../webapp/build/`.

### Key dev commands

All `task` commands are documented in `README.md`, `CLAUDE.md`, and `Taskfile.yml`. Key ones:
| Task | What it does |
|------|-------------|
| `task test-server` | Go unit/integration tests |
| `task test-webapp` | Vitest unit tests |
| `task test-mobile` | Jest mobile tests |
| `task test-e2e` | Playwright e2e (requires webapp built first) |
| `task lint` | All linters (server + webapp + mobile) |

### Non-obvious caveats

- **Go 1.24+** is required (the `go.mod` specifies `go 1.24.7`). CGO must be enabled for the `go-sqlite3` driver, so `gcc` is needed.
- **Node 24+** is used (matching the Dockerfile). Install via `nvm install 24 && nvm alias default 24`.
- **Playwright e2e tests**: Chromium is preinstalled by the VM update script (`npx playwright install chromium`), and webapp deps are preinstalled via `npm ci`. The Playwright config auto-starts the Go server and uses a temp DB, so no manual server startup is needed — just run `npm run test:e2e` from `webapp/`. If Chromium is missing for some reason, run `npx playwright install --with-deps chromium` in `webapp/`.
- **Auth is session-cookie based** (not JWT). The first registered user becomes admin.
- The mobile app (`mobile/`) uses Expo and requires emulator/device access; it is not testable in a headless cloud environment for GUI flows.
- **Some e2e tests may fail** due to stale selectors for "Archive"/"Bin" sidebar navigation in the page objects (`e2e/pages/DashboardPage.ts`). These are pre-existing test issues, not environment problems.
