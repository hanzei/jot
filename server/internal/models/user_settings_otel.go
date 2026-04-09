package models

import (
	"context"
	"database/sql"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/trace"
)

// UserSettingsStore wraps userSettingsStore with OpenTelemetry span instrumentation.
type UserSettingsStore struct {
	inner  *userSettingsStore
	tracer trace.Tracer
}

// NewUserSettingsStore creates an instrumented UserSettingsStore.
func NewUserSettingsStore(db *sql.DB) *UserSettingsStore {
	return &UserSettingsStore{
		inner:  newUserSettingsStore(db),
		tracer: otel.Tracer("github.com/hanzei/jot/server"),
	}
}

func (s *UserSettingsStore) GetOrCreate(ctx context.Context, userID string) (_ *UserSettings, err error) {
	ctx, end := startSpan(ctx, s.tracer, "UserSettingsStore.GetOrCreate", &err)
	defer end()
	return s.inner.GetOrCreate(ctx, userID)
}

func (s *UserSettingsStore) Update(ctx context.Context, userID, language, theme, noteSort string) (_ *UserSettings, err error) {
	ctx, end := startSpan(ctx, s.tracer, "UserSettingsStore.Update", &err)
	defer end()
	return s.inner.Update(ctx, userID, language, theme, noteSort)
}
