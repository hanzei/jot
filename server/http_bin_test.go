package main

import (
	"context"
	"net/http"
	"testing"

	"github.com/hanzei/jot/server/jotclient"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// createAndTrashNote creates a note and moves it to trash.
func createAndTrashNote(t *testing.T, _ *TestServer, user *TestUser, title string) *jotclient.Note {
	t.Helper()
	ctx := context.Background()
	note, err := user.Client.CreateNote(ctx, &jotclient.CreateNoteRequest{
		Title:    title,
		NoteType: jotclient.NoteTypeText,
	})
	require.NoError(t, err)
	require.NoError(t, user.Client.DeleteNote(ctx, note.ID))
	return note
}

func TestBinDeleteMovesToTrash(t *testing.T) {
	ts := setupTestServer(t)
	ctx := context.Background()
	user := ts.createTestUser(t, "binuser1", "password123", false)

	note, err := user.Client.CreateNote(ctx, &jotclient.CreateNoteRequest{
		Title: "Bin Test Note", Content: "some content", NoteType: jotclient.NoteTypeText,
	})
	require.NoError(t, err)

	require.NoError(t, user.Client.DeleteNote(ctx, note.ID))

	activeNotes, err := user.Client.ListNotes(ctx, nil)
	require.NoError(t, err)
	for _, n := range activeNotes {
		assert.NotEqual(t, note.ID, n.ID, "deleted note should not appear in active list")
	}
}

func TestBinTrashedNotesAppearInTrashList(t *testing.T) {
	ts := setupTestServer(t)
	ctx := context.Background()
	user := ts.createTestUser(t, "binuser2", "password123", false)
	note := createAndTrashNote(t, ts, user, "Trashed Note")

	trashedNotes, err := user.Client.ListNotes(ctx, &jotclient.ListNotesOptions{Trashed: true})
	require.NoError(t, err)

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
	ctx := context.Background()
	user := ts.createTestUser(t, "binuser3", "password123", false)
	note := createAndTrashNote(t, ts, user, "Restore Me")

	restored, err := user.Client.RestoreNote(ctx, note.ID)
	require.NoError(t, err)
	assert.Nil(t, restored.DeletedAt, "deleted_at should be cleared after restore")

	activeNotes, err := user.Client.ListNotes(ctx, nil)
	require.NoError(t, err)
	found := false
	for _, n := range activeNotes {
		if n.ID == note.ID {
			found = true
			break
		}
	}
	assert.True(t, found, "restored note should appear in active list")

	trashedNotes, err := user.Client.ListNotes(ctx, &jotclient.ListNotesOptions{Trashed: true})
	require.NoError(t, err)
	for _, n := range trashedNotes {
		assert.NotEqual(t, note.ID, n.ID, "restored note should not appear in trash")
	}
}

func TestBinPermanentDeleteRemovesNote(t *testing.T) {
	ts := setupTestServer(t)
	ctx := context.Background()
	user := ts.createTestUser(t, "binuser4", "password123", false)
	note := createAndTrashNote(t, ts, user, "Delete Me Permanently")

	require.NoError(t, user.Client.DeleteNotePermanently(ctx, note.ID))

	trashedNotes, err := user.Client.ListNotes(ctx, &jotclient.ListNotesOptions{Trashed: true})
	require.NoError(t, err)
	for _, n := range trashedNotes {
		assert.NotEqual(t, note.ID, n.ID)
	}

	activeNotes, err := user.Client.ListNotes(ctx, nil)
	require.NoError(t, err)
	for _, n := range activeNotes {
		assert.NotEqual(t, note.ID, n.ID)
	}
}

func TestBinRestoreNonTrashedReturns404(t *testing.T) {
	ts := setupTestServer(t)
	ctx := context.Background()
	user := ts.createTestUser(t, "binuser5", "password123", false)

	note, err := user.Client.CreateNote(ctx, &jotclient.CreateNoteRequest{
		Title: "Active Note", NoteType: jotclient.NoteTypeText,
	})
	require.NoError(t, err)

	_, err = user.Client.RestoreNote(ctx, note.ID)
	assert.Equal(t, http.StatusNotFound, jotclient.StatusCode(err))
}

func TestBinPermanentDeleteNonTrashedReturns404(t *testing.T) {
	ts := setupTestServer(t)
	ctx := context.Background()
	user := ts.createTestUser(t, "binuser6", "password123", false)

	note, err := user.Client.CreateNote(ctx, &jotclient.CreateNoteRequest{
		Title: "Active Note 2", NoteType: jotclient.NoteTypeText,
	})
	require.NoError(t, err)

	err = user.Client.DeleteNotePermanently(ctx, note.ID)
	assert.Equal(t, http.StatusNotFound, jotclient.StatusCode(err))
}

func TestBinNonOwnerCannotRestore(t *testing.T) {
	ts := setupTestServer(t)
	ctx := context.Background()
	owner := ts.createTestUser(t, "binowner", "password123", false)
	other := ts.createTestUser(t, "binother", "password123", false)

	note := createAndTrashNote(t, ts, owner, "Owner Note")

	_, err := other.Client.RestoreNote(ctx, note.ID)
	assert.Equal(t, http.StatusNotFound, jotclient.StatusCode(err))
}

func TestBinNonOwnerCannotPermanentDelete(t *testing.T) {
	ts := setupTestServer(t)
	ctx := context.Background()
	owner := ts.createTestUser(t, "binowner2", "password123", false)
	other := ts.createTestUser(t, "binother2", "password123", false)

	note := createAndTrashNote(t, ts, owner, "Owner Note 2")

	err := other.Client.DeleteNotePermanently(ctx, note.ID)
	assert.Equal(t, http.StatusNotFound, jotclient.StatusCode(err))
}
