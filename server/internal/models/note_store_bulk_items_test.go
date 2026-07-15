package models

import (
	"testing"
	"time"

	"github.com/hanzei/jot/server/internal/database/dbtest"
	"github.com/hanzei/jot/server/internal/database/dialect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newTestBulkStore opens a fresh migrated database for driver and returns a
// noteStore bound to it plus an owning user ID.
func newTestBulkStore(t *testing.T, driver string) (*noteStore, string) {
	t.Helper()

	db := dbtest.New(t, driver)
	d := &dialect.Dialect{Driver: driver}
	store := newNoteStore(db, d)

	_, err := db.ExecContext(t.Context(),
		d.RewritePlaceholders(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`),
		"user000000000000000bulk", "bulker", "x")
	require.NoError(t, err)

	return store, "user000000000000000bulk"
}

// bulkItemByText returns the item with the given text, failing if absent.
func bulkItemByText(t *testing.T, items []NoteItem, text string) NoteItem {
	t.Helper()
	for _, it := range items {
		if it.Text == text {
			return it
		}
	}
	t.Fatalf("item %q not found", text)
	return NoteItem{}
}

// forceNoteUpdatedAtPast pins the note's updated_at to a fixed past instant and
// returns it (read back through GetByID so the comparison normalizes any
// driver-specific timestamp formatting). A later GetByID that still equals this
// proves the note was not touched.
func forceNoteUpdatedAtPast(t *testing.T, store *noteStore, noteID, userID string) time.Time {
	t.Helper()
	past := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	_, err := store.db.ExecContext(t.Context(),
		store.d.RewritePlaceholders(`UPDATE notes SET updated_at = ? WHERE id = ?`),
		past, noteID)
	require.NoError(t, err)
	n, err := store.GetByID(t.Context(), noteID, userID)
	require.NoError(t, err)
	return n.UpdatedAt
}

func TestSetItemsCompleted(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		t.Run("clears completed on the given items and returns the full list", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			ctx := t.Context()

			doneA, err := generateID()
			require.NoError(t, err)
			doneC, err := generateID()
			require.NoError(t, err)

			note, err := store.CreateWithItems(ctx, userID, "", "Chores", "", NoteTypeList, DefaultNoteColor,
				[]NewNoteItem{
					{ID: doneA, Text: "done a", Position: 0, Completed: true},
					{Text: "todo b", Position: 1, Completed: false},
					{ID: doneC, Text: "done c", Position: 2, Completed: true},
				})
			require.NoError(t, err)

			items, err := store.SetItemsCompleted(ctx, note.ID, []string{doneA, doneC}, false)
			require.NoError(t, err)
			require.Len(t, items, 3, "returns the note's full item list")
			for _, it := range items {
				assert.False(t, it.Completed, "item %q should be unchecked", it.Text)
			}
		})

		t.Run("re-checks the given items (undo of an uncheck)", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			ctx := t.Context()

			a, err := generateID()
			require.NoError(t, err)
			b, err := generateID()
			require.NoError(t, err)

			note, err := store.CreateWithItems(ctx, userID, "", "Chores", "", NoteTypeList, DefaultNoteColor,
				[]NewNoteItem{
					{ID: a, Text: "a", Position: 0, Completed: true},
					{ID: b, Text: "b", Position: 1, Completed: true},
				})
			require.NoError(t, err)

			_, err = store.SetItemsCompleted(ctx, note.ID, []string{a, b}, false)
			require.NoError(t, err)

			items, err := store.SetItemsCompleted(ctx, note.ID, []string{a, b}, true)
			require.NoError(t, err)
			for _, it := range items {
				assert.True(t, it.Completed, "item %q should be re-checked", it.Text)
			}
		})

		t.Run("ignores IDs that do not belong to the note", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			ctx := t.Context()

			note, err := store.CreateWithItems(ctx, userID, "", "Chores", "", NoteTypeList, DefaultNoteColor,
				[]NewNoteItem{{Text: "done", Position: 0, Completed: true}})
			require.NoError(t, err)

			items, err := store.SetItemsCompleted(ctx, note.ID, []string{"doesnotexist1234567890"}, false)
			require.NoError(t, err)
			require.Len(t, items, 1)
			assert.True(t, items[0].Completed, "unrelated ID must not change anything")
		})

		t.Run("does not touch the note when nothing actually changes", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			ctx := t.Context()

			a, err := generateID()
			require.NoError(t, err)
			note, err := store.CreateWithItems(ctx, userID, "", "Chores", "", NoteTypeList, DefaultNoteColor,
				[]NewNoteItem{{ID: a, Text: "todo", Position: 0, Completed: false}})
			require.NoError(t, err)

			before := forceNoteUpdatedAtPast(t, store, note.ID, userID)

			// Item is already uncompleted, so setting it uncompleted is a no-op.
			_, err = store.SetItemsCompleted(ctx, note.ID, []string{a}, false)
			require.NoError(t, err)

			after, err := store.GetByID(ctx, note.ID, userID)
			require.NoError(t, err)
			assert.True(t, after.UpdatedAt.Equal(before), "no-op set-completed must not bump the note's updated_at")
		})
	})
}

func TestDeleteItems(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		t.Run("removes the given items and keeps the rest", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			ctx := t.Context()

			a, err := generateID()
			require.NoError(t, err)
			c, err := generateID()
			require.NoError(t, err)

			note, err := store.CreateWithItems(ctx, userID, "", "Chores", "", NoteTypeList, DefaultNoteColor,
				[]NewNoteItem{
					{ID: a, Text: "remove a", Position: 0},
					{Text: "keep b", Position: 1},
					{ID: c, Text: "remove c", Position: 2},
				})
			require.NoError(t, err)

			items, err := store.DeleteItems(ctx, note.ID, []string{a, c})
			require.NoError(t, err)
			require.Len(t, items, 1)
			assert.Equal(t, "keep b", items[0].Text)
		})

		t.Run("re-homes a child orphaned by deleting its parent", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			ctx := t.Context()

			parentID, err := generateID()
			require.NoError(t, err)

			note, err := store.CreateWithItems(ctx, userID, "", "Groups", "", NoteTypeList, DefaultNoteColor,
				[]NewNoteItem{
					{ID: parentID, Text: "Parent", Position: 0, Completed: true},
					{Text: "Child", Position: 1, Completed: false, ParentID: parentID},
				})
			require.NoError(t, err)

			items, err := store.DeleteItems(ctx, note.ID, []string{parentID})
			require.NoError(t, err)
			require.Len(t, items, 1, "only the child remains")
			child := bulkItemByText(t, items, "Child")
			assert.Nil(t, child.ParentID, "orphaned child is re-homed to top level")
		})

		t.Run("ignores IDs that do not belong to the note", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			ctx := t.Context()

			note, err := store.CreateWithItems(ctx, userID, "", "Chores", "", NoteTypeList, DefaultNoteColor,
				[]NewNoteItem{{Text: "keep", Position: 0}})
			require.NoError(t, err)

			items, err := store.DeleteItems(ctx, note.ID, []string{"doesnotexist1234567890"})
			require.NoError(t, err)
			assert.Len(t, items, 1, "unrelated ID must not delete anything")
		})

		t.Run("does not touch the note when nothing is deleted", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			ctx := t.Context()

			note, err := store.CreateWithItems(ctx, userID, "", "Chores", "", NoteTypeList, DefaultNoteColor,
				[]NewNoteItem{{Text: "keep", Position: 0}})
			require.NoError(t, err)

			before := forceNoteUpdatedAtPast(t, store, note.ID, userID)

			_, err = store.DeleteItems(ctx, note.ID, []string{"doesnotexist1234567890"})
			require.NoError(t, err)

			after, err := store.GetByID(ctx, note.ID, userID)
			require.NoError(t, err)
			assert.True(t, after.UpdatedAt.Equal(before), "no-op delete must not bump the note's updated_at")
		})
	})
}
