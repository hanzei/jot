package models

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	sqlite3 "github.com/mattn/go-sqlite3"
)

var ErrLabelNotFoundOrNotOwned = errors.New("label not found or not owned by user")
var ErrLabelNameConflict = errors.New("label name already exists")

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

// GetLabelNoteIDs returns note IDs currently associated with a user-owned label.
func (s *LabelStore) GetLabelNoteIDs(labelID, userID string) ([]string, error) {
	var exists int
	if err := s.db.QueryRow(
		`SELECT 1 FROM labels WHERE id = ? AND user_id = ?`,
		labelID, userID,
	).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrLabelNotFoundOrNotOwned
		}
		return nil, fmt.Errorf("check label ownership: %w", err)
	}

	rows, err := s.db.Query(`SELECT note_id FROM note_labels WHERE label_id = ?`, labelID)
	if err != nil {
		return nil, fmt.Errorf("get label note IDs: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()

	noteIDs := make([]string, 0)
	for rows.Next() {
		var noteID string
		if err := rows.Scan(&noteID); err != nil {
			return nil, fmt.Errorf("scan label note ID: %w", err)
		}
		noteIDs = append(noteIDs, noteID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate label note IDs: %w", err)
	}
	return noteIDs, nil
}

// RenameLabel renames a user-owned label and returns the updated row.
func (s *LabelStore) RenameLabel(labelID, userID, newName string) (*Label, error) {
	var l Label
	err := s.db.QueryRow(
		`UPDATE labels
		 SET name = ?, updated_at = CURRENT_TIMESTAMP
		 WHERE id = ? AND user_id = ?
		 RETURNING id, user_id, name, created_at, updated_at`,
		newName, labelID, userID,
	).Scan(&l.ID, &l.UserID, &l.Name, &l.CreatedAt, &l.UpdatedAt)
	if err != nil {
		var sqliteErr sqlite3.Error
		if errors.As(err, &sqliteErr) && sqliteErr.ExtendedCode == sqlite3.ErrConstraintUnique {
			return nil, ErrLabelNameConflict
		}
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrLabelNotFoundOrNotOwned
		}
		return nil, fmt.Errorf("failed to rename label: %w", err)
	}
	return &l, nil
}

// DeleteLabel deletes a user-owned label and all note label associations in one transaction.
func (s *LabelStore) DeleteLabel(labelID, userID string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin delete label transaction: %w", err)
	}
	defer func() {
		if tx != nil {
			_ = tx.Rollback()
		}
	}()

	var exists int
	if err := tx.QueryRow(
		`SELECT 1 FROM labels WHERE id = ? AND user_id = ?`,
		labelID, userID,
	).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrLabelNotFoundOrNotOwned
		}
		return fmt.Errorf("check label ownership: %w", err)
	}

	if _, err := tx.Exec(`DELETE FROM note_labels WHERE label_id = ?`, labelID); err != nil {
		return fmt.Errorf("delete note label associations: %w", err)
	}

	if _, err := tx.Exec(`DELETE FROM labels WHERE id = ? AND user_id = ?`, labelID, userID); err != nil {
		return fmt.Errorf("delete label: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit delete label transaction: %w", err)
	}
	tx = nil
	return nil
}
