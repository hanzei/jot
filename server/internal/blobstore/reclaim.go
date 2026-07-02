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

// BatchRefCounter is RefCounter's bulk form, also satisfied by
// *models.NoteStore (GetNoteImageRefCounts). Reclaiming a whole batch of
// hashes (EmptyTrash, an admin user/notes delete, the periodic purge sweep)
// through ReclaimAllIfOrphaned costs one refcount query total instead of one
// per hash.
type BatchRefCounter interface {
	GetNoteImageRefCounts(ctx context.Context, shas []string) (map[string]int, error)
}

// ReclaimIfOrphaned deletes sha's blob and derived thumbnail from store if no
// row still references it (dedup means another row may share the same
// content hash). It is a no-op if the hash is still referenced. Used by
// callers reclaiming a single hash outside of a bulk delete (single-image
// delete, upload rollback).
func ReclaimIfOrphaned(ctx context.Context, refCounter RefCounter, store *ImageStore, sha string) error {
	count, err := refCounter.GetNoteImageRefCount(ctx, sha)
	if err != nil {
		return fmt.Errorf("get note image refcount: %w", err)
	}
	if count > 0 {
		return nil
	}
	return store.Delete(ctx, sha)
}

// ReclaimAllIfOrphaned is ReclaimIfOrphaned's batch form: it checks every
// hash in shas' refcount in a single query, then deletes whichever ones are
// now orphaned. Every note/user hard-delete cascade (issue #608) funnels
// through this so bulk deletes don't pay one refcount round-trip per image.
// Deletion failures for individual hashes are collected and returned rather
// than aborting the batch, so one bad blob doesn't block reclaiming the
// rest; callers typically log rather than fail the request over these, since
// the note_images rows are already gone by the time this runs.
func ReclaimAllIfOrphaned(ctx context.Context, refCounter BatchRefCounter, store *ImageStore, shas []string) []error {
	if len(shas) == 0 {
		return nil
	}

	counts, err := refCounter.GetNoteImageRefCounts(ctx, shas)
	if err != nil {
		return []error{fmt.Errorf("get note image refcounts: %w", err)}
	}

	var errs []error
	for _, sha := range shas {
		if counts[sha] > 0 {
			continue
		}
		if err := store.Delete(ctx, sha); err != nil {
			errs = append(errs, fmt.Errorf("reclaim %s: %w", sha, err))
		}
	}
	return errs
}
