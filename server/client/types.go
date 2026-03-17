package client

import "time"

// NoteType distinguishes text notes from todo/checklist notes.
type NoteType string

const (
	NoteTypeText NoteType = "text"
	NoteTypeTodo NoteType = "todo"
)

// Role distinguishes user permission levels.
type Role string

const (
	RoleUser  Role = "user"
	RoleAdmin Role = "admin"
)

// User represents a Jot user account.
type User struct {
	ID             string    `json:"id"`
	Username       string    `json:"username"`
	FirstName      string    `json:"first_name"`
	LastName       string    `json:"last_name"`
	Role           Role      `json:"role"`
	HasProfileIcon bool      `json:"has_profile_icon"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

// UserSettings holds per-user preferences.
type UserSettings struct {
	UserID    string    `json:"user_id"`
	Language  string    `json:"language"`
	Theme     string    `json:"theme"`
	UpdatedAt time.Time `json:"updated_at"`
}

// AuthResponse is the envelope returned by register, login, and me endpoints.
type AuthResponse struct {
	User     *User         `json:"user"`
	Settings *UserSettings `json:"settings"`
}

// Note is a single note with optional items, shares, and labels.
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
	CheckedItemsCollapsed bool        `json:"checked_items_collapsed"`
	Items                 []NoteItem  `json:"items,omitempty"`
	SharedWith            []NoteShare `json:"shared_with,omitempty"`
	IsShared              bool        `json:"is_shared"`
	Labels                []Label     `json:"labels"`
	DeletedAt             *time.Time  `json:"deleted_at"`
	CreatedAt             time.Time   `json:"created_at"`
	UpdatedAt             time.Time   `json:"updated_at"`
}

// NoteItem is a single checklist entry within a todo note.
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

// NoteShare describes a share relationship for a note.
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

// Label is a user-scoped tag that can be attached to notes.
type Label struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// UserInfo is the public profile returned by the user search endpoint.
type UserInfo struct {
	ID             string `json:"id"`
	Username       string `json:"username"`
	FirstName      string `json:"first_name"`
	LastName       string `json:"last_name"`
	Role           Role   `json:"role"`
	HasProfileIcon bool   `json:"has_profile_icon"`
}

// CreateNoteRequest is the body for POST /api/v1/notes.
type CreateNoteRequest struct {
	Title    string           `json:"title"`
	Content  string           `json:"content"`
	NoteType NoteType         `json:"note_type,omitempty"`
	Color    string           `json:"color,omitempty"`
	Items    []CreateNoteItem `json:"items,omitempty"`
}

// CreateNoteItem describes a checklist item to create with a new todo note.
// Assignment (AssignedTo) is only supported on update, not creation.
type CreateNoteItem struct {
	Text        string `json:"text"`
	Position    int    `json:"position"`
	IndentLevel int    `json:"indent_level"`
}

// UpdateNoteRequest is the body for PATCH /api/v1/notes/{id}.
// Nil pointer fields are omitted and keep their server-side values.
type UpdateNoteRequest struct {
	Title                 *string          `json:"title,omitempty"`
	Content               *string          `json:"content,omitempty"`
	Pinned                *bool            `json:"pinned,omitempty"`
	Archived              *bool            `json:"archived,omitempty"`
	Color                 *string          `json:"color,omitempty"`
	CheckedItemsCollapsed *bool            `json:"checked_items_collapsed,omitempty"`
	Items                 []UpdateNoteItem `json:"items,omitempty"`
}

// UpdateNoteItem describes a checklist item in an update request.
type UpdateNoteItem struct {
	Text        string `json:"text"`
	Position    int    `json:"position"`
	Completed   bool   `json:"completed"`
	IndentLevel int    `json:"indent_level"`
	AssignedTo  string `json:"assigned_to"`
}

// UpdateUserRequest is the body for PATCH /api/v1/users/me.
type UpdateUserRequest struct {
	Username  *string `json:"username,omitempty"`
	FirstName *string `json:"first_name,omitempty"`
	LastName  *string `json:"last_name,omitempty"`
	Language  *string `json:"language,omitempty"`
	Theme     *string `json:"theme,omitempty"`
}

// ListNotesOptions holds optional query parameters for listing notes.
type ListNotesOptions struct {
	Archived bool
	Trashed  bool
	Search   string
	Label    string // label ID (not name) to filter by
	MyTodo   bool
}

// ImportResponse is returned by the import endpoint.
type ImportResponse struct {
	Imported int      `json:"imported"`
	Skipped  int      `json:"skipped"`
	Errors   []string `json:"errors,omitempty"`
}

// UserListResponse wraps the admin user listing.
type UserListResponse struct {
	Users []*User `json:"users"`
}

// SessionInfo is a single active session as returned by the sessions API.
type SessionInfo struct {
	ID        string    `json:"id"`
	Browser   string    `json:"browser"`
	OS        string    `json:"os"`
	IsCurrent bool      `json:"is_current"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
}

// Ptr returns a pointer to v; useful for building UpdateUserRequest fields.
func Ptr[T any](v T) *T { return &v }
