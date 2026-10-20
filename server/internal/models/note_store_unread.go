package models

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/hanzei/jot/server/internal/database/dialect"
)

// RecordContentChange stamps a change to a note's shared content by actorID,
// for write paths whose store method does not know the actor (the item
// endpoints). Update and ConvertType record it inside their own transaction.
// Callers run it after the mutation succeeds and before publishing
// note_updated, so the personalized payloads carry the new unread state.
func (s *noteStore) RecordContentChange(ctx context.Context, noteID, actorID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if err = recordContentChangeTx(ctx, tx, s.d, noteID, actorID, Timestamp(Now())); err != nil {
		return err
	}
	return tx.Commit()
}

// recordContentChangeTx marks the note's shared content (title, content, items,
// type) as changed by actorID at now. Collaborators who last viewed the note
// earlier then see it as "updated"; the actor's own last_viewed_at moves to the
// same instant, since editing a note means looking at it, so their own edits
// never flag it for themselves.
func recordContentChangeTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID, actorID, now string) error {
	if _, err := tx.ExecContext(ctx,
		d.RewritePlaceholders(`UPDATE notes SET content_changed_at = ?, content_changed_by = ? WHERE id = ?`),
		now, actorID, noteID,
	); err != nil {
		return fmt.Errorf("failed to record note content change: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		d.RewritePlaceholders(`UPDATE note_user_state SET last_viewed_at = ? WHERE note_id = ? AND user_id = ?`),
		now, noteID, actorID,
	); err != nil {
		return fmt.Errorf("failed to mark note viewed by editor: %w", err)
	}
	return nil
}

// MarkViewed records that userID has opened the note now, clearing its unread
// state for them. It reports whether the note was unread beforehand, so callers
// can skip notifying the user's other devices when nothing changed. A note the
// user cannot access is ErrNoteNotFound.
func (s *noteStore) MarkViewed(ctx context.Context, noteID, userID string) (wasUnread bool, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var unread *NoteUnread
	err = tx.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT `+noteUnreadExpr+`
			  FROM active_notes n
			  INNER JOIN note_user_state nus ON n.id = nus.note_id AND nus.user_id = ?
			  WHERE n.id = ?`),
		userID, noteID,
	).Scan(&unread)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, ErrNoteNotFound
		}
		return false, fmt.Errorf("failed to read note unread state: %w", err)
	}

	if _, err = tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`UPDATE note_user_state SET last_viewed_at = ? WHERE note_id = ? AND user_id = ?`),
		Timestamp(Now()), noteID, userID,
	); err != nil {
		return false, fmt.Errorf("failed to mark note viewed: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return false, fmt.Errorf("failed to commit: %w", err)
	}
	return unread != nil, nil
}
