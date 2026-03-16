package client

import (
	"context"
	"fmt"
	"net/http"
)

// AdminListUsers returns all users (admin only).
func (c *Client) AdminListUsers(ctx context.Context) ([]*User, error) {
	var resp UserListResponse
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/admin/users", nil, &resp); err != nil {
		return nil, err
	}
	return resp.Users, nil
}

// AdminCreateUser creates a user account (admin only).
func (c *Client) AdminCreateUser(ctx context.Context, username, password, role string) (*User, error) {
	var user User
	if err := c.doJSON(ctx, http.MethodPost, "/api/v1/admin/users", map[string]string{
		"username": username,
		"password": password,
		"role":     role,
	}, &user); err != nil {
		return nil, err
	}
	return &user, nil
}

// AdminUpdateUserRole changes a user's role (admin only).
func (c *Client) AdminUpdateUserRole(ctx context.Context, userID, role string) (*User, error) {
	var user User
	if err := c.doJSON(ctx, http.MethodPut, fmt.Sprintf("/api/v1/admin/users/%s/role", userID), map[string]string{
		"role": role,
	}, &user); err != nil {
		return nil, err
	}
	return &user, nil
}

// AdminDeleteUser deletes a user account (admin only).
func (c *Client) AdminDeleteUser(ctx context.Context, userID string) error {
	return c.doNoContent(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/admin/users/%s", userID), nil)
}
