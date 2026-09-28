package blobstore

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"slices"
	"strings"
	"time"
)

// SweepRefCounter is what Sweep needs from the database: every referenced
// hash in one query up front, plus the single-hash RefCounter to re-check a
// candidate right before acting on it.
type SweepRefCounter interface {
	RefCounter
	GetNoteImageRefCounts(ctx context.Context) (map[string]int, error)
}

// MissingBlob is a content hash that note_images rows reference but whose
// original blob is absent from disk.
type MissingBlob struct {
	SHA256 string
	Rows   int
}

// SweepReport summarizes one Sweep run.
type SweepReport struct {
	// BlobsScanned counts distinct hashes found on disk (an original, a
	// thumbnail, or both).
	BlobsScanned int
	// Reclaimed counts hashes whose unreferenced blob and/or thumbnail were
	// deleted.
	Reclaimed int
	// TempFilesRemoved counts stale temp files left behind by an interrupted
	// write.
	TempFilesRemoved int
	// MissingBlobs lists referenced hashes whose original blob is gone.
	MissingBlobs []MissingBlob
	// UnreferencedSkipped counts unreferenced hashes left alone because the
	// database references no images at all (see Sweep).
	UnreferencedSkipped int
}

// sweepDirs are the store's two trees: originals and their thumbnails.
var sweepDirs = [...]string{"blobs", "thumb"}

// Sweep is the safety net behind the synchronous ReclaimIfOrphaned path. It
// runs at startup and then daily, and walks the store and:
//
//   - deletes every blob and thumbnail no note_images row references, which
//     covers a crash between Put and the row commit, and a reclaim that
//     failed or never ran after a row delete;
//   - removes temp files an interrupted write left behind;
//   - reports referenced hashes whose original blob is missing, e.g. after
//     restoring a database and upload directory backed up at different times.
//
// Deletion goes through reclaimIfOrphaned, so a hash pinned by an in-flight
// upload (ImageStore.Pin) is never deleted. As defense in depth, only files
// whose newest modification time is older than grace are touched,
// so an upload whose blob is written but whose row has not committed yet is
// left alone (Put refreshes the mtime of a blob it dedups against for the
// same reason). Right before deleting, each candidate's files are re-statted
// against the grace period and its refcount is re-checked, and each missing
// blob's refcount is re-checked right before it is reported, so a row created
// or deleted while the sweep runs is not misjudged.
//
// If no row references any image, nothing is deleted: see UnreferencedSkipped.
//
// Errors on individual hashes do not stop the sweep; they are joined into the
// returned error alongside the report of everything else it did.
func Sweep(ctx context.Context, refs SweepRefCounter, store *ImageStore, grace time.Duration) (SweepReport, error) {
	// Loaded before the walk: a row committed after this point has a blob
	// that is either fresh (skipped by grace) or re-checked below.
	referenced, err := refs.GetNoteImageRefCounts(ctx)
	if err != nil {
		return SweepReport{}, fmt.Errorf("get note image refcounts: %w", err)
	}

	sw := &sweeper{
		refs:    refs,
		store:   store,
		cutoff:  time.Now().Add(-grace), //nolint:gocritic // compared against filesystem mtimes, not a timestamp column
		newest:  make(map[string]time.Time),
		hasBlob: make(map[string]bool),
	}
	for _, dir := range sweepDirs {
		if err := sw.walk(ctx, dir); err != nil {
			return sw.report, fmt.Errorf("walk %s: %w", dir, err)
		}
	}
	sw.report.BlobsScanned = len(sw.newest)

	if err := sw.reclaimUnreferenced(ctx, referenced); err != nil {
		return sw.report, errors.Join(append(sw.errs, err)...)
	}
	if err := sw.findMissing(ctx, referenced); err != nil {
		return sw.report, errors.Join(append(sw.errs, err)...)
	}
	slices.SortFunc(sw.report.MissingBlobs, func(a, b MissingBlob) int { return strings.Compare(a.SHA256, b.SHA256) })
	return sw.report, errors.Join(sw.errs...)
}

// sweeper holds one Sweep run's state. Per-hash failures accumulate in errs;
// its methods return an error only for what aborts the run (a failed walk, a
// canceled context).
type sweeper struct {
	refs   SweepRefCounter
	store  *ImageStore
	cutoff time.Time

	newest  map[string]time.Time // hash -> newest mtime of its files
	hasBlob map[string]bool      // hashes whose original blob exists
	report  SweepReport
	errs    []error
}

// walk records every blob or thumbnail under dir and removes stale temp
// files. Anything that isn't a well-formed file of ours is left alone.
func (sw *sweeper) walk(ctx context.Context, dir string) error {
	return fs.WalkDir(sw.store.root.FS(), dir, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if p == dir && errors.Is(walkErr, fs.ErrNotExist) {
				return fs.SkipDir // nothing stored yet
			}
			return walkErr
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if d.IsDir() {
			return nil
		}
		info, infoErr := d.Info()
		if errors.Is(infoErr, fs.ErrNotExist) {
			return nil // removed since the directory was listed
		} else if infoErr != nil {
			return infoErr
		}

		sw.visit(dir, p, d.Name(), info.ModTime())
		return nil
	})
}

// visit handles one file found under dir.
func (sw *sweeper) visit(dir, p, name string, mtime time.Time) {
	if strings.HasPrefix(name, tempFilePrefix) {
		sw.removeStaleTemp(p, mtime)
		return
	}
	sha := name
	if dir == "thumb" {
		sha = strings.TrimSuffix(name, ".jpg")
	}
	if canon, err := canonicalSHA(sha); err != nil || canon != sha {
		return // not one of our files
	}
	if dir == "blobs" {
		sw.hasBlob[sha] = true
	}
	if mtime.After(sw.newest[sha]) {
		sw.newest[sha] = mtime
	}
}

func (sw *sweeper) removeStaleTemp(p string, mtime time.Time) {
	if !mtime.Before(sw.cutoff) {
		return
	}
	if err := sw.store.remove(p); err != nil {
		sw.errs = append(sw.errs, fmt.Errorf("remove temp file %s: %w", p, err))
		return
	}
	sw.report.TempFilesRemoved++
}

// reclaimUnreferenced deletes every hash found on disk that no row
// references and whose files are all older than the grace period.
func (sw *sweeper) reclaimUnreferenced(ctx context.Context, referenced map[string]int) error {
	for sha, mtime := range sw.newest {
		if referenced[sha] > 0 || !mtime.Before(sw.cutoff) {
			continue
		}
		// A database with no image rows next to an upload directory full of
		// blobs far more likely means Jot was pointed at the wrong or a
		// freshly created database than that every image was deleted and
		// every reclaim failed. Deleting would destroy the real data, so
		// leave it and let the caller warn.
		if len(referenced) == 0 {
			sw.report.UnreferencedSkipped++
			continue
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		// The walk's mtimes can be minutes old by now: a dedup Put may have
		// touched the blob since, for a row that has not committed yet.
		if fresh, err := sw.touchedSinceCutoff(sha); err != nil {
			sw.errs = append(sw.errs, err)
			continue
		} else if fresh {
			continue
		}
		reclaimed, err := reclaimIfOrphaned(ctx, sw.refs, sw.store, sha)
		if err != nil {
			sw.errs = append(sw.errs, err)
		} else if reclaimed {
			sw.report.Reclaimed++
		}
	}
	return nil
}

// touchedSinceCutoff re-stats sha's original and thumbnail and reports
// whether either was modified at or after the cutoff. A file that no longer
// exists counts as not fresh.
func (sw *sweeper) touchedSinceCutoff(sha string) (bool, error) {
	p, err := relPath(sha)
	if err != nil {
		return false, err
	}
	tp, err := thumbRelPath(sha)
	if err != nil {
		return false, err
	}
	for _, path := range []string{p, tp} {
		info, err := sw.store.root.Stat(path)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		} else if err != nil {
			return false, fmt.Errorf("stat %s: %w", path, err)
		}
		if !info.ModTime().Before(sw.cutoff) {
			return true, nil
		}
	}
	return false, nil
}

// findMissing reports every referenced hash whose original blob is absent.
func (sw *sweeper) findMissing(ctx context.Context, referenced map[string]int) error {
	for sha := range referenced {
		if sw.hasBlob[sha] {
			continue
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		// A blob written after the walk passed its directory is not missing.
		// A malformed hash has no path, so its blob is missing by definition.
		if p, err := relPath(sha); err == nil {
			ok, err := sw.store.exists(p)
			if err != nil {
				sw.errs = append(sw.errs, err)
				continue
			}
			if ok {
				continue
			}
		}
		rows, err := sw.refs.GetNoteImageRefCount(ctx, sha)
		if err != nil {
			sw.errs = append(sw.errs, fmt.Errorf("get note image refcount: %w", err))
			continue
		}
		if rows > 0 {
			sw.report.MissingBlobs = append(sw.report.MissingBlobs, MissingBlob{SHA256: sha, Rows: rows})
		}
	}
	return nil
}
