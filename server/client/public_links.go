package client

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// SetPublicLink creates noteID's public link, or changes the expiry of its
// active one (the token stays the same). A nil expiresAt means the link never
// expires.
func (c *Client) SetPublicLink(ctx context.Context, noteID string, expiresAt *time.Time) (*PublicLink, error) {
	var link PublicLink
	body := map[string]*time.Time{"expires_at": expiresAt}
	if err := c.doJSON(ctx, http.MethodPut, fmt.Sprintf("/api/v1/notes/%s/public-link", noteID), body, &link); err != nil {
		return nil, err
	}
	return &link, nil
}

// DeletePublicLink revokes noteID's public link.
func (c *Client) DeletePublicLink(ctx context.Context, noteID string) error {
	return c.doNoContent(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/notes/%s/public-link", noteID), nil)
}

// GetPublicNote fetches the note a public link token publishes. It needs no
// login.
func (c *Client) GetPublicNote(ctx context.Context, token string) (*PublicNote, error) {
	var note PublicNote
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/public/notes/"+url.PathEscape(token), nil, &note); err != nil {
		return nil, err
	}
	return &note, nil
}

// GetPublicNoteImage fetches an image of the note a public link token
// publishes, returning its bytes and content type.
func (c *Client) GetPublicNoteImage(ctx context.Context, token, imageID string) ([]byte, string, error) {
	return c.doGetBytes(ctx, fmt.Sprintf("/api/v1/public/notes/%s/images/%s", url.PathEscape(token), imageID))
}

// GetPublicNoteImageThumbnail fetches an image thumbnail of the note a public
// link token publishes.
func (c *Client) GetPublicNoteImageThumbnail(ctx context.Context, token, imageID string) ([]byte, string, error) {
	return c.doGetBytes(ctx, fmt.Sprintf("/api/v1/public/notes/%s/images/%s/thumbnail", url.PathEscape(token), imageID))
}
