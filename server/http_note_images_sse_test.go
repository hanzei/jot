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
	t.Parallel()
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

func TestNoteImageChangeSendsPersonalizedNoteUpdated(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "imgsseunreadowner", "password123", false)
	collaborator := ts.createTestUser(t, "imgsseunreadcollab", "password123", false)

	note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "shared"})
	require.NoError(t, err)
	require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collaborator.User.ID))
	require.NoError(t, collaborator.Client.MarkNoteViewed(t.Context(), note.ID))

	sseCtx, sseCancel := context.WithCancel(t.Context())
	t.Cleanup(sseCancel)

	collabCh, err := collaborator.Client.SubscribeSSE(sseCtx)
	require.NoError(t, err)
	ownerCh, err := owner.Client.SubscribeSSE(sseCtx)
	require.NoError(t, err)

	isUpdate := func(e client.SSEEvent) bool {
		return e.Type == string(sse.EventNoteUpdated) && e.SourceUserID == owner.User.ID &&
			e.NoteData != nil && e.NoteData.NoteID == note.ID
	}

	img, err := owner.Client.UploadNoteImage(t.Context(), note.ID, "cat.png", bytes.NewReader(testPNG(t, 4, 4)))
	require.NoError(t, err)

	event, found := waitForSSEEvent(collabCh, isUpdate, 3*time.Second)
	require.True(t, found, "collaborator should receive note_updated after an image upload")
	require.NotNil(t, event.NoteData.Note)
	require.NotNil(t, event.NoteData.Note.Unread)
	assert.Equal(t, client.NoteUnreadUpdated, *event.NoteData.Note.Unread)
	require.Len(t, event.NoteData.Note.Images, 1)
	assert.Equal(t, img.ID, event.NoteData.Note.Images[0].ID)

	event, found = waitForSSEEvent(ownerCh, isUpdate, 3*time.Second)
	require.True(t, found, "the uploader's other devices get their own copy")
	require.NotNil(t, event.NoteData.Note)
	assert.Nil(t, event.NoteData.Note.Unread)

	require.NoError(t, collaborator.Client.MarkNoteViewed(t.Context(), note.ID))
	require.NoError(t, owner.Client.DeleteNoteImage(t.Context(), img.ID))

	event, found = waitForSSEEvent(collabCh, isUpdate, 3*time.Second)
	require.True(t, found, "collaborator should receive note_updated after an image removal")
	require.NotNil(t, event.NoteData.Note)
	require.NotNil(t, event.NoteData.Note.Unread)
	assert.Equal(t, client.NoteUnreadUpdated, *event.NoteData.Note.Unread)
	assert.Empty(t, event.NoteData.Note.Images)
}

func TestNoteImageDeleteSendsSSEToCollaborator(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
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
