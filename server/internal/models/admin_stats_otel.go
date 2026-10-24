package models

import (
	"context"
	"database/sql"
	"time"

	"github.com/hanzei/jot/server/internal/database/dialect"
)

// AdminStatsStore wraps adminStatsStore with OpenTelemetry span instrumentation.
type AdminStatsStore struct {
	inner *adminStatsStore
	instr instrumentation
}

// NewAdminStatsStore creates an instrumented AdminStatsStore.
func NewAdminStatsStore(db *sql.DB, d *dialect.Dialect, slowThreshold time.Duration) *AdminStatsStore {
	return &AdminStatsStore{
		inner: newAdminStatsStore(db, d),
		instr: newInstrumentation(slowThreshold),
	}
}

func (s *AdminStatsStore) GetStats(ctx context.Context) (_ *AdminStats, err error) {
	ctx, end := startSpan(ctx, s.instr, "AdminStatsStore.GetStats", &err)
	defer end()
	return s.inner.GetStats(ctx)
}
