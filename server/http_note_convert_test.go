package main

import (
	"net/http"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestConvertNoteTypeEndpoint covers POST /notes/{id}/convert. The transform
// itself (splitting text into list items, or rendering a list back into text)
// is computed client-side; the server only validates the precomputed
// content/items and persists them atomically, so these tests exercise the
// server's side of that contract with already-converted payloads.
func TestConvertNoteTypeEndpoint(t *testing.T) {
	t.Run("converts a text note to a list, preserving color/pinned/labels", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "convert-to-list", "password123", false)
		ctx := t.Context()

		source, err := user.Client.CreateTextNote(ctx, &client.CreateTextNoteRequest{
			Content: "Groceries\nMilk\nEggs",
			Color:   "#fbbc04",
			Labels:  []string{"chores"},
		})
		require.NoError(t, err)
		_, err = user.Client.UpdateTextNote(ctx, source.ID, &client.UpdateTextNoteRequest{Pinned: client.Ptr(true)})
		require.NoError(t, err)

		converted, err := user.Client.ConvertNoteType(ctx, source.ID, &client.ConvertNoteTypeRequest{
			NoteType: client.NoteTypeList,
			Items: []client.CreateNoteItem{
				{Text: "Groceries", Position: 0},
				{Text: "Milk", Position: 1},
				{Text: "Eggs", Position: 2, Completed: true},
			},
		})
		require.NoError(t, err)

		assert.Equal(t, client.NoteTypeList, converted.NoteType)
		assert.Empty(t, converted.Title)
		assert.Empty(t, converted.Content)
		assert.Equal(t, "#fbbc04", converted.Color)
		assert.True(t, converted.Pinned)
		require.Len(t, converted.Labels, 1)
		assert.Equal(t, "chores", converted.Labels[0].Name)
		require.Len(t, converted.Items, 3)
		assert.Equal(t, "Groceries", converted.Items[0].Text)
		assert.False(t, converted.Items[0].Completed)
		assert.Equal(t, "Milk", converted.Items[1].Text)
		assert.Equal(t, "Eggs", converted.Items[2].Text)
		assert.True(t, converted.Items[2].Completed)
	})

	t.Run("converts a list note to text, rendering the title as an h1 line", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "convert-to-text", "password123", false)
		ctx := t.Context()

		source, err := user.Client.CreateListNote(ctx, &client.CreateListNoteRequest{
			Title: "Groceries",
			Items: []client.CreateNoteItem{
				{Text: "Milk", Position: 0, Completed: true},
				{Text: "Eggs", Position: 1},
			},
		})
		require.NoError(t, err)

		converted, err := user.Client.ConvertNoteType(ctx, source.ID, &client.ConvertNoteTypeRequest{
			NoteType: client.NoteTypeText,
			Content:  client.Ptr("# Groceries\n\n- [x] Milk\n- [ ] Eggs"),
		})
		require.NoError(t, err)

		assert.Equal(t, client.NoteTypeText, converted.NoteType)
		assert.Empty(t, converted.Title)
		assert.Equal(t, "# Groceries\n\n- [x] Milk\n- [ ] Eggs", converted.Content)
		assert.Empty(t, converted.Items)
	})

	t.Run("drops per-item assignments when converting a list to text", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "convert-drop-owner", "password123", false)
		collaborator := ts.createTestUser(t, "convert-drop-collab", "password123", false)
		ctx := t.Context()

		source, err := owner.Client.CreateListNote(ctx, &client.CreateListNoteRequest{
			Title: "Tasks",
			Items: []client.CreateNoteItem{{Text: "Ship it", Position: 0}},
		})
		require.NoError(t, err)
		require.NoError(t, owner.Client.ShareNote(ctx, source.ID, collaborator.User.ID))

		items := getNoteItems(t, owner, source.ID)
		require.Len(t, items, 1)
		_, err = owner.Client.UpdateNoteItem(ctx, source.ID, items[0].ID, &client.PatchNoteItemRequest{
			AssignedTo: client.Ptr(collaborator.User.ID),
		})
		require.NoError(t, err)

		converted, err := owner.Client.ConvertNoteType(ctx, source.ID, &client.ConvertNoteTypeRequest{
			NoteType: client.NoteTypeText,
			Content:  client.Ptr("# Tasks\n\n- [ ] Ship it"),
		})
		require.NoError(t, err)
		assert.Equal(t, client.NoteTypeText, converted.NoteType)

		// Assignment is gone: the item row itself was deleted by the conversion.
		fetched, err := owner.Client.GetNote(ctx, source.ID)
		require.NoError(t, err)
		assert.Empty(t, fetched.Items)
	})

	t.Run("rejects converting a note to its own type", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "convert-unchanged", "password123", false)
		ctx := t.Context()

		source, err := user.Client.CreateTextNote(ctx, &client.CreateTextNoteRequest{Content: "hi"})
		require.NoError(t, err)

		_, err = user.Client.ConvertNoteType(ctx, source.ID, &client.ConvertNoteTypeRequest{
			NoteType: client.NoteTypeText,
			Content:  client.Ptr("hi"),
		})
		require.Error(t, err)
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("replaying an already-committed conversion with the original base_version succeeds as a no-op", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "convert-replay", "password123", false)
		ctx := t.Context()

		source, err := user.Client.CreateTextNote(ctx, &client.CreateTextNoteRequest{Content: "original"})
		require.NoError(t, err)
		originalVersion := source.Version

		convertReq := &client.ConvertNoteTypeRequest{
			NoteType:    client.NoteTypeList,
			Items:       []client.CreateNoteItem{{Text: "original", Position: 0}},
			BaseVersion: client.Ptr(originalVersion),
		}
		first, err := user.Client.ConvertNoteType(ctx, source.ID, convertReq)
		require.NoError(t, err)
		assert.Equal(t, client.NoteTypeList, first.NoteType)

		// The client never saw the first response (e.g. it was lost in transit)
		// and retries the exact same request, still carrying the pre-conversion
		// base_version. currentNote.NoteType now already equals the request's
		// note_type, but this must succeed as an idempotent no-op — not 400
		// ("already this type") and not 409 (the version really is stale, but
		// the content it would produce already matches what's stored).
		replayed, err := user.Client.ConvertNoteType(ctx, source.ID, convertReq)
		require.NoError(t, err)
		assert.Equal(t, client.NoteTypeList, replayed.NoteType)
		require.Len(t, replayed.Items, 1)
		assert.Equal(t, "original", replayed.Items[0].Text)
		// No-op: the replay must not bump the version again.
		assert.Equal(t, first.Version, replayed.Version)
	})

	t.Run("rejects a stale base_version with 409", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "convert-conflict", "password123", false)
		ctx := t.Context()

		source, err := user.Client.CreateTextNote(ctx, &client.CreateTextNoteRequest{Content: "original"})
		require.NoError(t, err)
		staleVersion := source.Version

		// Another write bumps the version before the conversion lands.
		_, err = user.Client.UpdateTextNote(ctx, source.ID, &client.UpdateTextNoteRequest{Content: client.Ptr("changed")})
		require.NoError(t, err)

		_, err = user.Client.ConvertNoteType(ctx, source.ID, &client.ConvertNoteTypeRequest{
			NoteType:    client.NoteTypeList,
			Items:       []client.CreateNoteItem{{Text: "changed", Position: 0}},
			BaseVersion: client.Ptr(staleVersion),
		})
		require.Error(t, err)
		assert.Equal(t, http.StatusConflict, client.StatusCode(err))

		fetched, err := user.Client.GetNote(ctx, source.ID)
		require.NoError(t, err)
		assert.Equal(t, client.NoteTypeText, fetched.NoteType)
		assert.Equal(t, "changed", fetched.Content)
	})

	t.Run("returns 404 for a note the caller cannot access", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "convert-404-owner", "password123", false)
		outsider := ts.createTestUser(t, "convert-404-outsider", "password123", false)
		ctx := t.Context()

		source, err := owner.Client.CreateTextNote(ctx, &client.CreateTextNoteRequest{Content: "private"})
		require.NoError(t, err)

		_, err = outsider.Client.ConvertNoteType(ctx, source.ID, &client.ConvertNoteTypeRequest{
			NoteType: client.NoteTypeList,
			Items:    []client.CreateNoteItem{{Text: "private", Position: 0}},
		})
		require.Error(t, err)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
	})

	t.Run("rejects content when converting to a list", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "convert-bad-payload-1", "password123", false)
		ctx := t.Context()

		source, err := user.Client.CreateTextNote(ctx, &client.CreateTextNoteRequest{Content: "hi"})
		require.NoError(t, err)

		_, err = user.Client.ConvertNoteType(ctx, source.ID, &client.ConvertNoteTypeRequest{
			NoteType: client.NoteTypeList,
			Content:  client.Ptr("hi"),
		})
		require.Error(t, err)
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("rejects items when converting to text", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "convert-bad-payload-2", "password123", false)
		ctx := t.Context()

		source, err := user.Client.CreateListNote(ctx, &client.CreateListNoteRequest{
			Title: "List",
			Items: []client.CreateNoteItem{{Text: "Item", Position: 0}},
		})
		require.NoError(t, err)

		_, err = user.Client.ConvertNoteType(ctx, source.ID, &client.ConvertNoteTypeRequest{
			NoteType: client.NoteTypeText,
			Items:    []client.CreateNoteItem{{Text: "Item", Position: 0}},
		})
		require.Error(t, err)
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("rejects content over the max length when converting to text", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "convert-too-long", "password123", false)
		ctx := t.Context()

		source, err := user.Client.CreateListNote(ctx, &client.CreateListNoteRequest{
			Title: "List",
			Items: []client.CreateNoteItem{{Text: "Item", Position: 0}},
		})
		require.NoError(t, err)

		oversized := make([]byte, 10001)
		for i := range oversized {
			oversized[i] = 'a'
		}

		_, err = user.Client.ConvertNoteType(ctx, source.ID, &client.ConvertNoteTypeRequest{
			NoteType: client.NoteTypeText,
			Content:  client.Ptr(string(oversized)),
		})
		require.Error(t, err)
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})
}
