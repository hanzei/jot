package models

import (
	"context"
	"database/sql"
	"fmt"
	"slices"

	"github.com/hanzei/jot/server/internal/database/dialect"
	"github.com/hanzei/jot/server/internal/labelfold"
)

// Create inserts a new note for the user. When noteID is empty the server
// generates one; when non-empty the caller-supplied ID is used as the note's
// primary key so an offline create can be replayed idempotently. Returns
// ErrNoteExists if a note with that ID already exists (e.g. a replayed create
// whose original request already committed).
func (s *noteStore) Create(ctx context.Context, userID, noteID, title, content string, noteType NoteType, color string) (*Note, error) {
	return s.CreateWithItems(ctx, userID, noteID, title, content, noteType, color, nil)
}

// CreateWithItems creates a note, its owner note_user_state, and all provided
// list items in a single transaction, so any failure (a duplicate item ID, an
// invalid parent ref, a DB error) rolls back the whole operation instead of
// leaving an orphaned or partially-populated note. items must already be
// validated and have their ParentID resolved to item IDs within this note.
// Returns ErrNoteExists if the note ID is taken, and ErrNoteItemExists /
// ErrInvalidParentRef for the corresponding item-level conflicts.
func (s *noteStore) CreateWithItems(ctx context.Context, userID, noteID, title, content string, noteType NoteType, color string, items []NewNoteItem) (*Note, error) {
	if !noteType.Valid() {
		return nil, ErrInvalidNoteType
	}

	if noteID == "" {
		var err error
		noteID, err = generateID()
		if err != nil {
			return nil, fmt.Errorf("failed to generate note ID: %w", err)
		}
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Reject a duplicate caller-supplied ID up front so a replayed create returns
	// ErrNoteExists (mapped to 409) instead of a raw primary-key violation.
	var exists int
	if err = tx.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT COUNT(*) FROM notes WHERE id = ?`),
		noteID,
	).Scan(&exists); err != nil {
		return nil, fmt.Errorf("failed to check note existence: %w", err)
	}
	if exists > 0 {
		return nil, ErrNoteExists
	}

	// Shift existing unpinned notes down to make room at position 0.
	if _, err = tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`UPDATE note_user_state SET position = position + 1
		 WHERE user_id = ? AND pinned = FALSE AND archived = FALSE
		 AND note_id IN (SELECT id FROM notes WHERE deleted_at IS NULL)`),
		userID,
	); err != nil {
		return nil, fmt.Errorf("failed to shift existing notes: %w", err)
	}

	nextPosition := 0
	now := Timestamp(Now())

	var note Note
	if err = tx.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`INSERT INTO notes (id, user_id, title, content, note_type, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING created_at, updated_at`),
		noteID, userID, title, content, noteType, now, now,
	).Scan(&note.CreatedAt, &note.UpdatedAt); err != nil {
		// Two concurrent creates with the same caller-supplied ID can both pass the
		// existence check above (neither sees the other's uncommitted insert), so
		// map the primary-key violation to ErrNoteExists to preserve 409 idempotency.
		if s.d.IsUniqueConstraintError(err) {
			return nil, ErrNoteExists
		}
		return nil, fmt.Errorf("failed to create note: %w", err)
	}

	if _, err = tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`INSERT INTO note_user_state (note_id, user_id, color, pinned, archived, position, unpinned_position, checked_items_collapsed, created_at, updated_at)
		 VALUES (?, ?, ?, FALSE, FALSE, ?, ?, FALSE, ?, ?)`),
		noteID, userID, color, nextPosition, nextPosition, now, now,
	); err != nil {
		return nil, fmt.Errorf("failed to create note user state: %w", err)
	}

	for _, item := range items {
		if err = insertNewNoteItemTx(ctx, tx, s.d, noteID, item, now); err != nil {
			return nil, err
		}
	}

	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("failed to commit note creation: %w", err)
	}

	note.ID = noteID
	note.UserID = userID
	note.Title = title
	note.Content = content
	note.NoteType = noteType
	note.Version = 1
	note.Color = color
	note.Position = nextPosition
	note.UnpinnedPosition = &nextPosition
	note.CheckedItemsCollapsed = false
	note.Labels = []Label{}

	return &note, nil
}

// insertNewNoteItemTx inserts one list item during note creation within tx. A
// supplied ID is existence-checked (ErrNoteItemExists on collision); an empty
// ID is generated server-side. The parent ref is validated against items
// already inserted in this note.
func insertNewNoteItemTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID string, item NewNoteItem, now string) error {
	itemID := item.ID
	if itemID == "" {
		var err error
		itemID, err = generateID()
		if err != nil {
			return fmt.Errorf("failed to generate item ID: %w", err)
		}
	} else {
		var exists int
		if err := tx.QueryRowContext(ctx,
			d.RewritePlaceholders(`SELECT COUNT(*) FROM note_items WHERE id = ?`),
			itemID,
		).Scan(&exists); err != nil {
			return fmt.Errorf("failed to check item existence: %w", err)
		}
		if exists > 0 {
			return ErrNoteItemExists
		}
	}

	if err := validateParentRefTx(ctx, tx, d, noteID, itemID, item.ParentID); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx,
		d.RewritePlaceholders(`INSERT INTO note_items (id, note_id, text, position, completed, parent_id, assigned_to, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		itemID, noteID, item.Text, item.Position, item.Completed, nullableParentID(item.ParentID), nullableAssignedTo(""), now, now,
	); err != nil {
		// Concurrent replays with the same client-supplied ID can both pass the
		// existence check above; map the constraint violation to ErrNoteItemExists.
		if item.ID != "" && d.IsUniqueConstraintError(err) {
			return ErrNoteItemExists
		}
		return fmt.Errorf("failed to create note item: %w", err)
	}
	return nil
}

func duplicateNoteTitle(title string) string {
	return "Copy of " + title
}

// Duplicate creates a copy of source owned by userID. When clientID is non-empty
// it is used as the new note's primary key so the operation is idempotent on
// replay; when empty a server-side ID is generated. Returns ErrNoteExists when
// clientID is already taken (e.g. a replayed duplicate whose original committed).
// itemIDs maps each source item ID to the caller-supplied new item ID; entries
// missing from the map fall back to server-side generation.
func (s *noteStore) Duplicate(ctx context.Context, source *Note, userID, clientID string, itemIDs map[string]string) (*Note, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	noteID := clientID
	if noteID == "" {
		noteID, err = generateID()
		if err != nil {
			return nil, fmt.Errorf("failed to generate note ID: %w", err)
		}
	} else {
		// Reject a duplicate caller-supplied ID up front so a replayed duplicate
		// returns ErrNoteExists (mapped to 409) instead of a raw constraint error.
		var exists int
		if err = tx.QueryRowContext(ctx,
			s.d.RewritePlaceholders(`SELECT COUNT(*) FROM notes WHERE id = ?`),
			noteID,
		).Scan(&exists); err != nil {
			return nil, fmt.Errorf("failed to check note existence: %w", err)
		}
		if exists > 0 {
			return nil, ErrNoteExists
		}
	}

	if _, err = tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`UPDATE note_user_state SET position = position + 1
		 WHERE user_id = ? AND pinned = FALSE AND archived = FALSE
		 AND note_id IN (SELECT id FROM notes WHERE deleted_at IS NULL)`),
		userID,
	); err != nil {
		return nil, fmt.Errorf("failed to shift existing notes: %w", err)
	}

	const nextPosition = 0
	now := Timestamp(Now())
	if _, err = tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`INSERT INTO notes (id, user_id, title, content, note_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`),
		noteID,
		userID,
		duplicateNoteTitle(source.Title),
		source.Content,
		source.NoteType,
		now,
		now,
	); err != nil {
		// Two concurrent duplicates with the same caller-supplied ID can both pass
		// the existence check above; map the constraint violation to ErrNoteExists.
		if clientID != "" && s.d.IsUniqueConstraintError(err) {
			return nil, ErrNoteExists
		}
		return nil, fmt.Errorf("failed to create duplicated note: %w", err)
	}

	if _, err = tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`INSERT INTO note_user_state (note_id, user_id, color, pinned, archived, position, unpinned_position, checked_items_collapsed, created_at, updated_at)
		 VALUES (?, ?, ?, FALSE, FALSE, ?, ?, ?, ?, ?)`),
		noteID, userID, source.Color, nextPosition, nextPosition, source.CheckedItemsCollapsed, now, now,
	); err != nil {
		return nil, fmt.Errorf("failed to create duplicated note user state: %w", err)
	}

	if err = duplicateItemsTx(ctx, tx, s.d, noteID, source.Items, itemIDs, now); err != nil {
		return nil, fmt.Errorf("duplicate note items: %w", err)
	}

	if err = duplicateLabelsTx(ctx, tx, s.d, noteID, userID, source.Labels, now); err != nil {
		return nil, fmt.Errorf("duplicate note labels: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("failed to commit duplicate note transaction: %w", err)
	}

	duplicated, err := s.GetByID(ctx, noteID, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to load duplicated note: %w", err)
	}

	return duplicated, nil
}

func duplicateItemsTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID string, items []NoteItem, itemIDs map[string]string, now string) error {
	// Insert parents before their children so each child's remapped parent_id is
	// already in idMap (and satisfies the parent_id foreign key). Position order
	// alone is not enough — a client reorder can leave a child at a lower position
	// than its parent — so order by parent-chain depth first, breaking ties by
	// position for stability.
	ordered := orderItemsParentsFirst(items)

	idMap := make(map[string]string, len(ordered))
	for _, item := range ordered {
		newID, err := resolveItemIDTx(ctx, tx, d, itemIDs[item.ID])
		if err != nil {
			return err
		}
		idMap[item.ID] = newID
		if err = insertDuplicateItemTx(ctx, tx, d, noteID, item, newID, idMap, now); err != nil {
			// Two concurrent replays with the same client-supplied ID can both pass
			// the existence check above; map the constraint violation to ErrNoteItemExists.
			if itemIDs[item.ID] != "" && d.IsUniqueConstraintError(err) {
				return ErrNoteItemExists
			}
			return fmt.Errorf("failed to duplicate note item: %w", err)
		}
	}
	return nil
}

// orderItemsParentsFirst returns items ordered so that every item comes after
// its parent (when that parent is part of the same set), breaking ties by
// ascending position. Items whose parent is not in the set are treated as roots.
// Ordering by parent-chain depth guarantees a parent is inserted before its
// children regardless of their relative positions.
func orderItemsParentsFirst(items []NoteItem) []NoteItem {
	byID := make(map[string]NoteItem, len(items))
	for _, it := range items {
		byID[it.ID] = it
	}

	// depthOf walks each item's parent chain; a parent outside the set or a cycle
	// stops the walk. Two-level lists (indent 0/1) yield depths 0 and 1, but this
	// handles arbitrary nesting too.
	depthOf := make(map[string]int, len(items))
	for _, it := range items {
		depth := 0
		seen := map[string]bool{it.ID: true}
		cur := it
		for cur.ParentID != nil {
			parent, ok := byID[*cur.ParentID]
			if !ok || seen[parent.ID] {
				break
			}
			seen[parent.ID] = true
			depth++
			cur = parent
		}
		depthOf[it.ID] = depth
	}

	ordered := make([]NoteItem, len(items))
	copy(ordered, items)
	slices.SortStableFunc(ordered, func(a, b NoteItem) int {
		if da, db := depthOf[a.ID], depthOf[b.ID]; da != db {
			return da - db
		}
		return a.Position - b.Position
	})
	return ordered
}

// resolveItemIDTx returns the ID to use for a duplicated item. When supplied is
// non-empty the item is existence-checked and the caller's value is returned;
// otherwise a fresh server-side ID is generated.
func resolveItemIDTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, supplied string) (string, error) {
	if supplied == "" {
		return generateID()
	}
	var exists int
	if err := tx.QueryRowContext(ctx,
		d.RewritePlaceholders(`SELECT COUNT(*) FROM note_items WHERE id = ?`),
		supplied,
	).Scan(&exists); err != nil {
		return "", fmt.Errorf("failed to check item existence: %w", err)
	}
	if exists > 0 {
		return "", ErrNoteItemExists
	}
	return supplied, nil
}

// insertDuplicateItemTx inserts one cloned item into noteID, remapping its
// parent_id through idMap (which must already contain the duplicated parent).
func insertDuplicateItemTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID string, item NoteItem, itemID string, idMap map[string]string, now string) error {
	var newParent sql.NullString
	if item.ParentID != nil {
		if mapped, ok := idMap[*item.ParentID]; ok {
			newParent = sql.NullString{String: mapped, Valid: true}
		}
	}
	_, err := tx.ExecContext(ctx,
		d.RewritePlaceholders(`INSERT INTO note_items (id, note_id, text, completed, position, parent_id, assigned_to, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		itemID, noteID, item.Text, item.Completed, item.Position, newParent, nullableAssignedTo(""), now, now,
	)
	return err
}

func duplicateLabelsTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID, userID string, labels []Label, now string) error {
	for _, label := range labels {
		labelID, err := generateID()
		if err != nil {
			return fmt.Errorf("failed to generate label ID: %w", err)
		}
		var resolvedLabelID string
		if err = tx.QueryRowContext(ctx,
			// The no-op SET is what makes RETURNING yield the existing row on a
			// conflict; DO NOTHING returns none. It must not assign
			// excluded.name — that would rewrite the label's spelling to
			// whatever the duplicated note happened to use, so duplicating a
			// note tagged "äpfel" would rename the user's "Äpfel" label.
			// GetOrCreateLabel keeps the stored spelling, and so does this.
			d.RewritePlaceholders(`INSERT INTO labels (id, user_id, name, name_folded, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (user_id, name_folded) DO UPDATE SET name = labels.name
			 RETURNING id`),
			labelID, userID, label.Name, labelfold.Fold(label.Name), now, now,
		).Scan(&resolvedLabelID); err != nil {
			return fmt.Errorf("failed to get or create duplicated label: %w", err)
		}
		noteLabelID, err := generateID()
		if err != nil {
			return fmt.Errorf("failed to generate note label ID: %w", err)
		}
		q := d.RewritePlaceholders(
			d.InsertIgnore("note_labels", "id, note_id, label_id, user_id, created_at", "?, ?, ?, ?, ?"),
		)
		if _, err = tx.ExecContext(ctx, q, noteLabelID, noteID, resolvedLabelID, userID, now); err != nil {
			return fmt.Errorf("failed to attach duplicated label to note: %w", err)
		}
	}
	return nil
}
