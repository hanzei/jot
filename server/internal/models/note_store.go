package models

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/hanzei/jot/server/internal/database/dialect"
	"github.com/sirupsen/logrus"
)

type noteStore struct {
	db *sql.DB
	d  *dialect.Dialect
}

func newNoteStore(db *sql.DB, d *dialect.Dialect) *noteStore {
	return &noteStore{db: db, d: d}
}

// deref returns *p if p is non-nil, otherwise def.
func deref[T any](p *T, def T) T {
	if p != nil {
		return *p
	}
	return def
}

func (s *noteStore) Create(ctx context.Context, userID string, title, content string, noteType NoteType, color string) (*Note, error) {
	noteID, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate note ID: %w", err)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

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

	var note Note
	if err = tx.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`INSERT INTO notes (id, user_id, title, content, note_type)
		 VALUES (?, ?, ?, ?, ?) RETURNING created_at, updated_at`),
		noteID, userID, title, content, noteType,
	).Scan(&note.CreatedAt, &note.UpdatedAt); err != nil {
		return nil, fmt.Errorf("failed to create note: %w", err)
	}

	if _, err = tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`INSERT INTO note_user_state (note_id, user_id, color, pinned, archived, position, unpinned_position, checked_items_collapsed)
		 VALUES (?, ?, ?, FALSE, FALSE, ?, ?, FALSE)`),
		noteID, userID, color, nextPosition, nextPosition,
	); err != nil {
		return nil, fmt.Errorf("failed to create note user state: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("failed to commit note creation: %w", err)
	}

	note.ID = noteID
	note.UserID = userID
	note.Title = title
	note.Content = content
	note.NoteType = noteType
	note.Color = color
	note.Position = nextPosition
	note.UnpinnedPosition = &nextPosition
	note.CheckedItemsCollapsed = false
	note.Labels = []Label{}

	return &note, nil
}

func duplicateNoteTitle(title string) string {
	return "Copy of " + title
}

func (s *noteStore) Duplicate(ctx context.Context, source *Note, userID string) (*Note, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	noteID, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate note ID: %w", err)
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
	if _, err = tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`INSERT INTO notes (id, user_id, title, content, note_type) VALUES (?, ?, ?, ?, ?)`),
		noteID,
		userID,
		duplicateNoteTitle(source.Title),
		source.Content,
		source.NoteType,
	); err != nil {
		return nil, fmt.Errorf("failed to create duplicated note: %w", err)
	}

	if _, err = tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`INSERT INTO note_user_state (note_id, user_id, color, pinned, archived, position, unpinned_position, checked_items_collapsed)
		 VALUES (?, ?, ?, FALSE, FALSE, ?, ?, ?)`),
		noteID, userID, source.Color, nextPosition, nextPosition, source.CheckedItemsCollapsed,
	); err != nil {
		return nil, fmt.Errorf("failed to create duplicated note user state: %w", err)
	}

	if err = duplicateItemsTx(ctx, tx, s.d, noteID, source.Items); err != nil {
		return nil, fmt.Errorf("duplicate note items: %w", err)
	}

	if err = duplicateLabelsTx(ctx, tx, s.d, noteID, userID, source.Labels); err != nil {
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

func duplicateItemsTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID string, items []NoteItem) error {
	for _, item := range items {
		itemID, err := generateID()
		if err != nil {
			return fmt.Errorf("failed to generate note item ID: %w", err)
		}
		if _, err = tx.ExecContext(ctx,
			d.RewritePlaceholders(`INSERT INTO note_items (id, note_id, text, completed, position, indent_level, assigned_to)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`),
			itemID, noteID, item.Text, item.Completed, item.Position, item.IndentLevel, nullableAssignedTo(""),
		); err != nil {
			return fmt.Errorf("failed to duplicate note item: %w", err)
		}
	}
	return nil
}

func duplicateLabelsTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID, userID string, labels []Label) error {
	for _, label := range labels {
		labelID, err := generateID()
		if err != nil {
			return fmt.Errorf("failed to generate label ID: %w", err)
		}
		var resolvedLabelID string
		if err = tx.QueryRowContext(ctx,
			d.RewritePlaceholders(`INSERT INTO labels (id, user_id, name) VALUES (?, ?, ?)
			 ON CONFLICT(user_id, name) DO UPDATE SET name=excluded.name
			 RETURNING id`),
			labelID, userID, label.Name,
		).Scan(&resolvedLabelID); err != nil {
			return fmt.Errorf("failed to get or create duplicated label: %w", err)
		}
		noteLabelID, err := generateID()
		if err != nil {
			return fmt.Errorf("failed to generate note label ID: %w", err)
		}
		q := d.RewritePlaceholders(
			d.InsertIgnore("note_labels", "id, note_id, label_id, user_id", "?, ?, ?, ?"),
		)
		if _, err = tx.ExecContext(ctx, q, noteLabelID, noteID, resolvedLabelID, userID); err != nil {
			return fmt.Errorf("failed to attach duplicated label to note: %w", err)
		}
	}
	return nil
}

func buildGetByUserIDQuery(userID string, archived bool, trashed bool, search string, labelID string, myTasks bool) (string, []any) {
	const selectCols = `SELECT DISTINCT n.id, n.user_id, n.title, n.content, n.note_type,
				  nus.color, nus.pinned, nus.archived, nus.position, nus.unpinned_position, nus.checked_items_collapsed,
				  n.deleted_at, n.created_at, n.updated_at`

	var query string
	var args []any
	if trashed {
		query = selectCols + `
				  FROM notes n
				  INNER JOIN note_user_state nus ON n.id = nus.note_id AND nus.user_id = ?
				  LEFT JOIN note_items ni ON n.id = ni.note_id
				  WHERE n.user_id = ? AND n.deleted_at IS NOT NULL`
		args = []any{userID, userID}
	} else if myTasks {
		query = selectCols + `
				  FROM active_notes n
				  INNER JOIN note_user_state nus ON n.id = nus.note_id AND nus.user_id = ?
				  INNER JOIN note_items ni ON n.id = ni.note_id
				  WHERE ni.assigned_to = ?`
		args = []any{userID, userID}
	} else {
		query = selectCols + `
				  FROM active_notes n
				  INNER JOIN note_user_state nus ON n.id = nus.note_id AND nus.user_id = ?
				  LEFT JOIN note_items ni ON n.id = ni.note_id
				  WHERE nus.archived = ?`
		args = []any{userID, archived}
	}
	if search != "" {
		query += ` AND (n.title LIKE ? OR n.content LIKE ? OR ni.text LIKE ?)`
		searchTerm := "%" + search + "%"
		args = append(args, searchTerm, searchTerm, searchTerm)
	}
	if labelID != "" {
		query += ` AND n.id IN (SELECT note_id FROM note_labels WHERE label_id = ? AND user_id = ?)`
		args = append(args, labelID, userID)
	}
	query += ` ORDER BY nus.pinned DESC, nus.position ASC`
	return query, args
}

func scanNote(rows *sql.Rows) (Note, error) {
	var note Note
	err := rows.Scan(
		&note.ID, &note.UserID, &note.Title, &note.Content,
		&note.NoteType, &note.Color, &note.Pinned, &note.Archived, &note.Position, &note.UnpinnedPosition, &note.CheckedItemsCollapsed,
		&note.DeletedAt, &note.CreatedAt, &note.UpdatedAt,
	)
	return note, err
}

func (s *noteStore) GetByUserID(ctx context.Context, userID string, archived bool, trashed bool, search string, labelID string, myTasks bool) ([]*Note, error) {
	query, args := buildGetByUserIDQuery(userID, archived, trashed, search, labelID, myTasks)

	rows, err := s.db.QueryContext(ctx, s.d.RewritePlaceholders(query), args...)
	if err != nil {
		return nil, fmt.Errorf("failed to get notes: %w", err)
	}

	scannedNotes, err := collectRows(rows, scanNote)
	if err != nil {
		return nil, fmt.Errorf("failed to scan notes: %w", err)
	}

	notes, err := s.populateNoteItemsAndDefaults(ctx, scannedNotes)
	if err != nil {
		return nil, err
	}

	if err := s.batchLoadSharesAndLabels(ctx, notes, userID); err != nil {
		return nil, err
	}

	return notes, nil
}

// populateNoteItemsAndDefaults converts scanned notes to []*Note, loading list items
// for each list note and initializing slice fields to non-nil defaults.
func (s *noteStore) populateNoteItemsAndDefaults(ctx context.Context, scannedNotes []Note) ([]*Note, error) {
	notes := make([]*Note, 0, len(scannedNotes))
	for i := range scannedNotes {
		note := &scannedNotes[i]
		if note.NoteType == NoteTypeList {
			items, err := s.getItemsByNoteID(ctx, note.ID)
			if err != nil {
				return nil, fmt.Errorf("failed to get note items: %w", err)
			}
			note.Items = items
		}
		note.SharedWith = []NoteShare{}
		note.IsShared = false
		note.Labels = []Label{}
		notes = append(notes, note)
	}
	return notes, nil
}

// batchLoadSharesAndLabels batch-loads shares and labels for a slice of notes, updating each note in place.
func (s *noteStore) batchLoadSharesAndLabels(ctx context.Context, notes []*Note, userID string) error {
	if len(notes) == 0 {
		return nil
	}

	noteIDs := make([]string, len(notes))
	for i, n := range notes {
		noteIDs[i] = n.ID
	}

	sharesMap, err := s.getSharesByNoteIDs(ctx, noteIDs)
	if err != nil {
		return fmt.Errorf("failed to batch-load note shares: %w", err)
	}
	for _, n := range notes {
		if shares, ok := sharesMap[n.ID]; ok {
			n.SharedWith = shares
			n.IsShared = true
		}
	}

	labelsMap, err := s.getLabelsByNoteIDs(ctx, noteIDs, userID)
	if err != nil {
		return fmt.Errorf("failed to batch-load note labels: %w", err)
	}
	for _, n := range notes {
		if lbls, ok := labelsMap[n.ID]; ok {
			n.Labels = lbls
		}
	}

	return nil
}

func (s *noteStore) GetByID(ctx context.Context, id string, userID string) (*Note, error) {
	query := `SELECT n.id, n.user_id, n.title, n.content, n.note_type,
			  nus.color, nus.pinned, nus.archived, nus.position, nus.unpinned_position, nus.checked_items_collapsed,
			  n.deleted_at, n.created_at, n.updated_at
			  FROM active_notes n
			  INNER JOIN note_user_state nus ON n.id = nus.note_id AND nus.user_id = ?
			  WHERE n.id = ?`

	var note Note
	err := s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(query), userID, id).Scan(
		&note.ID, &note.UserID, &note.Title, &note.Content,
		&note.NoteType, &note.Color, &note.Pinned, &note.Archived, &note.Position, &note.UnpinnedPosition, &note.CheckedItemsCollapsed,
		&note.DeletedAt, &note.CreatedAt, &note.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNoteNotFound
		}
		return nil, fmt.Errorf("failed to get note: %w", err)
	}

	if err := s.populateNoteDetails(ctx, &note, userID); err != nil {
		return nil, fmt.Errorf("populate note details: %w", err)
	}
	return &note, nil
}

// GetByIDAnyState returns an accessible note, including owner-only trashed notes.
func (s *noteStore) GetByIDAnyState(ctx context.Context, id string, userID string) (*Note, error) {
	note, err := s.GetByID(ctx, id, userID)
	if err == nil {
		return note, nil
	}
	if !errors.Is(err, ErrNoteNotFound) {
		return nil, err
	}

	isOwner, ownerErr := s.IsOwner(ctx, id, userID)
	if ownerErr != nil {
		return nil, fmt.Errorf("failed to check ownership: %w", ownerErr)
	}
	if !isOwner {
		return nil, ErrNoteNotFound
	}

	query := `SELECT n.id, n.user_id, n.title, n.content, n.note_type,
			  nus.color, nus.pinned, nus.archived, nus.position, nus.unpinned_position, nus.checked_items_collapsed,
			  n.deleted_at, n.created_at, n.updated_at
			  FROM notes n
			  INNER JOIN note_user_state nus ON n.id = nus.note_id AND nus.user_id = ?
			  WHERE n.id = ? AND n.user_id = ?`

	var ownedNote Note
	err = s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(query), userID, id, userID).Scan(
		&ownedNote.ID, &ownedNote.UserID, &ownedNote.Title, &ownedNote.Content,
		&ownedNote.NoteType, &ownedNote.Color, &ownedNote.Pinned, &ownedNote.Archived, &ownedNote.Position, &ownedNote.UnpinnedPosition, &ownedNote.CheckedItemsCollapsed,
		&ownedNote.DeletedAt, &ownedNote.CreatedAt, &ownedNote.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNoteNotFound
		}
		return nil, fmt.Errorf("failed to get note in any state: %w", err)
	}

	if err := s.populateNoteDetails(ctx, &ownedNote, userID); err != nil {
		return nil, fmt.Errorf("populate note details: %w", err)
	}
	return &ownedNote, nil
}

func (s *noteStore) populateNoteDetails(ctx context.Context, note *Note, userID string) error {
	if note.NoteType == NoteTypeList {
		var items []NoteItem
		items, err := s.getItemsByNoteID(ctx, note.ID)
		if err != nil {
			return fmt.Errorf("failed to get note items: %w", err)
		}
		note.Items = items
	}

	shares, err := s.GetNoteShares(ctx, note.ID)
	if err != nil {
		return fmt.Errorf("failed to get note shares: %w", err)
	}
	note.SharedWith = shares
	note.IsShared = len(shares) > 0

	labels, err := s.GetNoteLabels(ctx, note.ID, userID)
	if err != nil {
		return fmt.Errorf("failed to get note labels: %w", err)
	}
	note.Labels = labels

	return nil
}

func (s *noteStore) Update(ctx context.Context, id string, userID string, title, content, color *string, pinned, archived, checkedItemsCollapsed *bool) error {
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

	// Only update shared fields (title/content) when the caller explicitly
	// provided at least one — skipping avoids overwriting concurrent edits
	// when only per-user fields (color, pinned, etc.) are changing.
	if title != nil || content != nil {
		if _, err = tx.ExecContext(ctx,
			s.d.RewritePlaceholders(`UPDATE notes SET title = ?, content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`),
			resolvedTitle, resolvedContent, id,
		); err != nil {
			return fmt.Errorf("failed to update note: %w", err)
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

func (s *noteStore) Delete(ctx context.Context, id string, userID string) error {
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

	for _, q := range []string{
		`DELETE FROM note_items WHERE note_id = ?`,
		`DELETE FROM note_labels WHERE note_id = ?`,
		`DELETE FROM note_shares WHERE note_id = ?`,
		`DELETE FROM note_user_state WHERE note_id = ?`,
	} {
		if _, err = tx.ExecContext(ctx, s.d.RewritePlaceholders(q), id); err != nil {
			return fmt.Errorf("failed to delete dependent rows: %w", err)
		}
	}

	result, err := tx.ExecContext(ctx, s.d.RewritePlaceholders("DELETE FROM notes WHERE id = ? AND user_id = ?"), id, userID)
	if err != nil {
		return fmt.Errorf("failed to delete note: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}

	if rowsAffected == 0 {
		return ErrNoteNotOwnedByUser
	}

	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit note delete: %w", err)
	}
	return nil
}

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

func (s *noteStore) getNoteAudiencesTx(ctx context.Context, tx *sql.Tx, noteIDs []string) (map[string][]string, error) {
	if len(noteIDs) == 0 {
		return map[string][]string{}, nil
	}

	placeholders, args := buildInClauseArgs(noteIDs)
	queryArgs := make([]any, 0, len(args)*2)
	queryArgs = append(queryArgs, args...)
	queryArgs = append(queryArgs, args...)

	rawQuery := `SELECT id AS note_id, user_id FROM notes WHERE id IN (` + placeholders + `)
		 UNION
		 SELECT note_id, shared_with_user_id FROM note_shares WHERE note_id IN (` + placeholders + `)` // #nosec G202 -- only generated "?" placeholders are concatenated
	rows, err := tx.QueryContext(ctx, s.d.RewritePlaceholders(rawQuery), queryArgs...)
	if err != nil {
		return nil, fmt.Errorf("failed to query note audiences: %w", err)
	}
	defer func() { _ = rows.Close() }()

	audiences := make(map[string][]string, len(noteIDs))
	for rows.Next() {
		var noteID string
		var audienceID string
		if err = rows.Scan(&noteID, &audienceID); err != nil {
			return nil, fmt.Errorf("failed to scan note audience: %w", err)
		}
		audiences[noteID] = append(audiences[noteID], audienceID)
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("failed while reading note audiences: %w", err)
	}
	return audiences, nil
}

func deleteNoteDependenciesTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteIDs []string) error {
	if len(noteIDs) == 0 {
		return nil
	}

	placeholders, args := buildInClauseArgs(noteIDs)
	for _, q := range []string{
		`DELETE FROM note_items WHERE note_id IN (` + placeholders + `)`,
		`DELETE FROM note_labels WHERE note_id IN (` + placeholders + `)`,
		`DELETE FROM note_shares WHERE note_id IN (` + placeholders + `)`,
		`DELETE FROM note_user_state WHERE note_id IN (` + placeholders + `)`,
	} {
		if _, err := tx.ExecContext(ctx, d.RewritePlaceholders(q), args...); err != nil {
			return fmt.Errorf("failed to delete dependent rows: %w", err)
		}
	}

	return nil
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
// It returns ErrNoteNotInTrash if the note is not found in the trash or not owned by the user.
func (s *noteStore) DeleteFromTrash(ctx context.Context, id string, userID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if err = deleteNoteDependenciesTx(ctx, tx, s.d, []string{id}); err != nil {
		return fmt.Errorf("delete note dependencies: %w", err)
	}

	result, err := tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`DELETE FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL`),
		id, userID,
	)
	if err != nil {
		return fmt.Errorf("failed to permanently delete note from trash: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return ErrNoteNotInTrash
	}

	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit delete from trash: %w", err)
	}
	return nil
}

// EmptyTrash permanently removes all notes the user currently has in the trash.
// It returns the deleted note IDs and their audiences so handlers can publish
// note_deleted SSE events after the transaction commits.
func (s *noteStore) EmptyTrash(ctx context.Context, userID string) ([]DeletedNoteAudience, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	noteIDs, err := s.getTrashedOwnedNoteIDsTx(ctx, tx, userID)
	if err != nil {
		return nil, fmt.Errorf("get trashed note IDs: %w", err)
	}
	if len(noteIDs) == 0 {
		if err = tx.Commit(); err != nil {
			return nil, fmt.Errorf("failed to commit empty trash transaction: %w", err)
		}
		return []DeletedNoteAudience{}, nil
	}

	audienceMap, err := s.getNoteAudiencesTx(ctx, tx, noteIDs)
	if err != nil {
		return nil, fmt.Errorf("get note audiences: %w", err)
	}

	if err = deleteNoteDependenciesTx(ctx, tx, s.d, noteIDs); err != nil {
		return nil, fmt.Errorf("delete note dependencies: %w", err)
	}

	placeholders, args := buildInClauseArgs(noteIDs)
	deleteArgs := make([]any, 0, len(args)+1)
	deleteArgs = append(deleteArgs, userID)
	deleteArgs = append(deleteArgs, args...)

	deleteQuery := `DELETE FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL AND id IN (` + placeholders + `)` // #nosec G202 -- only generated "?" placeholders are concatenated
	result, err := tx.ExecContext(ctx, s.d.RewritePlaceholders(deleteQuery), deleteArgs...)
	if err != nil {
		return nil, fmt.Errorf("failed to empty trash: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return nil, fmt.Errorf("failed to get deleted note count: %w", err)
	}
	if rowsAffected != int64(len(noteIDs)) {
		return nil, fmt.Errorf("expected to delete %d trashed notes, deleted %d", len(noteIDs), rowsAffected)
	}

	deletedNotes := make([]DeletedNoteAudience, 0, len(noteIDs))
	for _, noteID := range noteIDs {
		deletedNotes = append(deletedNotes, DeletedNoteAudience{
			NoteID:      noteID,
			AudienceIDs: audienceMap[noteID],
		})
	}

	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("failed to commit empty trash transaction: %w", err)
	}

	return deletedNotes, nil
}

// PurgeOldTrashedNotes permanently deletes all notes that have been in the trash
// longer than the given duration. This is intended to be called periodically.
func (s *noteStore) PurgeOldTrashedNotes(ctx context.Context, olderThan time.Duration) error {
	cutoff := time.Now().Add(-olderThan)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	subquery := `SELECT id FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?`
	for _, q := range []string{
		`DELETE FROM note_items WHERE note_id IN (` + subquery + `)`,
		`DELETE FROM note_labels WHERE note_id IN (` + subquery + `)`,
		`DELETE FROM note_shares WHERE note_id IN (` + subquery + `)`,
		`DELETE FROM note_user_state WHERE note_id IN (` + subquery + `)`,
	} {
		if _, err = tx.ExecContext(ctx, s.d.RewritePlaceholders(q), cutoff); err != nil {
			return fmt.Errorf("failed to purge dependent rows: %w", err)
		}
	}

	if _, err = tx.ExecContext(ctx, s.d.RewritePlaceholders(`DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?`), cutoff); err != nil {
		return fmt.Errorf("failed to purge old trashed notes: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit purge old trashed notes: %w", err)
	}
	return nil
}

func nullableAssignedTo(s string) sql.NullString {
	return sql.NullString{String: s, Valid: s != ""}
}

func scanNoteItem(rows *sql.Rows) (NoteItem, error) {
	var item NoteItem
	var assignedTo sql.NullString
	err := rows.Scan(
		&item.ID, &item.NoteID, &item.Text, &item.Completed,
		&item.Position, &item.IndentLevel, &assignedTo,
		&item.CreatedAt, &item.UpdatedAt,
	)
	item.AssignedTo = assignedTo.String
	return item, err
}

func (s *noteStore) getItemsByNoteID(ctx context.Context, noteID string) ([]NoteItem, error) {
	query := s.d.RewritePlaceholders(`SELECT id, note_id, text, completed, position, indent_level,
			  assigned_to, created_at, updated_at
			  FROM note_items WHERE note_id = ? ORDER BY position`)

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

func (s *noteStore) CreateItem(ctx context.Context, noteID string, text string, position, indentLevel int, assignedTo string) (*NoteItem, error) {
	itemID, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate item ID: %w", err)
	}

	query := s.d.RewritePlaceholders(`INSERT INTO note_items (id, note_id, text, position, indent_level, assigned_to)
			  VALUES (?, ?, ?, ?, ?, ?) RETURNING completed, created_at, updated_at`)

	var item NoteItem
	err = s.db.QueryRowContext(ctx, query, itemID, noteID, text, position, indentLevel,
		nullableAssignedTo(assignedTo),
	).Scan(
		&item.Completed, &item.CreatedAt, &item.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create note item: %w", err)
	}

	item.ID = itemID
	item.NoteID = noteID
	item.Text = text
	item.Position = position
	item.IndentLevel = indentLevel
	item.AssignedTo = assignedTo

	return &item, nil
}

// UpdateItem updates text, completed, position, and indent_level for a note item.
// It does NOT update assigned_to. The current update flow uses delete-and-recreate
// via CreateItemWithCompleted which preserves assignments via the caller-supplied value.
func (s *noteStore) UpdateItem(ctx context.Context, id string, text string, completed bool, position, indentLevel int) error {
	query := s.d.RewritePlaceholders(`UPDATE note_items SET text = ?, completed = ?, position = ?, indent_level = ?, updated_at = CURRENT_TIMESTAMP
			  WHERE id = ?`)

	_, err := s.db.ExecContext(ctx, query, text, completed, position, indentLevel, id)
	if err != nil {
		return fmt.Errorf("failed to update note item: %w", err)
	}

	return nil
}

func (s *noteStore) DeleteItem(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.d.RewritePlaceholders("DELETE FROM note_items WHERE id = ?"), id)
	if err != nil {
		return fmt.Errorf("failed to delete note item: %w", err)
	}

	return nil
}

func (s *noteStore) DeleteItemsByNoteID(ctx context.Context, noteID string) error {
	_, err := s.db.ExecContext(ctx, s.d.RewritePlaceholders("DELETE FROM note_items WHERE note_id = ?"), noteID)
	if err != nil {
		return fmt.Errorf("failed to delete note items: %w", err)
	}
	return nil
}

func (s *noteStore) CreateItemWithCompleted(ctx context.Context, noteID string, text string, position int, completed bool, indentLevel int, assignedTo string) (*NoteItem, error) {
	itemID, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate item ID: %w", err)
	}

	query := s.d.RewritePlaceholders(`INSERT INTO note_items (id, note_id, text, position, completed, indent_level, assigned_to)
			  VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING created_at, updated_at`)
	var item NoteItem
	err = s.db.QueryRowContext(ctx, query, itemID, noteID, text, position, completed, indentLevel,
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
	item.IndentLevel = indentLevel
	item.AssignedTo = assignedTo

	return &item, nil
}

func (s *noteStore) HasAccess(ctx context.Context, noteID string, userID string) (bool, error) {
	// Use the same predicate as GetByID: a note_user_state row exists for both
	// owners and collaborators, so this is a single consistent access check.
	var count int
	err := s.db.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT COUNT(*) FROM note_user_state nus
		 INNER JOIN active_notes n ON n.id = nus.note_id
		 WHERE nus.note_id = ? AND nus.user_id = ?`),
		noteID, userID,
	).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("failed to check access: %w", err)
	}
	return count > 0, nil
}

func (s *noteStore) IsOwner(ctx context.Context, noteID string, userID string) (bool, error) {
	var count int
	query := s.d.RewritePlaceholders(`SELECT COUNT(*) FROM notes WHERE id = ? AND user_id = ?`)

	err := s.db.QueryRowContext(ctx, query, noteID, userID).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("failed to check ownership: %w", err)
	}

	return count > 0, nil
}

// GetOwnerID returns the owner user ID for a note.
func (s *noteStore) GetOwnerID(ctx context.Context, noteID string) (string, error) {
	var ownerID string
	err := s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(`SELECT user_id FROM notes WHERE id = ?`), noteID).Scan(&ownerID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", ErrNoteNotFound
		}
		return "", fmt.Errorf("failed to get note owner: %w", err)
	}
	return ownerID, nil
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
			logrus.WithError(rollbackErr).Error("Failed to rollback transaction")
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

// GetCollaboratorIDs returns the IDs of all users who share at least one note
// with userID (in either direction). Used to determine who to notify when a
// user's profile icon changes.
func (s *noteStore) GetCollaboratorIDs(ctx context.Context, userID string) ([]string, error) {
	query := s.d.RewritePlaceholders(`
		SELECT DISTINCT shared_with_user_id FROM note_shares WHERE shared_by_user_id = ?
		UNION
		SELECT DISTINCT shared_by_user_id FROM note_shares WHERE shared_with_user_id = ?
	`)
	rows, err := s.db.QueryContext(ctx, query, userID, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get collaborator IDs: %w", err)
	}

	scanString := func(rows *sql.Rows) (string, error) {
		var v string
		return v, rows.Scan(&v)
	}
	ids, err := collectRows(rows, scanString)
	if err != nil {
		return nil, fmt.Errorf("failed to scan collaborator IDs: %w", err)
	}
	return ids, nil
}

// GetNoteAudienceIDs returns the owner's user ID plus all shared_with user IDs for a note.
// Used by handlers to determine who to broadcast SSE events to.
func (s *noteStore) GetNoteAudienceIDs(ctx context.Context, noteID string) ([]string, error) {
	query := s.d.RewritePlaceholders(`
		SELECT user_id FROM notes WHERE id = ?
		UNION
		SELECT shared_with_user_id FROM note_shares WHERE note_id = ?
	`)
	rows, err := s.db.QueryContext(ctx, query, noteID, noteID)
	if err != nil {
		return nil, fmt.Errorf("failed to get note audience: %w", err)
	}

	scanString := func(rows *sql.Rows) (string, error) {
		var v string
		return v, rows.Scan(&v)
	}
	ids, err := collectRows(rows, scanString)
	if err != nil {
		return nil, fmt.Errorf("failed to scan note audience: %w", err)
	}
	return ids, nil
}

// GetNoteLabels returns labels attached to a note by a specific user.
func (s *noteStore) GetNoteLabels(ctx context.Context, noteID string, userID string) ([]Label, error) {
	query := s.d.RewritePlaceholders(`SELECT l.id, l.user_id, l.name, l.created_at, l.updated_at
			  FROM labels l
			  JOIN note_labels nl ON l.id = nl.label_id
			  WHERE nl.note_id = ? AND nl.user_id = ?
			  ORDER BY l.name ASC`)
	rows, err := s.db.QueryContext(ctx, query, noteID, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get note labels: %w", err)
	}

	labels, err := collectRows(rows, scanLabel)
	if err != nil {
		return nil, fmt.Errorf("failed to scan note labels: %w", err)
	}
	if labels == nil {
		labels = []Label{}
	}
	return labels, nil
}

// getLabelsByNoteIDs batch-loads labels for a set of note IDs for a specific user, returning a map of noteID -> []Label.
func (s *noteStore) getLabelsByNoteIDs(ctx context.Context, noteIDs []string, userID string) (map[string][]Label, error) {
	if len(noteIDs) == 0 {
		return map[string][]Label{}, nil
	}

	placeholders := slices.Repeat([]string{"?"}, len(noteIDs))
	args := make([]any, 0, len(noteIDs)+1)
	for _, id := range noteIDs {
		args = append(args, id)
	}
	args = append(args, userID)

	rawQuery := `SELECT nl.note_id, l.id, l.user_id, l.name, l.created_at, l.updated_at
			  FROM labels l
			  JOIN note_labels nl ON l.id = nl.label_id
			  WHERE nl.note_id IN (` + strings.Join(placeholders, ",") + `) AND nl.user_id = ?
			  ORDER BY nl.note_id, l.name ASC` // #nosec G202 -- only "?" placeholders are joined, no user input

	rows, err := s.db.QueryContext(ctx, s.d.RewritePlaceholders(rawQuery), args...)
	if err != nil {
		return nil, fmt.Errorf("failed to batch-get note labels: %w", err)
	}

	type noteLabelRow struct {
		noteID string
		label  Label
	}
	scanNoteLabel := func(rows *sql.Rows) (noteLabelRow, error) {
		var r noteLabelRow
		err := rows.Scan(&r.noteID, &r.label.ID, &r.label.UserID, &r.label.Name, &r.label.CreatedAt, &r.label.UpdatedAt)
		return r, err
	}

	defer func() { _ = rows.Close() }()
	result := map[string][]Label{}
	for row, err := range scanRows(rows, scanNoteLabel) {
		if err != nil {
			return nil, fmt.Errorf("failed to scan note label: %w", err)
		}
		result[row.noteID] = append(result[row.noteID], row.label)
	}
	return result, nil
}

// AddLabelToNote attaches a label to a note (user must have access).
func (s *noteStore) AddLabelToNote(ctx context.Context, noteID, labelID, userID string) error {
	hasAccess, err := s.HasAccess(ctx, noteID, userID)
	if err != nil {
		return fmt.Errorf("failed to check access: %w", err)
	}
	if !hasAccess {
		return ErrNoteNoAccess
	}

	// Verify the label exists and belongs to this user.
	var count int
	if err = s.db.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT COUNT(*) FROM labels WHERE id = ? AND user_id = ?`),
		labelID, userID,
	).Scan(&count); err != nil {
		return fmt.Errorf("failed to verify label ownership: %w", err)
	}
	if count == 0 {
		return ErrLabelNotFoundOrNotOwned
	}

	id, err := generateID()
	if err != nil {
		return fmt.Errorf("failed to generate note_label ID: %w", err)
	}
	q := s.d.RewritePlaceholders(
		s.d.InsertIgnore("note_labels", "id, note_id, label_id, user_id", "?, ?, ?, ?"),
	)
	_, err = s.db.ExecContext(ctx, q, id, noteID, labelID, userID)
	if err != nil {
		return fmt.Errorf("failed to add label to note: %w", err)
	}
	return nil
}

// GetOwnedNotesForExport returns all non-trashed notes owned by userID,
// including their list items and labels, for use in the export endpoint.
// It filters on notes.user_id (not note_user_state.user_id) so notes merely
// shared with the current user are never included.
func (s *noteStore) GetOwnedNotesForExport(ctx context.Context, userID string) ([]*Note, error) {
	query := s.d.RewritePlaceholders(`SELECT n.id, n.user_id, n.title, n.content, n.note_type,
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
	for _, item := range items {
		itemID, err := generateID()
		if err != nil {
			return fmt.Errorf("generate item ID: %w", err)
		}
		if _, err = tx.ExecContext(ctx,
			d.RewritePlaceholders(`INSERT INTO note_items (id, note_id, text, position, completed, indent_level, assigned_to)
			 VALUES (?, ?, ?, ?, ?, ?, NULL)`),
			itemID, noteID, item.Text, item.Position, item.Completed, item.IndentLevel,
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
			 ON CONFLICT(user_id, name) DO UPDATE SET name=excluded.name
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

// RemoveLabelFromNote detaches a label from a note (user must have access).
func (s *noteStore) RemoveLabelFromNote(ctx context.Context, noteID, labelID, userID string) error {
	hasAccess, err := s.HasAccess(ctx, noteID, userID)
	if err != nil {
		return fmt.Errorf("failed to check access: %w", err)
	}
	if !hasAccess {
		return ErrNoteNoAccess
	}

	_, err = s.db.ExecContext(ctx,
		s.d.RewritePlaceholders(`DELETE FROM note_labels WHERE note_id = ? AND label_id = ? AND user_id = ?`),
		noteID, labelID, userID,
	)
	if err != nil {
		return fmt.Errorf("failed to remove label from note: %w", err)
	}
	return nil
}
