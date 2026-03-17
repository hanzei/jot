package main

import (
	"net/http"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetNotesByLabel(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "labeluser", "password123", false)

	createNote := func(title string) string {
		t.Helper()
		note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title: title, Content: "content",
		})
		require.NoError(t, err)
		return note.ID
	}

	workNoteID := createNote("Work Note")
	personalNoteID := createNote("Personal Note")
	_ = createNote("Unlabeled Note")

	_, err := user.Client.AddLabel(t.Context(), workNoteID, "work")
	require.NoError(t, err)
	_, err = user.Client.AddLabel(t.Context(), personalNoteID, "personal")
	require.NoError(t, err)

	labels, err := user.Client.ListLabels(t.Context())
	require.NoError(t, err)
	require.Len(t, labels, 2)

	labelIDByName := map[string]string{}
	for _, l := range labels {
		labelIDByName[l.Name] = l.ID
	}

	t.Run("filter by label returns only matching notes", func(t *testing.T) {
		notes, err := user.Client.ListNotes(t.Context(), &client.ListNotesOptions{Label: labelIDByName["work"]})
		require.NoError(t, err)
		require.Len(t, notes, 1)
		assert.Equal(t, "Work Note", notes[0].Title)
	})

	t.Run("filter by different label returns correct notes", func(t *testing.T) {
		notes, err := user.Client.ListNotes(t.Context(), &client.ListNotesOptions{Label: labelIDByName["personal"]})
		require.NoError(t, err)
		require.Len(t, notes, 1)
		assert.Equal(t, "Personal Note", notes[0].Title)
	})

	t.Run("no label param returns all notes", func(t *testing.T) {
		notes, err := user.Client.ListNotes(t.Context(), nil)
		require.NoError(t, err)
		assert.Len(t, notes, 3)
	})

	t.Run("unknown label ID returns empty list", func(t *testing.T) {
		notes, err := user.Client.ListNotes(t.Context(), &client.ListNotesOptions{Label: "nonexistentlabelid"})
		require.NoError(t, err)
		assert.Empty(t, notes)
	})

	t.Run("label from another user is not accessible", func(t *testing.T) {
		other := ts.createTestUser(t, "otheruser", "password123", false)
		otherNote, err := other.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title: "Other Note", Content: "content",
		})
		require.NoError(t, err)

		_, err = other.Client.AddLabel(t.Context(), otherNote.ID, "work")
		require.NoError(t, err)

		otherLabels, err := other.Client.ListLabels(t.Context())
		require.NoError(t, err)
		require.NotEmpty(t, otherLabels)

		notes, err := user.Client.ListNotes(t.Context(), &client.ListNotesOptions{Label: otherLabels[0].ID})
		require.NoError(t, err)
		assert.Empty(t, notes)
	})

	t.Run("unauthenticated request returns 401", func(t *testing.T) {
		c := ts.newClient()
		_, err := c.ListNotes(t.Context(), &client.ListNotesOptions{Label: labelIDByName["work"]})
		assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
	})
}

func TestCreateNoteWithLabels(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "labelnote", "password123", false)

	t.Run("note created with labels has those labels attached", func(t *testing.T) {
		note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title:   "Labeled Note",
			Content: "some content",
			Labels:  []string{"work", "urgent"},
		})
		require.NoError(t, err)
		require.Len(t, note.Labels, 2)

		labelNames := []string{note.Labels[0].Name, note.Labels[1].Name}
		assert.Contains(t, labelNames, "work")
		assert.Contains(t, labelNames, "urgent")
	})

	t.Run("labels created during note creation appear in global label list", func(t *testing.T) {
		labels, err := user.Client.ListLabels(t.Context())
		require.NoError(t, err)
		nameSet := map[string]bool{}
		for _, l := range labels {
			nameSet[l.Name] = true
		}
		assert.True(t, nameSet["work"])
		assert.True(t, nameSet["urgent"])
	})

	t.Run("note without labels still works", func(t *testing.T) {
		note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title:   "No Labels",
			Content: "content",
		})
		require.NoError(t, err)
		assert.Empty(t, note.Labels)
	})

	t.Run("duplicate label names are deduplicated", func(t *testing.T) {
		note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title:   "Duped Labels",
			Content: "content",
			Labels:  []string{"same", "same"},
		})
		require.NoError(t, err)
		assert.Len(t, note.Labels, 1)
		assert.Equal(t, "same", note.Labels[0].Name)
	})

	t.Run("reuses existing labels by name", func(t *testing.T) {
		note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title:   "Reuse Label",
			Content: "content",
			Labels:  []string{"work"},
		})
		require.NoError(t, err)
		require.Len(t, note.Labels, 1)
		assert.Equal(t, "work", note.Labels[0].Name)

		labels, err := user.Client.ListLabels(t.Context())
		require.NoError(t, err)
		workCount := 0
		for _, l := range labels {
			if l.Name == "work" {
				workCount++
			}
		}
		assert.Equal(t, 1, workCount)
	})

	t.Run("note filterable by label right after creation", func(t *testing.T) {
		note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title:   "Filterable",
			Content: "content",
			Labels:  []string{"filterlabel"},
		})
		require.NoError(t, err)
		require.Len(t, note.Labels, 1)

		notes, err := user.Client.ListNotes(t.Context(), &client.ListNotesOptions{Label: note.Labels[0].ID})
		require.NoError(t, err)
		require.Len(t, notes, 1)
		assert.Equal(t, "Filterable", notes[0].Title)
	})

	t.Run("empty and whitespace-only label names are ignored", func(t *testing.T) {
		note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title:   "Whitespace Labels",
			Content: "content",
			Labels:  []string{"valid", "", "  ", "  also valid  "},
		})
		require.NoError(t, err)
		require.Len(t, note.Labels, 2)

		labelNames := []string{note.Labels[0].Name, note.Labels[1].Name}
		assert.Contains(t, labelNames, "valid")
		assert.Contains(t, labelNames, "also valid")
	})

	t.Run("labels work with todo notes and items", func(t *testing.T) {
		note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title:    "Todo With Labels",
			Content:  "",
			NoteType: client.NoteTypeTodo,
			Items: []client.CreateNoteItem{
				{Text: "Buy milk", Position: 0},
				{Text: "Buy eggs", Position: 1},
			},
			Labels: []string{"shopping"},
		})
		require.NoError(t, err)
		require.Len(t, note.Labels, 1)
		assert.Equal(t, "shopping", note.Labels[0].Name)
		require.Len(t, note.Items, 2)
	})
}
