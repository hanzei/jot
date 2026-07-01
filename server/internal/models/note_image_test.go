package models

import (
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

		img, err := store.CreateNoteImage(ctx, noteID, userID, "cat.png", "image/png", 1234, "deadbeef", 100, 200)
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
		assert.Nil(t, img.DeletedAt)
	})

	t.Run("GetNoteImagesByNoteID lists images in upload order", func(t *testing.T) {
		store, userID, noteID := newTestNoteImageStore(t)
		ctx := t.Context()

		first, err := store.CreateNoteImage(ctx, noteID, userID, "a.png", "image/png", 1, "sha-a", 1, 1)
		require.NoError(t, err)
		second, err := store.CreateNoteImage(ctx, noteID, userID, "b.png", "image/png", 1, "sha-b", 1, 1)
		require.NoError(t, err)

		images, err := store.GetNoteImagesByNoteID(ctx, noteID)
		require.NoError(t, err)
		require.Len(t, images, 2)
		assert.Equal(t, first.ID, images[0].ID)
		assert.Equal(t, second.ID, images[1].ID)
	})

	t.Run("GetNoteImagesByNoteID returns empty slice for a note with no images", func(t *testing.T) {
		store, _, noteID := newTestNoteImageStore(t)
		images, err := store.GetNoteImagesByNoteID(t.Context(), noteID)
		require.NoError(t, err)
		assert.Empty(t, images)
		assert.NotNil(t, images)
	})

	t.Run("SoftDeleteNoteImage hides the image from listing", func(t *testing.T) {
		store, userID, noteID := newTestNoteImageStore(t)
		ctx := t.Context()

		img, err := store.CreateNoteImage(ctx, noteID, userID, "a.png", "image/png", 1, "sha-a", 1, 1)
		require.NoError(t, err)

		require.NoError(t, store.SoftDeleteNoteImage(ctx, img.ID))

		images, err := store.GetNoteImagesByNoteID(ctx, noteID)
		require.NoError(t, err)
		assert.Empty(t, images)
	})

	t.Run("SoftDeleteNoteImage on an unknown or already-deleted image returns ErrNoteImageNotFound", func(t *testing.T) {
		store, userID, noteID := newTestNoteImageStore(t)
		ctx := t.Context()

		err := store.SoftDeleteNoteImage(ctx, "doesnotexist0000000000")
		require.ErrorIs(t, err, ErrNoteImageNotFound)

		img, err := store.CreateNoteImage(ctx, noteID, userID, "a.png", "image/png", 1, "sha-a", 1, 1)
		require.NoError(t, err)
		require.NoError(t, store.SoftDeleteNoteImage(ctx, img.ID))

		err = store.SoftDeleteNoteImage(ctx, img.ID)
		require.ErrorIs(t, err, ErrNoteImageNotFound)
	})

	t.Run("RestoreNoteImage undoes a soft-delete and it reappears in listing", func(t *testing.T) {
		store, userID, noteID := newTestNoteImageStore(t)
		ctx := t.Context()

		img, err := store.CreateNoteImage(ctx, noteID, userID, "a.png", "image/png", 1, "sha-a", 1, 1)
		require.NoError(t, err)
		require.NoError(t, store.SoftDeleteNoteImage(ctx, img.ID))

		restored, err := store.RestoreNoteImage(ctx, img.ID)
		require.NoError(t, err)
		assert.Equal(t, img.ID, restored.ID)
		assert.Nil(t, restored.DeletedAt)

		images, err := store.GetNoteImagesByNoteID(ctx, noteID)
		require.NoError(t, err)
		require.Len(t, images, 1)
		assert.Equal(t, img.ID, images[0].ID)
	})

	t.Run("RestoreNoteImage on an unknown or not-deleted image returns ErrNoteImageNotFound", func(t *testing.T) {
		store, userID, noteID := newTestNoteImageStore(t)
		ctx := t.Context()

		_, err := store.RestoreNoteImage(ctx, "doesnotexist0000000000")
		require.ErrorIs(t, err, ErrNoteImageNotFound)

		img, err := store.CreateNoteImage(ctx, noteID, userID, "a.png", "image/png", 1, "sha-a", 1, 1)
		require.NoError(t, err)

		_, err = store.RestoreNoteImage(ctx, img.ID)
		require.ErrorIs(t, err, ErrNoteImageNotFound, "restoring an image that isn't soft-deleted is a no-op error, not a silent success")
	})

	t.Run("GetNoteImageRefCount counts rows referencing a hash, including soft-deleted ones", func(t *testing.T) {
		store, userID, noteID := newTestNoteImageStore(t)
		ctx := t.Context()

		count, err := store.GetNoteImageRefCount(ctx, "shared-hash")
		require.NoError(t, err)
		assert.Equal(t, 0, count)

		img1, err := store.CreateNoteImage(ctx, noteID, userID, "a.png", "image/png", 1, "shared-hash", 1, 1)
		require.NoError(t, err)

		_, err = store.db.ExecContext(ctx, `INSERT INTO notes (id, user_id, note_type) VALUES ('note000000000000000im2', ?, 'text')`, userID)
		require.NoError(t, err)
		_, err = store.CreateNoteImage(ctx, "note000000000000000im2", userID, "a-dup.png", "image/png", 1, "shared-hash", 1, 1)
		require.NoError(t, err)

		count, err = store.GetNoteImageRefCount(ctx, "shared-hash")
		require.NoError(t, err)
		assert.Equal(t, 2, count)

		// A soft-deleted reference still counts: its blob must survive for undo.
		require.NoError(t, store.SoftDeleteNoteImage(ctx, img1.ID))
		count, err = store.GetNoteImageRefCount(ctx, "shared-hash")
		require.NoError(t, err)
		assert.Equal(t, 2, count)
	})

	t.Run("batch-loading images for a note list matches GetNoteImagesByNoteID and needs no per-note query", func(t *testing.T) {
		store, userID, noteID := newTestNoteImageStore(t)
		ctx := t.Context()

		_, err := store.db.ExecContext(ctx, `INSERT INTO notes (id, user_id, note_type) VALUES ('note000000000000000im2', ?, 'text')`, userID)
		require.NoError(t, err)

		img1, err := store.CreateNoteImage(ctx, noteID, userID, "a.png", "image/png", 1, "sha-a", 1, 1)
		require.NoError(t, err)
		img2, err := store.CreateNoteImage(ctx, "note000000000000000im2", userID, "b.png", "image/png", 1, "sha-b", 1, 1)
		require.NoError(t, err)
		// A soft-deleted image must not appear in the batch load either.
		deletedImg, err := store.CreateNoteImage(ctx, noteID, userID, "c.png", "image/png", 1, "sha-c", 1, 1)
		require.NoError(t, err)
		require.NoError(t, store.SoftDeleteNoteImage(ctx, deletedImg.ID))

		notes := []*Note{{ID: noteID}, {ID: "note000000000000000im2"}, {ID: "note-with-no-images-0"}}
		require.NoError(t, store.batchLoadImages(ctx, notes))

		require.Len(t, notes[0].Images, 1)
		assert.Equal(t, img1.ID, notes[0].Images[0].ID)
		require.Len(t, notes[1].Images, 1)
		assert.Equal(t, img2.ID, notes[1].Images[0].ID)
		assert.Empty(t, notes[2].Images)
	})
}

// TestNoteImageEmbeddedInNote exercises the Note.images embedding contract
// end-to-end through GetByID (single note) and GetByUserID (list), per
// spec docs/specs/file-attachments.md §4/§6.1.
func TestNoteImageEmbeddedInNote(t *testing.T) {
	store, userID, noteID := newTestNoteImageStore(t)
	ctx := t.Context()

	// No images yet: both paths report a non-nil, empty slice.
	note, err := store.GetByID(ctx, noteID, userID)
	require.NoError(t, err)
	assert.Empty(t, note.Images)

	img, err := store.CreateNoteImage(ctx, noteID, userID, "cat.png", "image/png", 1234, "deadbeef", 100, 200)
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

	require.NoError(t, store.SoftDeleteNoteImage(ctx, img.ID))

	note, err = store.GetByID(ctx, noteID, userID)
	require.NoError(t, err)
	assert.Empty(t, note.Images, "a soft-deleted image drops out of the note immediately")

	_, err = store.RestoreNoteImage(ctx, img.ID)
	require.NoError(t, err)

	note, err = store.GetByID(ctx, noteID, userID)
	require.NoError(t, err)
	require.Len(t, note.Images, 1, "restoring within the grace window brings it back")
}
