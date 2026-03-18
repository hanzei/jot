package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
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
	if data == nil {
		return nil, fmt.Errorf("data reader must not be nil")
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile("file", filename)
	if err != nil {
		return nil, fmt.Errorf("create form file: %w", err)
	}
	if _, err = io.Copy(part, data); err != nil {
		return nil, fmt.Errorf("copy file data: %w", err)
	}
	contentType := mw.FormDataContentType()
	if err = mw.Close(); err != nil {
		return nil, fmt.Errorf("close multipart writer: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url("/api/v1/users/me/profile-icon"), &buf)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", contentType)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("execute request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode >= 400 {
		return nil, &Error{StatusCode: resp.StatusCode, Body: string(respBody)}
	}

	var user User
	if err = json.Unmarshal(respBody, &user); err != nil {
		return nil, fmt.Errorf("unmarshal response: %w", err)
	}
	return &user, nil
}

// DeleteProfileIcon removes the current user's profile icon.
func (c *Client) DeleteProfileIcon(ctx context.Context) error {
	return c.doNoContent(ctx, http.MethodDelete, "/api/v1/users/me/profile-icon", nil)
}

// GetProfileIcon fetches a user's profile icon bytes and content type.
func (c *Client) GetProfileIcon(ctx context.Context, userID string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url(fmt.Sprintf("/api/v1/users/%s/profile-icon", userID)), nil)
	if err != nil {
		return nil, "", fmt.Errorf("create request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("execute request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode >= 400 {
		return nil, "", &Error{StatusCode: resp.StatusCode, Body: string(body)}
	}
	return body, resp.Header.Get("Content-Type"), nil
}
