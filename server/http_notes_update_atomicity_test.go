package main

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUpdateNoteRejectsInvalidItemsWithoutPartialWrite(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "atomicity_user", "password123", false)

	createBody := map[string]any{
		"title":     "Original title",
		"content":   "",
		"note_type": "todo",
		"items": []map[string]any{
			{"text": "item one", "position": 0, "indent_level": 0},
			{"text": "item two", "position": 1, "indent_level": 1},
		},
	}
	createResp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", createBody)
	require.Equal(t, http.StatusCreated, createResp.StatusCode)

	var createdNote map[string]any
	require.NoError(t, createResp.UnmarshalBody(&createdNote))
	noteID := createdNote["id"].(string)

	updateBody := map[string]any{
		"title":                   "Updated title should not persist",
		"content":                 "",
		"pinned":                  false,
		"archived":                false,
		"color":                   "#ffffff",
		"checked_items_collapsed": false,
		"items": []map[string]any{
			{"text": "still valid", "position": 0, "completed": false, "indent_level": 0},
			{"text": "invalid indent", "position": 1, "completed": false, "indent_level": 2},
		},
	}

	updateResp := ts.authRequest(t, user, http.MethodPut, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
	require.Equal(t, http.StatusBadRequest, updateResp.StatusCode)

	getResp := ts.authRequest(t, user, http.MethodGet, fmt.Sprintf("/api/v1/notes/%s", noteID), nil)
	require.Equal(t, http.StatusOK, getResp.StatusCode)

	var fetched map[string]any
	require.NoError(t, getResp.UnmarshalBody(&fetched))
	assert.Equal(t, "Original title", fetched["title"])

	items, ok := fetched["items"].([]any)
	require.True(t, ok)
	require.Len(t, items, 2)
	assert.Equal(t, "item one", items[0].(map[string]any)["text"])
	assert.Equal(t, "item two", items[1].(map[string]any)["text"])
}
