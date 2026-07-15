package main

import (
	"net/http"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBulkNoteItemEndpoints(t *testing.T) {
	t.Run("uncheck-all clears every completed item and returns the full list", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "bulk1", "password123", false)
		noteID, parentID, _, _, _ := createGroupNote(t, user)

		// Completing the parent cascades to both children.
		_, err := user.Client.ToggleNoteItemCompleted(t.Context(), noteID, parentID, true)
		require.NoError(t, err)

		items, err := user.Client.UncheckAllNoteItems(t.Context(), noteID)
		require.NoError(t, err)
		require.Len(t, items, 4, "returns the note's full item list")
		for _, it := range items {
			assert.False(t, it.Completed, "item %q should be unchecked", it.Text)
		}
	})

	t.Run("delete-completed removes completed items and returns the remainder", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "bulk2", "password123", false)
		noteID, parentID, _, _, soloID := createGroupNote(t, user)

		// Complete the whole parent group; Solo stays incomplete.
		_, err := user.Client.ToggleNoteItemCompleted(t.Context(), noteID, parentID, true)
		require.NoError(t, err)

		items, err := user.Client.DeleteCompletedNoteItems(t.Context(), noteID)
		require.NoError(t, err)
		require.Len(t, items, 1, "only the incomplete Solo item remains")
		assert.Equal(t, "Solo", items[0].Text)
		assert.Equal(t, soloID, items[0].ID)
	})

	t.Run("delete-completed keeps an incomplete parent of a completed child", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "bulk3", "password123", false)
		noteID, parentID, childAID, _, _ := createGroupNote(t, user)

		// Completing a child does not complete its parent.
		_, err := user.Client.ToggleNoteItemCompleted(t.Context(), noteID, childAID, true)
		require.NoError(t, err)

		items, err := user.Client.DeleteCompletedNoteItems(t.Context(), noteID)
		require.NoError(t, err)

		// Child A is gone; Parent, Child B and Solo survive.
		require.Len(t, items, 3)
		parent := itemByText(t, items, "Parent")
		assert.False(t, parent.Completed)
		assert.Equal(t, parentID, parent.ID)
		itemByText(t, items, "Child B")
		itemByText(t, items, "Solo")
	})

	t.Run("bulk ops are idempotent when nothing is completed", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "bulk4", "password123", false)
		noteID, _, _, _, _ := createGroupNote(t, user)

		items, err := user.Client.UncheckAllNoteItems(t.Context(), noteID)
		require.NoError(t, err)
		assert.Len(t, items, 4)

		items, err = user.Client.DeleteCompletedNoteItems(t.Context(), noteID)
		require.NoError(t, err)
		assert.Len(t, items, 4, "nothing completed, nothing deleted")
	})

	t.Run("bulk ops reject a text note", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "bulk5", "password123", false)
		textNote, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
			Content: "just text",
		})
		require.NoError(t, err)

		_, err = user.Client.UncheckAllNoteItems(t.Context(), textNote.ID)
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))

		_, err = user.Client.DeleteCompletedNoteItems(t.Context(), textNote.ID)
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("bulk ops on another user's note return not found", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "bulkowner", "password123", false)
		other := ts.createTestUser(t, "bulkother", "password123", false)
		noteID, _, _, _, _ := createGroupNote(t, owner)

		_, err := other.Client.UncheckAllNoteItems(t.Context(), noteID)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))

		_, err = other.Client.DeleteCompletedNoteItems(t.Context(), noteID)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
	})

	t.Run("a collaborator can clear completed items on a shared list", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "bulkshareowner", "password123", false)
		collaborator := ts.createTestUser(t, "bulksharecollab", "password123", false)
		noteID, parentID, _, _, _ := createGroupNote(t, owner)

		require.NoError(t, owner.Client.ShareNote(t.Context(), noteID, collaborator.User.ID))
		_, err := owner.Client.ToggleNoteItemCompleted(t.Context(), noteID, parentID, true)
		require.NoError(t, err)

		items, err := collaborator.Client.DeleteCompletedNoteItems(t.Context(), noteID)
		require.NoError(t, err)
		require.Len(t, items, 1, "collaborator cleared the completed group")
		assert.Equal(t, "Solo", items[0].Text)
	})
}
