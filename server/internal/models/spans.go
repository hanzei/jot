package models

import (
	"context"

	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// startSpan starts a new child span and returns an updated context and a
// deferred-safe end function that records any non-nil error and ends the span.
//
// Usage:
//
//	func (s *FooStore) Bar(ctx context.Context, ...) (_ T, err error) {
//	    ctx, end := startSpan(ctx, s.tracer, "FooStore.Bar", &err)
//	    defer end()
//	    ...
//	}
func startSpan(ctx context.Context, tracer trace.Tracer, name string, err *error) (context.Context, func()) {
	ctx, span := tracer.Start(ctx, name)
	return ctx, func() {
		if err != nil && *err != nil {
			span.RecordError(*err)
			span.SetStatus(codes.Error, (*err).Error())
		}
		span.End()
	}
}
