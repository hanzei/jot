package main

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// addLabelToNote is a test helper that creates/finds a label by name and attaches it to a note.
func addLabelToNote(t *testing.T, ts *TestServer, user *TestUser, noteID, labelName string) {
	t.Helper()
	body := map[string]string{"name": labelName}
	resp := ts.authRequest(t, user, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/labels", noteID), body)
	require.Equal(t, http.StatusOK, resp.StatusCode)
}

func TestGetNotesByLabel(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "labeluser", "password123", false)

	// Create notes
	createNote := func(title string) string {
		body := map[string]any{"title": title, "content": "content"}
		resp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", body)
		require.Equal(t, http.StatusCreated, resp.StatusCode)
		var note map[string]any
		require.NoError(t, resp.UnmarshalBody(&note))
		return note["id"].(string)
	}

	workNoteID := createNote("Work Note")
	personalNoteID := createNote("Personal Note")
	_ = createNote("Unlabeled Note")

	addLabelToNote(t, ts, user, workNoteID, "work")
	addLabelToNote(t, ts, user, personalNoteID, "personal")

	// Fetch label list to get label IDs
	labelsResp := ts.authRequest(t, user, http.MethodGet, "/api/v1/labels", nil)
	require.Equal(t, http.StatusOK, labelsResp.StatusCode)
	var labels []map[string]any
	require.NoError(t, labelsResp.UnmarshalBody(&labels))
	require.Len(t, labels, 2)

	labelIDByName := map[string]string{}
	for _, l := range labels {
		labelIDByName[l["name"].(string)] = l["id"].(string)
	}

	t.Run("filter by label returns only matching notes", func(t *testing.T) {
		resp := ts.authRequest(t, user, http.MethodGet,
			fmt.Sprintf("/api/v1/notes?label=%s", labelIDByName["work"]), nil)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var notes []map[string]any
		require.NoError(t, resp.UnmarshalBody(&notes))
		require.Len(t, notes, 1)
		assert.Equal(t, "Work Note", notes[0]["title"])
	})

	t.Run("filter by different label returns correct notes", func(t *testing.T) {
		resp := ts.authRequest(t, user, http.MethodGet,
			fmt.Sprintf("/api/v1/notes?label=%s", labelIDByName["personal"]), nil)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var notes []map[string]any
		require.NoError(t, resp.UnmarshalBody(&notes))
		require.Len(t, notes, 1)
		assert.Equal(t, "Personal Note", notes[0]["title"])
	})

	t.Run("no label param returns all notes", func(t *testing.T) {
		resp := ts.authRequest(t, user, http.MethodGet, "/api/v1/notes", nil)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var notes []map[string]any
		require.NoError(t, resp.UnmarshalBody(&notes))
		assert.Len(t, notes, 3)
	})

	t.Run("unknown label ID returns empty list", func(t *testing.T) {
		resp := ts.authRequest(t, user, http.MethodGet, "/api/v1/notes?label=nonexistentlabelid", nil)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var notes []map[string]any
		require.NoError(t, resp.UnmarshalBody(&notes))
		assert.Empty(t, notes)
	})

	t.Run("label from another user is not accessible", func(t *testing.T) {
		other := ts.createTestUser(t, "otheruser", "password123", false)
		otherNoteID := func() string {
			body := map[string]any{"title": "Other Note", "content": "content"}
			resp := ts.authRequest(t, other, http.MethodPost, "/api/v1/notes", body)
			require.Equal(t, http.StatusCreated, resp.StatusCode)
			var note map[string]any
			require.NoError(t, resp.UnmarshalBody(&note))
			return note["id"].(string)
		}()
		addLabelToNote(t, ts, other, otherNoteID, "work")

		// Fetch other user's labels
		labelsResp2 := ts.authRequest(t, other, http.MethodGet, "/api/v1/labels", nil)
		var otherLabels []map[string]any
		require.NoError(t, labelsResp2.UnmarshalBody(&otherLabels))
		require.NotEmpty(t, otherLabels)
		otherWorkLabelID := otherLabels[0]["id"].(string)

		// User 1 uses other user's label ID — should return no notes
		resp := ts.authRequest(t, user, http.MethodGet,
			fmt.Sprintf("/api/v1/notes?label=%s", otherWorkLabelID), nil)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var notes []map[string]any
		require.NoError(t, resp.UnmarshalBody(&notes))
		assert.Empty(t, notes)
	})

	t.Run("unauthenticated request returns 401", func(t *testing.T) {
		resp := ts.request(t, nil, http.MethodGet,
			fmt.Sprintf("/api/v1/notes?label=%s", labelIDByName["work"]), nil)
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	})
}
