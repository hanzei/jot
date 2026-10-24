package models

import (
	"context"
	"errors"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// expectedErrors are outcomes a store reports as part of normal operation — a
// missing or foreign row, a conflict, a refused change, a cap — which handlers
// turn into a 4xx response. startSpan records them as the error.expected
// attribute on an Ok span instead of failing the span, so routine 404s and
// 409s don't show up as failed spans.
var expectedErrors = []error{
	ErrLabelNotFoundOrNotOwned,
	ErrLabelNameConflict,
	ErrLabelIDConflict,
	ErrLabelNameTooLong,
	ErrNoteNoAccess,
	ErrNoteNotFound,
	ErrNoteNotOwnedByUser,
	ErrNoteNotInTrash,
	ErrNoteShareNotFound,
	ErrNoteAlreadyShared,
	ErrNoteExists,
	ErrNoteVersionConflict,
	ErrNoteItemNotFound,
	ErrNoteItemExists,
	ErrNoteItemCapExceeded,
	ErrInvalidParentRef,
	ErrNoteImageNotFound,
	ErrNoteImageCapExceeded,
	ErrNoteTypeUnchanged,
	ErrPATNotFound,
	ErrSessionNotFoundOrExpired,
	ErrUsernameTaken,
	ErrUserNotFound,
	ErrLastAdmin,
	ErrCannotDeleteSelf,
	ErrOIDCIdentityLinked,
	ErrWouldStrandAccount,
}

func isExpectedError(err error) bool {
	for _, target := range expectedErrors {
		if errors.Is(err, target) {
			return true
		}
	}
	return false
}

// startSpan starts a new child span, sets any provided attributes, and returns
// an updated context and a deferred-safe end function that records any non-nil
// error and ends the span. An error in expectedErrors leaves the span Ok.
//
// The store wrappers that call it are generated; see stores_otel.go.
//
// Usage:
//
//	func (s *FooStore) Bar(ctx context.Context, id string) (_ T, err error) {
//	    ctx, end := startSpan(ctx, s.tracer, "FooStore.Bar", &err,
//	        attribute.String("foo.id", id),
//	    )
//	    defer end()
//	    ...
//	}
func startSpan(ctx context.Context, tracer trace.Tracer, name string, err *error, attrs ...attribute.KeyValue) (context.Context, func()) {
	ctx, span := tracer.Start(ctx, name, trace.WithAttributes(attrs...))
	return ctx, func() {
		switch {
		case err == nil || *err == nil:
			span.SetStatus(codes.Ok, "")
		case isExpectedError(*err):
			span.SetAttributes(attribute.String("error.expected", (*err).Error()))
			span.SetStatus(codes.Ok, "")
		default:
			span.RecordError(*err)
			span.SetStatus(codes.Error, (*err).Error())
		}
		span.End()
	}
}
