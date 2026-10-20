package models

import (
	"testing"

	"github.com/hanzei/jot/server/internal/database/dbtest"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// unreadFor returns the note's unread state for userID, "" when there is none.
func unreadFor(t *testing.T, store *noteStore, noteID, userID string) NoteUnread {
	t.Helper()
	n, err := store.GetByID(t.Context(), noteID, userID)
	require.NoError(t, err)
	if n.Unread == nil {
		return ""
	}
	return *n.Unread
}

// TestNoteUnreadState covers the noteUnreadExpr rule and the writers that feed
// it on both backends; the HTTP-level matrix lives in http_note_unread_test.go.
func TestNoteUnreadState(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		store, ownerID := newTestBulkStore(t, driver)
		ctx := t.Context()
		const collabID = "user00000000000000collab"
		_, err := store.db.ExecContext(ctx,
			store.d.RewritePlaceholders(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`),
			collabID, "collab", "x")
		require.NoError(t, err)

		note, err := store.Create(ctx, ownerID, "", "", "hello", NoteTypeText, DefaultNoteColor)
		require.NoError(t, err)
		assert.Nil(t, note.Unread)

		require.NoError(t, store.ShareNote(ctx, note.ID, ownerID, collabID))
		assert.Equal(t, NoteUnreadNew, unreadFor(t, store, note.ID, collabID))
		assert.Empty(t, unreadFor(t, store, note.ID, ownerID))

		wasUnread, err := store.MarkViewed(ctx, note.ID, collabID)
		require.NoError(t, err)
		assert.True(t, wasUnread)
		assert.Empty(t, unreadFor(t, store, note.ID, collabID))

		wasUnread, err = store.MarkViewed(ctx, note.ID, collabID)
		require.NoError(t, err)
		assert.False(t, wasUnread, "a second view changes nothing")

		// The owner never reopened the note since creating it: their baseline is
		// the per-user row's created_at.
		content := "edited by collab"
		require.NoError(t, store.Update(ctx, note.ID, collabID, nil, &content, nil, nil, nil, nil, nil))
		assert.Equal(t, NoteUnreadUpdated, unreadFor(t, store, note.ID, ownerID))
		assert.Empty(t, unreadFor(t, store, note.ID, collabID))

		content = "edited by owner"
		require.NoError(t, store.Update(ctx, note.ID, ownerID, nil, &content, nil, nil, nil, nil, nil))
		assert.Empty(t, unreadFor(t, store, note.ID, ownerID), "the actor's own change clears it for them")
		assert.Equal(t, NoteUnreadUpdated, unreadFor(t, store, note.ID, collabID))

		notes, err := store.GetByUserID(ctx, collabID, false, false, "", "", false)
		require.NoError(t, err)
		require.Len(t, notes, 1)
		require.NotNil(t, notes[0].Unread)
		assert.Equal(t, NoteUnreadUpdated, *notes[0].Unread)

		_, err = store.MarkViewed(ctx, "abcdefghijklmnopqrstuv", collabID)
		require.ErrorIs(t, err, ErrNoteNotFound)

		// Item changes are recorded in the item write's own transaction, and
		// only when something actually changed.
		_, err = store.MarkViewed(ctx, note.ID, ownerID)
		require.NoError(t, err)
		_, err = store.SetItemsCompleted(ctx, note.ID, collabID, []string{"doesnotexist1234567890"}, true)
		require.NoError(t, err)
		assert.Empty(t, unreadFor(t, store, note.ID, ownerID), "a no-op item write changes nothing")
		_, err = store.CreateItemWithID(ctx, note.ID, collabID, "item000000000000000001", "x", 0, false, "", "", 0)
		require.NoError(t, err)
		assert.Equal(t, NoteUnreadUpdated, unreadFor(t, store, note.ID, ownerID))

		// A trashed note never shows a badge: the bin cannot clear one.
		_, err = store.db.ExecContext(ctx, store.d.RewritePlaceholders(`UPDATE notes SET deleted_at = ? WHERE id = ?`), Timestamp(Now()), note.ID)
		require.NoError(t, err)
		trashed, err := store.GetByIDAnyState(ctx, note.ID, ownerID)
		require.NoError(t, err)
		assert.Nil(t, trashed.Unread)
	})
}
