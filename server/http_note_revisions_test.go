package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// patchNoteAsClient updates a text note's content as user, sending clientID as
// X-Client-Id the way a webapp tab or the mobile app does. The SDK client
// sends no such header.
func patchNoteAsClient(t *testing.T, ts *TestServer, user *TestUser, noteID, clientID, content string) {
	t.Helper()

	encoded, err := json.Marshal(map[string]string{"content": content})
	require.NoError(t, err)
	status, _, body := rawRequest(t, user.Client.HTTPClient(), http.MethodPatch, ts.HTTPServer.URL+"/api/v1/notes/"+noteID,
		bytes.NewReader(encoded), http.Header{"Content-Type": {"application/json"}, "X-Client-Id": {clientID}})
	require.Equal(t, http.StatusOK, status, "body: %s", body)
}

func TestNoteRevisionsEndpoints(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "revisions-owner", "password123", false)
	collab := ts.createTestUser(t, "revisions-collab", "password123", false)
	outsider := ts.createTestUser(t, "revisions-outsider", "password123", false)

	t.Run("lists metadata newest first and returns one full revision", func(t *testing.T) {
		ctx := t.Context()
		note, err := owner.Client.CreateTextNote(ctx, &client.CreateTextNoteRequest{Content: "first"})
		require.NoError(t, err)

		empty, err := owner.Client.ListNoteRevisions(ctx, note.ID)
		require.NoError(t, err)
		assert.NotNil(t, empty, "an empty history is [], not null")
		assert.Empty(t, empty)

		_, err = owner.Client.UpdateTextNote(ctx, note.ID, &client.UpdateTextNoteRequest{Content: client.Ptr("second")})
		require.NoError(t, err)
		require.NoError(t, owner.Client.ShareNote(ctx, note.ID, collab.User.ID))
		_, err = collab.Client.UpdateTextNote(ctx, note.ID, &client.UpdateTextNoteRequest{Content: client.Ptr("third")})
		require.NoError(t, err)

		revisions, err := owner.Client.ListNoteRevisions(ctx, note.ID)
		require.NoError(t, err)
		require.Len(t, revisions, 2)
		assert.False(t, revisions[0].CreatedAt.Before(revisions[1].CreatedAt), "newest first")
		require.NotNil(t, revisions[0].ActorID)
		assert.Equal(t, owner.User.ID, *revisions[0].ActorID)

		rev, err := collab.Client.GetNoteRevision(ctx, note.ID, revisions[0].ID)
		require.NoError(t, err)
		assert.Equal(t, "second", rev.Content)
		assert.Equal(t, client.NoteTypeText, rev.NoteType)
		assert.NotNil(t, rev.Items)

		// The list body carries no content.
		status, _, body := rawRequest(t, owner.Client.HTTPClient(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/notes/"+note.ID+"/revisions", nil, nil)
		require.Equal(t, http.StatusOK, status)
		var raw map[string][]map[string]any
		require.NoError(t, json.Unmarshal(body, &raw))
		require.NotEmpty(t, raw["revisions"])
		assert.NotContains(t, raw["revisions"][0], "content")
		assert.NotContains(t, raw["revisions"][0], "items")
	})

	t.Run("history follows note access", func(t *testing.T) {
		ctx := t.Context()
		note, err := owner.Client.CreateTextNote(ctx, &client.CreateTextNoteRequest{Content: "private"})
		require.NoError(t, err)
		_, err = owner.Client.UpdateTextNote(ctx, note.ID, &client.UpdateTextNoteRequest{Content: client.Ptr("private v2")})
		require.NoError(t, err)
		revisions, err := owner.Client.ListNoteRevisions(ctx, note.ID)
		require.NoError(t, err)
		require.Len(t, revisions, 1)

		_, err = outsider.Client.ListNoteRevisions(ctx, note.ID)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
		_, err = outsider.Client.GetNoteRevision(ctx, note.ID, revisions[0].ID)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
		_, err = outsider.Client.RestoreNoteRevision(ctx, note.ID, revisions[0].ID, nil)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))

		other, err := owner.Client.CreateTextNote(ctx, &client.CreateTextNoteRequest{Content: "other"})
		require.NoError(t, err)
		_, err = owner.Client.GetNoteRevision(ctx, other.ID, revisions[0].ID)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err), "a revision is only reachable under its own note")

		_, err = owner.Client.GetNoteRevision(ctx, note.ID, "not-an-id")
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))

		require.NoError(t, owner.Client.DeleteNote(ctx, note.ID))
		_, err = owner.Client.ListNoteRevisions(ctx, note.ID)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err), "a trashed note's history is not served")
	})

	t.Run("restore is recorded, undoable, and version-gated", func(t *testing.T) {
		ctx := t.Context()
		note, err := owner.Client.CreateTextNote(ctx, &client.CreateTextNoteRequest{Content: "original"})
		require.NoError(t, err)
		edited, err := owner.Client.UpdateTextNote(ctx, note.ID, &client.UpdateTextNoteRequest{Content: client.Ptr("edited")})
		require.NoError(t, err)
		revisions, err := owner.Client.ListNoteRevisions(ctx, note.ID)
		require.NoError(t, err)
		require.Len(t, revisions, 1)

		_, err = owner.Client.RestoreNoteRevision(ctx, note.ID, revisions[0].ID, &note.Version)
		assert.Equal(t, http.StatusConflict, client.StatusCode(err), "a stale base_version conflicts")

		restored, err := owner.Client.RestoreNoteRevision(ctx, note.ID, revisions[0].ID, &edited.Version)
		require.NoError(t, err)
		assert.Equal(t, "original", restored.Content)

		revisions, err = owner.Client.ListNoteRevisions(ctx, note.ID)
		require.NoError(t, err)
		require.Len(t, revisions, 2, "the restore recorded what it replaced")
		undo, err := owner.Client.GetNoteRevision(ctx, note.ID, revisions[0].ID)
		require.NoError(t, err)
		assert.Equal(t, "edited", undo.Content)

		reverted, err := owner.Client.RestoreNoteRevision(ctx, note.ID, undo.ID, &restored.Version)
		require.NoError(t, err)
		assert.Equal(t, "edited", reverted.Content)
	})

	t.Run("restoring across a type change converts the note back", func(t *testing.T) {
		ctx := t.Context()
		note, err := owner.Client.CreateListNote(ctx, &client.CreateListNoteRequest{
			Title: "Groceries",
			Items: []client.CreateNoteItem{{Text: "Milk", Position: 0}, {Text: "Eggs", Position: 1, Completed: true}},
		})
		require.NoError(t, err)
		converted, err := owner.Client.ConvertNoteType(ctx, note.ID, &client.ConvertNoteTypeRequest{
			NoteType:    client.NoteTypeText,
			Content:     client.Ptr("# Groceries\n- [ ] Milk\n- [x] Eggs"),
			BaseVersion: &note.Version,
		})
		require.NoError(t, err)

		revisions, err := owner.Client.ListNoteRevisions(ctx, note.ID)
		require.NoError(t, err)
		require.Len(t, revisions, 1)
		assert.Equal(t, client.NoteTypeList, revisions[0].NoteType)
		assert.Equal(t, "Groceries", revisions[0].Title)

		restored, err := owner.Client.RestoreNoteRevision(ctx, note.ID, revisions[0].ID, &converted.Version)
		require.NoError(t, err)
		assert.Equal(t, client.NoteTypeList, restored.NoteType)
		assert.Equal(t, "Groceries", restored.Title)
		assert.Empty(t, restored.Content)
		require.Len(t, restored.Items, 2)
		assert.Equal(t, note.Items[0].ID, restored.Items[0].ID)
		assert.Equal(t, "Eggs", restored.Items[1].Text)
		assert.True(t, restored.Items[1].Completed)
	})

	t.Run("item writes are recorded", func(t *testing.T) {
		ctx := t.Context()
		note, err := owner.Client.CreateListNote(ctx, &client.CreateListNoteRequest{
			Title: "Chores",
			Items: []client.CreateNoteItem{{Text: "Dishes", Position: 0}},
		})
		require.NoError(t, err)
		_, err = owner.Client.ToggleNoteItemCompleted(ctx, note.ID, note.Items[0].ID, true)
		require.NoError(t, err)

		revisions, err := owner.Client.ListNoteRevisions(ctx, note.ID)
		require.NoError(t, err)
		require.Len(t, revisions, 1)
		rev, err := owner.Client.GetNoteRevision(ctx, note.ID, revisions[0].ID)
		require.NoError(t, err)
		require.Len(t, rev.Items, 1)
		assert.Equal(t, "Dishes", rev.Items[0].Text)
		assert.False(t, rev.Items[0].Completed)
	})

	t.Run("a second client of the same user starts a new revision", func(t *testing.T) {
		ctx := t.Context()
		note, err := owner.Client.CreateTextNote(ctx, &client.CreateTextNoteRequest{Content: "v0"})
		require.NoError(t, err)
		patchNoteAsClient(t, ts, owner, note.ID, "laptop", "from laptop")
		patchNoteAsClient(t, ts, owner, note.ID, "laptop", "from laptop, again")
		patchNoteAsClient(t, ts, owner, note.ID, "phone", "from phone")

		revisions, err := owner.Client.ListNoteRevisions(ctx, note.ID)
		require.NoError(t, err)
		require.Len(t, revisions, 2)
		rev, err := owner.Client.GetNoteRevision(ctx, note.ID, revisions[0].ID)
		require.NoError(t, err)
		assert.Equal(t, "from laptop, again", rev.Content)
	})
}

func TestMCPUpdateNoteIsUndoable(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	tu := ts.createTestUser(t, "mcp-revisions", "password123", false)
	sess := setupMCPSession(t, ts, tu)
	ctx := t.Context()

	note, err := tu.Client.CreateTextNote(ctx, &client.CreateTextNoteRequest{Content: "v0"})
	require.NoError(t, err)
	_, err = tu.Client.UpdateTextNote(ctx, note.ID, &client.UpdateTextNoteRequest{Content: client.Ptr("typed by hand")})
	require.NoError(t, err)

	// Seconds after the user's own edit, which would coalesce with another
	// edit from the same client.
	callTool(t, sess, "update_note", map[string]any{"id": note.ID, "content": "rewritten over MCP"}, nil)

	revisions, err := tu.Client.ListNoteRevisions(ctx, note.ID)
	require.NoError(t, err)
	require.Len(t, revisions, 2)
	rev, err := tu.Client.GetNoteRevision(ctx, note.ID, revisions[0].ID)
	require.NoError(t, err)
	assert.Equal(t, "typed by hand", rev.Content)
}
