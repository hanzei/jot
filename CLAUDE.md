# Jot Project Instructions

Per-area instructions live alongside the code and also apply when you work
there: [`server/CLAUDE.md`](server/CLAUDE.md) (Go naming and error handling),
[`webapp/CLAUDE.md`](webapp/CLAUDE.md) (i18n rules), and
[`mobile/CLAUDE.md`](mobile/CLAUDE.md) (offline/connectivity invariants,
filesystem and logging rules).

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
- Before creating a PR, run `task check` (lint + tests) and ensure it passes. See the CI Checklist at the end of this file for the full pre-PR gate.

### Pull request artifacts

- Include screenshots for visual/UI changes whenever possible.
- Include a short demo video for flows that are better shown in motion.
- If no visual artifact is feasible (backend-only changes, for example), say so briefly in the PR description.
- Call out API-breaking changes per the Development Status Notice above.

## Code Review Loop

Only run a review pass for large, complex PRs — this should be a rare exception, not the default. Skip for anything that isn't genuinely large and architecturally significant (e.g. most bug fixes, small features, refactors, config changes, and single-area changes do not qualify).

When a PR does qualify:

1. Launch **one sub-agent** that runs both `/code-review --effort medium` (correctness bugs) and `/simplify` (quality/cleanup and consistency with project conventions) on all changed files.
2. Address every piece of valid feedback the review returns (fix bugs, improve clarity, align with conventions).
3. Only proceed to commit/push after the review pass finishes — do not repeat the loop.

## Working from a GitHub issue

`/work-issue <url|#123|123>` (`.claude/commands/work-issue.md`) takes an issue and drives
it to a draft PR. It verifies the ticket before writing any code — whether the problem is
real, whether the proposed solution is over- or under-engineered for this codebase, and
whether it fits the architecture — and stops to discuss only when something is materially
wrong. Everything after that point is the normal workflow documented here.

## Commands and skills

`.claude/commands/` holds the workflows you start by name. They are deliberate, scheduled
operations: you decide when a sweep happens or which ticket gets picked up, so nothing
should start one on your behalf.

`.claude/skills/` holds the ones the model should reach for on its own, matched against
the situation rather than typed. Only `cut-release` qualifies today, because getting a
release wrong is unrecoverable — pushing a tag out of order bricks it permanently — so it
needs to fire on "ship v0.9.0" whether or not anyone remembers it exists.

The tradeoff of a command is that nothing surfaces it automatically. Where that matters,
`CLAUDE.md` carries the pointer instead — see [Dependency Updates](#dependency-updates),
which is what keeps an offhand "bump the OTel packages" from turning into a bare
`go get -u`.

## Environment Setup

`scripts/bootstrap.sh` provisions a checkout: it installs `task`, runs `npm ci`
in `shared/` → `webapp/` → `mobile/` (skipping packages that already have
`node_modules`), installs the Chromium build Playwright needs, warms the Go
build cache, and warns about Node/Go version skew. It is the single source of
truth for setup — `.claude/settings.json` runs
it from a `SessionStart` hook and `shell.nix` runs it on shell entry, so **a
session should already be provisioned and `task ...` should work as the first
command**. Do not add setup steps to those entry points; add them to the
script.

The Go warm-up is there because `golangci-lint` type-checks every package:
`task lint-server` is ~1s warm and ~2.5 minutes cold, and that cost otherwise
lands on whoever lints first, usually at the end of a change.

If `task` is somehow missing, run `./scripts/bootstrap.sh` (directly — `task`
cannot install itself) rather than working around it with raw `go test`/`npm run`.
`JOT_BOOTSTRAP_SKIP=1`, `JOT_BOOTSTRAP_SKIP_NPM=1`,
`JOT_BOOTSTRAP_SKIP_PLAYWRIGHT=1`, and `JOT_BOOTSTRAP_SKIP_GO_CACHE=1` opt out.
The README documents the script for humans; do not restate its steps
elsewhere.

### Editing feedback

`.claude/settings.json` registers a `PostToolUse` hook that runs
`scripts/lint-file.sh` on every file written or edited, linting just that file
(`golangci-lint` for Go, ESLint for TypeScript) and reporting failures against
the edit that caused them rather than at the end of the task. It is a fast
subset — single-file ESLint means nothing needing whole-project type
information (`tsc --noEmit`, `task check-translations`) is covered — so it
narrows the `task check` loop without replacing it. Anything it cannot lint is
a silent pass.

`scripts/bootstrap.sh` installs the Chromium build Playwright needs, so
`task test-e2e` normally just works. `scripts/check-playwright-browser.sh`
still runs first as a safety net (`JOT_BOOTSTRAP_SKIP_PLAYWRIGHT=1`, or
reaching `test-e2e` without ever running bootstrap) and stops with the install
command if the browser is missing or version-mismatched.

## Development Tasks

Use the following Task commands for development:

**Verification** — prefer the narrowest one that covers what you touched:

- `task check-server` / `check-webapp` / `check-mobile` / `check-shared` - Lint + test one area, plus that area's own gates: `check-server` also runs `check-docs` and `check-migrations`, `check-webapp` also runs `check-translations`
- `task check` - Pre-PR gate: everything CI runs except e2e (see the CI Checklist below)
- `task test` - All tests except e2e (shared + server + webapp + mobile)
- `task lint` - All linters (shared + server + webapp + mobile)
- `task test-server` / `test-webapp` / `test-mobile` / `test-shared` - One test suite
- `task lint-server` / `lint-webapp` / `lint-mobile` / `lint-shared` - One linter
- `task test-e2e` - Playwright end-to-end tests (`webapp/e2e/`)
- `task check-docs` - Verify `server/docs/` matches the handler annotations
- `task check-migrations` - Verify the sqlite and postgres migration trees match
- `task check-translations` - Verify locale files stay in sync with `en.json`
- `task coverage` - Run server tests with coverage report

Every `test-*` task forwards `{{.CLI_ARGS}}`, so scope a run with `--`:

```bash
task test-server -- -run TestCreateNote     # one Go test
task test-webapp -- NoteModal               # one Vitest file pattern
task test-e2e -- notes.spec.ts              # one Playwright spec
```

Both run their suites **serially** (not in parallel) so a failure is
attributable to one suite rather than buried in interleaved output. They differ
in what happens after one fails:

- **`task lint` keeps going** and ends with a summary of every suite that
  failed. A change spanning `shared/` + `webapp/` + `mobile/` reports all of it
  in one pass instead of one suite per rerun.
- **`task test` stops at the first failure**, on purpose: a broken `shared/` or
  `server/` makes the suites downstream of it fail for reasons that are not
  their own, and reporting those is noise, not information.

**Running and building:**

- `task run-server` - Start the Jot server
- `task run-webapp` - Start webapp dev server with HMR
- `task build-webapp` - Build the webapp into `webapp/build`
- `task build-jotctl` - Build the `jotctl` admin CLI binary (see below)
- `task fmt` - Apply formatting to every workspace (Go and TypeScript); scope it with `fmt-server` / `fmt-shared` / `fmt-webapp` / `fmt-mobile`
- `task gen-docs` - Regenerate Swagger API docs from handler annotations
- `task clean` - Remove generated files and node packages

`golangci-lint` and `swag` are pinned as `tool` directives in `server/go.mod`
and run via `go tool` — do not `go install` a separate copy, it will drift
from the version CI uses.

### Formatting

`task fmt` applies formatting to every workspace; the matching `lint-*` task
reports it. Each rule therefore has exactly one home, and neither language
needs a separate formatter tool.

**Go** goes through golangci-lint's `formatters:` block in `.golangci.yml`.
Three are enabled: **gofumpt** (a strict superset of `gofmt`, so `gofmt` itself
is not listed separately), **goimports**, and **swaggo** for the
`@Param`/`@Success` annotation tables in `internal/handlers`. The comment above
that block says why `gci` and `golines` are not.

goimports adds and drops imports to match what a file actually uses, so a stale
import left behind by an edit is fixed by `task fmt` rather than reported as a
`typecheck` failure.

**TypeScript** enforces exactly two things, as ESLint rules in all three
workspace configs:

```js
semi: ['error', 'always'],
quotes: ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
```

Both are autofixable, and `task fmt` applies them with `--fix-type layout` so
it stays a formatter and never rewrites logic. There is no Prettier and no
Biome, deliberately: measured against this codebase, Prettier rewrote 189 of
271 files and flattened hand-grouped literals like `ALLOWED_TAGS` in
`webapp/src/utils/markdown.ts`, where the layout carries meaning the comment
above it refers to. [#837](https://github.com/hanzei/jot/issues/837) has the
full comparison.

**Everything else is the author's call** — line width, wrapping, how a literal
is laid out. There is deliberately no line-width or indentation rule. For
anything not covered by the two rules above, match the surrounding file and do
not reformat code you did not otherwise need to touch.

A formatting-only commit goes in `.git-blame-ignore-revs` so `git blame` points
at whoever wrote the line rather than at the reformat. GitHub applies that file
on its own; locally it needs
`git config blame.ignoreRevsFile .git-blame-ignore-revs`.

### TypeScript strictness

`shared/tsconfig.json`, `webapp/tsconfig.json`, and `mobile/tsconfig.json`
carry the same strictness set on top of `strict`, and the two `webapp`
sub-projects inherit theirs. **Read them for what is on** — enumerating the
flags here only produced a list that went stale every time one moved. What the
configs cannot say: keep them in step. A flag one workspace has and another
does not is drift, not a decision, and the fix is to turn it on everywhere
rather than to record the exception. One known gap, tracked rather than
intentional — nothing anywhere runs `exactOptionalPropertyTypes`.

`noUncheckedIndexedAccess` types every indexed read as `T | undefined`, so
`arr[i]` and `record[key]` have to be handled rather than assumed
([#843](https://github.com/hanzei/jot/issues/843)). Two ways to satisfy it, and
the choice is not stylistic:

- **A guard**, when the index can genuinely be out of range — a stale
  highlighted-suggestion index, a lookup that may miss. This is the case the
  flag exists to find, and `?? null` or an `if` is the fix.
- **A `!` assertion**, when it provably cannot — a bounds check two lines up, a
  regex group that is not optional, an array built with exactly that many
  entries. Keep the reason visible from the assertion: adjacent, or in a
  comment. `for...of`, `.entries()`, and `.map()` sidestep the question
  entirely and are usually the better rewrite.

Test code is the one place to reach for `!` freely: a test that indexes past
the end should fail loudly, and asserting keeps it reading as a test.

**Node types are not repo-wide, on purpose** — `types: ["node"]` must not reach
`src`, or app code touching `process`/`Buffer`/`fs` type-checks clean and breaks
in the browser. The header comment in `webapp/tsconfig.e2e.json` has the full
reasoning. The consequence worth knowing before you add a file outside `src`:
`webapp` has three projects, each one an invocation in `lint:ts`.

| Project | Covers | Adds |
|---|---|---|
| `tsconfig.json` | `src` | the shared strictness set; browser `lib` only |
| `tsconfig.node.json` | `vite.config.ts` | `types: ["node"]` |
| `tsconfig.e2e.json` | `e2e/`, `playwright.config.ts` | `types: ["node"]` |

`tsc --noEmit` does not follow project references, so a project not named in
`lint:ts` is not checked — that is how `e2e/` went unchecked until
[#839](https://github.com/hanzei/jot/issues/839) and `vite.config.ts` with it.
The `references` array is still there, for editors: it is what lets tsserver
resolve a file outside `src` to the project that actually governs it. A new
tree outside `src` needs both, or it silently gets neither.

### Seeing it run

Screenshots for UI changes (see [Pull request artifacts](#pull-request-artifacts))
need a server with data in it. `jotctl` is how you get one:

```bash
task run-server                      # terminal 1
task build-jotctl                    # terminal 2
./server/jotctl login --server http://localhost:8080 --username <admin>
./server/jotctl dev seed             # notes, labels, lists, images, shares
```

`dev seed` covers the full feature surface — including every Markdown
construct the renderer supports — so it is usually faster than clicking a
scenario together by hand. `dev reset` deletes all non-admin users and every
note. Both are development-only; never point them at a real server. The README
documents the rest of `jotctl` (user management, `JOTCTL_*` environment
variables).

## Dependency Updates

Three separate things update dependencies here, and they are easy to confuse:

- **Dependabot version updates** (`.github/dependabot.yml`) cover **GitHub Actions only** —
  one grouped PR a month, re-pinning action SHAs as they drift. That is a strict subset of
  what `update-github-actions` does: Dependabot keeps existing pins current between sweeps,
  the command handles major bumps, one-SHA-everywhere divergence, runner labels,
  permissions, and path filters. They are complements, not alternatives — do not remove
  either on the assumption the other covers it.
- **Dependabot security updates** are enabled at the repository level, not by that file, and
  open advisory-driven PRs for **every** ecosystem including the ones the config omits.
  Adding or removing `dependabot.yml` does not affect them.
- **Everything else** is updated deliberately, one workspace at a time, via the commands in
  `.claude/commands/`:

  - `update-server-deps` — Go modules, `go.mod` tool directives (golangci-lint, swag), Go toolchain version
  - `update-shared-deps` — `@jot/shared` devDependencies
  - `update-webapp-deps` — webapp npm packages, `overrides` block, Playwright browsers
  - `update-mobile-deps` — Expo/React Native packages (Expo SDK dictates most versions)
  - `update-docker-deps` — Dockerfile base images, CI container images, `docker-compose.yml`, `.dockerignore`
  - `update-github-actions` — pinned action SHAs in `.github/workflows/`, runner labels, permissions

**Run the command; do not update these by hand.** Each one exists because the obvious
approach — `go get -u ./...`, `npm update`, editing a `FROM` or `uses:` line — silently
breaks a coupling that only shows up in CI or on a device. Since these are commands rather
than skills, nothing will surface them automatically: this list is the pointer, so consult
it whenever a dependency update comes up, whoever asked and however it was phrased.

For a full sweep, update in the order **shared → webapp → mobile** (both consumers compile
`shared/src` directly through the `file:../shared` link); `server/` is independent. The
Docker and Actions commands are independent of all four and of each other, but the base
images they touch mirror versions owned by the language commands. When Docker and a
language update are both in scope, run the owning language command first
(`update-server-deps` for Go, `update-webapp-deps` for Node) and `update-docker-deps`
after it, so the Dockerfile lands aligned with `server/go.mod` and `.nvmrc` rather than
drifting until the next image build.

npm, the Go module, and Docker are kept out of `dependabot.yml` on purpose — the coupling
constraints that make them manual are documented in the comments at the top of that file.
Do not add them without reading those first.

---

## Codebase Overview

Jot is a self-hosted note-taking application. The backend is a Go HTTP API and the frontend is a React/TypeScript SPA. A single Go binary serves both the API and the compiled frontend static files.

### Directory Structure

Orientation, not an inventory — directories are listed, individual files are
not. Run `ls` rather than trusting this tree to be exhaustive.

```text
/
├── shared/          # @jot/shared — types, constants, and utilities shared by webapp & mobile
│   └── src/             # types.ts is the single source of truth for domain interfaces
├── server/          # Go backend
│   ├── main.go
│   ├── client/          # Go client SDK types (used by jotctl)
│   ├── cmd/jotctl/      # Admin CLI tool (build with task build-jotctl)
│   ├── internal/
│   │   ├── auth/        # Session-cookie + PAT auth middleware and utilities
│   │   ├── blobstore/   # Filesystem note-image storage (ImageStore) + orphan reclaim
│   │   ├── config/      # Server configuration (env vars, defaults)
│   │   ├── database/    # Database bootstrap and migration runner
│   │   │   ├── migrations/sqlite/    # SQLite migrations (embedded into binary)
│   │   │   ├── migrations/postgres/  # Postgres migrations (embedded into binary)
│   │   │   ├── dialect/  # Per-dialect SQL differences
│   │   │   ├── dsntest/  # Postgres DSN/raw-connection test helpers
│   │   │   └── dbtest/   # Fully migrated test databases
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
│   │   ├── test/        # Vitest setup and shared test helpers
│   │   └── utils/       # API client, auth helpers
│   └── e2e/             # Playwright end-to-end tests
│       ├── fixtures/    # Test fixtures and helpers
│       ├── pages/       # Page Object Model classes
│       └── tests/       # E2E test specs
├── mobile/          # React Native/Expo mobile app
│   └── src/
│       ├── api/         # API client modules
│       ├── components/  # React Native components
│       ├── db/          # Local SQLite/offline persistence
│       ├── hooks/       # Custom hooks (API, auth, sync)
│       ├── i18n/        # Internationalization (8 languages)
│       ├── navigation/  # React Navigation setup
│       ├── screens/     # Screen components
│       ├── store/       # Context/state providers
│       ├── theme/       # Colors, spacing, typography tokens
│       └── utils/       # Filesystem wrapper, logger, helpers
├── docs/specs/      # Design docs for cross-cutting features — read these before
│                    # touching file attachments, mobile connectivity, deep
│                    # linking, or Markdown rendering
├── images/          # Documentation images
├── scripts/         # bootstrap.sh (setup) + check-playwright-browser.sh
├── Taskfile.yml
├── Dockerfile       # Multi-stage production build
└── docker-compose.yml
```

### Shared package (`@jot/shared`)

Both consumers compile `shared/src` directly rather than a build artifact, so
its source has to satisfy the stricter of the two toolchains — the mobile app's
Babel/Jest setup. One construct to avoid: **array destructuring**, in either
form (`.map(([id]) => id)` or `const [a, b] = pair`). Babel lowers it to a
`@babel/runtime` helper, and that helper is resolved relative to `shared/`,
which has no `@babel/runtime`. Mobile's copy does not apply —
`mobile/node_modules/@jot/shared` is a symlink and Node resolves the realpath,
so the lookup walks up from `shared/` and never reaches `mobile/node_modules`.
Use index access (`entry[0]`) instead; it compiles to nothing.

Iterable spread (`[...map.values()]`), `for...of`, and value imports between
shared modules are all fine — only destructuring pulls a helper in.

The failure is not local, which makes it hard to place: **every** mobile suite
fails to *load*, because `jest.setup.js` imports i18n which imports
`@jot/shared`, and the error names the file's first import line rather than the
destructuring. Run `task test-mobile` after touching `shared/src`, not just
`task test-shared`.

(Adding `@babel/runtime` to `shared/` does fix it, and is the lever to reach for
if this ever constrains real code — but `shared/` has no runtime dependencies
today, and both consumers would inherit one that exists purely to satisfy
mobile's transform.)

---

## Server (Go)

### Technology Stack

- **Go 1.26**
- **Chi v5** — HTTP router with middleware
- **go-chi/cors** — CORS middleware
- **SQLite 3** — Default database (pure Go via `modernc.org/sqlite`, no CGO required)
- **Postgres** — Optional alternative backend (`lib/pq`), selected with `JOT_DB_DRIVER=postgres`
- **golang-migrate** — Migration runner, one embedded migration tree per dialect
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

**Blob storage** — `internal/blobstore` exposes `ImageStore` (`NewImageStore`), filesystem storage for note-image bytes, rooted at config `JOT_UPLOAD_DIR` (default `./uploads`). It stores two things under that one root:

- **Originals** — content-addressed by hex-encoded SHA-256, at `blobs/<sha[0:2]>/<sha[2:4]>/<sha>`. `Put` verifies the bytes actually hash to the claimed key before committing, which is what makes it safe for `Put` to dedup by mere existence check. `Open`/`Delete` round it out.
- **Thumbnails** — `PutThumbnail`/`OpenThumbnail`, at `thumb/<sha[0:2]>/<sha[2:4]>/<sha>.jpg`, keyed by the *original's* hash (a resized derivative has no hash of its own). Unverified and disposable: regenerate on a miss rather than treating `ErrNotFound` as an error. Generating them is the caller's job in `internal/handlers`, not `ImageStore`'s. `Delete` removes an original *and* its thumbnail, so there is no `DeleteThumbnail`.

All paths derive solely from the validated hash, never from caller-supplied filenames, so there is no path traversal risk; filesystem access additionally goes through `os.Root` (opened on `JOT_UPLOAD_DIR`, same traversal-resistant pattern used for static file serving in `server.go`) as defense-in-depth.

Because dedup means several rows can share one hash, hard-delete paths must not call `Delete` directly — they call `blobstore.ReclaimIfOrphaned`, which drops the blob only once the refcount (`RefCounter`, satisfied by `*models.NoteStore`) reaches zero. A full backup is **DB + `JOT_UPLOAD_DIR`**. See `docs/specs/file-attachments.md`.

**Configuration** — `internal/config` reads all app-specific server settings from `JOT_`-prefixed environment variables (e.g. `JOT_PORT`, `JOT_DB_DSN`); new config vars should follow this convention. Spec-standard OpenTelemetry SDK vars (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_INSECURE`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`) are a deliberate exception and stay unprefixed so the OTel SDK's own conventions apply.

### API Specification

Do not maintain endpoint tables in this file. Use the generated OpenAPI spec as the canonical API reference:

- `server/docs/swagger.yaml`
- `server/docs/swagger.json`
- Swagger UI at `/api/docs/index.html`

If handler annotations or request/response types change, regenerate docs with `task gen-docs`.

### API Conventions

- Resource-cap / limit-exceeded conditions (e.g., the per-user PAT cap, the per-note item/image cap) return HTTP 422 Unprocessable Entity, not 400. Reserve 400 for malformed/invalid input.
- **Creates return 201 Created.** A create that may instead match an existing resource returns 201 when it inserted and 200 when it handed back what was already there — `POST /labels` is the one such endpoint (see below), and the status code is the only signal a client gets about which happened.
- **`POST /labels` is deliberately get-or-create.** Both clients add labels by typing a name rather than picking an ID, and mobile's offline replay needs the create to be idempotent, so a name that matches an existing label returns it instead of erroring. The client-supplied-ID form is a strict create: a replayed ID is a 409.
- **Verbs:** `PATCH` for a partial update of a resource; `PUT` for a full replacement of a singleton subresource — `PUT /admin/users/{id}/role` is the model case. `PUT /users/me/password` follows the same spelling by convention even though it is really an action (it requires `current_password`, returns 204, and is not idempotent); it is the deliberate exception, not a precedent to extend. `POST` for creates and for named actions on a resource (`/notes/{id}/duplicate`, `/notes/{id}/restore`).
- **Usernames are lower case.** Validation rejects anything else (`server/internal/handlers/validation.go`), so every username written under that rule is lower case and the plain UNIQUE index on `users.username` is case-insensitive in effect for them — no expression index or per-dialect collation needed. Login folds its input before the lookup, so typing `Ben` still signs in as `ben`. Nothing migrates rows written before the rule: a stored `Ben` matches no login at all, and an administrator has to rename it (find them with `SELECT id, username FROM users WHERE username <> LOWER(username)`). The client-side mirror lives in `shared/src/usernameValidation.ts`, shared by both webapp and mobile, so a new rule only needs to change in two places.

### Database Migrations

There are **two** migration trees, one per supported dialect:

```text
server/internal/database/migrations/sqlite/000009_add_thing.up.sql
server/internal/database/migrations/postgres/000009_add_thing.up.sql
```

Each is embedded into the binary via `//go:embed migrations/<dialect>/*.sql`
and run by golang-migrate at startup against whichever driver is configured
(`database.go`). Filenames are `NNNNNN_description.up.sql` — **six** zero-padded
digits, and the `.up.` segment is required; golang-migrate ignores anything
that doesn't parse, and `embed` silently ignores anything outside those two
directories.

**Every schema change needs both files, with the same name in both trees.**
Writing only one is the easiest mistake to make here and the hardest to
notice: the Postgres store tests skip unless `TEST_POSTGRES_DSN` is set, so a
sqlite-only migration passes `task test-server` locally and only fails in CI.
The `migrations` job in `.github/workflows/server-ci.yml` diffs the two
directories to catch it early.

The two files are usually near-identical but never copies. Differences already
in the tree, as a guide to what to watch for:

- Column types — `BLOB` → `BYTEA`, `DATETIME` → `TIMESTAMP` (`000001`).
- Whole strategies, where the feature has no common form: note search is an
  FTS5 virtual table plus sync triggers on SQLite, and a `TSVECTOR` side table
  on Postgres (`000007`). Aim for equivalent *behaviour*, not equivalent SQL —
  that migration's header comments explain how the two are kept consistent.

`internal/database/dialect` holds the per-dialect differences needed at query
time; check whether a schema change needs a counterpart there too.

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

- Integration tests live in `server/` root as `http_<area>_test.go` (`ls server/http_*_test.go` for the current set); add new ones following that naming
- Unit tests alongside source: e.g., `server/internal/models/note_test.go`
- Tests spin up an `httptest.Server` against a per-test SQLite database under `t.TempDir()` — build one with `setupTestServer`/`setupTestServerWithConfig` rather than wiring a server by hand
- **Every top-level integration test calls `t.Parallel()` as its first statement** — new ones must too. Nothing is shared between them: each gets its own database, upload dir, `httptest.Server` on port 0, and its own `*logrus.Logger` writing to that test's `t.Log` (via `server.NewWithLogger`). Do not reintroduce process-global mutation in the harness — `logrus.SetOutput`, `os.Setenv`, `os.Chdir` — it is what kept this suite serial. The one deliberate opt-out is `TestRateLimiting`, commented in place.
- Subtests are a separate decision: they share their parent's server, so only add `t.Parallel()` inside a `t.Run` when those cases genuinely touch disjoint data.
- Password hashing drops to `bcrypt.MinCost` under `go test` (`models.passwordHashCost`, gated on `testing.Testing()`). At `DefaultCost` bcrypt was 65% of this package's CPU time.
- Helper types: `TestResponse`, `TestUser`, `TestServer`
- Use `t.Run` subtests for grouping related cases; see `server/CLAUDE.md` for the full Go test naming and table-driven test conventions
- Run: `task test-server`
- Store-level tests (`internal/models`) and migration/backfill tests (`internal/database`) run against SQLite unconditionally and additionally against Postgres when `TEST_POSTGRES_DSN` is set, via the harnesses in `internal/database/dsntest` (dependency-free DSN/raw-connection helpers, usable even from `internal/database`'s own internal test files) and `internal/database/dbtest` (fully migrated databases, for other packages). Each test creates and drops its own isolated Postgres database; tests skip cleanly when `TEST_POSTGRES_DSN` is unset. See the README's "Testing against Postgres" section for local setup.

---

## Webapp (React/TypeScript)

### Technology Stack

- **React 19** + **TypeScript 6**
- **Vite 8** — build tool and dev server
- **React Router 8** (`react-router`) — client-side routing
- **axios** — HTTP client (with request/response interceptors for auth)
- **Tailwind CSS 4** — utility-first styling (no scoped styles)
- **@dnd-kit** — drag-and-drop for note reordering
- **@headlessui/react** — unstyled accessible components
- **lucide-react** — icon set (the mobile app uses `lucide-react-native`)
- **marked** + **dompurify** — Markdown rendering and sanitization; the feature
  set and the shared normalizer behind it are specified in
  [the Markdown rendering spec](docs/specs/markdown-rendering.md)
- **i18next** / **react-i18next** — translations
- **vite-plugin-pwa** — service worker and offline support

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
- Run: `task test-e2e` (scope to one spec with `task test-e2e -- notes.spec.ts`)
- No server needs to be running first: Playwright's `webServer` builds the webapp, starts the Go server on a throwaway DB, and tears it down. `task test-e2e` pre-compiles the server so that startup stays inside the Playwright timeout on a cold build cache.
- `scripts/bootstrap.sh` provisions the browser, so this is usually a non-issue. `task test-e2e` runs `scripts/check-playwright-browser.sh` first as a safety net, which fails with the exact `npx playwright install chromium` command when the pinned Chromium build is missing — that is a one-command fix, not a broken suite.
- **Linted with the rest of webapp** (`task lint-webapp`), sharing the `tsRules` baseline in `eslint.config.js`. The e2e block drops the React plugins — react-hooks reads Playwright's `use` fixture parameter as React's `use()` hook — and allows `_`-prefixed unused parameters, which is how page objects keep a call signature steady after they stop using an argument.
- A fixture destructured but never referenced is doing real work: Playwright only runs a fixture a test names, so `authenticatedUser` is what logs the test in. Mark it `void authenticatedUser;` rather than deleting it.
- **Type-checked as its own project**, `webapp/tsconfig.e2e.json` — see [TypeScript strictness](#typescript-strictness) below. The e2e ESLint block parses against that same project, which buys it three type-aware rules the app block does not have: `no-floating-promises`, `no-misused-promises`, and `await-thenable`. A dropped `await` on a Playwright call is the failure they exist for — the assertion then runs against the page as it was *before* the action and passes or fails for the wrong reason, which `tsc` cannot see.

---

## Mobile (React Native/Expo)

### Technology Stack

- **React Native 0.86** + **Expo 57**
- **React Navigation 7** — drawer + native stack navigation
- **Tanstack React Query 5** — data fetching and caching
- **Expo Secure Store** — credential storage
- **Expo SQLite** — local offline persistence
- **Expo FileSystem** — blob/file storage, wrapped by `src/utils/fs.ts`
- **react-native-sse** — SSE client for real-time updates
- **marked** — Markdown parsing, the same library and version the webapp uses;
  mobile walks its tokens into React Native components rather than HTML
  ([the Markdown rendering spec](docs/specs/markdown-rendering.md))
- **@jot/shared** — shared types and utilities (local file dependency)

### Mobile Tests

- Framework: **Jest**
- Test files in `__tests__/`
- Filesystem access is backed by an in-memory `expo-file-system` mock defined in
  `jest.setup.js` and reachable as `globalThis.mockFileSystem` (seed
  `.files`/`.dirs`, stub `.downloadFileAsync`, `.reset()` per test). Prefer it
  over stubbing individual calls so the real `src/utils/fs.ts` logic runs.
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

The server at `localhost:8080` serves the API. Vite is configured with a proxy to forward API calls during development. Note: `run-server` sets `JOT_PASSWORD_MIN_LENGTH=4` for local convenience — do not use this in production.

To serve the built SPA from the Go binary instead of Vite, run `task build-webapp` first; the server reads `webapp/build/` (override with `JOT_STATIC_DIR`).

### Toolchain and no-`task` fallbacks

Setup is `./scripts/bootstrap.sh` (see [Environment Setup](#environment-setup)); the notes below are what it checks and what to fall back to.

- **Go 1.26** (`go.mod`), **Node 24** (`.nvmrc`, Dockerfile, CI). Older Go works only via toolchain auto-download; older Node is untested. Bootstrap warns on both but changes neither.
- The SQLite driver is pure Go (`modernc.org/sqlite`) — **no CGO or gcc required**.
- `@jot/shared` is a `file:../shared` dependency of both webapp and mobile. Install its deps before theirs. Use `npm ci`, not `npm install`.

If `task` isn't available, these are the underlying commands:

| Task | Equivalent |
|------|-----------|
| `task run-server` | `cd server && go build -buildvcs=false -o jot . && JOT_COOKIE_SECURE=false JOT_PASSWORD_MIN_LENGTH=4 JOT_CORS_ALLOWED_ORIGIN=http://localhost:5173 ./jot` |
| `task test-server` | `cd server && go test ./...` |
| `task lint-server` | `cd server && go tool golangci-lint run` |
| `task test-webapp` | `cd webapp && npm run test:run` |
| `task lint-webapp` | `cd webapp && npm run lint && npm run lint:ts` |
| `task test-e2e` | `cd webapp && npm run test:e2e` |
| `task test-mobile` | `cd mobile && npm test -- --ci` |
| `task build-webapp` | `cd webapp && npm run build` |
| `task fmt-server` | `cd server && go tool golangci-lint fmt` |
| `task fmt-webapp` | `cd webapp && npm run lint -- --fix --fix-type layout` (same in `shared/`, `mobile/`) |
| `task gen-docs` | `cd server && go tool swag init --generalInfo main.go --output docs --parseDependency --parseInternal` |
| `task check-migrations` | `./scripts/check-migrations.sh` |

`JOT_COOKIE_SECURE=false` is required for non-HTTPS local development — session
cookies are `Secure` by default and the browser will drop them over
`http://localhost`, which looks like a broken login rather than a config
problem. Note the `JOT_` prefix: all app config is `JOT_`-prefixed, and an
unprefixed `COOKIE_SECURE=false` is silently ignored.

### Docker (Production)

Multi-stage `Dockerfile`:
1. **Node 24 Alpine** — builds the React app (`npm ci && npm run build`)
2. **Go 1.26 Alpine** — compiles the Go binary (pure Go, no CGO)
3. **Alpine runtime** — copies binary and frontend build; exposes port 8080

```bash
docker compose up -d
```

Persistent data is mounted at `/data` (default `docker-compose.yml` maps host `./data` to `/data`).

**Workflow pinning policy:** In GitHub Actions workflows, pin every external action `uses:` reference (`owner/repo@...`) to a full commit SHA and add an inline comment with the intended major version tag (for example, `# v6`). Do not use floating action refs such as `@v4`, `@v6`, `@main`, or `@latest`. The
`update-github-actions` command covers re-pinning them; `update-docker-deps` covers the
image side of the build.

**Base image pinning policy:** Pin every image Jot *builds on* to a digest, keeping the
readable tag in the reference: `FROM alpine:3.24@sha256:...`. This covers all three
`Dockerfile` stages and container images referenced from workflows (the Postgres service
in `server-ci.yml`). A bare tag like `alpine:3.24` is republished on every patch release,
so two builds of the same commit can produce different images. The exception is
`docker-compose.yml`'s `hanzei/jot:latest` — that is Jot's own published image and is
meant to float, since pinning it would freeze users on one release.

Pin the digest of the **manifest index**, not of a single-platform manifest — images are
built for `linux/amd64` and `linux/arm64`, and a platform-specific digest resolves on one
leg of the matrix while failing on the other. Digests do not update themselves; the
`update-docker-deps` command owns re-resolving them, and that is the only thing that pulls
in base-image security patches.

### CI Checklist (before opening a PR)

1. `task check` — everything CI enforces except e2e: lint, all tests, the
   Swagger-docs freshness check, the migration-parity check, and the
   translation check.
2. `task test-e2e` — Playwright e2e tests (**not** part of `task check`; add
   new e2e tests for any new user-facing feature).

That is the whole list, and neither step is conditional. `task check` used to
be lint + tests only, with the other three gates written up here as "run this
one if you touched that" — which is exactly the kind of judgment call that gets
skipped, and each miss cost a full CI round trip to discover. They are now part
of the gate and add about eight seconds to it.

If `task check` fails on a gate you did not expect to touch:

- **`check-docs`** — `server/docs/` is generated from the handler annotations
  by `task gen-docs`, which the check already ran for you. Commit the result.
- **`check-migrations`** — a migration exists in one dialect tree and not the
  other, or two share a version number. See
  [Database Migrations](#database-migrations); the error names the files.
- **`check-translations`** — a locale file has keys `en.json` does not.
  A *missing* key is caught earlier, by `tsc` in `lint-webapp`; this gate is
  what catches stale extra keys and drift in the mobile locales.

While iterating, use the scoped tasks (`task check-server`, `task test-server -- -run TestX`) and save the full gate for just before pushing.
