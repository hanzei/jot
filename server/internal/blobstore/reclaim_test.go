package blobstore

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeRefCounter is a minimal RefCounter for exercising ReclaimIfOrphaned
// without a real *models.NoteStore.
type fakeRefCounter struct {
	counts map[string]int
	err    error
}

func (f *fakeRefCounter) GetNoteImageRefCount(_ context.Context, sha256 string) (int, error) {
	if f.err != nil {
		return 0, f.err
	}
	return f.counts[sha256], nil
}

func TestReclaimIfOrphanedDeletesWhenRefCountIsZero(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()
	sha := shaOf("orphaned")
	require.NoError(t, store.Put(ctx, sha, strings.NewReader("orphaned")))

	require.NoError(t, ReclaimIfOrphaned(ctx, &fakeRefCounter{counts: map[string]int{}}, store, sha))

	_, err := store.Open(ctx, sha)
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestReclaimIfOrphanedLeavesBlobWhenStillReferenced(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()
	sha := shaOf("still referenced")
	require.NoError(t, store.Put(ctx, sha, strings.NewReader("still referenced")))

	require.NoError(t, ReclaimIfOrphaned(ctx, &fakeRefCounter{counts: map[string]int{sha: 1}}, store, sha))

	rc, err := store.Open(ctx, sha)
	require.NoError(t, err)
	_ = rc.Close()
}

func TestReclaimIfOrphanedPropagatesRefCountError(t *testing.T) {
	store := newTestImageStore(t)
	wantErr := errors.New("db unavailable")

	err := ReclaimIfOrphaned(t.Context(), &fakeRefCounter{err: wantErr}, store, shaOf("x"))
	require.ErrorIs(t, err, wantErr)
}

func TestReclaimIfOrphanedRespectsPins(t *testing.T) {
	ctx := t.Context()
	noRefs := &fakeRefCounter{counts: map[string]int{}}

	t.Run("a pinned hash is not reclaimed", func(t *testing.T) {
		store := newTestImageStore(t)
		sha := shaOf("in-flight upload")
		require.NoError(t, store.Put(ctx, sha, strings.NewReader("in-flight upload")))
		release := store.Pin(sha)
		defer release()

		require.NoError(t, ReclaimIfOrphaned(ctx, noRefs, store, sha))

		rc, err := store.Open(ctx, sha)
		require.NoError(t, err)
		_ = rc.Close()
	})

	t.Run("pins match regardless of hash letter case", func(t *testing.T) {
		store := newTestImageStore(t)
		sha := shaOf("case")
		require.NoError(t, store.Put(ctx, sha, strings.NewReader("case")))
		release := store.Pin(strings.ToUpper(sha))
		defer release()

		require.NoError(t, ReclaimIfOrphaned(ctx, noRefs, store, sha))

		rc, err := store.Open(ctx, sha)
		require.NoError(t, err)
		_ = rc.Close()
	})

	t.Run("a released hash is reclaimed (upload rollback)", func(t *testing.T) {
		store := newTestImageStore(t)
		sha := shaOf("rolled back")
		require.NoError(t, store.Put(ctx, sha, strings.NewReader("rolled back")))
		release := store.Pin(sha)
		release()

		require.NoError(t, ReclaimIfOrphaned(ctx, noRefs, store, sha))

		_, err := store.Open(ctx, sha)
		assert.ErrorIs(t, err, ErrNotFound)
	})

	t.Run("release is idempotent and leaves other pins in place", func(t *testing.T) {
		store := newTestImageStore(t)
		sha := shaOf("two uploads")
		require.NoError(t, store.Put(ctx, sha, strings.NewReader("two uploads")))
		releaseA := store.Pin(sha)
		releaseB := store.Pin(sha)
		defer releaseB()
		releaseA()
		releaseA()

		require.NoError(t, ReclaimIfOrphaned(ctx, noRefs, store, sha))

		rc, err := store.Open(ctx, sha)
		require.NoError(t, err)
		_ = rc.Close()
	})
}
