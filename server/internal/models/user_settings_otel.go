package models

import (
	"context"
	"database/sql"
	"time"

	"github.com/hanzei/jot/server/internal/database/dialect"
)

// UserSettingsStore wraps userSettingsStore with OpenTelemetry span instrumentation.
type UserSettingsStore struct {
	inner *userSettingsStore
	instr instrumentation
}

// NewUserSettingsStore creates an instrumented UserSettingsStore.
func NewUserSettingsStore(db *sql.DB, d *dialect.Dialect, slowThreshold time.Duration) *UserSettingsStore {
	return &UserSettingsStore{
		inner: newUserSettingsStore(db, d),
		instr: newInstrumentation(slowThreshold),
	}
}

func (s *UserSettingsStore) GetOrCreate(ctx context.Context, userID string) (_ *UserSettings, err error) {
	ctx, end := startSpan(ctx, s.instr, "UserSettingsStore.GetOrCreate", &err)
	defer end()
	return s.inner.GetOrCreate(ctx, userID)
}

func (s *UserSettingsStore) Update(ctx context.Context, userID, language, theme, noteSort string) (_ *UserSettings, err error) {
	ctx, end := startSpan(ctx, s.instr, "UserSettingsStore.Update", &err)
	defer end()
	return s.inner.Update(ctx, userID, language, theme, noteSort)
}
