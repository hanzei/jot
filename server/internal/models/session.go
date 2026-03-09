package models

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"time"
)

const SessionDuration = 24 * time.Hour

type Session struct {
	Token     string    `json:"token"`
	UserID    string    `json:"user_id"`
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

func (s *SessionStore) Create(userID string) (*Session, error) {
	token, err := generateSessionToken()
	if err != nil {
		return nil, err
	}

	now := time.Now()
	expiresAt := now.Add(SessionDuration)

	query := `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`
	if _, err := s.db.Exec(query, token, userID, expiresAt); err != nil {
		return nil, fmt.Errorf("failed to create session: %w", err)
	}

	return &Session{
		Token:     token,
		UserID:    userID,
		CreatedAt: now,
		ExpiresAt: expiresAt,
	}, nil
}

func (s *SessionStore) GetByToken(token string) (*Session, error) {
	var session Session
	query := `SELECT token, user_id, created_at, expires_at FROM sessions WHERE token = ? AND expires_at > ?`

	err := s.db.QueryRow(query, token, time.Now()).Scan(
		&session.Token, &session.UserID, &session.CreatedAt, &session.ExpiresAt,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("session not found or expired")
		}
		return nil, fmt.Errorf("failed to get session: %w", err)
	}

	return &session, nil
}

func (s *SessionStore) Delete(token string) error {
	query := `DELETE FROM sessions WHERE token = ?`
	if _, err := s.db.Exec(query, token); err != nil {
		return fmt.Errorf("failed to delete session: %w", err)
	}
	return nil
}

func (s *SessionStore) DeleteByUserID(userID string) error {
	query := `DELETE FROM sessions WHERE user_id = ?`
	if _, err := s.db.Exec(query, userID); err != nil {
		return fmt.Errorf("failed to delete user sessions: %w", err)
	}
	return nil
}

func (s *SessionStore) DeleteExpired() error {
	query := `DELETE FROM sessions WHERE expires_at <= ?`
	if _, err := s.db.Exec(query, time.Now()); err != nil {
		return fmt.Errorf("failed to delete expired sessions: %w", err)
	}
	return nil
}
