package models

import (
	"time"

	"github.com/sirupsen/logrus"
)

// noteCommon holds the fields shared by both note-response variants; it is
// embedded into TextNoteResponse/ListNoteResponse so the JSON tags for those
// fields are declared once instead of duplicated across both DTOs.
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

func newNoteCommon(n Note) noteCommon {
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

// TextNoteResponse is the wire representation of a text note. It carries no
// items or checked_items_collapsed key at all — those belong exclusively to
// list notes — so the JSON shape matches the TextNote/ListNote discriminated
// union in shared/src/types.ts exactly, instead of a flat struct with
// zero-valued fields for the variant that doesn't own them.
type TextNoteResponse struct {
	noteCommon
	Content string `json:"content"`
}

// ListNoteResponse is the wire representation of a list note. It carries no
// content key at all. Title, items, and checked_items_collapsed are always
// present — even when empty/false — since they are legitimately owned by
// every list note; only the type-irrelevant content field is absent.
type ListNoteResponse struct {
	noteCommon
	Title                 string     `json:"title"`
	Items                 []NoteItem `json:"items"`
	CheckedItemsCollapsed bool       `json:"checked_items_collapsed"`
}

// NewNoteResponse selects the response DTO matching n.NoteType, copying over
// only the fields that belong to that variant. This is where the strict
// discriminated union is enforced on the wire: callers must serialize the
// returned value directly (not n itself) so the JSON keys of the other
// variant never appear. n.NoteType is validated to be "text" or "list" at
// write time (CreateNote, ConvertNoteType); an unrecognized value here would
// indicate a data inconsistency, so it is logged and falls back to the text
// shape rather than panicking.
func NewNoteResponse(n Note) any {
	if n.NoteType == NoteTypeList {
		items := n.Items
		if items == nil {
			items = []NoteItem{}
		}
		return ListNoteResponse{
			noteCommon:            newNoteCommon(n),
			Title:                 n.Title,
			Items:                 items,
			CheckedItemsCollapsed: n.CheckedItemsCollapsed,
		}
	}

	if n.NoteType != NoteTypeText {
		logrus.Warnf("NewNoteResponse: unknown note type %q for note %s, serializing as text", n.NoteType, n.ID)
	}

	return TextNoteResponse{
		noteCommon: newNoteCommon(n),
		Content:    n.Content,
	}
}

// NewNoteResponses maps NewNoteResponse over a slice of note pointers, as
// returned by the note store's list queries.
func NewNoteResponses(notes []*Note) []any {
	responses := make([]any, len(notes))
	for i, n := range notes {
		responses[i] = NewNoteResponse(*n)
	}
	return responses
}
