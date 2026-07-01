package blobstore

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"path/filepath"
)

// ImageStore stores note-image bytes on the filesystem: originals, laid out
// at blobs/<sha[0:2]>/<sha[2:4]>/<sha> and content-addressed by hex-encoded
// SHA-256 hash, plus their derived thumbnails at
// thumb/<sha[0:2]>/<sha[2:4]>/<sha>.jpg, keyed by the *original's* hash
// rather than their own content (a thumbnail is a resized/recompressed
// derivative, so it has no hash of its own to be addressed by). Both live
// under one root (see NewImageStore) — a single directory to configure and
// back up (docs/specs/file-attachments.md §5).
//
// Put verifies that the bytes it's given actually hash to the claimed key
// before committing them — that guarantee is what makes it safe for Put to
// dedup purely by checking whether a key already exists on disk.
// PutThumbnail/OpenThumbnail carry no such guarantee: thumbnails are a
// disposable cache that any caller can safely regenerate on a miss.
//
// Generating a thumbnail from an original — or regenerating one that's gone
// missing — is the caller's job, not this type's: that requires decoding and
// resizing image bytes, which belongs with the rest of the image-processing
// logic in internal/handlers, not in a storage type. ImageStore only stores
// what it's handed. Delete is the one deliberate exception: deleting an
// original always implies its thumbnail should go too, so Delete removes
// both in one call rather than requiring a separate DeleteThumbnail.
type ImageStore struct {
	blobStore
}

// NewImageStore creates an ImageStore rooted at root, creating the
// directory if it does not already exist.
func NewImageStore(root string) (*ImageStore, error) {
	bs, err := newBlobStore(root)
	if err != nil {
		return nil, err
	}
	return &ImageStore{blobStore: *bs}, nil
}

// relPath returns the path of sha's original blob relative to the store
// root, validating that sha is a well-formed hex-encoded SHA-256 hash first
// so that caller input never reaches the filesystem path (no traversal).
func relPath(sha string) (string, error) {
	canon, err := canonicalSHA(sha)
	if err != nil {
		return "", err
	}
	return filepath.Join("blobs", canon[0:2], canon[2:4], canon), nil
}

// thumbRelPath returns the path of sha's thumbnail relative to the store
// root, using the same fanout as relPath plus a .jpg suffix (thumbnails are
// always re-encoded as JPEG regardless of the original's type).
func thumbRelPath(sha string) (string, error) {
	canon, err := canonicalSHA(sha)
	if err != nil {
		return "", err
	}
	return filepath.Join("thumb", canon[0:2], canon[2:4], canon+".jpg"), nil
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

// Delete removes the blob stored under sha along with its derived
// thumbnail, if any — deleting an original always implies its thumbnail
// should go too, so there is no separate DeleteThumbnail. It is a no-op for
// either that doesn't exist.
func (s *ImageStore) Delete(ctx context.Context, sha string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	p, err := relPath(sha)
	if err != nil {
		return err
	}
	tp, err := thumbRelPath(sha)
	if err != nil {
		return err
	}
	return errors.Join(s.remove(p), s.remove(tp))
}

// PutThumbnail stores the bytes read from r as the thumbnail for the
// original image identified by sha. It is a no-op if a thumbnail for sha
// already exists.
func (s *ImageStore) PutThumbnail(ctx context.Context, sha string, r io.Reader) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	p, err := thumbRelPath(sha)
	if err != nil {
		return err
	}

	if ok, err := s.exists(p); err != nil {
		return err
	} else if ok {
		return nil // already generated
	}

	return s.writeAtomic(p, r, nil)
}

// OpenThumbnail returns a reader for the thumbnail derived from the
// original image identified by sha. It returns ErrNotFound if no such
// thumbnail exists — thumbnails are a disposable cache, so callers should
// regenerate on a miss rather than treat it as an error.
func (s *ImageStore) OpenThumbnail(ctx context.Context, sha string) (io.ReadSeekCloser, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	p, err := thumbRelPath(sha)
	if err != nil {
		return nil, err
	}
	return s.open(p)
}

// Close releases the underlying directory handle.
func (s *ImageStore) Close() error {
	return s.root.Close()
}
