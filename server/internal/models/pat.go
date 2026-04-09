package models

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

var ErrPATNotFound = errors.New("personal access token not found")

type PersonalAccessToken struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

type patStore struct {
	db *sql.DB
}

func newPATStore(db *sql.DB) *patStore {
	return &patStore{db: db}
}

func generatePATToken() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	return hex.EncodeToString(bytes), nil
}

func hashPATToken(rawToken string) string {
	h := sha256.Sum256([]byte(rawToken))
	return hex.EncodeToString(h[:])
}

// Create creates a new personal access token for the given user.
// It returns the PAT record and the raw token string. The raw token is
// returned only once — callers must present it to the user immediately,
// as only the hash is stored.
func (s *patStore) Create(ctx context.Context, userID, name string) (*PersonalAccessToken, string, error) {
	id, err := generateID()
	if err != nil {
		return nil, "", fmt.Errorf("create personal access token: %w", err)
	}

	rawToken, err := generatePATToken()
	if err != nil {
		return nil, "", fmt.Errorf("create personal access token: %w", err)
	}

	tokenHash := hashPATToken(rawToken)
	now := time.Now()

	query := `INSERT INTO personal_access_tokens (id, user_id, token_hash, name, created_at) VALUES (?, ?, ?, ?, ?)`
	if _, err := s.db.ExecContext(ctx, query, id, userID, tokenHash, name, now); err != nil {
		return nil, "", fmt.Errorf("create personal access token: %w", err)
	}

	return &PersonalAccessToken{
		ID:        id,
		UserID:    userID,
		Name:      name,
		CreatedAt: now,
	}, rawToken, nil
}

// GetByUserID returns all personal access tokens for the given user, ordered by creation date descending.
func (s *patStore) GetByUserID(ctx context.Context, userID string) (pats []*PersonalAccessToken, err error) {
	query := `SELECT id, user_id, name, created_at FROM personal_access_tokens WHERE user_id = ? ORDER BY created_at DESC, id DESC`

	rows, err := s.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("get personal access tokens by user ID: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close rows: %w", closeErr)
		}
	}()

	for rows.Next() {
		var pat PersonalAccessToken
		if err := rows.Scan(&pat.ID, &pat.UserID, &pat.Name, &pat.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan personal access token: %w", err)
		}
		pats = append(pats, &pat)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate personal access tokens: %w", err)
	}

	return pats, nil
}

// GetByTokenHash looks up a personal access token by the SHA-256 hash of the raw token.
// Used by the auth middleware to validate Bearer tokens.
func (s *patStore) GetByTokenHash(ctx context.Context, rawToken string) (*PersonalAccessToken, error) {
	tokenHash := hashPATToken(rawToken)

	var pat PersonalAccessToken
	query := `SELECT id, user_id, name, created_at FROM personal_access_tokens WHERE token_hash = ?`
	err := s.db.QueryRowContext(ctx, query, tokenHash).Scan(&pat.ID, &pat.UserID, &pat.Name, &pat.CreatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrPATNotFound
		}
		return nil, fmt.Errorf("get personal access token by token hash: %w", err)
	}

	return &pat, nil
}

// Delete removes a personal access token by ID, but only if it belongs to the given user.
// Returns true if a token was deleted, false if not found or not owned by the user.
func (s *patStore) Delete(ctx context.Context, id, userID string) (bool, error) {
	query := `DELETE FROM personal_access_tokens WHERE id = ? AND user_id = ?`
	result, err := s.db.ExecContext(ctx, query, id, userID)
	if err != nil {
		return false, fmt.Errorf("delete personal access token: %w", err)
	}
	n, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("delete personal access token: rows affected: %w", err)
	}
	return n > 0, nil
}
