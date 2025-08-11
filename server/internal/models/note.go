package models

import (
	"crypto/rand"
	"database/sql"
	"fmt"
	"log"
	"time"
)

type NoteType string

const (
	NoteTypeText NoteType = "text"
	NoteTypeTodo NoteType = "todo"
)

type Note struct {
	ID               string      `json:"id"`
	UserID           string      `json:"user_id"`
	Title            string      `json:"title"`
	Content          string      `json:"content"`
	NoteType         NoteType    `json:"note_type"`
	Color            string      `json:"color"`
	Pinned           bool        `json:"pinned"`
	Archived         bool        `json:"archived"`
	Position         int         `json:"position"`
	UnpinnedPosition *int        `json:"-"` // Hidden from JSON, used internally
	Items            []NoteItem  `json:"items,omitempty"`
	SharedWith       []NoteShare `json:"shared_with,omitempty"`
	IsShared         bool        `json:"is_shared"`
	CreatedAt        time.Time   `json:"created_at"`
	UpdatedAt        time.Time   `json:"updated_at"`
}

type NoteItem struct {
	ID        string    `json:"id"`
	NoteID    string    `json:"note_id"`
	Text      string    `json:"text"`
	Completed bool      `json:"completed"`
	Position  int       `json:"position"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type NoteShare struct {
	ID               string    `json:"id"`
	NoteID           string    `json:"note_id"`
	SharedWithUserID string    `json:"shared_with_user_id"`
	SharedByUserID   string    `json:"shared_by_user_id"`
	PermissionLevel  string    `json:"permission_level"`
	Username         string    `json:"username,omitempty"`
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
	
	for i := 0; i < 22; i++ {
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
	shiftQuery := `UPDATE notes SET position = position + 1 WHERE user_id = ? AND pinned = FALSE AND archived = FALSE`
	_, err = s.db.Exec(shiftQuery, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to shift existing notes: %w", err)
	}
	
	// New notes go at position 0 (first position)
	nextPosition := 0

	query := `INSERT INTO notes (id, user_id, title, content, note_type, color, position, unpinned_position) 
			  VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING pinned, archived, created_at, updated_at`

	var note Note
	err = s.db.QueryRow(query, noteID, userID, title, content, noteType, color, nextPosition, nextPosition).Scan(
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

	return &note, nil
}

func (s *NoteStore) GetByUserID(userID string, archived bool, search string) ([]*Note, error) {
	query := `SELECT DISTINCT n.id, n.user_id, n.title, n.content, n.note_type, n.color, n.pinned, n.archived, n.position, n.unpinned_position, n.created_at, n.updated_at
			  FROM notes n
			  LEFT JOIN note_shares ns ON n.id = ns.note_id
			  WHERE (n.user_id = ? OR ns.shared_with_user_id = ?) AND n.archived = ?`
	args := []any{userID, userID, archived}

	if search != "" {
		query += ` AND (n.title LIKE ? OR n.content LIKE ?)`
		searchTerm := "%" + search + "%"
		args = append(args, searchTerm, searchTerm)
	}

	query += ` ORDER BY n.pinned DESC, n.position ASC`

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to get notes: %w", err)
	}
	defer func() {
		if err = rows.Close(); err != nil {
			log.Printf("Failed to close rows: %v", err)
		}
	}()

	var notes []*Note
	for rows.Next() {
		var note Note
		err = rows.Scan(
			&note.ID, &note.UserID, &note.Title, &note.Content,
			&note.NoteType, &note.Color, &note.Pinned, &note.Archived, &note.Position, &note.UnpinnedPosition,
			&note.CreatedAt, &note.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan note: %w", err)
		}

		if note.NoteType == NoteTypeTodo {
			items, err := s.getItemsByNoteID(note.ID)
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

		notes = append(notes, &note)
	}

	return notes, nil
}

func (s *NoteStore) GetByID(id string, userID string) (*Note, error) {
	hasAccess, err := s.HasAccess(id, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to check access: %w", err)
	}
	if !hasAccess {
		return nil, fmt.Errorf("note not found")
	}

	query := `SELECT id, user_id, title, content, note_type, color, pinned, archived, position, unpinned_position, created_at, updated_at
			  FROM notes WHERE id = ?`

	var note Note
	err = s.db.QueryRow(query, id).Scan(
		&note.ID, &note.UserID, &note.Title, &note.Content,
		&note.NoteType, &note.Color, &note.Pinned, &note.Archived, &note.Position, &note.UnpinnedPosition,
		&note.CreatedAt, &note.UpdatedAt,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("note not found")
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

	return &note, nil
}

func (s *NoteStore) Update(id string, userID string, title, content string, pinned, archived bool, color string) error {
	hasAccess, err := s.HasAccess(id, userID)
	if err != nil {
		return fmt.Errorf("failed to check access: %w", err)
	}
	if !hasAccess {
		return fmt.Errorf("note not found or no access")
	}

	// Get current note state to check if pinned status is changing
	currentNote, err := s.GetByID(id, userID)
	if err != nil {
		return fmt.Errorf("failed to get current note: %w", err)
	}

	query := `UPDATE notes SET title = ?, content = ?, pinned = ?, archived = ?, color = ?, updated_at = CURRENT_TIMESTAMP
			  WHERE id = ?`

	result, err := s.db.Exec(query, title, content, pinned, archived, color, id)
	if err != nil {
		return fmt.Errorf("failed to update note: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}

	if rowsAffected == 0 {
		return fmt.Errorf("note not found")
	}

	// If pinned status changed, handle position preservation
	if currentNote.Pinned != pinned {
		if pinned {
			// Pinning: Store current position as unpinned_position and move to end of pinned
			var maxPosition int
			posQuery := `SELECT COALESCE(MAX(position), -1) FROM notes WHERE user_id = ? AND pinned = ? AND archived = FALSE`
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
							   WHERE user_id = ? AND pinned = FALSE AND archived = FALSE AND position >= ?`
				if _, err = s.db.Exec(shiftQuery, userID, targetPosition); err != nil {
					return fmt.Errorf("failed to shift notes: %w", err)
				}
			} else {
				// No saved position, add to end
				var maxPosition int
				posQuery := `SELECT COALESCE(MAX(position), -1) FROM notes WHERE user_id = ? AND pinned = ? AND archived = FALSE`
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
		return fmt.Errorf("note not found or not owned by user")
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
		return fmt.Errorf("note not found or not owned by user")
	}

	return nil
}

func (s *NoteStore) getItemsByNoteID(noteID string) ([]NoteItem, error) {
	query := `SELECT id, note_id, text, completed, position, created_at, updated_at
			  FROM note_items WHERE note_id = ? ORDER BY position`

	rows, err := s.db.Query(query, noteID)
	if err != nil {
		return nil, fmt.Errorf("failed to get note items: %w", err)
	}
	defer func() {
		if err := rows.Close(); err != nil {
			log.Printf("Failed to close rows: %v", err)
		}
	}()

	var items []NoteItem
	for rows.Next() {
		var item NoteItem
		err := rows.Scan(
			&item.ID, &item.NoteID, &item.Text, &item.Completed,
			&item.Position, &item.CreatedAt, &item.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan note item: %w", err)
		}
		items = append(items, item)
	}

	return items, nil
}

func (s *NoteStore) CreateItem(noteID string, text string, position int) (*NoteItem, error) {
	// Generate item ID
	itemID, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate item ID: %w", err)
	}

	query := `INSERT INTO note_items (id, note_id, text, position)
			  VALUES (?, ?, ?, ?) RETURNING completed, created_at, updated_at`

	var item NoteItem
	err = s.db.QueryRow(query, itemID, noteID, text, position).Scan(
		&item.Completed, &item.CreatedAt, &item.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create note item: %w", err)
	}

	item.ID = itemID
	item.NoteID = noteID
	item.Text = text
	item.Position = position

	return &item, nil
}

func (s *NoteStore) UpdateItem(id string, text string, completed bool, position int) error {
	query := `UPDATE note_items SET text = ?, completed = ?, position = ?, updated_at = CURRENT_TIMESTAMP
			  WHERE id = ?`

	_, err := s.db.Exec(query, text, completed, position, id)
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

func (s *NoteStore) CreateItemWithCompleted(noteID string, text string, position int, completed bool) (*NoteItem, error) {
	// Generate item ID
	itemID, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate item ID: %w", err)
	}

	query := `INSERT INTO note_items (id, note_id, text, position, completed)
			  VALUES (?, ?, ?, ?, ?) RETURNING created_at, updated_at`
	var item NoteItem
	err = s.db.QueryRow(query, itemID, noteID, text, position, completed).Scan(
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
		return fmt.Errorf("failed to share note: %w", err)
	}

	return nil
}

func (s *NoteStore) UnshareNote(noteID string, sharedWithUserID string) error {
	query := `DELETE FROM note_shares WHERE note_id = ? AND shared_with_user_id = ?`

	result, err := s.db.Exec(query, noteID, sharedWithUserID)
	if err != nil {
		return fmt.Errorf("failed to unshare note: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}

	if rowsAffected == 0 {
		return fmt.Errorf("note share not found")
	}

	return nil
}

func (s *NoteStore) GetNoteShares(noteID string) ([]NoteShare, error) {
	query := `SELECT ns.id, ns.note_id, ns.shared_with_user_id, ns.shared_by_user_id, 
			  ns.permission_level, u.username, ns.created_at, ns.updated_at
			  FROM note_shares ns
			  JOIN users u ON ns.shared_with_user_id = u.id
			  WHERE ns.note_id = ?`

	rows, err := s.db.Query(query, noteID)
	if err != nil {
		return nil, fmt.Errorf("failed to get note shares: %w", err)
	}
	defer func() {
		if err := rows.Close(); err != nil {
			log.Printf("Failed to close rows: %v", err)
		}
	}()

	var shares []NoteShare
	for rows.Next() {
		var share NoteShare
		err := rows.Scan(
			&share.ID, &share.NoteID, &share.SharedWithUserID, &share.SharedByUserID,
			&share.PermissionLevel, &share.Username, &share.CreatedAt, &share.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan note share: %w", err)
		}
		shares = append(shares, share)
	}

	return shares, nil
}

func (s *NoteStore) HasAccess(noteID string, userID string) (bool, error) {
	var count int
	query := `SELECT COUNT(*) FROM notes WHERE id = ? AND user_id = ?
			  UNION ALL
			  SELECT COUNT(*) FROM note_shares WHERE note_id = ? AND shared_with_user_id = ?`

	rows, err := s.db.Query(query, noteID, userID, noteID, userID)
	if err != nil {
		return false, fmt.Errorf("failed to check access: %w", err)
	}
	defer func() {
		if err := rows.Close(); err != nil {
			log.Printf("Failed to close rows: %v", err)
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
		if err = tx.Rollback(); err != nil {
			log.Printf("Failed to rollback transaction: %v", err)
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
			return fmt.Errorf("no access to note %s", noteID)
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
