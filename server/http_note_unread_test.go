package main

import (
	"net/http"
	"testing"
	"time"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// unreadOf returns the note's unread state as seen by c, "" when there is none.
func unreadOf(t *testing.T, c *client.Client, noteID string) client.NoteUnread {
	t.Helper()
	note, err := c.GetNote(t.Context(), noteID)
	require.NoError(t, err)
	if note.Unread == nil {
		return ""
	}
	return *note.Unread
}

func TestNoteUnread(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "owner", "password123", false)
	collab := ts.createTestUser(t, "collab", "password123", false)
	stranger := ts.createTestUser(t, "stranger", "password123", false)

	t.Run("own unshared note is never unread", func(t *testing.T) {
		note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "mine"})
		require.NoError(t, err)
		assert.Nil(t, note.Unread)

		_, err = owner.Client.UpdateTextNote(t.Context(), note.ID, &client.UpdateTextNoteRequest{Content: ptr("edited")})
		require.NoError(t, err)
		assert.Empty(t, unreadOf(t, owner.Client, note.ID))
	})

	t.Run("newly shared note is new for the recipient until viewed", func(t *testing.T) {
		note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "for you"})
		require.NoError(t, err)
		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collab.User.ID))

		assert.Equal(t, client.NoteUnreadNew, unreadOf(t, collab.Client, note.ID))
		assert.Empty(t, unreadOf(t, owner.Client, note.ID), "sharing does not flag the owner")

		notes, err := collab.Client.ListNotes(t.Context(), nil)
		require.NoError(t, err)
		var listed *client.Note
		for i := range notes {
			if notes[i].ID == note.ID {
				listed = &notes[i]
			}
		}
		require.NotNil(t, listed)
		require.NotNil(t, listed.Unread, "list responses carry the unread state too")
		assert.Equal(t, client.NoteUnreadNew, *listed.Unread)

		require.NoError(t, collab.Client.MarkNoteViewed(t.Context(), note.ID))
		assert.Empty(t, unreadOf(t, collab.Client, note.ID))

		// Idempotent.
		require.NoError(t, collab.Client.MarkNoteViewed(t.Context(), note.ID))
	})

	t.Run("collaborator edits flag the note as updated for others only", func(t *testing.T) {
		note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "shared"})
		require.NoError(t, err)
		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collab.User.ID))
		require.NoError(t, collab.Client.MarkNoteViewed(t.Context(), note.ID))

		_, err = collab.Client.UpdateTextNote(t.Context(), note.ID, &client.UpdateTextNoteRequest{Content: ptr("collab edit")})
		require.NoError(t, err)
		assert.Equal(t, client.NoteUnreadUpdated, unreadOf(t, owner.Client, note.ID))
		assert.Empty(t, unreadOf(t, collab.Client, note.ID), "own edits never flag the editor")

		require.NoError(t, owner.Client.MarkNoteViewed(t.Context(), note.ID))
		assert.Empty(t, unreadOf(t, owner.Client, note.ID))

		_, err = owner.Client.UpdateTextNote(t.Context(), note.ID, &client.UpdateTextNoteRequest{Content: ptr("owner edit")})
		require.NoError(t, err)
		assert.Equal(t, client.NoteUnreadUpdated, unreadOf(t, collab.Client, note.ID))
		assert.Empty(t, unreadOf(t, owner.Client, note.ID))
	})

	t.Run("editing an updated note clears it for the editor", func(t *testing.T) {
		note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "shared"})
		require.NoError(t, err)
		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collab.User.ID))
		require.NoError(t, collab.Client.MarkNoteViewed(t.Context(), note.ID))

		_, err = collab.Client.UpdateTextNote(t.Context(), note.ID, &client.UpdateTextNoteRequest{Content: ptr("collab edit")})
		require.NoError(t, err)
		require.Equal(t, client.NoteUnreadUpdated, unreadOf(t, owner.Client, note.ID))

		updated, err := owner.Client.UpdateTextNote(t.Context(), note.ID, &client.UpdateTextNoteRequest{Content: ptr("owner reply")})
		require.NoError(t, err)
		assert.Nil(t, updated.Unread, "the update response reflects the cleared state")
	})

	t.Run("per-user and no-op changes do not flag the note", func(t *testing.T) {
		note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "same"})
		require.NoError(t, err)
		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collab.User.ID))
		require.NoError(t, owner.Client.MarkNoteViewed(t.Context(), note.ID))

		_, err = collab.Client.UpdateTextNote(t.Context(), note.ID, &client.UpdateTextNoteRequest{
			Pinned: ptr(true), Color: ptr("#fbbc04"), Content: ptr("same"),
		})
		require.NoError(t, err)
		assert.Empty(t, unreadOf(t, owner.Client, note.ID))
	})

	t.Run("item changes and conversion flag the note", func(t *testing.T) {
		note, err := owner.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
			Title: "groceries", Items: []client.CreateNoteItem{{Text: "milk"}},
		})
		require.NoError(t, err)
		require.Len(t, note.Items, 1)
		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collab.User.ID))
		require.NoError(t, collab.Client.MarkNoteViewed(t.Context(), note.ID))

		_, err = collab.Client.ToggleNoteItemCompleted(t.Context(), note.ID, note.Items[0].ID, true)
		require.NoError(t, err)
		assert.Equal(t, client.NoteUnreadUpdated, unreadOf(t, owner.Client, note.ID))
		assert.Empty(t, unreadOf(t, collab.Client, note.ID))

		require.NoError(t, owner.Client.MarkNoteViewed(t.Context(), note.ID))
		_, err = collab.Client.CreateNoteItem(t.Context(), note.ID, &client.CreateNoteItemRequest{Text: "eggs", Position: 1})
		require.NoError(t, err)
		assert.Equal(t, client.NoteUnreadUpdated, unreadOf(t, owner.Client, note.ID))

		require.NoError(t, owner.Client.MarkNoteViewed(t.Context(), note.ID))
		_, err = collab.Client.ConvertNoteType(t.Context(), note.ID, &client.ConvertNoteTypeRequest{
			NoteType: client.NoteTypeText, Content: ptr("milk\neggs"),
		})
		require.NoError(t, err)
		assert.Equal(t, client.NoteUnreadUpdated, unreadOf(t, owner.Client, note.ID))
		assert.Empty(t, unreadOf(t, collab.Client, note.ID))
	})

	t.Run("re-sharing after unshare makes the note new again", func(t *testing.T) {
		note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "again"})
		require.NoError(t, err)
		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collab.User.ID))
		require.NoError(t, collab.Client.MarkNoteViewed(t.Context(), note.ID))
		require.NoError(t, owner.Client.UnshareNote(t.Context(), note.ID, collab.User.ID))
		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collab.User.ID))

		assert.Equal(t, client.NoteUnreadNew, unreadOf(t, collab.Client, note.ID))
	})

	t.Run("a view replayed from before a change leaves that change unread", func(t *testing.T) {
		note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "offline"})
		require.NoError(t, err)
		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collab.User.ID))

		// collab opens the note offline; the owner edits before the view syncs.
		openedOffline := time.Now().Add(-time.Second)
		_, err = owner.Client.UpdateTextNote(t.Context(), note.ID, &client.UpdateTextNoteRequest{Content: ptr("owner edit")})
		require.NoError(t, err)

		require.NoError(t, collab.Client.MarkNoteViewedAt(t.Context(), note.ID, openedOffline))
		assert.Equal(t, client.NoteUnreadUpdated, unreadOf(t, collab.Client, note.ID))

		// A view time in the future is capped at now.
		require.NoError(t, collab.Client.MarkNoteViewedAt(t.Context(), note.ID, time.Now().Add(time.Hour)))
		assert.Empty(t, unreadOf(t, collab.Client, note.ID))
		_, err = owner.Client.UpdateTextNote(t.Context(), note.ID, &client.UpdateTextNoteRequest{Content: ptr("later edit")})
		require.NoError(t, err)
		assert.Equal(t, client.NoteUnreadUpdated, unreadOf(t, collab.Client, note.ID))
	})

	t.Run("mark viewed requires access", func(t *testing.T) {
		note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "private"})
		require.NoError(t, err)

		err = stranger.Client.MarkNoteViewed(t.Context(), note.ID)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))

		err = stranger.Client.MarkNoteViewed(t.Context(), "invalid")
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})
}
