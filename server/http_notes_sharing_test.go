package main

import (
	"context"
	"net/http"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Note sharing endpoint tests
func TestNoteSharingEndpoints(t *testing.T) {
	ts := setupTestServer(t)
	ctx := context.Background()
	owner := ts.createTestUser(t, "owner", "password123", false)
	sharedUser := ts.createTestUser(t, "user", "password123", false)
	other := ts.createTestUser(t, "other", "password123", false)

	note, err := owner.Client.CreateNote(ctx, &client.CreateNoteRequest{
		Title:   "Shared Note",
		Content: "This will be shared",
	})
	require.NoError(t, err)

	t.Run("share note with user", func(t *testing.T) {
		require.NoError(t, owner.Client.ShareNote(ctx, note.ID, sharedUser.User.ID))
	})

	t.Run("share with duplicate user returns conflict", func(t *testing.T) {
		require.NoError(t, owner.Client.ShareNote(ctx, note.ID, other.User.ID))

		err := owner.Client.ShareNote(ctx, note.ID, other.User.ID)
		assert.Equal(t, http.StatusConflict, client.StatusCode(err))
	})

	t.Run("share with nonexistent user_id returns not found", func(t *testing.T) {
		err := owner.Client.ShareNote(ctx, note.ID, "abcdefghijklmnopqrstuv")
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
	})

	t.Run("share with empty user_id returns bad request", func(t *testing.T) {
		err := owner.Client.ShareNote(ctx, note.ID, "")
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("share with invalid user_id format returns bad request", func(t *testing.T) {
		err := owner.Client.ShareNote(ctx, note.ID, "invalid")
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("share with self returns bad request", func(t *testing.T) {
		err := owner.Client.ShareNote(ctx, note.ID, owner.User.ID)
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("share by non-owner returns forbidden", func(t *testing.T) {
		err := other.Client.ShareNote(ctx, note.ID, other.User.ID)
		assert.Equal(t, http.StatusForbidden, client.StatusCode(err))
	})

	t.Run("get note shares", func(t *testing.T) {
		shares, err := owner.Client.GetNoteShares(ctx, note.ID)
		require.NoError(t, err)
		assert.GreaterOrEqual(t, len(shares), 1)
	})

	t.Run("get note shares by non-owner returns forbidden", func(t *testing.T) {
		_, err := other.Client.GetNoteShares(ctx, note.ID)
		assert.Equal(t, http.StatusForbidden, client.StatusCode(err))
	})

	t.Run("unshare note", func(t *testing.T) {
		require.NoError(t, owner.Client.UnshareNote(ctx, note.ID, sharedUser.User.ID))
	})

	t.Run("unshare non-shared user returns not found", func(t *testing.T) {
		err := owner.Client.UnshareNote(ctx, note.ID, sharedUser.User.ID)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
	})
}

func TestSearchUsersEndpoint(t *testing.T) {
	ts := setupTestServer(t)
	ctx := context.Background()
	user1 := ts.createTestUser(t, "alice", "password123", false)
	bob := ts.createTestUser(t, "bob", "password123", false)
	_ = ts.createTestUser(t, "charlie", "password123", true)

	_, err := user1.Client.UpdateUser(ctx, &client.UpdateUserRequest{
		Username: client.Ptr("alice"), FirstName: client.Ptr("Alice"), LastName: client.Ptr("Smith"),
	})
	require.NoError(t, err)
	_, err = bob.Client.UpdateUser(ctx, &client.UpdateUserRequest{
		Username: client.Ptr("bob"), FirstName: client.Ptr("Robert"), LastName: client.Ptr("Jones"),
	})
	require.NoError(t, err)

	t.Run("no search param returns all except current user", func(t *testing.T) {
		users, err := user1.Client.SearchUsers(ctx, "")
		require.NoError(t, err)
		assert.Len(t, users, 2)
		for _, u := range users {
			assert.NotEqual(t, "alice", u.Username, "Should not include current user in results")
		}
	})

	t.Run("search filters by username", func(t *testing.T) {
		users, err := user1.Client.SearchUsers(ctx, "bob")
		require.NoError(t, err)
		require.Len(t, users, 1)
		assert.Equal(t, "bob", users[0].Username)
	})

	t.Run("search is case insensitive", func(t *testing.T) {
		users, err := user1.Client.SearchUsers(ctx, "BOB")
		require.NoError(t, err)
		require.Len(t, users, 1)
		assert.Equal(t, "bob", users[0].Username)
	})

	t.Run("search filters by first name", func(t *testing.T) {
		users, err := user1.Client.SearchUsers(ctx, "Robert")
		require.NoError(t, err)
		require.Len(t, users, 1)
		assert.Equal(t, "bob", users[0].Username)
	})

	t.Run("search filters by last name", func(t *testing.T) {
		users, err := user1.Client.SearchUsers(ctx, "Jones")
		require.NoError(t, err)
		require.Len(t, users, 1)
		assert.Equal(t, "bob", users[0].Username)
	})

	t.Run("search with no matches returns empty list", func(t *testing.T) {
		users, err := user1.Client.SearchUsers(ctx, "nonexistent")
		require.NoError(t, err)
		assert.Empty(t, users)
	})

	t.Run("search excludes current user from results", func(t *testing.T) {
		users, err := user1.Client.SearchUsers(ctx, "alice")
		require.NoError(t, err)
		assert.Empty(t, users, "Current user should not appear in search results")
	})

	t.Run("search without auth returns unauthorized", func(t *testing.T) {
		c := ts.newClient()
		_, err := c.SearchUsers(ctx, "")
		assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
	})
}

func TestEdgeCases(t *testing.T) {
	ts := setupTestServer(t)
	ctx := context.Background()
	user := ts.createTestUser(t, "user", "password123", false)

	t.Run("invalid note ID returns bad request", func(t *testing.T) {
		_, err := user.Client.GetNote(ctx, "invalid")
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("nonexistent note ID returns bad request", func(t *testing.T) {
		_, err := user.Client.GetNote(ctx, "999")
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("valid but nonexistent note ID returns not found", func(t *testing.T) {
		_, err := user.Client.GetNote(ctx, "abcdefghijklmnopqrstuv")
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
	})

	t.Run("create note with empty fields", func(t *testing.T) {
		_, err := user.Client.CreateNote(ctx, &client.CreateNoteRequest{})
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("create note with todo items", func(t *testing.T) {
		note, err := user.Client.CreateNote(ctx, &client.CreateNoteRequest{
			Title:    "Todo List",
			NoteType: client.NoteTypeTodo,
			Items: []client.CreateNoteItem{
				{Text: "Item 1", Position: 0},
				{Text: "Item 2", Position: 1},
			},
		})
		require.NoError(t, err)
		assert.Equal(t, client.NoteTypeTodo, note.NoteType)
	})

	t.Run("create note with items defaults note_type to todo", func(t *testing.T) {
		note, err := user.Client.CreateNote(ctx, &client.CreateNoteRequest{
			Title: "Implicit Todo",
			Items: []client.CreateNoteItem{
				{Text: "Item 1", Position: 0},
			},
		})
		require.NoError(t, err)
		assert.Equal(t, client.NoteTypeTodo, note.NoteType)
		assert.Len(t, note.Items, 1)
	})

	t.Run("create note rejects non-todo note_type when items are provided", func(t *testing.T) {
		_, err := user.Client.CreateNote(ctx, &client.CreateNoteRequest{
			Title:    "Conflicting Note Type",
			NoteType: client.NoteTypeText,
			Items: []client.CreateNoteItem{
				{Text: "Item 1", Position: 0},
			},
		})
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("update note with default color", func(t *testing.T) {
		created, err := user.Client.CreateNote(ctx, &client.CreateNoteRequest{
			Title:   "Test Note",
			Content: "Content",
		})
		require.NoError(t, err)

		updated, err := user.Client.UpdateNote(ctx, created.ID, &client.UpdateNoteRequest{
			Title:   "Updated",
			Content: "Updated",
		})
		require.NoError(t, err)
		assert.Equal(t, "#ffffff", updated.Color)
	})
}
