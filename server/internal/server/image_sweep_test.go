package server

import (
	"fmt"
	"io"
	"testing"

	"github.com/hanzei/jot/server/internal/blobstore"
	"github.com/sirupsen/logrus"
	"github.com/sirupsen/logrus/hooks/test"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newCapturingLogger() (*logrus.Logger, *test.Hook) {
	log := logrus.New()
	log.SetOutput(io.Discard)
	return log, test.NewLocal(log)
}

func TestLogImageSweepReportQuietRunLogsNothing(t *testing.T) {
	t.Parallel()
	log, hook := newCapturingLogger()

	logImageSweepReport(log, blobstore.SweepReport{BlobsScanned: 5})

	assert.Empty(t, hook.AllEntries())
}

func TestLogImageSweepReportLogsReclaimed(t *testing.T) {
	t.Parallel()
	log, hook := newCapturingLogger()

	logImageSweepReport(log, blobstore.SweepReport{BlobsScanned: 5, Reclaimed: 2, TempFilesRemoved: 1})

	require.Len(t, hook.AllEntries(), 1)
	entry := hook.LastEntry()
	assert.Equal(t, logrus.InfoLevel, entry.Level)
	assert.Equal(t, 2, entry.Data["reclaimed"])
	assert.Equal(t, 1, entry.Data["temp_files_removed"])
}

func TestLogImageSweepReportWarnsAboutMissingBlobs(t *testing.T) {
	t.Parallel()
	log, hook := newCapturingLogger()

	logImageSweepReport(log, blobstore.SweepReport{MissingBlobs: []blobstore.MissingBlob{
		{SHA256: "aaa", Rows: 2},
		{SHA256: "bbb", Rows: 1},
	}})

	entries := hook.AllEntries()
	require.Len(t, entries, 3)
	for _, e := range entries {
		assert.Equal(t, logrus.WarnLevel, e.Level)
	}
	assert.Equal(t, "aaa", entries[0].Data["sha256"])
	assert.Equal(t, 2, entries[0].Data["rows"])
	assert.Equal(t, "bbb", entries[1].Data["sha256"])
	assert.Equal(t, 2, entries[2].Data["missing_blobs"])
	assert.Equal(t, 3, entries[2].Data["affected_rows"])
}

func TestLogImageSweepReportCapsPerBlobLines(t *testing.T) {
	t.Parallel()
	log, hook := newCapturingLogger()

	missing := make([]blobstore.MissingBlob, maxLoggedMissingBlobs+10)
	for i := range missing {
		missing[i] = blobstore.MissingBlob{SHA256: fmt.Sprintf("sha%d", i), Rows: 1}
	}
	logImageSweepReport(log, blobstore.SweepReport{MissingBlobs: missing})

	entries := hook.AllEntries()
	require.Len(t, entries, maxLoggedMissingBlobs+1)
	summary := entries[len(entries)-1]
	assert.Equal(t, len(missing), summary.Data["missing_blobs"])
	assert.Equal(t, len(missing), summary.Data["affected_rows"])
}

func TestLogImageSweepReportWarnsAboutSkippedUnreferenced(t *testing.T) {
	t.Parallel()
	log, hook := newCapturingLogger()

	logImageSweepReport(log, blobstore.SweepReport{UnreferencedSkipped: 4})

	require.Len(t, hook.AllEntries(), 1)
	entry := hook.LastEntry()
	assert.Equal(t, logrus.WarnLevel, entry.Level)
	assert.Equal(t, 4, entry.Data["unreferenced"])
}
