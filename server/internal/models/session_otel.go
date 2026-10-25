package models

import (
	"context"
	"database/sql"
	"time"

	"github.com/hanzei/jot/server/internal/database/dialect"
)

// SessionStore wraps sessionStore with OpenTelemetry span instrumentation.
type SessionStore struct {
	inner *sessionStore
	instr instrumentation
}

// NewSessionStore creates an instrumented SessionStore.
func NewSessionStore(db *sql.DB, d *dialect.Dialect, slowThreshold time.Duration) (*SessionStore, error) {
	inner, err := newSessionStore(db, d)
	if err != nil {
		return nil, err
	}
	return &SessionStore{
		inner: inner,
		instr: newInstrumentation(slowThreshold),
	}, nil
}

func (s *SessionStore) Create(ctx context.Context, userID, userAgent string) (_ *Session, _ string, err error) {
	ctx, end := startSpan(ctx, s.instr, "SessionStore.Create", &err)
	defer end()
	return s.inner.Create(ctx, userID, userAgent)
}

func (s *SessionStore) GetByToken(ctx context.Context, rawToken string) (_ *Session, err error) {
	ctx, end := startSpan(ctx, s.instr, "SessionStore.GetByToken", &err)
	defer end()
	return s.inner.GetByToken(ctx, rawToken)
}

func (s *SessionStore) GetByUserID(ctx context.Context, userID string) (_ []*Session, err error) {
	ctx, end := startSpan(ctx, s.instr, "SessionStore.GetByUserID", &err)
	defer end()
	return s.inner.GetByUserID(ctx, userID)
}

func (s *SessionStore) Delete(ctx context.Context, rawToken string) (err error) {
	ctx, end := startSpan(ctx, s.instr, "SessionStore.Delete", &err)
	defer end()
	return s.inner.Delete(ctx, rawToken)
}

func (s *SessionStore) DeleteByUserIDAndTokenHash(ctx context.Context, userID, tokenHash string) (_ bool, err error) {
	ctx, end := startSpan(ctx, s.instr, "SessionStore.DeleteByUserIDAndTokenHash", &err)
	defer end()
	return s.inner.DeleteByUserIDAndTokenHash(ctx, userID, tokenHash)
}

func (s *SessionStore) DeleteByUserID(ctx context.Context, userID string) (err error) {
	ctx, end := startSpan(ctx, s.instr, "SessionStore.DeleteByUserID", &err)
	defer end()
	return s.inner.DeleteByUserID(ctx, userID)
}

func (s *SessionStore) DeleteExpired(ctx context.Context) (err error) {
	ctx, end := startSpan(ctx, s.instr, "SessionStore.DeleteExpired", &err)
	defer end()
	return s.inner.DeleteExpired(ctx)
}

func (s *SessionStore) UpdateExpiry(ctx context.Context, tokenHash string, expiresAt time.Time) (err error) {
	ctx, end := startSpan(ctx, s.instr, "SessionStore.UpdateExpiry", &err)
	defer end()
	return s.inner.UpdateExpiry(ctx, tokenHash, expiresAt)
}
