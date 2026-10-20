package models

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
)

func (s *NoteStore) RecordContentChange(ctx context.Context, noteID, actorID string) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.RecordContentChange", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.RecordContentChange(ctx, noteID, actorID)
}

func (s *NoteStore) MarkViewed(ctx context.Context, noteID, userID string) (_ bool, err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.MarkViewed", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.MarkViewed(ctx, noteID, userID)
}
