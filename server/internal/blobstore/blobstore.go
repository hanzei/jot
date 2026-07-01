// Package blobstore provides filesystem-backed storage for note-image bytes:
// ImageStore for content-addressed, hash-verified originals, and ThumbStore
// for their derived, unverified JPEG thumbnails. Both share one on-disk root
// (see NewStores) so there is a single directory to configure and back up.
package blobstore

import "errors"

// ErrNotFound is returned by Open when no file exists for the given key.
var ErrNotFound = errors.New("blob not found")
