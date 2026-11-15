package models

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/hanzei/jot/server/internal/database/dialect"
	"github.com/hanzei/jot/server/internal/logutil"
)

// touchNoteTx bumps a note's updated_at so item and image changes are reflected
// in note ordering (updated_at sort) and client freshness checks, and records
// the change by actorID for unread tracking (see markViewedTx). Callers invoke
// it only when an item or image actually changed. Like content_changed_at,
// updated_at never moves backward: two concurrent writes can commit in the
// opposite order to the one they sampled now in.
func touchNoteTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID, actorID, now string) error {
	if _, err := tx.ExecContext(ctx,
		d.RewritePlaceholders(`UPDATE notes SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END, `+contentChangedSet+` WHERE id = ?`),
		append(appendContentChangedArgs([]any{now, now}, now, actorID), noteID)...,
	); err != nil {
		return fmt.Errorf("failed to touch note: %w", err)
	}
	return markViewedTx(ctx, tx, d, noteID, actorID, now)
}

// touchNoteIfChangedTx is touchNoteTx for item writes that may turn out to be
// no-ops (e.g. an offline replay of an already-applied change): it touches the
// note only when changed is true.
func touchNoteIfChangedTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, changed bool, noteID, actorID, now string) error {
	if !changed {
		return nil
	}
	return touchNoteTx(ctx, tx, d, noteID, actorID, now)
}

func (s *noteStore) ReorderNotes(ctx context.Context, userID string, noteIDs []string) error {
	if len(noteIDs) == 0 {
		return nil
	}

	// Start transaction
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() {
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			logutil.FromContext(ctx).WithError(rollbackErr).Error("Failed to rollback transaction")
		}
	}()

	// Update positions in note_user_state, enforcing access via the state row's user_id.
	for i, noteID := range noteIDs {
		var result sql.Result
		result, err = tx.ExecContext(ctx,
			s.d.RewritePlaceholders("UPDATE note_user_state SET position = ? WHERE note_id = ? AND user_id = ?"),
			i, noteID, userID,
		)
		if err != nil {
			return fmt.Errorf("failed to update position for note %s: %w", noteID, err)
		}
		var n int64
		n, err = result.RowsAffected()
		if err != nil {
			return fmt.Errorf("failed to check rows affected for note %s: %w", noteID, err)
		}
		if n == 0 {
			return fmt.Errorf("no access to note %s: %w", noteID, ErrNoteNoAccess)
		}
	}

	// Commit transaction
	err = tx.Commit()
	if err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}
