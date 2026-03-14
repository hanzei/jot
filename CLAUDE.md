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
- When functionality changes (API endpoints, features, configuration options, etc.), update the documentation in docs/ directory:
  - docs/user/ - Update user-facing documentation for new features or workflow changes
  - docs/admin/ - Update admin documentation for configuration, installation, or maintenance changes

## Git Workflow

- Don't commit to `master` unless specifically asked; always use a separate feature branch.
- Before creating a PR, run all tests and ensure they pass. Also run the linter.

## Code Review Loop

After completing a set of changes, run a sub-agent review loop before finalizing:

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
- `task test` - Run all tests
- `task test-server` - Run server tests
- `task test-webapp` - Run webapp tests
- `task test-e2e` - Run Playwright end-to-end tests (`webapp/e2e/`)
- `task coverage` - Run server tests with coverage report
- `task lint` - Run linters
- `task lint-server` - Run server linting with golangci-lint
- `task lint-webapp` - Run webapp linting
- `task check-translations` - Verify locale files stay in sync with `en.json`
- `task test-mobile` - Run mobile app tests
- `task lint-mobile` - Run mobile app linting
- `task gen-docs` - Regenerate Swagger API docs from handler annotations (requires `swag` CLI)

---

## Codebase Overview

Jot is a self-hosted note-taking application. The backend is a Go HTTP API and the frontend is a React/TypeScript SPA. A single Go binary serves both the API and the compiled frontend static files.

### Directory Structure

```
/
├── server/          # Go backend
│   ├── main.go
│   ├── go.mod
│   ├── internal/
│   │   ├── auth/        # Session-cookie auth middleware and utilities
│   │   ├── database/    # Database bootstrap and migration runner
│   │   ├── handlers/    # HTTP request handlers
│   │   ├── models/      # Store types and shared data models
│   │   ├── sse/         # Server-sent event hub and event types
│   │   └── server/      # Server setup, routing, middleware wiring
│   ├── docs/            # Generated OpenAPI docs (swagger)
│   └── migrations/      # Sequential SQL migration files
├── webapp/          # React/TypeScript frontend
│   ├── src/
│   │   ├── components/  # React components
│   │   ├── pages/       # Route-level page components
│   │   ├── types/       # Shared TypeScript interfaces
│   │   └── utils/       # API client, auth helpers
│   └── package.json
├── mobile/          # React Native/Expo mobile app
│   ├── src/
│   │   ├── components/  # React Native components
│   │   ├── screens/     # Screen components
│   │   ├── navigation/  # React Navigation setup
│   │   ├── hooks/       # Custom hooks (API, auth, sync)
│   │   ├── api/         # API client modules
│   │   ├── db/          # Local SQLite/offline persistence
│   │   ├── store/       # Context/state providers
│   │   ├── types/       # Shared TypeScript interfaces
│   └── package.json
├── docs/
│   ├── user/        # End-user documentation
│   ├── admin/       # Operator/admin documentation
│   └── mobile/      # Mobile app phase specs
├── Taskfile.yml
├── Dockerfile       # Multi-stage production build
└── docker-compose.yml
```

---

## Server (Go)

### Technology Stack

- **Go 1.24**
- **Chi v5** — HTTP router with middleware
- **go-chi/cors** — CORS middleware
- **SQLite 3** — File-based database (requires CGO)
- **bcrypt** — Password hashing
- **logrus** — Structured logging
- **testify** — Test assertions
- **swaggo/swag + http-swagger** — OpenAPI spec generation and Swagger UI

### Architecture Patterns

**Store pattern** — database interaction is wrapped in `*Store` types (`UserStore`, `NoteStore`, etc.) in `internal/models`, each holding a `*sql.DB`. No ORM is used; all queries are hand-written SQL with parameterized inputs.

**Handler pattern** — handlers have the signature:
```go
func(w http.ResponseWriter, r *http.Request) (int, error)
```
They return an HTTP status code and error. The `wrapHandler` middleware in `server.go` handles writing the status and logging the error uniformly.

**ID generation** — most entity IDs are 22-character cryptographically random alphanumeric strings generated from `crypto/rand`. Session tokens are 64-character hex strings.

**Middleware** — authentication middleware reads the `jot_session` cookie, resolves the user from the session store, and saves the user in request context. Admin middleware checks the authenticated user's `role`.

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
- `user_id` TEXT FK → users
- `title`, `content` TEXT
- `note_type` TEXT — `'text'` or `'todo'`
- `color` TEXT — hex color (default `#ffffff`)
- `pinned`, `archived` BOOLEAN
- `position` INTEGER — display order
- `unpinned_position` INTEGER (nullable) — saved position restored when unpinning
- `checked_items_collapsed` BOOLEAN — UI state for todo notes
- `deleted_at` DATETIME (nullable soft-delete/trash marker)
- `created_at`, `updated_at` DATETIME

**note_items** (todo list items)
- `id` TEXT PK
- `note_id` TEXT FK → notes
- `text` TEXT
- `completed` BOOLEAN
- `position` INTEGER
- `indent_level` INTEGER
- `created_at`, `updated_at` DATETIME

**note_shares**
- `id` TEXT PK
- `note_id`, `shared_with_user_id`, `shared_by_user_id` TEXT FKs
- `permission_level` TEXT — `'edit'` (only level currently)
- `created_at`, `updated_at` DATETIME

**labels**
- `id` TEXT PK
- `user_id` TEXT FK → users
- `name` TEXT
- `created_at`, `updated_at` DATETIME

**note_labels**
- `id` TEXT PK
- `note_id` TEXT FK → notes
- `label_id` TEXT FK → labels
- `created_at` DATETIME
- UNIQUE(`note_id`, `label_id`)

**sessions**
- `token` TEXT PK (64-char hex session token)
- `user_id` TEXT FK → users
- `expires_at`, `created_at` DATETIME

**user_settings**
- `user_id` TEXT PK/FK → users
- `language` TEXT
- `theme` TEXT (`system`, `light`, `dark`)
- `created_at`, `updated_at` DATETIME

**migrations** — internal migration tracking table.

### Database Migrations

Migration files live in `server/migrations/` and are named `NNN_description.sql`. They are applied automatically at startup in sequential order. To add a new migration, create the next numbered file.

### Configuration (Environment Variables)

| Variable | Default | Notes |
|----------|---------|-------|
| `DB_PATH` | `./jot.db` | Path to SQLite database file |
| `PORT` | `8080` | HTTP listen port |
| `STATIC_DIR` | `../webapp/build/` | Path to compiled frontend files |
| `CORS_ALLOWED_ORIGIN` | `http://localhost:5173` | Allowed webapp origin for CORS |
| `COOKIE_SECURE` | `true` (unless explicitly `false`) | Whether the session cookie is `Secure` |

### Authentication

- Auth is session-based using an HttpOnly `jot_session` cookie.
- Sessions are persisted in the `sessions` table with 24-hour expiry.
- Browser clients send credentialed requests (`withCredentials: true`).
- The first registered user automatically becomes admin.
- Note access is granted if the requester is the owner **or** the note is shared with them.

### Naming Conventions (Go)

- Packages: `internal/{auth,database,handlers,models,sse,server}`
- Go types: PascalCase when exported (`UserStore`, `NoteStore`); variables: camelCase (`noteStore`, `userID`)
- Database columns: snake_case (`note_type`, `user_id`)
- JSON fields: snake_case (`note_type`, `user_id`)
- Error wrapping: `fmt.Errorf("context: %w", err)`

### Server Tests

- Integration tests live in `server/` root (for example: `http_integration_test.go`, `http_notes_sharing_test.go`, `http_labels_test.go`, `http_import_test.go`, `http_profile_icon_test.go`)
- Unit tests alongside source: e.g., `server/internal/models/note_test.go`
- Tests spin up an `httptest.Server` against a temporary SQLite database (`/tmp/test_*.db`)
- Helper types: `TestResponse`, `TestUser`, `TestServer`
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

## Build & Deployment

### Local Development

```bash
# Terminal 1 — backend (build + run binary)
task run-server

# Terminal 2 — frontend (Vite dev server with HMR)
task run-webapp
```

The server at `localhost:8080` serves the API. Vite is configured with a proxy to forward API calls during development.

### Docker (Production)

Multi-stage `Dockerfile`:
1. **Node 24 Alpine** — builds the React app (`npm ci && npm run build`)
2. **Go 1.24 Alpine** — compiles the Go binary (CGO enabled for SQLite)
3. **Alpine runtime** — copies binary, migrations, and frontend build; exposes port 8080

```bash
docker compose up -d
```

Persistent data is mounted at `/data` (default `docker-compose.yml` maps host `./data` to `/data`).

### CI Workflows

CI is split into per-component workflows in `.github/workflows/`:

| Workflow | File | Triggers |
|----------|------|----------|
| Server — CI | `server-ci.yml` | push to `master`; PRs touching `server/**` |
| Webapp — CI | `webapp-ci.yml` | push to `master`; PRs touching `webapp/**` |
| Mobile — CI | `mobile-ci.yml` | push to `master`; PRs touching `mobile/**` |
| Mobile — APK Build | `mobile-apk.yml` | push to `master` and `v*` tags; PRs touching `mobile/**` |
| Docker | `docker.yml` | push to `master`; all PRs |
| Release | `release.yml` | push tags `v*` |
| Claude Code | `claude.yml` | issue/PR comment and review events, plus issues opened/assigned, when `@claude` is mentioned |

### CI Checklist (before opening a PR)

1. `task test` — all tests pass
2. `task lint` — no lint errors
3. `task test-e2e` — e2e tests pass (add new e2e tests for any new user-facing features)

