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

func newTestStore(t *testing.T) *FSBlobstore {
	t.Helper()
	store, err := NewFSBlobstore(t.TempDir())
	require.NoError(t, err)
	return store
}

func TestNewFSBlobstoreCreatesRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "uploads")
	_, err := NewFSBlobstore(root)
	require.NoError(t, err)

	info, err := os.Stat(root)
	require.NoError(t, err)
	assert.True(t, info.IsDir())
}

func TestFSBlobstoreRoundTrip(t *testing.T) {
	store := newTestStore(t)
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

func TestFSBlobstorePutLayout(t *testing.T) {
	store := newTestStore(t)
	ctx := t.Context()
	content := "layout check"
	sha := shaOf(content)

	require.NoError(t, store.Put(ctx, sha, strings.NewReader(content)))

	wantPath := filepath.Join(store.root.Name(), "blobs", sha[0:2], sha[2:4], sha)
	got, err := os.ReadFile(wantPath) // #nosec G304 -- test-controlled path
	require.NoError(t, err)
	assert.Equal(t, content, string(got))
}

func TestFSBlobstorePutDedupNoOp(t *testing.T) {
	store := newTestStore(t)
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

func TestFSBlobstoreHashIsCaseInsensitive(t *testing.T) {
	store := newTestStore(t)
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

func TestFSBlobstorePutRejectsContentHashMismatch(t *testing.T) {
	store := newTestStore(t)
	ctx := t.Context()
	claimedSha := shaOf("this is not the content that follows")

	err := store.Put(ctx, claimedSha, strings.NewReader("actual content"))
	require.Error(t, err)

	// A rejected write must not leave a blob behind under the claimed hash.
	_, err = store.Open(ctx, claimedSha)
	require.ErrorIs(t, err, ErrNotFound)
}

func TestFSBlobstoreOpenMissing(t *testing.T) {
	store := newTestStore(t)
	ctx := t.Context()

	_, err := store.Open(ctx, shaOf("never stored"))
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestFSBlobstoreDelete(t *testing.T) {
	store := newTestStore(t)
	ctx := t.Context()
	content := "to be deleted"
	sha := shaOf(content)

	require.NoError(t, store.Put(ctx, sha, strings.NewReader(content)))
	require.NoError(t, store.Delete(ctx, sha))

	_, err := store.Open(ctx, sha)
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestFSBlobstoreClose(t *testing.T) {
	store := newTestStore(t)
	require.NoError(t, store.Close())
}

func TestFSBlobstoreDeleteMissingIsNoOp(t *testing.T) {
	store := newTestStore(t)
	ctx := t.Context()

	err := store.Delete(ctx, shaOf("was never here"))
	require.NoError(t, err)
}

func TestFSBlobstorePathSafety(t *testing.T) {
	store := newTestStore(t)
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
		})
	}

	// Nothing must have escaped the store root.
	entries, err := os.ReadDir(store.root.Name())
	require.NoError(t, err)
	for _, e := range entries {
		assert.Equal(t, "blobs", e.Name())
	}
}

// TestFSBlobstoreRootRejectsEscape exercises the os.Root layer directly,
// bypassing relPath's own hash validation, to confirm it is a genuine second
// line of defense rather than dead code: even a hypothetical bug that let a
// "../"-containing name through relPath would still be rejected here.
func TestFSBlobstoreRootRejectsEscape(t *testing.T) {
	store := newTestStore(t)

	_, err := store.root.OpenFile(filepath.Join("..", "escaped"), os.O_CREATE|os.O_WRONLY, 0o640)
	require.Error(t, err)
}
