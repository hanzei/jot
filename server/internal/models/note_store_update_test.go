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
	notes, err := store.GetByUserID(t.Context(), userID, false, false, "", "", false)
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
				n, err := store.Create(ctx, userID, "", title, "", NoteTypeText, DefaultNoteColor)
				require.NoError(t, err)
				noteIDs = append(noteIDs, n.ID)
			}
			noteA, noteB, _, _ := noteIDs[0], noteIDs[1], noteIDs[2], noteIDs[3]
			require.Equal(t, []string{"D", "C", "B", "A"}, unpinnedOrder(t, store, userID))

			pinned := true
			require.NoError(t, store.Update(ctx, noteB, userID, nil, nil, nil, &pinned, nil, nil, nil))
			// Pinning removes B from the unpinned list without touching the others.
			require.Equal(t, []string{"D", "C", "A"}, unpinnedOrder(t, store, userID))

			unpinned := false
			require.NoError(t, store.Update(ctx, noteB, userID, nil, nil, nil, &unpinned, nil, nil, nil))

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
				n, err := store.Create(ctx, userID, "", title, "", NoteTypeText, DefaultNoteColor)
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
			require.NoError(t, store.Update(ctx, noteToPin, userID, nil, nil, nil, &unpinned, nil, nil, nil))

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
