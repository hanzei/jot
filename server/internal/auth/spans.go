package auth

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// startSpan starts a new child span, sets any provided attributes, and returns
// an updated context and a deferred-safe end function that records any non-nil
// error and ends the span.
func startSpan(ctx context.Context, tracer trace.Tracer, name string, err *error, attrs ...attribute.KeyValue) (context.Context, func()) {
	ctx, span := tracer.Start(ctx, name, trace.WithAttributes(attrs...))
	return ctx, func() {
		if err != nil && *err != nil {
			span.RecordError(*err)
			span.SetStatus(codes.Error, (*err).Error())
		} else {
			span.SetStatus(codes.Ok, "")
		}
		span.End()
	}
}
