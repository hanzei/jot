package models

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"unicode"

	"github.com/hanzei/jot/server/internal/database/dialect"
)

// buildSearchTokens normalizes a raw search string into lowercase, literal word
// tokens for full-text matching. It splits on any rune that is not a letter or
// digit, so query operators and punctuation (%, _, ", *, -, :, &, …) act only
// as separators and can never be interpreted as FTS/tsquery syntax — the reason
// such inputs can't error the request. Diacritics are preserved (café ≠ cafe)
// so tokens line up with the unicode61/simple tokenizers the two backends use.
// Returns an empty slice when the input has no alphanumeric characters.
func buildSearchTokens(search string) []string {
	tokens := strings.FieldsFunc(search, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	for i, tok := range tokens {
		tokens[i] = strings.ToLower(tok)
	}
	return tokens
}

// noteSelectColumns is the note column list shared by every query that scans
// its rows with scanNote, in the exact order scanNote expects.
const noteSelectColumns = `n.id, n.user_id, n.title, n.content, n.note_type, n.version,
				  nus.color, nus.pinned, nus.archived, nus.position, nus.unpinned_position, nus.checked_items_collapsed,
				  n.deleted_at, n.created_at, n.updated_at`

func buildGetByUserIDQuery(d *dialect.Dialect, userID string, archived bool, trashed bool, search string, labelID string, myTasks bool) (string, []any) {
	// No DISTINCT: every join below is one-to-one with a note (the per-user
	// state join, the full-text search join, and — for My Tasks — an IN
	// subquery rather than a row-multiplying note_items join), so each note
	// yields exactly one row. This also lets ORDER BY reference the search
	// rank, which Postgres forbids under SELECT DISTINCT.
	const selectCols = `SELECT ` + noteSelectColumns

	var b strings.Builder
	b.WriteString(selectCols)
	args := make([]any, 0, 6)

	// FROM + per-user state join.
	switch {
	case trashed:
		b.WriteString(`
				  FROM notes n
				  INNER JOIN note_user_state nus ON n.id = nus.note_id AND nus.user_id = ?`)
		args = append(args, userID)
	default: // active notes (both the default grid and the My Tasks filter)
		b.WriteString(`
				  FROM active_notes n
				  INNER JOIN note_user_state nus ON n.id = nus.note_id AND nus.user_id = ?`)
		args = append(args, userID)
	}

	// Full-text search: join candidate note IDs (with relevance rank) from the
	// note_search index. A query of only punctuation tokenizes to nothing;
	// treat that as matching nothing rather than erroring or matching all.
	tokens := buildSearchTokens(search)
	matchedNothing := search != "" && len(tokens) == 0
	rankOrder := ""
	if search != "" && len(tokens) > 0 {
		join, order := d.FullTextSearchJoin()
		b.WriteString(join)
		args = append(args, d.FullTextMatchExpr(tokens))
		rankOrder = order
	}

	switch {
	case trashed:
		b.WriteString(` WHERE n.user_id = ? AND n.deleted_at IS NOT NULL`)
		args = append(args, userID)
	case myTasks:
		b.WriteString(` WHERE n.id IN (SELECT note_id FROM note_items WHERE assigned_to = ?)`)
		args = append(args, userID)
	default:
		b.WriteString(` WHERE nus.archived = ?`)
		args = append(args, archived)
	}

	if matchedNothing {
		b.WriteString(` AND 1 = 0`)
	}

	if labelID != "" {
		b.WriteString(` AND n.id IN (SELECT note_id FROM note_labels WHERE label_id = ? AND user_id = ?)`)
		args = append(args, labelID, userID)
	}

	// Search results order by relevance within the pinned/unpinned split; the
	// plain grid keeps its manual position order. nus.position is a stable
	// tiebreak for equally-ranked notes.
	if rankOrder != "" {
		b.WriteString(` ORDER BY nus.pinned DESC, ` + rankOrder + `, nus.position ASC`)
	} else {
		b.WriteString(` ORDER BY nus.pinned DESC, nus.position ASC`)
	}

	return b.String(), args
}

func scanNote(rows *sql.Rows) (Note, error) {
	var note Note
	err := rows.Scan(
		&note.ID, &note.UserID, &note.Title, &note.Content, &note.NoteType, &note.Version,
		&note.Color, &note.Pinned, &note.Archived, &note.Position, &note.UnpinnedPosition, &note.CheckedItemsCollapsed,
		&note.DeletedAt, &note.CreatedAt, &note.UpdatedAt,
	)
	return note, err
}

func (s *noteStore) GetByUserID(ctx context.Context, userID string, archived bool, trashed bool, search string, labelID string, myTasks bool) ([]*Note, error) {
	query, args := buildGetByUserIDQuery(s.d, userID, archived, trashed, search, labelID, myTasks)

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

	if err := s.batchLoadNoteAssociations(ctx, notes, userID); err != nil {
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
		note.Images = []NoteImage{}
		notes = append(notes, note)
	}
	return notes, nil
}

// batchLoadNoteAssociations batch-loads shares, labels, and images for a
// slice of notes, updating each note in place.
func (s *noteStore) batchLoadNoteAssociations(ctx context.Context, notes []*Note, userID string) error {
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

	imagesMap, err := s.getNoteImagesByNoteIDs(ctx, noteIDs)
	if err != nil {
		return fmt.Errorf("failed to batch-load note images: %w", err)
	}
	for _, n := range notes {
		if imgs, ok := imagesMap[n.ID]; ok {
			n.Images = imgs
		}
	}

	return nil
}

func (s *noteStore) GetByID(ctx context.Context, id string, userID string) (*Note, error) {
	query := `SELECT ` + noteSelectColumns + `
			  FROM active_notes n
			  INNER JOIN note_user_state nus ON n.id = nus.note_id AND nus.user_id = ?
			  WHERE n.id = ?`

	var note Note
	err := s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(query), userID, id).Scan(
		&note.ID, &note.UserID, &note.Title, &note.Content, &note.NoteType, &note.Version,
		&note.Color, &note.Pinned, &note.Archived, &note.Position, &note.UnpinnedPosition, &note.CheckedItemsCollapsed,
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

	query := `SELECT ` + noteSelectColumns + `
			  FROM notes n
			  INNER JOIN note_user_state nus ON n.id = nus.note_id AND nus.user_id = ?
			  WHERE n.id = ? AND n.user_id = ?`

	var ownedNote Note
	err = s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(query), userID, id, userID).Scan(
		&ownedNote.ID, &ownedNote.UserID, &ownedNote.Title, &ownedNote.Content, &ownedNote.NoteType, &ownedNote.Version,
		&ownedNote.Color, &ownedNote.Pinned, &ownedNote.Archived, &ownedNote.Position, &ownedNote.UnpinnedPosition, &ownedNote.CheckedItemsCollapsed,
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

	images, err := s.GetNoteImagesByNoteID(ctx, note.ID)
	if err != nil {
		return fmt.Errorf("failed to get note images: %w", err)
	}
	note.Images = images

	return nil
}
