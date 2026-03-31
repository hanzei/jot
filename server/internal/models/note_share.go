package models

import (
	"context"
	"database/sql"
	"fmt"
)

func scanNoteShare(rows *sql.Rows) (NoteShare, error) {
	var share NoteShare
	err := rows.Scan(
		&share.ID, &share.NoteID, &share.SharedWithUserID, &share.SharedByUserID,
		&share.PermissionLevel, &share.Username, &share.FirstName, &share.LastName,
		&share.HasProfileIcon, &share.CreatedAt, &share.UpdatedAt,
	)
	return share, err
}

func (s *NoteStore) GetNoteShares(ctx context.Context, noteID string) ([]NoteShare, error) {
	query := `SELECT ns.id, ns.note_id, ns.shared_with_user_id, ns.shared_by_user_id,
			  ns.permission_level, u.username, u.first_name, u.last_name,
			  u.profile_icon IS NOT NULL AS has_profile_icon,
			  ns.created_at, ns.updated_at
			  FROM note_shares ns
			  JOIN users u ON ns.shared_with_user_id = u.id
			  WHERE ns.note_id = ?
			  ORDER BY u.username`

	rows, err := s.db.QueryContext(ctx, query, noteID)
	if err != nil {
		return nil, fmt.Errorf("failed to get note shares: %w", err)
	}

	shares, err := collectRows(rows, scanNoteShare)
	if err != nil {
		return nil, fmt.Errorf("failed to scan note shares: %w", err)
	}
	if shares == nil {
		shares = []NoteShare{}
	}
	return shares, nil
}

func (s *NoteStore) ShareNote(ctx context.Context, noteID string, sharedByUserID, sharedWithUserID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	shareID, err := generateID()
	if err != nil {
		return fmt.Errorf("failed to generate share ID: %w", err)
	}

	_, err = tx.ExecContext(ctx,
		`INSERT INTO note_shares (id, note_id, shared_with_user_id, shared_by_user_id, permission_level)
		 VALUES (?, ?, ?, ?, 'edit')`,
		shareID, noteID, sharedWithUserID, sharedByUserID,
	)
	if err != nil {
		if isUniqueConstraintError(err) {
			return ErrNoteAlreadyShared
		}
		return fmt.Errorf("failed to share note: %w", err)
	}

	if _, err = tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO note_user_state (note_id, user_id) VALUES (?, ?)`,
		noteID, sharedWithUserID,
	); err != nil {
		return fmt.Errorf("failed to create note user state for collaborator: %w", err)
	}

	return tx.Commit()
}

func (s *NoteStore) UnshareNote(ctx context.Context, noteID string, sharedWithUserID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	result, err := tx.ExecContext(ctx, `DELETE FROM note_shares WHERE note_id = ? AND shared_with_user_id = ?`, noteID, sharedWithUserID)
	if err != nil {
		return fmt.Errorf("failed to unshare note: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}

	if rowsAffected == 0 {
		return ErrNoteShareNotFound
	}

	if _, err = tx.ExecContext(ctx,
		`UPDATE note_items SET assigned_to = '' WHERE note_id = ? AND assigned_to = ?`,
		noteID, sharedWithUserID,
	); err != nil {
		return fmt.Errorf("failed to clear assignments for unshared user: %w", err)
	}

	var remainingShares int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM note_shares WHERE note_id = ?`, noteID).Scan(&remainingShares); err != nil {
		return fmt.Errorf("failed to count remaining shares: %w", err)
	}

	if remainingShares == 0 {
		if _, err = tx.ExecContext(ctx,
			`UPDATE note_items SET assigned_to = '' WHERE note_id = ? AND assigned_to != ''`,
			noteID,
		); err != nil {
			return fmt.Errorf("failed to clear all assignments: %w", err)
		}
	}

	// Remove per-user state and labels for the unshared collaborator.
	if _, err = tx.ExecContext(ctx,
		`DELETE FROM note_user_state WHERE note_id = ? AND user_id = ?`,
		noteID, sharedWithUserID,
	); err != nil {
		return fmt.Errorf("failed to delete note user state for unshared user: %w", err)
	}

	if _, err = tx.ExecContext(ctx,
		`DELETE FROM note_labels WHERE note_id = ? AND user_id = ?`,
		noteID, sharedWithUserID,
	); err != nil {
		return fmt.Errorf("failed to delete note labels for unshared user: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit unshare transaction: %w", err)
	}

	return nil
}

// ClearUserAssignmentsTx clears all item assignments related to a deleted user
// within an existing transaction. It:
//  1. Removes note_shares rows where the user is the sharee (shared_with_user_id).
//  2. Removes note_shares rows where the user is the sharer (shared_by_user_id).
//  3. Clears items directly assigned to the deleted user.
//  4. Clears all remaining assignments on notes that no longer have any shares,
//     enforcing the invariant that unshared notes cannot have assignments.
func (s *NoteStore) ClearUserAssignmentsTx(ctx context.Context, tx *sql.Tx, userID string) error {
	if _, err := tx.ExecContext(
		ctx,
		`DELETE FROM note_shares WHERE shared_with_user_id = ?`,
		userID,
	); err != nil {
		return fmt.Errorf("failed to remove deleted user shares: %w", err)
	}

	if _, err := tx.ExecContext(
		ctx,
		`DELETE FROM note_shares WHERE shared_by_user_id = ?`,
		userID,
	); err != nil {
		return fmt.Errorf("failed to remove shares created by deleted user: %w", err)
	}

	if _, err := tx.ExecContext(
		ctx,
		`UPDATE note_items SET assigned_to = '' WHERE assigned_to = ?`,
		userID,
	); err != nil {
		return fmt.Errorf("failed to clear deleted user assignments: %w", err)
	}

	if _, err := tx.ExecContext(
		ctx,
		`UPDATE note_items SET assigned_to = ''
		 WHERE assigned_to != ''
		   AND note_id NOT IN (SELECT DISTINCT note_id FROM note_shares)`,
	); err != nil {
		return fmt.Errorf("failed to clear assignments on unshared notes: %w", err)
	}

	// Remove per-user state for notes the user was collaborating on (not owning).
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM note_user_state WHERE user_id = ? AND note_id NOT IN (SELECT id FROM notes WHERE user_id = ?)`,
		userID, userID,
	); err != nil {
		return fmt.Errorf("failed to delete note user state for deleted user's shared notes: %w", err)
	}

	// Remove note labels the user applied to shared notes.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM note_labels WHERE user_id = ? AND note_id NOT IN (SELECT id FROM notes WHERE user_id = ?)`,
		userID, userID,
	); err != nil {
		return fmt.Errorf("failed to delete note labels for deleted user's shared notes: %w", err)
	}

	return nil
}
