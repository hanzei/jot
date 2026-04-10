package main

import (
	"bytes"
	"context"
	"image"
	"testing"
	"time"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/sse"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// waitForSSEEvent reads from ch until an event matching predicate is found or
// the deadline expires. Returns the first matching event and true, or the zero
// value and false on timeout.
func waitForSSEEvent(ch <-chan client.SSEEvent, predicate func(client.SSEEvent) bool, timeout time.Duration) (client.SSEEvent, bool) {
	deadline := time.After(timeout)
	for {
		select {
		case event, ok := <-ch:
			if !ok {
				return client.SSEEvent{}, false
			}
			if predicate(event) {
				return event, true
			}
		case <-deadline:
			return client.SSEEvent{}, false
		}
	}
}

func TestProfileIconUploadSendsSSEToCollaborator(t *testing.T) {
	ts := setupTestServer(t)
	iconOwner := ts.createTestUser(t, "iconowner", "password123", false)
	collaborator := ts.createTestUser(t, "collaborator", "password123", false)

	// Link the two users via a shared note.
	note, err := iconOwner.Client.CreateNote(t.Context(), &client.CreateNoteRequest{Content: "shared"})
	require.NoError(t, err)
	require.NoError(t, iconOwner.Client.ShareNote(t.Context(), note.ID, collaborator.User.ID))

	// Subscribe collaborator to SSE before uploading the icon.
	sseCtx, sseCancel := context.WithCancel(t.Context())
	t.Cleanup(sseCancel)

	ch, err := collaborator.Client.SubscribeSSE(sseCtx)
	require.NoError(t, err)

	// Upload a profile icon for iconOwner.
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	_, err = iconOwner.Client.UploadProfileIcon(t.Context(), "icon.png", bytes.NewReader(encodePNG(t, img)))
	require.NoError(t, err)

	event, found := waitForSSEEvent(ch, func(e client.SSEEvent) bool {
		return e.Type == string(sse.EventProfileIconUpdated) && e.SourceUserID == iconOwner.User.ID
	}, 3*time.Second)

	require.True(t, found, "collaborator should receive profile_icon_updated SSE event")
	assert.Equal(t, string(sse.EventProfileIconUpdated), event.Type)
	assert.Equal(t, iconOwner.User.ID, event.SourceUserID)
	require.NotNil(t, event.ProfileData, "event should carry profile icon data")
	require.NotNil(t, event.ProfileData.User, "event should carry updated user data")
	assert.Equal(t, iconOwner.User.ID, event.ProfileData.User.ID)
	assert.True(t, event.ProfileData.User.HasProfileIcon)
}

func TestProfileIconDeleteSendsSSEToCollaborator(t *testing.T) {
	ts := setupTestServer(t)
	iconOwner := ts.createTestUser(t, "deliconowner", "password123", false)
	collaborator := ts.createTestUser(t, "delcollaborator", "password123", false)

	// Link the two users via a shared note.
	note, err := iconOwner.Client.CreateNote(t.Context(), &client.CreateNoteRequest{Content: "shared"})
	require.NoError(t, err)
	require.NoError(t, iconOwner.Client.ShareNote(t.Context(), note.ID, collaborator.User.ID))

	// Upload an icon first so there is something to delete.
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	_, err = iconOwner.Client.UploadProfileIcon(t.Context(), "icon.png", bytes.NewReader(encodePNG(t, img)))
	require.NoError(t, err)

	sseCtx, sseCancel := context.WithCancel(t.Context())
	t.Cleanup(sseCancel)

	ch, err := collaborator.Client.SubscribeSSE(sseCtx)
	require.NoError(t, err)

	// Delete the profile icon.
	require.NoError(t, iconOwner.Client.DeleteProfileIcon(t.Context()))

	event, found := waitForSSEEvent(ch, func(e client.SSEEvent) bool {
		return e.Type == string(sse.EventProfileIconUpdated) && e.SourceUserID == iconOwner.User.ID
	}, 3*time.Second)

	require.True(t, found, "collaborator should receive profile_icon_updated SSE event on delete")
	assert.Equal(t, iconOwner.User.ID, event.SourceUserID)
	require.NotNil(t, event.ProfileData)
	require.NotNil(t, event.ProfileData.User)
	assert.False(t, event.ProfileData.User.HasProfileIcon)
}

func TestProfileIconUploadNoSSEToNonCollaborator(t *testing.T) {
	ts := setupTestServer(t)
	iconOwner := ts.createTestUser(t, "iconowneriso", "password123", false)
	stranger := ts.createTestUser(t, "stranger", "password123", false)

	// No shared notes between iconOwner and stranger.
	sseCtx, sseCancel := context.WithCancel(t.Context())
	t.Cleanup(sseCancel)

	ch, err := stranger.Client.SubscribeSSE(sseCtx)
	require.NoError(t, err)

	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	_, err = iconOwner.Client.UploadProfileIcon(t.Context(), "icon.png", bytes.NewReader(encodePNG(t, img)))
	require.NoError(t, err)

	_, found := waitForSSEEvent(ch, func(e client.SSEEvent) bool {
		return e.Type == string(sse.EventProfileIconUpdated) && e.SourceUserID == iconOwner.User.ID
	}, 750*time.Millisecond)

	assert.False(t, found, "non-collaborator should NOT receive profile_icon_updated SSE event")
}
