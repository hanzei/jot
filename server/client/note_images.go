package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
)

// UploadNoteImage uploads an image to a note. data is read fully; filename is
// used only for the multipart header.
func (c *Client) UploadNoteImage(ctx context.Context, noteID, filename string, data io.Reader) (*NoteImage, error) {
	if data == nil {
		return nil, fmt.Errorf("data reader must not be nil")
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
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

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url(fmt.Sprintf("/api/v1/notes/%s/images", noteID)), &buf)
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

	var img NoteImage
	if err = json.Unmarshal(respBody, &img); err != nil {
		return nil, fmt.Errorf("unmarshal response: %w", err)
	}
	return &img, nil
}

// GetNoteImage fetches a note image's bytes and content type.
func (c *Client) GetNoteImage(ctx context.Context, imageID string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url(fmt.Sprintf("/api/v1/images/%s", imageID)), nil)
	if err != nil {
		return nil, "", fmt.Errorf("create request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("execute request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode >= 400 {
		return nil, "", &Error{StatusCode: resp.StatusCode, Body: string(body)}
	}
	return body, resp.Header.Get("Content-Type"), nil
}

// DeleteNoteImage removes a note image, reclaiming its blob if no other image
// row references the same content hash.
func (c *Client) DeleteNoteImage(ctx context.Context, imageID string) error {
	return c.doNoContent(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/images/%s", imageID), nil)
}
