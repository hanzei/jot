package models

import (
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
			// deleted_at is written by the database, not by Go.
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

			// created_at comes from the database default, expires_at from Go.
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
