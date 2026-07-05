package models

import (
	"testing"

	"github.com/hanzei/jot/server/internal/database"
	"github.com/hanzei/jot/server/internal/database/dialect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newTestConvertStore opens a fresh migrated SQLite database and returns a
// noteStore bound to it, along with an owning user ID.
func newTestConvertStore(t *testing.T) (*noteStore, string) {
	t.Helper()

	dsn := t.TempDir() + "/note_convert.db"
	db, err := database.New("sqlite", dsn)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	d := &dialect.Dialect{Driver: "sqlite"}
	store := newNoteStore(db, d)

	ctx := t.Context()
	_, err = db.ExecContext(ctx, `INSERT INTO users (id, username, password_hash) VALUES ('user000000000000convert', 'convertowner', 'x')`)
	require.NoError(t, err)

	return store, "user000000000000convert"
}

// TestConvertTypeVersionConflict covers convertNoteRowTx's idempotent-replay
// check on a version-guard mismatch: it must compare the actual re-read
// content/items against what this caller intended to write, not just the
// note's type, so a differently-timed concurrent conversion to the same
// target type isn't mistaken for this caller's own result.
func TestConvertTypeVersionConflict(t *testing.T) {
	ptrInt := func(i int) *int { return &i }
	ptrString := func(s string) *string { return &s }

	t.Run("rejects a stale conversion whose intended result no longer matches a concurrent conversion", func(t *testing.T) {
		store, userID := newTestConvertStore(t)
		ctx := t.Context()

		note, err := store.Create(ctx, userID, "", "", "Alpha", NoteTypeText, DefaultNoteColor)
		require.NoError(t, err)
		staleVersion := note.Version

		// Someone else edits the content and converts it to a list first, based
		// on the newer content — landing at a later version with different items.
		err = store.Update(ctx, note.ID, userID, nil, ptrString("Beta"), nil, nil, nil, nil, nil)
		require.NoError(t, err)
		winner, err := store.ConvertType(ctx, note.ID, userID, NoteTypeList, "", []NewNoteItem{{Text: "Beta"}}, nil)
		require.NoError(t, err)
		require.Equal(t, NoteTypeList, winner.NoteType)

		// Client A's stale request now lands: same target type as the winner,
		// but items derived from the old "Alpha" content. It must be rejected,
		// not silently reported as successful just because the type matches.
		_, err = store.ConvertType(ctx, note.ID, userID, NoteTypeList, "", []NewNoteItem{{Text: "Alpha"}}, ptrInt(staleVersion))
		require.ErrorIs(t, err, ErrNoteVersionConflict)

		// The winning conversion must survive untouched.
		reloaded, err := store.GetByID(ctx, note.ID, userID)
		require.NoError(t, err)
		require.Len(t, reloaded.Items, 1)
		assert.Equal(t, "Beta", reloaded.Items[0].Text)
	})

	t.Run("treats a stale replay as an idempotent success when the result already matches", func(t *testing.T) {
		store, userID := newTestConvertStore(t)
		ctx := t.Context()

		note, err := store.Create(ctx, userID, "", "", "Alpha", NoteTypeText, DefaultNoteColor)
		require.NoError(t, err)
		staleVersion := ptrInt(note.Version)
		items := []NewNoteItem{{Text: "Alpha"}}

		// The conversion commits once...
		first, err := store.ConvertType(ctx, note.ID, userID, NoteTypeList, "", items, staleVersion)
		require.NoError(t, err)
		require.Equal(t, NoteTypeList, first.NoteType)

		// ...and a replay with the same stale base_version and the same intended
		// result (e.g. a client retrying after losing the first response) must
		// succeed rather than conflict.
		second, err := store.ConvertType(ctx, note.ID, userID, NoteTypeList, "", items, staleVersion)
		require.NoError(t, err)
		assert.Equal(t, NoteTypeList, second.NoteType)
		require.Len(t, second.Items, 1)
		assert.Equal(t, "Alpha", second.Items[0].Text)
	})
}
