package client

import (
	"context"
	"fmt"
	"io"
	"net/http"
)

// Config returns the public server configuration (unauthenticated).
func (c *Client) Config(ctx context.Context) (*ServerConfig, error) {
	var resp ServerConfig
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/config", nil, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// Register creates a new user account and stores the session cookie.
func (c *Client) Register(ctx context.Context, username, password string) (*AuthResponse, error) {
	var resp AuthResponse
	err := c.doJSON(ctx, http.MethodPost, "/api/v1/register", map[string]string{
		"username": username,
		"password": password,
	}, &resp)
	if err != nil {
		return nil, err
	}
	return &resp, nil
}

// Login authenticates and stores the session cookie.
func (c *Client) Login(ctx context.Context, username, password string) (*AuthResponse, error) {
	var resp AuthResponse
	err := c.doJSON(ctx, http.MethodPost, "/api/v1/login", map[string]string{
		"username": username,
		"password": password,
	}, &resp)
	if err != nil {
		return nil, err
	}
	return &resp, nil
}

// Logout destroys the current session.
func (c *Client) Logout(ctx context.Context) error {
	return c.doNoContent(ctx, http.MethodPost, "/api/v1/logout", nil)
}

// Me returns the currently authenticated user and settings.
func (c *Client) Me(ctx context.Context) (*AuthResponse, error) {
	var resp AuthResponse
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/me", nil, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// UpdateUser updates the authenticated user's profile and/or settings.
func (c *Client) UpdateUser(ctx context.Context, req *UpdateUserRequest) (*AuthResponse, error) {
	if req == nil {
		return nil, fmt.Errorf("request must not be nil")
	}
	var resp AuthResponse
	if err := c.doJSON(ctx, http.MethodPatch, "/api/v1/users/me", req, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// ChangePassword changes the authenticated user's password.
func (c *Client) ChangePassword(ctx context.Context, currentPassword, newPassword string) error {
	return c.doNoContent(ctx, http.MethodPut, "/api/v1/users/me/password", map[string]string{
		"current_password": currentPassword,
		"new_password":     newPassword,
	})
}

// UploadProfileIcon uploads an image as the current user's profile icon.
// data is read fully; filename is used only for the multipart header.
func (c *Client) UploadProfileIcon(ctx context.Context, filename string, data io.Reader) (*User, error) {
	var user User
	if err := c.doMultipartUpload(ctx, "/api/v1/users/me/profile-icon", filename, data, &user); err != nil {
		return nil, err
	}
	return &user, nil
}

// DeleteProfileIcon removes the current user's profile icon.
func (c *Client) DeleteProfileIcon(ctx context.Context) error {
	return c.doNoContent(ctx, http.MethodDelete, "/api/v1/users/me/profile-icon", nil)
}

// GetProfileIcon fetches a user's profile icon bytes and content type.
func (c *Client) GetProfileIcon(ctx context.Context, userID string) ([]byte, string, error) {
	return c.doGetBytes(ctx, fmt.Sprintf("/api/v1/users/%s/profile-icon", userID))
}
