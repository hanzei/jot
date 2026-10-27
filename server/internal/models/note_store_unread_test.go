package models

import (
	"context"
	"database/sql"
	"testing"
	"time"

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

// inTx runs write in a committed transaction on store.
func inTx(ctx context.Context, store *noteStore, write func(tx *sql.Tx) error) error {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err = write(tx); err != nil {
		return err
	}
	return tx.Commit()
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

		note, err := store.Create(ctx, ownerID, NewNote{Content: "hello", Type: NoteTypeText, Color: DefaultNoteColor})
		require.NoError(t, err)
		assert.Nil(t, note.Unread)

		require.NoError(t, store.ShareNote(ctx, note.ID, ownerID, collabID))
		assert.Equal(t, NoteUnreadNew, unreadFor(t, store, note.ID, collabID))
		assert.Empty(t, unreadFor(t, store, note.ID, ownerID))

		wasUnread, err := store.MarkViewed(ctx, note.ID, collabID, Now())
		require.NoError(t, err)
		assert.True(t, wasUnread)
		assert.Empty(t, unreadFor(t, store, note.ID, collabID))

		wasUnread, err = store.MarkViewed(ctx, note.ID, collabID, Now())
		require.NoError(t, err)
		assert.False(t, wasUnread, "a second view changes nothing")

		// The owner never reopened the note since creating it: their baseline is
		// the per-user row's created_at.
		content := "edited by collab"
		_, err = store.Update(ctx, note.ID, collabID, NoteUpdate{Content: &content})
		require.NoError(t, err)
		assert.Equal(t, NoteUnreadUpdated, unreadFor(t, store, note.ID, ownerID))
		assert.Empty(t, unreadFor(t, store, note.ID, collabID))

		content = "edited by owner"
		_, err = store.Update(ctx, note.ID, ownerID, NoteUpdate{Content: &content})
		require.NoError(t, err)
		assert.Empty(t, unreadFor(t, store, note.ID, ownerID), "the actor's own change clears it for them")
		assert.Equal(t, NoteUnreadUpdated, unreadFor(t, store, note.ID, collabID))

		notes, err := store.GetByUserID(ctx, collabID, NoteFilter{})
		require.NoError(t, err)
		require.Len(t, notes, 1)
		require.NotNil(t, notes[0].Unread)
		assert.Equal(t, NoteUnreadUpdated, *notes[0].Unread)

		_, err = store.MarkViewed(ctx, "abcdefghijklmnopqrstuv", collabID, Now())
		require.ErrorIs(t, err, ErrNoteNotFound)

		// Item changes are recorded in the item write's own transaction, and
		// only when something actually changed.
		_, err = store.MarkViewed(ctx, note.ID, ownerID, Now())
		require.NoError(t, err)
		_, err = store.SetItemsCompleted(ctx, note.ID, collabID, []string{"doesnotexist1234567890"}, true)
		require.NoError(t, err)
		assert.Empty(t, unreadFor(t, store, note.ID, ownerID), "a no-op item write changes nothing")
		_, err = store.CreateItemWithID(ctx, note.ID, collabID, "item000000000000000001", "x", 0, false, "", "", 0)
		require.NoError(t, err)
		assert.Equal(t, NoteUnreadUpdated, unreadFor(t, store, note.ID, ownerID))

		// Replayed no-op item writes (an offline client resending a change the
		// server already applied) change nothing, so they flag nothing.
		const itemID = "item000000000000000001"
		_, err = store.MarkViewed(ctx, note.ID, ownerID, Now())
		require.NoError(t, err)
		_, err = store.ToggleItemCompleted(ctx, note.ID, collabID, itemID, false)
		require.NoError(t, err)
		require.NoError(t, store.ReorderItems(ctx, note.ID, collabID, []string{itemID}))
		sameText := "x"
		_, err = store.PatchItem(ctx, note.ID, collabID, itemID, NoteItemPatch{Text: &sameText})
		require.NoError(t, err)
		assert.Empty(t, unreadFor(t, store, note.ID, ownerID), "no-op toggle, reorder and patch change nothing")
		_, err = store.ToggleItemCompleted(ctx, note.ID, collabID, itemID, true)
		require.NoError(t, err)
		assert.Equal(t, NoteUnreadUpdated, unreadFor(t, store, note.ID, ownerID))

		// Adding and removing an image are changes to the shared content too.
		_, err = store.MarkViewed(ctx, note.ID, ownerID, Now())
		require.NoError(t, err)
		_, err = store.MarkViewed(ctx, note.ID, collabID, Now())
		require.NoError(t, err)
		img, err := store.CreateNoteImage(ctx, note.ID, collabID, "a.png", "image/png", 1, "sha-unread", 1, 1, 0)
		require.NoError(t, err)
		assert.Equal(t, NoteUnreadUpdated, unreadFor(t, store, note.ID, ownerID))
		assert.Empty(t, unreadFor(t, store, note.ID, collabID), "the uploader's own image never flags them")
		_, err = store.MarkViewed(ctx, note.ID, ownerID, Now())
		require.NoError(t, err)
		_, err = store.DeleteNoteImage(ctx, img.ID, collabID)
		require.NoError(t, err)
		assert.Equal(t, NoteUnreadUpdated, unreadFor(t, store, note.ID, ownerID))
		assert.Empty(t, unreadFor(t, store, note.ID, collabID))

		// A view replayed from before a collaborator's change (an offline open)
		// leaves that change unread, and never moves the view time backward.
		openedOffline := Now()
		content = "edited by collab while owner was offline"
		_, err = store.Update(ctx, note.ID, collabID, NoteUpdate{Content: &content})
		require.NoError(t, err)
		changed, err := store.MarkViewed(ctx, note.ID, ownerID, openedOffline)
		require.NoError(t, err)
		assert.False(t, changed)
		assert.Equal(t, NoteUnreadUpdated, unreadFor(t, store, note.ID, ownerID))
		_, err = store.MarkViewed(ctx, note.ID, ownerID, Now())
		require.NoError(t, err)
		_, err = store.MarkViewed(ctx, note.ID, ownerID, openedOffline)
		require.NoError(t, err)
		assert.Empty(t, unreadFor(t, store, note.ID, ownerID), "an older view does not undo a newer one")

		// A write that captured an older now and commits after a newer one
		// (two concurrent writes) never moves content_changed_at backward or
		// takes over content_changed_by, so a collaborator who viewed the note
		// between the two still sees the newer change.
		const viewerID = "user00000000000000viewer"
		_, err = store.db.ExecContext(ctx,
			store.d.RewritePlaceholders(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`),
			viewerID, "viewer", "x")
		require.NoError(t, err)
		require.NoError(t, store.ShareNote(ctx, note.ID, ownerID, viewerID))
		base := Now()
		stale := Timestamp(base.Add(-2 * time.Minute))
		_, err = store.MarkViewed(ctx, note.ID, viewerID, base.Add(-time.Minute))
		require.NoError(t, err)
		content = "newer edit by collab"
		_, err = store.Update(ctx, note.ID, collabID, NoteUpdate{Content: &content})
		require.NoError(t, err)
		require.Equal(t, NoteUnreadUpdated, unreadFor(t, store, note.ID, viewerID))
		staleWriters := map[string]func(tx *sql.Tx) error{
			"touchNoteTx": func(tx *sql.Tx) error {
				return touchNoteTx(ctx, tx, store.d, pendingRevision{}, note.ID, ownerID, stale)
			},
			"changeNoteContentTx": func(tx *sql.Tx) error {
				return store.changeNoteContentTx(ctx, tx, note.ID, ownerID, "stale title", "stale content", nil, stale)
			},
			"convertNoteRowTx": func(tx *sql.Tx) error {
				_, convErr := store.convertNoteRowTx(ctx, tx, note.ID, ownerID, note.NoteType, "stale title", "stale content", nil, nil, true, stale)
				return convErr
			},
			"recordContentChangeTx": func(tx *sql.Tx) error {
				return recordContentChangeTx(ctx, tx, store.d, note.ID, ownerID, stale)
			},
		}
		for name, write := range staleWriters {
			require.NoError(t, inTx(ctx, store, write), name)
			var by string
			require.NoError(t, store.db.QueryRowContext(ctx,
				store.d.RewritePlaceholders(`SELECT content_changed_by FROM notes WHERE id = ?`), note.ID).Scan(&by), name)
			assert.Equal(t, collabID, by, "%s: the newer write's actor is kept", name)
			assert.Equal(t, NoteUnreadUpdated, unreadFor(t, store, note.ID, viewerID), "%s: the newer change stays unread for the viewer", name)
			assert.Equal(t, NoteUnreadUpdated, unreadFor(t, store, note.ID, ownerID), "%s: the stale writer still sees the newer change", name)
		}

		// A trashed note never shows a badge: the bin cannot clear one.
		_, err = store.db.ExecContext(ctx, store.d.RewritePlaceholders(`UPDATE notes SET deleted_at = ? WHERE id = ?`), Timestamp(Now()), note.ID)
		require.NoError(t, err)
		trashed, err := store.GetByIDAnyState(ctx, note.ID, ownerID)
		require.NoError(t, err)
		assert.Nil(t, trashed.Unread)
	})
}
