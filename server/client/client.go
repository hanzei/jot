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
	"time"
)

// DefaultTimeout is the HTTP client timeout applied by New.
// It bounds every request (including response-body read) so that CLI tools
// and scripts do not hang indefinitely when the server is unreachable.
const DefaultTimeout = 30 * time.Second

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
// The underlying HTTP client is configured with [DefaultTimeout].
// Use [WithHTTPClient] to override the client when a different timeout or
// transport is required (e.g. tests that need longer deadlines or SSE streams).
func New(baseURL string) *Client {
	jar, err := cookiejar.New(nil)
	if err != nil {
		panic(err)
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		httpClient: &http.Client{
			Jar:     jar,
			Timeout: DefaultTimeout,
		},
	}
}

// WithHTTPClient replaces the underlying HTTP client and returns the receiver.
// The caller's cookie jar is preserved: the receiver's existing jar takes
// precedence (so in-flight session cookies are not discarded), falling back to
// the provided client's jar, and only creating a fresh jar if neither has one.
// Pass a client whose Timeout is 0 to disable the default timeout (e.g. for
// long-lived SSE connections).
func (c *Client) WithHTTPClient(httpClient *http.Client) *Client {
	clone := *httpClient // shallow copy; avoids mutating the caller's value

	switch {
	case c.httpClient != nil && c.httpClient.Jar != nil:
		clone.Jar = c.httpClient.Jar // preserve receiver's existing session cookies
	case httpClient.Jar != nil:
		clone.Jar = httpClient.Jar // use caller-supplied jar if present
	default:
		jar, err := cookiejar.New(nil)
		if err != nil {
			panic(err)
		}
		clone.Jar = jar
	}

	c.httpClient = &clone
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
