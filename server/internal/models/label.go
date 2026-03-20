package models

import (
	"database/sql"
	"fmt"
	"time"
)

func scanLabel(rows *sql.Rows) (Label, error) {
	var l Label
	err := rows.Scan(&l.ID, &l.UserID, &l.Name, &l.CreatedAt, &l.UpdatedAt)
	return l, err
}

type Label struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type LabelStore struct {
	db *sql.DB
}

func NewLabelStore(db *sql.DB) *LabelStore {
	return &LabelStore{db: db}
}

// GetLabels returns all labels belonging to a user.
func (s *LabelStore) GetLabels(userID string) ([]Label, error) {
	query := `SELECT id, user_id, name, created_at, updated_at FROM labels WHERE user_id = ? ORDER BY name ASC`
	rows, err := s.db.Query(query, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get labels: %w", err)
	}

	labels, err := collectRows(rows, scanLabel)
	if err != nil {
		return nil, fmt.Errorf("failed to scan labels: %w", err)
	}
	if labels == nil {
		labels = []Label{}
	}
	return labels, nil
}

// GetOrCreateLabel finds an existing label by name for a user or creates a new one.
// Uses an atomic upsert to avoid race conditions when multiple callers create the same label concurrently.
func (s *LabelStore) GetOrCreateLabel(userID, name string) (*Label, error) {
	id, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate label ID: %w", err)
	}

	var l Label
	err = s.db.QueryRow(
		`INSERT INTO labels (id, user_id, name) VALUES (?, ?, ?)
		 ON CONFLICT(user_id, name) DO UPDATE SET name=excluded.name
		 RETURNING id, user_id, name, created_at, updated_at`,
		id, userID, name,
	).Scan(&l.ID, &l.UserID, &l.Name, &l.CreatedAt, &l.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to get or create label: %w", err)
	}
	return &l, nil
}
