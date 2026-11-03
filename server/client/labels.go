package client

import (
	"context"
	"fmt"
	"net/http"
)

const paramName = "name"

// ListLabels returns all labels for the authenticated user, each with its note count.
func (c *Client) ListLabels(ctx context.Context) ([]LabelWithCount, error) {
	var resp struct {
		Labels []LabelWithCount `json:"labels"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/labels", nil, &resp); err != nil {
		return nil, err
	}
	return resp.Labels, nil
}

// CreateLabel creates a label (or returns the existing one with the same name).
func (c *Client) CreateLabel(ctx context.Context, name string) (*Label, error) {
	var label Label
	if err := c.doJSON(ctx, http.MethodPost, "/api/v1/labels", map[string]string{
		paramName: name,
	}, &label); err != nil {
		return nil, err
	}
	return &label, nil
}

// CreateLabelWithID creates a label with a client-supplied ID. Returns a 409 error
// if the ID (or name) is already in use for this user.
func (c *Client) CreateLabelWithID(ctx context.Context, id, name string) (*Label, error) {
	var label Label
	if err := c.doJSON(ctx, http.MethodPost, "/api/v1/labels", map[string]string{
		"id":      id,
		paramName: name,
	}, &label); err != nil {
		return nil, err
	}
	return &label, nil
}

// AddLabel creates or finds a label by name and attaches it to a note.
// Returns the updated note.
func (c *Client) AddLabel(ctx context.Context, noteID, name string) (*Note, error) {
	var note Note
	if err := c.doJSON(ctx, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/labels", noteID), map[string]string{
		paramName: name,
	}, &note); err != nil {
		return nil, err
	}
	return &note, nil
}

// RenameLabel renames a label and returns the updated label.
func (c *Client) RenameLabel(ctx context.Context, labelID, name string) (*Label, error) {
	var label Label
	if err := c.doJSON(ctx, http.MethodPatch, fmt.Sprintf("/api/v1/labels/%s", labelID), map[string]string{
		paramName: name,
	}, &label); err != nil {
		return nil, err
	}
	return &label, nil
}

// DeleteLabel deletes a label.
func (c *Client) DeleteLabel(ctx context.Context, labelID string) error {
	return c.doNoContent(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/labels/%s", labelID), nil)
}

// RemoveLabel detaches a label from a note. Returns the updated note.
func (c *Client) RemoveLabel(ctx context.Context, noteID, labelID string) (*Note, error) {
	var note Note
	if err := c.doJSON(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/notes/%s/labels/%s", noteID, labelID), nil, &note); err != nil {
		return nil, err
	}
	return &note, nil
}
