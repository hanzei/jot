package models

import (
	"context"
	"database/sql"
	"time"

	"github.com/hanzei/jot/server/internal/database/dialect"
)

// PATStore wraps patStore with OpenTelemetry span instrumentation.
type PATStore struct {
	inner *patStore
	instr instrumentation
}

// NewPATStore creates an instrumented PATStore.
func NewPATStore(db *sql.DB, d *dialect.Dialect, slowThreshold time.Duration) *PATStore {
	return &PATStore{
		inner: newPATStore(db, d),
		instr: newInstrumentation(slowThreshold),
	}
}

func (s *PATStore) Create(ctx context.Context, userID, name string) (_ *PersonalAccessToken, _ string, err error) {
	ctx, end := startSpan(ctx, s.instr, "PATStore.Create", &err)
	defer end()
	return s.inner.Create(ctx, userID, name)
}

func (s *PATStore) GetByUserID(ctx context.Context, userID string) (_ []*PersonalAccessToken, err error) {
	ctx, end := startSpan(ctx, s.instr, "PATStore.GetByUserID", &err)
	defer end()
	return s.inner.GetByUserID(ctx, userID)
}

func (s *PATStore) GetByTokenHash(ctx context.Context, rawToken string) (_ *PersonalAccessToken, err error) {
	ctx, end := startSpan(ctx, s.instr, "PATStore.GetByTokenHash", &err)
	defer end()
	return s.inner.GetByTokenHash(ctx, rawToken)
}

func (s *PATStore) Delete(ctx context.Context, id, userID string) (_ bool, err error) {
	ctx, end := startSpan(ctx, s.instr, "PATStore.Delete", &err)
	defer end()
	return s.inner.Delete(ctx, id, userID)
}
