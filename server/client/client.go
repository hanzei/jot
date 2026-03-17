package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"strings"
)

// Error is an API error with the HTTP status code and response body.
type Error struct {
	StatusCode int
	Body       string
}

func (e *Error) Error() string {
	return fmt.Sprintf("jot api returned: %d %s", e.StatusCode, strings.TrimSpace(e.Body))
}

// StatusCode extracts the HTTP status code from an [Error].
// If err is nil or not an *Error it returns 0.
func StatusCode(err error) int {
	var apiErr *Error
	if errors.As(err, &apiErr) {
		return apiErr.StatusCode
	}
	return 0
}

// Client is a typed HTTP client for the Jot API.
// It maintains session cookies automatically after Register or Login.
type Client struct {
	baseURL    string
	httpClient *http.Client
}

// New creates a new Jot API client pointed at baseURL (e.g. "http://localhost:8080").
// The default HTTP client has no timeout; callers should use context deadlines or
// [WithHTTPClient] with a configured Timeout for production use.
func New(baseURL string) *Client {
	jar, err := cookiejar.New(nil)
	if err != nil {
		panic(err)
	}
	c := &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		httpClient: &http.Client{Jar: jar},
	}

	return c
}

// HTTPClient returns the underlying *http.Client.
// This is useful for tests that need low-level HTTP access (e.g. SSE streams,
// raw multipart uploads, or cookie manipulation).
func (c *Client) HTTPClient() *http.Client {
	return c.httpClient
}

// BaseURL returns the server base URL the client is configured for.
func (c *Client) BaseURL() string {
	return c.baseURL
}

func (c *Client) url(path string) string {
	return c.baseURL + path
}

func (c *Client) doJSON(ctx context.Context, method, path string, body any, result any) error {
	var reqBody io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal request body: %w", err)
		}
		reqBody = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.url(path), reqBody)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("execute request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read response body: %w", err)
	}

	if resp.StatusCode >= 400 {
		return &Error{StatusCode: resp.StatusCode, Body: string(respBody)}
	}

	if result != nil && len(respBody) > 0 {
		if err := json.Unmarshal(respBody, result); err != nil {
			return fmt.Errorf("unmarshal response: %w", err)
		}
	}

	return nil
}

func (c *Client) doNoContent(ctx context.Context, method, path string, body any) error {
	return c.doJSON(ctx, method, path, body, nil)
}
