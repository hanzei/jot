package models

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/hanzei/jot/server/internal/database/dialect"
)

func nullableAssignedTo(s string) sql.NullString {
	return sql.NullString{String: s, Valid: s != ""}
}

// nullableParentID maps an empty string to a SQL NULL (top-level item) and any
// non-empty value to a stored parent reference.
func nullableParentID(s string) sql.NullString {
	return sql.NullString{String: s, Valid: s != ""}
}

// parentIDPtr converts a scanned parent_id into the *string used on NoteItem,
// where nil means the item is top-level.
func parentIDPtr(ns sql.NullString) *string {
	if !ns.Valid {
		return nil
	}
	v := ns.String
	return &v
}

func scanNoteItem(rows *sql.Rows) (NoteItem, error) {
	var item NoteItem
	var assignedTo, parentID sql.NullString
	err := rows.Scan(
		&item.ID, &item.NoteID, &item.Text, &item.Completed,
		&item.Position, &parentID, &assignedTo,
		&item.CreatedAt, &item.UpdatedAt,
	)
	item.AssignedTo = assignedTo.String
	item.ParentID = parentIDPtr(parentID)
	return item, err
}

// validateParentRefTx enforces the grouping invariants for a non-empty
// parentID: the parent must be a different item in the same note that is itself
// top-level (parent_id IS NULL). This caps nesting at one level (no
// grandchildren) and rejects cross-note or self references. An empty parentID
// (top-level) is always valid.
func validateParentRefTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID, itemID, parentID string) error {
	if parentID == "" {
		return nil
	}
	if parentID == itemID {
		return ErrInvalidParentRef
	}
	var parentIsTopLevel bool
	err := tx.QueryRowContext(ctx,
		d.RewritePlaceholders(`SELECT parent_id IS NULL FROM note_items WHERE id = ? AND note_id = ?`),
		parentID, noteID,
	).Scan(&parentIsTopLevel)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrInvalidParentRef
		}
		return fmt.Errorf("validate parent ref: %w", err)
	}
	if !parentIsTopLevel {
		return ErrInvalidParentRef
	}
	// The item being nested must not itself have children, otherwise those
	// children would become grandchildren and break the one-level cap.
	var childCount int
	if err := tx.QueryRowContext(ctx,
		d.RewritePlaceholders(`SELECT COUNT(*) FROM note_items WHERE note_id = ? AND parent_id = ?`),
		noteID, itemID,
	).Scan(&childCount); err != nil {
		return fmt.Errorf("validate parent ref children: %w", err)
	}
	if childCount > 0 {
		return ErrInvalidParentRef
	}
	return nil
}

func (s *noteStore) getItemsByNoteID(ctx context.Context, noteID string) ([]NoteItem, error) {
	// Tiebreak on created_at, id so display order is deterministic even if two
	// items share a position (which can happen transiently after a partial
	// reorder from a client that did not include every item).
	query := s.d.RewritePlaceholders(`SELECT id, note_id, text, completed, position, parent_id,
			  assigned_to, created_at, updated_at
			  FROM note_items WHERE note_id = ? ORDER BY position, created_at, id`)

	rows, err := s.db.QueryContext(ctx, query, noteID)
	if err != nil {
		return nil, fmt.Errorf("failed to get note items: %w", err)
	}

	items, err := collectRows(rows, scanNoteItem)
	if err != nil {
		return nil, fmt.Errorf("failed to scan note items: %w", err)
	}
	return items, nil
}

func (s *noteStore) CreateItemWithCompleted(ctx context.Context, noteID string, text string, position int, completed bool, parentID string, assignedTo string) (*NoteItem, error) {
	itemID, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate item ID: %w", err)
	}

	query := s.d.RewritePlaceholders(`INSERT INTO note_items (id, note_id, text, position, completed, parent_id, assigned_to)
			  VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING created_at, updated_at`)
	var item NoteItem
	err = s.db.QueryRowContext(ctx, query, itemID, noteID, text, position, completed, nullableParentID(parentID),
		nullableAssignedTo(assignedTo),
	).Scan(
		&item.CreatedAt, &item.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create note item: %w", err)
	}

	item.ID = itemID
	item.NoteID = noteID
	item.Text = text
	item.Position = position
	item.Completed = completed
	item.ParentID = parentIDPtr(nullableParentID(parentID))
	item.AssignedTo = assignedTo

	return &item, nil
}

// GetItemForNote returns a single item scoped to its note, or ErrNoteItemNotFound.
func (s *noteStore) GetItemForNote(ctx context.Context, noteID, itemID string) (*NoteItem, error) {
	query := s.d.RewritePlaceholders(`SELECT id, note_id, text, completed, position, parent_id,
			  assigned_to, created_at, updated_at
			  FROM note_items WHERE id = ? AND note_id = ?`)
	var item NoteItem
	var assignedTo, parentID sql.NullString
	err := s.db.QueryRowContext(ctx, query, itemID, noteID).Scan(
		&item.ID, &item.NoteID, &item.Text, &item.Completed,
		&item.Position, &parentID, &assignedTo,
		&item.CreatedAt, &item.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNoteItemNotFound
		}
		return nil, fmt.Errorf("failed to get note item: %w", err)
	}
	item.AssignedTo = assignedTo.String
	item.ParentID = parentIDPtr(parentID)
	return &item, nil
}

// CreateItemWithID inserts a list item using a caller-supplied ID. Returns
// ErrNoteItemExists if an item with that ID already exists, and bumps the
// parent note's updated_at. When maxItems > 0 the note's item count is checked
// inside the transaction and ErrNoteItemCapExceeded is returned if adding the
// item would exceed the cap (atomic, so concurrent creates cannot race past it).
func (s *noteStore) CreateItemWithID(ctx context.Context, noteID, itemID, text string, position int, completed bool, parentID string, assignedTo string, maxItems int) (*NoteItem, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var exists int
	if err = tx.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT COUNT(*) FROM note_items WHERE id = ?`),
		itemID,
	).Scan(&exists); err != nil {
		return nil, fmt.Errorf("failed to check item existence: %w", err)
	}
	if exists > 0 {
		return nil, ErrNoteItemExists
	}

	if maxItems > 0 {
		var count int
		if err = tx.QueryRowContext(ctx,
			s.d.RewritePlaceholders(`SELECT COUNT(*) FROM note_items WHERE note_id = ?`),
			noteID,
		).Scan(&count); err != nil {
			return nil, fmt.Errorf("failed to count note items: %w", err)
		}
		if count >= maxItems {
			return nil, ErrNoteItemCapExceeded
		}
	}

	if err = validateParentRefTx(ctx, tx, s.d, noteID, itemID, parentID); err != nil {
		return nil, err
	}

	var item NoteItem
	if err = tx.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`INSERT INTO note_items (id, note_id, text, position, completed, parent_id, assigned_to)
			  VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING created_at, updated_at`),
		itemID, noteID, text, position, completed, nullableParentID(parentID), nullableAssignedTo(assignedTo),
	).Scan(&item.CreatedAt, &item.UpdatedAt); err != nil {
		return nil, fmt.Errorf("failed to create note item: %w", err)
	}

	if err = touchNoteTx(ctx, tx, s.d, noteID); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit create note item: %w", err)
	}

	item.ID = itemID
	item.NoteID = noteID
	item.Text = text
	item.Position = position
	item.Completed = completed
	item.ParentID = parentIDPtr(nullableParentID(parentID))
	item.AssignedTo = assignedTo
	return &item, nil
}

// PatchItem applies a partial update to a single item. Unset fields are resolved
// against the item's current stored value (read inside the transaction), so a
// concurrent edit to a different column is preserved. Returns the updated item
// or ErrNoteItemNotFound.
func (s *noteStore) PatchItem(ctx context.Context, noteID, itemID string, patch NoteItemPatch) (*NoteItem, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var current NoteItem
	var assignedTo, currentParent sql.NullString
	err = tx.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT id, note_id, text, completed, position, parent_id, assigned_to, created_at
			  FROM note_items WHERE id = ? AND note_id = ?`),
		itemID, noteID,
	).Scan(&current.ID, &current.NoteID, &current.Text, &current.Completed,
		&current.Position, &currentParent, &assignedTo, &current.CreatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNoteItemNotFound
		}
		return nil, fmt.Errorf("failed to load note item: %w", err)
	}
	current.AssignedTo = assignedTo.String

	resolvedText := deref(patch.Text, current.Text)
	resolvedCompleted := deref(patch.Completed, current.Completed)
	resolvedPosition := deref(patch.Position, current.Position)
	resolvedParent := deref(patch.ParentID, currentParent.String)
	resolvedAssignedTo := deref(patch.AssignedTo, current.AssignedTo)

	// Only re-validate the parent when the caller is changing it, so a patch to
	// another field never trips on a parent that became top-level meanwhile.
	if patch.ParentID != nil {
		if err = validateParentRefTx(ctx, tx, s.d, noteID, itemID, resolvedParent); err != nil {
			return nil, err
		}
	}

	var item NoteItem
	if err = tx.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`UPDATE note_items SET text = ?, completed = ?, position = ?, parent_id = ?, assigned_to = ?, updated_at = CURRENT_TIMESTAMP
			  WHERE id = ? AND note_id = ? RETURNING created_at, updated_at`),
		resolvedText, resolvedCompleted, resolvedPosition, nullableParentID(resolvedParent), nullableAssignedTo(resolvedAssignedTo), itemID, noteID,
	).Scan(&item.CreatedAt, &item.UpdatedAt); err != nil {
		return nil, fmt.Errorf("failed to update note item: %w", err)
	}

	// Keep the same parent/child completion invariant as ToggleItemCompleted.
	// Runs whenever completed or parent_id changes: a plain re-parent (no
	// Completed in the request) can just as easily violate the invariant —
	// moving an incomplete child under an already-completed parent — even
	// though this item's own completed flag isn't part of the patch. Cascades
	// off of the item's *resolved* (post-patch) parent and completed value, so
	// a request that changes parent_id and completed together enforces the
	// invariant against the group the item ends up in, not the one it's
	// leaving. This matters in practice: the webapp's autosave diff can send
	// both fields in one patch (e.g. a drag-to-reparent that lands before an
	// in-flight checkbox toggle's own request has advanced the local
	// baseline).
	if patch.Completed != nil || patch.ParentID != nil {
		if err = cascadeItemCompletion(ctx, tx, s.d, noteID, itemID, nullableParentID(resolvedParent), resolvedCompleted); err != nil {
			return nil, err
		}
	}

	if err = touchNoteTx(ctx, tx, s.d, noteID); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit update note item: %w", err)
	}

	item.ID = itemID
	item.NoteID = noteID
	item.Text = resolvedText
	item.Completed = resolvedCompleted
	item.Position = resolvedPosition
	item.ParentID = parentIDPtr(nullableParentID(resolvedParent))
	item.AssignedTo = resolvedAssignedTo
	return &item, nil
}

// DeleteItemFromNote deletes a single item scoped to its note and bumps the
// parent note's updated_at. Returns ErrNoteItemNotFound if no such item exists.
func (s *noteStore) DeleteItemFromNote(ctx context.Context, noteID, itemID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	result, err := tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`DELETE FROM note_items WHERE id = ? AND note_id = ?`),
		itemID, noteID,
	)
	if err != nil {
		return fmt.Errorf("failed to delete note item: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return ErrNoteItemNotFound
	}

	if err = touchNoteTx(ctx, tx, s.d, noteID); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit delete note item: %w", err)
	}
	return nil
}

// ReorderItems sets each item's position to its index in itemIDs. Every ID must
// belong to the note; otherwise ErrNoteItemNotFound is returned and no change is
// committed.
func (s *noteStore) ReorderItems(ctx context.Context, noteID string, itemIDs []string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	for i, itemID := range itemIDs {
		result, execErr := tx.ExecContext(ctx,
			s.d.RewritePlaceholders(`UPDATE note_items SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND note_id = ?`),
			i, itemID, noteID,
		)
		if execErr != nil {
			return fmt.Errorf("failed to reorder note item: %w", execErr)
		}
		n, raErr := result.RowsAffected()
		if raErr != nil {
			return fmt.Errorf("failed to get rows affected: %w", raErr)
		}
		if n == 0 {
			return ErrNoteItemNotFound
		}
	}

	if err = touchNoteTx(ctx, tx, s.d, noteID); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit reorder note items: %w", err)
	}
	return nil
}

// cascadeItemCompletion enforces the checklist invariant that a parent item
// can never be marked completed while one of its children is not: completing a
// top-level item cascades the same value to all of its children (checking or
// unchecking a group never splits it), while unchecking a child also
// un-completes its parent. The reverse does not happen: completing the last
// incomplete child never auto-completes the parent — that still requires
// checking the parent itself. parentID is the item's parent_id as it stood
// before this change.
func cascadeItemCompletion(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID, itemID string, parentID sql.NullString, newCompleted bool) error {
	if !parentID.Valid {
		if _, err := tx.ExecContext(ctx,
			d.RewritePlaceholders(`UPDATE note_items SET completed = ?, updated_at = CURRENT_TIMESTAMP WHERE note_id = ? AND parent_id = ?`),
			newCompleted, noteID, itemID,
		); err != nil {
			return fmt.Errorf("failed to cascade completion to children: %w", err)
		}
		return nil
	}
	if !newCompleted {
		if _, err := tx.ExecContext(ctx,
			d.RewritePlaceholders(`UPDATE note_items SET completed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND note_id = ?`),
			false, parentID.String, noteID,
		); err != nil {
			return fmt.Errorf("failed to cascade completion to parent: %w", err)
		}
	}
	return nil
}

// ToggleItemCompleted sets an item's completed flag and cascades per
// cascadeItemCompletion in a single transaction. It returns the note's full
// item list so callers reconcile every affected item from one response.
// Returns ErrNoteItemNotFound if the item does not belong to the note.
func (s *noteStore) ToggleItemCompleted(ctx context.Context, noteID, itemID string, completed bool) ([]NoteItem, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var parentID sql.NullString
	err = tx.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT parent_id FROM note_items WHERE id = ? AND note_id = ?`),
		itemID, noteID,
	).Scan(&parentID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNoteItemNotFound
		}
		return nil, fmt.Errorf("failed to load note item: %w", err)
	}

	if _, err = tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`UPDATE note_items SET completed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND note_id = ?`),
		completed, itemID, noteID,
	); err != nil {
		return nil, fmt.Errorf("failed to update note item: %w", err)
	}

	if err = cascadeItemCompletion(ctx, tx, s.d, noteID, itemID, parentID, completed); err != nil {
		return nil, err
	}

	if err = touchNoteTx(ctx, tx, s.d, noteID); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit toggle item completed: %w", err)
	}

	return s.getItemsByNoteID(ctx, noteID)
}

// SetItemsCompleted sets the completed flag to the given value on each of the
// named items (that belong to the note) in a single transaction and returns the
// note's full item list so callers reconcile every affected item from one
// response. Each flip applies the same parent/child cascade as
// ToggleItemCompleted (checking/unchecking a top-level item carries to its
// children; unchecking a child un-completes its parent), so the completion
// invariant holds even for an arbitrary ID subset — not just the complete
// snapshot the webapp sends. IDs that do not belong to the note are ignored, so
// a replay/undo referencing a since-deleted item is a no-op. The note's
// updated_at is bumped only when at least one item actually changed.
func (s *noteStore) SetItemsCompleted(ctx context.Context, noteID string, itemIDs []string, completed bool) ([]NoteItem, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var changed int64
	for _, itemID := range itemIDs {
		var parentID sql.NullString
		err = tx.QueryRowContext(ctx,
			s.d.RewritePlaceholders(`SELECT parent_id FROM note_items WHERE id = ? AND note_id = ?`),
			itemID, noteID,
		).Scan(&parentID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				// ID does not belong to the note: ignore it (err is reassigned
				// on the next iteration or by the touch/commit calls below).
				continue
			}
			return nil, fmt.Errorf("failed to load note item: %w", err)
		}

		res, execErr := tx.ExecContext(ctx,
			s.d.RewritePlaceholders(`UPDATE note_items SET completed = ?, updated_at = CURRENT_TIMESTAMP WHERE note_id = ? AND id = ? AND completed != ?`),
			completed, noteID, itemID, completed,
		)
		if execErr != nil {
			return nil, fmt.Errorf("failed to set note item completed: %w", execErr)
		}
		n, raErr := res.RowsAffected()
		if raErr != nil {
			return nil, fmt.Errorf("failed to get rows affected: %w", raErr)
		}
		// Only cascade when this item actually flipped, so a no-op call touches
		// nothing (and a group already consistent is left alone).
		if n > 0 {
			changed += n
			if err = cascadeItemCompletion(ctx, tx, s.d, noteID, itemID, parentID, completed); err != nil {
				return nil, err
			}
		}
	}

	// Only bump the note when something actually changed, so a no-op call does
	// not spuriously reorder the dashboard or emit an update to collaborators.
	if changed > 0 {
		if err = touchNoteTx(ctx, tx, s.d, noteID); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit set items completed: %w", err)
	}

	return s.getItemsByNoteID(ctx, noteID)
}

// DeleteItems removes each of the named items (that belong to the note) in a
// single transaction and returns the note's remaining items so callers reconcile
// from one response. As defense-in-depth against a drifted row, an item orphaned
// by the delete (its parent was among those removed) is re-homed to top level to
// preserve the parent-reference invariant. Positions are left with gaps, matching
// DeleteItemFromNote. IDs that do not belong to the note are ignored. The note's
// updated_at is bumped only when at least one row was actually deleted.
func (s *noteStore) DeleteItems(ctx context.Context, noteID string, itemIDs []string) ([]NoteItem, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var deleted int64
	for _, itemID := range itemIDs {
		res, execErr := tx.ExecContext(ctx,
			s.d.RewritePlaceholders(`DELETE FROM note_items WHERE note_id = ? AND id = ?`),
			noteID, itemID,
		)
		if execErr != nil {
			return nil, fmt.Errorf("failed to delete note item: %w", execErr)
		}
		n, raErr := res.RowsAffected()
		if raErr != nil {
			return nil, fmt.Errorf("failed to get rows affected: %w", raErr)
		}
		deleted += n
	}

	if deleted > 0 {
		// Defense-in-depth: re-home any child whose parent was just removed.
		if _, err = tx.ExecContext(ctx,
			s.d.RewritePlaceholders(`UPDATE note_items SET parent_id = NULL, updated_at = CURRENT_TIMESTAMP
				WHERE note_id = ? AND parent_id IS NOT NULL
				  AND parent_id NOT IN (SELECT id FROM note_items WHERE note_id = ?)`),
			noteID, noteID,
		); err != nil {
			return nil, fmt.Errorf("failed to re-home orphaned note items: %w", err)
		}

		// Only bump the note when something was actually deleted.
		if err = touchNoteTx(ctx, tx, s.d, noteID); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit delete note items: %w", err)
	}

	return s.getItemsByNoteID(ctx, noteID)
}
