package models

import (
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
	ID         int         `json:"id"`
	UserID     string      `json:"user_id"`
	Title      string      `json:"title"`
	Content    string      `json:"content"`
	NoteType   NoteType    `json:"note_type"`
	Color      string      `json:"color"`
	Pinned     bool        `json:"pinned"`
	Archived   bool        `json:"archived"`
	Items      []NoteItem  `json:"items,omitempty"`
	SharedWith []NoteShare `json:"shared_with,omitempty"`
	IsShared   bool        `json:"is_shared"`
	CreatedAt  time.Time   `json:"created_at"`
	UpdatedAt  time.Time   `json:"updated_at"`
}

type NoteItem struct {
	ID        int       `json:"id"`
	NoteID    int       `json:"note_id"`
	Text      string    `json:"text"`
	Completed bool      `json:"completed"`
	Position  int       `json:"position"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type NoteShare struct {
	ID               int       `json:"id"`
	NoteID           int       `json:"note_id"`
	SharedWithUserID string    `json:"shared_with_user_id"`
	SharedByUserID   string    `json:"shared_by_user_id"`
	PermissionLevel  string    `json:"permission_level"`
	UserEmail        string    `json:"user_email,omitempty"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

type NoteStore struct {
	db *sql.DB
}

func NewNoteStore(db *sql.DB) *NoteStore {
	return &NoteStore{db: db}
}

func (s *NoteStore) Create(userID string, title, content string, noteType NoteType, color string) (*Note, error) {
	query := `INSERT INTO notes (user_id, title, content, note_type, color) 
			  VALUES (?, ?, ?, ?, ?) RETURNING id, pinned, archived, created_at, updated_at`

	var note Note
	err := s.db.QueryRow(query, userID, title, content, noteType, color).Scan(
		&note.ID, &note.Pinned, &note.Archived,
		&note.CreatedAt, &note.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create note: %w", err)
	}

	note.UserID = userID
	note.Title = title
	note.Content = content
	note.NoteType = noteType
	note.Color = color

	return &note, nil
}

func (s *NoteStore) GetByUserID(userID string, archived bool, search string) ([]*Note, error) {
	query := `SELECT DISTINCT n.id, n.user_id, n.title, n.content, n.note_type, n.color, n.pinned, n.archived, n.created_at, n.updated_at
			  FROM notes n
			  LEFT JOIN note_shares ns ON n.id = ns.note_id
			  WHERE (n.user_id = ? OR ns.shared_with_user_id = ?) AND n.archived = ?`
	args := []any{userID, userID, archived}

	if search != "" {
		query += ` AND (n.title LIKE ? OR n.content LIKE ?)`
		searchTerm := "%" + search + "%"
		args = append(args, searchTerm, searchTerm)
	}

	query += ` ORDER BY n.pinned DESC, n.updated_at DESC`

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to get notes: %w", err)
	}
	defer func() {
		if err := rows.Close(); err != nil {
			log.Printf("Failed to close rows: %v", err)
		}
	}()

	var notes []*Note
	for rows.Next() {
		var note Note
		err := rows.Scan(
			&note.ID, &note.UserID, &note.Title, &note.Content,
			&note.NoteType, &note.Color, &note.Pinned, &note.Archived,
			&note.CreatedAt, &note.UpdatedAt,
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

func (s *NoteStore) GetByID(id int, userID string) (*Note, error) {
	hasAccess, err := s.HasAccess(id, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to check access: %w", err)
	}
	if !hasAccess {
		return nil, fmt.Errorf("note not found")
	}

	query := `SELECT id, user_id, title, content, note_type, color, pinned, archived, created_at, updated_at
			  FROM notes WHERE id = ?`

	var note Note
	err = s.db.QueryRow(query, id).Scan(
		&note.ID, &note.UserID, &note.Title, &note.Content,
		&note.NoteType, &note.Color, &note.Pinned, &note.Archived,
		&note.CreatedAt, &note.UpdatedAt,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("note not found")
		}
		return nil, fmt.Errorf("failed to get note: %w", err)
	}

	if note.NoteType == NoteTypeTodo {
		items, itemsErr := s.getItemsByNoteID(note.ID)
		if itemsErr != nil {
			return nil, fmt.Errorf("failed to get note items: %w", itemsErr)
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

func (s *NoteStore) Update(id int, userID string, title, content string, pinned, archived bool, color string) error {
	hasAccess, err := s.HasAccess(id, userID)
	if err != nil {
		return fmt.Errorf("failed to check access: %w", err)
	}
	if !hasAccess {
		return fmt.Errorf("note not found or no access")
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

	return nil
}

func (s *NoteStore) Delete(id int, userID string) error {
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

func (s *NoteStore) getItemsByNoteID(noteID int) ([]NoteItem, error) {
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

func (s *NoteStore) CreateItem(noteID int, text string, position int) (*NoteItem, error) {
	query := `INSERT INTO note_items (note_id, text, position)
			  VALUES (?, ?, ?) RETURNING id, completed, created_at, updated_at`

	var item NoteItem
	err := s.db.QueryRow(query, noteID, text, position).Scan(
		&item.ID, &item.Completed, &item.CreatedAt, &item.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create note item: %w", err)
	}

	item.NoteID = noteID
	item.Text = text
	item.Position = position

	return &item, nil
}

func (s *NoteStore) UpdateItem(id int, text string, completed bool, position int) error {
	query := `UPDATE note_items SET text = ?, completed = ?, position = ?, updated_at = CURRENT_TIMESTAMP
			  WHERE id = ?`

	_, err := s.db.Exec(query, text, completed, position, id)
	if err != nil {
		return fmt.Errorf("failed to update note item: %w", err)
	}

	return nil
}

func (s *NoteStore) DeleteItem(id int) error {
	_, err := s.db.Exec("DELETE FROM note_items WHERE id = ?", id)
	if err != nil {
		return fmt.Errorf("failed to delete note item: %w", err)
	}

	return nil
}

func (s *NoteStore) DeleteItemsByNoteID(noteID int) error {
	_, err := s.db.Exec("DELETE FROM note_items WHERE note_id = ?", noteID)
	if err != nil {
		return fmt.Errorf("failed to delete note items: %w", err)
	}
	return nil
}

func (s *NoteStore) CreateItemWithCompleted(noteID int, text string, position int, completed bool) (*NoteItem, error) {
	query := `INSERT INTO note_items (note_id, text, position, completed)
			  VALUES (?, ?, ?, ?) RETURNING id, created_at, updated_at`
	var item NoteItem
	err := s.db.QueryRow(query, noteID, text, position, completed).Scan(
		&item.ID, &item.CreatedAt, &item.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create note item: %w", err)
	}

	item.NoteID = noteID
	item.Text = text
	item.Position = position
	item.Completed = completed

	return &item, nil
}

func (s *NoteStore) ShareNote(noteID int, sharedByUserID, sharedWithUserID string) error {
	query := `INSERT INTO note_shares (note_id, shared_with_user_id, shared_by_user_id, permission_level)
			  VALUES (?, ?, ?, 'edit')`

	_, err := s.db.Exec(query, noteID, sharedWithUserID, sharedByUserID)
	if err != nil {
		return fmt.Errorf("failed to share note: %w", err)
	}

	return nil
}

func (s *NoteStore) UnshareNote(noteID int, sharedWithUserID string) error {
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

func (s *NoteStore) GetNoteShares(noteID int) ([]NoteShare, error) {
	query := `SELECT ns.id, ns.note_id, ns.shared_with_user_id, ns.shared_by_user_id, 
			  ns.permission_level, u.email, ns.created_at, ns.updated_at
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
			&share.PermissionLevel, &share.UserEmail, &share.CreatedAt, &share.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan note share: %w", err)
		}
		shares = append(shares, share)
	}

	return shares, nil
}

func (s *NoteStore) HasAccess(noteID int, userID string) (bool, error) {
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

func (s *NoteStore) IsOwner(noteID int, userID string) (bool, error) {
	var count int
	query := `SELECT COUNT(*) FROM notes WHERE id = ? AND user_id = ?`

	err := s.db.QueryRow(query, noteID, userID).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("failed to check ownership: %w", err)
	}

	return count > 0, nil
}
