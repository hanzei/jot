package blobstore

import (
	"context"
	"io"
	"path/filepath"
)

// ThumbStore stores derived JPEG thumbnails for note images, keyed by the
// *original* image's SHA-256 hash rather than the thumbnail's own content —
// a thumbnail is a resized/recompressed derivative, so it has no hash of its
// own to be addressed by. Unlike ImageStore, writes are not content-verified
// and thumbnails carry no reference count or DB row of their own: they are a
// disposable cache that any caller can safely delete or regenerate at any
// time (docs/specs/file-attachments.md §5).
type ThumbStore struct {
	blobStore
}

// thumbPath returns the path of sourceSHA's thumbnail relative to the store
// root, using the same fanout as ImageStore's relPath plus a .jpg suffix
// (thumbnails are always re-encoded as JPEG regardless of the original's
// type). Validating sourceSHA as a well-formed hash first keeps caller input
// out of the filesystem path (no traversal).
func thumbPath(sourceSHA string) (string, error) {
	canon, err := canonicalSHA(sourceSHA)
	if err != nil {
		return "", err
	}
	return filepath.Join("thumb", canon[0:2], canon[2:4], canon+".jpg"), nil
}

// Put stores the bytes read from r as the thumbnail for the original image
// identified by sourceSHA. It is a no-op if a thumbnail for sourceSHA
// already exists.
func (s *ThumbStore) Put(ctx context.Context, sourceSHA string, r io.Reader) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	p, err := thumbPath(sourceSHA)
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

// Open returns a reader for the thumbnail derived from the original image
// identified by sourceSHA. It returns ErrNotFound if no such thumbnail
// exists — thumbnails are a disposable cache, so callers should regenerate
// on a miss rather than treat it as an error.
func (s *ThumbStore) Open(ctx context.Context, sourceSHA string) (io.ReadSeekCloser, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	p, err := thumbPath(sourceSHA)
	if err != nil {
		return nil, err
	}
	return s.open(p)
}

// Delete removes the thumbnail derived from the original image identified by
// sourceSHA. It is a no-op if no such thumbnail exists.
func (s *ThumbStore) Delete(ctx context.Context, sourceSHA string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	p, err := thumbPath(sourceSHA)
	if err != nil {
		return err
	}
	return s.remove(p)
}
