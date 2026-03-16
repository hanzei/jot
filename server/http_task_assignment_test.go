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

	shareBody := map[string]string{"user_id": sharedWith.User.ID}
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
	t.Run("create note items have empty assigned_to", func(t *testing.T) {
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
		assert.Empty(t, item["assigned_to"])
	})

	t.Run("assigned_to is ignored on note creation", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "user1", "password123", false)

		body := map[string]any{
			"title":     "Todo",
			"note_type": "todo",
			"items": []map[string]any{
				{"text": "Buy milk", "position": 0, "indent_level": 0, "assigned_to": "someuser1234567890abcd"},
			},
		}
		resp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", body)
		require.Equal(t, http.StatusCreated, resp.StatusCode)

		var note map[string]any
		require.NoError(t, resp.UnmarshalBody(&note))
		items := note["items"].([]any)
		item := items[0].(map[string]any)
		assert.Empty(t, item["assigned_to"], "assigned_to should be ignored on create")
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
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to": collabID},
				{"text": "Item 2", "position": 1, "indent_level": 0},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPatch, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		items := getNoteItems(t, ts, owner, noteID)
		assert.Equal(t, collabID, items[0]["assigned_to"])
		assert.Empty(t, items[1]["assigned_to"])
	})

	t.Run("self-assignment by owner", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, _ := createSharedTodoNote(t, ts, owner, collaborator)

		updateBody := map[string]any{
			"title": "Shared Todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to": owner.User.ID},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPatch, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		items := getNoteItems(t, ts, owner, noteID)
		assert.Equal(t, owner.User.ID, items[0]["assigned_to"])
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
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to": owner.User.ID},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPatch, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
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
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to": outsider.User.ID},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPatch, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
		assert.Contains(t, resp.GetString(), "assigned user does not have access")
	})

	t.Run("reject assignment with invalid user ID format", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, _ := createSharedTodoNote(t, ts, owner, collaborator)

		updateBody := map[string]any{
			"title": "Shared Todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to": "short"},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPatch, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
		assert.Contains(t, resp.GetString(), "invalid assigned_to format")
	})

	t.Run("collaborator can assign items", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, _ := createSharedTodoNote(t, ts, owner, collaborator)

		updateBody := map[string]any{
			"title": "Shared Todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to": owner.User.ID},
				{"text": "Item 2", "position": 1, "indent_level": 0},
			},
		}
		resp := ts.authRequest(t, collaborator, http.MethodPatch, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		items := getNoteItems(t, ts, owner, noteID)
		assert.Equal(t, owner.User.ID, items[0]["assigned_to"])
	})

	t.Run("unassign item by setting empty assigned_to", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, collabID := createSharedTodoNote(t, ts, owner, collaborator)

		// First assign
		updateBody := map[string]any{
			"title": "Shared Todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to": collabID},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPatch, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		items := getNoteItems(t, ts, owner, noteID)
		assert.Equal(t, collabID, items[0]["assigned_to"])

		// Now unassign
		unassignBody := map[string]any{
			"title": "Shared Todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to": ""},
			},
		}
		resp = ts.authRequest(t, owner, http.MethodPatch, fmt.Sprintf("/api/v1/notes/%s", noteID), unassignBody)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		items = getNoteItems(t, ts, owner, noteID)
		assert.Empty(t, items[0]["assigned_to"])
	})

	t.Run("completed items retain assignment", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, collabID := createSharedTodoNote(t, ts, owner, collaborator)

		updateBody := map[string]any{
			"title": "Shared Todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0, "completed": true, "assigned_to": collabID},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPatch, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		items := getNoteItems(t, ts, owner, noteID)
		assert.True(t, items[0]["completed"].(bool))
		assert.Equal(t, collabID, items[0]["assigned_to"])
	})
}

func TestMyTodoFilter(t *testing.T) {
	t.Run("returns notes with items assigned to current user", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, collabID := createSharedTodoNote(t, ts, owner, collaborator)

		updateBody := map[string]any{
			"title": "Shared Todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to": collabID},
				{"text": "Item 2", "position": 1, "indent_level": 0},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPatch, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		resp = ts.authRequest(t, collaborator, http.MethodGet, "/api/v1/notes?my_todo=true", nil)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		var notes []map[string]any
		require.NoError(t, resp.UnmarshalBody(&notes))
		require.Len(t, notes, 1)
		assert.Equal(t, noteID, notes[0]["id"])
	})

	t.Run("does not return notes without assignments to current user", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, _ := createSharedTodoNote(t, ts, owner, collaborator)

		updateBody := map[string]any{
			"title": "Shared Todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to": owner.User.ID},
				{"text": "Item 2", "position": 1, "indent_level": 0},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPatch, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		resp = ts.authRequest(t, collaborator, http.MethodGet, "/api/v1/notes?my_todo=true", nil)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		var notes []map[string]any
		require.NoError(t, resp.UnmarshalBody(&notes))
		assert.Empty(t, notes)
	})

	t.Run("returns empty list when no assignments exist", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)

		body := map[string]any{
			"title":     "Solo Todo",
			"note_type": "todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPost, "/api/v1/notes", body)
		require.Equal(t, http.StatusCreated, resp.StatusCode)

		resp = ts.authRequest(t, owner, http.MethodGet, "/api/v1/notes?my_todo=true", nil)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		var notes []map[string]any
		require.NoError(t, resp.UnmarshalBody(&notes))
		assert.Empty(t, notes)
	})

	t.Run("owner sees own assignments in my_todo filter", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, _ := createSharedTodoNote(t, ts, owner, collaborator)

		updateBody := map[string]any{
			"title": "Shared Todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to": owner.User.ID},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPatch, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		resp = ts.authRequest(t, owner, http.MethodGet, "/api/v1/notes?my_todo=true", nil)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		var notes []map[string]any
		require.NoError(t, resp.UnmarshalBody(&notes))
		require.Len(t, notes, 1)
		assert.Equal(t, noteID, notes[0]["id"])
	})

	t.Run("excludes trashed notes from my_todo filter", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, collabID := createSharedTodoNote(t, ts, owner, collaborator)

		updateBody := map[string]any{
			"title": "Shared Todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to": collabID},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPatch, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		resp = ts.authRequest(t, owner, http.MethodDelete, fmt.Sprintf("/api/v1/notes/%s", noteID), nil)
		require.Equal(t, http.StatusNoContent, resp.StatusCode)

		resp = ts.authRequest(t, collaborator, http.MethodGet, "/api/v1/notes?my_todo=true", nil)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		var notes []map[string]any
		require.NoError(t, resp.UnmarshalBody(&notes))
		assert.Empty(t, notes)
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
		ts.authRequest(t, owner, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/share", noteID), map[string]string{"user_id": collab1.User.ID})
		ts.authRequest(t, owner, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/share", noteID), map[string]string{"user_id": collab2.User.ID})

		// Assign items
		updateBody := map[string]any{
			"title": "Shared Todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to": collab1.User.ID},
				{"text": "Item 2", "position": 1, "indent_level": 0, "assigned_to": collab2.User.ID},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPatch, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		// Unshare collab1 — only collab1's assignment should be cleared
		ts.authRequest(t, owner, http.MethodDelete, fmt.Sprintf("/api/v1/notes/%s/share", noteID), map[string]string{"user_id": collab1.User.ID})

		items := getNoteItems(t, ts, owner, noteID)
		assert.Empty(t, items[0]["assigned_to"], "collab1's assignment should be cleared")
		assert.Equal(t, collab2.User.ID, items[1]["assigned_to"], "collab2's assignment should remain")
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
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to": owner.User.ID},
				{"text": "Item 2", "position": 1, "indent_level": 0, "assigned_to": collab.User.ID},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPatch, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		// Unshare the only collaborator — note becomes unshared, all assignments cleared
		ts.authRequest(t, owner, http.MethodDelete, fmt.Sprintf("/api/v1/notes/%s/share", noteID), map[string]string{"user_id": collab.User.ID})

		items := getNoteItems(t, ts, owner, noteID)
		assert.Empty(t, items[0]["assigned_to"], "owner's self-assignment should be cleared")
		assert.Empty(t, items[1]["assigned_to"], "collab's assignment should be cleared")
	})
}

func TestTaskAssignmentUserDeletion(t *testing.T) {
	t.Run("deleting a user clears their assignments across all notes", func(t *testing.T) {
		ts := setupTestServer(t)
		admin := ts.createTestUser(t, "admin", "password123", true)
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

		// Share with both collaborators so the note stays shared after one is deleted
		ts.authRequest(t, owner, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/share", noteID), map[string]string{"user_id": collab1.User.ID})
		ts.authRequest(t, owner, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/share", noteID), map[string]string{"user_id": collab2.User.ID})

		// Assign collab1 to item 1, collab2 to item 2
		updateBody := map[string]any{
			"title": "Shared Todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to": collab1.User.ID},
				{"text": "Item 2", "position": 1, "indent_level": 0, "assigned_to": collab2.User.ID},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPatch, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		// Delete collab1 — only collab1's assignment cleared; note still shared with collab2
		deleteResp := ts.authRequest(t, admin, http.MethodDelete, fmt.Sprintf("/api/v1/admin/users/%s", collab1.User.ID), nil)
		require.Equal(t, http.StatusNoContent, deleteResp.StatusCode)

		items := getNoteItems(t, ts, owner, noteID)
		assert.Empty(t, items[0]["assigned_to"], "deleted user's assignment should be cleared")
		assert.Equal(t, collab2.User.ID, items[1]["assigned_to"], "other collab's assignment should remain")
	})

	t.Run("deleting last collaborator clears all assignments including owner self-assignment", func(t *testing.T) {
		ts := setupTestServer(t)
		admin := ts.createTestUser(t, "admin", "password123", true)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collab := ts.createTestUser(t, "collab", "password123", false)

		noteID, collabID := createSharedTodoNote(t, ts, owner, collab)

		// Assign owner to item 1, collab to item 2
		updateBody := map[string]any{
			"title": "Shared Todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0, "indent_level": 0, "assigned_to": owner.User.ID},
				{"text": "Item 2", "position": 1, "indent_level": 0, "assigned_to": collabID},
			},
		}
		resp := ts.authRequest(t, owner, http.MethodPatch, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		// Delete the only collaborator — note becomes unshared, all assignments must be cleared
		deleteResp := ts.authRequest(t, admin, http.MethodDelete, fmt.Sprintf("/api/v1/admin/users/%s", collabID), nil)
		require.Equal(t, http.StatusNoContent, deleteResp.StatusCode)

		items := getNoteItems(t, ts, owner, noteID)
		assert.Empty(t, items[0]["assigned_to"], "owner's self-assignment should be cleared when note becomes unshared")
		assert.Empty(t, items[1]["assigned_to"], "deleted collab's assignment should be cleared")
	})
}
