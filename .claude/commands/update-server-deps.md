---
description: Update Go dependencies in server/ — module upgrades, go.mod tool directives (golangci-lint, swag), and the Go toolchain version.
---

# Update server (Go) dependencies

`server/` is a single Go module (`github.com/hanzei/jot/server`) that also carries
its linter and doc generator as `tool` directives. That makes a naive `go get -u ./...`
misleading: it leaves the tools stale and hides a few coupled version families that
must move together. Work in small, verifiable batches so any regression is trivially
bisectable.

## Before you start

Work on a feature branch — never `master` (see root `CLAUDE.md`). Confirm the tree is
clean so `git diff` stays meaningful as a review aid:

```bash
git status --short
git checkout -b chore/update-server-deps   # or the branch you were told to use
```

## 1. Survey what's available

Only direct requires are worth reasoning about; the ~250 indirect entries in `go.mod`
are almost entirely golangci-lint's transitive tree and move on their own.

```bash
cd server
go list -m -u -f '{{if and .Update (not .Indirect)}}{{.Path}}: {{.Version}} -> {{.Update.Version}}{{end}}' all
```

Sort what you find into three buckets, because each has a different risk profile:

- **Patch/minor on leaf libraries** (chi, cors, httprate, logrus, testify, cobra, lib/pq,
  golang.org/x/*) — safe to batch together.
- **Coupled version families** — see below. Bump the whole family or not at all.
- **Majors and infrastructure** (modernc.org/sqlite, golang-migrate, grpc,
  modelcontextprotocol/go-sdk) — one per commit, with its changelog read first.

### Coupled families

**OpenTelemetry** is the big one. `go.opentelemetry.io/otel*` modules are released as a
set with three parallel version lines that must stay consistent with each other:

| Line | Current | Modules |
|---|---|---|
| Stable | `v1.44.0` | `otel`, `otel/trace`, `otel/metric`, `otel/sdk`, `exporters/otlp/otlp{trace,metric}*`, `exporters/stdout/stdouttrace` |
| Experimental log | `v0.20.0` | `otel/log`, `otel/sdk/log`, `exporters/otlp/otlplog/*`, `exporters/stdout/stdoutlog` |
| Prometheus exporter | `v0.66.0` | `exporters/prometheus` |
| Contrib | `v0.19.0` / `v0.69.0` | `contrib/bridges/otellogrus`, `contrib/instrumentation/*` |

Mixing lines (e.g. stable `1.45` with a log exporter still on the `1.44`-era `0.20`)
compiles but panics or silently drops signals at runtime. Bump every OTel module in one
`go get` invocation and check the release notes for the matching contrib release.

**modernc.org/sqlite** is the production database driver — a bad bump breaks every
install. Treat it as its own commit and make sure `task test-server` covers it (it does;
the integration tests run against real SQLite files).

## 2. Apply updates in batches

```bash
# Batch 1 — leaf libraries, patch/minor
go get -u github.com/go-chi/chi/v5 github.com/sirupsen/logrus github.com/stretchr/testify
go mod tidy

# Batch 2 — the whole OTel set in one shot
go get -u go.opentelemetry.io/otel@vX.Y.Z go.opentelemetry.io/otel/sdk@vX.Y.Z ...
go mod tidy
```

`go get -u=patch ./...` is a reasonable shortcut when you only want patch releases across
the board. Avoid a blanket `go get -u ./...` unless you have already read the changelogs —
it happily pulls minor versions of grpc and the OTel SDK in the same commit as a logrus
patch, and then you cannot tell which bump broke the build.

Verify after **each** batch, not just at the end:

```bash
go build ./... && task test-server && task lint-server
```

## 3. Update the pinned tools

`golangci-lint` and `swag` live in the `tool (...)` block of `go.mod`. `go get -u ./...`
does **not** touch them, because no package imports them.

```bash
go get -u tool     # upgrades every module in the tool block
go mod tidy
```

If your Go version rejects the `tool` meta-pattern, name the modules explicitly:
`go get -u github.com/golangci/golangci-lint/v2 github.com/swaggo/swag`.

Two things reliably break here — expect them rather than being surprised:

- **golangci-lint minor bumps enable new linters and occasionally change the config
  schema.** The config lives at the repo root (`.golangci.yml`), not in `server/`. Run
  `task lint-server` and fix genuine findings in code. Only touch `.golangci.yml` when a
  key was renamed or a linter was removed upstream; disabling a linter to make the build
  pass is a decision to raise with the user, not to make silently.
- **swag bumps change generated output.** Regenerate and commit the result, because CI
  fails on any drift (`git diff --exit-code server/docs/`):

  ```bash
  task gen-docs
  git diff --stat docs/          # pathspec is relative to CWD; you are in server/
  ```

  Read that diff. Pure formatting churn is fine; a disappeared endpoint or a mangled
  schema means the new swag version parses an annotation differently and needs a fix in
  the handler comments.

## 4. Go toolchain version (only when explicitly asked)

The Go version is declared in more places than `go.mod`, and they must not drift:

- `server/go.mod` — `go 1.27.0`
- `Dockerfile` — `FROM golang:1.27-alpine`
- `README.md` prerequisites and `CLAUDE.md`

Update all of them in the same commit. A `go.mod` ahead of the Docker builder produces a
confusing "go.mod requires go >= X" failure that only shows up in the image build. The
workflows need nothing: every `setup-go` step resolves the version through
`go-version-file: server/go.mod`, so CI follows the bump on its own.

## 5. Verify

```bash
cd server
go build ./...
task build-jotctl        # the CLI has its own main; it can break independently
task test-server
task lint-server
task gen-docs && git diff --exit-code docs/
```

Note the pathspec: git resolves it relative to the current directory, so from `server/` it
must be `docs/`. Writing `server/docs/` there fails with a `fatal: ambiguous argument`
instead of checking anything. CI runs the equivalent `git diff --exit-code server/docs/`
from the repository root, so both point at the same generated directory.

Optional but cheap and worth doing when the point of the update was security:

```bash
go run golang.org/x/vuln/cmd/govulncheck@latest ./...
```

If the store or migration layer moved (sqlite driver, golang-migrate, lib/pq), also run
the Postgres path — those tests are skipped by default and are exactly the ones a driver
bump breaks:

```bash
TEST_POSTGRES_DSN='postgres://...' task test-server
```

## 6. Commit and describe

One commit per batch, with the versions in the message so `git log` is a usable upgrade
history:

```text
chore(server): update OpenTelemetry to v1.45.0 / v0.21.0
```

In the PR description, list every direct dependency that moved with old → new versions,
call out majors separately with what changed, and note any code you had to adapt. If a
bump changes runtime behaviour for existing installations (database driver, migration
library, session/crypto libraries), say so explicitly with upgrade guidance — root
`CLAUDE.md` requires that for anything affecting existing installs.

Leave anything you deliberately held back in the description too ("stayed on grpc v1.81,
v1.82 requires Go 1.27") so the next person doesn't re-derive it.
