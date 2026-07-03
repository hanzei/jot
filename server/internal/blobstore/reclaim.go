package blobstore

import (
	"context"
	"fmt"
)

// RefCounter reports how many rows still reference a content hash. Satisfied
// by *models.NoteStore (GetNoteImageRefCount) without this package needing to
// import models — blobstore stays a leaf package with no domain dependencies.
type RefCounter interface {
	GetNoteImageRefCount(ctx context.Context, sha256 string) (int, error)
}

// ReclaimIfOrphaned deletes sha's blob and derived thumbnail from store if no
// row still references it (dedup means another row may share the same
// content hash). It is a no-op if the hash is still referenced. Every
// note/image hard-delete path (single-image delete, upload rollback, and the
// note/user hard-delete cascades in issue #608) funnels through this, one
// hash at a time.
func ReclaimIfOrphaned(ctx context.Context, refCounter RefCounter, store *ImageStore, sha string) error {
	count, err := refCounter.GetNoteImageRefCount(ctx, sha)
	if err != nil {
		return fmt.Errorf("get note image refcount: %w", err)
	}
	if count > 0 {
		return nil
	}
	if err := store.Delete(ctx, sha); err != nil {
		return fmt.Errorf("reclaim %s: %w", sha, err)
	}
	return nil
}
