// Package blobgc reclaims note-image blobs that are no longer referenced by
// any note_images row, and sweeps for the rare case a blob is missing on
// disk. See docs/specs/file-attachments.md §10.
package blobgc

import (
	"context"

	"github.com/hanzei/jot/server/internal/logutil"
	"github.com/hanzei/jot/server/internal/models"
)

// Blobstore is the subset of blobstore.Blobstore that blob GC needs.
type Blobstore interface {
	Delete(ctx context.Context, sha string) error
	List(ctx context.Context) ([]string, error)
}

// RefCounter is the subset of models.NoteStore that Reclaim needs to decide
// whether a blob is still referenced.
type RefCounter interface {
	GetNoteImageRefCount(ctx context.Context, sha256 string) (int, error)
}

// Store is the subset of models.NoteStore that the orphan Sweep needs.
type Store interface {
	ListDistinctImageSHA256(ctx context.Context) ([]string, error)
	GetNoteImagesBySHA256(ctx context.Context, sha256 string) ([]models.NoteImage, error)
}

// Reclaim deletes each blob in shas whose reference count has dropped to
// zero (dedup means another row may still share the same content hash). This
// is the primary reclamation path, called synchronously after a row delete —
// the client-deferred single-image delete, or a note hard-delete cascade
// (trash empty/purge, admin bulk delete). Failures for individual hashes are
// logged and skipped rather than aborting the batch; Sweep is the safety net
// for anything left behind.
func Reclaim(ctx context.Context, bs Blobstore, rc RefCounter, shas []string) {
	log := logutil.FromContext(ctx)
	for _, sha := range shas {
		count, err := rc.GetNoteImageRefCount(ctx, sha)
		if err != nil {
			log.WithError(err).WithField("sha256", sha).Error("Failed to check note image refcount for blob reclamation")
			continue
		}
		if count > 0 {
			continue
		}
		if err := bs.Delete(ctx, sha); err != nil {
			log.WithError(err).WithField("sha256", sha).Error("Failed to reclaim orphaned note image blob")
		}
	}
}

// SweepResult reports what a Sweep found, for logging/telemetry.
type SweepResult struct {
	// BlobsReclaimed is the number of on-disk blobs deleted because no
	// note_images row referenced them.
	BlobsReclaimed int
	// MissingBlobs is the number of distinct content hashes referenced by at
	// least one note_images row but not found on disk.
	MissingBlobs int
	// MissingRows is the total number of note_images rows affected by a
	// missing blob (a hash may be referenced by more than one row, dedup).
	MissingRows int
}

// Sweep deletes on-disk blobs with zero referencing rows and logs rows whose
// blob is missing on disk. It is a safety net for crash-after-row-delete
// races (Reclaim is the primary path); run it at startup and daily.
func Sweep(ctx context.Context, bs Blobstore, store Store) (SweepResult, error) {
	onDisk, err := bs.List(ctx)
	if err != nil {
		return SweepResult{}, err
	}
	referenced, err := store.ListDistinctImageSHA256(ctx)
	if err != nil {
		return SweepResult{}, err
	}

	referencedSet := make(map[string]struct{}, len(referenced))
	for _, sha := range referenced {
		referencedSet[sha] = struct{}{}
	}
	onDiskSet := make(map[string]struct{}, len(onDisk))
	for _, sha := range onDisk {
		onDiskSet[sha] = struct{}{}
	}

	log := logutil.FromContext(ctx)
	var result SweepResult

	for _, sha := range onDisk {
		if _, ok := referencedSet[sha]; ok {
			continue
		}
		if err := bs.Delete(ctx, sha); err != nil {
			log.WithError(err).WithField("sha256", sha).Error("Orphan sweep: failed to delete unreferenced blob")
			continue
		}
		result.BlobsReclaimed++
	}

	for _, sha := range referenced {
		if _, ok := onDiskSet[sha]; ok {
			continue
		}
		rows, err := store.GetNoteImagesBySHA256(ctx, sha)
		if err != nil {
			log.WithError(err).WithField("sha256", sha).Error("Orphan sweep: failed to look up rows for missing blob")
			continue
		}
		result.MissingBlobs++
		result.MissingRows += len(rows)
		ids := make([]string, len(rows))
		for i, row := range rows {
			ids[i] = row.ID
		}
		log.WithField("sha256", sha).WithField("note_image_ids", ids).Warn("Orphan sweep: note image row(s) reference a blob missing on disk")
	}

	return result, nil
}
