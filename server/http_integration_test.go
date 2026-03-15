package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"mime/multipart"
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
	safeTestName := strings.NewReplacer("/", "_", "\\", "_").Replace(t.Name())
	tmpDB := fmt.Sprintf("/tmp/test_%s.db", safeTestName)
	_ = os.Remove(tmpDB)
	staticDir := t.TempDir()
	require.NoError(t, os.WriteFile(staticDir+"/index.html", []byte("<html><body>jot test app</body></html>"), 0o600))

	t.Setenv("DB_PATH", tmpDB)
	t.Setenv("COOKIE_SECURE", "false")
	t.Setenv("STATIC_DIR", staticDir)

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

// Probe endpoint tests
func TestProbeEndpoints(t *testing.T) {
	ts := setupTestServer(t)

	t.Run("health path falls back to spa", func(t *testing.T) {
		resp := ts.request(t, nil, http.MethodGet, "/health", nil)

		assert.Equal(t, http.StatusOK, resp.StatusCode)
		assert.Contains(t, resp.GetString(), "jot test app")
	})

	t.Run("unknown api route still returns not found", func(t *testing.T) {
		resp := ts.request(t, nil, http.MethodGet, "/api/v1/nonexistent", nil)

		assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	})

	t.Run("unknown api namespace returns not found", func(t *testing.T) {
		resp := ts.request(t, nil, http.MethodGet, "/api/v2/nonexistent", nil)

		assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	})

	t.Run("bare api path returns not found", func(t *testing.T) {
		resp := ts.request(t, nil, http.MethodGet, "/api", nil)

		assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	})

	t.Run("livez endpoint", func(t *testing.T) {
		resp := ts.request(t, nil, http.MethodGet, "/livez", nil)

		assert.Equal(t, http.StatusOK, resp.StatusCode)
		assert.Equal(t, "OK", resp.GetString())
	})

	t.Run("readyz endpoint", func(t *testing.T) {
		resp := ts.request(t, nil, http.MethodGet, "/readyz", nil)

		assert.Equal(t, http.StatusOK, resp.StatusCode)
		assert.Equal(t, "OK", resp.GetString())
	})

	t.Run("readyz returns 503 when shutting down", func(t *testing.T) {
		ts.Server.BeginShutdown()
		resp := ts.request(t, nil, http.MethodGet, "/readyz", nil)
		assert.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)
		assert.Contains(t, resp.GetString(), "NOT READY")
	})

	t.Run("readyz returns 503 when database is unavailable", func(t *testing.T) {
		tsWithClosedDB := setupTestServer(t)
		require.NoError(t, tsWithClosedDB.Server.GetDB().Close())

		resp := tsWithClosedDB.request(t, nil, http.MethodGet, "/readyz", nil)
		assert.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)
		assert.Contains(t, resp.GetString(), "NOT READY")
	})
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

	t.Run("delete user as admin", func(t *testing.T) {
		// Create a user to delete
		deleteTarget := ts.createTestUser(t, "todelete", "password123", false)

		resp := ts.authRequest(t, adminUser, http.MethodDelete, fmt.Sprintf("/api/v1/admin/users/%s", deleteTarget.User.ID), nil)
		assert.Equal(t, http.StatusNoContent, resp.StatusCode)

		// Verify user is gone from list
		listResp := ts.authRequest(t, adminUser, http.MethodGet, "/api/v1/admin/users", nil)
		var response map[string]any
		require.NoError(t, listResp.UnmarshalBody(&response))
		users := response["users"].([]any)
		for _, u := range users {
			uMap := u.(map[string]any)
			assert.NotEqual(t, deleteTarget.User.ID, uMap["id"])
		}
	})

	t.Run("delete user as non-admin returns 403", func(t *testing.T) {
		// Create a user to attempt deletion
		deleteTarget := ts.createTestUser(t, "todelete2", "password123", false)

		resp := ts.authRequest(t, user, http.MethodDelete, fmt.Sprintf("/api/v1/admin/users/%s", deleteTarget.User.ID), nil)
		assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	})

	t.Run("admin cannot delete themselves", func(t *testing.T) {
		resp := ts.authRequest(t, adminUser, http.MethodDelete, fmt.Sprintf("/api/v1/admin/users/%s", adminUser.User.ID), nil)
		assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	})

	t.Run("delete nonexistent user returns 404", func(t *testing.T) {
		resp := ts.authRequest(t, adminUser, http.MethodDelete, "/api/v1/admin/users/nonexistentid12345678", nil)
		assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	})
}

// TestDeleteUserAdminCanDeleteOtherAdmin verifies that an admin can delete another admin
// when multiple admins exist (the last-admin guard should not trigger).
func TestDeleteUserAdminCanDeleteOtherAdmin(t *testing.T) {
	ts := setupTestServer(t)
	admin1 := ts.createTestUser(t, "admin1", "password123", true)
	admin2 := ts.createTestUser(t, "admin2", "password123", true)

	resp := ts.authRequest(t, admin1, http.MethodDelete, fmt.Sprintf("/api/v1/admin/users/%s", admin2.User.ID), nil)
	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
}

// TestUpdateUserEndpoint tests the PUT /api/v1/users/me endpoint for updating
// the authenticated user's profile and settings.
func TestUpdateUserEndpoint(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "originaluser", "password123", false)
	other := ts.createTestUser(t, "otheruser", "password123", false)

	t.Run("successful username update", func(t *testing.T) {
		t.Cleanup(func() {
			restoreResp := ts.authRequest(t, user, http.MethodPatch, "/api/v1/users/me", map[string]any{"username": "originaluser"})
			require.Equal(t, http.StatusOK, restoreResp.StatusCode)
		})

		body := map[string]any{"username": "newusername"}
		resp := ts.authRequest(t, user, http.MethodPatch, "/api/v1/users/me", body)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var response map[string]any
		require.NoError(t, resp.UnmarshalBody(&response))

		userResp, ok := response["user"].(map[string]any)
		require.True(t, ok, "expected response.user object")
		assert.Equal(t, "newusername", userResp["username"])
		assert.NotNil(t, response["settings"], "response should include settings")
	})

	t.Run("duplicate username returns 409", func(t *testing.T) {
		body := map[string]any{"username": other.User.Username}
		resp := ts.authRequest(t, user, http.MethodPatch, "/api/v1/users/me", body)
		assert.Equal(t, http.StatusConflict, resp.StatusCode)
	})

	t.Run("invalid username format returns 400", func(t *testing.T) {
		body := map[string]any{"username": "a"}
		resp := ts.authRequest(t, user, http.MethodPatch, "/api/v1/users/me", body)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})

	t.Run("unauthenticated request returns 401", func(t *testing.T) {
		body := map[string]any{"username": "hacker"}
		resp := ts.request(t, nil, http.MethodPatch, "/api/v1/users/me", body)
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	})

	t.Run("partial update preserves unchanged fields", func(t *testing.T) {
		resp := ts.authRequest(t, user, http.MethodPatch, "/api/v1/users/me", map[string]any{"first_name": "Updated"})
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var response map[string]any
		require.NoError(t, resp.UnmarshalBody(&response))
		userResp, ok := response["user"].(map[string]any)
		require.True(t, ok)
		assert.Equal(t, "Updated", userResp["first_name"])
		assert.Equal(t, "originaluser", userResp["username"])
	})

	t.Run("empty body updates nothing and returns current state", func(t *testing.T) {
		resp := ts.authRequest(t, user, http.MethodPatch, "/api/v1/users/me", map[string]any{})
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var response map[string]any
		require.NoError(t, resp.UnmarshalBody(&response))
		userResp, ok := response["user"].(map[string]any)
		require.True(t, ok)
		assert.Equal(t, "originaluser", userResp["username"])
		assert.NotNil(t, response["settings"])
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

func TestUserSettingsEndpoints(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "settingsuser", "password123", false)

	t.Run("me response includes default settings for new user", func(t *testing.T) {
		resp := ts.authRequest(t, user, http.MethodGet, "/api/v1/me", nil)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var response map[string]any
		require.NoError(t, resp.UnmarshalBody(&response))
		settings, ok := response["settings"].(map[string]any)
		require.True(t, ok)
		assert.Equal(t, "system", settings["language"])
		assert.Equal(t, user.User.ID, settings["user_id"])
	})

	t.Run("PATCH /users/me updates language via unified endpoint", func(t *testing.T) {
		body := map[string]string{"language": "de"}
		resp := ts.authRequest(t, user, http.MethodPatch, "/api/v1/users/me", body)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var response map[string]any
		require.NoError(t, resp.UnmarshalBody(&response))
		settings, ok := response["settings"].(map[string]any)
		require.True(t, ok)
		assert.Equal(t, "de", settings["language"])
	})

	t.Run("me response reflects updated language", func(t *testing.T) {
		resp := ts.authRequest(t, user, http.MethodGet, "/api/v1/me", nil)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var response map[string]any
		require.NoError(t, resp.UnmarshalBody(&response))
		settings, ok := response["settings"].(map[string]any)
		require.True(t, ok)
		assert.Equal(t, "de", settings["language"])
	})

	t.Run("PATCH /users/me with invalid language returns 400", func(t *testing.T) {
		body := map[string]string{"language": "fr"}
		resp := ts.authRequest(t, user, http.MethodPatch, "/api/v1/users/me", body)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})

	t.Run("invalid settings with valid profile does not commit profile (atomic validation)", func(t *testing.T) {
		// Send valid profile change + invalid language; profile must not be updated
		body := map[string]any{"first_name": "ShouldNotPersist", "language": "invalid"}
		resp := ts.authRequest(t, user, http.MethodPatch, "/api/v1/users/me", body)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)

		// Verify profile was not updated
		meResp := ts.authRequest(t, user, http.MethodGet, "/api/v1/me", nil)
		require.Equal(t, http.StatusOK, meResp.StatusCode)
		var meData map[string]any
		require.NoError(t, meResp.UnmarshalBody(&meData))
		userResp, ok := meData["user"].(map[string]any)
		require.True(t, ok)
		assert.NotEqual(t, "ShouldNotPersist", userResp["first_name"])
	})

	t.Run("PATCH /users/me updates both profile and settings", func(t *testing.T) {
		body := map[string]any{"first_name": "Jane", "theme": "dark"}
		resp := ts.authRequest(t, user, http.MethodPatch, "/api/v1/users/me", body)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var response map[string]any
		require.NoError(t, resp.UnmarshalBody(&response))

		userResp, ok := response["user"].(map[string]any)
		require.True(t, ok)
		assert.Equal(t, "Jane", userResp["first_name"])

		settings, ok := response["settings"].(map[string]any)
		require.True(t, ok)
		assert.Equal(t, "dark", settings["theme"])
		assert.Equal(t, "de", settings["language"])
	})

	t.Run("me response includes settings", func(t *testing.T) {
		resp := ts.authRequest(t, user, http.MethodGet, "/api/v1/me", nil)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var response map[string]any
		require.NoError(t, resp.UnmarshalBody(&response))
		assert.NotNil(t, response["settings"])
	})

	t.Run("login response includes settings", func(t *testing.T) {
		loginBody := map[string]string{"username": "settingsuser", "password": "password123"}
		resp := ts.request(t, newCookieClient(t), http.MethodPost, "/api/v1/login", loginBody)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var response map[string]any
		require.NoError(t, resp.UnmarshalBody(&response))
		assert.NotNil(t, response["settings"])
		settings, ok := response["settings"].(map[string]any)
		require.True(t, ok)
		assert.Equal(t, "de", settings["language"])
	})

	t.Run("register response includes settings", func(t *testing.T) {
		regBody := map[string]string{"username": "newsettings", "password": "password123"}
		resp := ts.request(t, newCookieClient(t), http.MethodPost, "/api/v1/register", regBody)
		assert.Equal(t, http.StatusCreated, resp.StatusCode)

		var response map[string]any
		require.NoError(t, resp.UnmarshalBody(&response))
		assert.NotNil(t, response["settings"])
		settings, ok := response["settings"].(map[string]any)
		require.True(t, ok)
		assert.Equal(t, "system", settings["language"])
	})
}

func TestTodoItemIndentLevel(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "indentuser", "password123", false)

	// Create a todo note with items at various indent levels.
	createBody := map[string]any{
		"title":     "Indent Test",
		"note_type": "todo",
		"content":   "",
		"items": []map[string]any{
			{"text": "top level", "position": 0, "indent_level": 0},
			{"text": "indented once", "position": 1, "indent_level": 1},
			{"text": "also indented", "position": 2, "indent_level": 1},
		},
	}
	createResp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", createBody)
	require.Equal(t, http.StatusCreated, createResp.StatusCode)

	var created map[string]any
	require.NoError(t, createResp.UnmarshalBody(&created))
	noteID := created["id"].(string)

	t.Run("indent levels persisted on create", func(t *testing.T) {
		resp := ts.authRequest(t, user, http.MethodGet, "/api/v1/notes/"+noteID, nil)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		var note map[string]any
		require.NoError(t, resp.UnmarshalBody(&note))

		items := note["items"].([]any)
		require.Len(t, items, 3)

		assert.InDelta(t, float64(0), items[0].(map[string]any)["indent_level"], 0)
		assert.InDelta(t, float64(1), items[1].(map[string]any)["indent_level"], 0)
		assert.InDelta(t, float64(1), items[2].(map[string]any)["indent_level"], 0)
	})

	t.Run("indent levels updated via PUT", func(t *testing.T) {
		updateBody := map[string]any{
			"title":                   "Indent Test",
			"content":                 "",
			"pinned":                  false,
			"archived":                false,
			"color":                   "#ffffff",
			"checked_items_collapsed": false,
			"items": []map[string]any{
				{"text": "top level", "position": 0, "completed": false, "indent_level": 0},
				{"text": "indented once", "position": 1, "completed": false, "indent_level": 1},
				{"text": "promoted to top", "position": 2, "completed": false, "indent_level": 0},
			},
		}
		resp := ts.authRequest(t, user, http.MethodPut, "/api/v1/notes/"+noteID, updateBody)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		getResp := ts.authRequest(t, user, http.MethodGet, "/api/v1/notes/"+noteID, nil)
		require.Equal(t, http.StatusOK, getResp.StatusCode)

		var note map[string]any
		require.NoError(t, getResp.UnmarshalBody(&note))

		items := note["items"].([]any)
		require.Len(t, items, 3)

		assert.InDelta(t, float64(0), items[0].(map[string]any)["indent_level"], 0)
		assert.InDelta(t, float64(1), items[1].(map[string]any)["indent_level"], 0)
		assert.InDelta(t, float64(0), items[2].(map[string]any)["indent_level"], 0)
	})

	t.Run("indent level defaults to 0 when omitted", func(t *testing.T) {
		createBody := map[string]any{
			"title":     "No Indent",
			"note_type": "todo",
			"content":   "",
			"items": []map[string]any{
				{"text": "item without indent_level", "position": 0},
			},
		}
		resp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", createBody)
		require.Equal(t, http.StatusCreated, resp.StatusCode)

		var note map[string]any
		require.NoError(t, resp.UnmarshalBody(&note))

		items := note["items"].([]any)
		require.Len(t, items, 1)
		assert.InDelta(t, float64(0), items[0].(map[string]any)["indent_level"], 0)
	})

	t.Run("indent level > 1 rejected on create", func(t *testing.T) {
		body := map[string]any{
			"title":     "Bad Indent",
			"note_type": "todo",
			"content":   "",
			"items": []map[string]any{
				{"text": "too deep", "position": 0, "indent_level": 2},
			},
		}
		resp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", body)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})

	t.Run("indent level > 1 rejected on update", func(t *testing.T) {
		updateBody := map[string]any{
			"title":                   "Indent Test",
			"content":                 "",
			"pinned":                  false,
			"archived":                false,
			"color":                   "#ffffff",
			"checked_items_collapsed": false,
			"items": []map[string]any{
				{"text": "top level", "position": 0, "completed": false, "indent_level": 0},
				{"text": "too deep", "position": 1, "completed": false, "indent_level": 2},
			},
		}
		resp := ts.authRequest(t, user, http.MethodPut, "/api/v1/notes/"+noteID, updateBody)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})
}

// Helper to create a multipart form body with an image file.
func createMultipartImage(t *testing.T, fieldName, fileName string, imgData []byte) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	part, err := writer.CreateFormFile(fieldName, fileName)
	require.NoError(t, err)
	_, err = part.Write(imgData)
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	return &buf, writer.FormDataContentType()
}

// Helper to encode a Go image as PNG bytes.
func encodePNG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, img))
	return buf.Bytes()
}

// Helper to upload a profile icon via multipart POST.
func (ts *TestServer) uploadProfileIcon(t *testing.T, user *TestUser, body *bytes.Buffer, contentType string) *TestResponse {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, ts.HTTPServer.URL+"/api/v1/users/me/profile-icon", body)
	require.NoError(t, err)
	req.Header.Set("Content-Type", contentType)

	resp, err := user.Client.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	return &TestResponse{
		StatusCode: resp.StatusCode,
		Body:       respBody,
		Headers:    resp.Header,
		Cookies:    resp.Cookies(),
	}
}

func TestUploadProfileIcon(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "iconuser", "password123", false)

	t.Run("valid image upload returns 200 with has_profile_icon true", func(t *testing.T) {
		img := image.NewRGBA(image.Rect(0, 0, 64, 64))
		for y := range 64 {
			for x := range 64 {
				img.Set(x, y, color.RGBA{R: 255, A: 255})
			}
		}
		pngData := encodePNG(t, img)
		body, ct := createMultipartImage(t, "file", "test.png", pngData)

		resp := ts.uploadProfileIcon(t, user, body, ct)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var userResp models.User
		require.NoError(t, resp.UnmarshalBody(&userResp))
		assert.True(t, userResp.HasProfileIcon)
	})

	t.Run("transparent PNG pixels are flattened to white", func(t *testing.T) {
		// Fully transparent NRGBA image — after compositing onto white the
		// resulting JPEG pixels should be white (255,255,255).
		img := image.NewNRGBA(image.Rect(0, 0, 4, 4))
		// All pixels default to {0,0,0,0} (fully transparent).
		body, ct := createMultipartImage(t, "file", "transparent.png", encodePNG(t, img))
		require.Equal(t, http.StatusOK, ts.uploadProfileIcon(t, user, body, ct).StatusCode)

		resp := ts.authRequest(t, user, http.MethodGet, "/api/v1/users/"+user.User.ID+"/profile-icon", nil)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		decoded, err := jpeg.Decode(bytes.NewReader(resp.Body))
		require.NoError(t, err)
		r, g, b, _ := decoded.At(0, 0).RGBA()
		// JPEG compression may introduce slight variance; allow ±1.
		assert.InDelta(t, 0xFFFF, r, 256, "red channel should be white")
		assert.InDelta(t, 0xFFFF, g, 256, "green channel should be white")
		assert.InDelta(t, 0xFFFF, b, 256, "blue channel should be white")
	})

	t.Run("stored image is JPEG", func(t *testing.T) {
		// Upload first so this subtest is self-contained.
		img := image.NewRGBA(image.Rect(0, 0, 8, 8))
		body, ct := createMultipartImage(t, "file", "test.png", encodePNG(t, img))
		require.Equal(t, http.StatusOK, ts.uploadProfileIcon(t, user, body, ct).StatusCode)

		// Fetch the profile icon and verify JPEG magic bytes
		resp := ts.authRequest(t, user, http.MethodGet, "/api/v1/users/"+user.User.ID+"/profile-icon", nil)
		assert.Equal(t, http.StatusOK, resp.StatusCode)
		assert.Equal(t, "image/jpeg", resp.Headers.Get("Content-Type"))
		require.GreaterOrEqual(t, len(resp.Body), 2)
		assert.Equal(t, byte(0xFF), resp.Body[0], "JPEG magic byte 1")
		assert.Equal(t, byte(0xD8), resp.Body[1], "JPEG magic byte 2")
	})

	t.Run("oversized image is scaled down to fit 256x256", func(t *testing.T) {
		img := image.NewRGBA(image.Rect(0, 0, 1024, 512))
		pngData := encodePNG(t, img)
		body, ct := createMultipartImage(t, "file", "big.png", pngData)

		resp := ts.uploadProfileIcon(t, user, body, ct)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		// Fetch and decode the stored icon to check dimensions
		getResp := ts.authRequest(t, user, http.MethodGet, "/api/v1/users/"+user.User.ID+"/profile-icon", nil)
		assert.Equal(t, http.StatusOK, getResp.StatusCode)

		decoded, err := jpeg.Decode(bytes.NewReader(getResp.Body))
		require.NoError(t, err)
		bounds := decoded.Bounds()
		assert.LessOrEqual(t, bounds.Dx(), 256)
		assert.LessOrEqual(t, bounds.Dy(), 256)
		// 1024x512 → 256x128 (aspect ratio preserved)
		assert.Equal(t, 256, bounds.Dx())
		assert.Equal(t, 128, bounds.Dy())
	})

	t.Run("corrupt file returns 400", func(t *testing.T) {
		// Starts with PNG header but is truncated/corrupt
		corruptData := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00}
		body, ct := createMultipartImage(t, "file", "corrupt.png", corruptData)

		resp := ts.uploadProfileIcon(t, user, body, ct)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})

	t.Run("decompression bomb is rejected", func(t *testing.T) {
		// Craft a minimal valid PNG IHDR that claims 5000x5000 (exceeds 4096 cap).
		// PNG signature + IHDR chunk with huge dimensions, then truncated.
		// This is enough for image.DecodeConfig to read dimensions.
		pngHeader := []byte{
			0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
			0x00, 0x00, 0x00, 0x0D, // IHDR length (13 bytes)
			0x49, 0x48, 0x44, 0x52, // "IHDR"
			0x00, 0x00, 0x13, 0x88, // width: 5000
			0x00, 0x00, 0x13, 0x88, // height: 5000
			0x08,             // bit depth: 8
			0x02,             // color type: RGB
			0x00, 0x00, 0x00, // compression, filter, interlace
			0x00, 0x00, 0x00, 0x00, // CRC (invalid but DecodeConfig reads before checking)
		}
		body, ct := createMultipartImage(t, "file", "bomb.png", pngHeader)

		resp := ts.uploadProfileIcon(t, user, body, ct)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})

	t.Run("GIF upload returns 400", func(t *testing.T) {
		img := image.NewPaletted(image.Rect(0, 0, 1, 1), color.Palette{color.White})
		var buf bytes.Buffer
		require.NoError(t, gif.Encode(&buf, img, nil))
		body, ct := createMultipartImage(t, "file", "test.gif", buf.Bytes())

		resp := ts.uploadProfileIcon(t, user, body, ct)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})

	t.Run("unauthenticated request returns 401", func(t *testing.T) {
		img := image.NewRGBA(image.Rect(0, 0, 1, 1))
		pngData := encodePNG(t, img)
		body, ct := createMultipartImage(t, "file", "test.png", pngData)

		req, err := http.NewRequest(http.MethodPost, ts.HTTPServer.URL+"/api/v1/users/me/profile-icon", body)
		require.NoError(t, err)
		req.Header.Set("Content-Type", ct)

		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	})
}
