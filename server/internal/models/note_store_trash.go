package models

import (
	"context"
	"database/sql"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/hanzei/jot/server/internal/database/dialect"
)

func buildInClauseArgs(ids []string) (string, []any) {
	placeholders := slices.Repeat([]string{"?"}, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	return strings.Join(placeholders, ","), args
}

func (s *noteStore) getTrashedOwnedNoteIDsTx(ctx context.Context, tx *sql.Tx, userID string) ([]string, error) {
	rows, err := tx.QueryContext(ctx, s.d.RewritePlaceholders(`SELECT id FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at ASC, id ASC`), userID)
	if err != nil {
		return nil, fmt.Errorf("failed to query trashed notes: %w", err)
	}

	scanString := func(rows *sql.Rows) (string, error) {
		var id string
		return id, rows.Scan(&id)
	}
	ids, err := collectRows(rows, scanString)
	if err != nil {
		return nil, fmt.Errorf("failed to scan trashed note IDs: %w", err)
	}
	return ids, nil
}

// deleteNoteDependenciesTx deletes rows in tables that reference noteIDs but
// aren't covered by the notes table's own cascading foreign keys (items,
// labels, shares, per-user state), and returns the distinct sha256 hashes of
// images attached to noteIDs. Those hashes must be read before the caller
// deletes the notes themselves: note_images rows cascade-delete with their
// note, so reading them afterward would find nothing. The caller is
// responsible for reclaiming the returned hashes' blobs (via
// blobstore.ReclaimIfOrphaned) once the delete has committed.
func deleteNoteDependenciesTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteIDs []string) ([]string, error) {
	if len(noteIDs) == 0 {
		return nil, nil
	}

	placeholders, args := buildInClauseArgs(noteIDs)

	imgQuery := `SELECT DISTINCT sha256 FROM note_images WHERE note_id IN (` + placeholders + `)` // #nosec G202 -- only "?" placeholders are joined, no user input
	rows, err := tx.QueryContext(ctx, d.RewritePlaceholders(imgQuery), args...)
	if err != nil {
		return nil, fmt.Errorf("failed to query note image hashes: %w", err)
	}
	shas, err := collectRows(rows, func(rows *sql.Rows) (string, error) {
		var sha string
		return sha, rows.Scan(&sha)
	})
	if err != nil {
		return nil, fmt.Errorf("failed to scan note image hashes: %w", err)
	}

	for _, q := range []string{
		`DELETE FROM note_items WHERE note_id IN (` + placeholders + `)`,
		`DELETE FROM note_labels WHERE note_id IN (` + placeholders + `)`,
		`DELETE FROM note_shares WHERE note_id IN (` + placeholders + `)`,
		`DELETE FROM note_user_state WHERE note_id IN (` + placeholders + `)`,
	} {
		if _, err := tx.ExecContext(ctx, d.RewritePlaceholders(q), args...); err != nil {
			return nil, fmt.Errorf("failed to delete dependent rows: %w", err)
		}
	}

	return shas, nil
}

// MoveToTrash soft-deletes a note by setting deleted_at to the current time.
// Only the owner can move a note to trash; it disappears from all collaborators' views.
func (s *noteStore) MoveToTrash(ctx context.Context, id string, userID string) error {
	isOwner, err := s.IsOwner(ctx, id, userID)
	if err != nil {
		return fmt.Errorf("failed to check ownership: %w", err)
	}
	if !isOwner {
		return ErrNoteNotOwnedByUser
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	result, err := tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`UPDATE notes SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
		 WHERE id = ? AND user_id = ? AND deleted_at IS NULL`),
		id, userID,
	)
	if err != nil {
		return fmt.Errorf("failed to move note to trash: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return ErrNoteNotOwnedByUser
	}

	// Reset all collaborators' per-user state so the note won't appear pinned/archived on restore.
	if _, err = tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`UPDATE note_user_state SET pinned = FALSE, archived = FALSE, updated_at = CURRENT_TIMESTAMP
		 WHERE note_id = ?`),
		id,
	); err != nil {
		return fmt.Errorf("failed to reset note user state on trash: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit move to trash: %w", err)
	}
	return nil
}

// RestoreFromTrash clears deleted_at and places the restored note at position 0
// of the unpinned active list, shifting existing notes down.
func (s *noteStore) RestoreFromTrash(ctx context.Context, id string, userID string) error {
	isOwner, err := s.IsOwner(ctx, id, userID)
	if err != nil {
		return fmt.Errorf("failed to check ownership: %w", err)
	}
	if !isOwner {
		return ErrNoteNotOwnedByUser
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Restore the note first — if it's not actually in the trash we bail out
	// before shifting any positions.
	result, err := tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`UPDATE notes SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
		 WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL`),
		id, userID,
	)
	if err != nil {
		return fmt.Errorf("failed to restore note from trash: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return ErrNoteNotInTrash
	}

	// Reset all collaborators' per-user state so the restored note lands at position 0,
	// unpinned and unarchived, for every user who has access.
	if _, err = tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`UPDATE note_user_state SET pinned = FALSE, archived = FALSE, position = 0, unpinned_position = NULL, updated_at = CURRENT_TIMESTAMP
		 WHERE note_id = ?`),
		id,
	); err != nil {
		return fmt.Errorf("failed to reset note user state on restore: %w", err)
	}

	// Shift each collaborator's existing active unpinned notes down to make room at position 0.
	shiftQuery := s.d.RewritePlaceholders(`UPDATE note_user_state SET position = position + 1
	               WHERE note_id != ?
	               AND pinned = FALSE AND archived = FALSE
	               AND note_id IN (SELECT id FROM notes WHERE deleted_at IS NULL)
	               AND user_id IN (SELECT user_id FROM note_user_state WHERE note_id = ?)`)
	if _, err = tx.ExecContext(ctx, shiftQuery, id, id); err != nil {
		return fmt.Errorf("failed to shift notes after restore: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit restore transaction: %w", err)
	}

	return nil
}

// DeleteFromTrash permanently removes a note that is already in the trash.
// It returns ErrNoteNotInTrash if the note is not found in the trash or not
// owned by the user. On success it also returns the distinct sha256 hashes
// of images that were attached to the note, for the caller to reclaim (see
// deleteNoteDependenciesTx).
func (s *noteStore) DeleteFromTrash(ctx context.Context, id string, userID string) ([]string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	shas, err := deleteNoteDependenciesTx(ctx, tx, s.d, []string{id})
	if err != nil {
		return nil, fmt.Errorf("delete note dependencies: %w", err)
	}

	result, err := tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`DELETE FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL`),
		id, userID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to permanently delete note from trash: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return nil, fmt.Errorf("failed to get rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return nil, ErrNoteNotInTrash
	}

	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit delete from trash: %w", err)
	}
	return shas, nil
}

// EmptyTrash permanently removes all notes the user currently has in the trash.
// It returns the deleted note IDs and their audiences so handlers can publish
// note_deleted SSE events after the transaction commits, plus the distinct
// sha256 hashes of images that were attached to the deleted notes, for the
// caller to reclaim (see deleteNoteDependenciesTx).
func (s *noteStore) EmptyTrash(ctx context.Context, userID string) ([]DeletedNoteAudience, []string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	noteIDs, err := s.getTrashedOwnedNoteIDsTx(ctx, tx, userID)
	if err != nil {
		return nil, nil, fmt.Errorf("get trashed note IDs: %w", err)
	}
	if len(noteIDs) == 0 {
		if err = tx.Commit(); err != nil {
			return nil, nil, fmt.Errorf("failed to commit empty trash transaction: %w", err)
		}
		return []DeletedNoteAudience{}, nil, nil
	}

	audienceMap, err := s.getNoteAudiencesTx(ctx, tx, noteIDs)
	if err != nil {
		return nil, nil, fmt.Errorf("get note audiences: %w", err)
	}

	shas, err := deleteNoteDependenciesTx(ctx, tx, s.d, noteIDs)
	if err != nil {
		return nil, nil, fmt.Errorf("delete note dependencies: %w", err)
	}

	placeholders, args := buildInClauseArgs(noteIDs)
	deleteArgs := make([]any, 0, len(args)+1)
	deleteArgs = append(deleteArgs, userID)
	deleteArgs = append(deleteArgs, args...)

	deleteQuery := `DELETE FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL AND id IN (` + placeholders + `)` // #nosec G202 -- only generated "?" placeholders are concatenated
	result, err := tx.ExecContext(ctx, s.d.RewritePlaceholders(deleteQuery), deleteArgs...)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to empty trash: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return nil, nil, fmt.Errorf("failed to get deleted note count: %w", err)
	}
	if rowsAffected != int64(len(noteIDs)) {
		return nil, nil, fmt.Errorf("expected to delete %d trashed notes, deleted %d", len(noteIDs), rowsAffected)
	}

	deletedNotes := make([]DeletedNoteAudience, 0, len(noteIDs))
	for _, noteID := range noteIDs {
		deletedNotes = append(deletedNotes, DeletedNoteAudience{
			NoteID:      noteID,
			AudienceIDs: audienceMap[noteID],
		})
	}

	if err = tx.Commit(); err != nil {
		return nil, nil, fmt.Errorf("failed to commit empty trash transaction: %w", err)
	}

	return deletedNotes, shas, nil
}

// DeleteAllByUser permanently removes every note owned by the user, regardless
// of state (active, archived, or trashed), along with all dependent rows. It
// returns the number of notes deleted and the distinct sha256 hashes of
// images that were attached to them, for the caller to reclaim (see
// deleteNoteDependenciesTx).
func (s *noteStore) DeleteAllByUser(ctx context.Context, userID string) (int, []string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	rows, err := tx.QueryContext(ctx, s.d.RewritePlaceholders(`SELECT id FROM notes WHERE user_id = ?`), userID)
	if err != nil {
		return 0, nil, fmt.Errorf("failed to query owned notes: %w", err)
	}
	noteIDs, err := collectRows(rows, func(rows *sql.Rows) (string, error) {
		var id string
		return id, rows.Scan(&id)
	})
	if err != nil {
		return 0, nil, fmt.Errorf("failed to scan owned note IDs: %w", err)
	}
	if len(noteIDs) == 0 {
		if err = tx.Commit(); err != nil {
			return 0, nil, fmt.Errorf("failed to commit delete-all transaction: %w", err)
		}
		return 0, nil, nil
	}

	shas, err := deleteNoteDependenciesTx(ctx, tx, s.d, noteIDs)
	if err != nil {
		return 0, nil, fmt.Errorf("delete note dependencies: %w", err)
	}

	if _, err = tx.ExecContext(ctx, s.d.RewritePlaceholders(`DELETE FROM notes WHERE user_id = ?`), userID); err != nil {
		return 0, nil, fmt.Errorf("failed to delete notes: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return 0, nil, fmt.Errorf("failed to commit delete-all transaction: %w", err)
	}

	return len(noteIDs), shas, nil
}

// PurgeOldTrashedNotes permanently deletes all notes that have been in the
// trash longer than the given duration. This is intended to be called
// periodically. It returns the distinct sha256 hashes of images that were
// attached to the purged notes, for the caller to reclaim (see
// deleteNoteDependenciesTx).
func (s *noteStore) PurgeOldTrashedNotes(ctx context.Context, olderThan time.Duration) ([]string, error) {
	cutoff := Now().Add(-olderThan)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	rows, err := tx.QueryContext(ctx, s.d.RewritePlaceholders(`SELECT id FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?`), cutoff)
	if err != nil {
		return nil, fmt.Errorf("failed to query old trashed notes: %w", err)
	}
	noteIDs, err := collectRows(rows, func(rows *sql.Rows) (string, error) {
		var id string
		return id, rows.Scan(&id)
	})
	if err != nil {
		return nil, fmt.Errorf("failed to scan old trashed note IDs: %w", err)
	}
	if len(noteIDs) == 0 {
		if err = tx.Commit(); err != nil {
			return nil, fmt.Errorf("failed to commit purge old trashed notes transaction: %w", err)
		}
		return nil, nil
	}

	shas, err := deleteNoteDependenciesTx(ctx, tx, s.d, noteIDs)
	if err != nil {
		return nil, fmt.Errorf("delete note dependencies: %w", err)
	}

	// Re-check deleted_at here (mirroring EmptyTrash) rather than deleting
	// bare-by-id: noteIDs was read before this transaction took any write
	// locks, so a concurrent RestoreFromTrash could have cleared deleted_at
	// on one of these notes in between. Without the re-check, such a note
	// would still be hard-deleted despite no longer being in the trash.
	placeholders, args := buildInClauseArgs(noteIDs)
	deleteArgs := append([]any{cutoff}, args...)
	deleteQuery := `DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ? AND id IN (` + placeholders + `)` // #nosec G202 -- only generated "?" placeholders are concatenated
	result, err := tx.ExecContext(ctx, s.d.RewritePlaceholders(deleteQuery), deleteArgs...)
	if err != nil {
		return nil, fmt.Errorf("failed to purge old trashed notes: %w", err)
	}

	// If the re-check above skipped a concurrently-restored note, rowsAffected
	// falls short of len(noteIDs): deleteNoteDependenciesTx already dropped
	// that note's items/labels/shares/state unconditionally (it has no
	// deleted_at re-check of its own), so this whole batch must abort rather
	// than commit — otherwise the restored note would silently lose its
	// content while its notes row survives. Aborting is safe: nothing in this
	// batch is lost, it's simply picked up again on the next periodic run.
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return nil, fmt.Errorf("failed to get purged note count: %w", err)
	}
	if rowsAffected != int64(len(noteIDs)) {
		return nil, fmt.Errorf("expected to purge %d trashed notes, purged %d", len(noteIDs), rowsAffected)
	}

	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit purge old trashed notes: %w", err)
	}
	return shas, nil
}
