package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/server"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type TestResponse struct {
	StatusCode int
	Body       []byte
	Headers    http.Header
	Cookies    []*http.Cookie
}

func (r *TestResponse) UnmarshalBody(v any) error {
	return json.Unmarshal(r.Body, v)
}

func (r *TestResponse) GetString() string {
	return string(r.Body)
}

type TestUser struct {
	User   *models.User
	Client *http.Client
}

type TestServer struct {
	Server     *server.Server
	HTTPServer *httptest.Server
}

func setupTestServer(t *testing.T) *TestServer {
	tmpDB := fmt.Sprintf("/tmp/test_%s.db", t.Name())
	_ = os.Remove(tmpDB)

	t.Setenv("DB_PATH", tmpDB)
	t.Setenv("COOKIE_SECURE", "false")

	s := server.New()
	httpServer := httptest.NewServer(s.GetRouter())

	ts := &TestServer{
		Server:     s,
		HTTPServer: httpServer,
	}

	t.Cleanup(func() {
		httpServer.Close()
		_ = ts.Server.GetDB().Close()
		_ = os.Remove(tmpDB)
	})

	return ts
}

func newCookieClient(t *testing.T) *http.Client {
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	return &http.Client{Jar: jar}
}

func (ts *TestServer) createTestUser(t *testing.T, username, password string, isAdmin bool) *TestUser {
	client := newCookieClient(t)

	// Register user via API to get a session cookie
	body := map[string]string{
		"username": username,
		"password": password,
	}
	jsonBody, err := json.Marshal(body)
	require.NoError(t, err)

	resp, err := client.Post(ts.HTTPServer.URL+"/api/v1/register", "application/json", bytes.NewBuffer(jsonBody))
	require.NoError(t, err)
	defer resp.Body.Close()

	var authResp struct {
		User *models.User `json:"user"`
	}
	respBody, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(respBody, &authResp))

	// If admin role is needed, update directly in DB
	if isAdmin {
		_, err = ts.Server.GetDB().Exec("UPDATE users SET role = ? WHERE id = ?", models.RoleAdmin, authResp.User.ID)
		require.NoError(t, err)

		authResp.User.Role = models.RoleAdmin
	}

	return &TestUser{
		User:   authResp.User,
		Client: client,
	}
}

func (ts *TestServer) request(t *testing.T, client *http.Client, method, path string, body any) *TestResponse {
	var reqBody io.Reader
	if body != nil {
		jsonBody, err := json.Marshal(body)
		require.NoError(t, err, "Failed to marshal request body")
		reqBody = bytes.NewBuffer(jsonBody)
	}

	req, err := http.NewRequest(method, ts.HTTPServer.URL+path, reqBody)
	require.NoError(t, err, "Failed to create HTTP request")

	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	if client == nil {
		client = &http.Client{}
	}

	resp, err := client.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	require.NoError(t, err, "Failed to read response body")

	return &TestResponse{
		StatusCode: resp.StatusCode,
		Body:       respBody,
		Headers:    resp.Header,
		Cookies:    resp.Cookies(),
	}
}

func (ts *TestServer) authRequest(t *testing.T, user *TestUser, method, path string, body any) *TestResponse {
	return ts.request(t, user.Client, method, path, body)
}

// Health endpoint tests
func TestHealthEndpoint(t *testing.T) {
	ts := setupTestServer(t)

	resp := ts.request(t, nil, http.MethodGet, "/health", nil)

	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "OK", resp.GetString())
}

// Auth endpoint tests
func TestRegisterEndpoint(t *testing.T) {
	ts := setupTestServer(t)

	t.Run("valid registration", func(t *testing.T) {
		body := map[string]string{
			"username": "testuser",
			"password": "password123",
		}

		resp := ts.request(t, newCookieClient(t), http.MethodPost, "/api/v1/register", body)
		assert.Equal(t, http.StatusCreated, resp.StatusCode)

		var response map[string]any
		require.NoError(t, resp.UnmarshalBody(&response))
		assert.NotNil(t, response["user"])
	})

	t.Run("duplicate username", func(t *testing.T) {
		body := map[string]string{
			"username": "duplicate",
			"password": "password123",
		}

		ts.request(t, newCookieClient(t), http.MethodPost, "/api/v1/register", body)
		resp := ts.request(t, newCookieClient(t), http.MethodPost, "/api/v1/register", body)

		assert.Equal(t, http.StatusConflict, resp.StatusCode)
	})

	t.Run("invalid username", func(t *testing.T) {
		body := map[string]string{
			"username": "x",
			"password": "password123",
		}

		resp := ts.request(t, newCookieClient(t), http.MethodPost, "/api/v1/register", body)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})
}

func TestLoginEndpoint(t *testing.T) {
	ts := setupTestServer(t)

	// Register a user first
	registerBody := map[string]string{
		"username": "loginuser",
		"password": "password123",
	}
	ts.request(t, newCookieClient(t), http.MethodPost, "/api/v1/register", registerBody)

	t.Run("valid login", func(t *testing.T) {
		client := newCookieClient(t)
		body := map[string]string{
			"username": "loginuser",
			"password": "password123",
		}

		resp := ts.request(t, client, http.MethodPost, "/api/v1/login", body)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var response map[string]any
		require.NoError(t, resp.UnmarshalBody(&response))
		assert.NotNil(t, response["user"])

		// Verify the session cookie works for authenticated requests
		meResp := ts.request(t, client, http.MethodGet, "/api/v1/me", nil)
		assert.Equal(t, http.StatusOK, meResp.StatusCode)
	})

	t.Run("invalid credentials", func(t *testing.T) {
		body := map[string]string{
			"username": "loginuser",
			"password": "wrongpassword",
		}

		resp := ts.request(t, newCookieClient(t), http.MethodPost, "/api/v1/login", body)
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	})
}

func TestLogoutEndpoint(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "logoutuser", "password123", false)

	// Verify session works before logout
	meResp := ts.authRequest(t, user, http.MethodGet, "/api/v1/me", nil)
	assert.Equal(t, http.StatusOK, meResp.StatusCode)

	// Logout
	logoutResp := ts.authRequest(t, user, http.MethodPost, "/api/v1/logout", nil)
	assert.Equal(t, http.StatusNoContent, logoutResp.StatusCode)

	// Verify session no longer works
	meResp2 := ts.authRequest(t, user, http.MethodGet, "/api/v1/me", nil)
	assert.Equal(t, http.StatusUnauthorized, meResp2.StatusCode)
}

// Notes endpoint tests
func TestNotesEndpoints(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "user", "password123", false)

	t.Run("unauthorized access", func(t *testing.T) {
		resp := ts.request(t, nil, http.MethodGet, "/api/v1/notes", nil)
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	})

	t.Run("get empty notes list", func(t *testing.T) {
		resp := ts.authRequest(t, user, http.MethodGet, "/api/v1/notes", nil)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var notes []any
		require.NoError(t, resp.UnmarshalBody(&notes))
		assert.Empty(t, notes)
	})

	t.Run("create note", func(t *testing.T) {
		body := map[string]any{
			"title":     "Test Note",
			"content":   "This is a test note",
			"note_type": "text",
			"color":     "#ffeb3b",
		}

		resp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", body)
		assert.Equal(t, http.StatusCreated, resp.StatusCode)

		var note map[string]any
		require.NoError(t, resp.UnmarshalBody(&note))

		assert.Equal(t, "Test Note", note["title"])
	})

	// Create a note for further tests
	body := map[string]any{
		"title":   "Test Note",
		"content": "Test Content",
	}
	createResp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", body)
	var createdNote map[string]any
	require.NoError(t, createResp.UnmarshalBody(&createdNote))
	noteID := createdNote["id"].(string)

	t.Run("get specific note", func(t *testing.T) {
		resp := ts.authRequest(t, user, http.MethodGet, fmt.Sprintf("/api/v1/notes/%s", noteID), nil)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var note map[string]any
		require.NoError(t, resp.UnmarshalBody(&note))

		assert.Equal(t, "Test Note", note["title"])
	})

	t.Run("update note", func(t *testing.T) {
		updateBody := map[string]any{
			"title":    "Updated Title",
			"content":  "Updated Content",
			"pinned":   true,
			"archived": false,
			"color":    "#ff0000",
		}

		resp := ts.authRequest(t, user, http.MethodPut, fmt.Sprintf("/api/v1/notes/%s", noteID), updateBody)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var updatedNote map[string]any
		require.NoError(t, resp.UnmarshalBody(&updatedNote))

		assert.Equal(t, "Updated Title", updatedNote["title"])
	})

	t.Run("delete note", func(t *testing.T) {
		resp := ts.authRequest(t, user, http.MethodDelete, fmt.Sprintf("/api/v1/notes/%s", noteID), nil)
		assert.Equal(t, http.StatusNoContent, resp.StatusCode)

		// Verify note is deleted
		getResp := ts.authRequest(t, user, http.MethodGet, fmt.Sprintf("/api/v1/notes/%s", noteID), nil)
		assert.Equal(t, http.StatusNotFound, getResp.StatusCode)
	})
}

// Admin endpoint tests
func TestAdminEndpoints(t *testing.T) {
	ts := setupTestServer(t)
	adminUser := ts.createTestUser(t, "admin", "password123", true)
	user := ts.createTestUser(t, "user", "password123", false)

	t.Run("get users as admin", func(t *testing.T) {
		resp := ts.authRequest(t, adminUser, http.MethodGet, "/api/v1/admin/users", nil)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var response map[string]any
		require.NoError(t, resp.UnmarshalBody(&response))

		users := response["users"].([]any)
		assert.Len(t, users, 2)
	})

	t.Run("get users as non-admin", func(t *testing.T) {
		resp := ts.authRequest(t, user, http.MethodGet, "/api/v1/admin/users", nil)
		assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	})

	t.Run("create user as admin", func(t *testing.T) {
		body := map[string]any{
			"username": "newuser",
			"password": "password123",
			"role":     "user",
		}

		resp := ts.authRequest(t, adminUser, http.MethodPost, "/api/v1/admin/users", body)
		assert.Equal(t, http.StatusCreated, resp.StatusCode)

		var createdUser map[string]any
		require.NoError(t, resp.UnmarshalBody(&createdUser))

		assert.Equal(t, "newuser", createdUser["username"])
	})

	t.Run("create user as non-admin", func(t *testing.T) {
		body := map[string]any{
			"username": "hacker",
			"password": "password123",
			"role":     "admin",
		}

		resp := ts.authRequest(t, user, http.MethodPost, "/api/v1/admin/users", body)
		assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	})
}

// TestUpdateUserEndpoint tests the PUT /api/v1/users/me endpoint for updating
// the authenticated user's username.
func TestUpdateUserEndpoint(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "originaluser", "password123", false)
	other := ts.createTestUser(t, "otheruser", "password123", false)

	t.Run("successful username update", func(t *testing.T) {
		t.Cleanup(func() {
			// Restore username for subsequent subtests
			restoreResp := ts.authRequest(t, user, http.MethodPut, "/api/v1/users/me", map[string]any{"username": "originaluser"})
			require.Equal(t, http.StatusOK, restoreResp.StatusCode)
		})

		body := map[string]any{"username": "newusername"}
		resp := ts.authRequest(t, user, http.MethodPut, "/api/v1/users/me", body)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var response map[string]any
		require.NoError(t, resp.UnmarshalBody(&response))

		userResp, ok := response["user"].(map[string]any)
		require.True(t, ok, "expected response.user object")
		assert.Equal(t, "newusername", userResp["username"])
	})

	t.Run("duplicate username returns 409", func(t *testing.T) {
		body := map[string]any{"username": other.User.Username}
		resp := ts.authRequest(t, user, http.MethodPut, "/api/v1/users/me", body)
		assert.Equal(t, http.StatusConflict, resp.StatusCode)
	})

	t.Run("invalid username format returns 400", func(t *testing.T) {
		body := map[string]any{"username": "a"} // too short (< 2 chars)
		resp := ts.authRequest(t, user, http.MethodPut, "/api/v1/users/me", body)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})

	t.Run("unauthenticated request returns 401", func(t *testing.T) {
		body := map[string]any{"username": "hacker"}
		resp := ts.request(t, nil, http.MethodPut, "/api/v1/users/me", body)
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	})
}

// SSE endpoint tests

func TestSSEEndpoint(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "sseuser", "password123", false)

	t.Run("unauthenticated returns 401", func(t *testing.T) {
		resp := ts.request(t, nil, http.MethodGet, "/api/v1/events", nil)
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	})

	t.Run("authenticated receives SSE headers and connected comment", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, ts.HTTPServer.URL+"/api/v1/events", nil)
		require.NoError(t, err)

		resp, err := user.Client.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()

		assert.Equal(t, http.StatusOK, resp.StatusCode)
		assert.Equal(t, "text/event-stream", resp.Header.Get("Content-Type"))
		assert.Equal(t, "no-cache", resp.Header.Get("Cache-Control"))

		// The first SSE line must be ": connected"
		scanner := bufio.NewScanner(resp.Body)
		require.True(t, scanner.Scan(), "expected first line from SSE stream")
		assert.Equal(t, ": connected", scanner.Text())
	})

	t.Run("note creation triggers note_created event", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, ts.HTTPServer.URL+"/api/v1/events", nil)
		require.NoError(t, err)

		resp, err := user.Client.Do(req) //nolint:bodyclose // closed on next line
		require.NoError(t, err)
		defer resp.Body.Close()

		// connectedCh is closed once ": connected" is read, guaranteeing the hub
		// subscription is active before we publish any events.
		connectedCh := make(chan struct{})
		eventCh := make(chan map[string]any, 4)

		go func() {
			scanner := bufio.NewScanner(resp.Body)
			connectedSent := false
			for scanner.Scan() {
				line := scanner.Text()
				if !connectedSent && line == ": connected" {
					close(connectedCh)
					connectedSent = true
					continue
				}
				if strings.HasPrefix(line, "data: ") {
					var event map[string]any
					if jsonErr := json.Unmarshal([]byte(line[6:]), &event); jsonErr == nil {
						eventCh <- event
					}
				}
			}
		}()

		// Wait until the subscription is registered.
		select {
		case <-connectedCh:
		case <-ctx.Done():
			t.Fatal("timed out waiting for SSE connection")
		}

		// Trigger an event by creating a note.
		noteBody := map[string]any{
			"title":     "SSE Test Note",
			"content":   "test content",
			"note_type": "text",
		}
		noteResp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", noteBody)
		require.Equal(t, http.StatusCreated, noteResp.StatusCode)

		var note map[string]any
		require.NoError(t, noteResp.UnmarshalBody(&note))

		select {
		case event := <-eventCh:
			assert.Equal(t, "note_created", event["type"])
			assert.Equal(t, user.User.ID, event["source_user_id"])
			assert.Equal(t, note["id"], event["note_id"])
		case <-ctx.Done():
			t.Fatal("timed out waiting for SSE event after note creation")
		}
	})
}

func TestChangePasswordEndpoint(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "passuser", "oldpassword", false)

	t.Run("successful password change", func(t *testing.T) {
		body := map[string]string{
			"current_password": "oldpassword",
			"new_password":     "newpassword",
		}
		resp := ts.authRequest(t, user, http.MethodPut, "/api/v1/users/me/password", body)
		assert.Equal(t, http.StatusNoContent, resp.StatusCode)

		// The handler invalidates old sessions and issues a fresh one, so
		// verify the new password works with a separate login.
		loginBody := map[string]string{"username": "passuser", "password": "newpassword"}
		loginResp := ts.request(t, user.Client, http.MethodPost, "/api/v1/login", loginBody)
		assert.Equal(t, http.StatusOK, loginResp.StatusCode)
	})

	t.Run("wrong current password returns 403", func(t *testing.T) {
		body := map[string]string{
			"current_password": "wrongpassword",
			"new_password":     "anotherpass",
		}
		resp := ts.authRequest(t, user, http.MethodPut, "/api/v1/users/me/password", body)
		assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	})

	t.Run("short new password returns 400", func(t *testing.T) {
		body := map[string]string{
			"current_password": "newpassword",
			"new_password":     "ab",
		}
		resp := ts.authRequest(t, user, http.MethodPut, "/api/v1/users/me/password", body)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})

	t.Run("missing fields returns 400", func(t *testing.T) {
		body := map[string]string{
			"current_password": "",
			"new_password":     "",
		}
		resp := ts.authRequest(t, user, http.MethodPut, "/api/v1/users/me/password", body)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})

	t.Run("unauthenticated request returns 401", func(t *testing.T) {
		body := map[string]string{
			"current_password": "newpassword",
			"new_password":     "hacked",
		}
		resp := ts.request(t, nil, http.MethodPut, "/api/v1/users/me/password", body)
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	})
}
