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
// hash at a time; Sweep is the safety net for anything those paths miss.
func ReclaimIfOrphaned(ctx context.Context, refCounter RefCounter, store *ImageStore, sha string) error {
	_, err := reclaimIfOrphaned(ctx, refCounter, store, sha)
	return err
}

// reclaimIfOrphaned is ReclaimIfOrphaned, additionally reporting whether it
// deleted anything, so Sweep can count what it reclaimed.
func reclaimIfOrphaned(ctx context.Context, refCounter RefCounter, store *ImageStore, sha string) (bool, error) {
	count, err := refCounter.GetNoteImageRefCount(ctx, sha)
	if err != nil {
		return false, fmt.Errorf("get note image refcount: %w", err)
	}
	if count > 0 {
		return false, nil
	}
	if err := store.Delete(ctx, sha); err != nil {
		return false, fmt.Errorf("reclaim %s: %w", sha, err)
	}
	return true, nil
}
