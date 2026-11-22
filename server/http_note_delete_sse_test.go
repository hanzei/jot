package main

import (
	"context"
	"testing"
	"time"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/sse"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// note_deleted says whether the note is gone for good, so a client that keeps
// a local copy can drop it rather than move it to its trash (#1324). The
// account-level paths are covered by TestUserDeleteSSENotifiesCollaboratorsOfOwnedNotes.
func TestNoteDeleteSSEPermanentFlag(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)

	for _, tc := range []struct {
		name   string
		prefix string
		// trashFirst: the note is in the trash before del runs, and the
		// subscription starts after that, so it sees del's event only.
		trashFirst bool
		del        func(t *testing.T, owner *TestUser, noteID string)
		permanent  bool
	}{
		{name: "move to trash", prefix: "sdtrash", del: func(t *testing.T, owner *TestUser, noteID string) {
			require.NoError(t, owner.Client.DeleteNote(t.Context(), noteID))
		}},
		{name: "delete from trash", prefix: "sdperm", trashFirst: true, permanent: true, del: func(t *testing.T, owner *TestUser, noteID string) {
			require.NoError(t, owner.Client.DeleteNotePermanently(t.Context(), noteID))
		}},
		{name: "empty trash", prefix: "sdempty", trashFirst: true, permanent: true, del: func(t *testing.T, owner *TestUser, _ string) {
			resp, err := owner.Client.EmptyTrash(t.Context())
			require.NoError(t, err)
			assert.Equal(t, 1, resp.Deleted)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Each case has its own user, so the cases touch disjoint data.
			t.Parallel()
			owner := ts.createTestUser(t, tc.prefix+"owner", "password123", false)
			note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "Doomed"})
			require.NoError(t, err)
			if tc.trashFirst {
				require.NoError(t, owner.Client.DeleteNote(t.Context(), note.ID))
			}

			sseCtx, sseCancel := context.WithCancel(t.Context())
			t.Cleanup(sseCancel)
			ch, err := owner.Client.SubscribeSSE(sseCtx)
			require.NoError(t, err)

			tc.del(t, owner, note.ID)

			event, found := waitForSSEEvent(ch, func(e client.SSEEvent) bool {
				return e.Type == string(sse.EventNoteDeleted) && e.NoteData != nil && e.NoteData.NoteID == note.ID
			}, 3*time.Second)
			require.True(t, found, "owner should receive note_deleted")
			assert.Equal(t, tc.permanent, event.NoteData.Permanent)
		})
	}
}
