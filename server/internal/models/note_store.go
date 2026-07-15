package models

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode"

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

// NewNoteItem describes a list item to insert atomically as part of note
// creation. ID is the caller-supplied item ID, or "" to generate one
// server-side. ParentID is the resolved parent item ID within the same note
// ("" for a top-level item); the caller computes it (e.g. from indent levels)
// before calling CreateWithItems.
type NewNoteItem struct {
	ID        string
	Text      string
	Position  int
	Completed bool
	ParentID  string
}

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

	var note Note
	if err = tx.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`INSERT INTO notes (id, user_id, title, content, note_type)
		 VALUES (?, ?, ?, ?, ?) RETURNING created_at, updated_at`),
		noteID, userID, title, content, noteType,
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
		s.d.RewritePlaceholders(`INSERT INTO note_user_state (note_id, user_id, color, pinned, archived, position, unpinned_position, checked_items_collapsed)
		 VALUES (?, ?, ?, FALSE, FALSE, ?, ?, FALSE)`),
		noteID, userID, color, nextPosition, nextPosition,
	); err != nil {
		return nil, fmt.Errorf("failed to create note user state: %w", err)
	}

	for _, item := range items {
		if err = insertNewNoteItemTx(ctx, tx, s.d, noteID, item); err != nil {
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
func insertNewNoteItemTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID string, item NewNoteItem) error {
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
		d.RewritePlaceholders(`INSERT INTO note_items (id, note_id, text, position, completed, parent_id, assigned_to)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`),
		itemID, noteID, item.Text, item.Position, item.Completed, nullableParentID(item.ParentID), nullableAssignedTo(""),
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
	if _, err = tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`INSERT INTO notes (id, user_id, title, content, note_type) VALUES (?, ?, ?, ?, ?)`),
		noteID,
		userID,
		duplicateNoteTitle(source.Title),
		source.Content,
		source.NoteType,
	); err != nil {
		// Two concurrent duplicates with the same caller-supplied ID can both pass
		// the existence check above; map the constraint violation to ErrNoteExists.
		if clientID != "" && s.d.IsUniqueConstraintError(err) {
			return nil, ErrNoteExists
		}
		return nil, fmt.Errorf("failed to create duplicated note: %w", err)
	}

	if _, err = tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`INSERT INTO note_user_state (note_id, user_id, color, pinned, archived, position, unpinned_position, checked_items_collapsed)
		 VALUES (?, ?, ?, FALSE, FALSE, ?, ?, ?)`),
		noteID, userID, source.Color, nextPosition, nextPosition, source.CheckedItemsCollapsed,
	); err != nil {
		return nil, fmt.Errorf("failed to create duplicated note user state: %w", err)
	}

	if err = duplicateItemsTx(ctx, tx, s.d, noteID, source.Items, itemIDs); err != nil {
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

func duplicateItemsTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID string, items []NoteItem, itemIDs map[string]string) error {
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
		if err = insertDuplicateItemTx(ctx, tx, d, noteID, item, newID, idMap); err != nil {
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
func insertDuplicateItemTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID string, item NoteItem, itemID string, idMap map[string]string) error {
	var newParent sql.NullString
	if item.ParentID != nil {
		if mapped, ok := idMap[*item.ParentID]; ok {
			newParent = sql.NullString{String: mapped, Valid: true}
		}
	}
	_, err := tx.ExecContext(ctx,
		d.RewritePlaceholders(`INSERT INTO note_items (id, note_id, text, completed, position, parent_id, assigned_to)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`),
		itemID, noteID, item.Text, item.Completed, item.Position, newParent, nullableAssignedTo(""),
	)
	return err
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

func buildGetByUserIDQuery(d *dialect.Dialect, userID string, archived bool, trashed bool, search string, labelID string, myTasks bool) (string, []any) {
	// No DISTINCT: every join below is one-to-one with a note (the per-user
	// state join, the full-text search join, and — for My Tasks — an IN
	// subquery rather than a row-multiplying note_items join), so each note
	// yields exactly one row. This also lets ORDER BY reference the search
	// rank, which Postgres forbids under SELECT DISTINCT.
	const selectCols = `SELECT n.id, n.user_id, n.title, n.content, n.note_type, n.version,
				  nus.color, nus.pinned, nus.archived, nus.position, nus.unpinned_position, nus.checked_items_collapsed,
				  n.deleted_at, n.created_at, n.updated_at`

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
	query := `SELECT n.id, n.user_id, n.title, n.content, n.note_type, n.version,
			  nus.color, nus.pinned, nus.archived, nus.position, nus.unpinned_position, nus.checked_items_collapsed,
			  n.deleted_at, n.created_at, n.updated_at
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

	query := `SELECT n.id, n.user_id, n.title, n.content, n.note_type, n.version,
			  nus.color, nus.pinned, nus.archived, nus.position, nus.unpinned_position, nus.checked_items_collapsed,
			  n.deleted_at, n.created_at, n.updated_at
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
	cutoff := time.Now().Add(-olderThan)

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

// touchNoteTx bumps a note's updated_at so item-level changes are reflected in
// note ordering (updated_at sort) and client freshness checks.
func touchNoteTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID string) error {
	if _, err := tx.ExecContext(ctx,
		d.RewritePlaceholders(`UPDATE notes SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`),
		noteID,
	); err != nil {
		return fmt.Errorf("failed to touch note: %w", err)
	}
	return nil
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
// response. Unlike ToggleItemCompleted it does not cascade to parents/children —
// callers pass the complete set they want changed (e.g. every currently-checked
// item for "uncheck all", or that same snapshot to re-check on undo), which
// preserves the parent/child completion invariant. IDs that do not belong to the
// note are ignored, so a replay/undo referencing a since-deleted item is a no-op.
// The note's updated_at is bumped only when at least one row actually changed.
func (s *noteStore) SetItemsCompleted(ctx context.Context, noteID string, itemIDs []string, completed bool) ([]NoteItem, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var changed int64
	for _, itemID := range itemIDs {
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
		changed += n
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

	type noteLabelRow struct {
		noteID string
		label  Label
	}
	scanNoteLabel := func(rows *sql.Rows) (noteLabelRow, error) {
		var r noteLabelRow
		err := rows.Scan(&r.noteID, &r.label.ID, &r.label.UserID, &r.label.Name, &r.label.CreatedAt, &r.label.UpdatedAt)
		return r, err
	}

	result := map[string][]Label{}
	// Chunk the note IDs so the bound-parameter count stays under the driver's
	// limit, matching getSharesByNoteIDs/getNoteImagesByNoteIDs.
	for chunk := range slices.Chunk(noteIDs, noteIDsQueryBatchSize) {
		placeholders := strings.Join(slices.Repeat([]string{"?"}, len(chunk)), ",")
		args := make([]any, 0, len(chunk)+1)
		for _, id := range chunk {
			args = append(args, id)
		}
		args = append(args, userID)

		rawQuery := `SELECT nl.note_id, l.id, l.user_id, l.name, l.created_at, l.updated_at
				  FROM labels l
				  JOIN note_labels nl ON l.id = nl.label_id
				  WHERE nl.note_id IN (` + placeholders + `) AND nl.user_id = ?
				  ORDER BY nl.note_id, l.name ASC` // #nosec G202 -- only "?" placeholders are joined, no user input

		rows, err := s.db.QueryContext(ctx, s.d.RewritePlaceholders(rawQuery), args...)
		if err != nil {
			return nil, fmt.Errorf("failed to batch-get note labels: %w", err)
		}

		for row, err := range scanRows(rows, scanNoteLabel) {
			if err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("failed to scan note label: %w", err)
			}
			result[row.noteID] = append(result[row.noteID], row.label)
		}
		if err := rows.Close(); err != nil {
			return nil, fmt.Errorf("failed to close note labels rows: %w", err)
		}
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
