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

// fakeBatchRefCounter is a minimal BatchRefCounter for exercising
// ReclaimAllIfOrphaned without a real *models.NoteStore.
type fakeBatchRefCounter struct {
	counts map[string]int
	err    error
}

func (f *fakeBatchRefCounter) GetNoteImageRefCounts(_ context.Context, shas []string) (map[string]int, error) {
	if f.err != nil {
		return nil, f.err
	}
	result := make(map[string]int, len(shas))
	for _, sha := range shas {
		if count, ok := f.counts[sha]; ok {
			result[sha] = count
		}
	}
	return result, nil
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

func TestReclaimAllIfOrphanedDeletesOnlyOrphanedHashes(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()
	orphaned := shaOf("orphaned")
	referenced := shaOf("referenced")
	require.NoError(t, store.Put(ctx, orphaned, strings.NewReader("orphaned")))
	require.NoError(t, store.Put(ctx, referenced, strings.NewReader("referenced")))

	errs := ReclaimAllIfOrphaned(ctx, &fakeBatchRefCounter{counts: map[string]int{referenced: 1}}, store, []string{orphaned, referenced})
	assert.Empty(t, errs)

	_, err := store.Open(ctx, orphaned)
	require.ErrorIs(t, err, ErrNotFound)

	rc, err := store.Open(ctx, referenced)
	require.NoError(t, err)
	_ = rc.Close()
}

func TestReclaimAllIfOrphanedIsNoOpForEmptyInput(t *testing.T) {
	store := newTestImageStore(t)
	errs := ReclaimAllIfOrphaned(t.Context(), &fakeBatchRefCounter{}, store, nil)
	assert.Empty(t, errs)
}

func TestReclaimAllIfOrphanedPropagatesRefCountError(t *testing.T) {
	store := newTestImageStore(t)
	wantErr := errors.New("db unavailable")

	errs := ReclaimAllIfOrphaned(t.Context(), &fakeBatchRefCounter{err: wantErr}, store, []string{shaOf("x")})
	require.Len(t, errs, 1)
	assert.ErrorIs(t, errs[0], wantErr)
}
