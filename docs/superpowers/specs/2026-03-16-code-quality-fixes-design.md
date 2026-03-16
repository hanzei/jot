# Code Quality Fixes: active_notes View + UNIQUE Constraint Detection

Date: 2026-03-16

## Summary

Two targeted improvements to the Go server:

1. **UNIQUE constraint detection** (issue 4) — move SQLite error translation into the model layer so handlers use `errors.Is` instead of fragile string matching.
2. **`active_notes` view** (issue 3) — introduce a SQLite view that encodes `deleted_at IS NULL` once, making trashed-note filtering the safe default.

---

## Issue 4: UNIQUE Constraint Detection

### Problem

`UserStore.Create` and `UserStore.CreateByAdmin` wrap the raw SQLite error without translating it:

```go
return nil, fmt.Errorf("failed to create user: %w", err)
```

Callers (`handlers/auth.go`, `handlers/admin.go`) fall back to:

```go
if strings.Contains(err.Error(), "UNIQUE constraint failed") { ... }
```

This is fragile: it depends on SQLite's error message text and can silently break if the message changes or the error is wrapped differently.

### Fix

Apply the same pattern already used in `UserStore.UpdateUsername`:

```go
var sqliteErr sqlite3.Error
if errors.As(err, &sqliteErr) && sqliteErr.ExtendedCode == sqlite3.ErrConstraintUnique {
    return nil, ErrUsernameTaken
}
```

Add this check to both `Create` and `CreateByAdmin`. Handlers then use:

```go
if errors.Is(err, models.ErrUsernameTaken) { ... }
```

The `strings` import can be removed from both handler files (it is not used elsewhere in either file).

`admin.go CreateUser` currently returns the wrapped store error (`err`) as the HTTP response body on conflict. After the fix, update it to return `models.ErrUsernameTaken` directly (consistent with `Register` returning a fresh `errors.New("username already taken")`).

### Files Changed

- `server/internal/models/user.go` — `Create`, `CreateByAdmin`
- `server/internal/handlers/auth.go` — `Register`
- `server/internal/handlers/admin.go` — `CreateUser`

---

## Issue 3: `active_notes` View

### Problem

`deleted_at IS NULL` is repeated across ~10 queries in `note.go`. Omitting it in any new or modified query silently leaks trashed notes. The current approach requires every query author to remember the filter.

### Fix

Add a SQLite view as migration `015`:

```sql
CREATE VIEW active_notes AS
    SELECT * FROM notes WHERE deleted_at IS NULL;
```

Queries that should never see trashed notes use `FROM active_notes` (no `deleted_at` filter needed). Queries that are explicitly trash-aware continue using `FROM notes`.

### Queries to migrate to `active_notes`

| Location | Query / purpose |
|---|---|
| `buildGetByUserIDQuery` — `MyTodos` branch | `FROM notes n INNER JOIN note_items … LEFT JOIN note_shares … WHERE … AND n.deleted_at IS NULL` |
| `buildGetByUserIDQuery` — default branch | `FROM notes n LEFT JOIN note_shares … WHERE … AND n.deleted_at IS NULL` |
| `GetByID` | `FROM notes WHERE id = ? AND deleted_at IS NULL` |
| `Update` — max-position queries (×2) | `FROM notes WHERE … AND deleted_at IS NULL` (pinning and unpinning paths) |
| `HasAccess` — owner branch | First UNION branch: `FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL` → rewrite as `FROM active_notes WHERE id = ? AND user_id = ?` |
| `HasAccess` — share branch | Second UNION ALL branch: replace `AND (SELECT deleted_at FROM notes WHERE id = ?) IS NULL` with `AND EXISTS (SELECT 1 FROM active_notes WHERE id = ?)` in the WHERE clause, keeping `SELECT COUNT(*) FROM note_shares …` intact. This removes one bind parameter — the `s.db.Query` call argument list must be updated from 5 args (`noteID, userID, noteID, userID, noteID`) to 4 args (`noteID, userID, noteID, userID`). |

### Queries that stay on `FROM notes`

- `GetByUserID` with `Trashed` filter — explicitly queries `deleted_at IS NOT NULL`
- `MoveToTrash` — WHERE clause matches `deleted_at IS NULL` to guard against double-trash; stays on `notes`
- `RestoreFromTrash` — main UPDATE matches `deleted_at IS NOT NULL`; position-shift subquery uses `deleted_at IS NULL` to find active notes to shift — stays on `notes` because the function is explicitly trash-aware
- `Create` — position-shift UPDATE statement; SQLite views are not updatable, so `UPDATE notes … AND deleted_at IS NULL` must remain as-is
- `Update` — position-shift UPDATE statement; same reason as `Create`
- `DeleteFromTrash` — matches `deleted_at IS NOT NULL`
- `PurgeOldTrashedNotes` — matches `deleted_at IS NOT NULL AND deleted_at < ?`

### Files Changed

- `server/internal/database/migrations/015_active_notes_view.sql` — new migration
- `server/internal/models/note.go` — update queries listed above

---

## Testing

- Existing server integration tests cover note listing, trash, restore, and hard delete — no new tests needed for the view (it's a transparent alias).
- After applying the view, run `task test-server` to confirm no regressions.
- For the constraint fix, `http_integration_test.go` already tests duplicate username registration — confirm it still returns 409.

---

## Out of Scope

- Issue 1 (profile icon upload size) — already fully protected by `MaxBytesReader`, `image.DecodeConfig` header check, and `maxSourceDimension`/`maxSourcePixels` guards.
- Rate limiting on login/register endpoints.
- Database portability (SQLite-only is intentional).
