package client

import (
	"context"
	"fmt"
	"net/http"
)

// ShareNote shares a note with another user.
func (c *Client) ShareNote(ctx context.Context, noteID, userID string) error {
	return c.doNoContent(ctx, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/share", noteID), map[string]string{
		"user_id": userID,
	})
}

// UnshareNote removes a share from a note.
func (c *Client) UnshareNote(ctx context.Context, noteID, userID string) error {
	return c.doNoContent(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/notes/%s/share", noteID), map[string]string{
		"user_id": userID,
	})
}

// GetNoteShares lists users a note is shared with.
func (c *Client) GetNoteShares(ctx context.Context, noteID string) ([]NoteShare, error) {
	var shares []NoteShare
	if err := c.doJSON(ctx, http.MethodGet, fmt.Sprintf("/api/v1/notes/%s/shares", noteID), nil, &shares); err != nil {
		return nil, err
	}
	return shares, nil
}
