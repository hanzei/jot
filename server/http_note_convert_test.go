package main

import (
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestConvertNoteTypeEndpoint(t *testing.T) {
	t.Run("converts a text note to a list, splitting lines into items", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "convert-owner", "password123", false)

		source, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
			Content: "# Groceries\n\n- [x] Milk\n- Eggs",
			Color:   "#fbbc04",
			Labels:  []string{"errands"},
		})
		require.NoError(t, err)
		_, err = owner.Client.UpdateTextNote(t.Context(), source.ID, &client.UpdateTextNoteRequest{Pinned: client.Ptr(true)})
		require.NoError(t, err)

		converted, err := owner.Client.ConvertNoteType(t.Context(), source.ID, &client.ConvertNoteTypeRequest{
			NoteType: client.NoteTypeList,
		})
		require.NoError(t, err)

		assert.Equal(t, source.ID, converted.ID)
		assert.Equal(t, client.NoteTypeList, converted.NoteType)
		assert.Empty(t, converted.Content)
		assert.Empty(t, converted.Title)
		assert.Equal(t, "#fbbc04", converted.Color)
		assert.True(t, converted.Pinned)
		require.Len(t, converted.Labels, 1)
		assert.Equal(t, "errands", converted.Labels[0].Name)

		require.Len(t, converted.Items, 3)
		assert.Equal(t, "Groceries", converted.Items[0].Text)
		assert.False(t, converted.Items[0].Completed)
		assert.Equal(t, "Milk", converted.Items[1].Text)
		assert.True(t, converted.Items[1].Completed)
		assert.Equal(t, "Eggs", converted.Items[2].Text)
		assert.False(t, converted.Items[2].Completed)
	})

	t.Run("converts a list note to text, rendering the title as an h1 line", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "convert-owner-2", "password123", false)

		source, err := owner.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
			Title: "Groceries",
			Items: []client.CreateNoteItem{
				{Text: "Milk", Position: 0, Completed: true},
				{Text: "Eggs", Position: 1},
			},
		})
		require.NoError(t, err)

		converted, err := owner.Client.ConvertNoteType(t.Context(), source.ID, &client.ConvertNoteTypeRequest{
			NoteType: client.NoteTypeText,
		})
		require.NoError(t, err)

		assert.Equal(t, client.NoteTypeText, converted.NoteType)
		assert.Empty(t, converted.Title)
		assert.Empty(t, converted.Items)
		assert.Equal(t, "# Groceries\n\n- [x] Milk\n- [ ] Eggs", converted.Content)
	})

	t.Run("drops per-item assignments when converting a list to text", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "convert-owner-3", "password123", false)
		collaborator := ts.createTestUser(t, "convert-collab-3", "password123", false)

		source, err := owner.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
			Title: "Tasks",
			Items: []client.CreateNoteItem{{Text: "Ship it", Position: 0}},
		})
		require.NoError(t, err)
		require.NoError(t, owner.Client.ShareNote(t.Context(), source.ID, collaborator.User.ID))
		items := getNoteItems(t, owner, source.ID)
		require.Len(t, items, 1)
		_, err = owner.Client.UpdateNoteItem(t.Context(), source.ID, items[0].ID, &client.PatchNoteItemRequest{
			AssignedTo: client.Ptr(collaborator.User.ID),
		})
		require.NoError(t, err)

		converted, err := owner.Client.ConvertNoteType(t.Context(), source.ID, &client.ConvertNoteTypeRequest{
			NoteType: client.NoteTypeText,
		})
		require.NoError(t, err)
		assert.Equal(t, "# Tasks\n\n- [ ] Ship it", converted.Content)
		assert.Empty(t, converted.Items)
	})

	t.Run("rejects converting a note to its own type", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "convert-owner-4", "password123", false)

		source, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "hello"})
		require.NoError(t, err)

		_, err = owner.Client.ConvertNoteType(t.Context(), source.ID, &client.ConvertNoteTypeRequest{
			NoteType: client.NoteTypeText,
		})
		require.Error(t, err)
		assert.Equal(t, 400, client.StatusCode(err))
	})

	t.Run("rejects a version conflict", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "convert-owner-5", "password123", false)

		source, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "hello"})
		require.NoError(t, err)
		staleVersion := source.Version

		_, err = owner.Client.UpdateTextNote(t.Context(), source.ID, &client.UpdateTextNoteRequest{Content: client.Ptr("changed")})
		require.NoError(t, err)

		_, err = owner.Client.ConvertNoteType(t.Context(), source.ID, &client.ConvertNoteTypeRequest{
			NoteType:    client.NoteTypeList,
			BaseVersion: &staleVersion,
		})
		require.Error(t, err)
		assert.Equal(t, 409, client.StatusCode(err))
	})

	t.Run("returns 404 for a note the caller cannot access", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "convert-owner-6", "password123", false)
		other := ts.createTestUser(t, "convert-other-6", "password123", false)

		source, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "hello"})
		require.NoError(t, err)

		_, err = other.Client.ConvertNoteType(t.Context(), source.ID, &client.ConvertNoteTypeRequest{
			NoteType: client.NoteTypeList,
		})
		require.Error(t, err)
		assert.Equal(t, 404, client.StatusCode(err))
	})
}
