package blobstore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// shaHexLen is the length of a lowercase hex-encoded SHA-256 hash.
const shaHexLen = sha256.Size * 2

var _ Blobstore = (*FSBlobstore)(nil)

// FSBlobstore is a Blobstore backed by a directory tree on the local
// filesystem. Blobs are laid out as
// root/blobs/<sha[0:2]>/<sha[2:4]>/<sha>, fanned out by hash prefix to keep
// directories shallow.
type FSBlobstore struct {
	root string
}

// NewFSBlobstore creates an FSBlobstore rooted at root, creating the root
// directory if it does not already exist.
func NewFSBlobstore(root string) (*FSBlobstore, error) {
	if err := os.MkdirAll(root, 0o750); err != nil {
		return nil, fmt.Errorf("create upload dir: %w", err)
	}
	return &FSBlobstore{root: root}, nil
}

// path returns the on-disk location for sha, validating that sha is a
// well-formed hex-encoded SHA-256 hash first so that caller input never
// reaches the filesystem path (no traversal).
func (s *FSBlobstore) path(sha string) (string, error) {
	if len(sha) != shaHexLen {
		return "", fmt.Errorf("invalid sha256 hash %q: must be %d hex characters", sha, shaHexLen)
	}
	if _, err := hex.DecodeString(sha); err != nil {
		return "", fmt.Errorf("invalid sha256 hash %q: %w", sha, err)
	}
	return filepath.Join(s.root, "blobs", sha[0:2], sha[2:4], sha), nil
}

// Put implements Blobstore.
func (s *FSBlobstore) Put(ctx context.Context, sha string, r io.Reader) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	p, err := s.path(sha)
	if err != nil {
		return err
	}

	if _, statErr := os.Stat(p); statErr == nil {
		return nil // dedup: a blob with this hash is already stored
	} else if !errors.Is(statErr, fs.ErrNotExist) {
		return fmt.Errorf("stat blob: %w", statErr)
	}

	dir := filepath.Dir(p)
	if mkdirErr := os.MkdirAll(dir, 0o750); mkdirErr != nil {
		return fmt.Errorf("create blob directory: %w", mkdirErr)
	}

	tmp, err := os.CreateTemp(dir, ".upload-*")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }() // no-op once the rename below succeeds

	if _, err := io.Copy(tmp, r); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write blob: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp file: %w", err)
	}
	if err := os.Rename(tmpPath, p); err != nil {
		return fmt.Errorf("finalize blob: %w", err)
	}
	return nil
}

// Open implements Blobstore.
func (s *FSBlobstore) Open(ctx context.Context, sha string) (io.ReadSeekCloser, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	p, err := s.path(sha)
	if err != nil {
		return nil, err
	}

	f, err := os.Open(p) // #nosec G304 -- p is derived solely from the validated hex hash, no traversal possible
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
	p, err := s.path(sha)
	if err != nil {
		return err
	}

	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("delete blob: %w", err)
	}
	return nil
}
