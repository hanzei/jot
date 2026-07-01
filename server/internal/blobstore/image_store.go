package blobstore

import (
	"context"
	"encoding/hex"
	"fmt"
	"io"
	"path/filepath"
)

// ImageStore is a content-addressed store for original note-image bytes,
// keyed by hex-encoded SHA-256 hash and laid out at
// blobs/<sha[0:2]>/<sha[2:4]>/<sha>, fanned out by hash prefix to keep
// directories shallow. Put verifies that the bytes it's given actually hash
// to the claimed key before committing them — that guarantee is what makes
// it safe for Put to dedup purely by checking whether a key already exists
// on disk, rather than re-reading and re-comparing content on every call.
type ImageStore struct {
	blobStore
}

// relPath returns the path of sha relative to the store root, validating
// that sha is a well-formed hex-encoded SHA-256 hash first so that caller
// input never reaches the filesystem path (no traversal).
func relPath(sha string) (string, error) {
	canon, err := canonicalSHA(sha)
	if err != nil {
		return "", err
	}
	return filepath.Join("blobs", canon[0:2], canon[2:4], canon), nil
}

// Put stores the bytes read from r under sha, verifying that they actually
// hash to sha before committing them. It is a no-op if a blob with that hash
// already exists.
func (s *ImageStore) Put(ctx context.Context, sha string, r io.Reader) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	canon, err := canonicalSHA(sha)
	if err != nil {
		return err
	}
	p := filepath.Join("blobs", canon[0:2], canon[2:4], canon)

	if ok, err := s.exists(p); err != nil {
		return err
	} else if ok {
		return nil // dedup: a blob with this hash is already stored
	}

	return s.writeAtomic(p, r, func(sum [32]byte) error {
		if got := hex.EncodeToString(sum[:]); got != canon {
			return fmt.Errorf("content sha256 %q does not match claimed hash %q", got, canon)
		}
		return nil
	})
}

// Open returns a reader for the blob stored under sha. It returns
// ErrNotFound if no such blob exists.
func (s *ImageStore) Open(ctx context.Context, sha string) (io.ReadSeekCloser, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	p, err := relPath(sha)
	if err != nil {
		return nil, err
	}
	return s.open(p)
}

// Delete removes the blob stored under sha. It is a no-op if no such blob
// exists.
func (s *ImageStore) Delete(ctx context.Context, sha string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	p, err := relPath(sha)
	if err != nil {
		return err
	}
	return s.remove(p)
}

// Close releases the directory handle shared with the companion ThumbStore
// returned alongside this ImageStore by NewStores.
func (s *ImageStore) Close() error {
	return s.root.Close()
}
