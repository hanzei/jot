package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/hanzei/keep/server/internal/auth"
	"github.com/hanzei/keep/server/internal/models"
	"github.com/hanzei/keep/server/internal/server"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type TestResponse struct {
	StatusCode int
	Body       []byte
	Headers    http.Header
}

func (r *TestResponse) UnmarshalBody(v any) error {
	return json.Unmarshal(r.Body, v)
}

func (r *TestResponse) GetString() string {
	return string(r.Body)
}

type TestUser struct {
	User  *models.User
	Token string
}

type TestServer struct {
	Server     *server.Server
	HTTPServer *httptest.Server
	TestUsers  map[string]*TestUser
}

func setupTestServer(t *testing.T) *TestServer {
	tmpDB := fmt.Sprintf("/tmp/test_%s.db", t.Name())
	os.Remove(tmpDB)

	os.Setenv("DB_PATH", tmpDB)
	os.Setenv("JWT_SECRET", "test-secret-key")

	s := server.New()
	httpServer := httptest.NewServer(s.GetRouter())

	ts := &TestServer{
		Server:     s,
		HTTPServer: httpServer,
		TestUsers:  make(map[string]*TestUser),
	}

	t.Cleanup(func() {
		httpServer.Close()
		ts.Server.GetDB().Close()
		os.Remove(tmpDB)
	})

	return ts
}

func (ts *TestServer) createTestUser(t *testing.T, email, password string, isAdmin bool) *TestUser {
	userStore := models.NewUserStore(ts.Server.GetDB().DB)

	var user *models.User
	var err error

	if isAdmin {
		user, err = userStore.CreateByAdmin(email, password, isAdmin)
	} else {
		user, err = userStore.Create(email, password)
	}
	require.NoError(t, err)

	tokenService := auth.NewTokenService("test-secret-key")
	token, err := tokenService.GenerateToken(user.ID, user.Email, user.IsAdmin)
	require.NoError(t, err)

	testUser := &TestUser{
		User:  user,
		Token: token,
	}

	ts.TestUsers[email] = testUser
	return testUser
}

func (ts *TestServer) request(t *testing.T, method, path string, body any, headers map[string]string) *TestResponse {
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

	for key, value := range headers {
		req.Header.Set(key, value)
	}

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	require.NoError(t, err, "Failed to read response body")

	return &TestResponse{
		StatusCode: resp.StatusCode,
		Body:       respBody,
		Headers:    resp.Header,
	}
}

func (ts *TestServer) authRequest(t *testing.T, user *TestUser, method, path string, body any) *TestResponse {
	headers := map[string]string{
		"Authorization": fmt.Sprintf("Bearer %s", user.Token),
	}
	return ts.request(t, method, path, body, headers)
}

// Health endpoint tests
func TestHealthEndpoint(t *testing.T) {
	ts := setupTestServer(t)

	resp := ts.request(t, http.MethodGet, "/health", nil, nil)

	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "OK", resp.GetString())
}

// Auth endpoint tests
func TestRegisterEndpoint(t *testing.T) {
	ts := setupTestServer(t)

	t.Run("valid registration", func(t *testing.T) {
		body := map[string]string{
			"email":    "test@example.com",
			"password": "password123",
		}

		resp := ts.request(t, http.MethodPost, "/api/v1/register", body, nil)
		assert.Equal(t, http.StatusCreated, resp.StatusCode)

		var response map[string]any
		require.NoError(t, resp.UnmarshalBody(&response))
		assert.NotNil(t, response["token"])
	})

	t.Run("duplicate email", func(t *testing.T) {
		body := map[string]string{
			"email":    "duplicate@example.com",
			"password": "password123",
		}

		ts.request(t, http.MethodPost, "/api/v1/register", body, nil)
		resp := ts.request(t, http.MethodPost, "/api/v1/register", body, nil)

		assert.Equal(t, http.StatusConflict, resp.StatusCode)
	})

	t.Run("invalid email", func(t *testing.T) {
		body := map[string]string{
			"email":    "invalid-email",
			"password": "password123",
		}

		resp := ts.request(t, http.MethodPost, "/api/v1/register", body, nil)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})
}

func TestLoginEndpoint(t *testing.T) {
	ts := setupTestServer(t)

	// Register a user first
	registerBody := map[string]string{
		"email":    "login@example.com",
		"password": "password123",
	}
	ts.request(t, http.MethodPost, "/api/v1/register", registerBody, nil)

	t.Run("valid login", func(t *testing.T) {
		body := map[string]string{
			"email":    "login@example.com",
			"password": "password123",
		}

		resp := ts.request(t, http.MethodPost, "/api/v1/login", body, nil)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var response map[string]any
		require.NoError(t, resp.UnmarshalBody(&response))
		assert.NotNil(t, response["token"])
	})

	t.Run("invalid credentials", func(t *testing.T) {
		body := map[string]string{
			"email":    "login@example.com",
			"password": "wrongpassword",
		}

		resp := ts.request(t, http.MethodPost, "/api/v1/login", body, nil)
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	})
}

// Notes endpoint tests
func TestNotesEndpoints(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "user@example.com", "password123", false)

	t.Run("unauthorized access", func(t *testing.T) {
		resp := ts.request(t, http.MethodGet, "/api/v1/notes", nil, nil)
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
	createResp.UnmarshalBody(&createdNote)
	noteID := int(createdNote["id"].(float64))

	t.Run("get specific note", func(t *testing.T) {
		resp := ts.authRequest(t, user, http.MethodGet, fmt.Sprintf("/api/v1/notes/%d", noteID), nil)
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

		resp := ts.authRequest(t, user, http.MethodPut, fmt.Sprintf("/api/v1/notes/%d", noteID), updateBody)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		var updatedNote map[string]any
		require.NoError(t, resp.UnmarshalBody(&updatedNote))

		assert.Equal(t, "Updated Title", updatedNote["title"])
	})

	t.Run("delete note", func(t *testing.T) {
		resp := ts.authRequest(t, user, http.MethodDelete, fmt.Sprintf("/api/v1/notes/%d", noteID), nil)
		assert.Equal(t, http.StatusNoContent, resp.StatusCode)

		// Verify note is deleted
		getResp := ts.authRequest(t, user, http.MethodGet, fmt.Sprintf("/api/v1/notes/%d", noteID), nil)
		assert.Equal(t, http.StatusNotFound, getResp.StatusCode)
	})
}

// Admin endpoint tests
func TestAdminEndpoints(t *testing.T) {
	ts := setupTestServer(t)
	admin := ts.createTestUser(t, "admin@example.com", "password123", true)
	user := ts.createTestUser(t, "user@example.com", "password123", false)

	t.Run("get users as admin", func(t *testing.T) {
		resp := ts.authRequest(t, admin, http.MethodGet, "/api/v1/admin/users", nil)
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
			"email":    "newuser@example.com",
			"password": "password123",
			"is_admin": false,
		}

		resp := ts.authRequest(t, admin, http.MethodPost, "/api/v1/admin/users", body)
		assert.Equal(t, http.StatusCreated, resp.StatusCode)

		var createdUser map[string]any
		require.NoError(t, resp.UnmarshalBody(&createdUser))

		assert.Equal(t, "newuser@example.com", createdUser["email"])
	})

	t.Run("create user as non-admin", func(t *testing.T) {
		body := map[string]any{
			"email":    "hacker@example.com",
			"password": "password123",
			"is_admin": true,
		}

		resp := ts.authRequest(t, user, http.MethodPost, "/api/v1/admin/users", body)
		assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	})
}
