package client

import (
	"context"
	"net/http"
	"net/url"
)

// SearchUsers lists users visible to the authenticated user, optionally
// filtered by a search term. The current user is excluded from results. With
// a search term the server returns at most 50 matches; use SearchUsersPage to
// learn whether more matched.
func (c *Client) SearchUsers(ctx context.Context, search string) ([]UserInfo, error) {
	page, err := c.SearchUsersPage(ctx, search)
	if err != nil {
		return nil, err
	}
	return page.Users, nil
}

// UserSearchPage is the GET /users response.
type UserSearchPage struct {
	Users []UserInfo `json:"users"`
	// Truncated reports that the search matched more users than were returned.
	Truncated bool `json:"truncated"`
}

// SearchUsersPage is SearchUsers, also reporting whether a search was capped.
func (c *Client) SearchUsersPage(ctx context.Context, search string) (*UserSearchPage, error) {
	path := "/api/v1/users"
	if search != "" {
		path += "?" + url.Values{"search": {search}}.Encode()
	}

	var page UserSearchPage
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &page); err != nil {
		return nil, err
	}
	return &page, nil
}
