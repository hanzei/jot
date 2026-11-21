package main

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/sse"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// isNoteEvent matches an SSE event of eventType about one of noteIDs.
func isNoteEvent(eventType sse.EventType, noteIDs ...string) func(client.SSEEvent) bool {
	return func(e client.SSEEvent) bool {
		return e.Type == string(eventType) && e.NoteData != nil && slices.Contains(noteIDs, e.NoteData.NoteID)
	}
}

// waitForNoteEvents waits for an eventType event about each of noteIDs, in any
// order, and returns the IDs it did not see before the timeout.
// waitForSSEEvent alone cannot do this: it drops every event it skips.
func waitForNoteEvents(ch <-chan client.SSEEvent, eventType sse.EventType, noteIDs []string, timeout time.Duration) []string {
	missing := slices.Clone(noteIDs)
	deadline := time.After(timeout)
	for len(missing) > 0 {
		select {
		case e, ok := <-ch:
			if !ok {
				return missing
			}
			if e.Type == string(eventType) && e.NoteData != nil {
				missing = slices.DeleteFunc(missing, func(id string) bool { return id == e.NoteData.NoteID })
			}
		case <-deadline:
			return missing
		}
	}
	return nil
}

// Deleting a user's notes, with or without their account, tells everyone who
// could still see each note (#1319). A trashed note's collaborators heard
// note_deleted when it was trashed, and an unshared note has no one else to
// tell.
func TestUserDeleteSSENotifiesCollaboratorsOfOwnedNotes(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	admin := ts.createTestUser(t, "deladmin", "password123", true)

	for _, tc := range []struct {
		name   string
		prefix string
		// ownerKeepsAccount: the owner's own sessions hear of the delete too.
		ownerKeepsAccount bool
		del               func(t *testing.T, owner *TestUser)
	}{
		{name: "owner deletes their account", prefix: "delself", del: func(t *testing.T, owner *TestUser) {
			require.NoError(t, owner.Client.DeleteMe(t.Context(), "password123", ""))
		}},
		{name: "admin deletes the owner", prefix: "deladm", del: func(t *testing.T, owner *TestUser) {
			require.NoError(t, admin.Client.AdminDeleteUser(t.Context(), owner.User.ID))
		}},
		{name: "admin deletes the owner's notes", prefix: "delnotes", ownerKeepsAccount: true, del: func(t *testing.T, owner *TestUser) {
			deleted, err := admin.Client.AdminDeleteUserNotes(t.Context(), owner.User.ID)
			require.NoError(t, err)
			assert.Equal(t, 3, deleted)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Each case has its own users, so the cases touch disjoint data.
			t.Parallel()
			owner := ts.createTestUser(t, tc.prefix+"owner", "password123", false)
			collab := ts.createTestUser(t, tc.prefix+"collab", "password123", false)

			shared, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "Shared"})
			require.NoError(t, err)
			require.NoError(t, owner.Client.ShareNote(t.Context(), shared.ID, collab.User.ID))
			private, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "Private"})
			require.NoError(t, err)
			trashed, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "Trashed"})
			require.NoError(t, err)
			require.NoError(t, owner.Client.ShareNote(t.Context(), trashed.ID, collab.User.ID))
			require.NoError(t, owner.Client.DeleteNote(t.Context(), trashed.ID))

			sseCtx, sseCancel := context.WithCancel(t.Context())
			t.Cleanup(sseCancel)
			collabCh, err := collab.Client.SubscribeSSE(sseCtx)
			require.NoError(t, err)
			var ownerCh <-chan client.SSEEvent
			if tc.ownerKeepsAccount {
				ownerCh, err = owner.Client.SubscribeSSE(sseCtx)
				require.NoError(t, err)
			}

			tc.del(t, owner)

			_, found := waitForSSEEvent(collabCh, isNoteEvent(sse.EventNoteDeleted, shared.ID), 3*time.Second)
			assert.True(t, found, "collaborator should receive note_deleted for the shared note")
			_, found = waitForSSEEvent(collabCh, isNoteEvent(sse.EventNoteDeleted, private.ID, trashed.ID), 500*time.Millisecond)
			assert.False(t, found, "collaborator should hear nothing of notes it could not see")

			if tc.ownerKeepsAccount {
				missing := waitForNoteEvents(ownerCh, sse.EventNoteDeleted, []string{shared.ID, private.ID, trashed.ID}, 3*time.Second)
				assert.Empty(t, missing, "owner should receive note_deleted for every note")
			}
		})
	}
}

// Deleting a collaborator removes their shares and their assignments, and
// clears every assignment on a note left with no shares; the owner and the
// remaining collaborators receive note_unshared targeting the deleted user,
// which makes their clients refetch the note (#1319).
func TestUserDeleteSSENotifiesRemainingCollaborators(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "shareeowner", "password123", false)
	other := ts.createTestUser(t, "shareeother", "password123", false)
	sharee := ts.createTestUser(t, "shareegone", "password123", false)

	// group stays shared with other; the item assigned to sharee is cleared.
	group, err := owner.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
		Title: "Group",
		Items: []client.CreateNoteItem{{Text: "Theirs"}},
	})
	require.NoError(t, err)
	require.NoError(t, owner.Client.ShareNote(t.Context(), group.ID, other.User.ID))
	require.NoError(t, owner.Client.ShareNote(t.Context(), group.ID, sharee.User.ID))
	require.Len(t, group.Items, 1)
	_, err = owner.Client.UpdateNoteItem(t.Context(), group.ID, group.Items[0].ID, &client.PatchNoteItemRequest{AssignedTo: &sharee.User.ID})
	require.NoError(t, err)

	// pair is left unshared, so even the owner's own assignment is cleared.
	pair, err := owner.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
		Title: "Pair",
		Items: []client.CreateNoteItem{{Text: "Mine"}},
	})
	require.NoError(t, err)
	require.NoError(t, owner.Client.ShareNote(t.Context(), pair.ID, sharee.User.ID))
	require.Len(t, pair.Items, 1)
	_, err = owner.Client.UpdateNoteItem(t.Context(), pair.ID, pair.Items[0].ID, &client.PatchNoteItemRequest{AssignedTo: &owner.User.ID})
	require.NoError(t, err)

	sseCtx, sseCancel := context.WithCancel(t.Context())
	t.Cleanup(sseCancel)
	ownerCh, err := owner.Client.SubscribeSSE(sseCtx)
	require.NoError(t, err)
	otherCh, err := other.Client.SubscribeSSE(sseCtx)
	require.NoError(t, err)

	require.NoError(t, sharee.Client.DeleteMe(t.Context(), "password123", ""))

	assert.Empty(t, waitForNoteEvents(ownerCh, sse.EventNoteUnshared, []string{group.ID, pair.ID}, 3*time.Second),
		"owner should receive note_unshared for both notes")
	event, found := waitForSSEEvent(otherCh, isNoteEvent(sse.EventNoteUnshared, group.ID), 3*time.Second)
	require.True(t, found, "remaining collaborator should receive note_unshared")
	assert.Equal(t, sharee.User.ID, event.TargetUserID, "the target is the deleted user")
	assert.Equal(t, sharee.User.ID, event.SourceUserID)
	_, found = waitForSSEEvent(otherCh, isNoteEvent(sse.EventNoteUnshared, pair.ID), 500*time.Millisecond)
	assert.False(t, found, "a user who could not see the note should hear nothing of it")

	// What the refetch the event triggers finds.
	refetched, err := owner.Client.GetNote(t.Context(), group.ID)
	require.NoError(t, err)
	require.Len(t, refetched.SharedWith, 1)
	assert.Equal(t, other.User.ID, refetched.SharedWith[0].SharedWithUserID)
	require.Len(t, refetched.Items, 1)
	assert.Empty(t, refetched.Items[0].AssignedTo)

	refetched, err = owner.Client.GetNote(t.Context(), pair.ID)
	require.NoError(t, err)
	assert.Empty(t, refetched.SharedWith)
	require.Len(t, refetched.Items, 1)
	assert.Empty(t, refetched.Items[0].AssignedTo)
}
