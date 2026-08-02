package models

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
)

// Update applies a partial note update. When baseVersion is non-nil it enables
// optimistic concurrency on the shared content (title/content): the write is
// rejected with ErrNoteVersionConflict unless the note's current version still
// matches baseVersion, so a stale offline edit cannot silently clobber a newer
// change made on another device (issue #489). The version counter is only
// consulted/bumped when title or content is being changed; per-user fields
// (color, pinned, archived, checked_items_collapsed) are never version-guarded,
// since they live in note_user_state and differ per collaborator.
func (s *noteStore) Update(ctx context.Context, id string, userID string, title, content, color *string, pinned, archived, checkedItemsCollapsed *bool, baseVersion *int) error {
	hasAccess, err := s.HasAccess(ctx, id, userID)
	if err != nil {
		return fmt.Errorf("failed to check access: %w", err)
	}
	if !hasAccess {
		return ErrNoteNoAccess
	}

	// Get current note state (per-user view) to merge partial updates and detect pin changes.
	currentNote, err := s.GetByID(ctx, id, userID)
	if err != nil {
		return fmt.Errorf("failed to get current note: %w", err)
	}

	resolvedTitle := deref(title, currentNote.Title)
	resolvedContent := deref(content, currentNote.Content)
	resolvedColor := deref(color, currentNote.Color)
	resolvedPinned := deref(pinned, currentNote.Pinned)
	resolvedArchived := deref(archived, currentNote.Archived)
	resolvedCheckedItemsCollapsed := deref(checkedItemsCollapsed, currentNote.CheckedItemsCollapsed)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Only touch the shared fields (title/content) when the caller provided at
	// least one AND it actually differs from the stored value. Skipping a no-op
	// (e.g. an editor autosave that resends unchanged content) avoids a spurious
	// version bump that would invalidate other devices' base_version, and avoids
	// overwriting concurrent edits when only per-user fields are changing.
	contentChanged := (title != nil || content != nil) &&
		(resolvedTitle != currentNote.Title || resolvedContent != currentNote.Content)
	if contentChanged {
		if err = s.updateNoteContentTx(ctx, tx, id, resolvedTitle, resolvedContent, baseVersion); err != nil {
			return err
		}
	}

	// Per-user fields live in note_user_state.
	result, err := tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`UPDATE note_user_state SET pinned = ?, archived = ?, color = ?, checked_items_collapsed = ?, updated_at = CURRENT_TIMESTAMP
		 WHERE note_id = ? AND user_id = ?`),
		resolvedPinned, resolvedArchived, resolvedColor, resolvedCheckedItemsCollapsed, id, userID,
	)
	if err != nil {
		return fmt.Errorf("failed to update note user state: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return ErrNoteNotFound
	}

	if currentNote.Pinned != resolvedPinned {
		if err = s.handlePinStatusChangeTx(ctx, tx, id, userID, currentNote, resolvedPinned); err != nil {
			return fmt.Errorf("handle pin status change: %w", err)
		}
	}

	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit note update: %w", err)
	}
	return nil
}

// updateNoteContentTx updates title, content, and version inside tx. When baseVersion is non-nil
// the write is gated on the current version; on a version mismatch (zero rows affected) it re-reads
// the current title/content: if they already match the requested values it returns nil (idempotent
// success), otherwise ErrNoteVersionConflict.
func (s *noteStore) updateNoteContentTx(ctx context.Context, tx *sql.Tx, id, title, content string, baseVersion *int) error {
	query := `UPDATE notes SET title = ?, content = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
	args := []any{title, content, id}
	if baseVersion != nil {
		query += ` AND version = ?`
		args = append(args, *baseVersion)
	}
	result, err := tx.ExecContext(ctx, s.d.RewritePlaceholders(query), args...)
	if err != nil {
		return fmt.Errorf("failed to update note: %w", err)
	}
	if baseVersion == nil {
		return nil
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}
	// Zero rows means the version guard did not match. Re-read to check whether the
	// winning write already applied the same title/content; if so, treat this as a
	// no-op success rather than a conflict, since the desired state is already present.
	if rows == 0 {
		var currentTitle, currentContent string
		err = tx.QueryRowContext(ctx,
			s.d.RewritePlaceholders(`SELECT title, content FROM notes WHERE id = ? AND deleted_at IS NULL`),
			id,
		).Scan(&currentTitle, &currentContent)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrNoteNotFound
			}
			return fmt.Errorf("get current note content: %w", err)
		}
		if currentTitle == title && currentContent == content {
			return nil
		}
		return ErrNoteVersionConflict
	}
	return nil
}

// ConvertType changes a note's type in place, replacing its content
// representation (text content <-> title+items) while preserving its ID,
// labels, shares, and per-user state (pin/archive/color/position). The
// caller (handler) supplies the precomputed content/items — this method only
// validates access and persists them atomically. targetItems is inserted
// only when targetType is NoteTypeList; any existing items are deleted
// regardless of direction (a text note has none, so the delete is a no-op in
// that direction).
func (s *noteStore) ConvertType(ctx context.Context, id, userID string, targetType NoteType, content string, targetItems []NewNoteItem, baseVersion *int) (*Note, error) {
	if !targetType.Valid() {
		return nil, ErrInvalidNoteType
	}

	hasAccess, err := s.HasAccess(ctx, id, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to check access: %w", err)
	}
	if !hasAccess {
		return nil, ErrNoteNoAccess
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	alreadyApplied, err := s.convertNoteRowTx(ctx, tx, id, targetType, content, targetItems, baseVersion)
	if err != nil {
		return nil, err
	}

	if !alreadyApplied {
		if _, err = tx.ExecContext(ctx, s.d.RewritePlaceholders(`DELETE FROM note_items WHERE note_id = ?`), id); err != nil {
			return nil, fmt.Errorf("delete note items for conversion: %w", err)
		}
		if targetType == NoteTypeList {
			for _, item := range targetItems {
				if err = insertNewNoteItemTx(ctx, tx, s.d, id, item); err != nil {
					return nil, fmt.Errorf("insert converted item: %w", err)
				}
			}
		}
	}

	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("failed to commit note conversion: %w", err)
	}

	converted, err := s.GetByID(ctx, id, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to load converted note: %w", err)
	}
	return converted, nil
}

// convertNoteRowTx updates the notes row's title/content/note_type/version for
// a type conversion inside tx. alreadyApplied is true when a concurrent write
// already committed this exact conversion (detected via the idempotent-replay
// check below); the caller should then skip re-touching note_items and just
// commit, since the winning write already did that atomically.
func (s *noteStore) convertNoteRowTx(ctx context.Context, tx *sql.Tx, id string, targetType NoteType, content string, targetItems []NewNoteItem, baseVersion *int) (alreadyApplied bool, err error) {
	// deleted_at IS NULL guards against a concurrent trash landing between the
	// HasAccess check in ConvertType and this UPDATE.
	query := `UPDATE notes SET title = '', content = ?, note_type = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL`
	args := []any{content, targetType, id}
	if baseVersion != nil {
		query += ` AND version = ?`
		args = append(args, *baseVersion)
	}
	result, err := tx.ExecContext(ctx, s.d.RewritePlaceholders(query), args...)
	if err != nil {
		return false, fmt.Errorf("failed to update note for conversion: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("failed to get rows affected: %w", err)
	}
	if rows > 0 {
		return false, nil
	}
	if baseVersion == nil {
		return false, ErrNoteNotFound
	}

	// Zero rows means the version guard did not match. Re-read to check whether a
	// concurrent write already applied this *exact* conversion (matching type
	// and content/items, not just type — a differently-timed concurrent
	// conversion could otherwise be mistaken for this caller's own result); if
	// so, treat it as a no-op success rather than a conflict (mirrors
	// updateNoteContentTx's idempotent-replay handling).
	matches, err := s.conversionAlreadyAppliedTx(ctx, tx, id, targetType, content, targetItems)
	if err != nil {
		return false, err
	}
	if !matches {
		return false, ErrNoteVersionConflict
	}
	return true, nil
}

// conversionAlreadyAppliedTx reports whether the note currently stored at id
// already matches the exact conversion result described by targetType/content
// (for a text target) or targetItems (for a list target).
func (s *noteStore) conversionAlreadyAppliedTx(ctx context.Context, tx *sql.Tx, id string, targetType NoteType, content string, targetItems []NewNoteItem) (bool, error) {
	var currentType NoteType
	var currentContent string
	err := tx.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT note_type, content FROM notes WHERE id = ? AND deleted_at IS NULL`),
		id,
	).Scan(&currentType, &currentContent)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, ErrNoteNotFound
		}
		return false, fmt.Errorf("get current note: %w", err)
	}
	if currentType != targetType {
		return false, nil
	}
	if targetType == NoteTypeText {
		return currentContent == content, nil
	}

	rows, err := tx.QueryContext(ctx,
		s.d.RewritePlaceholders(`SELECT text, completed FROM note_items WHERE note_id = ? ORDER BY position`),
		id,
	)
	if err != nil {
		return false, fmt.Errorf("get current note items: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var currentItems []NewNoteItem
	for rows.Next() {
		var item NewNoteItem
		if err := rows.Scan(&item.Text, &item.Completed); err != nil {
			return false, fmt.Errorf("scan current note item: %w", err)
		}
		currentItems = append(currentItems, item)
	}
	if err := rows.Err(); err != nil {
		return false, fmt.Errorf("iterate current note items: %w", err)
	}

	if len(currentItems) != len(targetItems) {
		return false, nil
	}
	// currentItems came back ORDER BY position; targetItems is whatever order
	// the caller built it in, so sort a copy the same way before the
	// index-wise comparison below — otherwise out-of-position-order input
	// falsely reports a mismatch (or, worse, a spurious match).
	sortedTargetItems := make([]NewNoteItem, len(targetItems))
	copy(sortedTargetItems, targetItems)
	slices.SortStableFunc(sortedTargetItems, func(a, b NewNoteItem) int { return a.Position - b.Position })
	for i, item := range sortedTargetItems {
		if currentItems[i].Text != item.Text || currentItems[i].Completed != item.Completed {
			return false, nil
		}
	}
	return true, nil
}

// handlePinStatusChangeTx updates note positions when a note is pinned or unpinned within a transaction.
func (s *noteStore) handlePinStatusChangeTx(ctx context.Context, tx *sql.Tx, id, ownerID string, currentNote *Note, nowPinned bool) error {
	if nowPinned {
		return s.handlePinningTx(ctx, tx, id, ownerID, currentNote)
	}
	return s.handleUnpinningTx(ctx, tx, id, ownerID, currentNote)
}

// handlePinningTx stores the current position as unpinned_position and moves the note to the end of the pinned list.
func (s *noteStore) handlePinningTx(ctx context.Context, tx *sql.Tx, id, userID string, currentNote *Note) error {
	var maxPosition int
	posQuery := s.d.RewritePlaceholders(`SELECT COALESCE(MAX(nus.position), -1)
	             FROM note_user_state nus
	             INNER JOIN notes n ON nus.note_id = n.id AND n.deleted_at IS NULL
	             WHERE nus.user_id = ? AND nus.pinned = TRUE AND nus.archived = FALSE AND nus.note_id != ?`)
	if err := tx.QueryRowContext(ctx, posQuery, userID, id).Scan(&maxPosition); err != nil {
		return fmt.Errorf("failed to get max position: %w", err)
	}

	if _, err := tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`UPDATE note_user_state SET position = ?, unpinned_position = ? WHERE note_id = ? AND user_id = ?`),
		maxPosition+1, currentNote.Position, id, userID,
	); err != nil {
		return fmt.Errorf("failed to update position: %w", err)
	}
	return nil
}

// handleUnpinningTx restores the note to its saved unpinned_position, or appends it to the end of the unpinned list.
func (s *noteStore) handleUnpinningTx(ctx context.Context, tx *sql.Tx, id, userID string, currentNote *Note) error {
	var targetPosition int

	if currentNote.UnpinnedPosition != nil {
		targetPosition = *currentNote.UnpinnedPosition

		// Shift other unpinned notes to make room
		if _, err := tx.ExecContext(ctx,
			s.d.RewritePlaceholders(`UPDATE note_user_state SET position = position + 1
			 WHERE user_id = ? AND pinned = FALSE AND archived = FALSE
			 AND note_id IN (SELECT id FROM notes WHERE deleted_at IS NULL)
			 AND note_id != ? AND position >= ?`),
			userID, id, targetPosition,
		); err != nil {
			return fmt.Errorf("failed to shift notes: %w", err)
		}
	} else {
		// No saved position, add to end
		var maxPosition int
		posQuery := s.d.RewritePlaceholders(`SELECT COALESCE(MAX(nus.position), -1)
		             FROM note_user_state nus
		             INNER JOIN notes n ON nus.note_id = n.id AND n.deleted_at IS NULL
		             WHERE nus.user_id = ? AND nus.pinned = FALSE AND nus.archived = FALSE AND nus.note_id != ?`)
		if err := tx.QueryRowContext(ctx, posQuery, userID, id).Scan(&maxPosition); err != nil {
			return fmt.Errorf("failed to get max position: %w", err)
		}
		targetPosition = maxPosition + 1
	}

	if _, err := tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`UPDATE note_user_state SET position = ?, unpinned_position = NULL WHERE note_id = ? AND user_id = ?`),
		targetPosition, id, userID,
	); err != nil {
		return fmt.Errorf("failed to update position: %w", err)
	}
	return nil
}

// Delete permanently removes an active (non-trashed) note owned by userID. It
// returns the distinct sha256 hashes of images that were attached to the note
// so the caller can reclaim their blobs (note_images rows cascade-delete with
// the note; the cascade drops the DB rows but never touches the on-disk
// blobs, so that's on the caller).
func (s *noteStore) Delete(ctx context.Context, id string, userID string) ([]string, error) {
	isOwner, err := s.IsOwner(ctx, id, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to check ownership: %w", err)
	}
	if !isOwner {
		return nil, ErrNoteNotOwnedByUser
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	shas, err := deleteNoteDependenciesTx(ctx, tx, s.d, []string{id})
	if err != nil {
		return nil, fmt.Errorf("delete note dependencies: %w", err)
	}

	result, err := tx.ExecContext(ctx, s.d.RewritePlaceholders("DELETE FROM notes WHERE id = ? AND user_id = ?"), id, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to delete note: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return nil, fmt.Errorf("failed to get rows affected: %w", err)
	}

	if rowsAffected == 0 {
		return nil, ErrNoteNotOwnedByUser
	}

	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit note delete: %w", err)
	}
	return shas, nil
}
