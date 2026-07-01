package blobstore

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestThumbStore(t *testing.T) *ThumbStore {
	t.Helper()
	_, thumbs := newTestStores(t)
	return thumbs
}

func TestThumbStoreRoundTrip(t *testing.T) {
	store := newTestThumbStore(t)
	ctx := t.Context()
	sha := shaOf("original bytes")
	thumbContent := "resized jpeg bytes"

	require.NoError(t, store.Put(ctx, sha, strings.NewReader(thumbContent)))

	rc, err := store.Open(ctx, sha)
	require.NoError(t, err)
	defer rc.Close()

	got, err := io.ReadAll(rc)
	require.NoError(t, err)
	assert.Equal(t, thumbContent, string(got))
}

func TestThumbStoreLayout(t *testing.T) {
	store := newTestThumbStore(t)
	ctx := t.Context()
	sha := shaOf("original bytes")

	require.NoError(t, store.Put(ctx, sha, strings.NewReader("thumb")))

	wantPath := filepath.Join(store.root.Name(), "thumb", sha[0:2], sha[2:4], sha+".jpg")
	got, err := os.ReadFile(wantPath) // #nosec G304 -- test-controlled path
	require.NoError(t, err)
	assert.Equal(t, "thumb", string(got))
}

func TestThumbStoreDoesNotAffectOriginalBlob(t *testing.T) {
	images, thumbs := newTestStores(t)
	ctx := t.Context()
	content := "hello, blob"
	sha := shaOf(content)

	require.NoError(t, images.Put(ctx, sha, strings.NewReader(content)))
	require.NoError(t, thumbs.Put(ctx, sha, strings.NewReader("thumb bytes")))

	rc, err := images.Open(ctx, sha)
	require.NoError(t, err)
	defer rc.Close()
	got, err := io.ReadAll(rc)
	require.NoError(t, err)
	assert.Equal(t, content, string(got), "putting a thumbnail must not touch the original blob stored under the same hash")
}

func TestThumbStorePutIsNoOpIfAlreadyPresent(t *testing.T) {
	store := newTestThumbStore(t)
	ctx := t.Context()
	sha := shaOf("original bytes")

	require.NoError(t, store.Put(ctx, sha, strings.NewReader("first")))
	require.NoError(t, store.Put(ctx, sha, strings.NewReader("second")))

	rc, err := store.Open(ctx, sha)
	require.NoError(t, err)
	defer rc.Close()
	got, err := io.ReadAll(rc)
	require.NoError(t, err)
	assert.Equal(t, "first", string(got))
}

func TestThumbStoreOpenMissing(t *testing.T) {
	store := newTestThumbStore(t)
	ctx := t.Context()

	_, err := store.Open(ctx, shaOf("never stored"))
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestThumbStoreDelete(t *testing.T) {
	store := newTestThumbStore(t)
	ctx := t.Context()
	sha := shaOf("original bytes")

	require.NoError(t, store.Put(ctx, sha, strings.NewReader("thumb")))
	require.NoError(t, store.Delete(ctx, sha))

	_, err := store.Open(ctx, sha)
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestThumbStoreDeleteMissingIsNoOp(t *testing.T) {
	store := newTestThumbStore(t)
	ctx := t.Context()

	err := store.Delete(ctx, shaOf("was never here"))
	require.NoError(t, err)
}

func TestThumbStorePathSafety(t *testing.T) {
	store := newTestThumbStore(t)
	ctx := t.Context()

	invalidSHA := "../../../../etc/passwd"

	err := store.Put(ctx, invalidSHA, strings.NewReader("payload"))
	require.Error(t, err)

	_, err = store.Open(ctx, invalidSHA)
	require.Error(t, err)
	require.NotErrorIs(t, err, ErrNotFound, "invalid hashes must be rejected before the not-found lookup")

	err = store.Delete(ctx, invalidSHA)
	require.Error(t, err)
}
