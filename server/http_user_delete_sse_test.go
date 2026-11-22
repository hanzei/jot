package main

import (
	"bytes"
	"context"
	"slices"
	"testing"
	"time"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/sse"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// collectNoteEvents reads eventType events from ch until it has one about
// each of want (or timeout passes), then for a further settle period, and
// returns the first event per note ID. Unlike waitForSSEEvent it keeps every
// event, so a test can also assert that a note produced none, whichever order
// the events arrived in.
func collectNoteEvents(ch <-chan client.SSEEvent, eventType sse.EventType, want []string, timeout, settle time.Duration) map[string]client.SSEEvent {
	seen := map[string]client.SSEEvent{}
	deadline := time.After(timeout)
	var settled <-chan time.Time
	missing := slices.Clone(want)
	if len(missing) == 0 {
		settled = time.After(settle)
	}
	for {
		select {
		case e, ok := <-ch:
			if !ok {
				return seen
			}
			if e.Type != string(eventType) || e.NoteData == nil {
				continue
			}
			if _, dup := seen[e.NoteData.NoteID]; !dup {
				seen[e.NoteData.NoteID] = e
			}
			missing = slices.DeleteFunc(missing, func(id string) bool { return id == e.NoteData.NoteID })
			if len(missing) == 0 && settled == nil {
				settled = time.After(settle)
			}
		case <-settled:
			return seen
		case <-deadline:
			return seen
		}
	}
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

			seen := collectNoteEvents(collabCh, sse.EventNoteDeleted, []string{shared.ID}, 3*time.Second, 500*time.Millisecond)
			assert.Contains(t, seen, shared.ID, "collaborator should receive note_deleted for the shared note")
			assert.NotContains(t, seen, private.ID, "collaborator should hear nothing of a note it could not see")
			assert.NotContains(t, seen, trashed.ID, "collaborator heard of the trashed note when it was trashed")

			if tc.ownerKeepsAccount {
				all := []string{shared.ID, private.ID, trashed.ID}
				seen = collectNoteEvents(ownerCh, sse.EventNoteDeleted, all, 3*time.Second, 0)
				for _, id := range all {
					assert.Contains(t, seen, id, "owner should receive note_deleted for every note")
				}
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

	// former is no longer shared with sharee, but keeps the image they
	// uploaded while it was; their delete takes the image with it.
	former, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "Former"})
	require.NoError(t, err)
	require.NoError(t, owner.Client.ShareNote(t.Context(), former.ID, sharee.User.ID))
	_, err = sharee.Client.UploadNoteImage(t.Context(), former.ID, "cat.png", bytes.NewReader(testPNG(t, 4, 4)))
	require.NoError(t, err)
	require.NoError(t, owner.Client.UnshareNote(t.Context(), former.ID, sharee.User.ID))

	// binned is in the owner's trash, where they can't fetch it to refresh.
	binned, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "Binned"})
	require.NoError(t, err)
	require.NoError(t, owner.Client.ShareNote(t.Context(), binned.ID, sharee.User.ID))
	require.NoError(t, owner.Client.DeleteNote(t.Context(), binned.ID))

	sseCtx, sseCancel := context.WithCancel(t.Context())
	t.Cleanup(sseCancel)
	ownerCh, err := owner.Client.SubscribeSSE(sseCtx)
	require.NoError(t, err)
	otherCh, err := other.Client.SubscribeSSE(sseCtx)
	require.NoError(t, err)

	require.NoError(t, sharee.Client.DeleteMe(t.Context(), "password123", ""))

	changed := []string{group.ID, pair.ID, former.ID}
	seen := collectNoteEvents(ownerCh, sse.EventNoteUnshared, changed, 3*time.Second, 500*time.Millisecond)
	for _, id := range changed {
		assert.Contains(t, seen, id, "owner should receive note_unshared for every note the delete changed")
	}
	assert.NotContains(t, seen, binned.ID, "a trashed note sends no event")

	seen = collectNoteEvents(otherCh, sse.EventNoteUnshared, []string{group.ID}, 3*time.Second, 500*time.Millisecond)
	require.Contains(t, seen, group.ID, "remaining collaborator should receive note_unshared")
	assert.Equal(t, sharee.User.ID, seen[group.ID].TargetUserID, "the target is the deleted user")
	assert.Equal(t, sharee.User.ID, seen[group.ID].SourceUserID)
	for _, id := range []string{pair.ID, former.ID, binned.ID} {
		assert.NotContains(t, seen, id, "a user who could not see the note should hear nothing of it")
	}

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

	refetched, err = owner.Client.GetNote(t.Context(), former.ID)
	require.NoError(t, err)
	assert.Empty(t, refetched.Images)
}
