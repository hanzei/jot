// Package blobstore provides ImageStore, filesystem-backed storage for
// note-image bytes: content-addressed, hash-verified originals plus their
// derived, unverified JPEG thumbnails, both under one on-disk root (see
// NewImageStore) so there is a single directory to configure and back up.
package blobstore

import "errors"

// ErrNotFound is returned by Open when no file exists for the given key.
var ErrNotFound = errors.New("blob not found")
