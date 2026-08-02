package models

import (
	"context"
	"database/sql"
	"fmt"
	"slices"

	"github.com/hanzei/jot/server/internal/database/dialect"
)

// GetOwnedNotesForExport returns all non-trashed notes owned by userID,
// including their list items and labels, for use in the export endpoint.
// It filters on notes.user_id (not note_user_state.user_id) so notes merely
// shared with the current user are never included.
func (s *noteStore) GetOwnedNotesForExport(ctx context.Context, userID string) ([]*Note, error) {
	query := s.d.RewritePlaceholders(`SELECT n.id, n.user_id, n.title, n.content, n.note_type, n.version,
			  nus.color, nus.pinned, nus.archived, nus.position, nus.unpinned_position, nus.checked_items_collapsed,
			  n.deleted_at, n.created_at, n.updated_at
			  FROM notes n
			  INNER JOIN note_user_state nus ON n.id = nus.note_id AND nus.user_id = ?
			  WHERE n.user_id = ? AND n.deleted_at IS NULL
			  ORDER BY nus.pinned DESC, nus.position ASC`)

	rows, err := s.db.QueryContext(ctx, query, userID, userID)
	if err != nil {
		return nil, fmt.Errorf("query owned notes for export: %w", err)
	}

	scannedNotes, err := collectRows(rows, scanNote)
	if err != nil {
		return nil, fmt.Errorf("scan owned notes for export: %w", err)
	}

	notes := make([]*Note, 0, len(scannedNotes))
	for i := range scannedNotes {
		note := &scannedNotes[i]
		if note.NoteType == NoteTypeList {
			items, err := s.getItemsByNoteID(ctx, note.ID)
			if err != nil {
				return nil, fmt.Errorf("get items for note %s: %w", note.ID, err)
			}
			note.Items = items
		}
		labels, err := s.GetNoteLabels(ctx, note.ID, userID)
		if err != nil {
			return nil, fmt.Errorf("get labels for note %s: %w", note.ID, err)
		}
		note.Labels = labels
		note.SharedWith = []NoteShare{}
		notes = append(notes, note)
	}

	return notes, nil
}

// JotImportNoteItem is a single list item in a Jot JSON import payload.
type JotImportNoteItem struct {
	Text        string
	Completed   bool
	Position    int
	IndentLevel int
}

// JotImportNote is a single note in a Jot JSON import payload.
type JotImportNote struct {
	Title                 string
	Content               string
	NoteType              NoteType
	Color                 string
	Pinned                bool
	Archived              bool
	Position              int
	UnpinnedPosition      *int
	CheckedItemsCollapsed bool
	Labels                []string
	Items                 []JotImportNoteItem
}

// importedNote pairs a newly created note ID with its import payload.
type importedNote struct {
	id   string
	note JotImportNote
}

// ImportJotNotes creates all notes in a single all-or-nothing database transaction.
// Positions are restored via per-bucket reorder passes so that active pinned, active
// unpinned, archived pinned, and archived unpinned notes each get sequential positions
// matching the exported ordering. unpinned_position is preserved when present in the
// import payload and falls back to the assigned rank within the bucket otherwise.
func (s *noteStore) ImportJotNotes(ctx context.Context, userID string, notes []JotImportNote) error {
	if len(notes) == 0 {
		return nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin import transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	imported := make([]importedNote, 0, len(notes))
	for _, n := range notes {
		noteID, createErr := insertImportedNoteTx(ctx, tx, s.d, userID, n)
		if createErr != nil {
			return createErr
		}
		imported = append(imported, importedNote{id: noteID, note: n})
	}

	if err = reorderImportedNotesTx(ctx, tx, s.d, userID, imported); err != nil {
		return err
	}

	return tx.Commit()
}

// insertImportedNoteTx inserts a single note, its list items, and its labels
// into the database within the provided transaction. It returns the new note ID.
func insertImportedNoteTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, userID string, n JotImportNote) (string, error) {
	noteID, err := generateID()
	if err != nil {
		return "", fmt.Errorf("generate note ID: %w", err)
	}

	if _, err = tx.ExecContext(ctx,
		d.RewritePlaceholders(`INSERT INTO notes (id, user_id, title, content, note_type) VALUES (?, ?, ?, ?, ?)`),
		noteID, userID, n.Title, n.Content, n.NoteType,
	); err != nil {
		return "", fmt.Errorf("create note: %w", err)
	}

	// Use placeholder positions (0); the reorder pass sets the final values.
	if _, err = tx.ExecContext(ctx,
		d.RewritePlaceholders(`INSERT INTO note_user_state (note_id, user_id, color, pinned, archived, position, unpinned_position, checked_items_collapsed)
		 VALUES (?, ?, ?, ?, ?, 0, 0, ?)`),
		noteID, userID, n.Color, n.Pinned, n.Archived, n.CheckedItemsCollapsed,
	); err != nil {
		return "", fmt.Errorf("create note user state: %w", err)
	}

	if err = insertImportedItemsTx(ctx, tx, d, noteID, n.Items); err != nil {
		return "", err
	}

	if err = insertImportedLabelsTx(ctx, tx, d, userID, noteID, n.Labels); err != nil {
		return "", err
	}

	return noteID, nil
}

func insertImportedItemsTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID string, items []JotImportNoteItem) error {
	// The import format is positional and carries indent_level (0/1) rather than
	// item IDs, so reconstruct grouping the same way the migration backfill does:
	// each indented item attaches to the most recent top-level item by position.
	ordered := make([]JotImportNoteItem, len(items))
	copy(ordered, items)
	slices.SortStableFunc(ordered, func(a, b JotImportNoteItem) int { return a.Position - b.Position })

	var lastTopLevel sql.NullString
	for _, item := range ordered {
		itemID, err := generateID()
		if err != nil {
			return fmt.Errorf("generate item ID: %w", err)
		}
		var parent sql.NullString
		if item.IndentLevel <= 0 {
			lastTopLevel = sql.NullString{String: itemID, Valid: true}
		} else {
			parent = lastTopLevel
		}
		if _, err = tx.ExecContext(ctx,
			d.RewritePlaceholders(`INSERT INTO note_items (id, note_id, text, position, completed, parent_id, assigned_to)
			 VALUES (?, ?, ?, ?, ?, ?, NULL)`),
			itemID, noteID, item.Text, item.Position, item.Completed, parent,
		); err != nil {
			return fmt.Errorf("create note item: %w", err)
		}
	}
	return nil
}

func insertImportedLabelsTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, userID, noteID string, labels []string) error {
	for _, labelName := range labels {
		labelID, err := generateID()
		if err != nil {
			return fmt.Errorf("generate label ID: %w", err)
		}
		var resolvedLabelID string
		if err = tx.QueryRowContext(ctx,
			d.RewritePlaceholders(`INSERT INTO labels (id, user_id, name) VALUES (?, ?, ?)
			 ON CONFLICT `+d.LabelNameConflictTarget()+` DO UPDATE SET name=excluded.name
			 RETURNING id`),
			labelID, userID, labelName,
		).Scan(&resolvedLabelID); err != nil {
			return fmt.Errorf("get or create label %q: %w", labelName, err)
		}

		noteLabelID, err := generateID()
		if err != nil {
			return fmt.Errorf("generate note_label ID: %w", err)
		}
		q := d.RewritePlaceholders(
			d.InsertIgnore("note_labels", "id, note_id, label_id, user_id", "?, ?, ?, ?"),
		)
		if _, err = tx.ExecContext(ctx, q, noteLabelID, noteID, resolvedLabelID, userID); err != nil {
			return fmt.Errorf("attach label to note: %w", err)
		}
	}
	return nil
}

// reorderImportedNotesTx groups imported notes by (pinned, archived) bucket, sorts
// each bucket by the exported position, and assigns sequential positions 0, 1, 2...
// unpinned_position is set to the exported value when present, or falls back to the
// assigned rank within the bucket.
func reorderImportedNotesTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, userID string, imported []importedNote) error {
	type bucket struct {
		pinned   bool
		archived bool
	}
	buckets := map[bucket][]importedNote{}
	for _, n := range imported {
		b := bucket{pinned: n.note.Pinned, archived: n.note.Archived}
		buckets[b] = append(buckets[b], n)
	}

	for key, items := range buckets {
		// Find the highest existing position in this bucket so imported notes
		// are appended after existing ones and do not collide.
		var maxPos sql.NullInt64
		if err := tx.QueryRowContext(ctx,
			d.RewritePlaceholders(`SELECT MAX(nus.position)
			   FROM note_user_state nus
			   JOIN notes n ON n.id = nus.note_id
			  WHERE nus.user_id = ?
			    AND n.deleted_at IS NULL
			    AND nus.pinned = ?
			    AND nus.archived = ?`),
			userID, key.pinned, key.archived,
		).Scan(&maxPos); err != nil {
			return fmt.Errorf("query max position: %w", err)
		}
		offset := 0
		if maxPos.Valid {
			offset = int(maxPos.Int64) + 1
		}

		slices.SortFunc(items, func(a, b importedNote) int {
			return a.note.Position - b.note.Position
		})
		for pos, n := range items {
			finalPos := offset + pos
			unpinnedPos := n.note.UnpinnedPosition
			if unpinnedPos == nil {
				unpinnedPos = &finalPos
			} else {
				adjusted := offset + *unpinnedPos
				unpinnedPos = &adjusted
			}
			if _, err := tx.ExecContext(ctx,
				d.RewritePlaceholders(`UPDATE note_user_state SET position = ?, unpinned_position = ? WHERE note_id = ? AND user_id = ?`),
				finalPos, unpinnedPos, n.id, userID,
			); err != nil {
				return fmt.Errorf("set note position: %w", err)
			}
		}
	}
	return nil
}
