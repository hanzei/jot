package models

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/hanzei/jot/server/internal/database/dialect"
)

// markViewedTx moves userID's last_viewed_at on the note forward to now. It
// never moves it backward, so a late-arriving view (an offline client's
// replay) cannot undo a newer one.
//
// Every write to a note's shared content (title, content, items, type, images) sets
// notes.content_changed_at/_by in its own UPDATE notes statement, so
// collaborators who viewed the note earlier see it as "updated", and then calls
// this for the actor: editing a note means looking at it, so their own edits
// never flag it for themselves.
func markViewedTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID, userID, now string) error {
	if _, err := tx.ExecContext(ctx,
		d.RewritePlaceholders(`UPDATE note_user_state SET last_viewed_at = ?
		 WHERE note_id = ? AND user_id = ? AND (last_viewed_at IS NULL OR last_viewed_at < ?)`),
		now, noteID, userID, now,
	); err != nil {
		return fmt.Errorf("failed to mark note viewed: %w", err)
	}
	return nil
}

// recordContentChangeTx records a change to the note's shared content by actorID
// for unread tracking, without touching updated_at, and marks the note viewed by
// actorID. Used by writes that live outside the notes row, such as images.
func recordContentChangeTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID, actorID, now string) error {
	if _, err := tx.ExecContext(ctx,
		d.RewritePlaceholders(`UPDATE notes SET content_changed_at = ?, content_changed_by = ? WHERE id = ?`),
		now, actorID, noteID,
	); err != nil {
		return fmt.Errorf("failed to record note content change: %w", err)
	}
	return markViewedTx(ctx, tx, d, noteID, actorID, now)
}

// MarkViewed records that userID viewed the note at viewedAt, clearing what was
// unread up to then. viewedAt is the time the user opened the note, which an
// offline client's replay sends from the past: a change a collaborator made
// after it stays unread. It reports whether the unread state changed, so
// callers can skip notifying the user's other devices when it did not. A note
// the user cannot access is ErrNoteNotFound.
func (s *noteStore) MarkViewed(ctx context.Context, noteID, userID string, viewedAt time.Time) (changed bool, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	before, err := s.unreadTx(ctx, tx, noteID, userID)
	if err != nil {
		return false, err
	}
	if before == nil {
		// Nothing to clear; skip the write.
		return false, nil
	}
	if err = markViewedTx(ctx, tx, s.d, noteID, userID, Timestamp(viewedAt)); err != nil {
		return false, err
	}
	// A view from before the latest change (an offline client's replay) leaves
	// that change unread.
	after, err := s.unreadTx(ctx, tx, noteID, userID)
	if err != nil {
		return false, err
	}

	if err = tx.Commit(); err != nil {
		return false, fmt.Errorf("failed to commit: %w", err)
	}
	return after == nil || *after != *before, nil
}

// unreadTx reads the note's unread state for userID, or ErrNoteNotFound when
// the user has no access to an active note.
func (s *noteStore) unreadTx(ctx context.Context, tx *sql.Tx, noteID, userID string) (*NoteUnread, error) {
	var unread *NoteUnread
	err := tx.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT `+noteUnreadExpr+`
			  FROM active_notes n
			  INNER JOIN note_user_state nus ON n.id = nus.note_id AND nus.user_id = ?
			  WHERE n.id = ?`),
		userID, noteID,
	).Scan(&unread)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNoteNotFound
		}
		return nil, fmt.Errorf("failed to read note unread state: %w", err)
	}
	return unread, nil
}
