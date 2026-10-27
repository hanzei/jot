package client

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

// NoteRevisionSummary is a revision's metadata: the note's shared content as
// it was just before a write replaced it.
type NoteRevisionSummary struct {
	ID       string   `json:"id"`
	NoteID   string   `json:"note_id"`
	NoteType NoteType `json:"note_type"`
	Title    string   `json:"title"`
	// ActorID is who last edited the snapshotted content, or nil when unknown.
	ActorID *string `json:"actor_id"`
	// EditedAt is when the snapshotted content was last edited.
	EditedAt time.Time `json:"edited_at"`
	// CreatedAt is when a write replaced this content.
	CreatedAt time.Time `json:"created_at"`
}

// NoteRevision is one full revision. Content is set for a text note and Items
// for a list note.
type NoteRevision struct {
	NoteRevisionSummary
	Content string             `json:"content"`
	Items   []NoteRevisionItem `json:"items"`
}

// NoteRevisionItem is a list item as stored in a revision.
type NoteRevisionItem struct {
	ID         string  `json:"id"`
	Text       string  `json:"text"`
	Completed  bool    `json:"completed"`
	Position   int     `json:"position"`
	ParentID   *string `json:"parent_id"`
	AssignedTo string  `json:"assigned_to"`
}

// ListNoteRevisions returns a note's revisions, newest first, without their
// content.
func (c *Client) ListNoteRevisions(ctx context.Context, noteID string) ([]NoteRevisionSummary, error) {
	var resp struct {
		Revisions []NoteRevisionSummary `json:"revisions"`
	}
	if err := c.doJSON(ctx, http.MethodGet, fmt.Sprintf("/api/v1/notes/%s/revisions", noteID), nil, &resp); err != nil {
		return nil, err
	}
	return resp.Revisions, nil
}

// GetNoteRevision returns one full revision of a note.
func (c *Client) GetNoteRevision(ctx context.Context, noteID, revisionID string) (*NoteRevision, error) {
	var rev NoteRevision
	if err := c.doJSON(ctx, http.MethodGet, fmt.Sprintf("/api/v1/notes/%s/revisions/%s", noteID, revisionID), nil, &rev); err != nil {
		return nil, err
	}
	return &rev, nil
}

// RestoreNoteRevision replaces the note's content with the revision's and
// returns the updated note. When baseVersion is non-nil the restore is
// rejected with 409 unless the note is still at that version.
func (c *Client) RestoreNoteRevision(ctx context.Context, noteID, revisionID string, baseVersion *int) (*Note, error) {
	body := &RestoreNoteRevisionRequest{BaseVersion: baseVersion}
	var note Note
	if err := c.doJSON(ctx, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/revisions/%s/restore", noteID, revisionID), body, &note); err != nil {
		return nil, err
	}
	return &note, nil
}
