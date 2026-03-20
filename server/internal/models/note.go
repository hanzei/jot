package models

import (
	"errors"
	"time"
)

type NoteType string

const (
	NoteTypeText     NoteType = "text"
	NoteTypeTodo     NoteType = "todo"
	DefaultNoteColor          = "#ffffff"
)

var ErrNoteNoAccess = errors.New("no access to note")
var ErrNoteNotFound = errors.New("note not found")
var ErrNoteNotOwnedByUser = errors.New("note not found or not owned by user")
var ErrNoteNotInTrash = errors.New("note not found in trash or not owned by user")
var ErrNoteShareNotFound = errors.New("note share not found")
var ErrNoteAlreadyShared = errors.New("note already shared with user")

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
	DeletedAt             *time.Time  `json:"deleted_at"`
	CreatedAt             time.Time   `json:"created_at"`
	UpdatedAt             time.Time   `json:"updated_at"`
}

type NoteItem struct {
	ID          string    `json:"id"`
	NoteID      string    `json:"note_id"`
	Text        string    `json:"text"`
	Completed   bool      `json:"completed"`
	Position    int       `json:"position"`
	IndentLevel int       `json:"indent_level"`
	AssignedTo  string    `json:"assigned_to"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
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
