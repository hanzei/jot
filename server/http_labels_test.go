package main

import (
	"context"
	"net/http"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetNotesByLabel(t *testing.T) {
	ts := setupTestServer(t)
	ctx := context.Background()
	user := ts.createTestUser(t, "labeluser", "password123", false)

	createNote := func(title string) string {
		t.Helper()
		note, err := user.Client.CreateNote(ctx, &client.CreateNoteRequest{
			Title: title, Content: "content",
		})
		require.NoError(t, err)
		return note.ID
	}

	workNoteID := createNote("Work Note")
	personalNoteID := createNote("Personal Note")
	_ = createNote("Unlabeled Note")

	_, err := user.Client.AddLabel(ctx, workNoteID, "work")
	require.NoError(t, err)
	_, err = user.Client.AddLabel(ctx, personalNoteID, "personal")
	require.NoError(t, err)

	labels, err := user.Client.ListLabels(ctx)
	require.NoError(t, err)
	require.Len(t, labels, 2)

	labelIDByName := map[string]string{}
	for _, l := range labels {
		labelIDByName[l.Name] = l.ID
	}

	t.Run("filter by label returns only matching notes", func(t *testing.T) {
		notes, err := user.Client.ListNotes(ctx, &client.ListNotesOptions{Label: labelIDByName["work"]})
		require.NoError(t, err)
		require.Len(t, notes, 1)
		assert.Equal(t, "Work Note", notes[0].Title)
	})

	t.Run("filter by different label returns correct notes", func(t *testing.T) {
		notes, err := user.Client.ListNotes(ctx, &client.ListNotesOptions{Label: labelIDByName["personal"]})
		require.NoError(t, err)
		require.Len(t, notes, 1)
		assert.Equal(t, "Personal Note", notes[0].Title)
	})

	t.Run("no label param returns all notes", func(t *testing.T) {
		notes, err := user.Client.ListNotes(ctx, nil)
		require.NoError(t, err)
		assert.Len(t, notes, 3)
	})

	t.Run("unknown label ID returns empty list", func(t *testing.T) {
		notes, err := user.Client.ListNotes(ctx, &client.ListNotesOptions{Label: "nonexistentlabelid"})
		require.NoError(t, err)
		assert.Empty(t, notes)
	})

	t.Run("label from another user is not accessible", func(t *testing.T) {
		other := ts.createTestUserCtx(ctx, t, "otheruser", "password123", false)
		otherNote, err := other.Client.CreateNote(ctx, &client.CreateNoteRequest{
			Title: "Other Note", Content: "content",
		})
		require.NoError(t, err)

		_, err = other.Client.AddLabel(ctx, otherNote.ID, "work")
		require.NoError(t, err)

		otherLabels, err := other.Client.ListLabels(ctx)
		require.NoError(t, err)
		require.NotEmpty(t, otherLabels)

		notes, err := user.Client.ListNotes(ctx, &client.ListNotesOptions{Label: otherLabels[0].ID})
		require.NoError(t, err)
		assert.Empty(t, notes)
	})

	t.Run("unauthenticated request returns 401", func(t *testing.T) {
		c := ts.newClient()
		_, err := c.ListNotes(ctx, &client.ListNotesOptions{Label: labelIDByName["work"]})
		assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
	})
}
