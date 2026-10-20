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

// note_shared goes to the note's whole audience; target_user_id names the user
// the note was just shared with, which is how clients tell "shared with you"
// apart from "a collaborator was added to a note you already have".
func TestNoteShareSSETargetsNewRecipient(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "sharesseowner", "password123", false)
	existing := ts.createTestUser(t, "sharesseexisting", "password123", false)
	recipient := ts.createTestUser(t, "sharesserecipient", "password123", false)

	note, err := owner.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{Title: "Plans"})
	require.NoError(t, err)
	require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, existing.User.ID))

	sseCtx, sseCancel := context.WithCancel(t.Context())
	t.Cleanup(sseCancel)

	recipientCh, err := recipient.Client.SubscribeSSE(sseCtx)
	require.NoError(t, err)
	existingCh, err := existing.Client.SubscribeSSE(sseCtx)
	require.NoError(t, err)

	require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, recipient.User.ID))

	isShare := func(e client.SSEEvent) bool {
		return e.Type == string(sse.EventNoteShared) && e.NoteData != nil && e.NoteData.NoteID == note.ID
	}

	event, found := waitForSSEEvent(recipientCh, isShare, 3*time.Second)
	require.True(t, found, "recipient should receive note_shared")
	assert.Equal(t, owner.User.ID, event.SourceUserID)
	assert.Equal(t, recipient.User.ID, event.TargetUserID)
	require.NotNil(t, event.NoteData.Note, "note_shared should carry the recipient's view of the note")
	assert.Equal(t, "Plans", event.NoteData.Note.Title)

	event, found = waitForSSEEvent(existingCh, isShare, 3*time.Second)
	require.True(t, found, "existing collaborator should receive note_shared")
	assert.Equal(t, recipient.User.ID, event.TargetUserID, "the target is the new recipient, not every audience member")
}
