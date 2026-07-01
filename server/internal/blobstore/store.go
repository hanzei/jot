package blobstore

import (
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

// blobStore provides the filesystem mechanics shared by ImageStore and
// ThumbStore: directory fanout, atomic writes, and safe path access via
// os.Root. It has no notion of content verification or what a key is
// supposed to mean — that policy belongs entirely to the types that embed
// it, so this type stays reusable for both the verified and unverified case.
type blobStore struct {
	root *os.Root
}

// newBlobStore creates the directory at root if it does not already exist
// and opens it via os.Root, so all filesystem access below is confined to
// it — even a bug that let a malformed key through a caller's validation
// could not escape it.
func newBlobStore(root string) (*blobStore, error) {
	if err := os.MkdirAll(root, 0o750); err != nil {
		return nil, fmt.Errorf("create upload dir: %w", err)
	}
	r, err := os.OpenRoot(root)
	if err != nil {
		return nil, fmt.Errorf("open upload dir: %w", err)
	}
	return &blobStore{root: r}, nil
}

// canonicalSHA validates that sha is a well-formed hex-encoded SHA-256 hash
// and returns its lowercase canonical form, so that every caller resolves to
// the same on-disk path regardless of the input's letter case.
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

// randomHex returns n random bytes hex-encoded, used for temp file names.
func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate random suffix: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// exists reports whether a file is already present at path.
func (s *blobStore) exists(path string) (bool, error) {
	if _, err := s.root.Stat(path); err == nil {
		return true, nil
	} else if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	} else {
		return false, fmt.Errorf("stat file: %w", err)
	}
}

// writeAtomic writes the content of r to path via a randomly-named temp file
// in the same directory, then renames it into place, so a concurrent reader
// never observes a partial write. If verify is non-nil, it is called with
// the SHA-256 of the bytes actually written before the rename; a returned
// error aborts the write and the temp file is discarded without the target
// path ever becoming visible. Callers that don't need that guarantee (e.g.
// a derived cache with no self-verifiable content) pass a nil verify.
func (s *blobStore) writeAtomic(path string, r io.Reader, verify func(sum [32]byte) error) error {
	dir := filepath.Dir(path)
	if err := s.root.MkdirAll(dir, 0o750); err != nil {
		return fmt.Errorf("create directory: %w", err)
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
		return fmt.Errorf("write file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp file: %w", err)
	}

	if verify != nil {
		var sum [32]byte
		copy(sum[:], h.Sum(nil))
		if err := verify(sum); err != nil {
			return err
		}
	}

	if err := s.root.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("finalize file: %w", err)
	}
	return nil
}

// open returns a reader for the file at path, mapping a missing file to
// ErrNotFound.
func (s *blobStore) open(path string) (io.ReadSeekCloser, error) {
	f, err := s.root.Open(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("open file: %w", err)
	}
	return f, nil
}

// remove deletes the file at path. It is a no-op if no such file exists.
func (s *blobStore) remove(path string) error {
	if err := s.root.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("delete file: %w", err)
	}
	return nil
}

// NewStores creates the ImageStore and its companion ThumbStore, both
// rooted at the same directory (creating it if it does not already exist).
// They share one os.Root so there is exactly one upload directory to
// configure and back up (docs/specs/file-attachments.md §5) — there is
// deliberately no separate constructor that could point them at different
// roots. Call Close on the returned ImageStore during shutdown; ThumbStore
// does not own the underlying handle and has no Close of its own.
func NewStores(root string) (*ImageStore, *ThumbStore, error) {
	bs, err := newBlobStore(root)
	if err != nil {
		return nil, nil, err
	}
	return &ImageStore{blobStore: *bs}, &ThumbStore{blobStore: *bs}, nil
}
