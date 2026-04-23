package models

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/hanzei/jot/server/internal/database/dialect"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/trace"
)

// PATStore wraps patStore with OpenTelemetry span instrumentation.
type PATStore struct {
	inner  *patStore
	tracer trace.Tracer
}

// NewPATStore creates an instrumented PATStore.
func NewPATStore(db *sql.DB, d *dialect.Dialect) (*PATStore, error) {
	inner, err := newPATStore(db, d)
	if err != nil {
		return nil, fmt.Errorf("initialize personal access token store: %w", err)
	}
	return &PATStore{
		inner:  inner,
		tracer: otel.Tracer("github.com/hanzei/jot/server"),
	}, nil
}

func (s *PATStore) Create(ctx context.Context, userID, name string, expiresAt *time.Time) (_ *PersonalAccessToken, _ string, err error) {
	ctx, end := startSpan(ctx, s.tracer, "PATStore.Create", &err)
	defer end()
	return s.inner.Create(ctx, userID, name, expiresAt)
}

func (s *PATStore) GetByUserID(ctx context.Context, userID string) (_ []*PersonalAccessToken, err error) {
	ctx, end := startSpan(ctx, s.tracer, "PATStore.GetByUserID", &err)
	defer end()
	return s.inner.GetByUserID(ctx, userID)
}

func (s *PATStore) GetByTokenHash(ctx context.Context, rawToken string) (_ *PersonalAccessToken, err error) {
	ctx, end := startSpan(ctx, s.tracer, "PATStore.GetByTokenHash", &err)
	defer end()
	return s.inner.GetByTokenHash(ctx, rawToken)
}

func (s *PATStore) Delete(ctx context.Context, id, userID string) (_ bool, err error) {
	ctx, end := startSpan(ctx, s.tracer, "PATStore.Delete", &err)
	defer end()
	return s.inner.Delete(ctx, id, userID)
}

func (s *PATStore) DeleteExpired(ctx context.Context) (_ int64, err error) {
	ctx, end := startSpan(ctx, s.tracer, "PATStore.DeleteExpired", &err)
	defer end()
	return s.inner.DeleteExpired(ctx)
}
