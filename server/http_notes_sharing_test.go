package main

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Note sharing endpoint tests
func TestNoteSharingEndpoints(t *testing.T) {
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "owner", "password123", false)
	sharedUser := ts.createTestUser(t, "user", "password123", false)
	other := ts.createTestUser(t, "other", "password123", false)

	// Create a note to share
	body := map[string]any{
		"title":   "Shared Note",
		"content": "This will be shared",
	}
	createResp := ts.authRequest(t, owner, http.MethodPost, "/api/v1/notes", body)
	var createdNote map[string]any
	require.NoError(t, createResp.UnmarshalBody(&createdNote))
	noteID := createdNote["id"].(string)
	missingNoteID := "abcdefghijklmnopqrstuv"

	t.Run("share note with user_id", func(t *testing.T) {
		shareBody := map[string]string{
			"user_id": sharedUser.User.ID,
		}

		resp := ts.authRequest(t, owner, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/share", noteID), shareBody)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var response map[string]any
		require.NoError(t, resp.UnmarshalBody(&response))
		assert.True(t, response["success"].(bool))
	})

	t.Run("share with duplicate user returns conflict", func(t *testing.T) {
		// First share with other user
		shareBody := map[string]string{
			"username": "other",
		}
		resp1 := ts.authRequest(t, owner, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/share", noteID), shareBody)
		assert.Equal(t, http.StatusOK, resp1.StatusCode)

		// Try to share again with the same user - should return conflict
		resp := ts.authRequest(t, owner, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/share", noteID), shareBody)
		assert.Equal(t, http.StatusConflict, resp.StatusCode)
	})

	t.Run("share nonexistent note returns not found", func(t *testing.T) {
		shareBody := map[string]string{
			"user_id": sharedUser.User.ID,
		}

		resp := ts.authRequest(t, owner, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/share", missingNoteID), shareBody)
		assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	})

	t.Run("share with nonexistent username returns not found", func(t *testing.T) {
		shareBody := map[string]string{
			"username": "nonexistent",
		}

		resp := ts.authRequest(t, owner, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/share", noteID), shareBody)
		assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	})

	t.Run("share with empty payload returns bad request", func(t *testing.T) {
		shareBody := map[string]string{
			"username": "",
		}

		resp := ts.authRequest(t, owner, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/share", noteID), shareBody)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
		assert.Contains(t, resp.GetString(), "either user_id or username is required")
	})

	t.Run("share with invalid user_id returns bad request", func(t *testing.T) {
		shareBody := map[string]string{
			"user_id": "invalid-id",
		}

		resp := ts.authRequest(t, owner, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/share", noteID), shareBody)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
		assert.Contains(t, resp.GetString(), "invalid user_id format")
	})

	t.Run("share with self returns bad request", func(t *testing.T) {
		shareBody := map[string]string{
			"username": "owner",
		}

		resp := ts.authRequest(t, owner, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/share", noteID), shareBody)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
		assert.Contains(t, resp.GetString(), "cannot share with self")
	})

	t.Run("share by non-owner returns forbidden", func(t *testing.T) {
		shareBody := map[string]string{
			"username": "other",
		}

		resp := ts.authRequest(t, other, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/share", noteID), shareBody)
		assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	})

	t.Run("get note shares", func(t *testing.T) {
		resp := ts.authRequest(t, owner, http.MethodGet, fmt.Sprintf("/api/v1/notes/%s/shares", noteID), nil)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var shares []any
		require.NoError(t, resp.UnmarshalBody(&shares))
		assert.GreaterOrEqual(t, len(shares), 1)
	})

	t.Run("get note shares by non-owner returns forbidden", func(t *testing.T) {
		resp := ts.authRequest(t, other, http.MethodGet, fmt.Sprintf("/api/v1/notes/%s/shares", noteID), nil)
		assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	})

	t.Run("get shares for nonexistent note returns not found", func(t *testing.T) {
		resp := ts.authRequest(t, owner, http.MethodGet, fmt.Sprintf("/api/v1/notes/%s/shares", missingNoteID), nil)
		assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	})

	t.Run("unshare note by user_id", func(t *testing.T) {
		unshareBody := map[string]string{
			"user_id": sharedUser.User.ID,
		}

		resp := ts.authRequest(t, owner, http.MethodDelete, fmt.Sprintf("/api/v1/notes/%s/share", noteID), unshareBody)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var response map[string]any
		require.NoError(t, resp.UnmarshalBody(&response))
		assert.True(t, response["success"].(bool))
	})

	t.Run("unshare non-shared user returns not found", func(t *testing.T) {
		unshareBody := map[string]string{
			"user_id": sharedUser.User.ID, // Already unshared
		}

		resp := ts.authRequest(t, owner, http.MethodDelete, fmt.Sprintf("/api/v1/notes/%s/share", noteID), unshareBody)
		assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	})

	t.Run("unshare nonexistent note returns not found", func(t *testing.T) {
		unshareBody := map[string]string{
			"user_id": sharedUser.User.ID,
		}

		resp := ts.authRequest(t, owner, http.MethodDelete, fmt.Sprintf("/api/v1/notes/%s/share", missingNoteID), unshareBody)
		assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	})

	t.Run("share trashed note returns not found", func(t *testing.T) {
		createBody := map[string]any{
			"title":   "Will be trashed",
			"content": "trashed",
		}
		createResp := ts.authRequest(t, owner, http.MethodPost, "/api/v1/notes", createBody)
		require.Equal(t, http.StatusCreated, createResp.StatusCode)

		var trashedNote map[string]any
		require.NoError(t, createResp.UnmarshalBody(&trashedNote))
		trashedNoteID := trashedNote["id"].(string)

		deleteResp := ts.authRequest(t, owner, http.MethodDelete, fmt.Sprintf("/api/v1/notes/%s", trashedNoteID), nil)
		require.Equal(t, http.StatusNoContent, deleteResp.StatusCode)

		shareBody := map[string]string{
			"user_id": sharedUser.User.ID,
		}
		shareResp := ts.authRequest(t, owner, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/share", trashedNoteID), shareBody)
		assert.Equal(t, http.StatusNotFound, shareResp.StatusCode)
	})
}

func TestSearchUsersEndpoint(t *testing.T) {
	ts := setupTestServer(t)
	user1 := ts.createTestUser(t, "user1", "password123", false)
	_ = ts.createTestUser(t, "user2", "password123", false)
	_ = ts.createTestUser(t, "admin", "password123", true)

	t.Run("search users returns all except current user", func(t *testing.T) {
		resp := ts.authRequest(t, user1, http.MethodGet, "/api/v1/users", nil)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var users []map[string]any
		require.NoError(t, resp.UnmarshalBody(&users))
		assert.Len(t, users, 2)

		// Check that current user is not in results
		for _, user := range users {
			assert.NotEqual(t, "user1", user["username"], "Should not include current user in results")
		}

		// Check that response doesn't include passwords
		for _, user := range users {
			assert.NotContains(t, user, "password", "User response should not include password")
			assert.NotContains(t, user, "password_hash", "User response should not include password_hash")
		}
	})

	t.Run("search users without auth returns unauthorized", func(t *testing.T) {
		resp := ts.request(t, nil, http.MethodGet, "/api/v1/users", nil)
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	})
}

func TestEdgeCases(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "user", "password123", false)

	t.Run("invalid note ID returns bad request", func(t *testing.T) {
		resp := ts.authRequest(t, user, http.MethodGet, "/api/v1/notes/invalid", nil)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})

	t.Run("nonexistent note ID returns bad request", func(t *testing.T) {
		resp := ts.authRequest(t, user, http.MethodGet, "/api/v1/notes/999", nil)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})

	t.Run("valid but nonexistent note ID returns not found", func(t *testing.T) {
		// Use a valid 22-character ID format that doesn't exist
		resp := ts.authRequest(t, user, http.MethodGet, "/api/v1/notes/abcdefghijklmnopqrstuv", nil)
		assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	})

	t.Run("create note with empty fields", func(t *testing.T) {
		body := map[string]any{
			"title":   "",
			"content": "",
		}

		resp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", body)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
		assert.Contains(t, resp.GetString(), "empty note")
	})

	t.Run("create note with todo items", func(t *testing.T) {
		body := map[string]any{
			"title":     "Todo List",
			"content":   "",
			"note_type": "todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0},
				{"text": "Item 2", "position": 1},
			},
		}

		resp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", body)
		assert.Equal(t, http.StatusCreated, resp.StatusCode)

		var note map[string]any
		require.NoError(t, resp.UnmarshalBody(&note))
		assert.Equal(t, "todo", note["note_type"])
	})

	t.Run("create note with items defaults note_type to todo", func(t *testing.T) {
		body := map[string]any{
			"title":   "Implicit Todo",
			"content": "",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0},
			},
		}

		resp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", body)
		assert.Equal(t, http.StatusCreated, resp.StatusCode)

		var note map[string]any
		require.NoError(t, resp.UnmarshalBody(&note))
		assert.Equal(t, "todo", note["note_type"])
		items, ok := note["items"].([]any)
		require.True(t, ok)
		assert.Len(t, items, 1)
	})

	t.Run("create note rejects non-todo note_type when items are provided", func(t *testing.T) {
		body := map[string]any{
			"title":     "Conflicting Note Type",
			"content":   "",
			"note_type": "text",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0},
			},
		}

		resp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", body)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
		assert.Contains(t, resp.GetString(), "note_type must be 'todo' when items are provided")
	})

	t.Run("update note with default color", func(t *testing.T) {
		// Create note first
		createBody := map[string]any{
			"title":   "Test Note",
			"content": "Content",
		}
		createResp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", createBody)
		var createdNote map[string]any
		require.NoError(t, createResp.UnmarshalBody(&createdNote))
		noteID := createdNote["id"].(string)

		updateBody := map[string]any{
			"title":    "Updated",
			"content":  "Updated",
			"pinned":   false,
			"archived": false,
			"color":    "", // Empty color should default to #ffffff
		}

		resp := ts.authRequest(t, user, http.MethodPut, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var updatedNote map[string]any
		require.NoError(t, resp.UnmarshalBody(&updatedNote))

		assert.Equal(t, "#ffffff", updatedNote["color"])
	})
}
