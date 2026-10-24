package models

import (
	"testing"

	"github.com/hanzei/jot/server/internal/database/dbtest"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// unpinnedOrder returns the titles of userID's unpinned, non-archived notes in
// position order, for asserting handleUnpinningTx's effect on the whole list
// rather than just the unpinned note itself.
func unpinnedOrder(t *testing.T, store *noteStore, userID string) []string {
	t.Helper()
	notes, err := store.GetByUserID(t.Context(), userID, NoteFilter{})
	require.NoError(t, err)
	titles := make([]string, 0, len(notes))
	for _, n := range notes {
		if !n.Pinned {
			titles = append(titles, n.Title)
		}
	}
	return titles
}

func TestUpdateUnpinning(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		t.Run("restores the note to its saved unpinned_position and shifts later notes to make room", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			ctx := t.Context()

			// Created in this order, so creation's shift-to-front logic leaves them
			// as: D, C, B, A (most recently created first).
			noteIDs := make([]string, 0, 4)
			for _, title := range []string{"A", "B", "C", "D"} {
				n, err := store.Create(ctx, userID, NewNote{Title: title, Type: NoteTypeText, Color: DefaultNoteColor})
				require.NoError(t, err)
				noteIDs = append(noteIDs, n.ID)
			}
			noteA, noteB, _, _ := noteIDs[0], noteIDs[1], noteIDs[2], noteIDs[3]
			require.Equal(t, []string{"D", "C", "B", "A"}, unpinnedOrder(t, store, userID))

			pinned := true
			_, err := store.Update(ctx, noteB, userID, NoteUpdate{Pinned: &pinned})
			require.NoError(t, err)
			// Pinning removes B from the unpinned list without touching the others.
			require.Equal(t, []string{"D", "C", "A"}, unpinnedOrder(t, store, userID))

			unpinned := false
			_, err = store.Update(ctx, noteB, userID, NoteUpdate{Pinned: &unpinned})
			require.NoError(t, err)

			// B returns to the slot it held before being pinned, and A (which sat at
			// or past that slot) is pushed one further out to make room. D and C,
			// both before B's restored slot, are undisturbed.
			assert.Equal(t, []string{"D", "C", "B", "A"}, unpinnedOrder(t, store, userID))

			restored, err := store.GetByID(ctx, noteB, userID)
			require.NoError(t, err)
			assert.False(t, restored.Pinned)
			assert.Nil(t, restored.UnpinnedPosition, "unpinned_position is cleared once consumed")

			untouched, err := store.GetByID(ctx, noteA, userID)
			require.NoError(t, err)
			assert.False(t, untouched.Pinned)
		})

		t.Run("appends to the end when the note has no saved unpinned_position", func(t *testing.T) {
			// unpinned_position is only ever NULL for a note pinned by some path
			// other than handlePinStatusChangeTx (e.g. a row imported directly in
			// a pinned state, or one written before the column existed) — Create
			// and the normal pin flow both always set it. Simulate that directly
			// so the "no saved position" branch of handleUnpinningTx is exercised.
			store, userID := newTestBulkStore(t, driver)
			ctx := t.Context()

			noteIDs := make([]string, 0, 3)
			for _, title := range []string{"A", "B", "C"} {
				n, err := store.Create(ctx, userID, NewNote{Title: title, Type: NoteTypeText, Color: DefaultNoteColor})
				require.NoError(t, err)
				noteIDs = append(noteIDs, n.ID)
			}
			noteToPin := noteIDs[1] // "B"
			require.Equal(t, []string{"C", "B", "A"}, unpinnedOrder(t, store, userID))

			_, err := store.db.ExecContext(ctx,
				store.d.RewritePlaceholders(`UPDATE note_user_state SET pinned = TRUE, unpinned_position = NULL WHERE note_id = ? AND user_id = ?`),
				noteToPin, userID,
			)
			require.NoError(t, err)

			unpinned := false
			_, err = store.Update(ctx, noteToPin, userID, NoteUpdate{Pinned: &unpinned})
			require.NoError(t, err)

			// With no saved slot to restore, B lands at the end of the unpinned
			// list rather than crashing or silently keeping its stale position.
			assert.Equal(t, []string{"C", "A", "B"}, unpinnedOrder(t, store, userID))

			restored, err := store.GetByID(ctx, noteToPin, userID)
			require.NoError(t, err)
			assert.False(t, restored.Pinned)
			assert.Nil(t, restored.UnpinnedPosition)
		})
	})
}

func TestUpdate(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		t.Run("returns the updated note", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			ctx := t.Context()

			n, err := store.Create(ctx, userID, NewNote{Content: "before", Type: NoteTypeText, Color: DefaultNoteColor})
			require.NoError(t, err)

			content, color, pinned := "after", "#ff0000", true
			updated, err := store.Update(ctx, n.ID, userID, NoteUpdate{Content: &content, Color: &color, Pinned: &pinned})
			require.NoError(t, err)

			reread, err := store.GetByID(ctx, n.ID, userID)
			require.NoError(t, err)
			assert.Equal(t, reread, updated)
			assert.Equal(t, "after", updated.Content)
			assert.Equal(t, "#ff0000", updated.Color)
			assert.True(t, updated.Pinned)
			assert.Equal(t, n.Version+1, updated.Version)
		})

		t.Run("rejects a field the note type does not allow, without writing", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			ctx := t.Context()

			text, err := store.Create(ctx, userID, NewNote{Content: "body", Type: NoteTypeText, Color: DefaultNoteColor})
			require.NoError(t, err)
			list, err := store.Create(ctx, userID, NewNote{Title: "List", Type: NoteTypeList, Color: DefaultNoteColor})
			require.NoError(t, err)

			title, content, color, collapsed := "Title", "content", "#ff0000", true
			cases := []struct {
				name                  string
				id                    string
				title, content        *string
				checkedItemsCollapsed *bool
				wantMsg               string
			}{
				{"title on a text note", text.ID, &title, nil, nil, "text notes cannot have a title"},
				{"content on a list note", list.ID, nil, &content, nil, "list notes cannot have content"},
				{"checked_items_collapsed on a text note", text.ID, nil, nil, &collapsed, "text notes cannot have checked_items_collapsed"},
			}
			for _, tc := range cases {
				t.Run(tc.name, func(t *testing.T) {
					before, err := store.GetByID(ctx, tc.id, userID)
					require.NoError(t, err)

					_, err = store.Update(ctx, tc.id, userID, NoteUpdate{Title: tc.title, Content: tc.content, Color: &color, CheckedItemsCollapsed: tc.checkedItemsCollapsed})
					require.ErrorIs(t, err, ErrNoteFieldNotAllowed)
					require.EqualError(t, err, tc.wantMsg)

					after, err := store.GetByID(ctx, tc.id, userID)
					require.NoError(t, err)
					assert.Equal(t, before, after, "a rejected update must not write the other fields either")
				})
			}
		})

		t.Run("checks the type the note has now, after a conversion", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			ctx := t.Context()

			n, err := store.Create(ctx, userID, NewNote{Content: "body", Type: NoteTypeText, Color: DefaultNoteColor})
			require.NoError(t, err)
			_, err = store.ConvertType(ctx, n.ID, userID, NoteTypeList, "", "", nil, nil)
			require.NoError(t, err)

			content := "text again"
			_, err = store.Update(ctx, n.ID, userID, NoteUpdate{Content: &content})
			require.ErrorIs(t, err, ErrNoteFieldNotAllowed)
		})

		t.Run("reports a note the user cannot see as not found", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			ctx := t.Context()

			const strangerID = "user0000000000000strange"
			_, err := store.db.ExecContext(ctx,
				store.d.RewritePlaceholders(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`),
				strangerID, "stranger", "x")
			require.NoError(t, err)

			n, err := store.Create(ctx, userID, NewNote{Content: "body", Type: NoteTypeText, Color: DefaultNoteColor})
			require.NoError(t, err)

			content := "intrusion"
			_, err = store.Update(ctx, n.ID, strangerID, NoteUpdate{Content: &content})
			require.ErrorIs(t, err, ErrNoteNotFound)

			require.NoError(t, store.MoveToTrash(ctx, n.ID, userID))
			_, err = store.Update(ctx, n.ID, userID, NoteUpdate{Content: &content})
			require.ErrorIs(t, err, ErrNoteNotFound, "a trashed note is not updatable")

			trashed, err := store.GetByIDAnyState(ctx, n.ID, userID)
			require.NoError(t, err)
			assert.Equal(t, "body", trashed.Content)
		})
	})
}
