package main

import (
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// noteIDs returns the IDs of notes in grid order.
func noteIDs(notes []client.Note) []string {
	ids := make([]string, len(notes))
	for i, n := range notes {
		ids[i] = n.ID
	}
	return ids
}

func TestCreatePinnedNote(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "pinowner", "password123", false)
	collaborator := ts.createTestUser(t, "pincollab", "password123", false)
	ctx := t.Context()

	unpinned, err := owner.Client.CreateTextNote(ctx, &client.CreateTextNoteRequest{Content: "unpinned"})
	require.NoError(t, err)
	firstPinned, err := owner.Client.CreateTextNote(ctx, &client.CreateTextNoteRequest{Content: "pinned first", Pinned: true})
	require.NoError(t, err)
	secondPinned, err := owner.Client.CreateListNote(ctx, &client.CreateListNoteRequest{
		Title:  "pinned list",
		Pinned: true,
		Items:  []client.CreateNoteItem{{Text: "milk"}},
	})
	require.NoError(t, err)

	t.Run("create response reports pinned", func(t *testing.T) {
		assert.True(t, firstPinned.Pinned)
		assert.True(t, secondPinned.Pinned)
		assert.False(t, unpinned.Pinned)
	})

	t.Run("omitted pinned creates an unpinned note", func(t *testing.T) {
		got, err := owner.Client.GetNote(ctx, unpinned.ID)
		require.NoError(t, err)
		assert.False(t, got.Pinned)
	})

	t.Run("pinned notes are appended to the pinned section", func(t *testing.T) {
		notes, err := owner.Client.ListNotes(ctx, nil)
		require.NoError(t, err)
		assert.Equal(t, []string{firstPinned.ID, secondPinned.ID, unpinned.ID}, noteIDs(notes))
	})

	t.Run("pinned is per-user state", func(t *testing.T) {
		require.NoError(t, owner.Client.ShareNote(ctx, firstPinned.ID, collaborator.User.ID))
		got, err := collaborator.Client.GetNote(ctx, firstPinned.ID)
		require.NoError(t, err)
		assert.False(t, got.Pinned)
	})

	t.Run("unpinning a note created pinned returns it to the top of the grid", func(t *testing.T) {
		later, err := owner.Client.CreateTextNote(ctx, &client.CreateTextNoteRequest{Content: "later"})
		require.NoError(t, err)

		_, err = owner.Client.UpdateTextNote(ctx, firstPinned.ID, &client.UpdateTextNoteRequest{Pinned: new(false)})
		require.NoError(t, err)

		notes, err := owner.Client.ListNotes(ctx, nil)
		require.NoError(t, err)
		assert.Equal(t, []string{secondPinned.ID, firstPinned.ID, later.ID, unpinned.ID}, noteIDs(notes))
	})
}
