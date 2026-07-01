package models

import (
	"errors"
	"time"
)

type NoteType string

const (
	NoteTypeText     NoteType = "text"
	NoteTypeList     NoteType = "list"
	DefaultNoteColor          = "#ffffff"
)

var ErrNoteNoAccess = errors.New("no access to note")
var ErrNoteNotFound = errors.New("note not found")
var ErrNoteNotOwnedByUser = errors.New("note not found or not owned by user")
var ErrNoteNotInTrash = errors.New("note not found in trash or not owned by user")
var ErrNoteShareNotFound = errors.New("note share not found")
var ErrNoteAlreadyShared = errors.New("note already shared with user")
var ErrNoteExists = errors.New("note already exists")
var ErrNoteVersionConflict = errors.New("note was modified by another write")
var ErrNoteItemNotFound = errors.New("note item not found")
var ErrNoteItemExists = errors.New("note item already exists")
var ErrNoteItemCapExceeded = errors.New("note item limit reached")
var ErrInvalidParentRef = errors.New("invalid parent reference")
var ErrNoteImageNotFound = errors.New("note image not found")

// NoteItemPatch carries the fields that may be changed by a partial single-item
// update. Nil fields are left untouched (resolved against the item's current
// stored value), so concurrent edits to different columns of the same item
// merge instead of overwriting one another.
type NoteItemPatch struct {
	Text      *string
	Completed *bool
	Position  *int
	// ParentID, when non-nil, re-parents the item. An empty string makes the
	// item top-level; a non-empty value attaches it to that parent (which must
	// itself be a top-level item in the same note). Nil leaves it unchanged.
	ParentID   *string
	AssignedTo *string
}

// DeletedNoteAudience describes which users should receive a note_deleted SSE
// event after a permanent delete succeeds.
type DeletedNoteAudience struct {
	NoteID      string
	AudienceIDs []string
}

type Note struct {
	ID       string   `json:"id"`
	UserID   string   `json:"user_id"`
	Title    string   `json:"title"`
	Content  string   `json:"content"`
	NoteType NoteType `json:"note_type"`
	// Version is an optimistic-concurrency counter bumped on every shared-content
	// (title/content) change. Clients echo the version their edit was based on as
	// base_version on update so a stale write can be rejected (issue #489).
	Version               int         `json:"version"`
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
	Images                []NoteImage `json:"images,omitempty"`
	DeletedAt             *time.Time  `json:"deleted_at"`
	CreatedAt             time.Time   `json:"created_at"`
	UpdatedAt             time.Time   `json:"updated_at"`
}

type NoteItem struct {
	ID        string `json:"id"`
	NoteID    string `json:"note_id"`
	Text      string `json:"text"`
	Completed bool   `json:"completed"`
	Position  int    `json:"position"`
	// ParentID is the item this one is nested under, or nil for a top-level
	// item. It replaces the former indent_level column: a group is a top-level
	// item plus the children that reference it. Nesting is capped at one level,
	// so a parent always has ParentID == nil.
	ParentID   *string   `json:"parent_id"`
	AssignedTo string    `json:"assigned_to"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
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

// NoteImage is a metadata row for an image attached to a note (spec
// docs/specs/file-attachments.md §4). The bytes live on disk in the
// Blobstore, content-addressed by SHA256; this row is the pointer plus
// display metadata. Only a narrow field set is embedded into Note responses
// (spec §6.1) so the note list payload stays small; fields not in that
// contract are tagged json:"-" and used internally (batch-loading, refcount,
// future upload/delete handlers).
type NoteImage struct {
	ID          string     `json:"id"`
	NoteID      string     `json:"-"`
	UploaderID  string     `json:"-"`
	Filename    string     `json:"filename"`
	ContentType string     `json:"content_type"`
	SizeBytes   int64      `json:"-"`
	SHA256      string     `json:"-"`
	Width       int        `json:"width"`
	Height      int        `json:"height"`
	CreatedAt   time.Time  `json:"created_at"`
	DeletedAt   *time.Time `json:"-"`
}
