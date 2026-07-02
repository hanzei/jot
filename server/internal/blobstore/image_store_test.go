package blobstore

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func shaOf(data string) string {
	sum := sha256.Sum256([]byte(data))
	return hex.EncodeToString(sum[:])
}

func newTestImageStore(t *testing.T) *ImageStore {
	t.Helper()
	store, err := NewImageStore(t.TempDir())
	require.NoError(t, err)
	return store
}

func TestNewImageStoreCreatesRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "uploads")
	_, err := NewImageStore(root)
	require.NoError(t, err)

	info, err := os.Stat(root)
	require.NoError(t, err)
	assert.True(t, info.IsDir())
}

func TestImageStoreRoundTrip(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()
	content := "hello, blob"
	sha := shaOf(content)

	require.NoError(t, store.Put(ctx, sha, strings.NewReader(content)))

	rc, err := store.Open(ctx, sha)
	require.NoError(t, err)
	defer rc.Close()

	got, err := io.ReadAll(rc)
	require.NoError(t, err)
	assert.Equal(t, content, string(got))
}

func TestImageStorePutLayout(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()
	content := "layout check"
	sha := shaOf(content)

	require.NoError(t, store.Put(ctx, sha, strings.NewReader(content)))

	wantPath := filepath.Join(store.root.Name(), "blobs", sha[0:2], sha[2:4], sha)
	got, err := os.ReadFile(wantPath) // #nosec G304 -- test-controlled path
	require.NoError(t, err)
	assert.Equal(t, content, string(got))
}

func TestImageStorePutDedupNoOp(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()
	content := "original bytes"
	sha := shaOf(content)

	require.NoError(t, store.Put(ctx, sha, strings.NewReader(content)))

	// A second Put for the same hash must not touch the stored bytes, even
	// if handed a reader with different content (dedup short-circuits
	// before reading).
	require.NoError(t, store.Put(ctx, sha, strings.NewReader("different bytes")))

	rc, err := store.Open(ctx, sha)
	require.NoError(t, err)
	defer rc.Close()

	got, err := io.ReadAll(rc)
	require.NoError(t, err)
	assert.Equal(t, content, string(got))
}

func TestImageStoreHashIsCaseInsensitive(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()
	content := "case insensitivity check"
	sha := shaOf(content)

	require.NoError(t, store.Put(ctx, strings.ToUpper(sha), strings.NewReader(content)))

	rc, err := store.Open(ctx, sha)
	require.NoError(t, err)
	defer rc.Close()

	got, err := io.ReadAll(rc)
	require.NoError(t, err)
	assert.Equal(t, content, string(got))

	wantPath := filepath.Join(store.root.Name(), "blobs", sha[0:2], sha[2:4], sha)
	_, err = os.Stat(wantPath) // #nosec G304 -- test-controlled path
	require.NoError(t, err, "an uppercase hash must resolve to the same canonical lowercase path")
}

func TestImageStorePutRejectsContentHashMismatch(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()
	claimedSha := shaOf("this is not the content that follows")

	err := store.Put(ctx, claimedSha, strings.NewReader("actual content"))
	require.Error(t, err)

	// A rejected write must not leave a blob behind under the claimed hash.
	_, err = store.Open(ctx, claimedSha)
	require.ErrorIs(t, err, ErrNotFound)
}

func TestImageStoreOpenMissing(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()

	_, err := store.Open(ctx, shaOf("never stored"))
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestImageStoreDelete(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()
	content := "to be deleted"
	sha := shaOf(content)

	require.NoError(t, store.Put(ctx, sha, strings.NewReader(content)))
	require.NoError(t, store.Delete(ctx, sha))

	_, err := store.Open(ctx, sha)
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestImageStoreDeleteRemovesThumbnailToo(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()
	content := "original bytes"
	sha := shaOf(content)

	require.NoError(t, store.Put(ctx, sha, strings.NewReader(content)))
	require.NoError(t, store.PutThumbnail(ctx, sha, strings.NewReader("thumb bytes")))

	require.NoError(t, store.Delete(ctx, sha))

	_, err := store.Open(ctx, sha)
	require.ErrorIs(t, err, ErrNotFound, "Delete must remove the original")

	_, err = store.OpenThumbnail(ctx, sha)
	require.ErrorIs(t, err, ErrNotFound, "Delete must remove the derived thumbnail too — there is no separate DeleteThumbnail")
}

func TestImageStoreClose(t *testing.T) {
	store := newTestImageStore(t)
	require.NoError(t, store.Close())
}

func TestImageStoreDeleteMissingIsNoOp(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()

	err := store.Delete(ctx, shaOf("was never here"))
	require.NoError(t, err)
}

func TestImageStorePathSafety(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()

	tests := []struct {
		name string
		sha  string
	}{
		{"path traversal", "../../../../etc/passwd"},
		{"traversal padded to length", "../../../../../../../../../etc/passwdXXXXXXXX"},
		{"embedded slash", strings.Repeat("a", 30) + "/" + strings.Repeat("b", 33)},
		{"too short", "abc123"},
		{"too long", strings.Repeat("a", shaHexLen+1)},
		{"non-hex characters", strings.Repeat("z", shaHexLen)},
		{"empty", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := store.Put(ctx, tt.sha, strings.NewReader("payload"))
			require.Error(t, err)

			_, err = store.Open(ctx, tt.sha)
			require.Error(t, err)
			require.NotErrorIs(t, err, ErrNotFound, "invalid hashes must be rejected before the not-found lookup")

			err = store.Delete(ctx, tt.sha)
			require.Error(t, err)

			err = store.PutThumbnail(ctx, tt.sha, strings.NewReader("payload"))
			require.Error(t, err)

			_, err = store.OpenThumbnail(ctx, tt.sha)
			require.Error(t, err)
			require.NotErrorIs(t, err, ErrNotFound, "invalid hashes must be rejected before the not-found lookup")
		})
	}

	// Nothing must have escaped the store root.
	entries, err := os.ReadDir(store.root.Name())
	require.NoError(t, err)
	for _, e := range entries {
		assert.Contains(t, []string{"blobs", "thumb"}, e.Name())
	}
}

// TestImageStoreRootRejectsEscape exercises the os.Root layer directly,
// bypassing relPath's own hash validation, to confirm it is a genuine second
// line of defense rather than dead code: even a hypothetical bug that let a
// "../"-containing name through relPath would still be rejected here.
func TestImageStoreRootRejectsEscape(t *testing.T) {
	store := newTestImageStore(t)

	_, err := store.root.OpenFile(filepath.Join("..", "escaped"), os.O_CREATE|os.O_WRONLY, 0o640)
	require.Error(t, err)
}

func TestImageStoreThumbnailRoundTrip(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()
	sha := shaOf("original bytes")
	thumbContent := "resized jpeg bytes"

	require.NoError(t, store.PutThumbnail(ctx, sha, strings.NewReader(thumbContent)))

	rc, err := store.OpenThumbnail(ctx, sha)
	require.NoError(t, err)
	defer rc.Close()

	got, err := io.ReadAll(rc)
	require.NoError(t, err)
	assert.Equal(t, thumbContent, string(got))
}

func TestImageStoreThumbnailLayout(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()
	sha := shaOf("original bytes")

	require.NoError(t, store.PutThumbnail(ctx, sha, strings.NewReader("thumb")))

	wantPath := filepath.Join(store.root.Name(), "thumb", sha[0:2], sha[2:4], sha+".jpg")
	got, err := os.ReadFile(wantPath) // #nosec G304 -- test-controlled path
	require.NoError(t, err)
	assert.Equal(t, "thumb", string(got))
}

func TestImageStoreThumbnailDoesNotAffectOriginalBlob(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()
	content := "hello, blob"
	sha := shaOf(content)

	require.NoError(t, store.Put(ctx, sha, strings.NewReader(content)))
	require.NoError(t, store.PutThumbnail(ctx, sha, strings.NewReader("thumb bytes")))

	rc, err := store.Open(ctx, sha)
	require.NoError(t, err)
	defer rc.Close()
	got, err := io.ReadAll(rc)
	require.NoError(t, err)
	assert.Equal(t, content, string(got), "putting a thumbnail must not touch the original blob stored under the same hash")
}

func TestImageStorePutThumbnailIsNoOpIfAlreadyPresent(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()
	sha := shaOf("original bytes")

	require.NoError(t, store.PutThumbnail(ctx, sha, strings.NewReader("first")))
	require.NoError(t, store.PutThumbnail(ctx, sha, strings.NewReader("second")))

	rc, err := store.OpenThumbnail(ctx, sha)
	require.NoError(t, err)
	defer rc.Close()
	got, err := io.ReadAll(rc)
	require.NoError(t, err)
	assert.Equal(t, "first", string(got))
}

func TestImageStoreOpenThumbnailMissing(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()

	_, err := store.OpenThumbnail(ctx, shaOf("never stored"))
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestImageStoreListEmpty(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()

	shas, err := store.List(ctx)
	require.NoError(t, err)
	assert.Empty(t, shas)
}

func TestImageStoreListReturnsStoredHashes(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()
	shaA := shaOf("blob a")
	shaB := shaOf("blob b")

	require.NoError(t, store.Put(ctx, shaA, strings.NewReader("blob a")))
	require.NoError(t, store.Put(ctx, shaB, strings.NewReader("blob b")))

	shas, err := store.List(ctx)
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{shaA, shaB}, shas)
}

func TestImageStoreListIgnoresThumbnails(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()
	sha := shaOf("has a thumbnail")

	require.NoError(t, store.Put(ctx, sha, strings.NewReader("has a thumbnail")))
	require.NoError(t, store.PutThumbnail(ctx, sha, strings.NewReader("thumb bytes")))

	shas, err := store.List(ctx)
	require.NoError(t, err)
	assert.Equal(t, []string{sha}, shas, "List must report the original once, not once per stored file")
}

func TestImageStoreListSkipsAfterDelete(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()
	shaA := shaOf("kept")
	shaB := shaOf("removed")

	require.NoError(t, store.Put(ctx, shaA, strings.NewReader("kept")))
	require.NoError(t, store.Put(ctx, shaB, strings.NewReader("removed")))
	require.NoError(t, store.Delete(ctx, shaB))

	shas, err := store.List(ctx)
	require.NoError(t, err)
	assert.Equal(t, []string{shaA}, shas)
}

func TestImageStoreDeleteThumbnailOnlyIsNoOpForMissingOriginal(t *testing.T) {
	store := newTestImageStore(t)
	ctx := t.Context()
	sha := shaOf("original bytes")

	require.NoError(t, store.PutThumbnail(ctx, sha, strings.NewReader("thumb")))

	// No original was ever stored under sha; Delete must still succeed and
	// clean up the thumbnail that does exist.
	require.NoError(t, store.Delete(ctx, sha))

	_, err := store.OpenThumbnail(ctx, sha)
	assert.ErrorIs(t, err, ErrNotFound)
}
