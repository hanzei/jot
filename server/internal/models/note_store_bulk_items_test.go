package models

import (
	"testing"

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

func TestUncheckAllItems(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		t.Run("clears every completed item and returns the full list", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			ctx := t.Context()

			note, err := store.CreateWithItems(ctx, userID, "", "Chores", "", NoteTypeList, DefaultNoteColor,
				[]NewNoteItem{
					{Text: "done a", Position: 0, Completed: true},
					{Text: "todo b", Position: 1, Completed: false},
					{Text: "done c", Position: 2, Completed: true},
				})
			require.NoError(t, err)

			items, err := store.UncheckAllItems(ctx, note.ID)
			require.NoError(t, err)
			require.Len(t, items, 3, "returns the note's full item list")
			for _, it := range items {
				assert.False(t, it.Completed, "item %q should be unchecked", it.Text)
			}
		})

		t.Run("is idempotent when nothing is completed", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			ctx := t.Context()

			note, err := store.CreateWithItems(ctx, userID, "", "Chores", "", NoteTypeList, DefaultNoteColor,
				[]NewNoteItem{
					{Text: "todo a", Position: 0},
					{Text: "todo b", Position: 1},
				})
			require.NoError(t, err)

			items, err := store.UncheckAllItems(ctx, note.ID)
			require.NoError(t, err)
			assert.Len(t, items, 2)
			for _, it := range items {
				assert.False(t, it.Completed)
			}
		})
	})
}

func TestDeleteCompletedItems(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		t.Run("removes a completed group whole and keeps incomplete items", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			ctx := t.Context()

			parentID, err := generateID()
			require.NoError(t, err)

			// A completed parent with completed children (the normal invariant),
			// plus a standalone incomplete item.
			note, err := store.CreateWithItems(ctx, userID, "", "Groups", "", NoteTypeList, DefaultNoteColor,
				[]NewNoteItem{
					{ID: parentID, Text: "Parent", Position: 0, Completed: true},
					{Text: "Child A", Position: 1, Completed: true, ParentID: parentID},
					{Text: "Child B", Position: 2, Completed: true, ParentID: parentID},
					{Text: "Solo", Position: 3, Completed: false},
				})
			require.NoError(t, err)

			items, err := store.DeleteCompletedItems(ctx, note.ID)
			require.NoError(t, err)
			require.Len(t, items, 1, "only the incomplete item remains")
			assert.Equal(t, "Solo", items[0].Text)
		})

		t.Run("removes a completed child but keeps its incomplete parent", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			ctx := t.Context()

			parentID, err := generateID()
			require.NoError(t, err)

			note, err := store.CreateWithItems(ctx, userID, "", "Groups", "", NoteTypeList, DefaultNoteColor,
				[]NewNoteItem{
					{ID: parentID, Text: "Parent", Position: 0, Completed: false},
					{Text: "Child A", Position: 1, Completed: true, ParentID: parentID},
					{Text: "Child B", Position: 2, Completed: false, ParentID: parentID},
				})
			require.NoError(t, err)

			items, err := store.DeleteCompletedItems(ctx, note.ID)
			require.NoError(t, err)
			require.Len(t, items, 2)

			parent := bulkItemByText(t, items, "Parent")
			childB := bulkItemByText(t, items, "Child B")
			assert.Nil(t, parent.ParentID, "surviving parent stays top-level")
			require.NotNil(t, childB.ParentID)
			assert.Equal(t, parentID, *childB.ParentID, "surviving child keeps its parent")
		})

		t.Run("re-homes a child orphaned by deleting its completed parent", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			ctx := t.Context()

			parentID, err := generateID()
			require.NoError(t, err)

			// Invariant-violating state (completed parent, incomplete child) that
			// the cascade normally prevents. Deleting the completed parent would
			// orphan the child; the defensive re-home must return it to top level.
			note, err := store.CreateWithItems(ctx, userID, "", "Drifted", "", NoteTypeList, DefaultNoteColor,
				[]NewNoteItem{
					{ID: parentID, Text: "Parent", Position: 0, Completed: true},
					{Text: "Child", Position: 1, Completed: false, ParentID: parentID},
				})
			require.NoError(t, err)

			items, err := store.DeleteCompletedItems(ctx, note.ID)
			require.NoError(t, err)
			require.Len(t, items, 1, "the completed parent is deleted, the incomplete child survives")

			child := bulkItemByText(t, items, "Child")
			assert.Nil(t, child.ParentID, "orphaned child is re-homed to top level")
		})

		t.Run("is idempotent when nothing is completed", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			ctx := t.Context()

			note, err := store.CreateWithItems(ctx, userID, "", "Chores", "", NoteTypeList, DefaultNoteColor,
				[]NewNoteItem{
					{Text: "todo a", Position: 0},
					{Text: "todo b", Position: 1},
				})
			require.NoError(t, err)

			items, err := store.DeleteCompletedItems(ctx, note.ID)
			require.NoError(t, err)
			assert.Len(t, items, 2)
		})
	})
}
