package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/config"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/server"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"
)

// TestUser bundles a user model with a typed API client.
type TestUser struct {
	User   *client.User
	Client *client.Client
}

// TestServer wraps a test HTTP server with helpers for creating users.
type TestServer struct {
	Server     *server.Server
	HTTPServer *httptest.Server
}

func defaultTestConfig(tmpDir string) *config.Config {
	return &config.Config{
		Port:                0,
		DBPath:              tmpDir + "/test.db",
		StaticDir:           tmpDir,
		CORSAllowedOrigin:   "http://localhost:5173",
		CookieSecure:        false,
		RegistrationEnabled: true,
	}
}

func setupTestServer(t *testing.T) *TestServer {
	t.Helper()
	return setupTestServerWithConfig(t, nil)
}

func setupTestServerWithConfig(t *testing.T, customize func(*config.Config)) *TestServer {
	t.Helper()

	tmpDir := t.TempDir()
	require.NoError(t, os.WriteFile(tmpDir+"/index.html", []byte("<html><body>jot test app</body></html>"), 0o600))

	cfg := defaultTestConfig(tmpDir)
	if customize != nil {
		customize(cfg)
	}

	s, err := server.New(cfg)
	require.NoError(t, err)

	httpServer := httptest.NewServer(s.GetRouter())

	ts := &TestServer{
		Server:     s,
		HTTPServer: httpServer,
	}

	t.Cleanup(func() {
		httpServer.Close()
		_ = ts.Server.GetDB().Close()
	})

	return ts
}

// newClient creates a new [client.Client] pointed at the test server.
func (ts *TestServer) newClient() *client.Client {
	return client.New(ts.HTTPServer.URL)
}

func (ts *TestServer) createTestUser(t *testing.T, username, password string, isAdmin bool) *TestUser {
	t.Helper()

	c := ts.newClient()
	auth, err := c.Register(t.Context(), username, password)
	require.NoError(t, err)

	if isAdmin {
		_, err = ts.Server.GetDB().Exec("UPDATE users SET role = ? WHERE id = ?", models.RoleAdmin, auth.User.ID)
		require.NoError(t, err)
		auth.User.Role = client.RoleAdmin
	}

	return &TestUser{
		User:   auth.User,
		Client: c,
	}
}

// Probe endpoint tests
func TestProbeEndpoints(t *testing.T) {
	ts := setupTestServer(t)
	c := ts.newClient()

	t.Run("unknown api route still returns not found", func(t *testing.T) {
		req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/nonexistent", nil)
		resp, err := c.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	})

	t.Run("unknown api namespace returns not found", func(t *testing.T) {
		req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v2/nonexistent", nil)
		resp, err := c.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	})

	t.Run("bare api path returns not found", func(t *testing.T) {
		req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api", nil)
		resp, err := c.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	})

	t.Run("livez endpoint", func(t *testing.T) {
		req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/livez", nil)
		resp, err := c.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		assert.Equal(t, http.StatusOK, resp.StatusCode)
		assert.Equal(t, "OK", string(body))
	})

	t.Run("readyz endpoint", func(t *testing.T) {
		req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/readyz", nil)
		resp, err := c.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		assert.Equal(t, http.StatusOK, resp.StatusCode)
		assert.Equal(t, "OK", string(body))
	})

	t.Run("readyz returns 503 when shutting down", func(t *testing.T) {
		ts.Server.BeginShutdown()
		req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/readyz", nil)
		resp, err := c.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		assert.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)
		assert.Contains(t, string(body), "NOT READY")
	})

	t.Run("readyz returns 503 when database is unavailable", func(t *testing.T) {
		tsWithClosedDB := setupTestServer(t)
		require.NoError(t, tsWithClosedDB.Server.GetDB().Close())

		req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, tsWithClosedDB.HTTPServer.URL+"/readyz", nil)
		resp, err := tsWithClosedDB.newClient().HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		assert.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)
		assert.Contains(t, string(body), "NOT READY")
	})
}

func TestConfigEndpoint(t *testing.T) {
	t.Run("returns registration_enabled true by default", func(t *testing.T) {
		ts := setupTestServer(t)
		c := ts.newClient()

		cfg, err := c.Config(t.Context())
		require.NoError(t, err)
		assert.True(t, cfg.RegistrationEnabled)
	})

	t.Run("returns registration_enabled false when disabled", func(t *testing.T) {
		ts := setupTestServerWithConfig(t, func(cfg *config.Config) {
			cfg.RegistrationEnabled = false
		})
		c := ts.newClient()

		cfg, err := c.Config(t.Context())
		require.NoError(t, err)
		assert.False(t, cfg.RegistrationEnabled)
	})

	t.Run("does not require authentication", func(t *testing.T) {
		ts := setupTestServer(t)
		c := ts.newClient()

		cfg, err := c.Config(t.Context())
		require.NoError(t, err)
		assert.True(t, cfg.RegistrationEnabled)
	})
}

// Auth endpoint tests
func TestRegisterEndpoint(t *testing.T) {
	ts := setupTestServer(t)

	t.Run("valid registration", func(t *testing.T) {
		c := ts.newClient()
		auth, err := c.Register(t.Context(), "testuser", "password123")
		require.NoError(t, err)
		assert.NotNil(t, auth.User)
	})

	t.Run("duplicate username", func(t *testing.T) {
		c1 := ts.newClient()
		_, err := c1.Register(t.Context(), "duplicate", "password123")
		require.NoError(t, err)

		c2 := ts.newClient()
		_, err = c2.Register(t.Context(), "duplicate", "password123")
		assert.Equal(t, http.StatusConflict, client.StatusCode(err))
	})

	t.Run("invalid username", func(t *testing.T) {
		c := ts.newClient()
		_, err := c.Register(t.Context(), "x", "password123")
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})
}

func TestRegisterDisabled(t *testing.T) {
	ts := setupTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.RegistrationEnabled = false
	})

	t.Run("registration returns 403", func(t *testing.T) {
		c := ts.newClient()
		_, err := c.Register(t.Context(), "newuser", "password123")
		require.Error(t, err)
		assert.Equal(t, http.StatusForbidden, client.StatusCode(err))
	})

	t.Run("admin can still create users", func(t *testing.T) {
		db := ts.Server.GetDB()

		hash, err := bcrypt.GenerateFromPassword([]byte("adminpass"), bcrypt.DefaultCost)
		require.NoError(t, err)
		_, err = db.Exec(
			"INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)",
			"admin-test-id", "seedadmin", string(hash), "admin",
		)
		require.NoError(t, err)

		adminClient := ts.newClient()
		_, err = adminClient.Login(t.Context(), "seedadmin", "adminpass")
		require.NoError(t, err)

		created, err := adminClient.AdminCreateUser(t.Context(), "adminmade", "password123", client.RoleUser)
		require.NoError(t, err)
		assert.Equal(t, "adminmade", created.Username)
	})
}

func TestLoginEndpoint(t *testing.T) {
	ts := setupTestServer(t)

	c := ts.newClient()
	_, err := c.Register(t.Context(), "loginuser", "password123")
	require.NoError(t, err)

	t.Run("valid login", func(t *testing.T) {
		loginClient := ts.newClient()
		auth, err := loginClient.Login(t.Context(), "loginuser", "password123")
		require.NoError(t, err)
		assert.NotNil(t, auth.User)

		me, err := loginClient.Me(t.Context())
		require.NoError(t, err)
		assert.Equal(t, auth.User.ID, me.User.ID)
	})

	t.Run("invalid credentials", func(t *testing.T) {
		loginClient := ts.newClient()
		_, err := loginClient.Login(t.Context(), "loginuser", "wrongpassword")
		assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
	})
}

func TestLogoutEndpoint(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "logoutuser", "password123", false)

	_, err := user.Client.Me(t.Context())
	require.NoError(t, err)

	require.NoError(t, user.Client.Logout(t.Context()))

	_, err = user.Client.Me(t.Context())
	assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
}

// Notes endpoint tests
func TestNotesEndpoints(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "user", "password123", false)

	t.Run("unauthorized access", func(t *testing.T) {
		c := ts.newClient()
		_, err := c.ListNotes(t.Context(), nil)
		assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
	})

	t.Run("get empty notes list", func(t *testing.T) {
		notes, err := user.Client.ListNotes(t.Context(), nil)
		require.NoError(t, err)
		assert.Empty(t, notes)
	})

	t.Run("create note", func(t *testing.T) {
		note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title:    "Test Note",
			Content:  "This is a test note",
			NoteType: client.NoteTypeText,
			Color:    "#ffeb3b",
		})
		require.NoError(t, err)
		assert.Equal(t, "Test Note", note.Title)
	})

	created, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
		Title:   "Test Note",
		Content: "Test Content",
	})
	require.NoError(t, err)

	t.Run("get specific note", func(t *testing.T) {
		note, err := user.Client.GetNote(t.Context(), created.ID)
		require.NoError(t, err)
		assert.Equal(t, "Test Note", note.Title)
	})

	t.Run("update note", func(t *testing.T) {
		updated, err := user.Client.UpdateNote(t.Context(), created.ID, &client.UpdateNoteRequest{
			Title:   client.Ptr("Updated Title"),
			Content: client.Ptr("Updated Content"),
			Pinned:  client.Ptr(true),
			Color:   client.Ptr("#ff0000"),
		})
		require.NoError(t, err)
		assert.Equal(t, "Updated Title", updated.Title)
	})

	t.Run("delete note", func(t *testing.T) {
		require.NoError(t, user.Client.DeleteNote(t.Context(), created.ID))

		_, err := user.Client.GetNote(t.Context(), created.ID)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
	})
}

// Admin endpoint tests
func TestAdminEndpoints(t *testing.T) {
	ts := setupTestServer(t)
	adminUser := ts.createTestUser(t, "admin", "password123", true)
	user := ts.createTestUser(t, "user", "password123", false)

	t.Run("get users as admin", func(t *testing.T) {
		users, err := adminUser.Client.AdminListUsers(t.Context())
		require.NoError(t, err)
		assert.Len(t, users, 2)
	})

	t.Run("get users as non-admin", func(t *testing.T) {
		_, err := user.Client.AdminListUsers(t.Context())
		assert.Equal(t, http.StatusForbidden, client.StatusCode(err))
	})

	t.Run("create user as admin", func(t *testing.T) {
		created, err := adminUser.Client.AdminCreateUser(t.Context(), "newuser", "password123", client.RoleUser)
		require.NoError(t, err)
		assert.Equal(t, "newuser", created.Username)
	})

	t.Run("create user as non-admin", func(t *testing.T) {
		_, err := user.Client.AdminCreateUser(t.Context(), "hacker", "password123", client.RoleAdmin)
		assert.Equal(t, http.StatusForbidden, client.StatusCode(err))
	})

	t.Run("delete user as admin", func(t *testing.T) {
		deleteTarget := ts.createTestUser(t, "todelete", "password123", false)
		require.NoError(t, adminUser.Client.AdminDeleteUser(t.Context(), deleteTarget.User.ID))

		users, err := adminUser.Client.AdminListUsers(t.Context())
		require.NoError(t, err)
		for _, u := range users {
			assert.NotEqual(t, deleteTarget.User.ID, u.ID)
		}
	})

	t.Run("delete user as non-admin returns 403", func(t *testing.T) {
		deleteTarget := ts.createTestUser(t, "todelete2", "password123", false)
		err := user.Client.AdminDeleteUser(t.Context(), deleteTarget.User.ID)
		assert.Equal(t, http.StatusForbidden, client.StatusCode(err))
	})

	t.Run("admin cannot delete themselves", func(t *testing.T) {
		err := adminUser.Client.AdminDeleteUser(t.Context(), adminUser.User.ID)
		assert.Equal(t, http.StatusForbidden, client.StatusCode(err))
	})

	t.Run("delete nonexistent user returns 404", func(t *testing.T) {
		err := adminUser.Client.AdminDeleteUser(t.Context(), "nonexistentid12345678")
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
	})
}

func TestDeleteUserAdminCanDeleteOtherAdmin(t *testing.T) {
	ts := setupTestServer(t)
	admin1 := ts.createTestUser(t, "admin1", "password123", true)
	admin2 := ts.createTestUser(t, "admin2", "password123", true)

	require.NoError(t, admin1.Client.AdminDeleteUser(t.Context(), admin2.User.ID))
}

func TestAdminStatsEndpoint(t *testing.T) {
	var dbPath string
	ts := setupTestServerWithConfig(t, func(cfg *config.Config) {
		dbPath = cfg.DBPath
	})

	adminUser := ts.createTestUser(t, "adminstats", "password123", true)
	member1 := ts.createTestUser(t, "memberstats1", "password123", false)
	member2 := ts.createTestUser(t, "memberstats2", "password123", false)

	sharedTextNote, err := adminUser.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
		Title:    "Shared text note",
		Content:  "shared content",
		NoteType: client.NoteTypeText,
	})
	require.NoError(t, err)

	archivedTodoNote, err := adminUser.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
		Title:    "Archived todo note",
		NoteType: client.NoteTypeTodo,
		Items: []client.CreateNoteItem{
			{Text: "First todo", Position: 0},
			{Text: "Second todo", Position: 1},
		},
	})
	require.NoError(t, err)

	activeTodoNote, err := adminUser.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
		Title:    "Active todo note",
		NoteType: client.NoteTypeTodo,
		Items: []client.CreateNoteItem{
			{Text: "Assigned todo", Position: 0},
		},
	})
	require.NoError(t, err)

	trashedTextNote, err := adminUser.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
		Title:    "Trashed text note",
		Content:  "trashed content",
		NoteType: client.NoteTypeText,
	})
	require.NoError(t, err)

	require.NoError(t, adminUser.Client.ShareNote(t.Context(), archivedTodoNote.ID, member1.User.ID))
	require.NoError(t, adminUser.Client.ShareNote(t.Context(), activeTodoNote.ID, member2.User.ID))

	archived := true
	_, err = adminUser.Client.UpdateNote(t.Context(), archivedTodoNote.ID, &client.UpdateNoteRequest{
		Archived: &archived,
		Items: []client.UpdateNoteItem{
			{Text: "First todo", Position: 0, Completed: true, AssignedTo: member1.User.ID},
			{Text: "Second todo", Position: 1, Completed: false, AssignedTo: ""},
		},
	})
	require.NoError(t, err)

	_, err = adminUser.Client.UpdateNote(t.Context(), activeTodoNote.ID, &client.UpdateNoteRequest{
		Items: []client.UpdateNoteItem{
			{Text: "Assigned todo", Position: 0, Completed: false, AssignedTo: member2.User.ID},
		},
	})
	require.NoError(t, err)

	require.NoError(t, adminUser.Client.DeleteNote(t.Context(), trashedTextNote.ID))
	require.NoError(t, adminUser.Client.ShareNote(t.Context(), sharedTextNote.ID, member1.User.ID))
	require.NoError(t, adminUser.Client.ShareNote(t.Context(), sharedTextNote.ID, member2.User.ID))

	_, err = adminUser.Client.AddLabel(t.Context(), sharedTextNote.ID, "work")
	require.NoError(t, err)
	_, err = adminUser.Client.AddLabel(t.Context(), sharedTextNote.ID, "urgent")
	require.NoError(t, err)
	_, err = adminUser.Client.AddLabel(t.Context(), archivedTodoNote.ID, "work")
	require.NoError(t, err)

	t.Run("returns aggregated stats for admins", func(t *testing.T) {
		stats, err := adminUser.Client.AdminGetStats(t.Context())
		require.NoError(t, err)

		assert.Equal(t, int64(3), stats.Users.Total)
		assert.Equal(t, int64(4), stats.Notes.Total)
		assert.Equal(t, int64(2), stats.Notes.Text)
		assert.Equal(t, int64(2), stats.Notes.Todo)
		assert.Equal(t, int64(1), stats.Notes.Trashed)
		assert.Equal(t, int64(1), stats.Notes.Archived)

		assert.Equal(t, int64(3), stats.Sharing.SharedNotes)
		assert.Equal(t, int64(4), stats.Sharing.ShareLinks)

		assert.Equal(t, int64(2), stats.Labels.Total)
		assert.Equal(t, int64(3), stats.Labels.NoteAssociations)

		assert.Equal(t, int64(3), stats.TodoItems.Total)
		assert.Equal(t, int64(1), stats.TodoItems.Completed)
		assert.Equal(t, int64(2), stats.TodoItems.Assigned)

		fileInfo, err := os.Stat(dbPath)
		require.NoError(t, err)
		assert.Equal(t, fileInfo.Size(), stats.Storage.DatabaseSizeBytes)
		assert.Positive(t, stats.Storage.DatabaseSizeBytes)
	})

	t.Run("returns 403 for non-admin users", func(t *testing.T) {
		_, err := member1.Client.AdminGetStats(t.Context())
		assert.Equal(t, http.StatusForbidden, client.StatusCode(err))
	})

	t.Run("returns 401 for unauthenticated requests", func(t *testing.T) {
		_, err := ts.newClient().AdminGetStats(t.Context())
		assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
	})
}

func TestUpdateUserEndpoint(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "originaluser", "password123", false)
	other := ts.createTestUser(t, "otheruser", "password123", false)

	t.Run("successful username update", func(t *testing.T) {
		t.Cleanup(func() {
			// t.Context() is already canceled when cleanup runs; use a fresh context.
			_, err := user.Client.UpdateUser(context.Background(), &client.UpdateUserRequest{Username: client.Ptr("originaluser")})
			require.NoError(t, err)
		})

		resp, err := user.Client.UpdateUser(t.Context(), &client.UpdateUserRequest{Username: client.Ptr("newusername")})
		require.NoError(t, err)
		assert.Equal(t, "newusername", resp.User.Username)
		assert.NotNil(t, resp.Settings)
	})

	t.Run("duplicate username returns 409", func(t *testing.T) {
		_, err := user.Client.UpdateUser(t.Context(), &client.UpdateUserRequest{Username: &other.User.Username})
		assert.Equal(t, http.StatusConflict, client.StatusCode(err))
	})

	t.Run("invalid username format returns 400", func(t *testing.T) {
		_, err := user.Client.UpdateUser(t.Context(), &client.UpdateUserRequest{Username: client.Ptr("a")})
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("unauthenticated request returns 401", func(t *testing.T) {
		c := ts.newClient()
		_, err := c.UpdateUser(t.Context(), &client.UpdateUserRequest{Username: client.Ptr("hacker")})
		assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
	})

	t.Run("partial update preserves unchanged fields", func(t *testing.T) {
		resp, err := user.Client.UpdateUser(t.Context(), &client.UpdateUserRequest{FirstName: client.Ptr("Updated")})
		require.NoError(t, err)
		assert.Equal(t, "Updated", resp.User.FirstName)
		assert.Equal(t, "originaluser", resp.User.Username)
	})

	t.Run("empty body updates nothing and returns current state", func(t *testing.T) {
		resp, err := user.Client.UpdateUser(t.Context(), &client.UpdateUserRequest{})
		require.NoError(t, err)
		assert.Equal(t, "originaluser", resp.User.Username)
		assert.NotNil(t, resp.Settings)
	})
}

// SSE endpoint tests

func TestSSEEndpoint(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "sseuser", "password123", false)

	t.Run("unauthenticated returns 401", func(t *testing.T) {
		c := ts.newClient()
		req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/events", nil)
		resp, err := c.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	})

	t.Run("authenticated receives SSE headers and connected comment", func(t *testing.T) {
		sseCtx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
		defer cancel()

		req, err := http.NewRequestWithContext(sseCtx, http.MethodGet, ts.HTTPServer.URL+"/api/v1/events", nil)
		require.NoError(t, err)

		resp, err := user.Client.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()

		assert.Equal(t, http.StatusOK, resp.StatusCode)
		assert.Equal(t, "text/event-stream", resp.Header.Get("Content-Type"))
		assert.Equal(t, "no-cache", resp.Header.Get("Cache-Control"))

		scanner := bufio.NewScanner(resp.Body)
		require.True(t, scanner.Scan(), "expected first line from SSE stream")
		assert.Equal(t, ": connected", scanner.Text())
	})

	t.Run("note creation triggers note_created event", func(t *testing.T) {
		sseCtx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()

		req, err := http.NewRequestWithContext(sseCtx, http.MethodGet, ts.HTTPServer.URL+"/api/v1/events", nil)
		require.NoError(t, err)

		resp, err := user.Client.HTTPClient().Do(req) //nolint:bodyclose // closed on next line
		require.NoError(t, err)
		defer resp.Body.Close()

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

		select {
		case <-connectedCh:
		case <-sseCtx.Done():
			t.Fatal("timed out waiting for SSE connection")
		}

		note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title:    "SSE Test Note",
			Content:  "test content",
			NoteType: client.NoteTypeText,
		})
		require.NoError(t, err)

		select {
		case event := <-eventCh:
			assert.Equal(t, "note_created", event["type"])
			assert.Equal(t, user.User.ID, event["source_user_id"])
			assert.Equal(t, note.ID, event["note_id"])
		case <-sseCtx.Done():
			t.Fatal("timed out waiting for SSE event after note creation")
		}
	})
}

func TestChangePasswordEndpoint(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "passuser", "oldpassword", false)

	t.Run("successful password change", func(t *testing.T) {
		require.NoError(t, user.Client.ChangePassword(t.Context(), "oldpassword", "newpassword"))

		_, err := user.Client.Login(t.Context(), "passuser", "newpassword")
		require.NoError(t, err)
	})

	t.Run("wrong current password returns 403", func(t *testing.T) {
		err := user.Client.ChangePassword(t.Context(), "wrongpassword", "anotherpass")
		assert.Equal(t, http.StatusForbidden, client.StatusCode(err))
	})

	t.Run("short new password returns 400", func(t *testing.T) {
		err := user.Client.ChangePassword(t.Context(), "newpassword", "ab")
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("missing fields returns 400", func(t *testing.T) {
		err := user.Client.ChangePassword(t.Context(), "", "")
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("unauthenticated request returns 401", func(t *testing.T) {
		c := ts.newClient()
		err := c.ChangePassword(t.Context(), "newpassword", "hacked")
		assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
	})
}

func TestUserSettingsEndpoints(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "settingsuser", "password123", false)

	t.Run("me response includes default settings for new user", func(t *testing.T) {
		me, err := user.Client.Me(t.Context())
		require.NoError(t, err)
		assert.Equal(t, "system", me.Settings.Language)
		assert.Equal(t, user.User.ID, me.Settings.UserID)
	})

	t.Run("PATCH /users/me updates language via unified endpoint", func(t *testing.T) {
		resp, err := user.Client.UpdateUser(t.Context(), &client.UpdateUserRequest{Language: client.Ptr("de")})
		require.NoError(t, err)
		assert.Equal(t, "de", resp.Settings.Language)
	})

	t.Run("PATCH /users/me accepts phase-1 languages", func(t *testing.T) {
		resp, err := user.Client.UpdateUser(t.Context(), &client.UpdateUserRequest{Language: client.Ptr("fr")})
		require.NoError(t, err)
		assert.Equal(t, "fr", resp.Settings.Language)
	})

	t.Run("me response reflects updated language", func(t *testing.T) {
		me, err := user.Client.Me(t.Context())
		require.NoError(t, err)
		assert.Equal(t, "fr", me.Settings.Language)
	})

	t.Run("PATCH /users/me with invalid language returns 400", func(t *testing.T) {
		_, err := user.Client.UpdateUser(t.Context(), &client.UpdateUserRequest{Language: client.Ptr("sv")})
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("invalid settings with valid profile does not commit profile (atomic validation)", func(t *testing.T) {
		_, err := user.Client.UpdateUser(t.Context(), &client.UpdateUserRequest{
			FirstName: client.Ptr("ShouldNotPersist"),
			Language:  client.Ptr("invalid"),
		})
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))

		me, err := user.Client.Me(t.Context())
		require.NoError(t, err)
		assert.NotEqual(t, "ShouldNotPersist", me.User.FirstName)
	})

	t.Run("PATCH /users/me updates both profile and settings", func(t *testing.T) {
		resp, err := user.Client.UpdateUser(t.Context(), &client.UpdateUserRequest{
			FirstName: client.Ptr("Jane"),
			Theme:     client.Ptr("dark"),
		})
		require.NoError(t, err)
		assert.Equal(t, "Jane", resp.User.FirstName)
		assert.Equal(t, "dark", resp.Settings.Theme)
		assert.Equal(t, "fr", resp.Settings.Language)
	})

	t.Run("me response includes settings", func(t *testing.T) {
		me, err := user.Client.Me(t.Context())
		require.NoError(t, err)
		assert.NotNil(t, me.Settings)
	})

	t.Run("login response includes settings", func(t *testing.T) {
		loginClient := ts.newClient()
		auth, err := loginClient.Login(t.Context(), "settingsuser", "password123")
		require.NoError(t, err)
		assert.NotNil(t, auth.Settings)
		assert.Equal(t, "fr", auth.Settings.Language)
	})

	t.Run("register response includes settings", func(t *testing.T) {
		regClient := ts.newClient()
		auth, err := regClient.Register(t.Context(), "newsettings", "password123")
		require.NoError(t, err)
		assert.NotNil(t, auth.Settings)
		assert.Equal(t, "system", auth.Settings.Language)
	})
}

func TestTodoItemIndentLevel(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "indentuser", "password123", false)

	created, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
		Title:    "Indent Test",
		NoteType: client.NoteTypeTodo,
		Items: []client.CreateNoteItem{
			{Text: "top level", Position: 0, IndentLevel: 0},
			{Text: "indented once", Position: 1, IndentLevel: 1},
			{Text: "also indented", Position: 2, IndentLevel: 1},
		},
	})
	require.NoError(t, err)

	t.Run("indent levels persisted on create", func(t *testing.T) {
		note, err := user.Client.GetNote(t.Context(), created.ID)
		require.NoError(t, err)
		require.Len(t, note.Items, 3)
		assert.Equal(t, 0, note.Items[0].IndentLevel)
		assert.Equal(t, 1, note.Items[1].IndentLevel)
		assert.Equal(t, 1, note.Items[2].IndentLevel)
	})

	t.Run("indent levels updated via PATCH", func(t *testing.T) {
		_, err := user.Client.UpdateNote(t.Context(), created.ID, &client.UpdateNoteRequest{
			Title: client.Ptr("Indent Test"),
			Color: client.Ptr("#ffffff"),
			Items: []client.UpdateNoteItem{
				{Text: "top level", Position: 0, IndentLevel: 0},
				{Text: "indented once", Position: 1, IndentLevel: 1},
				{Text: "promoted to top", Position: 2, IndentLevel: 0},
			},
		})
		require.NoError(t, err)

		note, err := user.Client.GetNote(t.Context(), created.ID)
		require.NoError(t, err)
		require.Len(t, note.Items, 3)
		assert.Equal(t, 0, note.Items[0].IndentLevel)
		assert.Equal(t, 1, note.Items[1].IndentLevel)
		assert.Equal(t, 0, note.Items[2].IndentLevel)
	})

	t.Run("indent level defaults to 0 when omitted", func(t *testing.T) {
		note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title:    "No Indent",
			NoteType: client.NoteTypeTodo,
			Items: []client.CreateNoteItem{
				{Text: "item without indent_level", Position: 0},
			},
		})
		require.NoError(t, err)
		require.Len(t, note.Items, 1)
		assert.Equal(t, 0, note.Items[0].IndentLevel)
	})

	t.Run("indent level > 1 rejected on create", func(t *testing.T) {
		_, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title:    "Bad Indent",
			NoteType: client.NoteTypeTodo,
			Items: []client.CreateNoteItem{
				{Text: "too deep", Position: 0, IndentLevel: 2},
			},
		})
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("indent level > 1 rejected on update", func(t *testing.T) {
		_, err := user.Client.UpdateNote(t.Context(), created.ID, &client.UpdateNoteRequest{
			Title: client.Ptr("Indent Test"),
			Color: client.Ptr("#ffffff"),
			Items: []client.UpdateNoteItem{
				{Text: "top level", Position: 0, IndentLevel: 0},
				{Text: "too deep", Position: 1, IndentLevel: 2},
			},
		})
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
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
		u, err := user.Client.UploadProfileIcon(t.Context(), "test.png", bytes.NewReader(pngData))
		require.NoError(t, err)
		assert.True(t, u.HasProfileIcon)
	})

	t.Run("transparent PNG pixels are flattened to white", func(t *testing.T) {
		img := image.NewNRGBA(image.Rect(0, 0, 4, 4))
		pngData := encodePNG(t, img)
		_, err := user.Client.UploadProfileIcon(t.Context(), "transparent.png", bytes.NewReader(pngData))
		require.NoError(t, err)

		body, _, err := user.Client.GetProfileIcon(t.Context(), user.User.ID)
		require.NoError(t, err)

		decoded, err := jpeg.Decode(bytes.NewReader(body))
		require.NoError(t, err)
		r, g, b, _ := decoded.At(0, 0).RGBA()
		assert.InDelta(t, 0xFFFF, r, 256, "red channel should be white")
		assert.InDelta(t, 0xFFFF, g, 256, "green channel should be white")
		assert.InDelta(t, 0xFFFF, b, 256, "blue channel should be white")
	})

	t.Run("stored image is JPEG", func(t *testing.T) {
		img := image.NewRGBA(image.Rect(0, 0, 8, 8))
		pngData := encodePNG(t, img)
		_, err := user.Client.UploadProfileIcon(t.Context(), "test.png", bytes.NewReader(pngData))
		require.NoError(t, err)

		body, contentType, err := user.Client.GetProfileIcon(t.Context(), user.User.ID)
		require.NoError(t, err)
		assert.Equal(t, "image/jpeg", contentType)
		require.GreaterOrEqual(t, len(body), 2)
		assert.Equal(t, byte(0xFF), body[0], "JPEG magic byte 1")
		assert.Equal(t, byte(0xD8), body[1], "JPEG magic byte 2")
	})

	t.Run("oversized image is scaled down to fit 256x256", func(t *testing.T) {
		img := image.NewRGBA(image.Rect(0, 0, 1024, 512))
		pngData := encodePNG(t, img)
		_, err := user.Client.UploadProfileIcon(t.Context(), "big.png", bytes.NewReader(pngData))
		require.NoError(t, err)

		body, _, err := user.Client.GetProfileIcon(t.Context(), user.User.ID)
		require.NoError(t, err)

		decoded, err := jpeg.Decode(bytes.NewReader(body))
		require.NoError(t, err)
		bounds := decoded.Bounds()
		assert.LessOrEqual(t, bounds.Dx(), 256)
		assert.LessOrEqual(t, bounds.Dy(), 256)
		assert.Equal(t, 256, bounds.Dx())
		assert.Equal(t, 128, bounds.Dy())
	})

	t.Run("corrupt file returns 400", func(t *testing.T) {
		corruptData := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00}
		_, err := user.Client.UploadProfileIcon(t.Context(), "corrupt.png", bytes.NewReader(corruptData))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("decompression bomb is rejected", func(t *testing.T) {
		// Minimal PNG with an IHDR claiming 5000x5000 pixels (~75 MB decompressed).
		// UploadProfileIcon rejects dimensions exceeding the 4096-pixel cap.
		pngHeader := []byte{
			0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
			0x00, 0x00, 0x00, 0x0D,
			0x49, 0x48, 0x44, 0x52,
			0x00, 0x00, 0x13, 0x88,
			0x00, 0x00, 0x13, 0x88,
			0x08,
			0x02,
			0x00, 0x00, 0x00,
			0x00, 0x00, 0x00, 0x00,
		}
		_, err := user.Client.UploadProfileIcon(t.Context(), "bomb.png", bytes.NewReader(pngHeader))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("GIF upload returns 400", func(t *testing.T) {
		img := image.NewPaletted(image.Rect(0, 0, 1, 1), color.Palette{color.White})
		var buf bytes.Buffer
		require.NoError(t, gif.Encode(&buf, img, nil))
		_, err := user.Client.UploadProfileIcon(t.Context(), "test.gif", &buf)
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
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
