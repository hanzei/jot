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

	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/server"
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
	}

	t.Cleanup(func() {
		httpServer.Close()
		ts.Server.GetDB().Close()
		os.Remove(tmpDB)
	})

	return ts
}

func (ts *TestServer) createTestUser(t *testing.T, username, password string, isAdmin bool) *TestUser {
	userStore := models.NewUserStore(ts.Server.GetDB().DB)
	var user *models.User
	var err error
	if isAdmin {
		user, err = userStore.CreateByAdmin(username, password, isAdmin)
	} else {
		user, err = userStore.Create(username, password)
	}

	tokenService := auth.NewTokenService("test-secret-key")
	token, err := tokenService.GenerateToken(user.ID, user.Username, user.IsAdmin)
	require.NoError(t, err)

	testUser := &TestUser{
		User:  user,
		Token: token,
	}

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
			"username": "testuser",
			"password": "password123",
		}

		resp := ts.request(t, http.MethodPost, "/api/v1/register", body, nil)
		assert.Equal(t, http.StatusCreated, resp.StatusCode)

		var response map[string]any
		require.NoError(t, resp.UnmarshalBody(&response))
		assert.NotNil(t, response["token"])
	})

	t.Run("duplicate username", func(t *testing.T) {
		body := map[string]string{
			"username": "duplicate",
			"password": "password123",
		}

		ts.request(t, http.MethodPost, "/api/v1/register", body, nil)
		resp := ts.request(t, http.MethodPost, "/api/v1/register", body, nil)

		assert.Equal(t, http.StatusConflict, resp.StatusCode)
	})

	t.Run("invalid username", func(t *testing.T) {
		body := map[string]string{
			"username": "x",
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
		"username": "loginuser",
		"password": "password123",
	}
	ts.request(t, http.MethodPost, "/api/v1/register", registerBody, nil)

	t.Run("valid login", func(t *testing.T) {
		body := map[string]string{
			"username": "loginuser",
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
			"username": "loginuser",
			"password": "wrongpassword",
		}

		resp := ts.request(t, http.MethodPost, "/api/v1/login", body, nil)
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	})
}

// Notes endpoint tests
func TestNotesEndpoints(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "user", "password123", false)

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
	admin := ts.createTestUser(t, "admin", "password123", true)
	user := ts.createTestUser(t, "user", "password123", false)

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
			"username": "newuser",
			"password": "password123",
			"is_admin": false,
		}

		resp := ts.authRequest(t, admin, http.MethodPost, "/api/v1/admin/users", body)
		assert.Equal(t, http.StatusCreated, resp.StatusCode)

		var createdUser map[string]any
		require.NoError(t, resp.UnmarshalBody(&createdUser))

		assert.Equal(t, "newuser", createdUser["username"])
	})

	t.Run("create user as non-admin", func(t *testing.T) {
		body := map[string]any{
			"username": "hacker",
			"password": "password123",
			"is_admin": true,
		}

		resp := ts.authRequest(t, user, http.MethodPost, "/api/v1/admin/users", body)
		assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	})
}

// Test checked items functionality
func TestCheckedItemsFunctionality(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "user@example.com", "password123", false)

	t.Run("create todo note with items", func(t *testing.T) {
		body := map[string]any{
			"title":     "Test Todo",
			"content":   "Todo list",
			"note_type": "todo",
			"items": []map[string]any{
				{"text": "Item 1", "position": 0},
				{"text": "Item 2", "position": 1},
				{"text": "Item 3", "position": 2},
			},
		}

		resp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", body)
		assert.Equal(t, http.StatusCreated, resp.StatusCode)

		var note map[string]any
		require.NoError(t, resp.UnmarshalBody(&note))
		
		items := note["items"].([]any)
		assert.Len(t, items, 3)
		assert.Equal(t, "Item 1", items[0].(map[string]any)["text"])
		assert.Equal(t, false, items[0].(map[string]any)["completed"])
	})

	// Create a todo note for further tests
	createBody := map[string]any{
		"title":     "Position Test Todo",
		"content":   "Testing position restoration",
		"note_type": "todo",
		"items": []map[string]any{
			{"text": "First item", "position": 0},
			{"text": "Second item", "position": 1},
			{"text": "Third item", "position": 2},
		},
	}
	createResp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", createBody)
	var createdNote map[string]any
	createResp.UnmarshalBody(&createdNote)
	noteID := int(createdNote["id"].(float64))

	t.Run("update note with checked items", func(t *testing.T) {
		updateBody := map[string]any{
			"title":    "Position Test Todo",
			"content":  "Testing position restoration",
			"pinned":   false,
			"archived": false,
			"color":    "#ffffff",
			"items": []map[string]any{
				{"text": "First item", "position": 0, "completed": false},
				{"text": "Second item", "position": 1, "completed": true, "original_position": 1},
				{"text": "Third item", "position": 2, "completed": false},
			},
		}

		resp := ts.authRequest(t, user, http.MethodPut, fmt.Sprintf("/api/v1/notes/%d", noteID), updateBody)
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		// Get the updated note to verify changes
		getResp := ts.authRequest(t, user, http.MethodGet, fmt.Sprintf("/api/v1/notes/%d", noteID), nil)
		var updatedNote map[string]any
		require.NoError(t, getResp.UnmarshalBody(&updatedNote))
		
		items := updatedNote["items"].([]any)
		assert.Len(t, items, 3)
		
		// Find the second item and check it's marked as completed
		var secondItem map[string]any
		for _, item := range items {
			if item.(map[string]any)["text"] == "Second item" {
				secondItem = item.(map[string]any)
				break
			}
		}
		assert.NotNil(t, secondItem)
		assert.Equal(t, true, secondItem["completed"])
		assert.Equal(t, float64(1), secondItem["original_position"])
	})

	t.Run("update checked items collapsed state", func(t *testing.T) {
		resp := ts.authRequest(t, user, http.MethodPut, fmt.Sprintf("/api/v1/notes/%d/checked-items-collapsed", noteID), map[string]bool{"collapsed": false})
		assert.Equal(t, http.StatusOK, resp.StatusCode)

		// Verify the state was updated
		getResp := ts.authRequest(t, user, http.MethodGet, fmt.Sprintf("/api/v1/notes/%d", noteID), nil)
		var note map[string]any
		require.NoError(t, getResp.UnmarshalBody(&note))
		
		assert.Equal(t, false, note["checked_items_collapsed"])
	})
}

// Test UpdateItem method with optional original_position parameter
func TestUpdateItemMethods(t *testing.T) {
	ts := setupTestServer(t)
	
	noteStore := models.NewNoteStore(ts.Server.GetDB().DB)
	
	// Create a test note
	note, err := noteStore.Create("test-user", "Test Note", "Test Content", models.NoteTypeTodo, "#ffffff")
	require.NoError(t, err)
	
	// Create a test item
	item, err := noteStore.CreateItem(note.ID, "Test Item", 0)
	require.NoError(t, err)
	
	t.Run("UpdateItem without original_position", func(t *testing.T) {
		err := noteStore.UpdateItem(item.ID, "Updated Item", true, 0)
		assert.NoError(t, err)
		
		// Verify the update
		items, err := noteStore.getItemsByNoteID(note.ID)
		require.NoError(t, err)
		assert.Len(t, items, 1)
		assert.Equal(t, "Updated Item", items[0].Text)
		assert.Equal(t, true, items[0].Completed)
		assert.Nil(t, items[0].OriginalPosition)
	})
	
	t.Run("UpdateItem with original_position", func(t *testing.T) {
		originalPos := 5
		err := noteStore.UpdateItem(item.ID, "Updated Item 2", false, 1, &originalPos)
		assert.NoError(t, err)
		
		// Verify the update
		items, err := noteStore.getItemsByNoteID(note.ID)
		require.NoError(t, err)
		assert.Len(t, items, 1)
		assert.Equal(t, "Updated Item 2", items[0].Text)
		assert.Equal(t, false, items[0].Completed)
		assert.Equal(t, 1, items[0].Position)
		assert.NotNil(t, items[0].OriginalPosition)
		assert.Equal(t, 5, *items[0].OriginalPosition)
	})
	
	t.Run("UpdateItemWithOriginalPosition delegates correctly", func(t *testing.T) {
		originalPos := 3
		err := noteStore.UpdateItemWithOriginalPosition(item.ID, "Final Update", true, 2, &originalPos)
		assert.NoError(t, err)
		
		// Verify the update
		items, err := noteStore.getItemsByNoteID(note.ID)
		require.NoError(t, err)
		assert.Len(t, items, 1)
		assert.Equal(t, "Final Update", items[0].Text)
		assert.Equal(t, true, items[0].Completed)
		assert.Equal(t, 2, items[0].Position)
		assert.NotNil(t, items[0].OriginalPosition)
		assert.Equal(t, 3, *items[0].OriginalPosition)
	})
}
