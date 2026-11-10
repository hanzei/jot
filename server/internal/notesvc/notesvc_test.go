package notesvc

import (
	"net/http"
	"strings"
	"testing"

	"github.com/hanzei/jot/server/internal/apierr"
	"github.com/hanzei/jot/server/internal/blobstore"
	"github.com/hanzei/jot/server/internal/database/dbtest"
	"github.com/hanzei/jot/server/internal/database/dialect"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/notify"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

const testUserID = "user0000000000000notesvc"

// missingID is a well-formed ID that no row has.
const missingID = "0000000000000000missing"

// newTestService returns a Service on a fresh migrated database for driver,
// with no SSE hub, recording metrics into the returned reader.
func newTestService(t *testing.T, driver string) (*Service, *sdkmetric.ManualReader) {
	t.Helper()

	db := dbtest.New(t, driver)
	d := &dialect.Dialect{Driver: driver}
	_, err := db.ExecContext(t.Context(),
		d.RewritePlaceholders(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`),
		testUserID, "notesvc", "x")
	require.NoError(t, err)

	imageStore, err := blobstore.NewImageStore(t.TempDir())
	require.NoError(t, err)
	t.Cleanup(func() { _ = imageStore.Close() })

	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	t.Cleanup(func() { _ = provider.Shutdown(t.Context()) })

	noteStore := models.NewNoteStore(db, d, 0)
	svc, err := New(noteStore, models.NewLabelStore(db, d, 0), models.NewUserStore(db, d, 0), imageStore, notify.New(nil, noteStore), provider.Meter("test"))
	require.NoError(t, err)
	return svc, reader
}

// requireAPIError asserts that err maps to status and code the way the REST
// handlers map it.
func requireAPIError(t *testing.T, err error, status int, code apierr.Code) {
	t.Helper()
	require.Error(t, err)
	got, ok := apierr.SentinelStatus(err)
	require.True(t, ok, "no status for %v", err)
	assert.Equal(t, status, got)
	assert.Equal(t, code, apierr.CodeFor(got, err))
}

// counterValue returns the current total of the counter called name, 0 if it
// has not been recorded yet.
func counterValue(t *testing.T, reader *sdkmetric.ManualReader, name string) int64 {
	t.Helper()
	var rm metricdata.ResourceMetrics
	require.NoError(t, reader.Collect(t.Context(), &rm))
	var total int64
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name != name {
				continue
			}
			sum, ok := m.Data.(metricdata.Sum[int64])
			require.True(t, ok, "%s is not an int64 sum", name)
			for _, dp := range sum.DataPoints {
				total += dp.Value
			}
		}
	}
	return total
}

func TestBuildItems(t *testing.T) {
	t.Parallel()
	keptID, err := models.GenerateID()
	require.NoError(t, err)

	built, err := buildItems([]NewItem{
		{Text: "child", Position: 2, IndentLevel: 1},
		{Text: "parent", Position: 1},
		{Text: "orphan child", Position: 0, IndentLevel: 1},
		{ID: keptID, Text: "second parent", Position: 3},
		{Text: "second child", Position: 4, IndentLevel: 1},
		{Text: "plain", Position: 5},
	})
	require.NoError(t, err)
	require.Len(t, built, 6)

	texts := make([]string, len(built))
	for i, item := range built {
		texts[i] = item.Text
	}
	assert.Equal(t, []string{"orphan child", "parent", "child", "second parent", "second child", "plain"}, texts, "sorted by position")

	assert.Empty(t, built[0].ParentID, "an indented item with no top-level item before it stays top-level")
	assert.NotEmpty(t, built[1].ID, "a parent gets an ID for its children to reference")
	assert.Equal(t, built[1].ID, built[2].ParentID)
	assert.Equal(t, keptID, built[3].ID)
	assert.Equal(t, keptID, built[4].ParentID)
	// The store generates the rest, without the collision check it runs on a
	// supplied ID.
	for _, i := range []int{0, 2, 4, 5} {
		assert.Empty(t, built[i].ID, built[i].Text)
	}
}

// TestServiceMetrics pins the counters every write records. Both the REST
// handlers and the MCP tools go through these methods, so neither surface can
// skip them.
func TestServiceMetrics(t *testing.T) {
	t.Parallel()
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		svc, reader := newTestService(t, driver)
		ctx := t.Context()

		note, err := svc.Create(ctx, testUserID, NewNote{Content: "a"})
		require.NoError(t, err)
		_, err = svc.Duplicate(ctx, note.ID, testUserID, "", nil)
		require.NoError(t, err)
		assert.Equal(t, int64(2), counterValue(t, reader, "notes.created"))

		content := "b"
		_, err = svc.Update(ctx, note.ID, testUserID, models.NoteUpdate{Content: &content})
		require.NoError(t, err)
		_, err = svc.Convert(ctx, note.ID, testUserID, Conversion{Type: models.NoteTypeList})
		require.NoError(t, err)
		assert.Equal(t, int64(2), counterValue(t, reader, "notes.updated"))

		require.NoError(t, svc.Delete(ctx, note.ID, testUserID, false))
		_, err = svc.Restore(ctx, note.ID, testUserID)
		require.NoError(t, err)
		assert.Equal(t, int64(1), counterValue(t, reader, "notes.restored"))

		require.NoError(t, svc.Delete(ctx, note.ID, testUserID, false))
		require.NoError(t, svc.Delete(ctx, note.ID, testUserID, true))
		assert.Equal(t, int64(3), counterValue(t, reader, "notes.deleted"), "both moves to trash and the permanent delete")

		for range 2 {
			trashed, createErr := svc.Create(ctx, testUserID, NewNote{})
			require.NoError(t, createErr)
			require.NoError(t, svc.Delete(ctx, trashed.ID, testUserID, false))
		}
		deleted, err := svc.EmptyTrash(ctx, testUserID)
		require.NoError(t, err)
		assert.Equal(t, 2, deleted)
		assert.Equal(t, int64(3+2+2), counterValue(t, reader, "notes.deleted"), "emptying the trash counts each note again, as before")
	})
}

// TestServiceErrors pins the error contract the transports rely on: invalid
// input maps to 400, caps to 422 with item_limit_reached, and nothing is
// written or counted for a rejected call.
func TestServiceErrors(t *testing.T) {
	t.Parallel()
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		svc, reader := newTestService(t, driver)
		ctx := t.Context()

		tooManyItems := make([]NewItem, models.NoteItemsMaxCount+1)
		for _, tc := range []struct {
			name   string
			in     NewNote
			status int
			code   apierr.Code
		}{
			{"title too long", NewNote{Type: models.NoteTypeList, Title: strings.Repeat("a", models.NoteTitleMaxLength+1)}, http.StatusBadRequest, apierr.CodeValidationFailed},
			{"bad color", NewNote{Color: "red"}, http.StatusBadRequest, apierr.CodeValidationFailed},
			{"items on a text note", NewNote{Type: models.NoteTypeText, Items: []NewItem{{Text: "x"}}}, http.StatusBadRequest, apierr.CodeValidationFailed},
			{"title on a text note", NewNote{Title: "t"}, http.StatusBadRequest, apierr.CodeValidationFailed},
			{"bad note ID", NewNote{ID: "nope"}, http.StatusBadRequest, apierr.CodeValidationFailed},
			{"bad item ID", NewNote{Items: []NewItem{{ID: "nope", Text: "x"}}}, http.StatusBadRequest, apierr.CodeValidationFailed},
			{"too many items", NewNote{Items: tooManyItems}, http.StatusUnprocessableEntity, apierr.CodeItemLimitReached},
			{"label name too long", NewNote{Labels: []string{strings.Repeat("a", models.LabelNameMaxLength+1)}}, http.StatusUnprocessableEntity, apierr.CodeLabelNameTooLong},
		} {
			t.Run(tc.name, func(t *testing.T) {
				_, err := svc.Create(ctx, testUserID, tc.in)
				requireAPIError(t, err, tc.status, tc.code)
			})
		}

		notes, err := svc.noteStore.GetByUserID(ctx, testUserID, models.NoteFilter{})
		require.NoError(t, err)
		assert.Empty(t, notes)
		assert.Zero(t, counterValue(t, reader, "notes.created"))

		content := "x"
		_, err = svc.Update(ctx, missingID, testUserID, models.NoteUpdate{Content: &content})
		require.ErrorIs(t, err, models.ErrNoteNotFound)
		assert.Zero(t, counterValue(t, reader, "notes.updated"))
	})
}
