package client

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

// ListSessions returns all active sessions for the authenticated user.
func (c *Client) ListSessions(ctx context.Context) ([]SessionInfo, error) {
	sessions, err := collectAllPages(func(page *PaginationOptions) (*PaginatedResponse[SessionInfo], error) {
		return c.ListSessionsPage(ctx, page)
	})
	if err != nil {
		return nil, err
	}
	return sessions, nil
}

// ListSessionsPage returns a single paginated page of active sessions for the authenticated user.
func (c *Client) ListSessionsPage(ctx context.Context, pagination *PaginationOptions) (*PaginatedResponse[SessionInfo], error) {
	path := "/api/v1/sessions"
	q := url.Values{}
	applyPagination(q, pagination)
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}

	var response PaginatedResponse[SessionInfo]
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &response); err != nil {
		return nil, err
	}
	return &response, nil
}

// RevokeSession deletes a specific session by its hashed ID.
func (c *Client) RevokeSession(ctx context.Context, sessionID string) error {
	return c.doNoContent(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/sessions/%s", sessionID), nil)
}
