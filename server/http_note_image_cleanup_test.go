package main

import (
	"bytes"
	"path/filepath"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// blobCounts holds file counts for the two ImageStore keyspaces so tests can
// assert on both a note image's original and its eagerly-generated thumbnail
// in one call.
type blobCounts struct {
	blobs, thumbs int
}

func countBlobs(t *testing.T, uploadDir string) blobCounts {
	t.Helper()
	return blobCounts{
		blobs:  countRegularFiles(t, filepath.Join(uploadDir, "blobs")),
		thumbs: countRegularFiles(t, filepath.Join(uploadDir, "thumb")),
	}
}

// TestDeleteNotePermanentReclaimsImageBlobs covers issue #608's primary
// scope: note_images rows cascade-delete with their note (DB FK), but the
// on-disk blob/thumbnail only goes away if the delete path explicitly
// reclaims it.
func TestDeleteNotePermanentReclaimsImageBlobs(t *testing.T) {
	t.Parallel()
	var uploadDir string
	ts := setupTestServerWithConfig(t, func(cfg *config.Config) { uploadDir = cfg.UploadDir })
	user := ts.createTestUser(t, "cleanuppermanent", "password123", false)

	note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "note"})
	require.NoError(t, err)
	_, err = user.Client.UploadNoteImage(t.Context(), note.ID, "cat.png", bytes.NewReader(testPNG(t, 4, 4)))
	require.NoError(t, err)
	assert.Equal(t, blobCounts{blobs: 1, thumbs: 1}, countBlobs(t, uploadDir))

	require.NoError(t, user.Client.DeleteNote(t.Context(), note.ID))
	assert.Equal(t, blobCounts{blobs: 1, thumbs: 1}, countBlobs(t, uploadDir), "moving to trash must not touch blobs")

	require.NoError(t, user.Client.DeleteNotePermanently(t.Context(), note.ID))
	assert.Equal(t, blobCounts{blobs: 0, thumbs: 0}, countBlobs(t, uploadDir), "permanent delete must reclaim the now-orphaned blob and thumbnail")
}

// TestDeleteNotePermanentDedupBlobSurvives ensures the permanent-delete path
// respects the same refcount/dedup rule as the standalone image-delete
// endpoint: a blob shared with a still-live note must survive.
func TestDeleteNotePermanentDedupBlobSurvives(t *testing.T) {
	t.Parallel()
	var uploadDir string
	ts := setupTestServerWithConfig(t, func(cfg *config.Config) { uploadDir = cfg.UploadDir })
	user := ts.createTestUser(t, "cleanupdedup", "password123", false)

	data := testPNG(t, 6, 6)
	noteA, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "note A"})
	require.NoError(t, err)
	_, err = user.Client.UploadNoteImage(t.Context(), noteA.ID, "shared.png", bytes.NewReader(data))
	require.NoError(t, err)

	noteB, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "note B"})
	require.NoError(t, err)
	imgB, err := user.Client.UploadNoteImage(t.Context(), noteB.ID, "shared.png", bytes.NewReader(data))
	require.NoError(t, err)

	require.NoError(t, user.Client.DeleteNote(t.Context(), noteA.ID))
	require.NoError(t, user.Client.DeleteNotePermanently(t.Context(), noteA.ID))

	assert.Equal(t, blobCounts{blobs: 1, thumbs: 1}, countBlobs(t, uploadDir), "the blob must survive: note B still references it")

	downloaded, _, err := user.Client.GetNoteImage(t.Context(), imgB.ID)
	require.NoError(t, err)
	assert.Equal(t, data, downloaded)

	require.NoError(t, user.Client.DeleteNote(t.Context(), noteB.ID))
	require.NoError(t, user.Client.DeleteNotePermanently(t.Context(), noteB.ID))
	assert.Equal(t, blobCounts{blobs: 0, thumbs: 0}, countBlobs(t, uploadDir), "the last reference is gone: the blob must now be reclaimed")
}

// TestEmptyTrashReclaimsImageBlobs covers the bulk permanent-delete path.
func TestEmptyTrashReclaimsImageBlobs(t *testing.T) {
	t.Parallel()
	var uploadDir string
	ts := setupTestServerWithConfig(t, func(cfg *config.Config) { uploadDir = cfg.UploadDir })
	user := ts.createTestUser(t, "cleanupemptytrash", "password123", false)

	first, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "first"})
	require.NoError(t, err)
	_, err = user.Client.UploadNoteImage(t.Context(), first.ID, "a.png", bytes.NewReader(testPNG(t, 4, 4)))
	require.NoError(t, err)

	second, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "second"})
	require.NoError(t, err)
	_, err = user.Client.UploadNoteImage(t.Context(), second.ID, "b.png", bytes.NewReader(testPNG(t, 5, 5)))
	require.NoError(t, err)

	require.NoError(t, user.Client.DeleteNote(t.Context(), first.ID))
	require.NoError(t, user.Client.DeleteNote(t.Context(), second.ID))
	assert.Equal(t, blobCounts{blobs: 2, thumbs: 2}, countBlobs(t, uploadDir))

	resp, err := user.Client.EmptyTrash(t.Context())
	require.NoError(t, err)
	assert.Equal(t, 2, resp.Deleted)

	assert.Equal(t, blobCounts{blobs: 0, thumbs: 0}, countBlobs(t, uploadDir))
}

// TestAdminDeleteUserNotesReclaimsImageBlobs covers the admin bulk-delete
// endpoint (DELETE /admin/users/{id}/notes), which removes every note a user
// owns regardless of state.
func TestAdminDeleteUserNotesReclaimsImageBlobs(t *testing.T) {
	t.Parallel()
	var uploadDir string
	ts := setupTestServerWithConfig(t, func(cfg *config.Config) { uploadDir = cfg.UploadDir })
	admin := ts.createTestUser(t, "cleanupadmin1", "password123", true)
	target := ts.createTestUser(t, "cleanuptarget1", "password123", false)

	note, err := target.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "note"})
	require.NoError(t, err)
	_, err = target.Client.UploadNoteImage(t.Context(), note.ID, "cat.png", bytes.NewReader(testPNG(t, 4, 4)))
	require.NoError(t, err)
	assert.Equal(t, blobCounts{blobs: 1, thumbs: 1}, countBlobs(t, uploadDir))

	deleted, err := admin.Client.AdminDeleteUserNotes(t.Context(), target.User.ID)
	require.NoError(t, err)
	assert.Equal(t, 1, deleted)

	assert.Equal(t, blobCounts{blobs: 0, thumbs: 0}, countBlobs(t, uploadDir))
}

// TestAdminDeleteUserReclaimsOwnedImageBlobs covers deleting a user account
// outright: their owned notes (and note_images) cascade away via the users
// FK, not via any note-store delete method.
func TestAdminDeleteUserReclaimsOwnedImageBlobs(t *testing.T) {
	t.Parallel()
	var uploadDir string
	ts := setupTestServerWithConfig(t, func(cfg *config.Config) { uploadDir = cfg.UploadDir })
	admin := ts.createTestUser(t, "cleanupadmin2", "password123", true)
	target := ts.createTestUser(t, "cleanuptarget2", "password123", false)

	note, err := target.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "note"})
	require.NoError(t, err)
	_, err = target.Client.UploadNoteImage(t.Context(), note.ID, "cat.png", bytes.NewReader(testPNG(t, 4, 4)))
	require.NoError(t, err)
	assert.Equal(t, blobCounts{blobs: 1, thumbs: 1}, countBlobs(t, uploadDir))

	require.NoError(t, admin.Client.AdminDeleteUser(t.Context(), target.User.ID))

	assert.Equal(t, blobCounts{blobs: 0, thumbs: 0}, countBlobs(t, uploadDir))
}

// TestAdminDeleteUserReclaimsUploaderImageBlobs covers the other cascade a
// user hard-delete triggers: note_images.uploader_id, for an image a
// collaborator uploaded onto someone else's note. The note (and its owner)
// survive; only the collaborator's image row and blob should go.
func TestAdminDeleteUserReclaimsUploaderImageBlobs(t *testing.T) {
	t.Parallel()
	var uploadDir string
	ts := setupTestServerWithConfig(t, func(cfg *config.Config) { uploadDir = cfg.UploadDir })
	admin := ts.createTestUser(t, "cleanupadmin3", "password123", true)
	owner := ts.createTestUser(t, "cleanupowner3", "password123", false)
	collaborator := ts.createTestUser(t, "cleanupcollab3", "password123", false)

	note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "shared note"})
	require.NoError(t, err)
	require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collaborator.User.ID))

	_, err = collaborator.Client.UploadNoteImage(t.Context(), note.ID, "cat.png", bytes.NewReader(testPNG(t, 4, 4)))
	require.NoError(t, err)
	assert.Equal(t, blobCounts{blobs: 1, thumbs: 1}, countBlobs(t, uploadDir))

	require.NoError(t, admin.Client.AdminDeleteUser(t.Context(), collaborator.User.ID))

	assert.Equal(t, blobCounts{blobs: 0, thumbs: 0}, countBlobs(t, uploadDir), "the collaborator's uploaded image must be reclaimed even though the note survives")

	fetchedNote, err := owner.Client.GetNote(t.Context(), note.ID)
	require.NoError(t, err)
	assert.Empty(t, fetchedNote.Images)
}

// TestMCPDeleteNotePermanentReclaimsImageBlobs covers the MCP delete_note
// tool's permanent branch, a separate code path from the HTTP handler that
// shares the same underlying store method.
func TestMCPDeleteNotePermanentReclaimsImageBlobs(t *testing.T) {
	t.Parallel()
	var uploadDir string
	ts := setupTestServerWithConfig(t, func(cfg *config.Config) { uploadDir = cfg.UploadDir })
	user := ts.createTestUser(t, "cleanupmcp", "password123", false)
	sess := setupMCPSession(t, ts, user)

	var created client.Note
	callTool(t, sess, "create_note", map[string]any{"title": "MCP cleanup"}, &created)
	_, err := user.Client.UploadNoteImage(t.Context(), created.ID, "cat.png", bytes.NewReader(testPNG(t, 4, 4)))
	require.NoError(t, err)
	assert.Equal(t, blobCounts{blobs: 1, thumbs: 1}, countBlobs(t, uploadDir))

	callTool(t, sess, "delete_note", map[string]any{"id": created.ID}, nil)
	callTool(t, sess, "delete_note", map[string]any{"id": created.ID, "permanent": true}, nil)

	assert.Equal(t, blobCounts{blobs: 0, thumbs: 0}, countBlobs(t, uploadDir))
}
