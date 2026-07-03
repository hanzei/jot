package main

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/sse"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNoteImageUploadSendsSSEToCollaborator(t *testing.T) {
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "imgsseowner", "password123", false)
	collaborator := ts.createTestUser(t, "imgssecollab", "password123", false)

	note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "shared"})
	require.NoError(t, err)
	require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collaborator.User.ID))

	sseCtx, sseCancel := context.WithCancel(t.Context())
	t.Cleanup(sseCancel)

	ch, err := collaborator.Client.SubscribeSSE(sseCtx)
	require.NoError(t, err)

	img, err := owner.Client.UploadNoteImage(t.Context(), note.ID, "cat.png", bytes.NewReader(testPNG(t, 4, 4)))
	require.NoError(t, err)

	event, found := waitForSSEEvent(ch, func(e client.SSEEvent) bool {
		return e.Type == string(sse.EventNoteImageAdded) && e.SourceUserID == owner.User.ID
	}, 3*time.Second)

	require.True(t, found, "collaborator should receive note_image_added SSE event")
	require.NotNil(t, event.ImageData)
	assert.Equal(t, note.ID, event.ImageData.NoteID)
	require.NotNil(t, event.ImageData.Image, "note_image_added event should carry the image")
	assert.Equal(t, img.ID, event.ImageData.Image.ID)
	assert.Empty(t, event.ImageData.ImageID)
}

func TestNoteImageDeleteSendsSSEToCollaborator(t *testing.T) {
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "imgssedelowner", "password123", false)
	collaborator := ts.createTestUser(t, "imgssedelcollab", "password123", false)

	note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "shared"})
	require.NoError(t, err)
	require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collaborator.User.ID))

	img, err := owner.Client.UploadNoteImage(t.Context(), note.ID, "cat.png", bytes.NewReader(testPNG(t, 4, 4)))
	require.NoError(t, err)

	sseCtx, sseCancel := context.WithCancel(t.Context())
	t.Cleanup(sseCancel)

	ch, err := collaborator.Client.SubscribeSSE(sseCtx)
	require.NoError(t, err)

	require.NoError(t, owner.Client.DeleteNoteImage(t.Context(), img.ID))

	event, found := waitForSSEEvent(ch, func(e client.SSEEvent) bool {
		return e.Type == string(sse.EventNoteImageRemoved) && e.SourceUserID == owner.User.ID
	}, 3*time.Second)

	require.True(t, found, "collaborator should receive note_image_removed SSE event")
	require.NotNil(t, event.ImageData)
	assert.Equal(t, note.ID, event.ImageData.NoteID)
	assert.Equal(t, img.ID, event.ImageData.ImageID)
	assert.Nil(t, event.ImageData.Image)
}

func TestNoteImageUploadNoSSEToNonCollaborator(t *testing.T) {
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "imgsseowneriso", "password123", false)
	stranger := ts.createTestUser(t, "imgssestranger", "password123", false)

	note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "not shared"})
	require.NoError(t, err)

	sseCtx, sseCancel := context.WithCancel(t.Context())
	t.Cleanup(sseCancel)

	ch, err := stranger.Client.SubscribeSSE(sseCtx)
	require.NoError(t, err)

	_, err = owner.Client.UploadNoteImage(t.Context(), note.ID, "cat.png", bytes.NewReader(testPNG(t, 4, 4)))
	require.NoError(t, err)

	_, found := waitForSSEEvent(ch, func(e client.SSEEvent) bool {
		return e.Type == string(sse.EventNoteImageAdded) && e.SourceUserID == owner.User.ID
	}, 750*time.Millisecond)

	assert.False(t, found, "non-collaborator should NOT receive note_image_added SSE event")
}
