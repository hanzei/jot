package jotclient

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
)

// ListNotes returns notes for the authenticated user.
// Pass nil for opts to use defaults (active, non-archived notes).
func (c *Client) ListNotes(ctx context.Context, opts *ListNotesOptions) ([]Note, error) {
	path := "/api/v1/notes"
	if opts != nil {
		q := url.Values{}
		if opts.Archived {
			q.Set("archived", "true")
		}
		if opts.Trashed {
			q.Set("trashed", "true")
		}
		if opts.Search != "" {
			q.Set("search", opts.Search)
		}
		if opts.Label != "" {
			q.Set("label", opts.Label)
		}
		if opts.MyTodo {
			q.Set("my_todo", "true")
		}
		if encoded := q.Encode(); encoded != "" {
			path += "?" + encoded
		}
	}

	var notes []Note
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &notes); err != nil {
		return nil, err
	}
	return notes, nil
}

// CreateNote creates a new note.
func (c *Client) CreateNote(ctx context.Context, req *CreateNoteRequest) (*Note, error) {
	var note Note
	if err := c.doJSON(ctx, http.MethodPost, "/api/v1/notes", req, &note); err != nil {
		return nil, err
	}
	return &note, nil
}

// GetNote retrieves a single note by ID.
func (c *Client) GetNote(ctx context.Context, id string) (*Note, error) {
	var note Note
	if err := c.doJSON(ctx, http.MethodGet, fmt.Sprintf("/api/v1/notes/%s", id), nil, &note); err != nil {
		return nil, err
	}
	return &note, nil
}

// UpdateNote updates a note's content, pinning, archive, color, and items.
func (c *Client) UpdateNote(ctx context.Context, id string, req *UpdateNoteRequest) (*Note, error) {
	var note Note
	if err := c.doJSON(ctx, http.MethodPut, fmt.Sprintf("/api/v1/notes/%s", id), req, &note); err != nil {
		return nil, err
	}
	return &note, nil
}

// DeleteNote soft-deletes a note (moves it to trash).
func (c *Client) DeleteNote(ctx context.Context, id string) error {
	return c.doNoContent(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/notes/%s", id), nil)
}

// DeleteNotePermanently removes a trashed note permanently.
func (c *Client) DeleteNotePermanently(ctx context.Context, id string) error {
	return c.doNoContent(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/notes/%s?permanent=true", id), nil)
}

// RestoreNote restores a note from trash.
func (c *Client) RestoreNote(ctx context.Context, id string) (*Note, error) {
	var note Note
	if err := c.doJSON(ctx, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/restore", id), nil, &note); err != nil {
		return nil, err
	}
	return &note, nil
}

// ReorderNotes sets the display order for notes.
func (c *Client) ReorderNotes(ctx context.Context, noteIDs []string) error {
	return c.doNoContent(ctx, http.MethodPost, "/api/v1/notes/reorder", map[string][]string{
		"note_ids": noteIDs,
	})
}

// ImportNotes uploads a Google Keep export file (JSON or ZIP).
func (c *Client) ImportNotes(ctx context.Context, filename string, data io.Reader) (*ImportResponse, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile("file", filename)
	if err != nil {
		return nil, fmt.Errorf("create form file: %w", err)
	}
	if _, err = io.Copy(part, data); err != nil {
		return nil, fmt.Errorf("copy file data: %w", err)
	}
	if err = mw.Close(); err != nil {
		return nil, fmt.Errorf("close multipart writer: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url("/api/v1/notes/import"), &buf)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("execute request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode >= 400 {
		return nil, &Error{StatusCode: resp.StatusCode, Body: string(respBody)}
	}

	var result ImportResponse
	if err = unmarshalJSON(respBody, &result); err != nil {
		return nil, err
	}
	return &result, nil
}
