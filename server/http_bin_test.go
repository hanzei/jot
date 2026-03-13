package main

import (
	"net/http"
	"testing"

	"github.com/hanzei/jot/server/internal/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// createAndTrashNote is a helper that creates a note and moves it to trash.
func createAndTrashNote(t *testing.T, ts *TestServer, user *TestUser, title string) models.Note {
	t.Helper()
	createResp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", map[string]any{
		"title":     title,
		"content":   "",
		"note_type": "text",
	})
	require.Equal(t, http.StatusCreated, createResp.StatusCode)
	var note models.Note
	require.NoError(t, createResp.UnmarshalBody(&note))

	delResp := ts.authRequest(t, user, http.MethodDelete, "/api/v1/notes/"+note.ID, nil)
	require.Equal(t, http.StatusNoContent, delResp.StatusCode)
	return note
}

func TestBinDeleteMovesToTrash(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "binuser1", "password123", false)

	createResp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", map[string]any{
		"title": "Bin Test Note", "content": "some content", "note_type": "text",
	})
	require.Equal(t, http.StatusCreated, createResp.StatusCode)
	var note models.Note
	require.NoError(t, createResp.UnmarshalBody(&note))

	delResp := ts.authRequest(t, user, http.MethodDelete, "/api/v1/notes/"+note.ID, nil)
	assert.Equal(t, http.StatusNoContent, delResp.StatusCode)

	// Note should not appear in active list.
	listResp := ts.authRequest(t, user, http.MethodGet, "/api/v1/notes", nil)
	require.Equal(t, http.StatusOK, listResp.StatusCode)
	var activeNotes []models.Note
	require.NoError(t, listResp.UnmarshalBody(&activeNotes))
	for _, n := range activeNotes {
		assert.NotEqual(t, note.ID, n.ID, "deleted note should not appear in active list")
	}
}

func TestBinTrashedNotesAppearInTrashList(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "binuser2", "password123", false)
	note := createAndTrashNote(t, ts, user, "Trashed Note")

	trashResp := ts.authRequest(t, user, http.MethodGet, "/api/v1/notes?trashed=true", nil)
	require.Equal(t, http.StatusOK, trashResp.StatusCode)
	var trashedNotes []models.Note
	require.NoError(t, trashResp.UnmarshalBody(&trashedNotes))

	found := false
	for _, n := range trashedNotes {
		if n.ID == note.ID {
			found = true
			assert.NotNil(t, n.DeletedAt, "deleted_at should be set")
			break
		}
	}
	assert.True(t, found, "trashed note should appear in trash list")
}

func TestBinRestoreMovesToActiveList(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "binuser3", "password123", false)
	note := createAndTrashNote(t, ts, user, "Restore Me")

	restoreResp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes/"+note.ID+"/restore", nil)
	assert.Equal(t, http.StatusOK, restoreResp.StatusCode)

	var restored models.Note
	require.NoError(t, restoreResp.UnmarshalBody(&restored))
	assert.Nil(t, restored.DeletedAt, "deleted_at should be cleared after restore")

	// Note should appear in the active list again.
	listResp := ts.authRequest(t, user, http.MethodGet, "/api/v1/notes", nil)
	require.Equal(t, http.StatusOK, listResp.StatusCode)
	var activeNotes []models.Note
	require.NoError(t, listResp.UnmarshalBody(&activeNotes))
	found := false
	for _, n := range activeNotes {
		if n.ID == note.ID {
			found = true
			break
		}
	}
	assert.True(t, found, "restored note should appear in active list")

	// Note should not appear in trash.
	trashResp := ts.authRequest(t, user, http.MethodGet, "/api/v1/notes?trashed=true", nil)
	require.Equal(t, http.StatusOK, trashResp.StatusCode)
	var trashedNotes []models.Note
	require.NoError(t, trashResp.UnmarshalBody(&trashedNotes))
	for _, n := range trashedNotes {
		assert.NotEqual(t, note.ID, n.ID, "restored note should not appear in trash")
	}
}

func TestBinPermanentDeleteRemovesNote(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "binuser4", "password123", false)
	note := createAndTrashNote(t, ts, user, "Delete Me Permanently")

	permDelResp := ts.authRequest(t, user, http.MethodDelete, "/api/v1/notes/"+note.ID+"/permanent", nil)
	assert.Equal(t, http.StatusNoContent, permDelResp.StatusCode)

	// Note should not appear in trash.
	trashResp := ts.authRequest(t, user, http.MethodGet, "/api/v1/notes?trashed=true", nil)
	require.Equal(t, http.StatusOK, trashResp.StatusCode)
	var trashedNotes []models.Note
	require.NoError(t, trashResp.UnmarshalBody(&trashedNotes))
	for _, n := range trashedNotes {
		assert.NotEqual(t, note.ID, n.ID)
	}
}

func TestBinRestoreNonTrashedReturns404(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "binuser5", "password123", false)

	createResp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", map[string]any{
		"title": "Active Note", "content": "", "note_type": "text",
	})
	require.Equal(t, http.StatusCreated, createResp.StatusCode)
	var note models.Note
	require.NoError(t, createResp.UnmarshalBody(&note))

	resp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes/"+note.ID+"/restore", nil)
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestBinPermanentDeleteNonTrashedReturns404(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "binuser6", "password123", false)

	createResp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", map[string]any{
		"title": "Active Note 2", "content": "", "note_type": "text",
	})
	require.Equal(t, http.StatusCreated, createResp.StatusCode)
	var note models.Note
	require.NoError(t, createResp.UnmarshalBody(&note))

	resp := ts.authRequest(t, user, http.MethodDelete, "/api/v1/notes/"+note.ID+"/permanent", nil)
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestBinNonOwnerCannotRestore(t *testing.T) {
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "binowner", "password123", false)
	other := ts.createTestUser(t, "binother", "password123", false)

	note := createAndTrashNote(t, ts, owner, "Owner Note")

	resp := ts.authRequest(t, other, http.MethodPost, "/api/v1/notes/"+note.ID+"/restore", nil)
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestBinNonOwnerCannotPermanentDelete(t *testing.T) {
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "binowner2", "password123", false)
	other := ts.createTestUser(t, "binother2", "password123", false)

	note := createAndTrashNote(t, ts, owner, "Owner Note 2")

	resp := ts.authRequest(t, other, http.MethodDelete, "/api/v1/notes/"+note.ID+"/permanent", nil)
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}
