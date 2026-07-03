package models

import (
	"fmt"
	"testing"
	"time"

	"github.com/hanzei/jot/server/internal/database"
	"github.com/hanzei/jot/server/internal/database/dialect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newTestNoteImageStore opens a fresh migrated SQLite database and returns a
// noteStore bound to it, along with an owning user ID and a note ID to attach
// images to.
func newTestNoteImageStore(t *testing.T) (*noteStore, string, string) {
	t.Helper()

	dsn := t.TempDir() + "/note_images.db"
	db, err := database.New("sqlite", dsn)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	d := &dialect.Dialect{Driver: "sqlite"}
	store := newNoteStore(db, d)

	ctx := t.Context()
	_, err = db.ExecContext(ctx, `INSERT INTO users (id, username, password_hash) VALUES ('user0000000000000000im', 'imgowner', 'x')`)
	require.NoError(t, err)

	note, err := store.Create(ctx, "user0000000000000000im", "", "Note with images", "", NoteTypeText, DefaultNoteColor)
	require.NoError(t, err)

	return store, "user0000000000000000im", note.ID
}

func TestNoteImageStore(t *testing.T) {
	t.Run("CreateNoteImage inserts and returns the image", func(t *testing.T) {
		store, userID, noteID := newTestNoteImageStore(t)
		ctx := t.Context()

		img, err := store.CreateNoteImage(ctx, noteID, userID, "cat.png", "image/png", 1234, "deadbeef", 100, 200, 0)
		require.NoError(t, err)
		assert.True(t, IsValidID(img.ID))
		assert.Equal(t, noteID, img.NoteID)
		assert.Equal(t, userID, img.UploaderID)
		assert.Equal(t, "cat.png", img.Filename)
		assert.Equal(t, "image/png", img.ContentType)
		assert.Equal(t, int64(1234), img.SizeBytes)
		assert.Equal(t, "deadbeef", img.SHA256)
		assert.Equal(t, 100, img.Width)
		assert.Equal(t, 200, img.Height)
		assert.False(t, img.CreatedAt.IsZero())
	})

	t.Run("GetNoteImagesByNoteID lists images in upload order", func(t *testing.T) {
		store, userID, noteID := newTestNoteImageStore(t)
		ctx := t.Context()

		first, err := store.CreateNoteImage(ctx, noteID, userID, "a.png", "image/png", 1, "sha-a", 1, 1, 0)
		require.NoError(t, err)
		second, err := store.CreateNoteImage(ctx, noteID, userID, "b.png", "image/png", 1, "sha-b", 1, 1, 0)
		require.NoError(t, err)

		images, err := store.GetNoteImagesByNoteID(ctx, noteID)
		require.NoError(t, err)
		require.Len(t, images, 2)
		assert.Equal(t, first.ID, images[0].ID)
		assert.Equal(t, second.ID, images[1].ID)
	})

	t.Run("GetNoteImageByID fetches a single image by ID", func(t *testing.T) {
		store, userID, noteID := newTestNoteImageStore(t)
		ctx := t.Context()

		created, err := store.CreateNoteImage(ctx, noteID, userID, "cat.png", "image/png", 1234, "deadbeef", 100, 200, 0)
		require.NoError(t, err)

		fetched, err := store.GetNoteImageByID(ctx, created.ID)
		require.NoError(t, err)
		assert.Equal(t, created.ID, fetched.ID)
		assert.Equal(t, noteID, fetched.NoteID)
		assert.Equal(t, "deadbeef", fetched.SHA256)
	})

	t.Run("GetNoteImageByID returns ErrNoteImageNotFound for an unknown ID", func(t *testing.T) {
		store, _, _ := newTestNoteImageStore(t)
		_, err := store.GetNoteImageByID(t.Context(), "doesnotexist0000000000")
		require.ErrorIs(t, err, ErrNoteImageNotFound)
	})

	t.Run("GetNoteImagesByNoteID returns empty slice for a note with no images", func(t *testing.T) {
		store, _, noteID := newTestNoteImageStore(t)
		images, err := store.GetNoteImagesByNoteID(t.Context(), noteID)
		require.NoError(t, err)
		assert.Empty(t, images)
		assert.NotNil(t, images)
	})

	t.Run("DeleteNoteImage hard-deletes the row, returns it, and it drops out of listing", func(t *testing.T) {
		store, userID, noteID := newTestNoteImageStore(t)
		ctx := t.Context()

		img, err := store.CreateNoteImage(ctx, noteID, userID, "a.png", "image/png", 1, "sha-a", 1, 1, 0)
		require.NoError(t, err)

		deleted, err := store.DeleteNoteImage(ctx, img.ID)
		require.NoError(t, err)
		assert.Equal(t, img.ID, deleted.ID)
		assert.Equal(t, "sha-a", deleted.SHA256)

		images, err := store.GetNoteImagesByNoteID(ctx, noteID)
		require.NoError(t, err)
		assert.Empty(t, images)

		// There is no soft-delete/restore step: the row is simply gone.
		count, err := store.GetNoteImageRefCount(ctx, "sha-a")
		require.NoError(t, err)
		assert.Equal(t, 0, count)
	})

	t.Run("DeleteNoteImage on an unknown or already-deleted image returns ErrNoteImageNotFound", func(t *testing.T) {
		store, userID, noteID := newTestNoteImageStore(t)
		ctx := t.Context()

		_, err := store.DeleteNoteImage(ctx, "doesnotexist0000000000")
		require.ErrorIs(t, err, ErrNoteImageNotFound)

		img, err := store.CreateNoteImage(ctx, noteID, userID, "a.png", "image/png", 1, "sha-a", 1, 1, 0)
		require.NoError(t, err)
		_, err = store.DeleteNoteImage(ctx, img.ID)
		require.NoError(t, err)

		_, err = store.DeleteNoteImage(ctx, img.ID)
		require.ErrorIs(t, err, ErrNoteImageNotFound)
	})

	t.Run("GetNoteImageRefCount counts rows referencing a hash and drops to zero once all are deleted", func(t *testing.T) {
		store, userID, noteID := newTestNoteImageStore(t)
		ctx := t.Context()

		count, err := store.GetNoteImageRefCount(ctx, "shared-hash")
		require.NoError(t, err)
		assert.Equal(t, 0, count)

		img1, err := store.CreateNoteImage(ctx, noteID, userID, "a.png", "image/png", 1, "shared-hash", 1, 1, 0)
		require.NoError(t, err)

		_, err = store.db.ExecContext(ctx, `INSERT INTO notes (id, user_id, note_type) VALUES ('note000000000000000im2', ?, 'text')`, userID)
		require.NoError(t, err)
		img2, err := store.CreateNoteImage(ctx, "note000000000000000im2", userID, "a-dup.png", "image/png", 1, "shared-hash", 1, 1, 0)
		require.NoError(t, err)

		count, err = store.GetNoteImageRefCount(ctx, "shared-hash")
		require.NoError(t, err)
		assert.Equal(t, 2, count)

		// Deleting one row still leaves the other referencing the same hash
		// (dedup): the blob must survive until refcount reaches zero.
		_, err = store.DeleteNoteImage(ctx, img1.ID)
		require.NoError(t, err)
		count, err = store.GetNoteImageRefCount(ctx, "shared-hash")
		require.NoError(t, err)
		assert.Equal(t, 1, count)

		_, err = store.DeleteNoteImage(ctx, img2.ID)
		require.NoError(t, err)
		count, err = store.GetNoteImageRefCount(ctx, "shared-hash")
		require.NoError(t, err)
		assert.Equal(t, 0, count)
	})

	t.Run("batch-loading images for a note list matches GetNoteImagesByNoteID and needs no per-note query", func(t *testing.T) {
		store, userID, noteID := newTestNoteImageStore(t)
		ctx := t.Context()

		_, err := store.db.ExecContext(ctx, `INSERT INTO notes (id, user_id, note_type) VALUES ('note000000000000000im2', ?, 'text')`, userID)
		require.NoError(t, err)

		img1, err := store.CreateNoteImage(ctx, noteID, userID, "a.png", "image/png", 1, "sha-a", 1, 1, 0)
		require.NoError(t, err)
		img2, err := store.CreateNoteImage(ctx, "note000000000000000im2", userID, "b.png", "image/png", 1, "sha-b", 1, 1, 0)
		require.NoError(t, err)
		// A deleted image must not appear in the batch load either.
		deletedImg, err := store.CreateNoteImage(ctx, noteID, userID, "c.png", "image/png", 1, "sha-c", 1, 1, 0)
		require.NoError(t, err)
		_, err = store.DeleteNoteImage(ctx, deletedImg.ID)
		require.NoError(t, err)

		notes := []*Note{{ID: noteID}, {ID: "note000000000000000im2"}, {ID: "note-with-no-images-0"}}
		require.NoError(t, store.batchLoadNoteAssociations(ctx, notes, userID))

		require.Len(t, notes[0].Images, 1)
		assert.Equal(t, img1.ID, notes[0].Images[0].ID)
		require.Len(t, notes[1].Images, 1)
		assert.Equal(t, img2.ID, notes[1].Images[0].ID)
		assert.Empty(t, notes[2].Images)
	})

	t.Run("CreateNoteImage enforces maxImages atomically", func(t *testing.T) {
		store, userID, noteID := newTestNoteImageStore(t)
		ctx := t.Context()

		for i := range 3 {
			_, err := store.CreateNoteImage(ctx, noteID, userID, "a.png", "image/png", 1, fmt.Sprintf("sha-%d", i), 1, 1, 3)
			require.NoError(t, err)
		}

		_, err := store.CreateNoteImage(ctx, noteID, userID, "over.png", "image/png", 1, "sha-over", 1, 1, 3)
		require.ErrorIs(t, err, ErrNoteImageCapExceeded)

		images, err := store.GetNoteImagesByNoteID(ctx, noteID)
		require.NoError(t, err)
		assert.Len(t, images, 3, "the rejected insert must not have committed")
	})

	t.Run("CreateNoteImage does not enforce a cap when maxImages is 0", func(t *testing.T) {
		store, userID, noteID := newTestNoteImageStore(t)
		ctx := t.Context()

		for i := range 5 {
			_, err := store.CreateNoteImage(ctx, noteID, userID, "a.png", "image/png", 1, fmt.Sprintf("sha-%d", i), 1, 1, 0)
			require.NoError(t, err)
		}

		images, err := store.GetNoteImagesByNoteID(ctx, noteID)
		require.NoError(t, err)
		assert.Len(t, images, 5)
	})
}

// TestNoteImageEmbeddedInNote exercises the Note.images embedding contract
// end-to-end through GetByID (single note) and GetByUserID (list).
func TestNoteImageEmbeddedInNote(t *testing.T) {
	store, userID, noteID := newTestNoteImageStore(t)
	ctx := t.Context()

	// No images yet: both paths report a non-nil, empty slice.
	note, err := store.GetByID(ctx, noteID, userID)
	require.NoError(t, err)
	assert.Empty(t, note.Images)

	img, err := store.CreateNoteImage(ctx, noteID, userID, "cat.png", "image/png", 1234, "deadbeef", 100, 200, 0)
	require.NoError(t, err)

	note, err = store.GetByID(ctx, noteID, userID)
	require.NoError(t, err)
	require.Len(t, note.Images, 1)
	assert.Equal(t, img.ID, note.Images[0].ID)
	assert.Equal(t, "cat.png", note.Images[0].Filename)

	notes, err := store.GetByUserID(ctx, userID, false, false, "", "", false)
	require.NoError(t, err)
	require.Len(t, notes, 1)
	require.Len(t, notes[0].Images, 1)
	assert.Equal(t, img.ID, notes[0].Images[0].ID)

	_, err = store.DeleteNoteImage(ctx, img.ID)
	require.NoError(t, err)

	note, err = store.GetByID(ctx, noteID, userID)
	require.NoError(t, err)
	assert.Empty(t, note.Images, "a deleted image drops out of the note immediately")
}

// TestNoteHardDeletePathsReturnImageHashes covers every note/user hard-delete
// path's contract with note_images blob reclamation: note_images rows
// cascade-delete with their note (or, for uploader_id, with the uploading
// user), so each path must read the distinct sha256 hashes before the delete
// and hand them back to the caller to reclaim (docs/specs/file-attachments.md
// §10). Dedup (a hash referenced by a still-live row elsewhere) is exercised
// per-path so the returned set is exactly what's now safe to reclaim, not
// just "every hash that was ever attached."
func TestNoteHardDeletePathsReturnImageHashes(t *testing.T) {
	t.Run("Delete returns the note's image hashes", func(t *testing.T) {
		store, userID, noteID := newTestNoteImageStore(t)
		ctx := t.Context()

		_, err := store.CreateNoteImage(ctx, noteID, userID, "a.png", "image/png", 1, "sha-a", 1, 1, 0)
		require.NoError(t, err)
		_, err = store.CreateNoteImage(ctx, noteID, userID, "b.png", "image/png", 1, "sha-b", 1, 1, 0)
		require.NoError(t, err)

		shas, err := store.Delete(ctx, noteID, userID)
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"sha-a", "sha-b"}, shas)

		_, err = store.GetByIDAnyState(ctx, noteID, userID)
		require.ErrorIs(t, err, ErrNoteNotFound)
	})

	t.Run("DeleteFromTrash returns the note's image hashes", func(t *testing.T) {
		store, userID, noteID := newTestNoteImageStore(t)
		ctx := t.Context()

		_, err := store.CreateNoteImage(ctx, noteID, userID, "a.png", "image/png", 1, "sha-a", 1, 1, 0)
		require.NoError(t, err)
		require.NoError(t, store.MoveToTrash(ctx, noteID, userID))

		shas, err := store.DeleteFromTrash(ctx, noteID, userID)
		require.NoError(t, err)
		assert.Equal(t, []string{"sha-a"}, shas)
	})

	t.Run("EmptyTrash returns the deduped union of image hashes across all purged notes", func(t *testing.T) {
		store, userID, noteID := newTestNoteImageStore(t)
		ctx := t.Context()

		_, err := store.db.ExecContext(ctx, `INSERT INTO notes (id, user_id, note_type) VALUES ('note00000000000empty2', ?, 'text')`, userID)
		require.NoError(t, err)

		// "shared-hash" is attached to both notes (dedup); "sha-only1" only to
		// the first. The returned set must be deduped, not a raw concatenation.
		_, err = store.CreateNoteImage(ctx, noteID, userID, "a.png", "image/png", 1, "shared-hash", 1, 1, 0)
		require.NoError(t, err)
		_, err = store.CreateNoteImage(ctx, noteID, userID, "b.png", "image/png", 1, "sha-only1", 1, 1, 0)
		require.NoError(t, err)
		_, err = store.CreateNoteImage(ctx, "note00000000000empty2", userID, "c.png", "image/png", 1, "shared-hash", 1, 1, 0)
		require.NoError(t, err)

		require.NoError(t, store.MoveToTrash(ctx, noteID, userID))
		require.NoError(t, store.MoveToTrash(ctx, "note00000000000empty2", userID))

		deleted, shas, err := store.EmptyTrash(ctx, userID)
		require.NoError(t, err)
		assert.Len(t, deleted, 2)
		assert.ElementsMatch(t, []string{"shared-hash", "sha-only1"}, shas)
	})

	t.Run("DeleteAllByUser returns the image hashes across all of the user's notes", func(t *testing.T) {
		store, userID, noteID := newTestNoteImageStore(t)
		ctx := t.Context()

		_, err := store.db.ExecContext(ctx, `INSERT INTO notes (id, user_id, note_type) VALUES ('note0000000000allbyu2', ?, 'text')`, userID)
		require.NoError(t, err)

		_, err = store.CreateNoteImage(ctx, noteID, userID, "a.png", "image/png", 1, "sha-a", 1, 1, 0)
		require.NoError(t, err)
		_, err = store.CreateNoteImage(ctx, "note0000000000allbyu2", userID, "b.png", "image/png", 1, "sha-b", 1, 1, 0)
		require.NoError(t, err)

		deletedCount, shas, err := store.DeleteAllByUser(ctx, userID)
		require.NoError(t, err)
		assert.Equal(t, 2, deletedCount)
		assert.ElementsMatch(t, []string{"sha-a", "sha-b"}, shas)
	})

	t.Run("PurgeOldTrashedNotes only purges notes past the cutoff and returns their image hashes", func(t *testing.T) {
		store, userID, noteID := newTestNoteImageStore(t)
		ctx := t.Context()

		_, err := store.db.ExecContext(ctx, `INSERT INTO notes (id, user_id, note_type) VALUES ('note00000000000recent', ?, 'text')`, userID)
		require.NoError(t, err)

		_, err = store.CreateNoteImage(ctx, noteID, userID, "old.png", "image/png", 1, "sha-old", 1, 1, 0)
		require.NoError(t, err)
		_, err = store.CreateNoteImage(ctx, "note00000000000recent", userID, "recent.png", "image/png", 1, "sha-recent", 1, 1, 0)
		require.NoError(t, err)

		require.NoError(t, store.MoveToTrash(ctx, noteID, userID))
		require.NoError(t, store.MoveToTrash(ctx, "note00000000000recent", userID))

		// Backdate only the first note's deleted_at so it alone is past the cutoff.
		_, err = store.db.ExecContext(ctx, `UPDATE notes SET deleted_at = datetime('now', '-10 days') WHERE id = ?`, noteID)
		require.NoError(t, err)

		shas, err := store.PurgeOldTrashedNotes(ctx, 7*24*time.Hour)
		require.NoError(t, err)
		assert.Equal(t, []string{"sha-old"}, shas)

		_, err = store.GetByIDAnyState(ctx, noteID, userID)
		require.ErrorIs(t, err, ErrNoteNotFound)

		var recentCount int
		require.NoError(t, store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM notes WHERE id = 'note00000000000recent'`).Scan(&recentCount))
		assert.Equal(t, 1, recentCount, "the recently-trashed note must survive the purge")
	})

	t.Run("PurgeOldTrashedNotes returns nothing when no note is past the cutoff", func(t *testing.T) {
		store, _, _ := newTestNoteImageStore(t)

		shas, err := store.PurgeOldTrashedNotes(t.Context(), 7*24*time.Hour)
		require.NoError(t, err)
		assert.Empty(t, shas)
	})
}

// TestGetNoteImageSHA256sForUserTx covers both cascades a user hard-delete
// triggers: note_images.note_id (via notes the user owns) and
// note_images.uploader_id directly (images the user uploaded onto someone
// else's shared note, which survives the delete even though the image row
// doesn't). It's tx-scoped (see DeleteWithCleanup's preDelete hook) so the
// test exercises it the same way: inside a transaction, before any delete.
func TestGetNoteImageSHA256sForUserTx(t *testing.T) {
	store, ownerID, ownedNoteID := newTestNoteImageStore(t)
	ctx := t.Context()

	_, err := store.db.ExecContext(ctx, `INSERT INTO users (id, username, password_hash) VALUES ('user0000000shareduser', 'shareduploader', 'x')`)
	require.NoError(t, err)
	sharedUploaderID := "user0000000shareduser"

	// Image the owner attached to their own note.
	_, err = store.CreateNoteImage(ctx, ownedNoteID, ownerID, "owned.png", "image/png", 1, "sha-owned", 1, 1, 0)
	require.NoError(t, err)
	// Image sharedUploaderID uploaded onto the owner's note (a collaborator
	// upload) — reachable via uploader_id, not via owning any note.
	_, err = store.CreateNoteImage(ctx, ownedNoteID, sharedUploaderID, "uploaded.png", "image/png", 1, "sha-uploaded", 1, 1, 0)
	require.NoError(t, err)

	tx, err := store.db.BeginTx(ctx, nil)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback() }()

	ownerShas, err := store.GetNoteImageSHA256sForUserTx(ctx, tx, ownerID)
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{"sha-owned", "sha-uploaded"}, ownerShas, "owner reaches every image on their notes regardless of uploader")

	uploaderShas, err := store.GetNoteImageSHA256sForUserTx(ctx, tx, sharedUploaderID)
	require.NoError(t, err)
	assert.Equal(t, []string{"sha-uploaded"}, uploaderShas, "a non-owner only reaches images they personally uploaded")
}

func TestGetNoteImageCountByNoteID(t *testing.T) {
	store, userID, noteID := newTestNoteImageStore(t)
	ctx := t.Context()

	count, err := store.GetNoteImageCountByNoteID(ctx, noteID)
	require.NoError(t, err)
	assert.Equal(t, 0, count)

	_, err = store.CreateNoteImage(ctx, noteID, userID, "a.png", "image/png", 1, "sha-a", 1, 1, 0)
	require.NoError(t, err)
	_, err = store.CreateNoteImage(ctx, noteID, userID, "b.png", "image/png", 1, "sha-b", 1, 1, 0)
	require.NoError(t, err)

	count, err = store.GetNoteImageCountByNoteID(ctx, noteID)
	require.NoError(t, err)
	assert.Equal(t, 2, count)
}
