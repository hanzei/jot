package models

import (
	"context"
	"time"

	"github.com/hanzei/jot/server/internal/logutil"
	"github.com/sirupsen/logrus"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// instrumentation is what each exported store wrapper times its operations
// with: a span, and a warning for any operation slower than slowThreshold.
type instrumentation struct {
	tracer trace.Tracer
	// slowThreshold is JOT_SLOW_QUERY_THRESHOLD; 0 disables the warning.
	slowThreshold time.Duration
}

func newInstrumentation(slowThreshold time.Duration) instrumentation {
	return instrumentation{
		tracer:        otel.Tracer("github.com/hanzei/jot/server"),
		slowThreshold: slowThreshold,
	}
}

// startSpan starts a new child span, sets any provided attributes, and returns
// an updated context and a deferred-safe end function that records any non-nil
// error and ends the span.
//
// The end function also logs a warning through the context's logger, so it
// carries request_id, when the operation took longer than the slow threshold.
// That works with tracing off, which is the default: on SQLite's single
// connection one slow operation stalls every request behind it, and this line
// names the one that held the connection. It logs the operation name only,
// never attrs or arguments, which can carry note content.
//
// Usage:
//
//	func (s *FooStore) Bar(ctx context.Context, id string) (_ T, err error) {
//	    ctx, end := startSpan(ctx, s.instr, "FooStore.Bar", &err,
//	        attribute.String("foo.id", id),
//	    )
//	    defer end()
//	    ...
//	}
func startSpan(ctx context.Context, instr instrumentation, name string, err *error, attrs ...attribute.KeyValue) (context.Context, func()) {
	start := time.Now() //nolint:gocritic // elapsed operation time, never persisted; a duration has no time zone
	ctx, span := instr.tracer.Start(ctx, name, trace.WithAttributes(attrs...))
	return ctx, func() {
		if err != nil && *err != nil {
			span.RecordError(*err)
			span.SetStatus(codes.Error, (*err).Error())
		} else {
			span.SetStatus(codes.Ok, "")
		}
		span.End()

		if instr.slowThreshold > 0 {
			if elapsed := time.Since(start); elapsed > instr.slowThreshold {
				logutil.FromContext(ctx).WithFields(logrus.Fields{
					"op":       name,
					"duration": elapsed.String(),
				}).Warn("Slow store operation")
			}
		}
	}
}
