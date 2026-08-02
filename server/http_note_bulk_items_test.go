package main

import (
	"net/http"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBulkNoteItemEndpoints(t *testing.T) {
	t.Parallel()
	t.Run("set-completed unchecks the given items and returns the full list", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "bulk1", "password123", false)
		noteID, parentID, childAID, childBID, _ := createGroupNote(t, user)

		// Completing the parent cascades to both children.
		_, err := user.Client.ToggleNoteItemCompleted(t.Context(), noteID, parentID, true)
		require.NoError(t, err)

		items, err := user.Client.SetNoteItemsCompleted(t.Context(), noteID, []string{parentID, childAID, childBID}, false)
		require.NoError(t, err)
		require.Len(t, items, 4, "returns the note's full item list")
		for _, it := range items {
			assert.False(t, it.Completed, "item %q should be unchecked", it.Text)
		}
	})

	t.Run("set-completed re-checks the given items (undo)", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "bulk1b", "password123", false)
		noteID, parentID, childAID, childBID, _ := createGroupNote(t, user)
		ids := []string{parentID, childAID, childBID}

		_, err := user.Client.ToggleNoteItemCompleted(t.Context(), noteID, parentID, true)
		require.NoError(t, err)
		_, err = user.Client.SetNoteItemsCompleted(t.Context(), noteID, ids, false)
		require.NoError(t, err)

		items, err := user.Client.SetNoteItemsCompleted(t.Context(), noteID, ids, true)
		require.NoError(t, err)
		assert.True(t, itemByText(t, items, "Parent").Completed)
		assert.True(t, itemByText(t, items, "Child A").Completed)
		assert.True(t, itemByText(t, items, "Child B").Completed)
	})

	t.Run("delete removes the given items and returns the remainder", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "bulk2", "password123", false)
		noteID, parentID, childAID, childBID, soloID := createGroupNote(t, user)

		items, err := user.Client.DeleteNoteItems(t.Context(), noteID, []string{parentID, childAID, childBID})
		require.NoError(t, err)
		require.Len(t, items, 1, "only the untouched Solo item remains")
		assert.Equal(t, "Solo", items[0].Text)
		assert.Equal(t, soloID, items[0].ID)
	})

	t.Run("delete keeps an incomplete parent when only a child ID is passed", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "bulk3", "password123", false)
		noteID, parentID, childAID, _, _ := createGroupNote(t, user)

		items, err := user.Client.DeleteNoteItems(t.Context(), noteID, []string{childAID})
		require.NoError(t, err)

		// Child A is gone; Parent, Child B and Solo survive.
		require.Len(t, items, 3)
		assert.Equal(t, parentID, itemByText(t, items, "Parent").ID)
		itemByText(t, items, "Child B")
		itemByText(t, items, "Solo")
	})

	t.Run("empty item list returns 400", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "bulk4", "password123", false)
		noteID, _, _, _, _ := createGroupNote(t, user)

		_, err := user.Client.SetNoteItemsCompleted(t.Context(), noteID, []string{}, false)
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))

		_, err = user.Client.DeleteNoteItems(t.Context(), noteID, []string{})
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("bulk ops reject a text note", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "bulk5", "password123", false)
		textNote, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
			Content: "just text",
		})
		require.NoError(t, err)

		_, err = user.Client.SetNoteItemsCompleted(t.Context(), textNote.ID, []string{"aaaaaaaaaaaaaaaaaaaaaa"}, false)
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))

		_, err = user.Client.DeleteNoteItems(t.Context(), textNote.ID, []string{"aaaaaaaaaaaaaaaaaaaaaa"})
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("bulk ops on another user's note return not found", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "bulkowner", "password123", false)
		other := ts.createTestUser(t, "bulkother", "password123", false)
		noteID, parentID, _, _, _ := createGroupNote(t, owner)

		_, err := other.Client.SetNoteItemsCompleted(t.Context(), noteID, []string{parentID}, false)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))

		_, err = other.Client.DeleteNoteItems(t.Context(), noteID, []string{parentID})
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
	})

	t.Run("a collaborator can clear completed items on a shared list", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "bulkshareowner", "password123", false)
		collaborator := ts.createTestUser(t, "bulksharecollab", "password123", false)
		noteID, parentID, childAID, childBID, _ := createGroupNote(t, owner)

		require.NoError(t, owner.Client.ShareNote(t.Context(), noteID, collaborator.User.ID))
		_, err := owner.Client.ToggleNoteItemCompleted(t.Context(), noteID, parentID, true)
		require.NoError(t, err)

		items, err := collaborator.Client.DeleteNoteItems(t.Context(), noteID, []string{parentID, childAID, childBID})
		require.NoError(t, err)
		require.Len(t, items, 1, "collaborator cleared the completed group")
		assert.Equal(t, "Solo", items[0].Text)
	})
}
