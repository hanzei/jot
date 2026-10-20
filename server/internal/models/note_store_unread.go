package models

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/hanzei/jot/server/internal/database/dialect"
)

// markViewedTx sets userID's last_viewed_at on the note to now.
//
// Every write to a note's shared content (title, content, items, type) sets
// notes.content_changed_at/_by in its own UPDATE notes statement, so
// collaborators who viewed the note earlier see it as "updated", and then calls
// this for the actor: editing a note means looking at it, so their own edits
// never flag it for themselves.
func markViewedTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID, userID, now string) error {
	if _, err := tx.ExecContext(ctx,
		d.RewritePlaceholders(`UPDATE note_user_state SET last_viewed_at = ? WHERE note_id = ? AND user_id = ?`),
		now, noteID, userID,
	); err != nil {
		return fmt.Errorf("failed to mark note viewed: %w", err)
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

	if err = markViewedTx(ctx, tx, s.d, noteID, userID, Timestamp(Now())); err != nil {
		return false, err
	}

	if err = tx.Commit(); err != nil {
		return false, fmt.Errorf("failed to commit: %w", err)
	}
	return unread != nil, nil
}
