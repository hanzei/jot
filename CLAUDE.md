# Jot Project Instructions

Jot is a self-hosted note-taking app: a Go API (`server/`) that also serves the
React SPA (`webapp/`), an Expo app (`mobile/`), and `@jot/shared` (`shared/`),
which both clients compile from source. `server/`, `webapp/`, and `mobile/` each
have their own `CLAUDE.md`. Design docs for cross-cutting features (file
attachments, mobile connectivity, deep linking, Markdown rendering) live in
`docs/specs/` — read the relevant one before touching those areas.

## Development Status Notice

- Jot is under heavy initial development. The API is unstable, and API-breaking
  changes are acceptable when needed.
- Call out every API-breaking change in the PR description with expected client
  impact and upgrade guidance.
- Preserve compatibility for existing installations whenever possible (startup
  behavior, migrations, existing data). If a change must break them — including
  a change to what an operator has to back up — call out the impact and
  migration steps explicitly in the PR description.

## Threat Model

- Logged-in users are generally treated as trustworthy collaborators.
- Baseline authentication and authorization remain mandatory (ownership/share
  checks, role checks, normal access boundaries).
- Prioritize protection against unintentional internal overload (accidental
  high-frequency requests, runaway sync loops, expensive repeated operations)
  with practical controls: rate limiting, retry/backoff, loop detection, caps on
  expensive operations.
- Defenses aimed specifically at malicious authenticated insiders are not a
  primary requirement, unless needed to preserve baseline auth/authz.

## Workflow

- Never commit to `master` unless asked; use a feature branch.
- When dev instructions change (build scripts, setup), update `README.md`. When
  functionality changes (endpoints, features, config), update the relevant docs.
- PRs: include screenshots for UI changes and a short video for flows better
  shown in motion; for backend-only changes, say briefly that no visual artifact
  applies.
- `/work-issue` drives a GitHub issue to a draft PR. Commands in
  `.claude/commands/` are started deliberately by a person, never on your own
  initiative.

### Before opening a PR

Run `task check` (lint, all tests, and the `check-docs`, `check-migrations`, and
`check-translations` gates) **and** `task test-e2e`, which `task check` does not
include. Neither is conditional on what you touched. While iterating, prefer the
narrowest task (`task check-server`, `task test-server -- -run TestX`; every
`test-*` task forwards arguments after `--`).

If `check-docs` fails, `task gen-docs` has already regenerated `server/docs/` —
commit the result.

### Code review loop

Only for genuinely large, architecturally significant PRs — a rare exception
(most bug fixes, small features, refactors, and single-area changes do not
qualify). When one does: launch **one** sub-agent that runs both
`/code-review --effort medium` and `/simplify` on all changed files, address
every valid finding, then commit/push. Do not repeat the loop.

## Environment

`scripts/bootstrap.sh` is the single source of truth for setup and already runs
from the `SessionStart` hook, so `task` should work immediately. If `task` is
missing, run `./scripts/bootstrap.sh` rather than working around it with raw
`go test`/`npm run`. New setup steps go in the script, never in the hook or
`shell.nix`.

`golangci-lint` and `swag` are `tool` directives in `server/go.mod`, run via
`go tool` — never `go install` a separate copy.

Local HTTP needs `JOT_COOKIE_SECURE=false` (`task run-server` sets it); without
it the browser drops the `Secure` session cookie and login looks broken. All app
config is `JOT_`-prefixed — an unprefixed variable is silently ignored — and new
config vars follow that convention. The standard `OTEL_*` variables are the
deliberate exception.

For screenshots, `task build-jotctl` then `./server/jotctl dev seed` against a
running `task run-server` populates the full feature surface. `dev seed` and
`dev reset` are development-only; never point them at a real server.

## Formatting

`task fmt` applies formatting everywhere; `lint-*` reports it. TypeScript
enforces exactly two rules, `semi` and single `quotes`. There is deliberately no
Prettier or Biome ([#837](https://github.com/hanzei/jot/issues/837)) and no
line-width or indentation rule: for everything else, match the surrounding file
and do not reformat code you did not otherwise need to touch.

A formatting-only commit goes in `.git-blame-ignore-revs`.

## TypeScript

- The `shared/`, `webapp/`, and `mobile/` tsconfigs carry the same strictness
  set. A flag in one and not another is drift — turn it on everywhere rather than
  recording an exception.
- `noUncheckedIndexedAccess`: use a guard (`?? null`, `if`) when the index can
  genuinely miss; use `!` only when it provably cannot, with the reason visible
  next to it. Prefer `for...of`/`.entries()`/`.map()` where they sidestep the
  question. In tests, `!` is fine.
- `webapp` has three tsconfig projects (`src`, `vite.config.ts`, `e2e/`), and
  `tsc --noEmit` does not follow references. A new tree outside `src` must be
  added both as an invocation in `lint:ts` and to `references`, or it is
  silently unchecked.

### `@jot/shared`: no array destructuring

Mobile's Babel lowers array destructuring (`.map(([id]) => id)`,
`const [a, b] = pair`) to a `@babel/runtime` helper resolved relative to
`shared/`, which has none. Use index access (`entry[0]`) instead. Spread,
`for...of`, and imports are fine. The failure shows up as **every** mobile suite
failing to load, with an error pointing at an unrelated import line — so run
`task test-mobile` after touching `shared/src`, not just `task test-shared`.

Domain types live in `shared/src/types.ts`; do not duplicate them in a client.

## Dependency Updates

**Do not update dependencies by hand** (`go get -u`, `npm update`, editing a
`FROM` or `uses:` line). Each workspace has a command in `.claude/commands/` —
`update-{server,shared,webapp,mobile,docker}-deps` and `update-github-actions` —
that handles couplings which otherwise only break in CI or on a device. Consult
this whenever a dependency update comes up, however it is phrased.

- Full sweep order: **shared → webapp → mobile**; `server/` is independent. When
  Docker is in scope too, run the owning language command first, then
  `update-docker-deps`.
- `expo-doctor` (`task check-mobile-expo`) belongs to `update-mobile-deps` and
  must not be added to CI or any `task check*`: it resolves versions at run
  time, so upstream releases turn green commits red.
- Dependabot version updates cover GitHub Actions only and complement
  `update-github-actions`; keep both. npm, Go, and Docker are kept out of
  `dependabot.yml` on purpose — read the comments at its top before changing
  that.

### Pinning

- Every external action `uses:` is pinned to a full commit SHA with a version
  comment (`# v6`); no floating refs.
- Every base image (all `Dockerfile` stages, workflow service images) is pinned
  as `tag@sha256:...` using the **manifest index** digest, since images build for
  amd64 and arm64. `hanzei/jot:latest` in `docker-compose.yml` is meant to float.

## Server

### Timestamps

Store code generates every timestamp in Go — never `CURRENT_TIMESTAMP` in a
store statement, never `time.Now()`. Bind `models.Timestamp(models.Now())`,
taking one value per logical operation and sharing it across all its statements
(`internal/models/time.go` explains why). A new table with timestamp columns
needs an entry in `timestampColumnsByTable` (`timestamp_columns_test.go`).

### Blob storage

Several rows can share one content-addressed blob, so hard-delete paths must call
`blobstore.ReclaimIfOrphaned`, never `ImageStore.Delete` directly. A backup is
**DB + `JOT_UPLOAD_DIR`**. See `docs/specs/file-attachments.md`.

### API conventions

- The generated spec (`server/docs/swagger.{yaml,json}`) is the API reference —
  do not maintain endpoint tables in docs. Regenerate with `task gen-docs`.
- Resource caps / limits exceeded → **422**; 400 is for malformed input.
- Creates return **201**. `POST /labels` is deliberately get-or-create (clients
  add labels by name; mobile offline replay needs idempotency): 201 when it
  inserted, 200 when it returned an existing label. With a client-supplied ID it
  is a strict create, and a replayed ID is 409.
- `PATCH` for partial updates, `PUT` for replacing a singleton subresource
  (`PUT /admin/users/{id}/role`), `POST` for creates and named actions
  (`/notes/{id}/restore`). `PUT /users/me/password` is a deliberate exception,
  not a precedent.
- Usernames are lower case, enforced by validation rather than a
  case-insensitive index. The client mirror is `shared/src/usernameValidation.ts`;
  change both together. Rows predating the rule are not migrated and must be
  renamed by an admin.

### Database migrations

Two trees, `migrations/sqlite/` and `migrations/postgres/`. **Every schema change
needs a file with the same name in both**; a change only one backend needs still
gets an explanatory placeholder in the other so numbering stays aligned. Postgres
tests skip locally unless `TEST_POSTGRES_DSN` is set, so a sqlite-only migration
passes `task test-server` and fails only in CI. Aim for equivalent behavior, not
identical SQL, and enforce the same invariants on both. Check whether
`internal/database/dialect` needs a matching query-time change.

### Server Tests

- Integration tests are `server/http_<area>_test.go`; build servers with
  `setupTestServer`/`setupTestServerWithConfig`.
- **Every top-level integration test calls `t.Parallel()` first.** Each gets its
  own database, upload dir, server, and logger, so never reintroduce
  process-global mutation in the harness (`logrus.SetOutput`, `os.Setenv`,
  `os.Chdir`). `TestRateLimiting` is the one commented opt-out.
- Subtests share their parent's server; only parallelize them when they touch
  disjoint data.
- Store and migration tests also run against Postgres when `TEST_POSTGRES_DSN`
  is set (`internal/database/dsntest`, `dbtest`); see the README for setup.

## Webapp E2E

- **Every new user-facing feature needs Playwright e2e tests** (`webapp/e2e/`,
  page objects in `e2e/pages/`). No server needs to be running first.
- A fixture destructured but unused (e.g. `authenticatedUser`) is what logs the
  test in; mark it `void authenticatedUser;` rather than deleting it.
