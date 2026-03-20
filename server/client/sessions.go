package client

import (
	"context"
	"fmt"
	"net/http"
)

// ListSessions returns all active sessions for the authenticated user.
func (c *Client) ListSessions(ctx context.Context) ([]SessionInfo, error) {
	var sessions []SessionInfo
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/sessions", nil, &sessions); err != nil {
		return nil, err
	}
	return sessions, nil
}

// RevokeSession deletes a specific session by its hashed ID.
func (c *Client) RevokeSession(ctx context.Context, sessionID string) error {
	return c.doNoContent(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/sessions/%s", sessionID), nil)
}
