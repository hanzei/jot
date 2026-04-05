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

- When development instructions change (build scripts, dev setup, etc.), update the README.md to reflect the changes
- When functionality changes (API endpoints, features, configuration options, etc.), update relevant documentation.

## Git Workflow

- Don't commit to `master` unless specifically asked; always use a separate feature branch.
- Before creating a PR, run all tests and ensure they pass. Also run the linter.

## Code Review Loop

Before submitting a PR, run a sub-agent review loop before finalizing:

1. Launch a sub-agent (use the `simplify` skill or a `general-purpose` agent) to review all changed files for correctness, code quality, and consistency with project conventions.
2. Address every piece of valid feedback the review returns (fix bugs, improve clarity, align with conventions).
3. Repeat steps 1–2 until either:
   - The review returns no valid feedback, **or**
   - You have completed **4 review rounds** (whichever comes first).
4. Only proceed to commit/push after the review loop finishes.

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

- **Go 1.25**
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
func(w http.ResponseWriter, r *http.Request) (int, error)
```
They return an HTTP status code and error. The `wrapHandler` middleware in `server.go` handles writing the status and logging the error uniformly.

**ID generation** — most entity IDs are 22-character cryptographically random alphanumeric strings generated from `crypto/rand`. Session tokens are 64-character hex strings. PAT raw tokens are 64-character hex strings (32 random bytes); only the SHA-256 hash is stored.

**Middleware** — authentication middleware reads the `jot_session` cookie first; if absent, it falls back to an `Authorization: Bearer <token>` header (PAT). The resolved user is saved in request context. Admin middleware checks the authenticated user's `role`.

**MCP server** — `internal/mcphandler` exposes note and label CRUD as Model Context Protocol tools over the streamable-HTTP transport. It is mounted behind auth middleware so every MCP session is scoped to the authenticated user.

**Observability** — `internal/telemetry` sets up optional OpenTelemetry traces (OTLP gRPC) and Prometheus metrics (separate port). Structured logs are integrated with the OTel LoggerProvider.

### API Specification

Do not maintain endpoint tables in this file. Use the generated OpenAPI spec as the canonical API reference:

- `server/docs/swagger.yaml`
- `server/docs/swagger.json`
- Swagger UI at `/api/docs/index.html`

If handler annotations or request/response types change, regenerate docs with `task gen-docs`.

### Database Schema

**users**
- `id` TEXT PK — 22-char random ID
- `username` TEXT UNIQUE — 2–30 chars, alphanumeric/underscore/hyphen
- `password_hash` TEXT — bcrypt
- `role` TEXT — `'user'` or `'admin'`
- `first_name`, `last_name` TEXT
- `profile_icon`, `profile_icon_content_type` BLOB/TEXT (nullable)
- `created_at`, `updated_at` DATETIME

**notes**
- `id` TEXT PK
- `user_id` TEXT FK → users (owner)
- `title`, `content` TEXT
- `note_type` TEXT — `'text'` or `'todo'`
- `deleted_at` DATETIME (nullable soft-delete/trash marker)
- `created_at`, `updated_at` DATETIME

**note_user_state** (per-user UI state for each note — separate from note content)
- `note_id` TEXT FK → notes
- `user_id` TEXT FK → users
- `color` TEXT — hex color (default `#ffffff`)
- `pinned`, `archived` BOOLEAN
- `position` INTEGER — display order
- `unpinned_position` INTEGER (nullable) — saved position restored when unpinning
- `checked_items_collapsed` BOOLEAN — UI state for todo notes
- `created_at`, `updated_at` DATETIME
- PRIMARY KEY (`note_id`, `user_id`)

**note_items** (todo list items)
- `id` TEXT PK
- `note_id` TEXT FK → notes
- `text` TEXT
- `completed` BOOLEAN
- `position` INTEGER
- `indent_level` INTEGER
- `assigned_to` TEXT FK → users (nullable)
- `created_at`, `updated_at` DATETIME

**note_shares**
- `id` TEXT PK
- `note_id`, `shared_with_user_id`, `shared_by_user_id` TEXT FKs
- `permission_level` TEXT — `'edit'` (only level currently)
- `created_at`, `updated_at` DATETIME
- UNIQUE(`note_id`, `shared_with_user_id`)

**labels**
- `id` TEXT PK
- `user_id` TEXT FK → users
- `name` TEXT (NOCASE collation)
- `created_at`, `updated_at` DATETIME
- UNIQUE(`user_id`, `name`)

**note_labels**
- `id` TEXT PK
- `note_id` TEXT FK → notes
- `label_id` TEXT FK → labels
- `user_id` TEXT FK → users
- `created_at` DATETIME
- UNIQUE(`note_id`, `label_id`, `user_id`)

**sessions**
- `token` TEXT PK (64-char hex session token)
- `user_id` TEXT FK → users
- `user_agent` TEXT
- `expires_at`, `created_at` DATETIME

**personal_access_tokens**
- `id` TEXT PK
- `user_id` TEXT FK → users
- `token_hash` TEXT UNIQUE — SHA-256 hash of the raw token
- `name` TEXT
- `created_at` DATETIME

**user_settings**
- `user_id` TEXT PK/FK → users
- `language` TEXT — `system`, `en`, `de`, `es`, `fr`, `pt`, `it`, `nl`, `pl`
- `theme` TEXT — `system`, `light`, `dark`
- `note_sort` TEXT — `manual`, `updated_at`, `created_at`
- `created_at`, `updated_at` DATETIME

**active_notes** — view over `notes` that excludes soft-deleted rows (`WHERE deleted_at IS NULL`).

**migrations** — internal migration tracking table.

### Database Migrations

Migration files live in `server/internal/database/migrations/` and are named `NNN_description.sql`. They are embedded into the binary at compile time via `embed.FS` and applied automatically at startup in sequential order. To add a new migration, create the next numbered file.

### Configuration (Environment Variables)

| Variable | Default | Notes |
|----------|---------|-------|
| `DB_PATH` | `./jot.db` | Path to SQLite database file |
| `PORT` | `8080` | HTTP listen port (1–65535) |
| `STATIC_DIR` | `../webapp/build/` | Path to compiled frontend files |
| `CORS_ALLOWED_ORIGIN` | `""` | Allowed webapp origin for CORS (exact match) |
| `COOKIE_SECURE` | `true` | Whether the session cookie is `Secure` |
| `REGISTRATION_ENABLED` | `true` | When `false`, only admins can create users via the admin API |
| `PASSWORD_MIN_LENGTH` | `10` | Minimum password length (1–72); set to `4` in dev via Taskfile |
| `METRICS_ENABLED` | `false` | Enable Prometheus metrics endpoint |
| `METRICS_HOST` | `127.0.0.1` | Host for the Prometheus metrics server |
| `METRICS_PORT` | `8081` | Port for the Prometheus metrics server |
| `OTEL_ENABLED` | `false` | Enable OpenTelemetry tracing |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `""` | OTLP gRPC endpoint for traces/logs |
| `OTEL_SERVICE_NAME` | `jot` | Service name reported in traces |
| `OTEL_EXPORTER_OTLP_INSECURE` | `false` | Skip TLS for OTLP connection |

### Authentication

- Auth is session-based using an HttpOnly `jot_session` cookie (primary method).
- Personal Access Tokens (PATs) are accepted via `Authorization: Bearer <token>` header (machine-to-machine use).
- Sessions are persisted in the `sessions` table with 30-day expiry by default.
- Sessions are automatically extended to 30 days again when less than 7 days remain.
- Browser clients send credentialed requests (`withCredentials: true`).
- The first registered user automatically becomes admin.
- Note access is granted if the requester is the owner **or** the note is shared with them.
- PAT raw tokens are only returned once on creation; only the SHA-256 hash is stored.

### Naming Conventions (Go)

- Packages: `internal/{auth,config,database,handlers,logutil,mcphandler,models,server,sse,telemetry}`
- Go types: PascalCase when exported (`UserStore`, `NoteStore`, `PATStore`); variables: camelCase (`noteStore`, `userID`)
- Database columns: snake_case (`note_type`, `user_id`)
- JSON fields: snake_case (`note_type`, `user_id`)
- Error wrapping: `fmt.Errorf("context: %w", err)`
- Use `any` instead of `interface{}`
- Use `errors.Is` instead of `==` when comparing errors
- Use `logrus` instead of the standard `log` package for all logging
- In HTTP handlers and middleware, use `logutil.FromContext(ctx)` to get the request-scoped logger (carries `request_id`, `user_id`, `method`, `path` automatically)
- Reserve bare `logrus.*` calls for background goroutines and startup code without request context
- In tests, use `t.Context()` instead of `context.Background()`

### Error Handling (Go)

- Errors that cross a function boundary should be wrapped with a short, lowercase description of the operation that failed: `return nil, fmt.Errorf("get note by id: %w", err)`.
- Prefer wrapping over bare `return err` or `return nil, err` when returning up the call stack — the added context makes log traces easier to follow.
- Do **not** re-wrap sentinel errors (`sql.ErrNoRows`, `ErrNoteNotFound`, etc.) that have already been identified with `errors.Is` and are being returned directly. Re-wrapping them adds a redundant message layer without useful context (`errors.Is` traverses the `%w` chain, so matching still works either way).
- Do not wrap errors inside `defer` functions or inside log statements.

### Server Tests

- Integration tests live in `server/` root (e.g. `http_integration_test.go`, `http_notes_sharing_test.go`, `http_labels_test.go`, `http_import_test.go`, `http_profile_icon_test.go`, `http_pats_test.go`, `http_mcp_test.go`, `http_task_assignment_test.go`, `http_note_duplicate_test.go`, `http_note_validation_test.go`, `http_security_headers_test.go`, `http_auth_middleware_test.go`, `http_user_flows_test.go`)
- Unit tests alongside source: e.g., `server/internal/models/note_test.go`
- Tests spin up an `httptest.Server` against a temporary SQLite database (`/tmp/test_*.db`)
- Helper types: `TestResponse`, `TestUser`, `TestServer`
- Use `t.Run` subtests for grouping related cases; do not use `_` as a separator in top-level test function names (e.g. use `TestCreateNote` with `t.Run("success", ...)` subtests, not `TestCreateNote_Success`)
- Run: `task test-server`

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
- `src/types/index.ts` — all shared TypeScript interfaces (single source of truth)
- `src/service-worker.ts` — PWA offline caching via Workbox

### i18n / Translations

When adding new i18n keys to `src/i18n/locales/en.json`, you **must** also add the corresponding key with an appropriate translated value to every other locale file in the same directory:

- `de.json` — German
- `es.json` — Spanish
- `fr.json` — French
- `it.json` — Italian
- `nl.json` — Dutch
- `pl.json` — Polish
- `pt.json` — Portuguese

Do not use the English string as a placeholder in non-English locales. Provide a proper translation for each language.

Run `task check-translations` after adding keys to verify all locale files are in sync with `en.json`.

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

### i18n / Translations

Same 8-language requirement as the webapp. When adding new i18n keys to `src/i18n/locales/en.json`, add proper translations to all other locale files (`de.json`, `es.json`, `fr.json`, `it.json`, `nl.json`, `pl.json`, `pt.json`). Do not use English strings as placeholders.

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
2. **Go 1.25 Alpine** — compiles the Go binary (pure Go, no CGO)
3. **Alpine runtime** — copies binary and frontend build; exposes port 8080

```bash
docker compose up -d
```

Persistent data is mounted at `/data` (default `docker-compose.yml` maps host `./data` to `/data`).

**Workflow pinning policy:** In GitHub Actions workflows, pin every external action `uses:` reference (`owner/repo@...`) to a full commit SHA and add an inline comment with the intended major version tag (for example, `# v6`). Do not use floating action refs such as `@v4`, `@v6`, `@main`, or `@latest`.

### CI Checklist (before opening a PR)

1. `task test` — all tests pass
2. `task lint` — no lint errors
3. `task test-e2e` — e2e tests pass (add new e2e tests for any new user-facing features)
