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

// relPath returns the path of sha relative to the store root, validating
// that sha is a well-formed hex-encoded SHA-256 hash first so that caller
// input never reaches the filesystem path (no traversal).
func relPath(sha string) (string, error) {
	if len(sha) != shaHexLen {
		return "", fmt.Errorf("invalid sha256 hash %q: must be %d hex characters", sha, shaHexLen)
	}
	if _, err := hex.DecodeString(sha); err != nil {
		return "", fmt.Errorf("invalid sha256 hash %q: %w", sha, err)
	}
	return filepath.Join("blobs", sha[0:2], sha[2:4], sha), nil
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
	p, err := relPath(sha)
	if err != nil {
		return err
	}

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

	if _, err := io.Copy(tmp, r); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write blob: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp file: %w", err)
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
