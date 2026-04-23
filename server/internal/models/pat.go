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

	"github.com/hanzei/jot/server/internal/database/dialect"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
)

var (
	ErrPATNotFound = errors.New("personal access token not found")
	ErrPATExpired  = errors.New("personal access token expired")
)

// PATMinLifetime is the minimum allowed lifetime for a PAT that carries an
// expiration. Tokens with an expires_at closer to now than this are rejected
// on creation to prevent accidentally-created tokens that are effectively
// already expired.
const PATMinLifetime = time.Minute

// PATMaxLifetime caps how far in the future a PAT's expires_at may be set at
// creation time. One year is long enough for typical CI / automation use-cases
// without letting callers create effectively-immortal tokens.
const PATMaxLifetime = 365 * 24 * time.Hour

type PersonalAccessToken struct {
	ID        string     `json:"id"`
	UserID    string     `json:"user_id"`
	Name      string     `json:"name"`
	CreatedAt time.Time  `json:"created_at"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
}

// IsExpired reports whether the token's expires_at is non-nil and has been
// reached (>= now).
func (p *PersonalAccessToken) IsExpired(now time.Time) bool {
	return p.ExpiresAt != nil && !now.Before(*p.ExpiresAt)
}

type patStore struct {
	db      *sql.DB
	d       *dialect.Dialect
	expired metric.Int64Counter
	cleaned metric.Int64Counter
}

func newPATStore(db *sql.DB, d *dialect.Dialect) (*patStore, error) {
	meter := otel.GetMeterProvider().Meter("github.com/hanzei/jot/server")

	expired, err := meter.Int64Counter(
		"pats.expired_rejected",
		metric.WithDescription("Total PAT auth attempts rejected because the token had expired"),
	)
	if err != nil {
		return nil, fmt.Errorf("create pats.expired_rejected instrument: %w", err)
	}

	cleaned, err := meter.Int64Counter(
		"pats.expired_deleted",
		metric.WithDescription("Total expired PATs deleted during periodic cleanup"),
	)
	if err != nil {
		return nil, fmt.Errorf("create pats.expired_deleted instrument: %w", err)
	}

	return &patStore{db: db, d: d, expired: expired, cleaned: cleaned}, nil
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
//
// If expiresAt is non-nil it is persisted as the token's expiration; a nil
// value persists NULL (the token never expires automatically).
func (s *patStore) Create(ctx context.Context, userID, name string, expiresAt *time.Time) (*PersonalAccessToken, string, error) {
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

	query := `INSERT INTO personal_access_tokens (id, user_id, token_hash, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`
	var expiresArg any
	if expiresAt != nil {
		expiresArg = *expiresAt
	} else {
		expiresArg = nil
	}
	if _, err := s.db.ExecContext(ctx, s.d.RewritePlaceholders(query), id, userID, tokenHash, name, now, expiresArg); err != nil {
		return nil, "", fmt.Errorf("create personal access token: %w", err)
	}

	return &PersonalAccessToken{
		ID:        id,
		UserID:    userID,
		Name:      name,
		CreatedAt: now,
		ExpiresAt: expiresAt,
	}, rawToken, nil
}

// GetByUserID returns all personal access tokens for the given user, ordered by creation date descending.
func (s *patStore) GetByUserID(ctx context.Context, userID string) (pats []*PersonalAccessToken, err error) {
	query := `SELECT id, user_id, name, created_at, expires_at FROM personal_access_tokens WHERE user_id = ? ORDER BY created_at DESC, id DESC`

	rows, err := s.db.QueryContext(ctx, s.d.RewritePlaceholders(query), userID)
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
		var expiresAt sql.NullTime
		if err := rows.Scan(&pat.ID, &pat.UserID, &pat.Name, &pat.CreatedAt, &expiresAt); err != nil {
			return nil, fmt.Errorf("scan personal access token: %w", err)
		}
		if expiresAt.Valid {
			t := expiresAt.Time
			pat.ExpiresAt = &t
		}
		pats = append(pats, &pat)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate personal access tokens: %w", err)
	}

	return pats, nil
}

// GetByTokenHash looks up a personal access token by the SHA-256 hash of the raw token.
// Used by the auth middleware to validate Bearer tokens. If the token exists
// but has expired, it returns ErrPATExpired (the caller is expected to log an
// audit-level event in that case). The expired counter is incremented as a
// side-effect of an expired-token lookup so operators can monitor forced
// rejections.
func (s *patStore) GetByTokenHash(ctx context.Context, rawToken string) (*PersonalAccessToken, error) {
	tokenHash := hashPATToken(rawToken)

	var pat PersonalAccessToken
	var expiresAt sql.NullTime
	query := `SELECT id, user_id, name, created_at, expires_at FROM personal_access_tokens WHERE token_hash = ?`
	err := s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(query), tokenHash).Scan(&pat.ID, &pat.UserID, &pat.Name, &pat.CreatedAt, &expiresAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrPATNotFound
		}
		return nil, fmt.Errorf("get personal access token by token hash: %w", err)
	}
	if expiresAt.Valid {
		t := expiresAt.Time
		pat.ExpiresAt = &t
	}
	if pat.IsExpired(time.Now()) {
		s.expired.Add(ctx, 1)
		return &pat, ErrPATExpired
	}

	return &pat, nil
}

// Delete removes a personal access token by ID, but only if it belongs to the given user.
// Returns true if a token was deleted, false if not found or not owned by the user.
func (s *patStore) Delete(ctx context.Context, id, userID string) (bool, error) {
	query := `DELETE FROM personal_access_tokens WHERE id = ? AND user_id = ?`
	result, err := s.db.ExecContext(ctx, s.d.RewritePlaceholders(query), id, userID)
	if err != nil {
		return false, fmt.Errorf("delete personal access token: %w", err)
	}
	n, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("delete personal access token: rows affected: %w", err)
	}
	return n > 0, nil
}

// DeleteExpired purges all personal access tokens whose expires_at has passed.
// Tokens with NULL expires_at are never deleted by this call. Returns the
// number of rows removed so the caller can log it for audit purposes.
func (s *patStore) DeleteExpired(ctx context.Context) (int64, error) {
	query := `DELETE FROM personal_access_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?`
	result, err := s.db.ExecContext(ctx, s.d.RewritePlaceholders(query), time.Now())
	if err != nil {
		return 0, fmt.Errorf("delete expired personal access tokens: %w", err)
	}
	n, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("delete expired personal access tokens: rows affected: %w", err)
	}
	if n > 0 {
		s.cleaned.Add(ctx, n)
	}
	return n, nil
}
