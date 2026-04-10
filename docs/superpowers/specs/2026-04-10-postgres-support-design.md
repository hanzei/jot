# PostgreSQL Support Design

**Date:** 2026-04-10  
**Status:** Approved

## Overview

Add PostgreSQL as a supported database backend alongside SQLite. SQLite remains the default. Users select the backend via environment variables. golang-migrate replaces the custom migration runner. Dialect differences in queries are handled via a small helper package.

---

## 1. Configuration

Two new env vars replace `DB_PATH`:

| Env var   | Default    | Values                                      |
|-----------|------------|---------------------------------------------|
| `DB_DRIVER` | `sqlite` | `sqlite` \| `postgres`                    |
| `DB_DSN`    | `./jot.db` | SQLite file path or PostgreSQL DSN        |

`DB_PATH` is accepted as a deprecated alias for `DB_DSN` when `DB_DRIVER=sqlite`, for backward compatibility with existing installations.

**Config struct changes (`server/internal/config/config.go`):**
- Add `DBDriver string`
- Rename `DBPath` → `DBDSN` internally
- `Load()` reads `DB_DRIVER` and `DB_DSN`; falls back to `DB_PATH` for `DB_DSN` if set

---

## 2. Dialect Package

New package: `server/internal/database/dialect`

```go
type Dialect struct {
    Driver string // "sqlite" | "postgres"
}

// RewritePlaceholders converts ? to $1, $2, ... for PostgreSQL. No-op for SQLite.
func (d *Dialect) RewritePlaceholders(query string) string

// InsertIgnore returns dialect-correct INSERT ... ON CONFLICT DO NOTHING SQL.
func (d *Dialect) InsertIgnore(table, cols, placeholders string) string

// CaseInsensitiveEquals returns a dialect-correct case-insensitive equality expression.
// SQLite: LOWER(col) = LOWER(?)   PostgreSQL: col ILIKE ?
func (d *Dialect) CaseInsensitiveEquals(col string) string

// IsUniqueConstraintError checks for unique constraint violations across both drivers.
// SQLite: sqlitedriver.Error code 2067   PostgreSQL: pq.Error code "23505"
func (d *Dialect) IsUniqueConstraintError(err error) bool
```

Each `*Store` type receives a `*dialect.Dialect` at construction. The existing `server/internal/models/sqlite_error.go` is deleted and replaced by `dialect.IsUniqueConstraintError`.

All query strings pass through `d.RewritePlaceholders(query)` before execution. For SQLite this is a no-op; for PostgreSQL it rewrites positional placeholders.

---

## 3. Migration System

### Tooling

Replace the custom migration runner in `server/internal/database/database.go` with [golang-migrate](https://github.com/golang-migrate/migrate).

### File Layout

```
server/internal/database/migrations/
  sqlite/
    000001_initial_schema.up.sql
    000002_personal_access_tokens.up.sql
    000003_rename_note_type_todo_to_list.up.sql
    000004_drop_notes_check_constraint.up.sql
  postgres/
    000001_initial_schema.up.sql
    000002_personal_access_tokens.up.sql
    000003_rename_note_type_todo_to_list.up.sql
```

Both directories are embedded into the binary via `embed.FS`. Down migrations are out of scope.

### Migration content changes

**000001_initial_schema:**
- **SQLite:** No `CHECK` constraint on `notes.type`; `INTEGER PRIMARY KEY AUTOINCREMENT`; `BLOB` for profile icon
- **PostgreSQL:** `CHECK (type IN ('note', 'list'))` retained; `BIGSERIAL PRIMARY KEY`; `BYTEA` for profile icon

**000003_rename_note_type_todo_to_list:**
- **Both dialects:** Simplified to `UPDATE notes SET type = 'list' WHERE type = 'todo';` — no table recreation required

**000004_drop_notes_check_constraint (SQLite only):**
- Recreates the `notes` table without the `CHECK` constraint, migrating all existing data
- Ensures schema consistency between old installations (which have the constraint from 001) and new ones (which never got it)
- PostgreSQL does not have this migration — its `CHECK` constraint is retained as-is

### Startup

`database.New()`:
1. Determines driver from config
2. Applies SQLite-only settings when driver is `sqlite`: `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON`, `SetMaxOpenConns(1)`
3. Runs golang-migrate against the correct embedded directory (`sqlite/` or `postgres/`)
4. Returns `*sql.DB`

---

## 4. Query Layer Changes

### INSERT OR IGNORE (4 call sites)

Replace with `d.InsertIgnore(...)`:

- `server/internal/models/note_store.go` — 3 occurrences (note_labels, note_user_state)
- `server/internal/models/note_share.go` — 1 occurrence

### COLLATE NOCASE (label names)

`COLLATE NOCASE` is removed from the PostgreSQL migration 001. Label name lookups that require case-insensitive matching use `d.CaseInsensitiveEquals("name")`:

- `server/internal/models/label.go` — `GetOrCreateLabel()` and related functions

### Unique constraint error handling

All call sites currently using `isUniqueConstraintError(err)` switch to `d.IsUniqueConstraintError(err)`:

- `server/internal/models/user.go` — 4 call sites
- `server/internal/models/label.go` — 1 call site
- `server/internal/models/note_share.go` — 1 call site

`server/internal/models/sqlite_error.go` is deleted.

### BLOB / BYTEA and AUTOINCREMENT / SERIAL

Migration-only changes; no Go code affected.

### PRAGMAs

Already handled in `database.New()` (Section 3); no store-layer changes needed.

---

## 5. Testing

**Dialect package unit tests** (`server/internal/database/dialect/dialect_test.go`):
- `RewritePlaceholders` — verifies `?` → `$1, $2, ...` conversion for PostgreSQL, no-op for SQLite
- `InsertIgnore` — verifies correct SQL for each driver
- `CaseInsensitiveEquals` — verifies correct expression per driver
- `IsUniqueConstraintError` — verifies correct error detection per driver

**Integration tests** — existing tests (`http_integration_test.go` etc.) continue to use a temporary SQLite database. No PostgreSQL integration tests are added now; that requires CI infrastructure changes (a running Postgres instance) which is a separate concern.

**Manual verification** — the upgrade SQL command (see Section 6) is verified against a test SQLite database before shipping.

---

## 6. Upgrade Path for Existing Installations

Existing installations have migrations 1–3 already applied via the old custom runner. golang-migrate tracks state in a `schema_migrations` table that does not yet exist on these databases.

Before upgrading, users must run the following against their SQLite database:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
    version bigint NOT NULL PRIMARY KEY,
    dirty   boolean NOT NULL
);
INSERT INTO schema_migrations (version, dirty) VALUES (3, false);
```

This seeds golang-migrate's state so it knows migrations 1–3 are already applied. On next startup, only migration 4 (dropping the `CHECK` constraint) will run.

This command must be documented in the release notes for the version that ships this change.

---

## Out of Scope

- Down migrations
- PostgreSQL integration tests in CI
- Connection pooling configuration (PostgreSQL defaults are acceptable for now)
- Any ORM or query builder adoption
