package main

import (
	"net/http"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func createSharedTodoNote(t *testing.T, ts *TestServer, owner *TestUser, sharedWith *TestUser) (string, string) {
	t.Helper()

	note, err := owner.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
		Title:    "Shared Todo",
		NoteType: client.NoteTypeTodo,
		Items: []client.CreateNoteItem{
			{Text: "Item 1", Position: 0, IndentLevel: 0},
			{Text: "Item 2", Position: 1, IndentLevel: 0},
		},
	})
	require.NoError(t, err)

	require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, sharedWith.User.ID))
	return note.ID, sharedWith.User.ID
}

func getNoteItems(t *testing.T, _ *TestServer, user *TestUser, noteID string) []client.NoteItem {
	t.Helper()
	note, err := user.Client.GetNote(t.Context(), noteID)
	require.NoError(t, err)
	return note.Items
}

func TestTaskAssignment(t *testing.T) {
	t.Run("create note items have empty assigned_to", func(t *testing.T) {
		ts := setupTestServer(t)
		
		user := ts.createTestUser(t, "user1", "password123", false)

		note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title:    "Todo",
			NoteType: client.NoteTypeTodo,
			Items: []client.CreateNoteItem{
				{Text: "Buy milk", Position: 0, IndentLevel: 0},
			},
		})
		require.NoError(t, err)
		assert.Empty(t, note.Items[0].AssignedTo)
	})

	t.Run("assigned_to is ignored on note creation", func(t *testing.T) {
		ts := setupTestServer(t)
		
		user := ts.createTestUser(t, "user1", "password123", false)

		note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title:    "Todo",
			NoteType: client.NoteTypeTodo,
			Items: []client.CreateNoteItem{
				{Text: "Buy milk", Position: 0, IndentLevel: 0},
			},
		})
		require.NoError(t, err)
		assert.Empty(t, note.Items[0].AssignedTo, "assigned_to should be ignored on create")
	})

	t.Run("assign item to shared user on update", func(t *testing.T) {
		ts := setupTestServer(t)
		
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, collabID := createSharedTodoNote(t, ts, owner, collaborator)

		_, err := owner.Client.UpdateNote(t.Context(), noteID, &client.UpdateNoteRequest{
			Title: "Shared Todo",
			Items: []client.UpdateNoteItem{
				{Text: "Item 1", Position: 0, IndentLevel: 0, AssignedTo: collabID},
				{Text: "Item 2", Position: 1, IndentLevel: 0},
			},
		})
		require.NoError(t, err)

		items := getNoteItems(t, ts, owner, noteID)
		assert.Equal(t, collabID, items[0].AssignedTo)
		assert.Empty(t, items[1].AssignedTo)
	})

	t.Run("self-assignment by owner", func(t *testing.T) {
		ts := setupTestServer(t)
		
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, _ := createSharedTodoNote(t, ts, owner, collaborator)

		_, err := owner.Client.UpdateNote(t.Context(), noteID, &client.UpdateNoteRequest{
			Title: "Shared Todo",
			Items: []client.UpdateNoteItem{
				{Text: "Item 1", Position: 0, IndentLevel: 0, AssignedTo: owner.User.ID},
			},
		})
		require.NoError(t, err)

		items := getNoteItems(t, ts, owner, noteID)
		assert.Equal(t, owner.User.ID, items[0].AssignedTo)
	})

	t.Run("reject assignment on unshared note", func(t *testing.T) {
		ts := setupTestServer(t)
		
		owner := ts.createTestUser(t, "owner", "password123", false)

		note, err := owner.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title:    "Solo Todo",
			NoteType: client.NoteTypeTodo,
			Items: []client.CreateNoteItem{
				{Text: "Item 1", Position: 0, IndentLevel: 0},
			},
		})
		require.NoError(t, err)

		_, err = owner.Client.UpdateNote(t.Context(), note.ID, &client.UpdateNoteRequest{
			Title: "Solo Todo",
			Items: []client.UpdateNoteItem{
				{Text: "Item 1", Position: 0, IndentLevel: 0, AssignedTo: owner.User.ID},
			},
		})
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("reject assignment to user without note access", func(t *testing.T) {
		ts := setupTestServer(t)
		
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)
		outsider := ts.createTestUser(t, "outsider", "password123", false)

		noteID, _ := createSharedTodoNote(t, ts, owner, collaborator)

		_, err := owner.Client.UpdateNote(t.Context(), noteID, &client.UpdateNoteRequest{
			Title: "Shared Todo",
			Items: []client.UpdateNoteItem{
				{Text: "Item 1", Position: 0, IndentLevel: 0, AssignedTo: outsider.User.ID},
			},
		})
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("reject assignment with invalid user ID format", func(t *testing.T) {
		ts := setupTestServer(t)
		
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, _ := createSharedTodoNote(t, ts, owner, collaborator)

		_, err := owner.Client.UpdateNote(t.Context(), noteID, &client.UpdateNoteRequest{
			Title: "Shared Todo",
			Items: []client.UpdateNoteItem{
				{Text: "Item 1", Position: 0, IndentLevel: 0, AssignedTo: "short"},
			},
		})
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("collaborator can assign items", func(t *testing.T) {
		ts := setupTestServer(t)
		
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, _ := createSharedTodoNote(t, ts, owner, collaborator)

		_, err := collaborator.Client.UpdateNote(t.Context(), noteID, &client.UpdateNoteRequest{
			Title: "Shared Todo",
			Items: []client.UpdateNoteItem{
				{Text: "Item 1", Position: 0, IndentLevel: 0, AssignedTo: owner.User.ID},
				{Text: "Item 2", Position: 1, IndentLevel: 0},
			},
		})
		require.NoError(t, err)

		items := getNoteItems(t, ts, owner, noteID)
		assert.Equal(t, owner.User.ID, items[0].AssignedTo)
	})

	t.Run("unassign item by setting empty assigned_to", func(t *testing.T) {
		ts := setupTestServer(t)
		
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, collabID := createSharedTodoNote(t, ts, owner, collaborator)

		_, err := owner.Client.UpdateNote(t.Context(), noteID, &client.UpdateNoteRequest{
			Title: "Shared Todo",
			Items: []client.UpdateNoteItem{
				{Text: "Item 1", Position: 0, IndentLevel: 0, AssignedTo: collabID},
			},
		})
		require.NoError(t, err)
		items := getNoteItems(t, ts, owner, noteID)
		assert.Equal(t, collabID, items[0].AssignedTo)

		_, err = owner.Client.UpdateNote(t.Context(), noteID, &client.UpdateNoteRequest{
			Title: "Shared Todo",
			Items: []client.UpdateNoteItem{
				{Text: "Item 1", Position: 0, IndentLevel: 0, AssignedTo: ""},
			},
		})
		require.NoError(t, err)
		items = getNoteItems(t, ts, owner, noteID)
		assert.Empty(t, items[0].AssignedTo)
	})

	t.Run("completed items retain assignment", func(t *testing.T) {
		ts := setupTestServer(t)
		
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, collabID := createSharedTodoNote(t, ts, owner, collaborator)

		_, err := owner.Client.UpdateNote(t.Context(), noteID, &client.UpdateNoteRequest{
			Title: "Shared Todo",
			Items: []client.UpdateNoteItem{
				{Text: "Item 1", Position: 0, IndentLevel: 0, Completed: true, AssignedTo: collabID},
			},
		})
		require.NoError(t, err)

		items := getNoteItems(t, ts, owner, noteID)
		assert.True(t, items[0].Completed)
		assert.Equal(t, collabID, items[0].AssignedTo)
	})
}

func TestMyTodoFilter(t *testing.T) {
	t.Run("returns notes with items assigned to current user", func(t *testing.T) {
		ts := setupTestServer(t)
		
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, collabID := createSharedTodoNote(t, ts, owner, collaborator)

		_, err := owner.Client.UpdateNote(t.Context(), noteID, &client.UpdateNoteRequest{
			Title: "Shared Todo",
			Items: []client.UpdateNoteItem{
				{Text: "Item 1", Position: 0, IndentLevel: 0, AssignedTo: collabID},
				{Text: "Item 2", Position: 1, IndentLevel: 0},
			},
		})
		require.NoError(t, err)

		notes, err := collaborator.Client.ListNotes(t.Context(), &client.ListNotesOptions{MyTodo: true})
		require.NoError(t, err)
		require.Len(t, notes, 1)
		assert.Equal(t, noteID, notes[0].ID)
	})

	t.Run("does not return notes without assignments to current user", func(t *testing.T) {
		ts := setupTestServer(t)
		
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, _ := createSharedTodoNote(t, ts, owner, collaborator)

		_, err := owner.Client.UpdateNote(t.Context(), noteID, &client.UpdateNoteRequest{
			Title: "Shared Todo",
			Items: []client.UpdateNoteItem{
				{Text: "Item 1", Position: 0, IndentLevel: 0, AssignedTo: owner.User.ID},
				{Text: "Item 2", Position: 1, IndentLevel: 0},
			},
		})
		require.NoError(t, err)

		notes, err := collaborator.Client.ListNotes(t.Context(), &client.ListNotesOptions{MyTodo: true})
		require.NoError(t, err)
		assert.Empty(t, notes)
	})

	t.Run("returns empty list when no assignments exist", func(t *testing.T) {
		ts := setupTestServer(t)
		
		owner := ts.createTestUser(t, "owner", "password123", false)

		_, err := owner.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title:    "Solo Todo",
			NoteType: client.NoteTypeTodo,
			Items: []client.CreateNoteItem{
				{Text: "Item 1", Position: 0, IndentLevel: 0},
			},
		})
		require.NoError(t, err)

		notes, err := owner.Client.ListNotes(t.Context(), &client.ListNotesOptions{MyTodo: true})
		require.NoError(t, err)
		assert.Empty(t, notes)
	})

	t.Run("owner sees own assignments in my_todo filter", func(t *testing.T) {
		ts := setupTestServer(t)
		
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, _ := createSharedTodoNote(t, ts, owner, collaborator)

		_, err := owner.Client.UpdateNote(t.Context(), noteID, &client.UpdateNoteRequest{
			Title: "Shared Todo",
			Items: []client.UpdateNoteItem{
				{Text: "Item 1", Position: 0, IndentLevel: 0, AssignedTo: owner.User.ID},
			},
		})
		require.NoError(t, err)

		notes, err := owner.Client.ListNotes(t.Context(), &client.ListNotesOptions{MyTodo: true})
		require.NoError(t, err)
		require.Len(t, notes, 1)
		assert.Equal(t, noteID, notes[0].ID)
	})

	t.Run("excludes trashed notes from my_todo filter", func(t *testing.T) {
		ts := setupTestServer(t)
		
		owner := ts.createTestUser(t, "owner", "password123", false)
		collaborator := ts.createTestUser(t, "collab", "password123", false)

		noteID, collabID := createSharedTodoNote(t, ts, owner, collaborator)

		_, err := owner.Client.UpdateNote(t.Context(), noteID, &client.UpdateNoteRequest{
			Title: "Shared Todo",
			Items: []client.UpdateNoteItem{
				{Text: "Item 1", Position: 0, IndentLevel: 0, AssignedTo: collabID},
			},
		})
		require.NoError(t, err)

		require.NoError(t, owner.Client.DeleteNote(t.Context(), noteID))

		notes, err := collaborator.Client.ListNotes(t.Context(), &client.ListNotesOptions{MyTodo: true})
		require.NoError(t, err)
		assert.Empty(t, notes)
	})
}

func TestTaskAssignmentUnshareCleanup(t *testing.T) {
	t.Run("unshare clears unshared users assignments", func(t *testing.T) {
		ts := setupTestServer(t)
		
		owner := ts.createTestUser(t, "owner", "password123", false)
		collab1 := ts.createTestUser(t, "collab1", "password123", false)
		collab2 := ts.createTestUser(t, "collab2", "password123", false)

		note, err := owner.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title:    "Shared Todo",
			NoteType: client.NoteTypeTodo,
			Items: []client.CreateNoteItem{
				{Text: "Item 1", Position: 0, IndentLevel: 0},
				{Text: "Item 2", Position: 1, IndentLevel: 0},
			},
		})
		require.NoError(t, err)

		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collab1.User.ID))
		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collab2.User.ID))

		_, err = owner.Client.UpdateNote(t.Context(), note.ID, &client.UpdateNoteRequest{
			Title: "Shared Todo",
			Items: []client.UpdateNoteItem{
				{Text: "Item 1", Position: 0, IndentLevel: 0, AssignedTo: collab1.User.ID},
				{Text: "Item 2", Position: 1, IndentLevel: 0, AssignedTo: collab2.User.ID},
			},
		})
		require.NoError(t, err)

		require.NoError(t, owner.Client.UnshareNote(t.Context(), note.ID, collab1.User.ID))

		items := getNoteItems(t, ts, owner, note.ID)
		assert.Empty(t, items[0].AssignedTo, "collab1's assignment should be cleared")
		assert.Equal(t, collab2.User.ID, items[1].AssignedTo, "collab2's assignment should remain")
	})

	t.Run("unshare last collaborator clears all assignments including owner", func(t *testing.T) {
		ts := setupTestServer(t)
		
		owner := ts.createTestUser(t, "owner", "password123", false)
		collab := ts.createTestUser(t, "collab", "password123", false)

		noteID, _ := createSharedTodoNote(t, ts, owner, collab)

		_, err := owner.Client.UpdateNote(t.Context(), noteID, &client.UpdateNoteRequest{
			Title: "Shared Todo",
			Items: []client.UpdateNoteItem{
				{Text: "Item 1", Position: 0, IndentLevel: 0, AssignedTo: owner.User.ID},
				{Text: "Item 2", Position: 1, IndentLevel: 0, AssignedTo: collab.User.ID},
			},
		})
		require.NoError(t, err)

		require.NoError(t, owner.Client.UnshareNote(t.Context(), noteID, collab.User.ID))

		items := getNoteItems(t, ts, owner, noteID)
		assert.Empty(t, items[0].AssignedTo, "owner's self-assignment should be cleared")
		assert.Empty(t, items[1].AssignedTo, "collab's assignment should be cleared")
	})
}

func TestTaskAssignmentUserDeletion(t *testing.T) {
	t.Run("deleting a user clears their assignments across all notes", func(t *testing.T) {
		ts := setupTestServer(t)
		
		admin := ts.createTestUser(t, "admin", "password123", true)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collab1 := ts.createTestUser(t, "collab1", "password123", false)
		collab2 := ts.createTestUser(t, "collab2", "password123", false)

		note, err := owner.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title:    "Shared Todo",
			NoteType: client.NoteTypeTodo,
			Items: []client.CreateNoteItem{
				{Text: "Item 1", Position: 0, IndentLevel: 0},
				{Text: "Item 2", Position: 1, IndentLevel: 0},
			},
		})
		require.NoError(t, err)

		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collab1.User.ID))
		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collab2.User.ID))

		_, err = owner.Client.UpdateNote(t.Context(), note.ID, &client.UpdateNoteRequest{
			Title: "Shared Todo",
			Items: []client.UpdateNoteItem{
				{Text: "Item 1", Position: 0, IndentLevel: 0, AssignedTo: collab1.User.ID},
				{Text: "Item 2", Position: 1, IndentLevel: 0, AssignedTo: collab2.User.ID},
			},
		})
		require.NoError(t, err)

		require.NoError(t, admin.Client.AdminDeleteUser(t.Context(), collab1.User.ID))

		items := getNoteItems(t, ts, owner, note.ID)
		assert.Empty(t, items[0].AssignedTo, "deleted user's assignment should be cleared")
		assert.Equal(t, collab2.User.ID, items[1].AssignedTo, "other collab's assignment should remain")
	})

	t.Run("deleting last collaborator clears all assignments including owner self-assignment", func(t *testing.T) {
		ts := setupTestServer(t)
		
		admin := ts.createTestUser(t, "admin", "password123", true)
		owner := ts.createTestUser(t, "owner", "password123", false)
		collab := ts.createTestUser(t, "collab", "password123", false)

		noteID, collabID := createSharedTodoNote(t, ts, owner, collab)

		_, err := owner.Client.UpdateNote(t.Context(), noteID, &client.UpdateNoteRequest{
			Title: "Shared Todo",
			Items: []client.UpdateNoteItem{
				{Text: "Item 1", Position: 0, IndentLevel: 0, AssignedTo: owner.User.ID},
				{Text: "Item 2", Position: 1, IndentLevel: 0, AssignedTo: collabID},
			},
		})
		require.NoError(t, err)

		require.NoError(t, admin.Client.AdminDeleteUser(t.Context(), collabID))

		items := getNoteItems(t, ts, owner, noteID)
		assert.Empty(t, items[0].AssignedTo, "owner's self-assignment should be cleared when note becomes unshared")
		assert.Empty(t, items[1].AssignedTo, "deleted collab's assignment should be cleared")
	})
}
