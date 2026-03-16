package jotclient

import (
	"context"
	"fmt"
	"net/http"
)

// ListLabels returns all labels for the authenticated user.
func (c *Client) ListLabels(ctx context.Context) ([]Label, error) {
	var labels []Label
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/labels", nil, &labels); err != nil {
		return nil, err
	}
	return labels, nil
}

// AddLabel creates or finds a label by name and attaches it to a note.
// Returns the updated note.
func (c *Client) AddLabel(ctx context.Context, noteID, name string) (*Note, error) {
	var note Note
	if err := c.doJSON(ctx, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/labels", noteID), map[string]string{
		"name": name,
	}, &note); err != nil {
		return nil, err
	}
	return &note, nil
}

// RemoveLabel detaches a label from a note. Returns the updated note.
func (c *Client) RemoveLabel(ctx context.Context, noteID, labelID string) (*Note, error) {
	var note Note
	if err := c.doJSON(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/notes/%s/labels/%s", noteID, labelID), nil, &note); err != nil {
		return nil, err
	}
	return &note, nil
}
