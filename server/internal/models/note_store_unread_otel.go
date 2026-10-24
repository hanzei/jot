package models

import (
	"context"
	"time"

	"go.opentelemetry.io/otel/attribute"
)

func (s *NoteStore) MarkViewed(ctx context.Context, noteID, userID string, viewedAt time.Time) (_ bool, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.MarkViewed", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.MarkViewed(ctx, noteID, userID, viewedAt)
}
