// Package blobstore provides content-addressed storage for binary blobs
// (currently note image bytes) behind a small interface so a remote backend
// (e.g. S3) can be added later without touching callers.
package blobstore

import (
	"context"
	"errors"
	"io"
)

// ErrNotFound is returned by Open when no blob exists for the given hash.
var ErrNotFound = errors.New("blob not found")

// Blobstore is a content-addressed store keyed by hex-encoded SHA-256 hash.
// Implementations must derive any on-disk or remote location solely from the
// validated hash, never from caller-supplied metadata such as filenames.
type Blobstore interface {
	// Put stores the bytes read from r under sha, verifying that they
	// actually hash to sha before committing them. It is a no-op if a blob
	// with that hash already exists.
	Put(ctx context.Context, sha string, r io.Reader) error
	// Open returns a reader for the blob stored under sha. It returns
	// ErrNotFound if no such blob exists.
	Open(ctx context.Context, sha string) (io.ReadSeekCloser, error)
	// Delete removes the blob stored under sha. It is a no-op if no such
	// blob exists.
	Delete(ctx context.Context, sha string) error
}
