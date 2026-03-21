package client

import (
	"context"
	"net/http"
	"net/url"
)

// SearchUsers lists users visible to the authenticated user, optionally
// filtered by a search term. The current user is excluded from results.
func (c *Client) SearchUsers(ctx context.Context, search string) ([]UserInfo, error) {
	users, err := collectAllPages(func(page *PaginationOptions) (*PaginatedResponse[UserInfo], error) {
		return c.SearchUsersPage(ctx, search, page)
	})
	if err != nil {
		return nil, err
	}
	return users, nil
}

// SearchUsersPage returns a single paginated page of users visible to the authenticated user.
func (c *Client) SearchUsersPage(ctx context.Context, search string, pagination *PaginationOptions) (*PaginatedResponse[UserInfo], error) {
	path := "/api/v1/users"
	q := url.Values{}
	if search != "" {
		q.Set("search", search)
	}
	applyPagination(q, pagination)
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}

	var response PaginatedResponse[UserInfo]
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &response); err != nil {
		return nil, err
	}
	return &response, nil
}
