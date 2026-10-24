package models

import (
	"cmp"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"
)

// Update applies a partial note update. When u.BaseVersion is non-nil it enables
// optimistic concurrency on the shared content (title/content): the write is
// rejected with ErrNoteVersionConflict unless the note's current version still
// matches u.BaseVersion, so a stale offline edit cannot silently clobber a newer
// change made on another device (issue #489). The version counter is only
// consulted/bumped when title or content is being changed; per-user fields
// (color, pinned, archived, checked_items_collapsed) are never version-guarded,
// since they live in note_user_state and differ per collaborator.
//
// Every write is decided against the row as stored when it runs, never against
// an earlier read: columns are written as COALESCE(new, column), so a field the
// caller did not send keeps whatever a concurrent update put there, and the
// no-op and pin-flip checks are guards in the UPDATE statements themselves.
func (s *noteStore) Update(ctx context.Context, id string, userID string, u NoteUpdate) error {
	hasAccess, err := s.HasAccess(ctx, id, userID)
	if err != nil {
		return fmt.Errorf("failed to check access: %w", err)
	}
	if !hasAccess {
		return ErrNoteNoAccess
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	now := Timestamp(Now())

	if u.Title != nil || u.Content != nil {
		if err = s.changeNoteContentTx(ctx, tx, id, userID, u.Title, u.Content, u.BaseVersion, now); err != nil {
			return err
		}
	}

	// Per-user fields live in note_user_state.
	if u.Pinned != nil {
		if err = s.setPinnedTx(ctx, tx, id, userID, *u.Pinned); err != nil {
			return err
		}
	}

	result, err := tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`UPDATE note_user_state SET archived = COALESCE(?, archived),
		 color = COALESCE(?, color), checked_items_collapsed = COALESCE(?, checked_items_collapsed), updated_at = ?
		 WHERE note_id = ? AND user_id = ?`),
		u.Archived, u.Color, u.CheckedItemsCollapsed, now, id, userID,
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

	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit note update: %w", err)
	}
	return nil
}

// setPinnedTx sets userID's pin flag on the note with a guarded statement, and
// moves the note's position only when the stored row actually flipped, so a
// repeated pin or unpin never repositions it twice.
func (s *noteStore) setPinnedTx(ctx context.Context, tx *sql.Tx, id, userID string, pinned bool) error {
	result, err := tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`UPDATE note_user_state SET pinned = ? WHERE note_id = ? AND user_id = ? AND pinned <> ?`),
		pinned, id, userID, pinned,
	)
	if err != nil {
		return fmt.Errorf("update note pin state: %w", err)
	}
	flipped, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("get pin rows affected: %w", err)
	}
	if flipped == 0 {
		return nil
	}
	if err = s.handlePinStatusChangeTx(ctx, tx, id, userID, pinned); err != nil {
		return fmt.Errorf("handle pin status change: %w", err)
	}
	return nil
}

// changeNoteContentTx writes userID's title/content change, which records it
// for unread tracking, and marks the note viewed by userID. A no-op or an
// idempotent replay wrote nothing, so it is not this user's change (mirrors
// ConvertType's alreadyApplied check).
func (s *noteStore) changeNoteContentTx(ctx context.Context, tx *sql.Tx, id, userID string, title, content *string, baseVersion *int, now string) error {
	applied, err := s.updateNoteContentTx(ctx, tx, id, userID, title, content, baseVersion, now)
	if err != nil || !applied {
		return err
	}
	return markViewedTx(ctx, tx, s.d, id, userID, now)
}

// updateNoteContentTx updates title and/or content (a nil one is left as
// stored) and bumps version inside tx, but only when a provided value differs
// from the stored one: skipping a no-op (e.g. an editor autosave that resends
// unchanged content) avoids a spurious version bump that would invalidate
// other devices' base_version. When baseVersion is non-nil the write is also
// gated on the current version.
//
// Zero rows affected means the note is gone (ErrNoteNotFound), the provided
// values are already stored (applied == false, nil), or — only with
// baseVersion — the version guard failed (ErrNoteVersionConflict).
func (s *noteStore) updateNoteContentTx(ctx context.Context, tx *sql.Tx, id, actorID string, title, content *string, baseVersion *int, now string) (applied bool, err error) {
	query := `UPDATE notes SET title = COALESCE(?, title), content = COALESCE(?, content), version = version + 1, updated_at = ?, ` + contentChangedSet +
		` WHERE id = ? AND deleted_at IS NULL AND (title <> COALESCE(?, title) OR content <> COALESCE(?, content))`
	args := append(appendContentChangedArgs([]any{title, content, now}, now, actorID), id, title, content)
	if baseVersion != nil {
		query += ` AND version = ?`
		args = append(args, *baseVersion)
	}
	result, err := tx.ExecContext(ctx, s.d.RewritePlaceholders(query), args...)
	if err != nil {
		return false, fmt.Errorf("failed to update note: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("failed to get rows affected: %w", err)
	}
	if rows > 0 {
		return true, nil
	}

	var currentTitle, currentContent string
	err = tx.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT title, content FROM notes WHERE id = ? AND deleted_at IS NULL`),
		id,
	).Scan(&currentTitle, &currentContent)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, ErrNoteNotFound
		}
		return false, fmt.Errorf("get current note content: %w", err)
	}
	// Without a version guard only the no-op guard can have stopped the write.
	// A version-guarded write whose values another write already stored is an
	// idempotent replay, not a conflict.
	if baseVersion == nil || (deref(title, currentTitle) == currentTitle && deref(content, currentContent) == currentContent) {
		return false, nil
	}
	return false, ErrNoteVersionConflict
}

// ConvertType changes a note's type in place, replacing its content
// representation (text content <-> title+items) while preserving its ID,
// labels, shares, and per-user state (pin/archive/color/position). The
// caller (handler) supplies the precomputed title/content/items — this method
// only validates access and persists them atomically. title and targetItems
// apply only when targetType is NoteTypeList (a text note has neither, so the
// title is cleared and the item delete is a no-op in that direction); existing
// items are deleted regardless of direction.
func (s *noteStore) ConvertType(ctx context.Context, id, userID string, targetType NoteType, title, content string, targetItems []NewNoteItem, baseVersion *int) (*Note, error) {
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

	now := Timestamp(Now())

	alreadyApplied, err := s.convertNoteRowTx(ctx, tx, id, userID, targetType, title, content, targetItems, baseVersion, now)
	if err != nil {
		return nil, err
	}

	if !alreadyApplied {
		if _, err = tx.ExecContext(ctx, s.d.RewritePlaceholders(`DELETE FROM note_items WHERE note_id = ?`), id); err != nil {
			return nil, fmt.Errorf("delete note items for conversion: %w", err)
		}
		if targetType == NoteTypeList {
			if err = insertNewNoteItemsTx(ctx, tx, s.d, id, targetItems, now); err != nil {
				return nil, fmt.Errorf("insert converted items: %w", err)
			}
		}
		if err = markViewedTx(ctx, tx, s.d, id, userID, now); err != nil {
			return nil, err
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
func (s *noteStore) convertNoteRowTx(ctx context.Context, tx *sql.Tx, id, actorID string, targetType NoteType, title, content string, targetItems []NewNoteItem, baseVersion *int, now string) (alreadyApplied bool, err error) {
	// deleted_at IS NULL guards against a concurrent trash landing between the
	// HasAccess check in ConvertType and this UPDATE.
	query := `UPDATE notes SET title = ?, content = ?, note_type = ?, version = version + 1, updated_at = ?, ` + contentChangedSet + ` WHERE id = ? AND deleted_at IS NULL`
	args := append(appendContentChangedArgs([]any{title, content, targetType, now}, now, actorID), id)
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
	// and title/content/items, not just type — a differently-timed concurrent
	// conversion could otherwise be mistaken for this caller's own result); if
	// so, treat it as a no-op success rather than a conflict (mirrors
	// updateNoteContentTx's idempotent-replay handling).
	matches, err := s.conversionAlreadyAppliedTx(ctx, tx, id, targetType, title, content, targetItems)
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
// (for a text target) or targetType/title/targetItems (for a list target).
func (s *noteStore) conversionAlreadyAppliedTx(ctx context.Context, tx *sql.Tx, id string, targetType NoteType, title, content string, targetItems []NewNoteItem) (bool, error) {
	var currentType NoteType
	var currentTitle, currentContent string
	err := tx.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT note_type, title, content FROM notes WHERE id = ? AND deleted_at IS NULL`),
		id,
	).Scan(&currentType, &currentTitle, &currentContent)
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
	// A list target carries a title, so two conversions that produce the same
	// items from differently titled content are not the same conversion.
	if currentTitle != title {
		return false, nil
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
	// currentItems came back ORDER BY position, and were stored grouped
	// (normalizeItemOrderTx); targetItems is whatever order the caller built it
	// in, so put a copy in the same order before the index-wise comparison
	// below — otherwise out-of-order input falsely reports a mismatch (or,
	// worse, a spurious match).
	for i, item := range groupedNewNoteItems(targetItems) {
		if currentItems[i].Text != item.Text || currentItems[i].Completed != item.Completed {
			return false, nil
		}
	}
	return true, nil
}

// groupedNewNoteItems returns items in the order they are stored in once
// inserted: by position, then grouped per groupedItemOrder. Items inserted
// together share created_at, so itemReadOrder breaks a position tie by ID.
func groupedNewNoteItems(items []NewNoteItem) []NewNoteItem {
	rows := make([]itemOrderRow, len(items))
	for i, item := range items {
		rows[i] = itemOrderRow{id: item.ID, position: item.Position, parentID: nullableParentID(item.ParentID), ref: i}
	}
	slices.SortStableFunc(rows, func(a, b itemOrderRow) int {
		return cmp.Or(cmp.Compare(a.position, b.position), strings.Compare(a.id, b.id))
	})

	grouped := make([]NewNoteItem, 0, len(items))
	for _, r := range groupedItemOrder(rows) {
		grouped = append(grouped, items[r.ref])
	}
	return grouped
}

// handlePinStatusChangeTx updates note positions when a note is pinned or unpinned within a transaction.
// Both read the note's stored positions inside tx rather than taking them from
// an earlier, possibly stale, read.
func (s *noteStore) handlePinStatusChangeTx(ctx context.Context, tx *sql.Tx, id, ownerID string, nowPinned bool) error {
	if nowPinned {
		return s.handlePinningTx(ctx, tx, id, ownerID)
	}
	return s.handleUnpinningTx(ctx, tx, id, ownerID)
}

// handlePinningTx stores the current position as unpinned_position and moves the note to the end of the pinned list.
func (s *noteStore) handlePinningTx(ctx context.Context, tx *sql.Tx, id, userID string) error {
	var maxPosition int
	posQuery := s.d.RewritePlaceholders(`SELECT COALESCE(MAX(nus.position), -1)
	             FROM note_user_state nus
	             INNER JOIN notes n ON nus.note_id = n.id AND n.deleted_at IS NULL
	             WHERE nus.user_id = ? AND nus.pinned = TRUE AND nus.archived = FALSE AND nus.note_id != ?`)
	if err := tx.QueryRowContext(ctx, posQuery, userID, id).Scan(&maxPosition); err != nil {
		return fmt.Errorf("failed to get max position: %w", err)
	}

	if _, err := tx.ExecContext(ctx,
		// unpinned_position = position reads the pre-update value: SET
		// expressions all see the row as it was before the statement.
		s.d.RewritePlaceholders(`UPDATE note_user_state SET position = ?, unpinned_position = position WHERE note_id = ? AND user_id = ?`),
		maxPosition+1, id, userID,
	); err != nil {
		return fmt.Errorf("failed to update position: %w", err)
	}
	return nil
}

// handleUnpinningTx restores the note to its saved unpinned_position, or appends it to the end of the unpinned list.
func (s *noteStore) handleUnpinningTx(ctx context.Context, tx *sql.Tx, id, userID string) error {
	var unpinnedPosition *int
	if err := tx.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT unpinned_position FROM note_user_state WHERE note_id = ? AND user_id = ?`),
		id, userID,
	).Scan(&unpinnedPosition); err != nil {
		return fmt.Errorf("get unpinned position: %w", err)
	}

	var targetPosition int
	if unpinnedPosition != nil {
		targetPosition = *unpinnedPosition

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
