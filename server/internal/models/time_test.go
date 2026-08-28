package models

import (
	"database/sql"
	"testing"
	"time"

	"github.com/hanzei/jot/server/internal/database/dbtest"
	"github.com/hanzei/jot/server/internal/database/dialect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// nonUTCTimeZone is deliberately behind UTC. A backend that resolved
// CURRENT_TIMESTAMP in it would stamp rows several hours in the past, which is
// the direction that makes cutoff comparisons purge or expire things early.
const nonUTCTimeZone = "America/New_York"

func TestNow(t *testing.T) {
	assert.Equal(t, time.UTC, Now().Location())
}

// TestTimestampCutoffsIgnoreDatabaseTimeZone runs the two cutoff comparisons
// that mix a database-written timestamp with a Go-computed one — trash purge
// and session expiry — against a database whose own time zone is not UTC.
// Both must behave exactly as they do under UTC: the application writes UTC
// (models.Now) and pins its PostgreSQL sessions to UTC, so the database's
// configured zone must not reach the stored values.
func TestTimestampCutoffsIgnoreDatabaseTimeZone(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		db := dbtest.NewInTimeZone(t, driver, nonUTCTimeZone)
		d := &dialect.Dialect{Driver: driver}
		ctx := t.Context()

		_, err := db.ExecContext(ctx,
			d.RewritePlaceholders(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`),
			"user000000000000000utc", "utc", "x")
		require.NoError(t, err)

		t.Run("a note trashed just now survives a purge with an older cutoff", func(t *testing.T) {
			store := newNoteStore(db, d)

			note, err := store.CreateWithItems(ctx, "user000000000000000utc", "", "Fresh", "", NoteTypeText, DefaultNoteColor, nil)
			require.NoError(t, err)
			// deleted_at is generated in Go, like every other timestamp the
			// store layer writes.
			require.NoError(t, store.MoveToTrash(ctx, note.ID, "user000000000000000utc"))

			_, err = store.PurgeOldTrashedNotes(ctx, time.Hour)
			require.NoError(t, err)

			_, err = store.GetByIDAnyState(ctx, note.ID, "user000000000000000utc")
			assert.NoError(t, err, "a note trashed seconds ago is not an hour old")
		})

		t.Run("a note trashed long enough ago is purged", func(t *testing.T) {
			store := newNoteStore(db, d)

			note, err := store.CreateWithItems(ctx, "user000000000000000utc", "", "Stale", "", NoteTypeText, DefaultNoteColor, nil)
			require.NoError(t, err)
			require.NoError(t, store.MoveToTrash(ctx, note.ID, "user000000000000000utc"))

			_, err = db.ExecContext(ctx, d.RewritePlaceholders(`UPDATE notes SET deleted_at = ? WHERE id = ?`),
				Now().Add(-48*time.Hour), note.ID)
			require.NoError(t, err)

			_, err = store.PurgeOldTrashedNotes(ctx, 24*time.Hour)
			require.NoError(t, err)

			_, err = store.GetByIDAnyState(ctx, note.ID, "user000000000000000utc")
			assert.ErrorIs(t, err, ErrNoteNotFound)
		})

		t.Run("a session created just now is neither expired nor cleaned up", func(t *testing.T) {
			store, err := newSessionStore(db, d)
			require.NoError(t, err)

			// created_at and expires_at both come from Go.
			session, rawToken, err := store.Create(ctx, "user000000000000000utc", "test-agent")
			require.NoError(t, err)
			assert.WithinDuration(t, Now().Add(SessionDuration), session.ExpiresAt, time.Minute)

			require.NoError(t, store.DeleteExpired(ctx))

			found, err := store.GetByToken(ctx, rawToken)
			require.NoError(t, err)
			assert.Equal(t, session.TokenHash, found.TokenHash)
			assert.WithinDuration(t, Now(), found.CreatedAt, time.Minute,
				"created_at must be a UTC wall clock, whatever time zone the database runs in")
		})

		t.Run("an expired session is not returned and is cleaned up", func(t *testing.T) {
			store, err := newSessionStore(db, d)
			require.NoError(t, err)

			_, rawToken, err := store.Create(ctx, "user000000000000000utc", "expired-agent")
			require.NoError(t, err)

			_, err = db.ExecContext(ctx, d.RewritePlaceholders(`UPDATE sessions SET expires_at = ? WHERE token_hash = ?`),
				Now().Add(-time.Hour), HashSessionToken(rawToken))
			require.NoError(t, err)

			_, err = store.GetByToken(ctx, rawToken)
			require.ErrorIs(t, err, ErrSessionNotFoundOrExpired)

			require.NoError(t, store.DeleteExpired(ctx))

			var remaining int
			require.NoError(t, db.QueryRowContext(ctx,
				d.RewritePlaceholders(`SELECT COUNT(*) FROM sessions WHERE token_hash = ?`),
				HashSessionToken(rawToken)).Scan(&remaining))
			assert.Zero(t, remaining)
		})
	})
}

func TestTimestamp(t *testing.T) {
	t.Run("renders microseconds, the finest resolution both backends store", func(t *testing.T) {
		ts := time.Date(2026, 7, 30, 14, 35, 26, 123456789, time.UTC)
		assert.Equal(t, "2026-07-30 14:35:26.123456", Timestamp(ts))
	})

	t.Run("converts to UTC rather than storing a local wall clock", func(t *testing.T) {
		ts := time.Date(2026, 7, 30, 14, 35, 26, 0, time.FixedZone("EST", -5*60*60))
		assert.Equal(t, "2026-07-30 19:35:26.000000", Timestamp(ts))
	})

	t.Run("round-trips a value from Now without losing digits", func(t *testing.T) {
		now := Now()
		parsed, err := time.Parse(timestampLayout, Timestamp(now))
		require.NoError(t, err)
		assert.True(t, now.Equal(parsed), "%s != %s", now, parsed)
	})
}

// TestStoreTimestampsHaveSubSecondPrecision is the regression test for the
// SQLite half of #776: CURRENT_TIMESTAMP there is whole seconds, so two edits
// in the same second stamped identical updated_at values and any ordering by
// updated_at tied — on PostgreSQL, whose CURRENT_TIMESTAMP is microseconds, the
// same two edits ordered correctly.
//
// Both assertions fail under the old behavior: two quick updates landed either
// in the same second (identical) or across a boundary (exactly one second
// apart). They hold now because Go supplies the value.
func TestStoreTimestampsHaveSubSecondPrecision(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		db := dbtest.New(t, driver)
		d := &dialect.Dialect{Driver: driver}
		ctx := t.Context()
		store := newNoteStore(db, d)
		userID := seedTimestampTestUser(t, db, d)

		note, err := store.CreateWithItems(ctx, userID, "", "Sortable", "", NoteTypeText, DefaultNoteColor, nil)
		require.NoError(t, err)

		first := updatedAtOf(t, db, d, note.ID)
		title := "Edited"
		require.NoError(t, store.Update(ctx, note.ID, userID, &title, nil, nil, nil, nil, nil, nil))
		second := updatedAtOf(t, db, d, note.ID)

		assert.True(t, second.After(first),
			"a second edit must sort after the first, not tie with it: %s vs %s", first, second)
		assert.Less(t, second.Sub(first), time.Second,
			"two back-to-back edits a whole second apart means the value was rounded to seconds")
	})
}

// TestStoreTimestampsAreConstantWithinOneOperation covers the other half of
// #776. PostgreSQL's CURRENT_TIMESTAMP is transaction-constant while SQLite's
// is evaluated per statement, so one note creation could stamp its rows
// identically on one backend and across a second boundary on the other. One
// Timestamp(Now()) per operation removes the difference by construction.
func TestStoreTimestampsAreConstantWithinOneOperation(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		db := dbtest.New(t, driver)
		d := &dialect.Dialect{Driver: driver}
		ctx := t.Context()
		store := newNoteStore(db, d)
		userID := seedTimestampTestUser(t, db, d)

		note, err := store.CreateWithItems(ctx, userID, "", "", "", NoteTypeList, DefaultNoteColor,
			[]NewNoteItem{{Text: "first", Position: 0}, {Text: "second", Position: 1}})
		require.NoError(t, err)

		want := updatedAtOf(t, db, d, note.ID)

		var stateUpdatedAt time.Time
		require.NoError(t, db.QueryRowContext(ctx,
			d.RewritePlaceholders(`SELECT updated_at FROM note_user_state WHERE note_id = ?`), note.ID,
		).Scan(&stateUpdatedAt))
		assert.True(t, want.Equal(stateUpdatedAt),
			"note_user_state must share the note's timestamp: %s vs %s", want, stateUpdatedAt)

		rows, err := db.QueryContext(ctx,
			d.RewritePlaceholders(`SELECT created_at, updated_at FROM note_items WHERE note_id = ? ORDER BY position`), note.ID)
		require.NoError(t, err)
		defer func() { _ = rows.Close() }()

		items := 0
		for rows.Next() {
			var createdAt, updatedAt time.Time
			require.NoError(t, rows.Scan(&createdAt, &updatedAt))
			assert.True(t, want.Equal(createdAt), "item created_at differs from the note's: %s vs %s", want, createdAt)
			assert.True(t, want.Equal(updatedAt), "item updated_at differs from the note's: %s vs %s", want, updatedAt)
			items++
		}
		require.NoError(t, rows.Err())
		assert.Equal(t, 2, items)
	})
}

func seedTimestampTestUser(t *testing.T, db *sql.DB, d *dialect.Dialect) string {
	t.Helper()
	const userID = "user0000000000000stamp"
	_, err := db.ExecContext(t.Context(),
		d.RewritePlaceholders(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`),
		userID, "stamp", "x")
	require.NoError(t, err)
	return userID
}

func updatedAtOf(t *testing.T, db *sql.DB, d *dialect.Dialect, noteID string) time.Time {
	t.Helper()
	var updatedAt time.Time
	require.NoError(t, db.QueryRowContext(t.Context(),
		d.RewritePlaceholders(`SELECT updated_at FROM notes WHERE id = ?`), noteID).Scan(&updatedAt))
	return updatedAt
}
