package client

import (
	"encoding/json"
	"errors"
	"time"
)

// NoteType distinguishes text notes from list/checklist notes.
type NoteType string

const (
	NoteTypeText NoteType = "text"
	NoteTypeList NoteType = "list"
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

// Note is a single note returned by the API, modeled as a discriminated
// union on NoteType: exactly one of Text or List is populated, matching
// which fields the server actually puts on the wire for that note type (a
// text note's JSON has no items/checked_items_collapsed keys at all; a list
// note's JSON has no content key). Common fields shared by both variants are
// promoted onto Note directly.
type Note struct {
	ID         string      `json:"id"`
	UserID     string      `json:"user_id"`
	NoteType   NoteType    `json:"note_type"`
	Version    int         `json:"version"`
	Color      string      `json:"color"`
	Pinned     bool        `json:"pinned"`
	Archived   bool        `json:"archived"`
	Position   int         `json:"position"`
	SharedWith []NoteShare `json:"shared_with,omitempty"`
	IsShared   bool        `json:"is_shared"`
	Labels     []Label     `json:"labels"`
	Images     []NoteImage `json:"images,omitempty"`
	DeletedAt  *time.Time  `json:"deleted_at"`
	CreatedAt  time.Time   `json:"created_at"`
	UpdatedAt  time.Time   `json:"updated_at"`

	// Text holds the fields owned by a text note. Non-nil iff NoteType == NoteTypeText.
	Text *TextNoteFields
	// List holds the fields owned by a list note. Non-nil iff NoteType == NoteTypeList.
	List *ListNoteFields
}

// TextNoteFields holds the fields a text note owns on the wire.
type TextNoteFields struct {
	Content string
}

// ListNoteFields holds the fields a list note owns on the wire.
type ListNoteFields struct {
	Title                 string
	Items                 []NoteItem
	CheckedItemsCollapsed bool
}

// noteCommon mirrors the fields shared by both note variants; it is embedded
// into the wire structs built by Note.MarshalJSON/UnmarshalJSON so the
// common-field tags are only declared once.
type noteCommon struct {
	ID         string      `json:"id"`
	UserID     string      `json:"user_id"`
	NoteType   NoteType    `json:"note_type"`
	Version    int         `json:"version"`
	Color      string      `json:"color"`
	Pinned     bool        `json:"pinned"`
	Archived   bool        `json:"archived"`
	Position   int         `json:"position"`
	SharedWith []NoteShare `json:"shared_with,omitempty"`
	IsShared   bool        `json:"is_shared"`
	Labels     []Label     `json:"labels"`
	Images     []NoteImage `json:"images,omitempty"`
	DeletedAt  *time.Time  `json:"deleted_at"`
	CreatedAt  time.Time   `json:"created_at"`
	UpdatedAt  time.Time   `json:"updated_at"`
}

func (n *Note) common() noteCommon {
	return noteCommon{
		ID:         n.ID,
		UserID:     n.UserID,
		NoteType:   n.NoteType,
		Version:    n.Version,
		Color:      n.Color,
		Pinned:     n.Pinned,
		Archived:   n.Archived,
		Position:   n.Position,
		SharedWith: n.SharedWith,
		IsShared:   n.IsShared,
		Labels:     n.Labels,
		Images:     n.Images,
		DeletedAt:  n.DeletedAt,
		CreatedAt:  n.CreatedAt,
		UpdatedAt:  n.UpdatedAt,
	}
}

// MarshalJSON emits only the fields owned by n's NoteType, so a round-trip
// through the client never reintroduces the flattened shape the server
// stopped sending. Pointer receiver so Note has one consistent receiver type
// across Marshal/UnmarshalJSON (UnmarshalJSON must be a pointer method).
func (n *Note) MarshalJSON() ([]byte, error) {
	if n.NoteType == NoteTypeList {
		if n.List == nil {
			return nil, errors.New("client: list note has nil List fields")
		}
		return json.Marshal(struct {
			noteCommon
			Title                 string     `json:"title"`
			Items                 []NoteItem `json:"items"`
			CheckedItemsCollapsed bool       `json:"checked_items_collapsed"`
		}{n.common(), n.List.Title, n.List.Items, n.List.CheckedItemsCollapsed})
	}
	if n.Text == nil {
		return nil, errors.New("client: text note has nil Text fields")
	}
	return json.Marshal(struct {
		noteCommon
		Content string `json:"content"`
	}{n.common(), n.Text.Content})
}

// UnmarshalJSON reads either wire shape (text or list) based on note_type
// and populates the matching Text/List field, leaving the other nil.
func (n *Note) UnmarshalJSON(data []byte) error {
	var common noteCommon
	if err := json.Unmarshal(data, &common); err != nil {
		return err
	}

	*n = Note{
		ID:         common.ID,
		UserID:     common.UserID,
		NoteType:   common.NoteType,
		Version:    common.Version,
		Color:      common.Color,
		Pinned:     common.Pinned,
		Archived:   common.Archived,
		Position:   common.Position,
		SharedWith: common.SharedWith,
		IsShared:   common.IsShared,
		Labels:     common.Labels,
		Images:     common.Images,
		DeletedAt:  common.DeletedAt,
		CreatedAt:  common.CreatedAt,
		UpdatedAt:  common.UpdatedAt,
	}

	if common.NoteType == NoteTypeList {
		var list struct {
			Title                 string     `json:"title"`
			Items                 []NoteItem `json:"items"`
			CheckedItemsCollapsed bool       `json:"checked_items_collapsed"`
		}
		if err := json.Unmarshal(data, &list); err != nil {
			return err
		}
		n.List = &ListNoteFields{Title: list.Title, Items: list.Items, CheckedItemsCollapsed: list.CheckedItemsCollapsed}
		return nil
	}

	var text struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal(data, &text); err != nil {
		return err
	}
	n.Text = &TextNoteFields{Content: text.Content}
	return nil
}

// NoteImage is a single image attached to a note. It intentionally mirrors
// only the metadata fields embedded in Note.images (matching the server's
// narrow response contract); size, hash, and uploader are server-internal
// and are not exposed here. Image bytes are fetched out-of-band via
// GetNoteImage, never inlined here.
type NoteImage struct {
	ID          string    `json:"id"`
	Filename    string    `json:"filename"`
	ContentType string    `json:"content_type"`
	Width       int       `json:"width"`
	Height      int       `json:"height"`
	CreatedAt   time.Time `json:"created_at"`
}

// NoteItem is a single checklist entry within a list note.
type NoteItem struct {
	ID         string    `json:"id"`
	NoteID     string    `json:"note_id"`
	Text       string    `json:"text"`
	Completed  bool      `json:"completed"`
	Position   int       `json:"position"`
	ParentID   *string   `json:"parent_id"`
	AssignedTo string    `json:"assigned_to"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
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

// CreateTextNoteRequest is the body for POST /api/v1/notes with note_type "text".
type CreateTextNoteRequest struct {
	Content string   `json:"content"`
	Color   string   `json:"color,omitempty"`
	Labels  []string `json:"labels,omitempty"`
}

// CreateListNoteRequest is the body for POST /api/v1/notes with note_type "list".
type CreateListNoteRequest struct {
	Title  string           `json:"title"`
	Color  string           `json:"color,omitempty"`
	Items  []CreateNoteItem `json:"items,omitempty"`
	Labels []string         `json:"labels,omitempty"`
}

// CreateNoteItem describes a checklist item to create with a new list note.
// Assignment (AssignedTo) is only supported on update, not creation.
type CreateNoteItem struct {
	Text        string `json:"text"`
	Position    int    `json:"position"`
	IndentLevel int    `json:"indent_level"`
	Completed   bool   `json:"completed"`
}

// UpdateTextNoteRequest is the body for PATCH /api/v1/notes/{id} on a text note.
// Nil pointer fields are omitted and keep their server-side values.
type UpdateTextNoteRequest struct {
	Content  *string `json:"content,omitempty"`
	Pinned   *bool   `json:"pinned,omitempty"`
	Archived *bool   `json:"archived,omitempty"`
	Color    *string `json:"color,omitempty"`
	// BaseVersion enables optimistic concurrency: when set, the server rejects
	// the update with 409 unless the note's current version still matches it
	// (issue #489). Omit for last-write-wins behavior.
	BaseVersion *int `json:"base_version,omitempty"`
}

// UpdateListNoteRequest is the body for PATCH /api/v1/notes/{id} on a list note.
// Nil pointer fields are omitted and keep their server-side values. List items
// are edited through the dedicated item endpoints (CreateNoteItem,
// UpdateNoteItem, DeleteNoteItem, ReorderNoteItems), not this request.
type UpdateListNoteRequest struct {
	Title                 *string `json:"title,omitempty"`
	Pinned                *bool   `json:"pinned,omitempty"`
	Archived              *bool   `json:"archived,omitempty"`
	Color                 *string `json:"color,omitempty"`
	CheckedItemsCollapsed *bool   `json:"checked_items_collapsed,omitempty"`
	// BaseVersion enables optimistic concurrency; see UpdateTextNoteRequest.
	BaseVersion *int `json:"base_version,omitempty"`
}

// ConvertNoteTypeRequest is the body for POST /api/v1/notes/{id}/convert,
// which changes a note's type in place. The caller must precompute the
// transform (splitting text into list items, or rendering a list back into
// text) and supply the result: Content when converting to "text", Items when
// converting to "list". The server only validates and persists it.
type ConvertNoteTypeRequest struct {
	NoteType NoteType         `json:"note_type"`
	Content  *string          `json:"content,omitempty"`
	Items    []CreateNoteItem `json:"items,omitempty"`
	// BaseVersion enables optimistic concurrency; see UpdateTextNoteRequest.
	BaseVersion *int `json:"base_version,omitempty"`
}

// CreateNoteItemRequest is the body for POST /api/v1/notes/{id}/items. ID is
// optional; when empty the server generates one.
type CreateNoteItemRequest struct {
	ID         string `json:"id,omitempty"`
	Text       string `json:"text"`
	Position   int    `json:"position"`
	Completed  bool   `json:"completed"`
	ParentID   string `json:"parent_id,omitempty"`
	AssignedTo string `json:"assigned_to,omitempty"`
}

// PatchNoteItemRequest is the body for PATCH /api/v1/notes/{id}/items/{item_id}.
// Nil fields are left unchanged so concurrent edits to different columns merge.
type PatchNoteItemRequest struct {
	Text       *string `json:"text,omitempty"`
	Completed  *bool   `json:"completed,omitempty"`
	Position   *int    `json:"position,omitempty"`
	ParentID   *string `json:"parent_id,omitempty"`
	AssignedTo *string `json:"assigned_to,omitempty"`
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
	MyTasks  bool
}

// ImportResponse is returned by the import endpoint.
type ImportResponse struct {
	Imported int      `json:"imported"`
	Skipped  int      `json:"skipped"`
	Errors   []string `json:"errors,omitempty"`
}

// JotExport is the top-level envelope for the native Jot JSON export format.
type JotExport struct {
	Format     string          `json:"format"`
	Version    int             `json:"version"`
	ExportedAt time.Time       `json:"exported_at"`
	Notes      []JotExportNote `json:"notes"`
}

// JotExportNote is a single note in a Jot JSON export.
type JotExportNote struct {
	Title                 string              `json:"title"`
	Content               string              `json:"content"`
	NoteType              NoteType            `json:"note_type"`
	Color                 string              `json:"color"`
	Pinned                bool                `json:"pinned"`
	Archived              bool                `json:"archived"`
	Position              int                 `json:"position"`
	UnpinnedPosition      *int                `json:"unpinned_position,omitempty"`
	CheckedItemsCollapsed bool                `json:"checked_items_collapsed,omitempty"`
	Labels                []string            `json:"labels"`
	Items                 []JotExportNoteItem `json:"items,omitempty"`
}

// JotExportNoteItem is a single list item in a Jot JSON export.
type JotExportNoteItem struct {
	Text        string `json:"text"`
	Completed   bool   `json:"completed"`
	Position    int    `json:"position"`
	IndentLevel int    `json:"indent_level"`
}

// EmptyTrashResponse is returned by DELETE /api/v1/notes/trash.
type EmptyTrashResponse struct {
	Deleted int `json:"deleted"`
}

// UserListResponse wraps the admin user listing.
type UserListResponse struct {
	Users []*User `json:"users"`
}

// DeleteUserNotesResponse reports how many notes an admin note purge removed.
type DeleteUserNotesResponse struct {
	Deleted int `json:"deleted"`
}

// AdminStatsResponse wraps the admin system statistics response.
type AdminStatsResponse struct {
	Users     AdminUserStats     `json:"users"`
	Notes     AdminNoteStats     `json:"notes"`
	Sharing   AdminSharingStats  `json:"sharing"`
	Labels    AdminLabelStats    `json:"labels"`
	ListItems AdminListItemStats `json:"list_items"`
	Storage   AdminStorageStats  `json:"storage"`
}

type AdminUserStats struct {
	Total  int64 `json:"total"`
	Admins int64 `json:"admins"`
}

type AdminNoteStats struct {
	Total    int64 `json:"total"`
	Text     int64 `json:"text"`
	List     int64 `json:"list"`
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

type AdminListItemStats struct {
	Total     int64 `json:"total"`
	Completed int64 `json:"completed"`
	Assigned  int64 `json:"assigned"`
}

type AdminStorageStats struct {
	DatabaseSizeBytes int64 `json:"database_size_bytes"`
	ImageCount        int64 `json:"image_count"`
	ImagesSizeBytes   int64 `json:"images_size_bytes"`
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
	PasswordMinLength   int  `json:"password_min_length"`
	UploadMaxBytes      int  `json:"upload_max_bytes"`
}

// Ptr returns a pointer to v; useful for building UpdateUserRequest fields.
func Ptr[T any](v T) *T { return &v }
