package models

import (
	"context"
	"database/sql"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/trace"
)

// AdminStatsStore wraps adminStatsStore with OpenTelemetry span instrumentation.
type AdminStatsStore struct {
	inner  *adminStatsStore
	tracer trace.Tracer
}

// NewAdminStatsStore creates an instrumented AdminStatsStore.
func NewAdminStatsStore(db *sql.DB) *AdminStatsStore {
	return &AdminStatsStore{
		inner:  newAdminStatsStore(db),
		tracer: otel.Tracer("github.com/hanzei/jot/server"),
	}
}

func (s *AdminStatsStore) GetStats(ctx context.Context) (_ *AdminStats, err error) {
	ctx, end := startSpan(ctx, s.tracer, "AdminStatsStore.GetStats", &err)
	defer end()
	return s.inner.GetStats(ctx)
}
