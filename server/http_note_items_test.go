package main

import (
	"strings"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ptr is a small helper for building pointer-valued patch requests.
func ptr[T any](v T) *T { return &v }

func createListNote(t *testing.T, user *TestUser, title string, items ...client.CreateNoteItem) *client.Note {
	t.Helper()
	note, err := user.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
		Title: title,
		Items: items,
	})
	require.NoError(t, err)
	return note
}

func TestCreateNoteItem(t *testing.T) {
	t.Run("client-supplied ID is honored", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "user1", "password123", false)
		note := createListNote(t, user, "List")

		itemID := "abcdefghijklmnopqrstuv"
		item, err := user.Client.CreateNoteItem(t.Context(), note.ID, &client.CreateNoteItemRequest{
			ID: itemID, Text: "Milk", Position: 0,
		})
		require.NoError(t, err)
		assert.Equal(t, itemID, item.ID)
		assert.Equal(t, "Milk", item.Text)

		items := getNoteItems(t, user, note.ID)
		require.Len(t, items, 1)
		assert.Equal(t, itemID, items[0].ID)
	})

	t.Run("server generates ID when omitted", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "user1", "password123", false)
		note := createListNote(t, user, "List")

		item, err := user.Client.CreateNoteItem(t.Context(), note.ID, &client.CreateNoteItemRequest{Text: "Eggs", Position: 0})
		require.NoError(t, err)
		assert.Len(t, item.ID, 22)
	})

	t.Run("duplicate ID returns 409", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "user1", "password123", false)
		note := createListNote(t, user, "List")

		itemID := "abcdefghijklmnopqrstuv"
		_, err := user.Client.CreateNoteItem(t.Context(), note.ID, &client.CreateNoteItemRequest{ID: itemID, Text: "A", Position: 0})
		require.NoError(t, err)
		_, err = user.Client.CreateNoteItem(t.Context(), note.ID, &client.CreateNoteItemRequest{ID: itemID, Text: "B", Position: 1})
		require.Error(t, err)
		assert.Equal(t, 409, client.StatusCode(err))
	})

	t.Run("invalid ID format returns 400", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "user1", "password123", false)
		note := createListNote(t, user, "List")

		_, err := user.Client.CreateNoteItem(t.Context(), note.ID, &client.CreateNoteItemRequest{ID: "too-short", Text: "A", Position: 0})
		require.Error(t, err)
		assert.Equal(t, 400, client.StatusCode(err))
	})

	t.Run("rejected on text note", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "user1", "password123", false)
		textNote, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "hello"})
		require.NoError(t, err)

		_, err = user.Client.CreateNoteItem(t.Context(), textNote.ID, &client.CreateNoteItemRequest{Text: "A", Position: 0})
		require.Error(t, err)
		assert.Equal(t, 400, client.StatusCode(err))
	})

	t.Run("text too long returns 400", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "user1", "password123", false)
		note := createListNote(t, user, "List")

		_, err := user.Client.CreateNoteItem(t.Context(), note.ID, &client.CreateNoteItemRequest{Text: strings.Repeat("x", 501), Position: 0})
		require.Error(t, err)
		assert.Equal(t, 400, client.StatusCode(err))
	})

	t.Run("exceeding per-note cap returns 422", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "user1", "password123", false)

		items := make([]client.CreateNoteItem, 500)
		for i := range items {
			items[i] = client.CreateNoteItem{Text: "item", Position: i}
		}
		note, err := user.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{Title: "List", Items: items})
		require.NoError(t, err)

		_, err = user.Client.CreateNoteItem(t.Context(), note.ID, &client.CreateNoteItemRequest{Text: "one too many", Position: 500})
		require.Error(t, err)
		assert.Equal(t, 422, client.StatusCode(err))
	})

	t.Run("non-collaborator cannot add item", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		intruder := ts.createTestUser(t, "intruder", "password123", false)
		note := createListNote(t, owner, "List")

		_, err := intruder.Client.CreateNoteItem(t.Context(), note.ID, &client.CreateNoteItemRequest{Text: "A", Position: 0})
		require.Error(t, err)
		assert.Equal(t, 404, client.StatusCode(err))
	})
}

func TestUpdateNoteItem(t *testing.T) {
	t.Run("partial update only changes provided fields", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "user1", "password123", false)
		note := createListNote(t, user, "List", client.CreateNoteItem{Text: "Milk", Position: 0})
		itemID := getNoteItems(t, user, note.ID)[0].ID

		updated, err := user.Client.UpdateNoteItem(t.Context(), note.ID, itemID, &client.PatchNoteItemRequest{
			Completed: ptr(true),
		})
		require.NoError(t, err)
		assert.True(t, updated.Completed)
		assert.Equal(t, "Milk", updated.Text, "text must be preserved when only completed is patched")
	})

	t.Run("not found returns 404", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "user1", "password123", false)
		note := createListNote(t, user, "List")

		_, err := user.Client.UpdateNoteItem(t.Context(), note.ID, "abcdefghijklmnopqrstuv", &client.PatchNoteItemRequest{Text: ptr("x")})
		require.Error(t, err)
		assert.Equal(t, 404, client.StatusCode(err))
	})
}

func TestDeleteNoteItem(t *testing.T) {
	t.Run("deletes a single item", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "user1", "password123", false)
		note := createListNote(t, user, "List",
			client.CreateNoteItem{Text: "A", Position: 0},
			client.CreateNoteItem{Text: "B", Position: 1},
		)
		items := getNoteItems(t, user, note.ID)

		require.NoError(t, user.Client.DeleteNoteItem(t.Context(), note.ID, items[0].ID))
		remaining := getNoteItems(t, user, note.ID)
		require.Len(t, remaining, 1)
		assert.Equal(t, "B", remaining[0].Text)
	})

	t.Run("not found returns 404", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "user1", "password123", false)
		note := createListNote(t, user, "List")

		err := user.Client.DeleteNoteItem(t.Context(), note.ID, "abcdefghijklmnopqrstuv")
		require.Error(t, err)
		assert.Equal(t, 404, client.StatusCode(err))
	})
}

func TestReorderNoteItems(t *testing.T) {
	t.Run("reorders by item ID", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "user1", "password123", false)
		note := createListNote(t, user, "List",
			client.CreateNoteItem{Text: "A", Position: 0},
			client.CreateNoteItem{Text: "B", Position: 1},
			client.CreateNoteItem{Text: "C", Position: 2},
		)
		items := getNoteItems(t, user, note.ID)

		// Reverse the order.
		require.NoError(t, user.Client.ReorderNoteItems(t.Context(), note.ID, []string{items[2].ID, items[1].ID, items[0].ID}))

		reordered := getNoteItems(t, user, note.ID)
		require.Len(t, reordered, 3)
		assert.Equal(t, "C", reordered[0].Text)
		assert.Equal(t, "B", reordered[1].Text)
		assert.Equal(t, "A", reordered[2].Text)
	})

	t.Run("foreign item ID returns 404", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "user1", "password123", false)
		note := createListNote(t, user, "List", client.CreateNoteItem{Text: "A", Position: 0})
		items := getNoteItems(t, user, note.ID)

		err := user.Client.ReorderNoteItems(t.Context(), note.ID, []string{items[0].ID, "abcdefghijklmnopqrstuv"})
		require.Error(t, err)
		assert.Equal(t, 404, client.StatusCode(err))
	})
}

// TestConcurrentListItemEdits is the core regression test for the lost-update
// problem: two clients editing the same list concurrently must both have their
// changes preserved (the bug was that a full-note save from one client
// overwrote the other's items).
func TestConcurrentListItemEdits(t *testing.T) {
	t.Run("edits to different items both survive", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, _ := createSharedListNote(t, ts, owner, collaborator)
		items := getNoteItems(t, owner, noteID) // "Item 1", "Item 2"
		require.Len(t, items, 2)

		// Owner renames item 1; collaborator completes item 2 — concurrently.
		_, err := owner.Client.UpdateNoteItem(t.Context(), noteID, items[0].ID, &client.PatchNoteItemRequest{Text: ptr("Renamed 1")})
		require.NoError(t, err)
		_, err = collaborator.Client.UpdateNoteItem(t.Context(), noteID, items[1].ID, &client.PatchNoteItemRequest{Completed: ptr(true)})
		require.NoError(t, err)

		final := getNoteItems(t, owner, noteID)
		require.Len(t, final, 2)
		assert.Equal(t, "Renamed 1", final[0].Text)
		assert.True(t, final[1].Completed)
		assert.Equal(t, "Item 2", final[1].Text)
	})

	t.Run("edits to different columns of the same item merge", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, _ := createSharedListNote(t, ts, owner, collaborator)
		items := getNoteItems(t, owner, noteID)

		// Owner edits text; collaborator toggles completed on the *same* item.
		_, err := owner.Client.UpdateNoteItem(t.Context(), noteID, items[0].ID, &client.PatchNoteItemRequest{Text: ptr("Updated text")})
		require.NoError(t, err)
		_, err = collaborator.Client.UpdateNoteItem(t.Context(), noteID, items[0].ID, &client.PatchNoteItemRequest{Completed: ptr(true)})
		require.NoError(t, err)

		final := getNoteItems(t, owner, noteID)
		assert.Equal(t, "Updated text", final[0].Text, "text edit must survive the concurrent completed toggle")
		assert.True(t, final[0].Completed)
	})

	t.Run("collaborator can add items", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, _ := createSharedListNote(t, ts, owner, collaborator)

		_, err := collaborator.Client.CreateNoteItem(t.Context(), noteID, &client.CreateNoteItemRequest{Text: "Added by collab", Position: 2})
		require.NoError(t, err)

		items := getNoteItems(t, owner, noteID)
		require.Len(t, items, 3)
		assert.Equal(t, "Added by collab", items[2].Text)
	})
}
