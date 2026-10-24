package models

import (
	"database/sql"

	"github.com/hanzei/jot/server/internal/database/dialect"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/trace"
)

// Every exported store below wraps its unexported implementation with
// OpenTelemetry spans. The wrapper methods are generated from the
// implementation's method set into stores_otel_gen.go (see
// internal/tools/otelwrap); run `task gen-go` after changing a store method.
//
//go:generate go run ../tools/otelwrap -out stores_otel_gen.go

const tracerName = "github.com/hanzei/jot/server"

// AdminStatsStore wraps adminStatsStore with OpenTelemetry span instrumentation.
type AdminStatsStore struct {
	inner  *adminStatsStore
	tracer trace.Tracer
}

// NewAdminStatsStore creates an instrumented AdminStatsStore.
func NewAdminStatsStore(db *sql.DB, d *dialect.Dialect) *AdminStatsStore {
	return &AdminStatsStore{
		inner:  newAdminStatsStore(db, d),
		tracer: otel.Tracer(tracerName),
	}
}

// LabelStore wraps labelStore with OpenTelemetry span instrumentation.
//
//otelwrap:attr id label.id
//otelwrap:attr labelID label.id
type LabelStore struct {
	inner  *labelStore
	tracer trace.Tracer
}

// NewLabelStore creates an instrumented LabelStore.
func NewLabelStore(db *sql.DB, d *dialect.Dialect) *LabelStore {
	return &LabelStore{
		inner:  newLabelStore(db, d),
		tracer: otel.Tracer(tracerName),
	}
}

// NoteStore wraps noteStore with OpenTelemetry span instrumentation.
//
//otelwrap:attr id note.id
//otelwrap:attr noteID note.id
//otelwrap:attr itemID item.id
//otelwrap:attr imageID image.id
//otelwrap:attr sharedWithUserID shared_with.user.id
type NoteStore struct {
	inner  *noteStore
	tracer trace.Tracer
}

// NewNoteStore creates an instrumented NoteStore.
func NewNoteStore(db *sql.DB, d *dialect.Dialect) *NoteStore {
	return &NoteStore{
		inner:  newNoteStore(db, d),
		tracer: otel.Tracer(tracerName),
	}
}

// PATStore wraps patStore with OpenTelemetry span instrumentation.
type PATStore struct {
	inner  *patStore
	tracer trace.Tracer
}

// NewPATStore creates an instrumented PATStore.
func NewPATStore(db *sql.DB, d *dialect.Dialect) *PATStore {
	return &PATStore{
		inner:  newPATStore(db, d),
		tracer: otel.Tracer(tracerName),
	}
}

// SessionStore wraps sessionStore with OpenTelemetry span instrumentation.
type SessionStore struct {
	inner  *sessionStore
	tracer trace.Tracer
}

// NewSessionStore creates an instrumented SessionStore.
func NewSessionStore(db *sql.DB, d *dialect.Dialect) (*SessionStore, error) {
	inner, err := newSessionStore(db, d)
	if err != nil {
		return nil, err
	}
	return &SessionStore{
		inner:  inner,
		tracer: otel.Tracer(tracerName),
	}, nil
}

// UserStore wraps userStore with OpenTelemetry span instrumentation.
//
//otelwrap:attr id user.id
//otelwrap:attr userID user.id
type UserStore struct {
	inner  *userStore
	tracer trace.Tracer
}

// NewUserStore creates an instrumented UserStore.
func NewUserStore(db *sql.DB, d *dialect.Dialect) *UserStore {
	return &UserStore{
		inner:  newUserStore(db, d),
		tracer: otel.Tracer(tracerName),
	}
}

// UserSettingsStore wraps userSettingsStore with OpenTelemetry span instrumentation.
type UserSettingsStore struct {
	inner  *userSettingsStore
	tracer trace.Tracer
}

// NewUserSettingsStore creates an instrumented UserSettingsStore.
func NewUserSettingsStore(db *sql.DB, d *dialect.Dialect) *UserSettingsStore {
	return &UserSettingsStore{
		inner:  newUserSettingsStore(db, d),
		tracer: otel.Tracer(tracerName),
	}
}
