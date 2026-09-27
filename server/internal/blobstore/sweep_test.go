package blobstore

import (
	"context"
	"io/fs"
	"maps"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const testGrace = time.Hour

// fakeSweepRefs is a SweepRefCounter whose bulk snapshot (bulk) can differ
// from the live per-hash counts (live), to simulate rows committed or deleted
// between the sweep's snapshot and its re-check.
type fakeSweepRefs struct {
	bulk map[string]int
	live map[string]int
}

func (f *fakeSweepRefs) GetNoteImageRefCounts(context.Context) (map[string]int, error) {
	return maps.Clone(f.bulk), nil
}

func (f *fakeSweepRefs) GetNoteImageRefCount(_ context.Context, sha string) (int, error) {
	return f.live[sha], nil
}

// refs returns a fakeSweepRefs whose snapshot and live counts agree.
func refs(counts map[string]int) *fakeSweepRefs {
	return &fakeSweepRefs{bulk: counts, live: counts}
}

// putAged stores content as a blob with a thumbnail and backdates both past
// the sweep's grace period.
func putAged(t *testing.T, store *ImageStore, content string) string {
	t.Helper()
	ctx := t.Context()
	sha := shaOf(content)
	require.NoError(t, store.Put(ctx, sha, strings.NewReader(content)))
	require.NoError(t, store.PutThumbnail(ctx, sha, strings.NewReader("thumb of "+content)))
	p, err := relPath(sha)
	require.NoError(t, err)
	age(t, store, p)
	tp, err := thumbRelPath(sha)
	require.NoError(t, err)
	age(t, store, tp)
	return sha
}

func age(t *testing.T, store *ImageStore, p string) {
	t.Helper()
	old := time.Now().Add(-2 * testGrace)
	require.NoError(t, store.root.Chtimes(p, old, old))
}

func assertBlobGone(t *testing.T, store *ImageStore, sha string) {
	t.Helper()
	_, err := store.Open(t.Context(), sha)
	require.ErrorIs(t, err, ErrNotFound)
	_, err = store.OpenThumbnail(t.Context(), sha)
	require.ErrorIs(t, err, ErrNotFound)
}

func assertBlobPresent(t *testing.T, store *ImageStore, sha string) {
	t.Helper()
	rc, err := store.Open(t.Context(), sha)
	require.NoError(t, err)
	_ = rc.Close()
}

// otherRef stands in for an unrelated referenced image, so the sweep does
// not take the empty-database guard.
var otherRef = map[string]int{shaOf("some other image"): 1}

func TestSweepReclaimsUnreferencedBlobAndThumbnail(t *testing.T) {
	store := newTestImageStore(t)
	sha := putAged(t, store, "orphan")
	require.NoError(t, store.Put(t.Context(), shaOf("some other image"), strings.NewReader("some other image")))

	report, err := Sweep(t.Context(), refs(otherRef), store, testGrace)
	require.NoError(t, err)

	assertBlobGone(t, store, sha)
	assert.Equal(t, 2, report.BlobsScanned)
	assert.Equal(t, 1, report.Reclaimed)
}

func TestSweepDeletesNothingWhenDatabaseReferencesNoImages(t *testing.T) {
	// Jot started against the wrong or an empty database: keep the blobs.
	store := newTestImageStore(t)
	sha := putAged(t, store, "real data")

	report, err := Sweep(t.Context(), refs(map[string]int{}), store, testGrace)
	require.NoError(t, err)

	assertBlobPresent(t, store, sha)
	assert.Zero(t, report.Reclaimed)
	assert.Equal(t, 1, report.UnreferencedSkipped)
}

func TestSweepLeavesReferencedBlob(t *testing.T) {
	store := newTestImageStore(t)
	sha := putAged(t, store, "referenced")

	report, err := Sweep(t.Context(), refs(map[string]int{sha: 1}), store, testGrace)
	require.NoError(t, err)

	assertBlobPresent(t, store, sha)
	assert.Zero(t, report.Reclaimed)
}

func TestSweepLeavesBlobYoungerThanGrace(t *testing.T) {
	// An upload whose blob is written but whose row has not committed yet.
	store := newTestImageStore(t)
	sha := shaOf("in flight")
	require.NoError(t, store.Put(t.Context(), sha, strings.NewReader("in flight")))

	report, err := Sweep(t.Context(), refs(otherRef), store, testGrace)
	require.NoError(t, err)

	assertBlobPresent(t, store, sha)
	assert.Zero(t, report.Reclaimed)
}

func TestSweepLeavesOrphanReusedByDedupPut(t *testing.T) {
	// A long-orphaned blob that a new upload just deduped against: Put must
	// refresh its mtime so the sweep treats it as in flight.
	store := newTestImageStore(t)
	sha := putAged(t, store, "reused")
	require.NoError(t, store.Put(t.Context(), sha, strings.NewReader("reused")))

	report, err := Sweep(t.Context(), refs(otherRef), store, testGrace)
	require.NoError(t, err)

	assertBlobPresent(t, store, sha)
	assert.Zero(t, report.Reclaimed)
}

func TestSweepRechecksRefCountBeforeDeleting(t *testing.T) {
	// A row that committed after the sweep took its snapshot.
	store := newTestImageStore(t)
	sha := putAged(t, store, "late row")

	report, err := Sweep(t.Context(), &fakeSweepRefs{bulk: otherRef, live: map[string]int{sha: 1}}, store, testGrace)
	require.NoError(t, err)

	assertBlobPresent(t, store, sha)
	assert.Zero(t, report.Reclaimed)
}

func TestSweepReclaimsThumbnailWithoutOriginal(t *testing.T) {
	store := newTestImageStore(t)
	sha := shaOf("thumb only")
	require.NoError(t, store.PutThumbnail(t.Context(), sha, strings.NewReader("thumb")))
	tp, err := thumbRelPath(sha)
	require.NoError(t, err)
	age(t, store, tp)

	report, err := Sweep(t.Context(), refs(otherRef), store, testGrace)
	require.NoError(t, err)

	assertBlobGone(t, store, sha)
	assert.Equal(t, 1, report.Reclaimed)
}

func TestSweepReportsReferencedBlobMissingOnDisk(t *testing.T) {
	store := newTestImageStore(t)
	present := putAged(t, store, "present")
	missing := shaOf("missing")

	report, err := Sweep(t.Context(), refs(map[string]int{present: 1, missing: 3}), store, testGrace)
	require.NoError(t, err)

	assert.Equal(t, []MissingBlob{{SHA256: missing, Rows: 3}}, report.MissingBlobs)
}

func TestSweepDoesNotReportMissingBlobWhoseRowsWereDeleted(t *testing.T) {
	// Rows deleted (and their blob reclaimed) after the snapshot.
	store := newTestImageStore(t)
	missing := shaOf("deleted meanwhile")

	report, err := Sweep(t.Context(), &fakeSweepRefs{bulk: map[string]int{missing: 1}, live: map[string]int{}}, store, testGrace)
	require.NoError(t, err)

	assert.Empty(t, report.MissingBlobs)
}

func TestSweepReportsMalformedReferencedHashAsMissing(t *testing.T) {
	store := newTestImageStore(t)

	report, err := Sweep(t.Context(), refs(map[string]int{"not-a-hash": 1}), store, testGrace)
	require.NoError(t, err)

	assert.Equal(t, []MissingBlob{{SHA256: "not-a-hash", Rows: 1}}, report.MissingBlobs)
}

func TestSweepRemovesStaleTempFilesOnly(t *testing.T) {
	store := newTestImageStore(t)
	require.NoError(t, store.root.MkdirAll("blobs/ab/cd", 0o750))
	require.NoError(t, store.root.WriteFile("blobs/ab/cd/"+tempFilePrefix+"stale", []byte("x"), 0o640))
	age(t, store, "blobs/ab/cd/"+tempFilePrefix+"stale")
	require.NoError(t, store.root.WriteFile("blobs/ab/cd/"+tempFilePrefix+"fresh", []byte("x"), 0o640))

	report, err := Sweep(t.Context(), refs(map[string]int{}), store, testGrace)
	require.NoError(t, err)

	assert.Equal(t, 1, report.TempFilesRemoved)
	_, err = store.root.Stat("blobs/ab/cd/" + tempFilePrefix + "stale")
	require.ErrorIs(t, err, fs.ErrNotExist)
	_, err = store.root.Stat("blobs/ab/cd/" + tempFilePrefix + "fresh")
	require.NoError(t, err)
}

func TestSweepIgnoresUnrecognizedFiles(t *testing.T) {
	store := newTestImageStore(t)
	require.NoError(t, store.root.MkdirAll("blobs/ab/cd", 0o750))
	require.NoError(t, store.root.WriteFile("blobs/ab/cd/README", []byte("x"), 0o640))
	age(t, store, "blobs/ab/cd/README")

	report, err := Sweep(t.Context(), refs(map[string]int{}), store, testGrace)
	require.NoError(t, err)

	assert.Zero(t, report.BlobsScanned)
	_, err = store.root.Stat("blobs/ab/cd/README")
	require.NoError(t, err)
}

func TestSweepOnEmptyStore(t *testing.T) {
	report, err := Sweep(t.Context(), refs(map[string]int{}), newTestImageStore(t), testGrace)
	require.NoError(t, err)
	assert.Equal(t, SweepReport{}, report)
}
