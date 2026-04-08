package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
		if opts.MyTasks {
			q.Set("my_tasks", "true")
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
	if req == nil {
		return nil, errors.New("request must not be nil")
	}
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

// UpdateNote partially updates a note. Pointer fields update when non-nil, and
// omitted (nil) pointer fields keep their current server-side values.
//
// Note: UpdateNoteRequest.Items is a pointer-to-slice with `omitempty`.
// - nil pointer omits "items" (no item update)
// - pointer to empty slice sends `"items":[]` (clear all items)
// - pointer to non-empty slice sends replacement items
func (c *Client) UpdateNote(ctx context.Context, id string, req *UpdateNoteRequest) (*Note, error) {
	if req == nil {
		return nil, errors.New("request must not be nil")
	}
	var note Note
	if err := c.doJSON(ctx, http.MethodPatch, fmt.Sprintf("/api/v1/notes/%s", id), req, &note); err != nil {
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

// EmptyTrash permanently deletes all trashed notes owned by the authenticated user.
func (c *Client) EmptyTrash(ctx context.Context) (*EmptyTrashResponse, error) {
	var result EmptyTrashResponse
	if err := c.doJSON(ctx, http.MethodDelete, "/api/v1/notes/trash", nil, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// RestoreNote restores a note from trash.
func (c *Client) RestoreNote(ctx context.Context, id string) (*Note, error) {
	var note Note
	if err := c.doJSON(ctx, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/restore", id), nil, &note); err != nil {
		return nil, err
	}
	return &note, nil
}

// DuplicateNote creates a copy of an existing note for the authenticated user.
func (c *Client) DuplicateNote(ctx context.Context, id string) (*Note, error) {
	var note Note
	if err := c.doJSON(ctx, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/duplicate", id), nil, &note); err != nil {
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

// ImportNotes uploads a note export file. importType must be "jot_json" or "google_keep".
func (c *Client) ImportNotes(ctx context.Context, importType string, filename string, data io.Reader) (*ImportResponse, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	if err := mw.WriteField("import_type", importType); err != nil {
		return nil, fmt.Errorf("write import_type field: %w", err)
	}
	part, err := mw.CreateFormFile("file", filename)
	if err != nil {
		return nil, fmt.Errorf("create form file: %w", err)
	}
	if _, err = io.Copy(part, data); err != nil {
		return nil, fmt.Errorf("copy file data: %w", err)
	}
	contentType := mw.FormDataContentType()
	if err = mw.Close(); err != nil {
		return nil, fmt.Errorf("close multipart writer: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url("/api/v1/notes/import"), &buf)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", contentType)

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
	if err = json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("unmarshal response: %w", err)
	}
	return &result, nil
}

// ExportNotes downloads the authenticated user's notes as a Jot JSON export.
func (c *Client) ExportNotes(ctx context.Context) (*JotExport, error) {
	var export JotExport
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/notes/export", nil, &export); err != nil {
		return nil, err
	}
	return &export, nil
}
