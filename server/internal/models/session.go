package models

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

const (
	SessionDuration    = 30 * 24 * time.Hour
	SessionRenewWindow = 7 * 24 * time.Hour
	maxUserAgentLength = 512
	MaxSessionsPerUser = 50
)

var ErrSessionNotFoundOrExpired = errors.New("session not found or expired")

type Session struct {
	Token     string    `json:"token"`
	UserID    string    `json:"user_id"`
	UserAgent string    `json:"user_agent"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
}

type SessionStore struct {
	db *sql.DB
}

func NewSessionStore(db *sql.DB) *SessionStore {
	return &SessionStore{db: db}
}

func generateSessionToken() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("failed to generate session token: %w", err)
	}
	return hex.EncodeToString(bytes), nil
}

func (s *SessionStore) Create(ctx context.Context, userID, userAgent string) (*Session, error) {
	token, err := generateSessionToken()
	if err != nil {
		return nil, fmt.Errorf("create session: %w", err)
	}

	if runes := []rune(userAgent); len(runes) > maxUserAgentLength {
		userAgent = string(runes[:maxUserAgentLength])
	}

	now := time.Now()
	expiresAt := now.Add(SessionDuration)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	evictQuery := `DELETE FROM sessions WHERE token IN (
		SELECT token FROM sessions WHERE user_id = ? AND expires_at > ?
		ORDER BY created_at DESC
		LIMIT -1 OFFSET ?
	)`
	if _, err = tx.ExecContext(ctx, evictQuery, userID, now, MaxSessionsPerUser-1); err != nil {
		return nil, fmt.Errorf("failed to evict old sessions: %w", err)
	}

	insertQuery := `INSERT INTO sessions (token, user_id, user_agent, expires_at) VALUES (?, ?, ?, ?)`
	if _, err = tx.ExecContext(ctx, insertQuery, token, userID, userAgent, expiresAt); err != nil {
		return nil, fmt.Errorf("failed to create session: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("failed to commit session: %w", err)
	}

	return &Session{
		Token:     token,
		UserID:    userID,
		UserAgent: userAgent,
		CreatedAt: now,
		ExpiresAt: expiresAt,
	}, nil
}

func (s *SessionStore) GetByToken(ctx context.Context, token string) (*Session, error) {
	var session Session
	query := `SELECT token, user_id, user_agent, created_at, expires_at FROM sessions WHERE token = ? AND expires_at > ?`

	err := s.db.QueryRowContext(ctx, query, token, time.Now()).Scan(
		&session.Token, &session.UserID, &session.UserAgent, &session.CreatedAt, &session.ExpiresAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("get session by token: %w", ErrSessionNotFoundOrExpired)
		}
		return nil, fmt.Errorf("failed to get session: %w", err)
	}

	return &session, nil
}

func (s *SessionStore) GetByUserID(ctx context.Context, userID string) (sessions []*Session, err error) {
	query := `SELECT token, user_id, user_agent, created_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC`

	rows, err := s.db.QueryContext(ctx, query, userID, time.Now())
	if err != nil {
		return nil, fmt.Errorf("failed to get sessions by user ID: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close rows: %w", closeErr)
		}
	}()

	for rows.Next() {
		var session Session
		if err := rows.Scan(&session.Token, &session.UserID, &session.UserAgent, &session.CreatedAt, &session.ExpiresAt); err != nil {
			return nil, fmt.Errorf("failed to scan session: %w", err)
		}
		sessions = append(sessions, &session)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate sessions: %w", err)
	}

	return sessions, nil
}

func (s *SessionStore) Delete(ctx context.Context, token string) error {
	query := `DELETE FROM sessions WHERE token = ?`
	if _, err := s.db.ExecContext(ctx, query, token); err != nil {
		return fmt.Errorf("failed to delete session: %w", err)
	}
	return nil
}

func (s *SessionStore) DeleteByUserIDAndToken(ctx context.Context, userID, token string) (bool, error) {
	query := `DELETE FROM sessions WHERE user_id = ? AND token = ?`
	result, err := s.db.ExecContext(ctx, query, userID, token)
	if err != nil {
		return false, fmt.Errorf("failed to delete session: %w", err)
	}
	n, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("failed to read rows affected: %w", err)
	}
	return n > 0, nil
}

func (s *SessionStore) DeleteByUserID(ctx context.Context, userID string) error {
	query := `DELETE FROM sessions WHERE user_id = ?`
	if _, err := s.db.ExecContext(ctx, query, userID); err != nil {
		return fmt.Errorf("failed to delete user sessions: %w", err)
	}
	return nil
}

func (s *SessionStore) DeleteExpired(ctx context.Context) error {
	query := `DELETE FROM sessions WHERE expires_at <= ?`
	if _, err := s.db.ExecContext(ctx, query, time.Now()); err != nil {
		return fmt.Errorf("failed to delete expired sessions: %w", err)
	}
	return nil
}

func (s *SessionStore) UpdateExpiry(ctx context.Context, token string, expiresAt time.Time) error {
	query := `UPDATE sessions SET expires_at = ? WHERE token = ? AND expires_at > ?`
	result, err := s.db.ExecContext(ctx, query, expiresAt, token, time.Now())
	if err != nil {
		return fmt.Errorf("failed to update session expiry: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to read updated sessions: %w", err)
	}
	if rowsAffected == 0 {
		return fmt.Errorf("update session expiry: %w", ErrSessionNotFoundOrExpired)
	}

	return nil
}
