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

// createTextNoteBody is the wire format for creating a text note.
type createTextNoteBody struct {
	NoteType string `json:"note_type"`
	*CreateTextNoteRequest
}

// createListNoteBody is the wire format for creating a list note.
type createListNoteBody struct {
	NoteType string `json:"note_type"`
	*CreateListNoteRequest
}

// CreateTextNote creates a new text note.
func (c *Client) CreateTextNote(ctx context.Context, req *CreateTextNoteRequest) (*Note, error) {
	if req == nil {
		return nil, errors.New("request must not be nil")
	}
	body := createTextNoteBody{NoteType: "text", CreateTextNoteRequest: req}
	var note Note
	if err := c.doJSON(ctx, http.MethodPost, "/api/v1/notes", body, &note); err != nil {
		return nil, err
	}
	return &note, nil
}

// CreateListNote creates a new list note.
func (c *Client) CreateListNote(ctx context.Context, req *CreateListNoteRequest) (*Note, error) {
	if req == nil {
		return nil, errors.New("request must not be nil")
	}
	body := createListNoteBody{NoteType: "list", CreateListNoteRequest: req}
	var note Note
	if err := c.doJSON(ctx, http.MethodPost, "/api/v1/notes", body, &note); err != nil {
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

// UpdateTextNote partially updates a text note. Nil pointer fields are omitted
// and keep their current server-side values.
func (c *Client) UpdateTextNote(ctx context.Context, id string, req *UpdateTextNoteRequest) (*Note, error) {
	if req == nil {
		return nil, errors.New("request must not be nil")
	}
	var note Note
	if err := c.doJSON(ctx, http.MethodPatch, fmt.Sprintf("/api/v1/notes/%s", id), req, &note); err != nil {
		return nil, err
	}
	return &note, nil
}

// UpdateListNote partially updates a list note. Nil pointer fields are omitted
// and keep their current server-side values.
//
// Items is a pointer-to-slice with `omitempty`:
// - nil pointer omits "items" (no item update)
// - pointer to empty slice sends `"items":[]` (clear all items)
// - pointer to non-empty slice sends replacement items
func (c *Client) UpdateListNote(ctx context.Context, id string, req *UpdateListNoteRequest) (*Note, error) {
	if req == nil {
		return nil, errors.New("request must not be nil")
	}
	var note Note
	if err := c.doJSON(ctx, http.MethodPatch, fmt.Sprintf("/api/v1/notes/%s", id), req, &note); err != nil {
		return nil, err
	}
	return &note, nil
}

// CreateNoteItem adds a single item to a list note. If req.ID is empty the
// server generates one. Returns the created item.
func (c *Client) CreateNoteItem(ctx context.Context, noteID string, req *CreateNoteItemRequest) (*NoteItem, error) {
	if req == nil {
		return nil, errors.New("request must not be nil")
	}
	var item NoteItem
	if err := c.doJSON(ctx, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/items", noteID), req, &item); err != nil {
		return nil, err
	}
	return &item, nil
}

// UpdateNoteItem applies a partial update to a single list item. Nil pointer
// fields are omitted and keep their current server-side values.
func (c *Client) UpdateNoteItem(ctx context.Context, noteID, itemID string, req *PatchNoteItemRequest) (*NoteItem, error) {
	if req == nil {
		return nil, errors.New("request must not be nil")
	}
	var item NoteItem
	if err := c.doJSON(ctx, http.MethodPatch, fmt.Sprintf("/api/v1/notes/%s/items/%s", noteID, itemID), req, &item); err != nil {
		return nil, err
	}
	return &item, nil
}

// ToggleNoteItemCompleted sets an item's completed state. When the item is a
// top-level (parent) item, the same value cascades to all of its children
// atomically. Returns the note's full item list.
func (c *Client) ToggleNoteItemCompleted(ctx context.Context, noteID, itemID string, completed bool) ([]NoteItem, error) {
	var items []NoteItem
	if err := c.doJSON(ctx, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/items/%s/toggle-completed", noteID, itemID), map[string]bool{
		"completed": completed,
	}, &items); err != nil {
		return nil, err
	}
	return items, nil
}

// UncheckAllNoteItems clears the completed flag on every item of a list note
// and returns the note's full item list.
func (c *Client) UncheckAllNoteItems(ctx context.Context, noteID string) ([]NoteItem, error) {
	var items []NoteItem
	if err := c.doJSON(ctx, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/items/uncheck-all", noteID), nil, &items); err != nil {
		return nil, err
	}
	return items, nil
}

// DeleteCompletedNoteItems deletes every completed item of a list note and
// returns the note's remaining items.
func (c *Client) DeleteCompletedNoteItems(ctx context.Context, noteID string) ([]NoteItem, error) {
	var items []NoteItem
	if err := c.doJSON(ctx, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/items/delete-completed", noteID), nil, &items); err != nil {
		return nil, err
	}
	return items, nil
}

// DeleteNoteItem deletes a single list item.
func (c *Client) DeleteNoteItem(ctx context.Context, noteID, itemID string) error {
	return c.doNoContent(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/notes/%s/items/%s", noteID, itemID), nil)
}

// ReorderNoteItems sets the order of a list note's items by item ID.
func (c *Client) ReorderNoteItems(ctx context.Context, noteID string, itemIDs []string) error {
	return c.doNoContent(ctx, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/items/reorder", noteID), map[string][]string{
		"item_ids": itemIDs,
	})
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

// ConvertNoteType converts a note between text and list type, persisting the
// caller-supplied precomputed content/items. See ConvertNoteTypeRequest.
func (c *Client) ConvertNoteType(ctx context.Context, id string, req *ConvertNoteTypeRequest) (*Note, error) {
	if req == nil {
		return nil, errors.New("request must not be nil")
	}
	var note Note
	if err := c.doJSON(ctx, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/convert", id), req, &note); err != nil {
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

// doImportRequest builds and executes a multipart POST to /api/v1/notes/import.
// writeParts is called after the import_type field is written and before the writer is closed.
func (c *Client) doImportRequest(ctx context.Context, importType string, writeParts func(*multipart.Writer) error) (*ImportResponse, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	if err := mw.WriteField("import_type", importType); err != nil {
		return nil, fmt.Errorf("write import_type field: %w", err)
	}
	if err := writeParts(mw); err != nil {
		return nil, err
	}
	contentType := mw.FormDataContentType()
	if err := mw.Close(); err != nil {
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

// ImportNotes uploads a note export file. importType must be "jot_json" or "google_keep".
func (c *Client) ImportNotes(ctx context.Context, importType string, filename string, data io.Reader) (*ImportResponse, error) {
	return c.doImportRequest(ctx, importType, func(mw *multipart.Writer) error {
		part, err := mw.CreateFormFile("file", filename)
		if err != nil {
			return fmt.Errorf("create form file: %w", err)
		}
		if _, err = io.Copy(part, data); err != nil {
			return fmt.Errorf("copy file data: %w", err)
		}
		return nil
	})
}

// ImportUsememos imports notes directly from a Memos instance.
func (c *Client) ImportUsememos(ctx context.Context, rawURL, token string) (*ImportResponse, error) {
	return c.doImportRequest(ctx, "usememos", func(mw *multipart.Writer) error {
		if err := mw.WriteField("url", rawURL); err != nil {
			return fmt.Errorf("write url field: %w", err)
		}
		if err := mw.WriteField("token", token); err != nil {
			return fmt.Errorf("write token field: %w", err)
		}
		return nil
	})
}

// ExportNotes downloads the authenticated user's notes as a Jot JSON export.
func (c *Client) ExportNotes(ctx context.Context) (*JotExport, error) {
	var export JotExport
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/notes/export", nil, &export); err != nil {
		return nil, err
	}
	return &export, nil
}
