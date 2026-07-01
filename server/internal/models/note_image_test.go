package models

import (
	"fmt"
	"testing"

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
