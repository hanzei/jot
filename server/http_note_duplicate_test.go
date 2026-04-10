package main

import (
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDuplicateNoteEndpoint(t *testing.T) {
	t.Run("duplicates a text note without shares and places it first", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		firstVisible, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
			Content: "Visible before duplicate",
		})
		require.NoError(t, err)

		source, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
			Content: "Shared content",
			Color:   "#fbbc04",
			Labels:  []string{"alpha", "beta"},
		})
		require.NoError(t, err)
		require.NoError(t, owner.Client.ShareNote(t.Context(), source.ID, collaborator.User.ID))

		_, err = owner.Client.UpdateTextNote(t.Context(), source.ID, &client.UpdateTextNoteRequest{
			Archived: client.Ptr(true),
			Pinned:   client.Ptr(true),
		})
		require.NoError(t, err)

		duplicated, err := owner.Client.DuplicateNote(t.Context(), source.ID)
		require.NoError(t, err)

		assert.Equal(t, owner.User.ID, duplicated.UserID)
		// Text notes have no title; the duplicate copies the content.
		assert.Empty(t, duplicated.Title)
		assert.Equal(t, source.Content, duplicated.Content)
		assert.Equal(t, source.Color, duplicated.Color)
		assert.False(t, duplicated.Pinned)
		assert.False(t, duplicated.Archived)
		assert.False(t, duplicated.IsShared)
		assert.Empty(t, duplicated.SharedWith)
		require.Len(t, duplicated.Labels, 2)
		assert.Equal(t, "alpha", duplicated.Labels[0].Name)
		assert.Equal(t, "beta", duplicated.Labels[1].Name)

		notes, err := owner.Client.ListNotes(t.Context(), nil)
		require.NoError(t, err)
		require.Len(t, notes, 2)
		assert.Equal(t, duplicated.ID, notes[0].ID)
		assert.Equal(t, firstVisible.ID, notes[1].ID)
	})

	t.Run("duplicates a shared list note for a collaborator and clears assignments", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "list-owner", "password123", false)
		collaborator := ts.createTestUser(t, "list-collab", "password123", false)

		source, err := owner.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
			Title:  "Shared Tasks",
			Color:  "#a7ffeb",
			Labels: []string{"ops"},
			Items: []client.CreateNoteItem{
				{Text: "Outline release", Position: 0, IndentLevel: 0, Completed: false},
				{Text: "Notify team", Position: 1, IndentLevel: 1, Completed: true},
			},
		})
		require.NoError(t, err)
		require.NoError(t, owner.Client.ShareNote(t.Context(), source.ID, collaborator.User.ID))

		updatedSource, err := owner.Client.UpdateListNote(t.Context(), source.ID, &client.UpdateListNoteRequest{
			Items: &[]client.UpdateNoteItem{
				{Text: "Outline release", Position: 0, IndentLevel: 0, Completed: false, AssignedTo: collaborator.User.ID},
				{Text: "Notify team", Position: 1, IndentLevel: 1, Completed: true, AssignedTo: owner.User.ID},
			},
		})
		require.NoError(t, err)
		require.Len(t, updatedSource.Items, 2)

		// Collaborator sets their own per-user state on the shared note before duplicating.
		_, err = collaborator.Client.UpdateListNote(t.Context(), source.ID, &client.UpdateListNoteRequest{
			Color: client.Ptr("#00bcd4"),
		})
		require.NoError(t, err)
		_, err = collaborator.Client.AddLabel(t.Context(), source.ID, "collab-label")
		require.NoError(t, err)

		duplicated, err := collaborator.Client.DuplicateNote(t.Context(), source.ID)
		require.NoError(t, err)

		assert.Equal(t, collaborator.User.ID, duplicated.UserID)
		assert.Equal(t, "Copy of Shared Tasks", duplicated.Title)
		assert.Equal(t, client.NoteTypeList, duplicated.NoteType)
		assert.Equal(t, "#00bcd4", duplicated.Color)
		assert.False(t, duplicated.Pinned)
		assert.False(t, duplicated.Archived)
		assert.False(t, duplicated.IsShared)
		assert.Empty(t, duplicated.SharedWith)
		require.Len(t, duplicated.Labels, 1)
		assert.Equal(t, "collab-label", duplicated.Labels[0].Name)
		require.Len(t, duplicated.Items, 2)
		assert.Equal(t, "Outline release", duplicated.Items[0].Text)
		assert.Equal(t, 0, duplicated.Items[0].Position)
		assert.Equal(t, 0, duplicated.Items[0].IndentLevel)
		assert.False(t, duplicated.Items[0].Completed)
		assert.Empty(t, duplicated.Items[0].AssignedTo)
		assert.Equal(t, "Notify team", duplicated.Items[1].Text)
		assert.Equal(t, 1, duplicated.Items[1].Position)
		assert.Equal(t, 1, duplicated.Items[1].IndentLevel)
		assert.True(t, duplicated.Items[1].Completed)
		assert.Empty(t, duplicated.Items[1].AssignedTo)

		notes, err := collaborator.Client.ListNotes(t.Context(), nil)
		require.NoError(t, err)
		require.Len(t, notes, 2)
		assert.ElementsMatch(t, []string{duplicated.ID, source.ID}, []string{notes[0].ID, notes[1].ID})
	})
}

func TestCreateNotePersistsCompletedItems(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "completed-items", "password123", false)

	created, err := user.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
		Title: "Checklist",
		Items: []client.CreateNoteItem{
			{Text: "Unchecked", Position: 0, IndentLevel: 0, Completed: false},
			{Text: "Checked", Position: 1, IndentLevel: 1, Completed: true},
		},
	})
	require.NoError(t, err)
	require.Len(t, created.Items, 2)
	assert.False(t, created.Items[0].Completed)
	assert.True(t, created.Items[1].Completed)

	fetched, err := user.Client.GetNote(t.Context(), created.ID)
	require.NoError(t, err)
	require.Len(t, fetched.Items, 2)
	assert.False(t, fetched.Items[0].Completed)
	assert.Equal(t, 0, fetched.Items[0].IndentLevel)
	assert.True(t, fetched.Items[1].Completed)
	assert.Equal(t, 1, fetched.Items[1].IndentLevel)
}
