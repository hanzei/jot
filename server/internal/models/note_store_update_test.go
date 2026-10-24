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
			require.NoError(t, store.Update(ctx, noteB, userID, NoteUpdate{Pinned: &pinned}))
			// Pinning removes B from the unpinned list without touching the others.
			require.Equal(t, []string{"D", "C", "A"}, unpinnedOrder(t, store, userID))

			unpinned := false
			require.NoError(t, store.Update(ctx, noteB, userID, NoteUpdate{Pinned: &unpinned}))

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
			require.NoError(t, store.Update(ctx, noteToPin, userID, NoteUpdate{Pinned: &unpinned}))

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

// TestUpdatePartialWrites covers updates whose fields were changed by another
// update after the caller last read the note: every write and every no-op or
// pin-flip decision must go by the row as stored, never by an earlier read.
func TestUpdatePartialWrites(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		// setup returns a fresh store and the note as first read, which the
		// cases treat as a client's (soon stale) copy.
		setup := func(t *testing.T) (*noteStore, string, *Note) {
			t.Helper()
			store, userID := newTestBulkStore(t, driver)
			note, err := store.Create(t.Context(), userID, NewNote{Title: "title", Content: "content", Type: NoteTypeText, Color: DefaultNoteColor})
			require.NoError(t, err)
			read, err := store.GetByID(t.Context(), note.ID, userID)
			require.NoError(t, err)
			return store, userID, read
		}

		t.Run("a title-only write keeps content changed since the read", func(t *testing.T) {
			store, userID, read := setup(t)
			ctx := t.Context()
			require.NoError(t, store.Update(ctx, read.ID, userID, NoteUpdate{Content: new("newer content")}))

			require.NoError(t, store.Update(ctx, read.ID, userID, NoteUpdate{Title: new("new title")}))

			got, err := store.GetByID(ctx, read.ID, userID)
			require.NoError(t, err)
			assert.Equal(t, "new title", got.Title)
			assert.Equal(t, "newer content", got.Content)
		})

		t.Run("a per-user write keeps the other per-user fields changed since the read", func(t *testing.T) {
			store, userID, read := setup(t)
			ctx := t.Context()
			require.NoError(t, store.Update(ctx, read.ID, userID, NoteUpdate{Archived: new(true), CheckedItemsCollapsed: new(true)}))

			require.NoError(t, store.Update(ctx, read.ID, userID, NoteUpdate{Color: new("#fbbc04")}))

			got, err := store.GetByID(ctx, read.ID, userID)
			require.NoError(t, err)
			assert.Equal(t, "#fbbc04", got.Color)
			assert.True(t, got.Archived)
			assert.True(t, got.CheckedItemsCollapsed)
		})

		t.Run("a write matching the read but not the stored value is applied", func(t *testing.T) {
			store, userID, read := setup(t)
			ctx := t.Context()
			require.NoError(t, store.Update(ctx, read.ID, userID, NoteUpdate{Title: new("other title")}))

			require.NoError(t, store.Update(ctx, read.ID, userID, NoteUpdate{Title: new(read.Title)}))

			got, err := store.GetByID(ctx, read.ID, userID)
			require.NoError(t, err)
			assert.Equal(t, read.Title, got.Title)
		})

		t.Run("a write that changes nothing does not bump the version", func(t *testing.T) {
			store, userID, read := setup(t)
			ctx := t.Context()

			require.NoError(t, store.Update(ctx, read.ID, userID, NoteUpdate{Title: new(read.Title), Content: new(read.Content)}))

			got, err := store.GetByID(ctx, read.ID, userID)
			require.NoError(t, err)
			assert.Equal(t, read.Version, got.Version)
		})

		t.Run("an unpin restores the position saved by the pin", func(t *testing.T) {
			store, userID, read := setup(t)
			ctx := t.Context()
			require.NoError(t, store.Update(ctx, read.ID, userID, NoteUpdate{Pinned: new(true)}))

			require.NoError(t, store.Update(ctx, read.ID, userID, NoteUpdate{Pinned: new(false)}))

			got, err := store.GetByID(ctx, read.ID, userID)
			require.NoError(t, err)
			assert.False(t, got.Pinned)
			assert.Equal(t, read.Position, got.Position)
			assert.Nil(t, got.UnpinnedPosition, "unpinned_position is cleared once consumed")
		})

		t.Run("a repeated unpin does not shift the other notes again", func(t *testing.T) {
			store, userID, other := setup(t)
			ctx := t.Context()
			note, err := store.Create(ctx, userID, NewNote{Title: "pinned", Type: NoteTypeText, Color: DefaultNoteColor})
			require.NoError(t, err)
			require.NoError(t, store.Update(ctx, note.ID, userID, NoteUpdate{Pinned: new(true)}))
			require.NoError(t, store.Update(ctx, note.ID, userID, NoteUpdate{Pinned: new(false)}))
			before, err := store.GetByID(ctx, other.ID, userID)
			require.NoError(t, err)

			require.NoError(t, store.Update(ctx, note.ID, userID, NoteUpdate{Pinned: new(false)}))

			after, err := store.GetByID(ctx, other.ID, userID)
			require.NoError(t, err)
			assert.Equal(t, before.Position, after.Position)
		})

		t.Run("a guarded title-only write conflicts when the title changed since base_version", func(t *testing.T) {
			store, userID, read := setup(t)
			ctx := t.Context()
			require.NoError(t, store.Update(ctx, read.ID, userID, NoteUpdate{Title: new("other title")}))

			err := store.Update(ctx, read.ID, userID, NoteUpdate{Title: new("new title"), BaseVersion: new(read.Version)})
			require.ErrorIs(t, err, ErrNoteVersionConflict)
		})

		t.Run("a guarded title-only write is an idempotent no-op when only content changed and the title already matches", func(t *testing.T) {
			store, userID, read := setup(t)
			ctx := t.Context()
			require.NoError(t, store.Update(ctx, read.ID, userID, NoteUpdate{Title: new("new title"), Content: new("newer content")}))

			require.NoError(t, store.Update(ctx, read.ID, userID, NoteUpdate{Title: new("new title"), BaseVersion: new(read.Version)}))

			got, err := store.GetByID(ctx, read.ID, userID)
			require.NoError(t, err)
			assert.Equal(t, "newer content", got.Content)
		})
	})
}
