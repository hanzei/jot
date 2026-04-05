package models

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
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
func (s *LabelStore) GetLabels(ctx context.Context, userID string) ([]Label, error) {
	query := `SELECT id, user_id, name, created_at, updated_at FROM labels WHERE user_id = ? ORDER BY name ASC`
	rows, err := s.db.QueryContext(ctx, query, userID)
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

// GetLabelCounts returns a map of label ID to note count for active notes.
// Counts exclude archived and trashed notes to match the default notes view.
func (s *LabelStore) GetLabelCounts(ctx context.Context, userID string) (map[string]int, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT l.id, COUNT(nus.note_id) AS note_count
		FROM labels l
		LEFT JOIN note_labels nl
			ON nl.label_id = l.id AND nl.user_id = l.user_id
		LEFT JOIN notes n
			ON n.id = nl.note_id
			AND n.deleted_at IS NULL
		LEFT JOIN note_user_state nus
			ON nus.note_id = n.id
			AND nus.user_id = l.user_id
			AND nus.archived = FALSE
		WHERE l.user_id = ?
		GROUP BY l.id
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get label counts: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()

	counts := map[string]int{}
	for rows.Next() {
		var labelID string
		var count int
		if err := rows.Scan(&labelID, &count); err != nil {
			return nil, fmt.Errorf("scan label count: %w", err)
		}
		counts[labelID] = count
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate label counts: %w", err)
	}

	return counts, nil
}

// GetOrCreateLabel finds an existing label by name for a user or creates a new one.
// Uses an atomic upsert to avoid race conditions when multiple callers create the same label concurrently.
func (s *LabelStore) GetOrCreateLabel(ctx context.Context, userID, name string) (*Label, error) {
	id, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate label ID: %w", err)
	}

	var l Label
	err = s.db.QueryRowContext(ctx,
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
func (s *LabelStore) GetLabelNoteIDs(ctx context.Context, labelID, userID string) ([]string, error) {
	var exists int
	if err := s.db.QueryRowContext(ctx,
		`SELECT 1 FROM labels WHERE id = ? AND user_id = ?`,
		labelID, userID,
	).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrLabelNotFoundOrNotOwned
		}
		return nil, fmt.Errorf("check label ownership: %w", err)
	}

	rows, err := s.db.QueryContext(ctx, `SELECT note_id FROM note_labels WHERE label_id = ? AND user_id = ?`, labelID, userID)
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
func (s *LabelStore) RenameLabel(ctx context.Context, labelID, userID, newName string) (*Label, error) {
	var l Label
	err := s.db.QueryRowContext(ctx,
		`UPDATE labels
		 SET name = ?, updated_at = CURRENT_TIMESTAMP
		 WHERE id = ? AND user_id = ?
		 RETURNING id, user_id, name, created_at, updated_at`,
		newName, labelID, userID,
	).Scan(&l.ID, &l.UserID, &l.Name, &l.CreatedAt, &l.UpdatedAt)
	if err != nil {
		if isUniqueConstraintError(err) {
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
func (s *LabelStore) DeleteLabel(ctx context.Context, labelID, userID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin delete label transaction: %w", err)
	}
	defer func() {
		if tx != nil {
			_ = tx.Rollback()
		}
	}()

	var exists int
	if err := tx.QueryRowContext(ctx,
		`SELECT 1 FROM labels WHERE id = ? AND user_id = ?`,
		labelID, userID,
	).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrLabelNotFoundOrNotOwned
		}
		return fmt.Errorf("check label ownership: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM note_labels WHERE label_id = ?`, labelID); err != nil {
		return fmt.Errorf("delete note label associations: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM labels WHERE id = ? AND user_id = ?`, labelID, userID); err != nil {
		return fmt.Errorf("delete label: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit delete label transaction: %w", err)
	}
	tx = nil
	return nil
}
