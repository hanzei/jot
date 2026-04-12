package models

import (
	"context"
	"database/sql"

	"github.com/hanzei/jot/server/internal/database/dialect"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// LabelStore wraps labelStore with OpenTelemetry span instrumentation.
type LabelStore struct {
	inner  *labelStore
	tracer trace.Tracer
}

// NewLabelStore creates an instrumented LabelStore.
func NewLabelStore(db *sql.DB, d *dialect.Dialect) *LabelStore {
	return &LabelStore{
		inner:  newLabelStore(db, d),
		tracer: otel.Tracer("github.com/hanzei/jot/server"),
	}
}

func (s *LabelStore) GetLabels(ctx context.Context, userID string) (_ []Label, err error) {
	ctx, end := startSpan(ctx, s.tracer, "LabelStore.GetLabels", &err)
	defer end()
	return s.inner.GetLabels(ctx, userID)
}

func (s *LabelStore) GetLabelCounts(ctx context.Context, userID string) (_ map[string]int, err error) {
	ctx, end := startSpan(ctx, s.tracer, "LabelStore.GetLabelCounts", &err)
	defer end()
	return s.inner.GetLabelCounts(ctx, userID)
}

func (s *LabelStore) GetOrCreateLabel(ctx context.Context, userID, name string) (_ *Label, err error) {
	ctx, end := startSpan(ctx, s.tracer, "LabelStore.GetOrCreateLabel", &err)
	defer end()
	return s.inner.GetOrCreateLabel(ctx, userID, name)
}

func (s *LabelStore) GetLabelNoteIDs(ctx context.Context, labelID, userID string) (_ []string, err error) {
	ctx, end := startSpan(ctx, s.tracer, "LabelStore.GetLabelNoteIDs", &err,
		attribute.String("label.id", labelID),
	)
	defer end()
	return s.inner.GetLabelNoteIDs(ctx, labelID, userID)
}

func (s *LabelStore) RenameLabel(ctx context.Context, labelID, userID, newName string) (_ *Label, err error) {
	ctx, end := startSpan(ctx, s.tracer, "LabelStore.RenameLabel", &err,
		attribute.String("label.id", labelID),
	)
	defer end()
	return s.inner.RenameLabel(ctx, labelID, userID, newName)
}

func (s *LabelStore) DeleteLabel(ctx context.Context, labelID, userID string) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "LabelStore.DeleteLabel", &err,
		attribute.String("label.id", labelID),
	)
	defer end()
	return s.inner.DeleteLabel(ctx, labelID, userID)
}
