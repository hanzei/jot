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
	NoteSort  string    `json:"note_sort"`
	UpdatedAt time.Time `json:"updated_at"`
}

// AuthResponse is the envelope returned by register, login, and me endpoints.
type AuthResponse struct {
	User     *User         `json:"user"`
	Settings *UserSettings `json:"settings"`
}

type PaginationOptions struct {
	Limit  int
	Offset int
}

type PaginationMetadata struct {
	Limit      int  `json:"limit"`
	Offset     int  `json:"offset"`
	Returned   int  `json:"returned"`
	HasMore    bool `json:"has_more"`
	NextOffset *int `json:"next_offset,omitempty"`
}

type PaginatedResponse[T any] struct {
	Items      []T                `json:"items"`
	Pagination PaginationMetadata `json:"pagination"`
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
	Labels   []string         `json:"labels,omitempty"`
}

// CreateNoteItem describes a checklist item to create with a new todo note.
// Assignment (AssignedTo) is only supported on update, not creation.
type CreateNoteItem struct {
	Text        string `json:"text"`
	Position    int    `json:"position"`
	IndentLevel int    `json:"indent_level"`
	Completed   bool   `json:"completed"`
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
	NoteSort  *string `json:"note_sort,omitempty"`
}

// ListNotesOptions holds optional query parameters for listing notes.
type ListNotesOptions struct {
	Archived bool
	Trashed  bool
	Search   string
	Label    string // label ID (not name) to filter by
	MyTodo   bool
	Limit    int
	Offset   int
}

// ImportResponse is returned by the import endpoint.
type ImportResponse struct {
	Imported int      `json:"imported"`
	Skipped  int      `json:"skipped"`
	Errors   []string `json:"errors,omitempty"`
}

// EmptyTrashResponse is returned by DELETE /api/v1/notes/trash.
type EmptyTrashResponse struct {
	Deleted int `json:"deleted"`
}

// UserListResponse wraps the admin user listing.
type UserListResponse = PaginatedResponse[User]

// AdminStatsResponse wraps the admin system statistics response.
type AdminStatsResponse struct {
	Users     AdminUserStats     `json:"users"`
	Notes     AdminNoteStats     `json:"notes"`
	Sharing   AdminSharingStats  `json:"sharing"`
	Labels    AdminLabelStats    `json:"labels"`
	TodoItems AdminTodoItemStats `json:"todo_items"`
	Storage   AdminStorageStats  `json:"storage"`
}

type AdminUserStats struct {
	Total int64 `json:"total"`
}

type AdminNoteStats struct {
	Total    int64 `json:"total"`
	Text     int64 `json:"text"`
	Todo     int64 `json:"todo"`
	Trashed  int64 `json:"trashed"`
	Archived int64 `json:"archived"`
}

type AdminSharingStats struct {
	SharedNotes int64 `json:"shared_notes"`
	ShareLinks  int64 `json:"share_links"`
}

type AdminLabelStats struct {
	Total            int64 `json:"total"`
	NoteAssociations int64 `json:"note_associations"`
}

type AdminTodoItemStats struct {
	Total     int64 `json:"total"`
	Completed int64 `json:"completed"`
	Assigned  int64 `json:"assigned"`
}

type AdminStorageStats struct {
	DatabaseSizeBytes int64 `json:"database_size_bytes"`
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

// ServerConfig holds public server configuration returned by GET /api/v1/config.
type ServerConfig struct {
	RegistrationEnabled bool `json:"registration_enabled"`
}

// Ptr returns a pointer to v; useful for building UpdateUserRequest fields.
func Ptr[T any](v T) *T { return &v }
