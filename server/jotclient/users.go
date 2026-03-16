package jotclient

import (
	"context"
	"net/http"
	"net/url"
)

// SearchUsers lists users visible to the authenticated user, optionally
// filtered by a search term. The current user is excluded from results.
func (c *Client) SearchUsers(ctx context.Context, search string) ([]UserInfo, error) {
	path := "/api/v1/users"
	if search != "" {
		path += "?" + url.Values{"search": {search}}.Encode()
	}

	var users []UserInfo
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &users); err != nil {
		return nil, err
	}
	return users, nil
}
