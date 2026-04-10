package main

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// createAndTrashNote creates a note and moves it to trash.
func createAndTrashNote(t *testing.T, user *TestUser, content string) *client.Note {
	t.Helper()
	note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
		Content: content,
	})
	require.NoError(t, err)
	require.NoError(t, user.Client.DeleteNote(t.Context(), note.ID))
	return note
}

func countRowsByNoteID(t *testing.T, ts *TestServer, table string, noteID string) int {
	t.Helper()

	var query string
	switch table {
	case "note_items", "note_labels", "note_shares":
		query = fmt.Sprintf("SELECT COUNT(*) FROM %s WHERE note_id = ?", table)
	default:
		t.Fatalf("unsupported table %q", table)
	}

	var count int
	err := ts.Server.GetDB().QueryRow(query, noteID).Scan(&count)
	require.NoError(t, err)
	return count
}

func countNotesByID(t *testing.T, ts *TestServer, noteID string) int {
	t.Helper()

	var count int
	err := ts.Server.GetDB().QueryRow("SELECT COUNT(*) FROM notes WHERE id = ?", noteID).Scan(&count)
	require.NoError(t, err)
	return count
}

func TestBinDeleteMovesToTrash(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "binuser1", "password123", false)

	note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
		Content: "Bin Test Note",
	})
	require.NoError(t, err)

	require.NoError(t, user.Client.DeleteNote(t.Context(), note.ID))

	activeNotes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	for _, n := range activeNotes {
		assert.NotEqual(t, note.ID, n.ID, "deleted note should not appear in active list")
	}
}

func TestBinTrashedNotesAppearInTrashList(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "binuser2", "password123", false)
	note := createAndTrashNote(t, user, "Trashed Note")

	trashedNotes, err := user.Client.ListNotes(t.Context(), &client.ListNotesOptions{Trashed: true})
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
	user := ts.createTestUser(t, "binuser3", "password123", false)
	note := createAndTrashNote(t, user, "Restore Me")

	restored, err := user.Client.RestoreNote(t.Context(), note.ID)
	require.NoError(t, err)
	assert.Nil(t, restored.DeletedAt, "deleted_at should be cleared after restore")

	activeNotes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	found := false
	for _, n := range activeNotes {
		if n.ID == note.ID {
			found = true
			break
		}
	}
	assert.True(t, found, "restored note should appear in active list")

	trashedNotes, err := user.Client.ListNotes(t.Context(), &client.ListNotesOptions{Trashed: true})
	require.NoError(t, err)
	for _, n := range trashedNotes {
		assert.NotEqual(t, note.ID, n.ID, "restored note should not appear in trash")
	}
}

func TestBinPermanentDeleteRemovesNote(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "binuser4", "password123", false)
	note := createAndTrashNote(t, user, "Delete Me Permanently")

	require.NoError(t, user.Client.DeleteNotePermanently(t.Context(), note.ID))

	trashedNotes, err := user.Client.ListNotes(t.Context(), &client.ListNotesOptions{Trashed: true})
	require.NoError(t, err)
	for _, n := range trashedNotes {
		assert.NotEqual(t, note.ID, n.ID)
	}

	activeNotes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	for _, n := range activeNotes {
		assert.NotEqual(t, note.ID, n.ID)
	}
}

func TestBinRestoreNonTrashedReturns404(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "binuser5", "password123", false)

	note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
		Content: "Active Note",
	})
	require.NoError(t, err)

	_, err = user.Client.RestoreNote(t.Context(), note.ID)
	assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
}

func TestBinPermanentDeleteNonTrashedReturns404(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "binuser6", "password123", false)

	note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
		Content: "Active Note 2",
	})
	require.NoError(t, err)

	err = user.Client.DeleteNotePermanently(t.Context(), note.ID)
	assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
}

func TestBinNonOwnerCannotRestore(t *testing.T) {
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "binowner", "password123", false)
	other := ts.createTestUser(t, "binother", "password123", false)

	note := createAndTrashNote(t, owner, "Owner Note")

	_, err := other.Client.RestoreNote(t.Context(), note.ID)
	assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
}

func TestBinNonOwnerCannotPermanentDelete(t *testing.T) {
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "binowner2", "password123", false)
	other := ts.createTestUser(t, "binother2", "password123", false)

	note := createAndTrashNote(t, owner, "Owner Note 2")

	err := other.Client.DeleteNotePermanently(t.Context(), note.ID)
	assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
}

func TestBinEmptyTrashDeletesMultipleNotes(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "binempty1", "password123", false)

	first := createAndTrashNote(t, user, "First trashed note")
	second := createAndTrashNote(t, user, "Second trashed note")

	resp, err := user.Client.EmptyTrash(t.Context())
	require.NoError(t, err)
	assert.Equal(t, 2, resp.Deleted)

	trashedNotes, err := user.Client.ListNotes(t.Context(), &client.ListNotesOptions{Trashed: true})
	require.NoError(t, err)
	assert.Empty(t, trashedNotes)

	assert.Zero(t, countNotesByID(t, ts, first.ID))
	assert.Zero(t, countNotesByID(t, ts, second.ID))
}

func TestBinEmptyTrashWhenAlreadyEmptyReturnsZero(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "binempty2", "password123", false)

	resp, err := user.Client.EmptyTrash(t.Context())
	require.NoError(t, err)
	assert.Equal(t, 0, resp.Deleted)
}

func TestBinEmptyTrashCleansUpItemsLabelsAndShares(t *testing.T) {
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "binempty3", "password123", false)
	sharedWith := ts.createTestUser(t, "binempty4", "password123", false)

	note, err := owner.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
		Title: "List in trash",
		Items: []client.CreateNoteItem{
			{Text: "First item", Position: 0},
			{Text: "Second item", Position: 1},
		},
	})
	require.NoError(t, err)

	note, err = owner.Client.AddLabel(t.Context(), note.ID, "Cleanup label")
	require.NoError(t, err)
	require.Len(t, note.Labels, 1)

	require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, sharedWith.User.ID))
	require.NoError(t, owner.Client.DeleteNote(t.Context(), note.ID))

	assert.Equal(t, 2, countRowsByNoteID(t, ts, "note_items", note.ID))
	assert.Equal(t, 1, countRowsByNoteID(t, ts, "note_labels", note.ID))
	assert.Equal(t, 1, countRowsByNoteID(t, ts, "note_shares", note.ID))

	resp, err := owner.Client.EmptyTrash(t.Context())
	require.NoError(t, err)
	assert.Equal(t, 1, resp.Deleted)

	assert.Zero(t, countRowsByNoteID(t, ts, "note_items", note.ID))
	assert.Zero(t, countRowsByNoteID(t, ts, "note_labels", note.ID))
	assert.Zero(t, countRowsByNoteID(t, ts, "note_shares", note.ID))
	assert.Zero(t, countNotesByID(t, ts, note.ID))
}

func TestBinEmptyTrashDoesNotAffectOtherUsersTrashedNotes(t *testing.T) {
	ts := setupTestServer(t)
	userA := ts.createTestUser(t, "binempty5", "password123", false)
	userB := ts.createTestUser(t, "binempty6", "password123", false)

	userANote := createAndTrashNote(t, userA, "A trashed note")
	userBNote := createAndTrashNote(t, userB, "B trashed note")

	resp, err := userA.Client.EmptyTrash(t.Context())
	require.NoError(t, err)
	assert.Equal(t, 1, resp.Deleted)

	assert.Zero(t, countNotesByID(t, ts, userANote.ID))
	assert.Equal(t, 1, countNotesByID(t, ts, userBNote.ID))

	userBTrash, err := userB.Client.ListNotes(t.Context(), &client.ListNotesOptions{Trashed: true})
	require.NoError(t, err)
	require.Len(t, userBTrash, 1)
	assert.Equal(t, userBNote.ID, userBTrash[0].ID)
}
