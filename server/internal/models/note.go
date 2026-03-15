package models

import (
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	sqlite3 "github.com/mattn/go-sqlite3"
	"github.com/sirupsen/logrus"
)

type NoteType string

const (
	NoteTypeText NoteType = "text"
	NoteTypeTodo NoteType = "todo"

	DefaultNoteColor = "#ffffff"
)

var ErrNoteNoAccess = errors.New("no access to note")
var ErrNoteNotFound = errors.New("note not found")
var ErrNoteNotOwnedByUser = errors.New("note not found or not owned by user")
var ErrNoteNotInTrash = errors.New("note not found in trash or not owned by user")
var ErrNoteShareNotFound = errors.New("note share not found")
var ErrNoteAlreadyShared = errors.New("note already shared with user")

type Label struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Note struct {
	ID                    string      `json:"id"`
	UserID                string      `json:"user_id"`
	Title                 string      `json:"title"`
	Content               string      `json:"content"`
	NoteType              NoteType    `json:"note_type"`
	Color                 string      `json:"color"`
	Pinned                bool        `json:"pinned"`
	Archived              bool        `json:"archived"`
	Position              int         `json:"position"`
	UnpinnedPosition      *int        `json:"-"` // Hidden from JSON, used internally
	CheckedItemsCollapsed bool        `json:"checked_items_collapsed"`
	Items                 []NoteItem  `json:"items,omitempty"`
	SharedWith            []NoteShare `json:"shared_with,omitempty"`
	IsShared              bool        `json:"is_shared"`
	Labels                []Label     `json:"labels"`
	OwnerUsername         string      `json:"owner_username,omitempty"`
	OwnerHasProfileIcon   bool        `json:"owner_has_profile_icon,omitempty"`
	DeletedAt             *time.Time  `json:"deleted_at"`
	CreatedAt             time.Time   `json:"created_at"`
	UpdatedAt             time.Time   `json:"updated_at"`
}

type NoteItem struct {
	ID               string    `json:"id"`
	NoteID           string    `json:"note_id"`
	Text             string    `json:"text"`
	Completed        bool      `json:"completed"`
	Position         int       `json:"position"`
	IndentLevel      int       `json:"indent_level"`
	AssignedTo       string    `json:"assigned_to"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

type NoteShare struct {
	ID               string    `json:"id"`
	NoteID           string    `json:"note_id"`
	SharedWithUserID string    `json:"shared_with_user_id"`
	SharedByUserID   string    `json:"shared_by_user_id"`
	PermissionLevel  string    `json:"permission_level"`
	Username         string    `json:"username,omitempty"`
	FirstName        string    `json:"first_name,omitempty"`
	LastName         string    `json:"last_name,omitempty"`
	HasProfileIcon   bool      `json:"has_profile_icon"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

type NoteStore struct {
	db *sql.DB
}

func NewNoteStore(db *sql.DB) *NoteStore {
	return &NoteStore{db: db}
}

func generateID() (string, error) {
	const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
	bytes := make([]byte, 22)
	randBytes := make([]byte, 22)

	if _, err := rand.Read(randBytes); err != nil {
		return "", err
	}

	for i := range 22 {
		bytes[i] = chars[randBytes[i]%byte(len(chars))]
	}

	return string(bytes), nil
}

func IsValidID(id string) bool {
	if len(id) != 22 {
		return false
	}
	const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
	for _, char := range id {
		found := false
		for _, validChar := range chars {
			if char == validChar {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func (s *NoteStore) Create(userID string, title, content string, noteType NoteType, color string) (*Note, error) {
	// Generate note ID
	noteID, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate note ID: %w", err)
	}

	// Shift existing unpinned notes down to make room at position 0
	shiftQuery := `UPDATE notes SET position = position + 1 WHERE user_id = ? AND pinned = FALSE AND archived = FALSE AND deleted_at IS NULL`
	_, err = s.db.Exec(shiftQuery, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to shift existing notes: %w", err)
	}

	// New notes go at position 0 (first position)
	nextPosition := 0

	query := `INSERT INTO notes (id, user_id, title, content, note_type, color, position, unpinned_position, checked_items_collapsed) 
			  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING pinned, archived, created_at, updated_at`

	var note Note
	err = s.db.QueryRow(query, noteID, userID, title, content, noteType, color, nextPosition, nextPosition, false).Scan(
		&note.Pinned, &note.Archived,
		&note.CreatedAt, &note.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create note: %w", err)
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

func buildGetByUserIDQuery(userID string, archived bool, trashed bool, search string, labelID string) (string, []any) {
	var query string
	var args []any
	if trashed {
		query = `SELECT DISTINCT n.id, n.user_id, n.title, n.content, n.note_type, n.color, n.pinned, n.archived, n.position, n.unpinned_position, n.checked_items_collapsed, n.deleted_at, n.created_at, n.updated_at, u.username, u.profile_icon IS NOT NULL
				  FROM notes n
				  JOIN users u ON n.user_id = u.id
				  LEFT JOIN note_items ni ON n.id = ni.note_id
				  WHERE n.user_id = ? AND n.deleted_at IS NOT NULL`
		args = []any{userID}
	} else {
		query = `SELECT DISTINCT n.id, n.user_id, n.title, n.content, n.note_type, n.color, n.pinned, n.archived, n.position, n.unpinned_position, n.checked_items_collapsed, n.deleted_at, n.created_at, n.updated_at, u.username, u.profile_icon IS NOT NULL
				  FROM notes n
				  JOIN users u ON n.user_id = u.id
				  LEFT JOIN note_shares ns ON n.id = ns.note_id
				  LEFT JOIN note_items ni ON n.id = ni.note_id
				  WHERE (n.user_id = ? OR ns.shared_with_user_id = ?) AND n.archived = ? AND n.deleted_at IS NULL`
		args = []any{userID, userID, archived}
	}
	if search != "" {
		query += ` AND (n.title LIKE ? OR n.content LIKE ? OR ni.text LIKE ?)`
		searchTerm := "%" + search + "%"
		args = append(args, searchTerm, searchTerm, searchTerm)
	}
	if labelID != "" {
		query += ` AND n.id IN (SELECT note_id FROM note_labels WHERE label_id = ?)`
		args = append(args, labelID)
	}
	query += ` ORDER BY n.pinned DESC, n.position ASC`
	return query, args
}

func (s *NoteStore) GetByUserID(userID string, archived bool, trashed bool, search string, labelID string) ([]*Note, error) {
	query, args := buildGetByUserIDQuery(userID, archived, trashed, search, labelID)

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to get notes: %w", err)
	}
	defer func() {
		if err = rows.Close(); err != nil {
			logrus.WithError(err).Error("Failed to close rows")
		}
	}()

	var notes []*Note
	for rows.Next() {
		var note Note
		err = rows.Scan(
			&note.ID, &note.UserID, &note.Title, &note.Content,
			&note.NoteType, &note.Color, &note.Pinned, &note.Archived, &note.Position, &note.UnpinnedPosition, &note.CheckedItemsCollapsed,
			&note.DeletedAt, &note.CreatedAt, &note.UpdatedAt,
			&note.OwnerUsername, &note.OwnerHasProfileIcon,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan note: %w", err)
		}

		if note.NoteType == NoteTypeTodo {
			items, itemsErr := s.getItemsByNoteID(note.ID)
			if itemsErr != nil {
				return nil, fmt.Errorf("failed to get note items: %w", itemsErr)
			}
			note.Items = items
		}

		shares, sharesErr := s.GetNoteShares(note.ID)
		if sharesErr != nil {
			return nil, fmt.Errorf("failed to get note shares: %w", sharesErr)
		}
		note.SharedWith = shares
		note.IsShared = len(shares) > 0
		note.Labels = []Label{}

		notes = append(notes, &note)
	}

	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate notes: %w", err)
	}

	// Batch-load labels for all notes in a single query.
	if len(notes) > 0 {
		noteIDs := make([]string, len(notes))
		for i, n := range notes {
			noteIDs[i] = n.ID
		}
		labelsMap, labelsErr := s.getLabelsByNoteIDs(noteIDs)
		if labelsErr != nil {
			return nil, fmt.Errorf("failed to batch-load note labels: %w", labelsErr)
		}
		for _, n := range notes {
			if lbls, ok := labelsMap[n.ID]; ok {
				n.Labels = lbls
			}
		}
	}

	return notes, nil
}

func (s *NoteStore) GetByID(id string, userID string) (*Note, error) {
	hasAccess, err := s.HasAccess(id, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to check access: %w", err)
	}
	if !hasAccess {
		return nil, ErrNoteNotFound
	}

	query := `SELECT n.id, n.user_id, n.title, n.content, n.note_type, n.color, n.pinned, n.archived, n.position, n.unpinned_position, n.checked_items_collapsed, n.deleted_at, n.created_at, n.updated_at, u.username, u.profile_icon IS NOT NULL
			  FROM notes n JOIN users u ON n.user_id = u.id WHERE n.id = ? AND n.deleted_at IS NULL`

	var note Note
	err = s.db.QueryRow(query, id).Scan(
		&note.ID, &note.UserID, &note.Title, &note.Content,
		&note.NoteType, &note.Color, &note.Pinned, &note.Archived, &note.Position, &note.UnpinnedPosition, &note.CheckedItemsCollapsed,
		&note.DeletedAt, &note.CreatedAt, &note.UpdatedAt,
		&note.OwnerUsername, &note.OwnerHasProfileIcon,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNoteNotFound
		}
		return nil, fmt.Errorf("failed to get note: %w", err)
	}

	if note.NoteType == NoteTypeTodo {
		var items []NoteItem
		items, err = s.getItemsByNoteID(note.ID)
		if err != nil {
			return nil, fmt.Errorf("failed to get note items: %w", err)
		}
		note.Items = items
	}

	shares, err := s.GetNoteShares(note.ID)
	if err != nil {
		return nil, fmt.Errorf("failed to get note shares: %w", err)
	}
	note.SharedWith = shares
	note.IsShared = len(shares) > 0

	labels, err := s.GetNoteLabels(note.ID)
	if err != nil {
		return nil, fmt.Errorf("failed to get note labels: %w", err)
	}
	note.Labels = labels

	return &note, nil
}

func (s *NoteStore) Update(id string, userID string, title, content string, pinned, archived bool, color string, checkedItemsCollapsed bool) error {
	hasAccess, err := s.HasAccess(id, userID)
	if err != nil {
		return fmt.Errorf("failed to check access: %w", err)
	}
	if !hasAccess {
		return ErrNoteNoAccess
	}

	// Get current note state to check if pinned status is changing
	currentNote, err := s.GetByID(id, userID)
	if err != nil {
		return fmt.Errorf("failed to get current note: %w", err)
	}

	query := `UPDATE notes SET title = ?, content = ?, pinned = ?, archived = ?, color = ?, checked_items_collapsed = ?, updated_at = CURRENT_TIMESTAMP
			  WHERE id = ?`

	result, err := s.db.Exec(query, title, content, pinned, archived, color, checkedItemsCollapsed, id)
	if err != nil {
		return fmt.Errorf("failed to update note: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}

	if rowsAffected == 0 {
		return ErrNoteNotFound
	}

	// If pinned status changed, handle position preservation
	if currentNote.Pinned != pinned {
		if pinned {
			// Pinning: Store current position as unpinned_position and move to end of pinned
			var maxPosition int
			posQuery := `SELECT COALESCE(MAX(position), -1) FROM notes WHERE user_id = ? AND pinned = ? AND archived = FALSE AND deleted_at IS NULL`
			if err = s.db.QueryRow(posQuery, userID, pinned).Scan(&maxPosition); err != nil {
				return fmt.Errorf("failed to get max position: %w", err)
			}
			newPosition := maxPosition + 1

			posUpdateQuery := `UPDATE notes SET position = ?, unpinned_position = ? WHERE id = ?`
			if _, err = s.db.Exec(posUpdateQuery, newPosition, currentNote.Position, id); err != nil {
				return fmt.Errorf("failed to update position: %w", err)
			}
		} else {
			// Unpinning: Restore to unpinned_position if available, otherwise add to end
			var targetPosition int
			if currentNote.UnpinnedPosition != nil {
				targetPosition = *currentNote.UnpinnedPosition

				// Shift other unpinned notes to make room
				shiftQuery := `UPDATE notes SET position = position + 1
							   WHERE user_id = ? AND pinned = FALSE AND archived = FALSE AND deleted_at IS NULL AND position >= ?`
				if _, err = s.db.Exec(shiftQuery, userID, targetPosition); err != nil {
					return fmt.Errorf("failed to shift notes: %w", err)
				}
			} else {
				// No saved position, add to end
				var maxPosition int
				posQuery := `SELECT COALESCE(MAX(position), -1) FROM notes WHERE user_id = ? AND pinned = ? AND archived = FALSE AND deleted_at IS NULL`
				if err = s.db.QueryRow(posQuery, userID, pinned).Scan(&maxPosition); err != nil {
					return fmt.Errorf("failed to get max position: %w", err)
				}
				targetPosition = maxPosition + 1
			}

			posUpdateQuery := `UPDATE notes SET position = ?, unpinned_position = NULL WHERE id = ?`
			if _, err = s.db.Exec(posUpdateQuery, targetPosition, id); err != nil {
				return fmt.Errorf("failed to update position: %w", err)
			}
		}
	}

	return nil
}

func (s *NoteStore) Delete(id string, userID string) error {
	isOwner, err := s.IsOwner(id, userID)
	if err != nil {
		return fmt.Errorf("failed to check ownership: %w", err)
	}
	if !isOwner {
		return ErrNoteNotOwnedByUser
	}

	result, err := s.db.Exec("DELETE FROM notes WHERE id = ? AND user_id = ?", id, userID)
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

	return nil
}

// MoveToTrash soft-deletes a note by setting deleted_at to the current time.
// The note is unpinned and unarchived so it doesn't appear in those filtered views.
func (s *NoteStore) MoveToTrash(id string, userID string) error {
	isOwner, err := s.IsOwner(id, userID)
	if err != nil {
		return fmt.Errorf("failed to check ownership: %w", err)
	}
	if !isOwner {
		return ErrNoteNotOwnedByUser
	}

	result, err := s.db.Exec(
		`UPDATE notes SET deleted_at = CURRENT_TIMESTAMP, pinned = FALSE, archived = FALSE, updated_at = CURRENT_TIMESTAMP
		 WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
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

	return nil
}

// RestoreFromTrash clears deleted_at and places the restored note at position 0
// of the unpinned active list, shifting existing notes down.
func (s *NoteStore) RestoreFromTrash(id string, userID string) error {
	isOwner, err := s.IsOwner(id, userID)
	if err != nil {
		return fmt.Errorf("failed to check ownership: %w", err)
	}
	if !isOwner {
		return ErrNoteNotOwnedByUser
	}

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Restore the note first — if it's not actually in the trash we bail out
	// before shifting any positions.
	result, err := tx.Exec(
		`UPDATE notes SET deleted_at = NULL, pinned = FALSE, archived = FALSE, position = 0, updated_at = CURRENT_TIMESTAMP
		 WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL`,
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

	// Shift existing active unpinned notes down to make room at position 0.
	shiftQuery := `UPDATE notes SET position = position + 1
	               WHERE user_id = ? AND pinned = FALSE AND archived = FALSE AND deleted_at IS NULL AND id != ?`
	if _, err = tx.Exec(shiftQuery, userID, id); err != nil {
		return fmt.Errorf("failed to shift notes after restore: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit restore transaction: %w", err)
	}

	return nil
}

// DeleteFromTrash permanently removes a note that is already in the trash.
// It returns ErrNoteNotInTrash if the note is not found in the trash or not owned by the user.
func (s *NoteStore) DeleteFromTrash(id string, userID string) error {
	result, err := s.db.Exec(
		`DELETE FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL`,
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

	return nil
}

// PurgeOldTrashedNotes permanently deletes all notes that have been in the trash
// longer than the given duration. This is intended to be called periodically.
func (s *NoteStore) PurgeOldTrashedNotes(olderThan time.Duration) error {
	cutoff := time.Now().Add(-olderThan)
	_, err := s.db.Exec(`DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?`, cutoff)
	if err != nil {
		return fmt.Errorf("failed to purge old trashed notes: %w", err)
	}
	return nil
}

func (s *NoteStore) getItemsByNoteID(noteID string) ([]NoteItem, error) {
	query := `SELECT id, note_id, text, completed, position, indent_level,
			  assigned_to, created_at, updated_at
			  FROM note_items WHERE note_id = ? ORDER BY position`

	rows, err := s.db.Query(query, noteID)
	if err != nil {
		return nil, fmt.Errorf("failed to get note items: %w", err)
	}
	defer func() {
		if err := rows.Close(); err != nil {
			logrus.WithError(err).Error("Failed to close rows")
		}
	}()

	var items []NoteItem
	for rows.Next() {
		var item NoteItem
		err := rows.Scan(
			&item.ID, &item.NoteID, &item.Text, &item.Completed,
			&item.Position, &item.IndentLevel, &item.AssignedTo,
			&item.CreatedAt, &item.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan note item: %w", err)
		}
		items = append(items, item)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate note items: %w", err)
	}

	return items, nil
}

func (s *NoteStore) CreateItem(noteID string, text string, position, indentLevel int, assignedTo string) (*NoteItem, error) {
	itemID, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate item ID: %w", err)
	}

	query := `INSERT INTO note_items (id, note_id, text, position, indent_level, assigned_to)
			  VALUES (?, ?, ?, ?, ?, ?) RETURNING completed, created_at, updated_at`

	var item NoteItem
	err = s.db.QueryRow(query, itemID, noteID, text, position, indentLevel, assignedTo).Scan(
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
func (s *NoteStore) UpdateItem(id string, text string, completed bool, position, indentLevel int) error {
	query := `UPDATE note_items SET text = ?, completed = ?, position = ?, indent_level = ?, updated_at = CURRENT_TIMESTAMP
			  WHERE id = ?`

	_, err := s.db.Exec(query, text, completed, position, indentLevel, id)
	if err != nil {
		return fmt.Errorf("failed to update note item: %w", err)
	}

	return nil
}

func (s *NoteStore) DeleteItem(id string) error {
	_, err := s.db.Exec("DELETE FROM note_items WHERE id = ?", id)
	if err != nil {
		return fmt.Errorf("failed to delete note item: %w", err)
	}

	return nil
}

func (s *NoteStore) DeleteItemsByNoteID(noteID string) error {
	_, err := s.db.Exec("DELETE FROM note_items WHERE note_id = ?", noteID)
	if err != nil {
		return fmt.Errorf("failed to delete note items: %w", err)
	}
	return nil
}

func (s *NoteStore) CreateItemWithCompleted(noteID string, text string, position int, completed bool, indentLevel int, assignedTo string) (*NoteItem, error) {
	itemID, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate item ID: %w", err)
	}

	query := `INSERT INTO note_items (id, note_id, text, position, completed, indent_level, assigned_to)
			  VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING created_at, updated_at`
	var item NoteItem
	err = s.db.QueryRow(query, itemID, noteID, text, position, completed, indentLevel, assignedTo).Scan(
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

func (s *NoteStore) ShareNote(noteID string, sharedByUserID, sharedWithUserID string) error {
	// Generate share ID
	shareID, err := generateID()
	if err != nil {
		return fmt.Errorf("failed to generate share ID: %w", err)
	}

	query := `INSERT INTO note_shares (id, note_id, shared_with_user_id, shared_by_user_id, permission_level)
			  VALUES (?, ?, ?, ?, 'edit')`

	_, err = s.db.Exec(query, shareID, noteID, sharedWithUserID, sharedByUserID)
	if err != nil {
		var sqliteErr sqlite3.Error
		if errors.As(err, &sqliteErr) && sqliteErr.ExtendedCode == sqlite3.ErrConstraintUnique {
			return ErrNoteAlreadyShared
		}
		return fmt.Errorf("failed to share note: %w", err)
	}

	return nil
}

func (s *NoteStore) UnshareNote(noteID string, sharedWithUserID string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	result, err := tx.Exec(`DELETE FROM note_shares WHERE note_id = ? AND shared_with_user_id = ?`, noteID, sharedWithUserID)
	if err != nil {
		return fmt.Errorf("failed to unshare note: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}

	if rowsAffected == 0 {
		return ErrNoteShareNotFound
	}

	if _, err = tx.Exec(
		`UPDATE note_items SET assigned_to = '' WHERE note_id = ? AND assigned_to = ?`,
		noteID, sharedWithUserID,
	); err != nil {
		return fmt.Errorf("failed to clear assignments for unshared user: %w", err)
	}

	var remainingShares int
	if err = tx.QueryRow(`SELECT COUNT(*) FROM note_shares WHERE note_id = ?`, noteID).Scan(&remainingShares); err != nil {
		return fmt.Errorf("failed to count remaining shares: %w", err)
	}

	if remainingShares == 0 {
		if _, err = tx.Exec(
			`UPDATE note_items SET assigned_to = '' WHERE note_id = ? AND assigned_to != ''`,
			noteID,
		); err != nil {
			return fmt.Errorf("failed to clear all assignments: %w", err)
		}
	}

	if err = tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit unshare transaction: %w", err)
	}

	return nil
}

// ClearUserAssignmentsTx clears all item assignments related to a deleted user
// within an existing transaction. It:
//  1. Removes the user's note_shares rows (SQLite FK cascades are not enforced).
//  2. Clears items directly assigned to the deleted user.
//  3. Clears all remaining assignments on notes that no longer have any shares,
//     enforcing the invariant that unshared notes cannot have assignments.
func (s *NoteStore) ClearUserAssignmentsTx(tx *sql.Tx, userID string) error {
	if _, err := tx.Exec(
		`DELETE FROM note_shares WHERE shared_with_user_id = ?`,
		userID,
	); err != nil {
		return fmt.Errorf("failed to remove deleted user shares: %w", err)
	}

	if _, err := tx.Exec(
		`UPDATE note_items SET assigned_to = '' WHERE assigned_to = ?`,
		userID,
	); err != nil {
		return fmt.Errorf("failed to clear deleted user assignments: %w", err)
	}

	if _, err := tx.Exec(
		`UPDATE note_items SET assigned_to = ''
		 WHERE assigned_to != ''
		   AND note_id NOT IN (SELECT DISTINCT note_id FROM note_shares)`,
	); err != nil {
		return fmt.Errorf("failed to clear assignments on unshared notes: %w", err)
	}

	return nil
}

func (s *NoteStore) GetNoteShares(noteID string) ([]NoteShare, error) {
	query := `SELECT ns.id, ns.note_id, ns.shared_with_user_id, ns.shared_by_user_id,
			  ns.permission_level, u.username, u.first_name, u.last_name,
			  u.profile_icon IS NOT NULL AS has_profile_icon,
			  ns.created_at, ns.updated_at
			  FROM note_shares ns
			  JOIN users u ON ns.shared_with_user_id = u.id
			  WHERE ns.note_id = ?
			  ORDER BY u.username`

	rows, err := s.db.Query(query, noteID)
	if err != nil {
		return nil, fmt.Errorf("failed to get note shares: %w", err)
	}
	defer func() {
		if err := rows.Close(); err != nil {
			logrus.WithError(err).Error("Failed to close rows")
		}
	}()

	var shares []NoteShare
	for rows.Next() {
		var share NoteShare
		err := rows.Scan(
			&share.ID, &share.NoteID, &share.SharedWithUserID, &share.SharedByUserID,
			&share.PermissionLevel, &share.Username, &share.FirstName, &share.LastName,
			&share.HasProfileIcon, &share.CreatedAt, &share.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan note share: %w", err)
		}
		shares = append(shares, share)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate note shares: %w", err)
	}

	return shares, nil
}

func (s *NoteStore) HasAccess(noteID string, userID string) (bool, error) {
	var count int
	query := `SELECT COUNT(*) FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL
			  UNION ALL
			  SELECT COUNT(*) FROM note_shares WHERE note_id = ? AND shared_with_user_id = ?
			    AND (SELECT deleted_at FROM notes WHERE id = ?) IS NULL`

	rows, err := s.db.Query(query, noteID, userID, noteID, userID, noteID)
	if err != nil {
		return false, fmt.Errorf("failed to check access: %w", err)
	}
	defer func() {
		if err := rows.Close(); err != nil {
			logrus.WithError(err).Error("Failed to close rows")
		}
	}()

	totalCount := 0
	for rows.Next() {
		err := rows.Scan(&count)
		if err != nil {
			return false, fmt.Errorf("failed to scan count: %w", err)
		}
		totalCount += count
	}

	if err := rows.Err(); err != nil {
		return false, fmt.Errorf("failed to iterate access rows: %w", err)
	}

	return totalCount > 0, nil
}

func (s *NoteStore) IsOwner(noteID string, userID string) (bool, error) {
	var count int
	query := `SELECT COUNT(*) FROM notes WHERE id = ? AND user_id = ?`

	err := s.db.QueryRow(query, noteID, userID).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("failed to check ownership: %w", err)
	}

	return count > 0, nil
}

// GetOwnerID returns the owner user ID for a note.
func (s *NoteStore) GetOwnerID(noteID string) (string, error) {
	var ownerID string
	err := s.db.QueryRow(`SELECT user_id FROM notes WHERE id = ?`, noteID).Scan(&ownerID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", ErrNoteNotFound
		}
		return "", fmt.Errorf("failed to get note owner: %w", err)
	}
	return ownerID, nil
}

func (s *NoteStore) ReorderNotes(userID string, noteIDs []string) error {
	if len(noteIDs) == 0 {
		return nil
	}

	// Start transaction
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() {
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			logrus.WithError(rollbackErr).Error("Failed to rollback transaction")
		}
	}()

	// Update positions for each note
	for i, noteID := range noteIDs {
		// Verify user has access to this note
		var hasAccess bool
		hasAccess, err = s.HasAccess(noteID, userID)
		if err != nil {
			return fmt.Errorf("failed to check access for note %s: %w", noteID, err)
		}
		if !hasAccess {
			return fmt.Errorf("no access to note %s: %w", noteID, ErrNoteNoAccess)
		}

		// Update position
		if _, err = tx.Exec("UPDATE notes SET position = ? WHERE id = ?", i, noteID); err != nil {
			return fmt.Errorf("failed to update position for note %s: %w", noteID, err)
		}
	}

	// Commit transaction
	err = tx.Commit()
	if err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

// getLabelsByNoteIDs batch-loads labels for a set of note IDs, returning a map of noteID -> []Label.
func (s *NoteStore) getLabelsByNoteIDs(noteIDs []string) (map[string][]Label, error) {
	if len(noteIDs) == 0 {
		return map[string][]Label{}, nil
	}

	placeholders := make([]string, len(noteIDs))
	args := make([]any, len(noteIDs))
	for i, id := range noteIDs {
		placeholders[i] = "?"
		args[i] = id
	}

	query := `SELECT nl.note_id, l.id, l.user_id, l.name, l.created_at, l.updated_at
			  FROM labels l
			  JOIN note_labels nl ON l.id = nl.label_id
			  WHERE nl.note_id IN (` + strings.Join(placeholders, ",") + `)
			  ORDER BY nl.note_id, l.name ASC` // #nosec G202 -- only "?" placeholders are joined, no user input

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to batch-get note labels: %w", err)
	}
	defer func() {
		if err := rows.Close(); err != nil {
			logrus.Errorf("Failed to close rows: %v", err)
		}
	}()

	result := map[string][]Label{}
	for rows.Next() {
		var noteID string
		var l Label
		if err := rows.Scan(&noteID, &l.ID, &l.UserID, &l.Name, &l.CreatedAt, &l.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan note label: %w", err)
		}
		result[noteID] = append(result[noteID], l)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate note labels: %w", err)
	}
	return result, nil
}

// GetLabels returns all labels belonging to a user.
func (s *NoteStore) GetLabels(userID string) ([]Label, error) {
	query := `SELECT id, user_id, name, created_at, updated_at FROM labels WHERE user_id = ? ORDER BY name ASC`
	rows, err := s.db.Query(query, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get labels: %w", err)
	}
	defer func() {
		if err := rows.Close(); err != nil {
			logrus.Errorf("Failed to close rows: %v", err)
		}
	}()

	labels := []Label{}
	for rows.Next() {
		var l Label
		if err := rows.Scan(&l.ID, &l.UserID, &l.Name, &l.CreatedAt, &l.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan label: %w", err)
		}
		labels = append(labels, l)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate labels: %w", err)
	}
	return labels, nil
}

// GetNoteLabels returns all labels attached to a note.
func (s *NoteStore) GetNoteLabels(noteID string) ([]Label, error) {
	query := `SELECT l.id, l.user_id, l.name, l.created_at, l.updated_at
			  FROM labels l
			  JOIN note_labels nl ON l.id = nl.label_id
			  WHERE nl.note_id = ?
			  ORDER BY l.name ASC`
	rows, err := s.db.Query(query, noteID)
	if err != nil {
		return nil, fmt.Errorf("failed to get note labels: %w", err)
	}
	defer func() {
		if err := rows.Close(); err != nil {
			logrus.Errorf("Failed to close rows: %v", err)
		}
	}()

	labels := []Label{}
	for rows.Next() {
		var l Label
		if err := rows.Scan(&l.ID, &l.UserID, &l.Name, &l.CreatedAt, &l.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan label: %w", err)
		}
		labels = append(labels, l)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate note labels: %w", err)
	}
	return labels, nil
}

// GetOrCreateLabel finds an existing label by name for a user or creates a new one.
// Uses an atomic upsert to avoid race conditions when multiple callers create the same label concurrently.
func (s *NoteStore) GetOrCreateLabel(userID, name string) (*Label, error) {
	id, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate label ID: %w", err)
	}

	var l Label
	err = s.db.QueryRow(
		`INSERT INTO labels (id, user_id, name) VALUES (?, ?, ?)
		 ON CONFLICT(user_id, name) DO UPDATE SET name=excluded.name
		 RETURNING id, user_id, name, created_at, updated_at`,
		id, userID, name,
	).Scan(&l.ID, &l.UserID, &l.Name, &l.CreatedAt, &l.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to get or create label: %w", err)
	}
	return &l, nil
}

// AddLabelToNote attaches a label to a note (user must have access).
func (s *NoteStore) AddLabelToNote(noteID, labelID, userID string) error {
	hasAccess, err := s.HasAccess(noteID, userID)
	if err != nil {
		return fmt.Errorf("failed to check access: %w", err)
	}
	if !hasAccess {
		return ErrNoteNoAccess
	}

	id, err := generateID()
	if err != nil {
		return fmt.Errorf("failed to generate note_label ID: %w", err)
	}
	_, err = s.db.Exec(
		`INSERT OR IGNORE INTO note_labels (id, note_id, label_id) VALUES (?, ?, ?)`,
		id, noteID, labelID,
	)
	if err != nil {
		return fmt.Errorf("failed to add label to note: %w", err)
	}
	return nil
}

// RemoveLabelFromNote detaches a label from a note (user must have access).
func (s *NoteStore) RemoveLabelFromNote(noteID, labelID, userID string) error {
	hasAccess, err := s.HasAccess(noteID, userID)
	if err != nil {
		return fmt.Errorf("failed to check access: %w", err)
	}
	if !hasAccess {
		return ErrNoteNoAccess
	}

	_, err = s.db.Exec(
		`DELETE FROM note_labels WHERE note_id = ? AND label_id = ?`,
		noteID, labelID,
	)
	if err != nil {
		return fmt.Errorf("failed to remove label from note: %w", err)
	}
	return nil
}

// GetNoteAudienceIDs returns the owner's user ID plus all shared_with user IDs for a note.
// Used by handlers to determine who to broadcast SSE events to.
func (s *NoteStore) GetNoteAudienceIDs(noteID string) ([]string, error) {
	query := `
		SELECT user_id FROM notes WHERE id = ?
		UNION
		SELECT shared_with_user_id FROM note_shares WHERE note_id = ?
	`
	rows, err := s.db.Query(query, noteID, noteID)
	if err != nil {
		return nil, fmt.Errorf("failed to get note audience: %w", err)
	}
	defer func() {
		if err := rows.Close(); err != nil {
			logrus.WithError(err).Error("Failed to close rows in GetNoteAudienceIDs")
		}
	}()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("failed to scan user ID: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate note audience rows: %w", err)
	}
	return ids, nil
}
