package models

import (
	"context"
	"database/sql"
	"time"

	"github.com/hanzei/jot/server/internal/database/dialect"
	"go.opentelemetry.io/otel/attribute"
)

// LabelStore wraps labelStore with OpenTelemetry span instrumentation.
type LabelStore struct {
	inner *labelStore
	instr instrumentation
}

// NewLabelStore creates an instrumented LabelStore.
func NewLabelStore(db *sql.DB, d *dialect.Dialect, slowThreshold time.Duration) *LabelStore {
	return &LabelStore{
		inner: newLabelStore(db, d),
		instr: newInstrumentation(slowThreshold),
	}
}

func (s *LabelStore) GetLabels(ctx context.Context, userID string) (_ []Label, err error) {
	ctx, end := startSpan(ctx, s.instr, "LabelStore.GetLabels", &err)
	defer end()
	return s.inner.GetLabels(ctx, userID)
}

func (s *LabelStore) GetLabelCounts(ctx context.Context, userID string) (_ map[string]int, err error) {
	ctx, end := startSpan(ctx, s.instr, "LabelStore.GetLabelCounts", &err)
	defer end()
	return s.inner.GetLabelCounts(ctx, userID)
}

func (s *LabelStore) GetOrCreateLabel(ctx context.Context, userID, name string) (_ *Label, _ bool, err error) {
	ctx, end := startSpan(ctx, s.instr, "LabelStore.GetOrCreateLabel", &err)
	defer end()
	return s.inner.GetOrCreateLabel(ctx, userID, name)
}

func (s *LabelStore) GetLabelByName(ctx context.Context, userID, name string) (_ *Label, err error) {
	ctx, end := startSpan(ctx, s.instr, "LabelStore.GetLabelByName", &err)
	defer end()
	return s.inner.GetLabelByName(ctx, userID, name)
}

func (s *LabelStore) CreateLabel(ctx context.Context, userID, id, name string) (_ *Label, err error) {
	ctx, end := startSpan(ctx, s.instr, "LabelStore.CreateLabel", &err,
		attribute.String("label.id", id),
	)
	defer end()
	return s.inner.CreateLabel(ctx, userID, id, name)
}

func (s *LabelStore) GetLabelNoteIDs(ctx context.Context, labelID, userID string) (_ []string, err error) {
	ctx, end := startSpan(ctx, s.instr, "LabelStore.GetLabelNoteIDs", &err,
		attribute.String("label.id", labelID),
	)
	defer end()
	return s.inner.GetLabelNoteIDs(ctx, labelID, userID)
}

func (s *LabelStore) RenameLabel(ctx context.Context, labelID, userID, newName string) (_ *Label, err error) {
	ctx, end := startSpan(ctx, s.instr, "LabelStore.RenameLabel", &err,
		attribute.String("label.id", labelID),
	)
	defer end()
	return s.inner.RenameLabel(ctx, labelID, userID, newName)
}

func (s *LabelStore) DeleteLabel(ctx context.Context, labelID, userID string) (err error) {
	ctx, end := startSpan(ctx, s.instr, "LabelStore.DeleteLabel", &err,
		attribute.String("label.id", labelID),
	)
	defer end()
	return s.inner.DeleteLabel(ctx, labelID, userID)
}
