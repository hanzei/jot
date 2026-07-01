package blobstore

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// shaHexLen is the length of a lowercase hex-encoded SHA-256 hash.
const shaHexLen = sha256.Size * 2

var _ Blobstore = (*FSBlobstore)(nil)

// FSBlobstore is a Blobstore backed by a directory tree on the local
// filesystem. Blobs are laid out as
// root/blobs/<sha[0:2]>/<sha[2:4]>/<sha>, fanned out by hash prefix to keep
// directories shallow. All filesystem access goes through an os.Root opened
// on the upload directory, so even a bug in hash validation could not walk a
// name outside of it.
type FSBlobstore struct {
	root *os.Root
}

// NewFSBlobstore creates an FSBlobstore rooted at root, creating the
// directory if it does not already exist.
func NewFSBlobstore(root string) (*FSBlobstore, error) {
	if err := os.MkdirAll(root, 0o750); err != nil {
		return nil, fmt.Errorf("create upload dir: %w", err)
	}
	r, err := os.OpenRoot(root)
	if err != nil {
		return nil, fmt.Errorf("open upload dir: %w", err)
	}
	return &FSBlobstore{root: r}, nil
}

// Close releases the underlying directory handle.
func (s *FSBlobstore) Close() error {
	return s.root.Close()
}

// canonicalSHA validates that sha is a well-formed hex-encoded SHA-256 hash
// and returns its lowercase canonical form, so that every caller of
// FSBlobstore resolves to the same on-disk path regardless of the input's
// letter case.
func canonicalSHA(sha string) (string, error) {
	if len(sha) != shaHexLen {
		return "", fmt.Errorf("invalid sha256 hash %q: must be %d hex characters", sha, shaHexLen)
	}
	lower := strings.ToLower(sha)
	if _, err := hex.DecodeString(lower); err != nil {
		return "", fmt.Errorf("invalid sha256 hash %q: %w", sha, err)
	}
	return lower, nil
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

// thumbRelPath returns the path of sha's derived thumbnail relative to the
// store root, using the same fanout as relPath plus a .jpg suffix (thumbnails
// are always re-encoded as JPEG regardless of the original's type).
func thumbRelPath(sha string) (string, error) {
	canon, err := canonicalSHA(sha)
	if err != nil {
		return "", err
	}
	return filepath.Join("thumb", canon[0:2], canon[2:4], canon+".jpg"), nil
}

// randomHex returns n random bytes hex-encoded, used for temp file names.
func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate random suffix: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// Put implements Blobstore.
func (s *FSBlobstore) Put(ctx context.Context, sha string, r io.Reader) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	canon, err := canonicalSHA(sha)
	if err != nil {
		return err
	}
	p := filepath.Join("blobs", canon[0:2], canon[2:4], canon)

	if _, statErr := s.root.Stat(p); statErr == nil {
		return nil // dedup: a blob with this hash is already stored
	} else if !errors.Is(statErr, fs.ErrNotExist) {
		return fmt.Errorf("stat blob: %w", statErr)
	}

	dir := filepath.Dir(p)
	if mkdirErr := s.root.MkdirAll(dir, 0o750); mkdirErr != nil {
		return fmt.Errorf("create blob directory: %w", mkdirErr)
	}

	suffix, err := randomHex(8)
	if err != nil {
		return err
	}
	tmpPath := filepath.Join(dir, ".upload-"+suffix)
	tmp, err := s.root.OpenFile(tmpPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o640)
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	defer func() { _ = s.root.Remove(tmpPath) }() // no-op once the rename below succeeds

	h := sha256.New()
	if _, err := io.Copy(tmp, io.TeeReader(r, h)); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write blob: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp file: %w", err)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != canon {
		return fmt.Errorf("content sha256 %q does not match claimed hash %q", got, canon)
	}
	if err := s.root.Rename(tmpPath, p); err != nil {
		return fmt.Errorf("finalize blob: %w", err)
	}
	return nil
}

// Open implements Blobstore.
func (s *FSBlobstore) Open(ctx context.Context, sha string) (io.ReadSeekCloser, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	p, err := relPath(sha)
	if err != nil {
		return nil, err
	}

	f, err := s.root.Open(p)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("open blob: %w", err)
	}
	return f, nil
}

// Delete implements Blobstore.
func (s *FSBlobstore) Delete(ctx context.Context, sha string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	p, err := relPath(sha)
	if err != nil {
		return err
	}

	if err := s.root.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("delete blob: %w", err)
	}
	return nil
}

// PutThumbnail implements Blobstore.
func (s *FSBlobstore) PutThumbnail(ctx context.Context, sha string, r io.Reader) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	p, err := thumbRelPath(sha)
	if err != nil {
		return err
	}

	if _, statErr := s.root.Stat(p); statErr == nil {
		return nil // already generated
	} else if !errors.Is(statErr, fs.ErrNotExist) {
		return fmt.Errorf("stat thumbnail: %w", statErr)
	}

	dir := filepath.Dir(p)
	if mkdirErr := s.root.MkdirAll(dir, 0o750); mkdirErr != nil {
		return fmt.Errorf("create thumbnail directory: %w", mkdirErr)
	}

	suffix, err := randomHex(8)
	if err != nil {
		return err
	}
	tmpPath := filepath.Join(dir, ".upload-"+suffix)
	tmp, err := s.root.OpenFile(tmpPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o640)
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	defer func() { _ = s.root.Remove(tmpPath) }() // no-op once the rename below succeeds

	if _, err := io.Copy(tmp, r); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write thumbnail: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp file: %w", err)
	}
	if err := s.root.Rename(tmpPath, p); err != nil {
		return fmt.Errorf("finalize thumbnail: %w", err)
	}
	return nil
}

// OpenThumbnail implements Blobstore.
func (s *FSBlobstore) OpenThumbnail(ctx context.Context, sha string) (io.ReadSeekCloser, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	p, err := thumbRelPath(sha)
	if err != nil {
		return nil, err
	}

	f, err := s.root.Open(p)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("open thumbnail: %w", err)
	}
	return f, nil
}

// DeleteThumbnail implements Blobstore.
func (s *FSBlobstore) DeleteThumbnail(ctx context.Context, sha string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	p, err := thumbRelPath(sha)
	if err != nil {
		return err
	}

	if err := s.root.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("delete thumbnail: %w", err)
	}
	return nil
}
