package main

import (
	"net/http"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Note sharing endpoint tests
func TestNoteSharingEndpoints(t *testing.T) {
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "owner", "password123", false)
	sharedUser := ts.createTestUser(t, "user", "password123", false)
	other := ts.createTestUser(t, "other", "password123", false)

	note, err := owner.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
		Title:   "Shared Note",
		Content: "This will be shared",
	})
	require.NoError(t, err)

	t.Run("share note with user", func(t *testing.T) {
		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, sharedUser.User.ID))
	})

	t.Run("share with duplicate user returns conflict", func(t *testing.T) {
		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, other.User.ID))

		err := owner.Client.ShareNote(t.Context(), note.ID, other.User.ID)
		assert.Equal(t, http.StatusConflict, client.StatusCode(err))
	})

	t.Run("share with nonexistent user_id returns not found", func(t *testing.T) {
		err := owner.Client.ShareNote(t.Context(), note.ID, "abcdefghijklmnopqrstuv")
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
	})

	t.Run("share with empty user_id returns bad request", func(t *testing.T) {
		err := owner.Client.ShareNote(t.Context(), note.ID, "")
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("share with invalid user_id format returns bad request", func(t *testing.T) {
		err := owner.Client.ShareNote(t.Context(), note.ID, "invalid")
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("share with self returns bad request", func(t *testing.T) {
		err := owner.Client.ShareNote(t.Context(), note.ID, owner.User.ID)
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("share by non-owner returns forbidden", func(t *testing.T) {
		err := other.Client.ShareNote(t.Context(), note.ID, sharedUser.User.ID)
		assert.Equal(t, http.StatusForbidden, client.StatusCode(err))
	})

	t.Run("get note shares", func(t *testing.T) {
		shares, err := owner.Client.GetNoteShares(t.Context(), note.ID)
		require.NoError(t, err)
		assert.GreaterOrEqual(t, len(shares), 1)
	})

	t.Run("get note shares by non-owner returns forbidden", func(t *testing.T) {
		_, err := other.Client.GetNoteShares(t.Context(), note.ID)
		assert.Equal(t, http.StatusForbidden, client.StatusCode(err))
	})

	t.Run("unshare note", func(t *testing.T) {
		require.NoError(t, owner.Client.UnshareNote(t.Context(), note.ID, sharedUser.User.ID))
	})

	t.Run("unshare with invalid user_id format returns bad request", func(t *testing.T) {
		err := owner.Client.UnshareNote(t.Context(), note.ID, "invalid")
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("unshare by non-owner returns forbidden", func(t *testing.T) {
		err := other.Client.UnshareNote(t.Context(), note.ID, sharedUser.User.ID)
		assert.Equal(t, http.StatusForbidden, client.StatusCode(err))
	})

	t.Run("unshare non-shared user returns not found", func(t *testing.T) {
		err := owner.Client.UnshareNote(t.Context(), note.ID, sharedUser.User.ID)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
	})
}

func TestSearchUsersEndpoint(t *testing.T) {
	ts := setupTestServer(t)
	user1 := ts.createTestUser(t, "alice", "password123", false)
	bob := ts.createTestUser(t, "bob", "password123", false)
	_ = ts.createTestUser(t, "charlie", "password123", true)

	_, err := user1.Client.UpdateUser(t.Context(), &client.UpdateUserRequest{
		Username: client.Ptr("alice"), FirstName: client.Ptr("Alice"), LastName: client.Ptr("Smith"),
	})
	require.NoError(t, err)
	_, err = bob.Client.UpdateUser(t.Context(), &client.UpdateUserRequest{
		Username: client.Ptr("bob"), FirstName: client.Ptr("Robert"), LastName: client.Ptr("Jones"),
	})
	require.NoError(t, err)

	t.Run("no search param returns all except current user", func(t *testing.T) {
		users, err := user1.Client.SearchUsers(t.Context(), "")
		require.NoError(t, err)
		assert.Len(t, users, 2)
		for _, u := range users {
			assert.NotEqual(t, "alice", u.Username, "Should not include current user in results")
		}
	})

	t.Run("search filters by username", func(t *testing.T) {
		users, err := user1.Client.SearchUsers(t.Context(), "bob")
		require.NoError(t, err)
		require.Len(t, users, 1)
		assert.Equal(t, "bob", users[0].Username)
	})

	t.Run("search is case insensitive", func(t *testing.T) {
		users, err := user1.Client.SearchUsers(t.Context(), "BOB")
		require.NoError(t, err)
		require.Len(t, users, 1)
		assert.Equal(t, "bob", users[0].Username)
	})

	t.Run("search filters by first name", func(t *testing.T) {
		users, err := user1.Client.SearchUsers(t.Context(), "Robert")
		require.NoError(t, err)
		require.Len(t, users, 1)
		assert.Equal(t, "bob", users[0].Username)
	})

	t.Run("search filters by last name", func(t *testing.T) {
		users, err := user1.Client.SearchUsers(t.Context(), "Jones")
		require.NoError(t, err)
		require.Len(t, users, 1)
		assert.Equal(t, "bob", users[0].Username)
	})

	t.Run("search with no matches returns empty list", func(t *testing.T) {
		users, err := user1.Client.SearchUsers(t.Context(), "nonexistent")
		require.NoError(t, err)
		assert.Empty(t, users)
	})

	t.Run("search excludes current user from results", func(t *testing.T) {
		users, err := user1.Client.SearchUsers(t.Context(), "alice")
		require.NoError(t, err)
		assert.Empty(t, users, "Current user should not appear in search results")
	})

	t.Run("search without auth returns unauthorized", func(t *testing.T) {
		c := ts.newClient()
		_, err := c.SearchUsers(t.Context(), "")
		assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
	})
}

// TestPerUserNoteState verifies that per-user fields (color, pinned, archived, labels)
// are isolated per collaborator while shared fields (title, content, items) are visible to all.
func TestPerUserNoteState(t *testing.T) {
	t.Run("collaborator color change does not affect owner", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collab := ts.createTestUser(t, "collab", "password123", false)

		note, err := owner.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title: "Shared Note",
			Color: "#ff0000",
		})
		require.NoError(t, err)
		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collab.User.ID))

		_, err = collab.Client.UpdateNote(t.Context(), note.ID, &client.UpdateNoteRequest{
			Color: client.Ptr("#0000ff"),
		})
		require.NoError(t, err)

		ownerNote, err := owner.Client.GetNote(t.Context(), note.ID)
		require.NoError(t, err)
		assert.Equal(t, "#ff0000", ownerNote.Color, "owner color should be unchanged")

		collabNote, err := collab.Client.GetNote(t.Context(), note.ID)
		require.NoError(t, err)
		assert.Equal(t, "#0000ff", collabNote.Color, "collaborator should see their own color")
	})

	t.Run("collaborator archive does not affect owner", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collab := ts.createTestUser(t, "collab", "password123", false)

		note, err := owner.Client.CreateNote(t.Context(), &client.CreateNoteRequest{Title: "Shared Note"})
		require.NoError(t, err)
		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collab.User.ID))

		_, err = collab.Client.UpdateNote(t.Context(), note.ID, &client.UpdateNoteRequest{
			Archived: client.Ptr(true),
		})
		require.NoError(t, err)

		ownerNotes, err := owner.Client.ListNotes(t.Context(), nil)
		require.NoError(t, err)
		ids := make([]string, len(ownerNotes))
		for i, n := range ownerNotes {
			ids[i] = n.ID
		}
		assert.Contains(t, ids, note.ID, "owner should still see note in active list")

		collabNotes, err := collab.Client.ListNotes(t.Context(), nil)
		require.NoError(t, err)
		for _, n := range collabNotes {
			assert.NotEqual(t, note.ID, n.ID, "collaborator should not see archived note in active list")
		}
	})

	t.Run("collaborator pin does not affect owner", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collab := ts.createTestUser(t, "collab", "password123", false)

		note, err := owner.Client.CreateNote(t.Context(), &client.CreateNoteRequest{Title: "Shared Note"})
		require.NoError(t, err)
		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collab.User.ID))

		_, err = collab.Client.UpdateNote(t.Context(), note.ID, &client.UpdateNoteRequest{
			Pinned: client.Ptr(true),
		})
		require.NoError(t, err)

		ownerNote, err := owner.Client.GetNote(t.Context(), note.ID)
		require.NoError(t, err)
		assert.False(t, ownerNote.Pinned, "owner should not see the note as pinned")

		collabNote, err := collab.Client.GetNote(t.Context(), note.ID)
		require.NoError(t, err)
		assert.True(t, collabNote.Pinned, "collaborator should see the note as pinned")
	})

	t.Run("labels applied by collaborator are only visible to that collaborator", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collab := ts.createTestUser(t, "collab", "password123", false)

		note, err := owner.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title:  "Shared Note",
			Labels: []string{"owner-label"},
		})
		require.NoError(t, err)
		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collab.User.ID))

		_, err = collab.Client.AddLabel(t.Context(), note.ID, "collab-label")
		require.NoError(t, err)

		ownerNote, err := owner.Client.GetNote(t.Context(), note.ID)
		require.NoError(t, err)
		require.Len(t, ownerNote.Labels, 1)
		assert.Equal(t, "owner-label", ownerNote.Labels[0].Name)

		collabNote, err := collab.Client.GetNote(t.Context(), note.ID)
		require.NoError(t, err)
		require.Len(t, collabNote.Labels, 1)
		assert.Equal(t, "collab-label", collabNote.Labels[0].Name)
	})

	t.Run("shared fields title and content are visible to all collaborators", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collab := ts.createTestUser(t, "collab", "password123", false)

		note, err := owner.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title:   "Original Title",
			Content: "Original Content",
		})
		require.NoError(t, err)
		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collab.User.ID))

		_, err = collab.Client.UpdateNote(t.Context(), note.ID, &client.UpdateNoteRequest{
			Title:   client.Ptr("Updated Title"),
			Content: client.Ptr("Updated Content"),
		})
		require.NoError(t, err)

		ownerNote, err := owner.Client.GetNote(t.Context(), note.ID)
		require.NoError(t, err)
		assert.Equal(t, "Updated Title", ownerNote.Title)
		assert.Equal(t, "Updated Content", ownerNote.Content)
	})

	t.Run("collaborator can reorder notes independently from owner", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collab := ts.createTestUser(t, "collab", "password123", false)
		unshared, err := owner.Client.CreateNote(t.Context(), &client.CreateNoteRequest{Title: "Owner-only"})
		require.NoError(t, err)

		noteA, err := owner.Client.CreateNote(t.Context(), &client.CreateNoteRequest{Title: "Note A"})
		require.NoError(t, err)
		noteB, err := owner.Client.CreateNote(t.Context(), &client.CreateNoteRequest{Title: "Note B"})
		require.NoError(t, err)
		require.NoError(t, owner.Client.ShareNote(t.Context(), noteA.ID, collab.User.ID))
		require.NoError(t, owner.Client.ShareNote(t.Context(), noteB.ID, collab.User.ID))

		// Collaborator reorders: noteB before noteA.
		err = collab.Client.ReorderNotes(t.Context(), []string{noteB.ID, noteA.ID})
		require.NoError(t, err)

		collabNotes, err := collab.Client.ListNotes(t.Context(), nil)
		require.NoError(t, err)
		require.GreaterOrEqual(t, len(collabNotes), 2)
		collabIDs := make([]string, 0, 2)
		for _, n := range collabNotes {
			if n.ID == noteA.ID || n.ID == noteB.ID {
				collabIDs = append(collabIDs, n.ID)
			}
		}
		require.Len(t, collabIDs, 2)
		assert.Equal(t, noteB.ID, collabIDs[0], "collaborator should see noteB first")
		assert.Equal(t, noteA.ID, collabIDs[1], "collaborator should see noteA second")

		// Shared-note reorder payload must include all collaborator-visible unpinned notes.
		// Because the collaborator cannot see owner's private note, this remains valid.
		err = collab.Client.ReorderNotes(t.Context(), []string{noteA.ID, noteB.ID})
		require.NoError(t, err)

		ownerNotes, err := owner.Client.ListNotes(t.Context(), nil)
		require.NoError(t, err)
		ownerIDs := make([]string, 0, 3)
		for _, n := range ownerNotes {
			if n.ID == noteA.ID || n.ID == noteB.ID || n.ID == unshared.ID {
				ownerIDs = append(ownerIDs, n.ID)
			}
		}
		require.Len(t, ownerIDs, 3)
		assert.Equal(t, noteB.ID, ownerIDs[0], "owner's order remains independent from collaborator reorders")
	})

	t.Run("unshare cleans up collaborator state so re-share starts fresh", func(t *testing.T) {
		ts := setupTestServer(t)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collab := ts.createTestUser(t, "collab", "password123", false)

		note, err := owner.Client.CreateNote(t.Context(), &client.CreateNoteRequest{Title: "Shared Note"})
		require.NoError(t, err)
		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collab.User.ID))

		_, err = collab.Client.UpdateNote(t.Context(), note.ID, &client.UpdateNoteRequest{
			Color: client.Ptr("#ff0000"),
		})
		require.NoError(t, err)
		_, err = collab.Client.AddLabel(t.Context(), note.ID, "collab-label")
		require.NoError(t, err)

		collabNote, err := collab.Client.GetNote(t.Context(), note.ID)
		require.NoError(t, err)
		assert.Equal(t, "#ff0000", collabNote.Color)
		require.Len(t, collabNote.Labels, 1)

		require.NoError(t, owner.Client.UnshareNote(t.Context(), note.ID, collab.User.ID))
		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collab.User.ID))

		collabNote, err = collab.Client.GetNote(t.Context(), note.ID)
		require.NoError(t, err)
		assert.Equal(t, "#ffffff", collabNote.Color, "color should reset to default after re-share")
		assert.Empty(t, collabNote.Labels, "labels should be cleared after re-share")
	})
}

func TestEdgeCases(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "user", "password123", false)

	t.Run("invalid note ID returns bad request", func(t *testing.T) {
		_, err := user.Client.GetNote(t.Context(), "invalid")
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("short note ID returns bad request", func(t *testing.T) {
		_, err := user.Client.GetNote(t.Context(), "999")
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("valid but nonexistent note ID returns not found", func(t *testing.T) {
		_, err := user.Client.GetNote(t.Context(), "abcdefghijklmnopqrstuv")
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
	})

	t.Run("create note with empty fields", func(t *testing.T) {
		_, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{})
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("create note with todo items", func(t *testing.T) {
		note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
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
		note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
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
		_, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title:    "Conflicting Note Type",
			NoteType: client.NoteTypeText,
			Items: []client.CreateNoteItem{
				{Text: "Item 1", Position: 0},
			},
		})
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("update note with default color", func(t *testing.T) {
		created, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title:   "Test Note",
			Content: "Content",
		})
		require.NoError(t, err)

		updated, err := user.Client.UpdateNote(t.Context(), created.ID, &client.UpdateNoteRequest{
			Title:   client.Ptr("Updated"),
			Content: client.Ptr("Updated"),
		})
		require.NoError(t, err)
		assert.Equal(t, "#ffffff", updated.Color)
	})
}
