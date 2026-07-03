package client

import (
	"context"
	"fmt"
	"io"
	"net/http"
)

// UploadNoteImage uploads an image to a note. data is read fully; filename is
// used only for the multipart header.
func (c *Client) UploadNoteImage(ctx context.Context, noteID, filename string, data io.Reader) (*NoteImage, error) {
	var img NoteImage
	if err := c.doMultipartUpload(ctx, fmt.Sprintf("/api/v1/notes/%s/images", noteID), filename, data, &img); err != nil {
		return nil, err
	}
	return &img, nil
}

// GetNoteImage fetches a note image's bytes and content type.
func (c *Client) GetNoteImage(ctx context.Context, imageID string) ([]byte, string, error) {
	return c.doGetBytes(ctx, fmt.Sprintf("/api/v1/images/%s", imageID))
}

// GetNoteImageThumbnail fetches a note image's thumbnail bytes and content
// type (always image/jpeg).
func (c *Client) GetNoteImageThumbnail(ctx context.Context, imageID string) ([]byte, string, error) {
	return c.doGetBytes(ctx, fmt.Sprintf("/api/v1/images/%s/thumbnail", imageID))
}

// DeleteNoteImage removes a note image, reclaiming its blob if no other image
// row references the same content hash.
func (c *Client) DeleteNoteImage(ctx context.Context, imageID string) error {
	return c.doNoContent(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/images/%s", imageID), nil)
}
