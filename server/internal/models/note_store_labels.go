package models

import (
	"context"
	"database/sql"
	"fmt"
	"slices"
	"strings"
)

// GetNoteLabels returns labels attached to a note by a specific user.
func (s *noteStore) GetNoteLabels(ctx context.Context, noteID string, userID string) ([]Label, error) {
	query := s.d.RewritePlaceholders(`SELECT l.id, l.user_id, l.name, l.created_at, l.updated_at
			  FROM labels l
			  JOIN note_labels nl ON l.id = nl.label_id
			  WHERE nl.note_id = ? AND nl.user_id = ?
			  ORDER BY l.name ASC`)
	rows, err := s.db.QueryContext(ctx, query, noteID, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get note labels: %w", err)
	}

	labels, err := collectRows(rows, scanLabel)
	if err != nil {
		return nil, fmt.Errorf("failed to scan note labels: %w", err)
	}
	if labels == nil {
		labels = []Label{}
	}
	return labels, nil
}

// getLabelsByNoteIDs batch-loads labels for a set of note IDs for a specific user, returning a map of noteID -> []Label.
func (s *noteStore) getLabelsByNoteIDs(ctx context.Context, noteIDs []string, userID string) (map[string][]Label, error) {
	if len(noteIDs) == 0 {
		return map[string][]Label{}, nil
	}

	type noteLabelRow struct {
		noteID string
		label  Label
	}
	scanNoteLabel := func(rows *sql.Rows) (noteLabelRow, error) {
		var r noteLabelRow
		err := rows.Scan(&r.noteID, &r.label.ID, &r.label.UserID, &r.label.Name, &r.label.CreatedAt, &r.label.UpdatedAt)
		return r, err
	}

	result := map[string][]Label{}
	// Chunk the note IDs so the bound-parameter count stays under the driver's
	// limit, matching getSharesByNoteIDs/getNoteImagesByNoteIDs.
	for chunk := range slices.Chunk(noteIDs, noteIDsQueryBatchSize) {
		placeholders := strings.Join(slices.Repeat([]string{"?"}, len(chunk)), ",")
		args := make([]any, 0, len(chunk)+1)
		for _, id := range chunk {
			args = append(args, id)
		}
		args = append(args, userID)

		rawQuery := `SELECT nl.note_id, l.id, l.user_id, l.name, l.created_at, l.updated_at
				  FROM labels l
				  JOIN note_labels nl ON l.id = nl.label_id
				  WHERE nl.note_id IN (` + placeholders + `) AND nl.user_id = ?
				  ORDER BY nl.note_id, l.name ASC` // #nosec G202 -- only "?" placeholders are joined, no user input

		rows, err := s.db.QueryContext(ctx, s.d.RewritePlaceholders(rawQuery), args...)
		if err != nil {
			return nil, fmt.Errorf("failed to batch-get note labels: %w", err)
		}

		for row, err := range scanRows(rows, scanNoteLabel) {
			if err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("failed to scan note label: %w", err)
			}
			result[row.noteID] = append(result[row.noteID], row.label)
		}
		if err := rows.Close(); err != nil {
			return nil, fmt.Errorf("failed to close note labels rows: %w", err)
		}
	}
	return result, nil
}

// AddLabelToNote attaches a label to a note (user must have access).
func (s *noteStore) AddLabelToNote(ctx context.Context, noteID, labelID, userID string) error {
	hasAccess, err := s.HasAccess(ctx, noteID, userID)
	if err != nil {
		return fmt.Errorf("failed to check access: %w", err)
	}
	if !hasAccess {
		return ErrNoteNoAccess
	}

	// Verify the label exists and belongs to this user.
	var count int
	if err = s.db.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT COUNT(*) FROM labels WHERE id = ? AND user_id = ?`),
		labelID, userID,
	).Scan(&count); err != nil {
		return fmt.Errorf("failed to verify label ownership: %w", err)
	}
	if count == 0 {
		return ErrLabelNotFoundOrNotOwned
	}

	id, err := generateID()
	if err != nil {
		return fmt.Errorf("failed to generate note_label ID: %w", err)
	}
	q := s.d.RewritePlaceholders(
		s.d.InsertIgnore("note_labels", "id, note_id, label_id, user_id", "?, ?, ?, ?"),
	)
	_, err = s.db.ExecContext(ctx, q, id, noteID, labelID, userID)
	if err != nil {
		return fmt.Errorf("failed to add label to note: %w", err)
	}
	return nil
}

// RemoveLabelFromNote detaches a label from a note (user must have access).
func (s *noteStore) RemoveLabelFromNote(ctx context.Context, noteID, labelID, userID string) error {
	hasAccess, err := s.HasAccess(ctx, noteID, userID)
	if err != nil {
		return fmt.Errorf("failed to check access: %w", err)
	}
	if !hasAccess {
		return ErrNoteNoAccess
	}

	_, err = s.db.ExecContext(ctx,
		s.d.RewritePlaceholders(`DELETE FROM note_labels WHERE note_id = ? AND label_id = ? AND user_id = ?`),
		noteID, labelID, userID,
	)
	if err != nil {
		return fmt.Errorf("failed to remove label from note: %w", err)
	}
	return nil
}
