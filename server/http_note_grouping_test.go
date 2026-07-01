package main

import (
	"net/http"
	"strings"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// itemByText returns the item with the given text, failing the test if absent.
func itemByText(t *testing.T, items []client.NoteItem, text string) client.NoteItem {
	t.Helper()
	for _, it := range items {
		if it.Text == text {
			return it
		}
	}
	t.Fatalf("item %q not found", text)
	return client.NoteItem{}
}

// createGroupNote creates a list note shaped as one top-level parent ("Parent")
// with two indented children ("Child A", "Child B") via the positional
// bulk-create path, plus a standalone top-level item ("Solo"). It returns the
// note ID and the resolved item IDs.
func createGroupNote(t *testing.T, user *TestUser) (noteID, parentID, childAID, childBID, soloID string) {
	t.Helper()

	note, err := user.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
		Title: "Group List",
		Items: []client.CreateNoteItem{
			{Text: "Parent", Position: 0, IndentLevel: 0},
			{Text: "Child A", Position: 1, IndentLevel: 1},
			{Text: "Child B", Position: 2, IndentLevel: 1},
			{Text: "Solo", Position: 3, IndentLevel: 0},
		},
	})
	require.NoError(t, err)

	parent := itemByText(t, note.Items, "Parent")
	childA := itemByText(t, note.Items, "Child A")
	childB := itemByText(t, note.Items, "Child B")
	solo := itemByText(t, note.Items, "Solo")

	// Sanity check that the bulk-create path reconstructed grouping from
	// indent_level: both children point at the parent, the others are top-level.
	require.Nil(t, parent.ParentID)
	require.Nil(t, solo.ParentID)
	require.NotNil(t, childA.ParentID)
	require.Equal(t, parent.ID, *childA.ParentID)
	require.NotNil(t, childB.ParentID)
	require.Equal(t, parent.ID, *childB.ParentID)

	return note.ID, parent.ID, childA.ID, childB.ID, solo.ID
}

func TestNoteGrouping(t *testing.T) {
	t.Run("bulk create backfills parent_id from indent_level", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "grpuser1", "password123", false)
		createGroupNote(t, user)
	})

	t.Run("bulk create with leading indented item stays top-level", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "grpuser2", "password123", false)

		// An indented item with no preceding top-level item has nothing to
		// attach to, so it must remain top-level (parent_id NULL).
		note, err := user.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
			Title: "Orphan Lead",
			Items: []client.CreateNoteItem{
				{Text: "Lonely", Position: 0, IndentLevel: 1},
			},
		})
		require.NoError(t, err)
		assert.Nil(t, itemByText(t, note.Items, "Lonely").ParentID)
	})

	t.Run("toggle parent cascades to children", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "grpuser3", "password123", false)
		noteID, parentID, _, _, soloID := createGroupNote(t, user)

		items, err := user.Client.ToggleNoteItemCompleted(t.Context(), noteID, parentID, true)
		require.NoError(t, err)
		require.Len(t, items, 4, "toggle returns the note's full item list")

		assert.True(t, itemByText(t, items, "Parent").Completed)
		assert.True(t, itemByText(t, items, "Child A").Completed)
		assert.True(t, itemByText(t, items, "Child B").Completed)
		assert.False(t, itemByText(t, items, "Solo").Completed, "unrelated top-level item is untouched")

		// Unchecking the parent cascades back to the children.
		items, err = user.Client.ToggleNoteItemCompleted(t.Context(), noteID, parentID, false)
		require.NoError(t, err)
		assert.False(t, itemByText(t, items, "Parent").Completed)
		assert.False(t, itemByText(t, items, "Child A").Completed)
		assert.False(t, itemByText(t, items, "Child B").Completed)

		_ = soloID
	})

	t.Run("toggle child does not complete parent", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "grpuser4", "password123", false)
		noteID, parentID, childAID, _, _ := createGroupNote(t, user)

		items, err := user.Client.ToggleNoteItemCompleted(t.Context(), noteID, childAID, true)
		require.NoError(t, err)

		assert.True(t, itemByText(t, items, "Child A").Completed)
		assert.False(t, itemByText(t, items, "Child B").Completed, "sibling is untouched")
		assert.False(t, itemByText(t, items, "Parent").Completed, "cascade is parent->child only")

		_ = parentID
	})

	t.Run("unchecking a child un-completes an already-completed parent", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "grpuser4b", "password123", false)
		noteID, parentID, childAID, _, _ := createGroupNote(t, user)

		// Complete the whole group (cascades parent -> children).
		_, err := user.Client.ToggleNoteItemCompleted(t.Context(), noteID, parentID, true)
		require.NoError(t, err)

		// Unchecking just Child A must also un-complete the parent: a parent can
		// never stay "done" while one of its children is not.
		items, err := user.Client.ToggleNoteItemCompleted(t.Context(), noteID, childAID, false)
		require.NoError(t, err)
		assert.False(t, itemByText(t, items, "Child A").Completed)
		assert.True(t, itemByText(t, items, "Child B").Completed, "sibling is untouched")
		assert.False(t, itemByText(t, items, "Parent").Completed, "parent cannot be completed with an incomplete child")
	})

	t.Run("completing every child does not auto-complete the parent", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "grpuser4c", "password123", false)
		noteID, _, childAID, childBID, _ := createGroupNote(t, user)

		_, err := user.Client.ToggleNoteItemCompleted(t.Context(), noteID, childAID, true)
		require.NoError(t, err)
		items, err := user.Client.ToggleNoteItemCompleted(t.Context(), noteID, childBID, true)
		require.NoError(t, err)

		assert.True(t, itemByText(t, items, "Child A").Completed)
		assert.True(t, itemByText(t, items, "Child B").Completed)
		assert.False(t, itemByText(t, items, "Parent").Completed, "checking the parent itself is still required")
	})

	t.Run("patching completed on a child un-completes the parent the same as toggle", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "grpuser4d", "password123", false)
		noteID, parentID, childAID, _, _ := createGroupNote(t, user)

		_, err := user.Client.ToggleNoteItemCompleted(t.Context(), noteID, parentID, true)
		require.NoError(t, err)

		incomplete := false
		_, err = user.Client.UpdateNoteItem(t.Context(), noteID, childAID, &client.PatchNoteItemRequest{
			Completed: &incomplete,
		})
		require.NoError(t, err)

		note, err := user.Client.GetNote(t.Context(), noteID)
		require.NoError(t, err)
		assert.False(t, itemByText(t, note.Items, "Parent").Completed, "generic patch enforces the same invariant as toggle-completed")
	})

	t.Run("patching completed on a parent cascades to children the same as toggle", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "grpuser4e", "password123", false)
		noteID, parentID, _, _, _ := createGroupNote(t, user)

		complete := true
		_, err := user.Client.UpdateNoteItem(t.Context(), noteID, parentID, &client.PatchNoteItemRequest{
			Completed: &complete,
		})
		require.NoError(t, err)

		note, err := user.Client.GetNote(t.Context(), noteID)
		require.NoError(t, err)
		assert.True(t, itemByText(t, note.Items, "Child A").Completed)
		assert.True(t, itemByText(t, note.Items, "Child B").Completed)
	})

	t.Run("patching parent_id and completed together evaluates the invariant against the new parent", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "grpuser4f", "password123", false)

		// Two independent, fully-completed groups.
		note, err := user.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
			Title: "Two Groups",
			Items: []client.CreateNoteItem{
				{Text: "Parent A", Position: 0, IndentLevel: 0, Completed: true},
				{Text: "Child A1", Position: 1, IndentLevel: 1, Completed: true},
				{Text: "Parent B", Position: 2, IndentLevel: 0, Completed: true},
				{Text: "Child B1", Position: 3, IndentLevel: 1, Completed: true},
			},
		})
		require.NoError(t, err)
		noteID := note.ID
		parentAID := itemByText(t, note.Items, "Parent A").ID
		parentBID := itemByText(t, note.Items, "Parent B").ID
		childA1ID := itemByText(t, note.Items, "Child A1").ID

		// Move Child A1 into Parent B's group and uncheck it in one request. The
		// invariant must be enforced against the group it ends up in (B), not
		// the one it's leaving (A).
		incomplete := false
		_, err = user.Client.UpdateNoteItem(t.Context(), noteID, childA1ID, &client.PatchNoteItemRequest{
			ParentID:  &parentBID,
			Completed: &incomplete,
		})
		require.NoError(t, err)

		updated, err := user.Client.GetNote(t.Context(), noteID)
		require.NoError(t, err)
		assert.False(t, itemByText(t, updated.Items, "Parent B").Completed, "new parent can't stay completed with an incomplete child")
		assert.True(t, itemByText(t, updated.Items, "Child B1").Completed, "unrelated sibling in the new group is untouched")
		assert.True(t, itemByText(t, updated.Items, "Parent A").Completed, "old parent is untouched: it has no children left")

		_ = parentAID
	})

	t.Run("toggle without completed field is rejected", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "grpuser5b", "password123", false)
		noteID, parentID, _, _, _ := createGroupNote(t, user)

		// An omitted "completed" must 400 rather than silently decode to false
		// and uncheck the item.
		url := ts.HTTPServer.URL + "/api/v1/notes/" + noteID + "/items/" + parentID + "/toggle-completed"
		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, url, strings.NewReader("{}"))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")

		resp, err := user.Client.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})

	t.Run("toggle unknown item returns 404", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "grpuser5", "password123", false)
		noteID, _, _, _, _ := createGroupNote(t, user)

		_, err := user.Client.ToggleNoteItemCompleted(t.Context(), noteID, "doesnotexist1234567890", true)
		require.Error(t, err)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
	})

	t.Run("reject grandchild parent reference", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "grpuser6", "password123", false)
		noteID, _, childAID, _, _ := createGroupNote(t, user)

		// Nesting a new item under a child (which already has a parent) would
		// create a grandchild, breaking the one-level cap.
		_, err := user.Client.CreateNoteItem(t.Context(), noteID, &client.CreateNoteItemRequest{
			Text:     "Grandchild",
			Position: 4,
			ParentID: childAID,
		})
		require.Error(t, err)
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("reject cross-note parent reference", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "grpuser7", "password123", false)
		noteID1, parentID1, _, _, _ := createGroupNote(t, user)

		note2, err := user.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
			Title: "Second",
			Items: []client.CreateNoteItem{{Text: "N2 item", Position: 0, IndentLevel: 0}},
		})
		require.NoError(t, err)

		_, err = user.Client.CreateNoteItem(t.Context(), note2.ID, &client.CreateNoteItemRequest{
			Text:     "Cross",
			Position: 1,
			ParentID: parentID1, // parent lives in note1, not note2
		})
		require.Error(t, err)
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))

		_ = noteID1
	})

	t.Run("reject self parent reference", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "grpuser8", "password123", false)
		noteID, _, _, _, soloID := createGroupNote(t, user)

		_, err := user.Client.UpdateNoteItem(t.Context(), noteID, soloID, &client.PatchNoteItemRequest{
			ParentID: &soloID,
		})
		require.Error(t, err)
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("reject nesting an item that has children", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "grpuser9", "password123", false)
		noteID, parentID, _, _, soloID := createGroupNote(t, user)

		// Re-parenting the parent (which has children) under another top-level
		// item would turn its children into grandchildren.
		_, err := user.Client.UpdateNoteItem(t.Context(), noteID, parentID, &client.PatchNoteItemRequest{
			ParentID: &soloID,
		})
		require.Error(t, err)
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("deleting a parent promotes children to top-level", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "grpuser10", "password123", false)
		noteID, parentID, childAID, childBID, _ := createGroupNote(t, user)

		require.NoError(t, user.Client.DeleteNoteItem(t.Context(), noteID, parentID))

		note, err := user.Client.GetNote(t.Context(), noteID)
		require.NoError(t, err)

		// Children survive (no data loss) and become top-level via ON DELETE SET NULL.
		childA := itemByText(t, note.Items, "Child A")
		childB := itemByText(t, note.Items, "Child B")
		assert.Nil(t, childA.ParentID, "orphaned child is promoted to top-level")
		assert.Nil(t, childB.ParentID, "orphaned child is promoted to top-level")
		assert.Equal(t, childAID, childA.ID)
		assert.Equal(t, childBID, childB.ID)
	})

	t.Run("re-parent a top-level item under another via patch", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "grpuser11", "password123", false)
		noteID, parentID, _, _, soloID := createGroupNote(t, user)

		updated, err := user.Client.UpdateNoteItem(t.Context(), noteID, soloID, &client.PatchNoteItemRequest{
			ParentID: &parentID,
		})
		require.NoError(t, err)
		require.NotNil(t, updated.ParentID)
		assert.Equal(t, parentID, *updated.ParentID)

		// Sending an empty parent_id makes it top-level again.
		empty := ""
		updated, err = user.Client.UpdateNoteItem(t.Context(), noteID, soloID, &client.PatchNoteItemRequest{
			ParentID: &empty,
		})
		require.NoError(t, err)
		assert.Nil(t, updated.ParentID)
	})

	t.Run("toggle on a non-list note is rejected", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "grpuser12", "password123", false)

		textNote, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
			Content: "just text",
		})
		require.NoError(t, err)

		_, err = user.Client.ToggleNoteItemCompleted(t.Context(), textNote.ID, "someitemid1234567890ab", true)
		require.Error(t, err)
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})
}
