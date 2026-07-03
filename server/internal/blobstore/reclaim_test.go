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
