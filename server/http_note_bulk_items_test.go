package main

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/sse"
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
		_, err := user.Client.SetNoteItemsCompleted(t.Context(), noteID, []string{parentID}, true)
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

		_, err := user.Client.SetNoteItemsCompleted(t.Context(), noteID, []string{parentID}, true)
		require.NoError(t, err)
		_, err = user.Client.SetNoteItemsCompleted(t.Context(), noteID, ids, false)
		require.NoError(t, err)

		items, err := user.Client.SetNoteItemsCompleted(t.Context(), noteID, ids, true)
		require.NoError(t, err)
		assert.True(t, itemByText(t, items, "Parent").Completed)
		assert.True(t, itemByText(t, items, "Child A").Completed)
		assert.True(t, itemByText(t, items, "Child B").Completed)
	})

	t.Run("set-completed repairs a parent whose children disagree with it", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "bulk1c", "password123", false)
		noteID, parentID, _, _, _ := createGroupNote(t, user)

		// Drift: a completed parent with incomplete children. Re-sending the
		// parent's current value must still cascade, as the old toggle endpoint
		// did, even though the parent's own row does not change.
		ts.exec(t, "UPDATE note_items SET completed = ? WHERE id = ?", true, parentID)

		items, err := user.Client.SetNoteItemsCompleted(t.Context(), noteID, []string{parentID}, true)
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
		_, err := owner.Client.SetNoteItemsCompleted(t.Context(), noteID, []string{parentID}, true)
		require.NoError(t, err)

		items, err := collaborator.Client.DeleteNoteItems(t.Context(), noteID, []string{parentID, childAID, childBID})
		require.NoError(t, err)
		require.Len(t, items, 1, "collaborator cleared the completed group")
		assert.Equal(t, "Solo", items[0].Text)
	})
}

// A bulk delete that removes nothing (every ID already gone, as on an offline
// client's replay) changes nothing, so it must not wake every collaborator
// with a note_updated. A delete that removes an item still does.
func TestDeleteNoteItemsPublishesOnlyWhenSomethingWasDeleted(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "bulkdelsseowner", "password123", false)
	collaborator := ts.createTestUser(t, "bulkdelssecollab", "password123", false)
	noteID, _, _, _, soloID := createGroupNote(t, owner)
	require.NoError(t, owner.Client.ShareNote(t.Context(), noteID, collaborator.User.ID))

	sseCtx, sseCancel := context.WithCancel(t.Context())
	t.Cleanup(sseCancel)
	ch, err := collaborator.Client.SubscribeSSE(sseCtx)
	require.NoError(t, err)

	isNoteUpdated := func(e client.SSEEvent) bool {
		return e.Type == string(sse.EventNoteUpdated) && e.NoteData != nil && e.NoteData.NoteID == noteID
	}

	missingID, err := models.GenerateID()
	require.NoError(t, err)
	items, err := owner.Client.DeleteNoteItems(t.Context(), noteID, []string{missingID})
	require.NoError(t, err)
	require.Len(t, items, 4, "nothing was deleted")
	_, found := waitForSSEEvent(ch, isNoteUpdated, 750*time.Millisecond)
	assert.False(t, found, "a delete that removed nothing should not publish note_updated")

	items, err = owner.Client.DeleteNoteItems(t.Context(), noteID, []string{soloID})
	require.NoError(t, err)
	require.Len(t, items, 3)
	_, found = waitForSSEEvent(ch, isNoteUpdated, 3*time.Second)
	assert.True(t, found, "a delete that removed an item should publish note_updated")
}
