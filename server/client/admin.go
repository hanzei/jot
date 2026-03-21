package client

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

// AdminListUsers returns all users (admin only).
func (c *Client) AdminListUsers(ctx context.Context) ([]*User, error) {
	users, err := collectAllPages(func(page *PaginationOptions) (*PaginatedResponse[User], error) {
		return c.AdminListUsersPage(ctx, page)
	})
	if err != nil {
		return nil, err
	}

	result := make([]*User, len(users))
	for i := range users {
		result[i] = &users[i]
	}
	return result, nil
}

// AdminListUsersPage returns a single paginated page of users (admin only).
func (c *Client) AdminListUsersPage(ctx context.Context, pagination *PaginationOptions) (*PaginatedResponse[User], error) {
	path := "/api/v1/admin/users"
	q := url.Values{}
	applyPagination(q, pagination)
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}

	var resp UserListResponse
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// AdminGetStats returns aggregate system statistics (admin only).
func (c *Client) AdminGetStats(ctx context.Context) (*AdminStatsResponse, error) {
	var resp AdminStatsResponse
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/admin/stats", nil, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// AdminCreateUser creates a user account (admin only).
func (c *Client) AdminCreateUser(ctx context.Context, username, password string, role Role) (*User, error) {
	var user User
	if err := c.doJSON(ctx, http.MethodPost, "/api/v1/admin/users", map[string]string{
		"username": username,
		"password": password,
		"role":     string(role),
	}, &user); err != nil {
		return nil, err
	}
	return &user, nil
}

// AdminUpdateUserRole changes a user's role (admin only).
func (c *Client) AdminUpdateUserRole(ctx context.Context, userID string, role Role) (*User, error) {
	var user User
	if err := c.doJSON(ctx, http.MethodPut, fmt.Sprintf("/api/v1/admin/users/%s/role", userID), map[string]string{
		"role": string(role),
	}, &user); err != nil {
		return nil, err
	}
	return &user, nil
}

// AdminDeleteUser deletes a user account (admin only).
func (c *Client) AdminDeleteUser(ctx context.Context, userID string) error {
	return c.doNoContent(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/admin/users/%s", userID), nil)
}
