# Jot Project Instructions

## Documentation Maintenance

- When development instructions change (build scripts, dev setup, etc.), update the README.md to reflect the changes
- When functionality changes (API endpoints, features, configuration options, etc.), update the documentation in docs/ directory:
  - docs/user/ - Update user-facing documentation for new features or workflow changes
  - docs/admin/ - Update admin documentation for configuration, installation, or maintenance changes

## Git Workflow

- Don't commit to master unless specifically asked. Use a separate feature branch instead.
- Don't create commits on the master branch unless specifically asked to do so.
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
- `task test-mobile` - Run mobile app tests
- `task lint-mobile` - Run mobile app linting

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
│   │   ├── auth/        # JWT middleware and token utilities
│   │   ├── database/    # SQLite store types (UserStore, NoteStore)
│   │   ├── handlers/    # HTTP request handlers
│   │   ├── models/      # Shared data types
│   │   └── server/      # Server setup, routing, middleware wiring
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
│   │   ├── types/       # Shared TypeScript interfaces
│   │   └── utils/       # API client, auth helpers
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
- **SQLite 3** — File-based database (requires CGO)
- **golang-jwt/jwt v5** — JWT generation and validation
- **bcrypt** — Password hashing
- **logrus** — Structured logging
- **testify** — Test assertions

### Architecture Patterns

**Store pattern** — database interaction is wrapped in `*Store` types (`UserStore`, `NoteStore`) that each hold a `*sql.DB`. No ORM is used; all queries are hand-written SQL with parameterized inputs.

**Handler pattern** — handlers have the signature:
```go
func(w http.ResponseWriter, r *http.Request) (int, error)
```
They return an HTTP status code and error. The `wrapHandler` middleware in `server.go` handles writing the status and logging the error uniformly.

**ID generation** — all primary keys are 22-character cryptographically random alphanumeric strings generated from `crypto/rand`.

**Middleware** — authentication middleware extracts the JWT from `Authorization: Bearer <token>`, validates it, and stores the claims in the request context. Admin middleware checks the `role` claim.

### API Routes

All endpoints are prefixed with `/api/v1/`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/register` | No | Register a new user |
| POST | `/login` | No | Login, returns JWT token |
| GET | `/notes` | Yes | List notes (`archived`, `search` query params) |
| POST | `/notes` | Yes | Create a note |
| GET | `/notes/{id}` | Yes | Get a single note |
| PUT | `/notes/{id}` | Yes | Update note properties |
| DELETE | `/notes/{id}` | Yes | Delete a note (owner only) |
| POST | `/notes/reorder` | Yes | Reorder notes |
| POST | `/notes/{id}/share` | Yes | Share note with a user |
| DELETE | `/notes/{id}/share` | Yes | Remove share |
| GET | `/notes/{id}/shares` | Yes | List users a note is shared with |
| GET | `/users` | Yes | Search users |
| GET | `/admin/users` | Admin | List all users |
| POST | `/admin/users` | Admin | Create a user |

`GET /health` — unauthenticated health check.

### Database Schema

**users**
- `id` TEXT PK — 22-char random ID
- `username` TEXT UNIQUE — 2–30 chars, alphanumeric/underscore/hyphen
- `password_hash` TEXT — bcrypt
- `role` TEXT — `'user'` or `'admin'`
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
- `created_at`, `updated_at` DATETIME

**note_items** (todo list items)
- `id` TEXT PK
- `note_id` TEXT FK → notes
- `text` TEXT
- `completed` BOOLEAN
- `position` INTEGER
- `created_at`, `updated_at` DATETIME

**note_shares**
- `id` TEXT PK
- `note_id`, `shared_with_user_id`, `shared_by_user_id` TEXT FKs
- `permission_level` TEXT — `'edit'` (only level currently)
- `created_at`, `updated_at` DATETIME

**migrations** — internal migration tracking table.

### Database Migrations

Migration files live in `server/migrations/` and are named `NNN_description.sql`. They are applied automatically at startup in sequential order. To add a new migration, create the next numbered file.

### Configuration (Environment Variables)

| Variable | Default | Notes |
|----------|---------|-------|
| `DB_PATH` | `./jot.db` | Path to SQLite database file |
| `JWT_SECRET` | `your-secret-key-change-in-production` | **Must be changed in production** |
| `PORT` | `8080` | HTTP listen port |
| `STATIC_DIR` | `../webapp/build/` | Path to compiled frontend files |

### Authentication

- JWT tokens are signed with HS256, valid for 24 hours.
- Token claims: `user_id`, `username`, `role`.
- Client sends `Authorization: Bearer <token>` header.
- The first registered user automatically becomes admin.
- Note access is granted if the requester is the owner **or** the note is shared with them.

### Naming Conventions (Go)

- Packages: `internal/{auth,database,handlers,models,server}`
- Go types/vars: camelCase (`noteStore`, `userID`)
- Database columns: snake_case (`note_type`, `user_id`)
- JSON fields: snake_case (`note_type`, `user_id`)
- Error wrapping: `fmt.Errorf("context: %w", err)`

### Server Tests

- Integration tests live in `server/` root: `http_integration_test.go`, `http_notes_sharing_test.go`
- Unit tests alongside source: e.g., `server/internal/models/note_test.go`
- Tests spin up an `httptest.Server` against a temporary SQLite database (`/tmp/test_*.db`)
- Helper types: `TestResponse`, `TestUser`, `TestServer`
- Run: `task test-server`

---

## Webapp (React/TypeScript)

### Technology Stack

- **React 18** + **TypeScript 5**
- **Vite 7** — build tool and dev server
- **React Router DOM 6** — client-side routing
- **axios** — HTTP client (with request/response interceptors for auth)
- **Tailwind CSS** — utility-first styling (no scoped styles)
- **@dnd-kit** — drag-and-drop for note reordering
- **@headlessui/react** — unstyled accessible components
- **@heroicons/react** — icon set
- **Vite PWA plugin** — service worker and offline support

### Key Files

- `src/utils/api.ts` — axios instance and all API call functions
- `src/utils/auth.ts` — token/user read/write in localStorage
- `src/types/index.ts` — all shared TypeScript interfaces (single source of truth)
- `src/service-worker.ts` — PWA offline caching via Workbox

### Naming Conventions (TypeScript/React)

- Component files: PascalCase + `.tsx` (`NoteModal.tsx`)
- Utility files: camelCase + `.ts` (`api.ts`)
- Type interfaces: PascalCase (`CreateNoteRequest`, `Note`)
- CSS: Tailwind utility classes only; no component-scoped stylesheets
- Custom hooks prefix: `use` (`useNotes`, `useAuth`)

### API Response Patterns

- Success: JSON object or array
- Auth responses: `{ token, user }` shape
- Errors: HTTP status code + plain-text body

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
# Terminal 1 — backend (hot-reload via go run)
task run-server

# Terminal 2 — frontend (Vite dev server with HMR)
task run-webapp
```

The server at `localhost:8080` serves the API. Vite can be configured with a proxy to forward API calls during development.

### Docker (Production)

Multi-stage `Dockerfile`:
1. **Node 24 Alpine** — builds the React app (`npm ci && npm run build`)
2. **Go 1.24 Alpine** — compiles the Go binary (CGO enabled for SQLite)
3. **Alpine runtime** — copies binary, migrations, and frontend build; exposes port 8080

```bash
docker compose up -d
```

Persistent data is stored in the `/data` Docker volume. Set `JWT_SECRET` to a secure random value in production.

### CI Workflows

CI is split into per-component workflows in `.github/workflows/`:

| Workflow | File | Triggers |
|----------|------|----------|
| Server — CI | `server-ci.yml` | `server/**` push/PR |
| Webapp — CI | `webapp-ci.yml` | `webapp/**` push/PR |
| Mobile — CI | `mobile-ci.yml` | `mobile/**` push/PR |
| Mobile — APK Build | `mobile-apk.yml` | master push, `v*` tags |
| Docker | `docker.yml` | master push, PR |

### CI Checklist (before opening a PR)

1. `task test` — all tests pass
2. `task lint` — no lint errors
3. `task test-e2e` — e2e tests pass (add new e2e tests for any new user-facing features)

---

## Note Features Summary

| Feature | Details |
|---------|---------|
| Note types | `text` (title + content) or `todo` (checklist items) |
| Pinning | Pinned notes appear first; unpinned position is saved and restored |
| Archiving | Archived notes shown in a separate view |
| Colors | Per-note hex color |
| Search | Full-text search across title, content, and todo item text |
| Sharing | Share with other users by username; `edit` permission |
| Reordering | Drag-and-drop via `@dnd-kit`; position persisted to DB |
| Offline | PWA service worker with Workbox caching |
