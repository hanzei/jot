package main

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func createSharedTodoNote(t *testing.T, ts *TestServer, owner *TestUser, sharedWith *TestUser) (string, string) {
	t.Helper()

	body := map[string]any{
		"title":     "Shared Todo",
		"note_type": "todo",
		"items": []map[string]any{
			{"text": "Item 1", "position": 0, "indent_level": 0},
			{"text": "Item 2", "position": 1, "indent_level": 0},
		},
	}
	resp := ts.authRequest(t, owner, http.MethodPost, "/api/v1/notes", body)
	require.Equal(t, http.StatusCreated, resp.StatusCode)

	var note map[string]any
	require.NoError(t, resp.UnmarshalBody(&note))
	noteID := note["id"].(string)

	shareBody := map[string]string{"username": sharedWith.User.Username}
	shareResp := ts.authRequest(t, owner, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/share", noteID), shareBody)
	require.Equal(t, http.StatusOK, shareResp.StatusCode)

	return noteID, sharedWith.User.ID
}

func getNoteItems(t *testing.T, ts *TestServer, user *TestUser, noteID string) []map[string]any {
	t.Helper()
	resp := ts.authRequest(t, user, http.MethodGet, fmt.Sprintf("/api/v1/notes/%s", noteID), nil)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var note map[string]any
	require.NoError(t, resp.UnmarshalBody(&note))
	items, ok := note["items"].([]any)
	require.True(t, ok, "items should be an array")
	result := make([]map[string]any, len(items))
	for i, item := range items {
		result[i] = item.(map[string]any)
	}
	return result
}

func TestTaskAssignment(t *testing.T) {
	t.Run("create note items have empty assigned_to_user_id", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "user1", "password123", false)

		body := map[string]any{
			"title":     "Todo",
			"note_type": "todo",
			"items": []map[string]any{
				{"text": "Buy milk", "position": 0, "indent_level": 0},
			},
		}
		resp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", body)
		require.Equal(t, http.StatusCreated, resp.StatusCode)

		var note map[string]any
		require.NoError(t, resp.UnmarshalBody(&note))
		items := note["items"].([]any)
		item := items[0].(map[string]any)
		assert.Equal(t, "", item["assigned_to_user_id"])
	})

	t.Run("reject assignment on note creation", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "user1", "password123", false)

		body := map[string]any{
			"title":     "Todo",
			"note_type": "todo",
			"items": []map[string]any{
				{"text": "Buy milk", "position": 0, "indent_level": 0, "assigned_to_user_id": "someuser1234567890abcd"},
			},
		}
		resp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", body)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
		assert.Contains(t, resp.GetString(), "cannot assign items on note creation")
	})

	t.Run("assign item to shared user on update", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, collabID := createSharedTodoNote(t, ts, owner, collaborator)

		updateBody := map[string]any{
			"title":     "Shared Todo",
			"note_type": "todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to_user_id": collabID},
				{"text": "Item 2", "position": 1, "indent_level": 0},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPut, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		items := getNoteItems(t, ts, owner, noteID)
		assert.Equal(t, collabID, items[0]["assigned_to_user_id"])
		assert.Equal(t, "", items[1]["assigned_to_user_id"])
	})

	t.Run("self-assignment by owner", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, _ := createSharedTodoNote(t, ts, owner, collaborator)

		updateBody := map[string]any{
			"title": "Shared Todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to_user_id": owner.User.ID},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPut, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		items := getNoteItems(t, ts, owner, noteID)
		assert.Equal(t, owner.User.ID, items[0]["assigned_to_user_id"])
	})

	t.Run("reject assignment on unshared note", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)

		body := map[string]any{
			"title":     "Solo Todo",
			"note_type": "todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0},
			},
		}
		createResp := ts.authRequest(t, owner, http.MethodPost, "/api/v1/notes", body)
		require.Equal(t, http.StatusCreated, createResp.StatusCode)
		var note map[string]any
		require.NoError(t, createResp.UnmarshalBody(&note))
		noteID := note["id"].(string)

		updateBody := map[string]any{
			"title": "Solo Todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to_user_id": owner.User.ID},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPut, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
		assert.Contains(t, resp.GetString(), "cannot assign items on an unshared note")
	})

	t.Run("reject assignment to user without note access", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)
		outsider := ts.createTestUser(t, "outsider", "password123", false)

		noteID, _ := createSharedTodoNote(t, ts, owner, collaborator)

		updateBody := map[string]any{
			"title": "Shared Todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to_user_id": outsider.User.ID},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPut, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
		assert.Contains(t, resp.GetString(), "does not have access")
	})

	t.Run("reject assignment with invalid user ID format", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, _ := createSharedTodoNote(t, ts, owner, collaborator)

		updateBody := map[string]any{
			"title": "Shared Todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to_user_id": "short"},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPut, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
		assert.Contains(t, resp.GetString(), "invalid assigned_to_user_id format")
	})

	t.Run("completed items retain assignment", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, collabID := createSharedTodoNote(t, ts, owner, collaborator)

		updateBody := map[string]any{
			"title": "Shared Todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0, "completed": true, "assigned_to_user_id": collabID},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPut, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		items := getNoteItems(t, ts, owner, noteID)
		assert.True(t, items[0]["completed"].(bool))
		assert.Equal(t, collabID, items[0]["assigned_to_user_id"])
	})
}

func TestTaskAssignmentUnshareCleanup(t *testing.T) {
	t.Run("unshare clears unshared users assignments", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collab1 := ts.createTestUser(t, "collab1", "password123", false)
		collab2 := ts.createTestUser(t, "collab2", "password123", false)

		body := map[string]any{
			"title":     "Shared Todo",
			"note_type": "todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0},
				{"text": "Item 2", "position": 1, "indent_level": 0},
			},
		}
		createResp := ts.authRequest(t, owner, http.MethodPost, "/api/v1/notes", body)
		require.Equal(t, http.StatusCreated, createResp.StatusCode)
		var note map[string]any
		require.NoError(t, createResp.UnmarshalBody(&note))
		noteID := note["id"].(string)

		// Share with both collaborators
		ts.authRequest(t, owner, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/share", noteID), map[string]string{"username": "collab1"})
		ts.authRequest(t, owner, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/share", noteID), map[string]string{"username": "collab2"})

		// Assign items
		updateBody := map[string]any{
			"title": "Shared Todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to_user_id": collab1.User.ID},
				{"text": "Item 2", "position": 1, "indent_level": 0, "assigned_to_user_id": collab2.User.ID},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPut, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		// Unshare collab1 — only collab1's assignment should be cleared
		ts.authRequest(t, owner, http.MethodDelete, fmt.Sprintf("/api/v1/notes/%s/share", noteID), map[string]string{"username": "collab1"})

		items := getNoteItems(t, ts, owner, noteID)
		assert.Equal(t, "", items[0]["assigned_to_user_id"], "collab1's assignment should be cleared")
		assert.Equal(t, collab2.User.ID, items[1]["assigned_to_user_id"], "collab2's assignment should remain")
	})

	t.Run("unshare last collaborator clears all assignments including owner", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collab := ts.createTestUser(t, "collab", "password123", false)

		noteID, _ := createSharedTodoNote(t, ts, owner, collab)

		// Assign owner to an item
		updateBody := map[string]any{
			"title": "Shared Todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to_user_id": owner.User.ID},
				{"text": "Item 2", "position": 1, "indent_level": 0, "assigned_to_user_id": collab.User.ID},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPut, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		// Unshare the only collaborator — note becomes unshared, all assignments cleared
		ts.authRequest(t, owner, http.MethodDelete, fmt.Sprintf("/api/v1/notes/%s/share", noteID), map[string]string{"username": "collab"})

		items := getNoteItems(t, ts, owner, noteID)
		assert.Equal(t, "", items[0]["assigned_to_user_id"], "owner's self-assignment should be cleared")
		assert.Equal(t, "", items[1]["assigned_to_user_id"], "collab's assignment should be cleared")
	})
}

func TestTaskAssignmentUserDeletion(t *testing.T) {
	t.Run("deleting a user clears their assignments across all notes", func(t *testing.T) {
		ts := setupTestServer(t)
		admin := ts.createTestUser(t, "admin", "password123", true)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collab := ts.createTestUser(t, "collab", "password123", false)

		noteID, collabID := createSharedTodoNote(t, ts, owner, collab)

		// Assign collab to an item
		updateBody := map[string]any{
			"title": "Shared Todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to_user_id": collabID},
				{"text": "Item 2", "position": 1, "indent_level": 0},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPut, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		// Delete the collab user via admin API
		deleteResp := ts.authRequest(t, admin, http.MethodDelete, fmt.Sprintf("/api/v1/admin/users/%s", collabID), nil)
		require.Equal(t, http.StatusNoContent, deleteResp.StatusCode)

		// Verify assignments are cleared
		items := getNoteItems(t, ts, owner, noteID)
		assert.Equal(t, "", items[0]["assigned_to_user_id"], "deleted user's assignment should be cleared")
		assert.Equal(t, "", items[1]["assigned_to_user_id"])
	})
}
