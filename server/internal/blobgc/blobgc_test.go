package blobgc

import (
	"context"
	"errors"
	"testing"

	"github.com/hanzei/jot/server/internal/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeBlobstore is an in-memory Blobstore for testing Reclaim/Sweep without
// touching the filesystem.
type fakeBlobstore struct {
	blobs     map[string]bool
	deleteErr error
	listErr   error
}

func newFakeBlobstore(shas ...string) *fakeBlobstore {
	blobs := make(map[string]bool, len(shas))
	for _, sha := range shas {
		blobs[sha] = true
	}
	return &fakeBlobstore{blobs: blobs}
}

func (f *fakeBlobstore) Delete(_ context.Context, sha string) error {
	if f.deleteErr != nil {
		return f.deleteErr
	}
	delete(f.blobs, sha)
	return nil
}

func (f *fakeBlobstore) List(_ context.Context) ([]string, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	shas := make([]string, 0, len(f.blobs))
	for sha := range f.blobs {
		shas = append(shas, sha)
	}
	return shas, nil
}

// fakeStore is an in-memory Store/RefCounter for testing Reclaim/Sweep
// without a real database.
type fakeStore struct {
	rowsBySHA   map[string][]models.NoteImage
	refCountErr error
	listErr     error
	imagesErr   error
}

func newFakeStore() *fakeStore {
	return &fakeStore{rowsBySHA: map[string][]models.NoteImage{}}
}

func (f *fakeStore) addRow(sha, imageID string) {
	f.rowsBySHA[sha] = append(f.rowsBySHA[sha], models.NoteImage{ID: imageID, SHA256: sha})
}

func (f *fakeStore) GetNoteImageRefCount(_ context.Context, sha256 string) (int, error) {
	if f.refCountErr != nil {
		return 0, f.refCountErr
	}
	return len(f.rowsBySHA[sha256]), nil
}

func (f *fakeStore) ListDistinctImageSHA256(_ context.Context) ([]string, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	shas := make([]string, 0, len(f.rowsBySHA))
	for sha := range f.rowsBySHA {
		shas = append(shas, sha)
	}
	return shas, nil
}

func (f *fakeStore) GetNoteImagesBySHA256(_ context.Context, sha256 string) ([]models.NoteImage, error) {
	if f.imagesErr != nil {
		return nil, f.imagesErr
	}
	return f.rowsBySHA[sha256], nil
}

func TestReclaim(t *testing.T) {
	t.Run("deletes blob at zero refcount", func(t *testing.T) {
		bs := newFakeBlobstore("orphaned-sha")
		store := newFakeStore() // no rows reference it

		Reclaim(t.Context(), bs, store, []string{"orphaned-sha"})

		assert.False(t, bs.blobs["orphaned-sha"])
	})

	t.Run("deduped blob survives while another row references it", func(t *testing.T) {
		bs := newFakeBlobstore("shared-sha")
		store := newFakeStore()
		store.addRow("shared-sha", "other-image-id")

		Reclaim(t.Context(), bs, store, []string{"shared-sha"})

		assert.True(t, bs.blobs["shared-sha"], "blob must survive while a row still references it")
	})

	t.Run("continues past a refcount error for one hash", func(t *testing.T) {
		bs := newFakeBlobstore("a", "b")
		store := newFakeStore() // both orphaned
		store.refCountErr = errors.New("boom")

		require.NotPanics(t, func() {
			Reclaim(t.Context(), bs, store, []string{"a", "b"})
		})
		// Refcount lookups failed for both, so neither is reclaimed rather
		// than being deleted on an unchecked assumption.
		assert.True(t, bs.blobs["a"])
		assert.True(t, bs.blobs["b"])
	})
}

func TestSweep(t *testing.T) {
	t.Run("removes an unreferenced blob", func(t *testing.T) {
		bs := newFakeBlobstore("orphan-sha")
		store := newFakeStore()

		result, err := Sweep(t.Context(), bs, store)
		require.NoError(t, err)

		assert.Equal(t, 1, result.BlobsReclaimed)
		assert.Equal(t, 0, result.MissingBlobs)
		assert.False(t, bs.blobs["orphan-sha"])
	})

	t.Run("keeps a referenced blob", func(t *testing.T) {
		bs := newFakeBlobstore("live-sha")
		store := newFakeStore()
		store.addRow("live-sha", "image-id")

		result, err := Sweep(t.Context(), bs, store)
		require.NoError(t, err)

		assert.Equal(t, 0, result.BlobsReclaimed)
		assert.True(t, bs.blobs["live-sha"])
	})

	t.Run("logs rows whose blob is missing", func(t *testing.T) {
		bs := newFakeBlobstore() // nothing on disk
		store := newFakeStore()
		store.addRow("missing-sha", "image-id-1")
		store.addRow("missing-sha", "image-id-2")

		result, err := Sweep(t.Context(), bs, store)
		require.NoError(t, err)

		assert.Equal(t, 0, result.BlobsReclaimed)
		assert.Equal(t, 1, result.MissingBlobs)
		assert.Equal(t, 2, result.MissingRows)
	})

	t.Run("propagates a List error", func(t *testing.T) {
		bs := newFakeBlobstore()
		bs.listErr = errors.New("disk unavailable")
		store := newFakeStore()

		_, err := Sweep(t.Context(), bs, store)
		require.Error(t, err)
	})

	t.Run("propagates a ListDistinctImageSHA256 error", func(t *testing.T) {
		bs := newFakeBlobstore()
		store := newFakeStore()
		store.listErr = errors.New("db unavailable")

		_, err := Sweep(t.Context(), bs, store)
		require.Error(t, err)
	})
}
