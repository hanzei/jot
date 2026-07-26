# Jot Project Instructions

## Development Status Notice

- Jot is under heavy initial development.
- The API is currently unstable, and API-breaking changes are acceptable when needed.
- Call out every API-breaking change in the PR description with expected client impact and upgrade guidance.
- Preserve compatibility for existing installations whenever possible (startup behavior, migrations, and existing data).
- If a change must break existing installations, explicitly call out the impact and migration steps in the PR description and communicate it clearly to users.

## Threat Model

- Logged-in users are generally treated as trustworthy collaborators.
- Baseline authentication and authorization guarantees remain mandatory (ownership/share checks, role checks, and normal access boundaries).
- Prioritize protections against unintentional internal overloads (for example: accidental high-frequency requests, runaway sync loops, and expensive repeated operations).
- For internal-load safety, prefer practical controls such as rate limiting, retry/backoff, loop detection, and caps on expensive operations.
- Defenses aimed specifically at malicious authenticated insiders are not a primary requirement at this stage, unless they are needed to preserve baseline auth/authz guarantees.

## Documentation Maintenance

- When development instructions change (build scripts, dev setup, etc.), update the README.md to reflect the changes.
- When functionality changes (API endpoints, features, configuration options, etc.), update relevant documentation.

## Git Workflow

- Don't commit to `master` unless specifically asked; always use a separate feature branch.
- Before creating a PR, run all tests and ensure they pass. Also run the linter.

## Code Review Loop

Only run a review pass for large, complex PRs — this should be a rare exception, not the default. Skip for anything that isn't genuinely large and architecturally significant (e.g. most bug fixes, small features, refactors, config changes, and single-area changes do not qualify).

When a PR does qualify:

1. Launch **one sub-agent** that runs both `/code-review --effort medium` (correctness bugs) and `/simplify` (quality/cleanup and consistency with project conventions) on all changed files.
2. Address every piece of valid feedback the review returns (fix bugs, improve clarity, align with conventions).
3. Only proceed to commit/push after the review pass finishes — do not repeat the loop.

## Development Tasks

Use the following Task commands for development:

- `task run-server` - Start the Jot server
- `task run-webapp` - Start webapp dev server with HMR
- `task test` - Run all tests (server + webapp + mobile + shared)
- `task test-server` - Run server tests
- `task test-webapp` - Run webapp tests
- `task test-e2e` - Run Playwright end-to-end tests (`webapp/e2e/`)
- `task coverage` - Run server tests with coverage report
- `task lint` - Run linters (server + webapp + mobile + shared)
- `task lint-server` - Run server linting with golangci-lint
- `task lint-webapp` - Run webapp linting
- `task check-translations` - Verify locale files stay in sync with `en.json`
- `task test-mobile` - Run mobile app tests
- `task lint-mobile` - Run mobile app linting
- `task test-shared` - Run shared package tests
- `task lint-shared` - Run shared package linting
- `task gen-docs` - Regenerate Swagger API docs from handler annotations (requires `swag` CLI)
- `task build-jotctl` - Build the `jotctl` admin CLI binary
- `task clean` - Remove generated files and node packages

---

## Codebase Overview

Jot is a self-hosted note-taking application. The backend is a Go HTTP API and the frontend is a React/TypeScript SPA. A single Go binary serves both the API and the compiled frontend static files.

### Directory Structure

```
/
├── shared/          # @jot/shared — types, constants, and utilities shared by webapp & mobile
│   ├── src/
│   │   ├── types.ts          # All TypeScript interfaces (single source of truth)
│   │   ├── constants.ts      # Validation limits, roles, defaults
│   │   ├── collaborators.ts  # buildCollaborators, displayName
│   │   ├── colors.ts         # Avatar colors, note color palettes, hash function
│   │   └── index.ts          # Barrel export
│   └── package.json
├── server/          # Go backend
│   ├── main.go
│   ├── go.mod
│   ├── client/          # Go client SDK types (used by jotctl)
│   ├── cmd/
│   │   └── jotctl/      # Admin CLI tool (build with task build-jotctl)
│   │       ├── main.go
│   │       └── cmd/     # Cobra command definitions
│   ├── internal/
│   │   ├── auth/        # Session-cookie + PAT auth middleware and utilities
│   │   ├── blobstore/   # Content-addressed blob storage (Blobstore interface, fsBlobstore)
│   │   ├── config/      # Server configuration (env vars, defaults)
│   │   ├── database/    # Database bootstrap and migration runner
│   │   │   └── migrations/  # Sequential SQL migration files (embedded into binary)
│   │   ├── handlers/    # HTTP request handlers
│   │   ├── logutil/     # Request-scoped logger utilities
│   │   ├── mcphandler/  # Model Context Protocol (MCP) server (note/label tools)
│   │   ├── models/      # Store types and shared data models
│   │   ├── server/      # Server setup, routing, middleware wiring
│   │   ├── sse/         # Server-sent event hub and event types
│   │   └── telemetry/   # OpenTelemetry setup (tracing, metrics, logging)
│   └── docs/            # Generated OpenAPI docs (swagger)
├── webapp/          # React/TypeScript frontend
│   ├── src/
│   │   ├── components/  # React components
│   │   ├── hooks/       # Custom React hooks
│   │   ├── i18n/        # Internationalization (8 languages)
│   │   ├── pages/       # Route-level page components
│   │   └── utils/       # API client, auth helpers
│   ├── e2e/             # Playwright end-to-end tests
│   │   ├── fixtures/    # Test fixtures and helpers
│   │   ├── pages/       # Page Object Model classes
│   │   └── tests/       # E2E test specs
│   └── package.json
├── mobile/          # React Native/Expo mobile app
│   ├── src/
│   │   ├── api/         # API client modules
│   │   ├── components/  # React Native components
│   │   ├── db/          # Local SQLite/offline persistence
│   │   ├── hooks/       # Custom hooks (API, auth, sync)
│   │   ├── i18n/        # Internationalization (8 languages)
│   │   ├── navigation/  # React Navigation setup
│   │   ├── screens/     # Screen components
│   │   └── store/       # Context/state providers
│   └── package.json
├── images/          # Documentation images
├── Taskfile.yml
├── Dockerfile       # Multi-stage production build
└── docker-compose.yml
```

---

## Server (Go)

### Technology Stack

- **Go 1.26**
- **Chi v5** — HTTP router with middleware
- **go-chi/cors** — CORS middleware
- **SQLite 3** — File-based database (pure Go, no CGO required)
- **bcrypt** — Password hashing
- **logrus** — Structured logging
- **testify** — Test assertions
- **swaggo/swag + http-swagger** — OpenAPI spec generation and Swagger UI
- **modelcontextprotocol/go-sdk** — MCP protocol server
- **OpenTelemetry** — Distributed tracing, metrics, and logging (optional)

### Architecture Patterns

**Store pattern** — database interaction is wrapped in `*Store` types (`UserStore`, `NoteStore`, `PATStore`, etc.) in `internal/models`, each holding a `*sql.DB`. No ORM is used; all queries are hand-written SQL with parameterized inputs.

**Handler pattern** — handlers have the signature:
```go
func(w http.ResponseWriter, r *http.Request) (int, any, error)
```
They return an HTTP status code, a response body (serialized to JSON by `wrapHandler`), and an error. The `wrapHandler` middleware in `server.go` handles writing the status, encoding the body, and logging the error uniformly.

**ID generation** — most entity IDs are 22-character cryptographically random alphanumeric strings generated from `crypto/rand`. Session tokens are 64-character hex strings. PAT raw tokens are 64-character hex strings (32 random bytes); only the SHA-256 hash is stored.

**Middleware** — authentication middleware reads the `jot_session` cookie first; if absent, it falls back to an `Authorization: Bearer <token>` header (PAT). The resolved user is saved in request context. Admin middleware checks the authenticated user's `role`.

**MCP server** — `internal/mcphandler` exposes note and label CRUD as Model Context Protocol tools over the streamable-HTTP transport. It is mounted behind auth middleware so every MCP session is scoped to the authenticated user.

**Timestamps** — every timestamp column is naive (SQLite `DATETIME`, Postgres `TIMESTAMP WITHOUT TIME ZONE`) and holds a UTC wall clock. Use `models.Now()` rather than `time.Now()` for anything written to, or compared against, one of those columns. Timestamps the database generates itself (`DEFAULT CURRENT_TIMESTAMP`) are UTC too: SQLite's always is, and Postgres pools open through a connector that runs `SET TIME ZONE 'UTC'` on every session (`internal/database`.`utcConnector`).

**Observability** — `internal/telemetry` sets up optional OpenTelemetry traces (OTLP gRPC) and Prometheus metrics (separate port). Structured logs are integrated with the OTel LoggerProvider.

**Blob storage** — `internal/blobstore` defines a `Blobstore` interface (`Put`/`Open`/`Delete`) for content-addressed binary storage, keyed by hex-encoded SHA-256 hash. `FSBlobstore` is the v1 implementation, rooted at config `UPLOAD_DIR` (default `./uploads`), laid out as `UPLOAD_DIR/blobs/<sha[0:2]>/<sha[2:4]>/<sha>`. All paths are derived solely from the validated hash, never from caller-supplied filenames, so there is no path traversal risk; filesystem access additionally goes through `os.Root` (opened on `UPLOAD_DIR`, same traversal-resistant pattern used for static file serving in `server.go`) as defense-in-depth. `Put` is a no-op when the hash already exists (dedup). A full backup is now **DB + `UPLOAD_DIR`**.

### API Specification

Do not maintain endpoint tables in this file. Use the generated OpenAPI spec as the canonical API reference:

- `server/docs/swagger.yaml`
- `server/docs/swagger.json`
- Swagger UI at `/api/docs/index.html`

If handler annotations or request/response types change, regenerate docs with `task gen-docs`.

### API Conventions

- Resource-cap / limit-exceeded conditions (e.g., the per-user PAT cap, the per-note item/image cap) return HTTP 422 Unprocessable Entity, not 400. Reserve 400 for malformed/invalid input.

### Database Migrations

Migration files live in `server/internal/database/migrations/` and are named `NNN_description.sql`. They are embedded into the binary at compile time via `embed.FS` and applied automatically at startup in sequential order. To add a new migration, create the next numbered file.

There is one directory per dialect (`migrations/sqlite/`, `migrations/postgres/`) and the numbering is kept aligned between them: a migration that only one backend needs still gets an explanatory placeholder file in the other. Both schemas must enforce the same invariants — a constraint on one dialect only means data valid on one backend fails to load into the other.

### Authentication

- Auth is session-based using an HttpOnly `jot_session` cookie (primary method).
- Personal Access Tokens (PATs) are accepted via `Authorization: Bearer <token>` header (machine-to-machine use).
- Sessions are persisted in the `sessions` table with 30-day expiry by default. Only the SHA-256 hash of the session token is stored (`token_hash` column); the raw token exists solely in the client's cookie.
- Sessions are automatically extended to 30 days again when less than 7 days remain.
- Browser clients send credentialed requests (`withCredentials: true`).
- The first registered user automatically becomes admin.
- Note access is granted if the requester is the owner **or** the note is shared with them.
- PAT raw tokens are only returned once on creation; only the SHA-256 hash is stored.

### Server Tests

- Integration tests live in `server/` root (e.g. `http_integration_test.go`, `http_notes_sharing_test.go`, `http_labels_test.go`, `http_import_test.go`, `http_profile_icon_test.go`, `http_pats_test.go`, `http_mcp_test.go`, `http_task_assignment_test.go`, `http_note_duplicate_test.go`, `http_note_validation_test.go`, `http_security_headers_test.go`, `http_auth_middleware_test.go`, `http_user_flows_test.go`)
- Unit tests alongside source: e.g., `server/internal/models/note_test.go`
- Tests spin up an `httptest.Server` against a temporary SQLite database (`/tmp/test_*.db`)
- Helper types: `TestResponse`, `TestUser`, `TestServer`
- Use `t.Run` subtests for grouping related cases; see `server/CLAUDE.md` for the full Go test naming and table-driven test conventions
- Run: `task test-server`
- Store-level tests (`internal/models`) and migration/backfill tests (`internal/database`) run against SQLite unconditionally and additionally against Postgres when `TEST_POSTGRES_DSN` is set, via the harnesses in `internal/database/dsntest` (dependency-free DSN/raw-connection helpers, usable even from `internal/database`'s own internal test files) and `internal/database/dbtest` (fully migrated databases, for other packages). Each test creates and drops its own isolated Postgres database; tests skip cleanly when `TEST_POSTGRES_DSN` is unset. See the README's "Testing against Postgres" section for local setup.

---

## Webapp (React/TypeScript)

### Technology Stack

- **React 19** + **TypeScript 5**
- **Vite 7** — build tool and dev server
- **React Router 7** (`react-router`) — client-side routing
- **axios** — HTTP client (with request/response interceptors for auth)
- **Tailwind CSS** — utility-first styling (no scoped styles)
- **@dnd-kit** — drag-and-drop for note reordering
- **@headlessui/react** — unstyled accessible components
- **@heroicons/react** — icon set
- **Vite PWA plugin** — service worker and offline support

### Key Files

- `src/utils/api.ts` — axios instance and all API call functions
- `src/utils/auth.ts` — user/settings read-write helpers in localStorage
- `src/service-worker.ts` — PWA offline caching via Workbox

Types are distributed across the `@jot/shared` package (`shared/src/`) and imported from `@jot/shared`. Domain model interfaces live in `shared/src/types.ts`; utility types and constants live in their respective modules (`collaborators.ts`, `constants.ts`). All are re-exported from `shared/src/index.ts`. Do not duplicate type definitions in the webapp.

### Naming Conventions (TypeScript/React)

- Component files: PascalCase + `.tsx` (`NoteModal.tsx`)
- Utility files: camelCase + `.ts` (`api.ts`)
- Type interfaces: PascalCase (`CreateNoteRequest`, `Note`)
- CSS: Tailwind utility classes only; no component-scoped stylesheets
- Custom hooks prefix: `use` (`useNotes`, `useAuth`)

### Webapp Tests

- Test files: `*.test.tsx` or in `__tests__/` directories
- Framework: **Vitest** with jsdom environment
- Library: `@testing-library/react`
- Run: `task test-webapp`

### E2E Tests

- Framework: **Playwright** (`webapp/e2e/`)
- Scope: Test complete user workflows through the browser UI (integration tests focus on backend API contracts)
- Pattern: Page Object Model — add page classes in `e2e/pages/`, tests in `e2e/tests/`
- Fixtures: `e2e/fixtures/index.ts` provides `authenticatedUser` and page objects
- **Add e2e tests for every new user-facing feature** (new pages, workflows, admin actions)
- Run: `task test-e2e`

---

## Mobile (React Native/Expo)

### Technology Stack

- **React Native 0.83** + **Expo 55**
- **React Navigation 7** — drawer + native stack navigation
- **Tanstack React Query 5** — data fetching and caching
- **Expo Secure Store** — credential storage
- **Expo SQLite** — local offline persistence
- **react-native-sse** — SSE client for real-time updates
- **@jot/shared** — shared types and utilities (local file dependency)

### Mobile Tests

- Framework: **Jest**
- Test files in `__tests__/`
- Run: `task test-mobile`

---

## Build & Deployment

### Local Development

```bash
# Terminal 1 — backend (build + run binary)
task run-server

# Terminal 2 — frontend (Vite dev server with HMR)
task run-webapp
```

The server at `localhost:8080` serves the API. Vite is configured with a proxy to forward API calls during development. Note: `run-server` sets `PASSWORD_MIN_LENGTH=4` for local convenience — do not use this in production.

### Docker (Production)

Multi-stage `Dockerfile`:
1. **Node 24 Alpine** — builds the React app (`npm ci && npm run build`)
2. **Go 1.26 Alpine** — compiles the Go binary (pure Go, no CGO)
3. **Alpine runtime** — copies binary and frontend build; exposes port 8080

```bash
docker compose up -d
```

Persistent data is mounted at `/data` (default `docker-compose.yml` maps host `./data` to `/data`).

**Workflow pinning policy:** In GitHub Actions workflows, pin every external action `uses:` reference (`owner/repo@...`) to a full commit SHA and add an inline comment with the intended major version tag (for example, `# v6`). Do not use floating action refs such as `@v4`, `@v6`, `@main`, or `@latest`.

### CI Checklist (before opening a PR)

1. `task test` — all unit/integration tests pass (server, webapp, mobile, shared)
2. `task lint` — no lint errors
3. `task test-e2e` — Playwright e2e tests pass (add new e2e tests for any new user-facing features; not included in `task test`)
4. `task check-translations` — all locale files are in sync with `en.json` (run if any i18n keys were added or changed)
