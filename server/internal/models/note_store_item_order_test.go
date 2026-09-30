package models

import (
	"database/sql"
	"testing"

	"github.com/hanzei/jot/server/internal/database/dbtest"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGroupedItemOrder(t *testing.T) {
	t.Parallel()

	parent := func(id string) sql.NullString { return sql.NullString{String: id, Valid: true} }
	ids := func(rows []itemOrderRow) []string {
		out := make([]string, 0, len(rows))
		for _, r := range rows {
			out = append(out, r.id)
		}
		return out
	}

	tests := []struct {
		name string
		rows []itemOrderRow
		want []string
	}{
		{
			name: "already grouped",
			rows: []itemOrderRow{{id: "a"}, {id: "a1", parentID: parent("a")}, {id: "b"}},
			want: []string{"a", "a1", "b"},
		},
		{
			name: "child ahead of its parent moves under it",
			rows: []itemOrderRow{{id: "b1", parentID: parent("b")}, {id: "a"}, {id: "b"}},
			want: []string{"a", "b", "b1"},
		},
		{
			name: "children keep their relative order",
			rows: []itemOrderRow{{id: "a2", parentID: parent("a")}, {id: "a"}, {id: "b"}, {id: "a1", parentID: parent("a")}},
			want: []string{"a", "a2", "a1", "b"},
		},
		{
			name: "a child of a missing parent keeps its place",
			rows: []itemOrderRow{{id: "a"}, {id: "x1", parentID: parent("x")}, {id: "b"}},
			want: []string{"a", "x1", "b"},
		},
		{
			name: "empty",
			rows: nil,
			want: []string{},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, ids(groupedItemOrder(tc.rows)))
		})
	}
}

// storedItemOrder returns the note's item texts and positions in read order.
func storedItemOrder(t *testing.T, store *noteStore, noteID string) ([]string, []int) {
	t.Helper()
	items, err := store.getItemsByNoteID(t.Context(), noteID)
	require.NoError(t, err)
	texts := make([]string, 0, len(items))
	positions := make([]int, 0, len(items))
	for _, it := range items {
		texts = append(texts, it.Text)
		positions = append(positions, it.Position)
	}
	return texts, positions
}

func TestItemOrderNormalization(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		// newNote creates a list note with three top-level items a, b, c at
		// positions 0..2 and returns the note ID and item IDs by text.
		newNote := func(t *testing.T, store *noteStore, userID string) (string, map[string]string) {
			t.Helper()
			ids := map[string]string{}
			items := make([]NewNoteItem, 0, 3)
			for i, text := range []string{"a", "b", "c"} {
				id, err := generateID()
				require.NoError(t, err)
				ids[text] = id
				items = append(items, NewNoteItem{ID: id, Text: text, Position: i})
			}
			note, err := store.CreateWithItems(t.Context(), userID, "", "List", "", NoteTypeList, DefaultNoteColor, items)
			require.NoError(t, err)
			return note.ID, ids
		}

		t.Run("re-parenting under a later item moves the child under it", func(t *testing.T) {
			// A drag-to-reparent whose follow-up reorder never landed.
			store, userID := newTestBulkStore(t, driver)
			noteID, ids := newNote(t, store, userID)

			parentID := ids["c"]
			item, err := store.PatchItem(t.Context(), noteID, ids["a"], NoteItemPatch{ParentID: &parentID})
			require.NoError(t, err)

			texts, positions := storedItemOrder(t, store, noteID)
			assert.Equal(t, []string{"b", "c", "a"}, texts)
			assert.Equal(t, []int{0, 1, 2}, positions)
			assert.Equal(t, 2, item.Position, "the response carries the stored position")
		})

		t.Run("a reorder that splits a group keeps the child under its parent", func(t *testing.T) {
			// A device that has not yet seen the re-parent sends an order
			// with the child at the top.
			store, userID := newTestBulkStore(t, driver)
			noteID, ids := newNote(t, store, userID)
			parentID := ids["c"]
			_, err := store.PatchItem(t.Context(), noteID, ids["a"], NoteItemPatch{ParentID: &parentID})
			require.NoError(t, err)

			require.NoError(t, store.ReorderItems(t.Context(), noteID, []string{ids["a"], ids["c"], ids["b"]}))

			texts, positions := storedItemOrder(t, store, noteID)
			assert.Equal(t, []string{"c", "a", "b"}, texts, "the requested order is kept apart from the group")
			assert.Equal(t, []int{0, 1, 2}, positions)
		})

		t.Run("creating a child at a position ahead of its parent places it under the parent", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			noteID, ids := newNote(t, store, userID)

			childID, err := generateID()
			require.NoError(t, err)
			item, err := store.CreateItemWithID(t.Context(), noteID, childID, "b1", 0, false, ids["b"], "", 0)
			require.NoError(t, err)

			texts, positions := storedItemOrder(t, store, noteID)
			assert.Equal(t, []string{"a", "b", "b1", "c"}, texts)
			assert.Equal(t, []int{0, 1, 2, 3}, positions)
			assert.Equal(t, 2, item.Position, "the response carries the stored position")
		})

		t.Run("creating a note with a child ahead of its parent places it under the parent", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			parentID, err := generateID()
			require.NoError(t, err)
			items := []NewNoteItem{
				{ID: parentID, Text: "a", Position: 1},
				{Text: "a1", Position: 0, ParentID: parentID},
				{Text: "b", Position: 2},
			}
			note, err := store.CreateWithItems(t.Context(), userID, "", "List", "", NoteTypeList, DefaultNoteColor, items)
			require.NoError(t, err)

			texts, positions := storedItemOrder(t, store, note.ID)
			assert.Equal(t, []string{"a", "a1", "b"}, texts)
			assert.Equal(t, []int{0, 1, 2}, positions)
		})

		t.Run("converting to a list with a child ahead of its parent places it under the parent", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			note, err := store.CreateWithItems(t.Context(), userID, "", "", "a\na1", NoteTypeText, DefaultNoteColor, nil)
			require.NoError(t, err)
			parentID, err := generateID()
			require.NoError(t, err)

			_, err = store.ConvertType(t.Context(), note.ID, userID, NoteTypeList, "List", "", []NewNoteItem{
				{ID: parentID, Text: "a", Position: 1},
				{Text: "a1", Position: 0, ParentID: parentID},
			}, nil)
			require.NoError(t, err)

			texts, positions := storedItemOrder(t, store, note.ID)
			assert.Equal(t, []string{"a", "a1"}, texts)
			assert.Equal(t, []int{0, 1}, positions)
		})

		t.Run("replaying a conversion with a child ahead of its parent is idempotent", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			note, err := store.CreateWithItems(t.Context(), userID, "", "", "a\na1", NoteTypeText, DefaultNoteColor, nil)
			require.NoError(t, err)
			parentID, err := generateID()
			require.NoError(t, err)
			childID, err := generateID()
			require.NoError(t, err)
			targetItems := []NewNoteItem{
				{ID: parentID, Text: "a", Position: 1},
				{ID: childID, Text: "a1", Position: 0, ParentID: parentID},
			}
			baseVersion := note.Version

			_, err = store.ConvertType(t.Context(), note.ID, userID, NoteTypeList, "List", "", targetItems, &baseVersion)
			require.NoError(t, err)
			// The same request again, at the same base version: the first one
			// already bumped the version, so this takes the replay path, which must
			// recognize the grouped order it stored rather than report a conflict.
			_, err = store.ConvertType(t.Context(), note.ID, userID, NoteTypeList, "List", "", targetItems, &baseVersion)
			require.NoError(t, err)

			texts, positions := storedItemOrder(t, store, note.ID)
			assert.Equal(t, []string{"a", "a1"}, texts)
			assert.Equal(t, []int{0, 1}, positions)
		})

		t.Run("replaying a conversion with shared positions is idempotent", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			note, err := store.CreateWithItems(t.Context(), userID, "", "", "x\ny", NoteTypeText, DefaultNoteColor, nil)
			require.NoError(t, err)
			// Items sharing a position are stored in ID order (same created_at),
			// so list them against that order to make the tiebreak matter.
			lowID, err := generateID()
			require.NoError(t, err)
			highID, err := generateID()
			require.NoError(t, err)
			if highID < lowID {
				lowID, highID = highID, lowID
			}
			targetItems := []NewNoteItem{
				{ID: highID, Text: "x", Position: 0},
				{ID: lowID, Text: "y", Position: 0},
			}
			baseVersion := note.Version

			_, err = store.ConvertType(t.Context(), note.ID, userID, NoteTypeList, "List", "", targetItems, &baseVersion)
			require.NoError(t, err)
			_, err = store.ConvertType(t.Context(), note.ID, userID, NoteTypeList, "List", "", targetItems, &baseVersion)
			require.NoError(t, err)

			texts, _ := storedItemOrder(t, store, note.ID)
			assert.Equal(t, []string{"y", "x"}, texts)
		})

		t.Run("a well-formed write leaves other positions alone", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			noteID, ids := newNote(t, store, userID)

			// Leave a gap; it is not an ordering problem, so nothing compacts it.
			position := 10
			_, err := store.PatchItem(t.Context(), noteID, ids["c"], NoteItemPatch{Position: &position})
			require.NoError(t, err)
			childID, err := generateID()
			require.NoError(t, err)
			item, err := store.CreateItemWithID(t.Context(), noteID, childID, "c1", 11, false, ids["c"], "", 0)
			require.NoError(t, err)

			texts, positions := storedItemOrder(t, store, noteID)
			assert.Equal(t, []string{"a", "b", "c", "c1"}, texts)
			assert.Equal(t, []int{0, 1, 10, 11}, positions)
			assert.Equal(t, 11, item.Position)
		})

		t.Run("a patch without a position keeps the stored one", func(t *testing.T) {
			store, userID := newTestBulkStore(t, driver)
			noteID, ids := newNote(t, store, userID)
			require.NoError(t, store.ReorderItems(t.Context(), noteID, []string{ids["c"], ids["a"], ids["b"]}))

			text := "a, renamed"
			item, err := store.PatchItem(t.Context(), noteID, ids["a"], NoteItemPatch{Text: &text})
			require.NoError(t, err)

			texts, positions := storedItemOrder(t, store, noteID)
			assert.Equal(t, []string{"c", "a, renamed", "b"}, texts)
			assert.Equal(t, []int{0, 1, 2}, positions)
			assert.Equal(t, 1, item.Position, "the response carries the stored position")
		})

		t.Run("a shared position is broken up", func(t *testing.T) {
			// Readers that sort by position alone (mobile's local store) would
			// otherwise be free to show the two in either order.
			store, userID := newTestBulkStore(t, driver)
			noteID, ids := newNote(t, store, userID)

			position := 0
			_, err := store.PatchItem(t.Context(), noteID, ids["b"], NoteItemPatch{Position: &position})
			require.NoError(t, err)

			// a and b share created_at (one CreateWithItems), so which of the
			// two comes first falls to their random IDs.
			texts, positions := storedItemOrder(t, store, noteID)
			require.Len(t, texts, 3)
			assert.ElementsMatch(t, []string{"a", "b"}, texts[:2])
			assert.Equal(t, "c", texts[2])
			assert.Equal(t, []int{0, 1, 2}, positions)
		})
	})
}
