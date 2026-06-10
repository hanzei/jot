package cmd

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/config"
	"github.com/hanzei/jot/server/internal/server"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// testLogWriter forwards logrus output to t.Log so it is hidden on success
// and visible on failure or when running with -v.
type testLogWriter struct{ t *testing.T }

func (w *testLogWriter) Write(p []byte) (int, error) {
	w.t.Log(strings.TrimRight(string(p), "\n"))
	return len(p), nil
}

// jotTestServer wraps an httptest.Server with helpers for test setup.
type jotTestServer struct {
	srv        *server.Server
	httpServer *httptest.Server
}

func setupTestServer(t *testing.T) *jotTestServer {
	t.Helper()
	return setupTestServerWithConfig(t, nil)
}

func setupTestServerWithConfig(t *testing.T, customize func(*config.Config)) *jotTestServer {
	t.Helper()

	prev := logrus.StandardLogger().Out
	logrus.SetOutput(&testLogWriter{t: t})
	t.Cleanup(func() { logrus.SetOutput(prev) })

	tmpDir := t.TempDir()
	require.NoError(t, os.WriteFile(tmpDir+"/index.html", []byte("<html><body>jot</body></html>"), 0o600))

	cfg := &config.Config{
		Port:                0,
		DBDriver:            "sqlite",
		DBDSN:               tmpDir + "/test.db",
		StaticDir:           tmpDir,
		CORSAllowedOrigin:   "http://localhost:5173",
		CookieSecure:        false,
		RegistrationEnabled: true,
		PasswordMinLength:   10,
	}
	if customize != nil {
		customize(cfg)
	}

	s, err := server.New(cfg)
	require.NoError(t, err)

	httpServer := httptest.NewServer(s.GetRouter())
	ts := &jotTestServer{srv: s, httpServer: httpServer}
	t.Cleanup(func() {
		httpServer.Close()
		ts.srv.StopBackgroundTasks()
		_ = ts.srv.GetDB().Close()
	})

	return ts
}

// createAdmin registers the first user on a fresh server. The server
// automatically promotes the first registered user to admin.
func (ts *jotTestServer) createAdmin(t *testing.T, username, password string) *client.Client {
	t.Helper()
	c := client.New(ts.httpServer.URL)
	_, err := c.Register(t.Context(), username, password)
	require.NoError(t, err)
	return c
}

// createUser registers a non-admin user and returns its authenticated client.
func (ts *jotTestServer) createUser(t *testing.T, username, password string) *client.Client {
	t.Helper()
	c := client.New(ts.httpServer.URL)
	_, err := c.Register(t.Context(), username, password)
	require.NoError(t, err)
	return c
}

// jotCTLResult holds the captured output and error from a runJotCTL call.
type jotCTLResult struct {
	Stdout string
	Err    error
}

// extractSessionToken returns the jot_session cookie value from c's cookie jar.
func extractSessionToken(t *testing.T, c *client.Client, rawURL string) string {
	t.Helper()
	u, err := url.Parse(rawURL)
	require.NoError(t, err)
	for _, cookie := range c.HTTPClient().Jar.Cookies(u) {
		if cookie.Name == sessionCookieName {
			return cookie.Value
		}
	}
	t.Fatal("client has no session cookie — was Login called?")
	return ""
}

// runJotCTL executes jotctl args against ts, authenticated as the user whose
// session cookie is held in c. It captures stdout and returns the result.
//
// The JOTCTL_CONFIG_DIR env var is redirected to a per-call temp directory so
// the session file never touches the real user config and calls can run in
// parallel.
func runJotCTL(t *testing.T, ts *jotTestServer, c *client.Client, args ...string) jotCTLResult {
	t.Helper()

	// Redirect the session file to an isolated temp directory.
	configDir := t.TempDir()
	t.Setenv("JOTCTL_CONFIG_DIR", configDir)

	// Write the session file so loadSession() can pick it up.
	require.NoError(t, writeSessionFile(&sessionData{
		Server:       ts.httpServer.URL,
		SessionToken: extractSessionToken(t, c, ts.httpServer.URL),
	}))

	// Run the command tree with a captured output buffer.
	var buf bytes.Buffer
	app := NewApp(&buf)
	root := app.newRootCmd()
	root.SetArgs(args)
	cmdErr := root.Execute()

	return jotCTLResult{Stdout: buf.String(), Err: cmdErr}
}

// --- Tests ---

func TestUsersListCmd(t *testing.T) {
	ts := setupTestServer(t)
	admin := ts.createAdmin(t, "admin", "adminpassword")
	ts.createUser(t, "alice", "alicepassword")

	t.Run("table output", func(t *testing.T) {
		res := runJotCTL(t, ts, admin, "users", "list")
		require.NoError(t, res.Err)
		assert.Contains(t, res.Stdout, "admin")
		assert.Contains(t, res.Stdout, "alice")
		assert.Contains(t, res.Stdout, "ID")
		assert.Contains(t, res.Stdout, "USERNAME")
	})

	t.Run("json output", func(t *testing.T) {
		res := runJotCTL(t, ts, admin, "--json", "users", "list")
		require.NoError(t, res.Err)

		var users []client.User
		require.NoError(t, json.Unmarshal([]byte(res.Stdout), &users))
		require.Len(t, users, 2)

		usernames := []string{users[0].Username, users[1].Username}
		assert.Contains(t, usernames, "admin")
		assert.Contains(t, usernames, "alice")
	})
}

func TestUsersCreateCmd(t *testing.T) {
	ts := setupTestServer(t)
	admin := ts.createAdmin(t, "admin", "adminpassword")

	t.Run("creates user with default role", func(t *testing.T) {
		res := runJotCTL(t, ts, admin, "users", "create", "--username", "bob", "--password", "bobpassword1")
		require.NoError(t, res.Err)
		assert.Contains(t, res.Stdout, "bob")
		assert.Contains(t, res.Stdout, "Created user")
	})

	t.Run("creates admin user", func(t *testing.T) {
		res := runJotCTL(t, ts, admin, "users", "create", "--username", "carol", "--password", "carolpassword", "--role", "admin")
		require.NoError(t, res.Err)
		assert.Contains(t, res.Stdout, "carol")
	})

	t.Run("json output", func(t *testing.T) {
		res := runJotCTL(t, ts, admin, "--json", "users", "create", "--username", "dave", "--password", "davepassword1")
		require.NoError(t, res.Err)

		var u client.User
		require.NoError(t, json.Unmarshal([]byte(res.Stdout), &u))
		assert.Equal(t, "dave", u.Username)
		assert.Equal(t, client.RoleUser, u.Role)
	})

	t.Run("rejects invalid role", func(t *testing.T) {
		res := runJotCTL(t, ts, admin, "users", "create", "--username", "eve", "--password", "evepassword1", "--role", "superuser")
		require.Error(t, res.Err)
		assert.Contains(t, res.Err.Error(), "invalid role")
	})
}

func TestUsersDeleteCmd(t *testing.T) {
	ts := setupTestServer(t)
	admin := ts.createAdmin(t, "admin", "adminpassword")

	t.Run("deletes existing user", func(t *testing.T) {
		// Create a user to delete via the client SDK, then delete via CLI.
		u, err := admin.AdminCreateUser(t.Context(), "todelete", "password123", client.RoleUser)
		require.NoError(t, err)

		res := runJotCTL(t, ts, admin, "users", "delete", u.ID)
		require.NoError(t, res.Err)
		assert.Contains(t, res.Stdout, "Deleted user")

		// Confirm it's gone.
		users, err := admin.AdminListUsers(t.Context())
		require.NoError(t, err)
		for _, listed := range users {
			assert.NotEqual(t, u.ID, listed.ID)
		}
	})
}

func TestUsersSetRoleCmd(t *testing.T) {
	ts := setupTestServer(t)
	admin := ts.createAdmin(t, "admin", "adminpassword")

	t.Run("promotes user to admin", func(t *testing.T) {
		u, err := admin.AdminCreateUser(t.Context(), "promote", "password123", client.RoleUser)
		require.NoError(t, err)

		res := runJotCTL(t, ts, admin, "users", "set-role", u.ID, "admin")
		require.NoError(t, res.Err)
		assert.Contains(t, res.Stdout, "admin")
	})

	t.Run("json output", func(t *testing.T) {
		u, err := admin.AdminCreateUser(t.Context(), "demote", "password123", client.RoleAdmin)
		require.NoError(t, err)

		res := runJotCTL(t, ts, admin, "--json", "users", "set-role", u.ID, "user")
		require.NoError(t, res.Err)

		var updated client.User
		require.NoError(t, json.Unmarshal([]byte(res.Stdout), &updated))
		assert.Equal(t, client.RoleUser, updated.Role)
	})

	t.Run("rejects invalid role", func(t *testing.T) {
		u, err := admin.AdminCreateUser(t.Context(), "norole", "password123", client.RoleUser)
		require.NoError(t, err)

		res := runJotCTL(t, ts, admin, "users", "set-role", u.ID, "godmode")
		require.Error(t, res.Err)
		assert.Contains(t, res.Err.Error(), "invalid role")
	})
}

func TestVersionCmd(t *testing.T) {
	ts := setupTestServer(t)
	admin := ts.createAdmin(t, "admin", "adminpassword")

	t.Run("text output", func(t *testing.T) {
		res := runJotCTL(t, ts, admin, "version")
		require.NoError(t, res.Err)
		assert.Contains(t, res.Stdout, "jotctl")
	})

	t.Run("json output", func(t *testing.T) {
		res := runJotCTL(t, ts, admin, "--json", "version")
		require.NoError(t, res.Err)

		var info versionInfo
		require.NoError(t, json.Unmarshal([]byte(res.Stdout), &info))
		assert.NotEmpty(t, info.GoVersion)
		assert.NotEmpty(t, info.Version)
	})
}

func TestSeedCmd(t *testing.T) {
	t.Run("seeds users and notes", func(t *testing.T) {
		ts := setupTestServer(t)
		admin := ts.createAdmin(t, "admin", "adminpassword")

		res := runJotCTL(t, ts, admin, "seed")
		require.NoError(t, res.Err)
		assert.Contains(t, res.Stdout, "Done.")

		users, err := admin.AdminListUsers(t.Context())
		require.NoError(t, err)
		// admin + 3 seed users
		assert.GreaterOrEqual(t, len(users), 4)
	})

	t.Run("json output", func(t *testing.T) {
		ts := setupTestServer(t)
		admin := ts.createAdmin(t, "admin", "adminpassword")

		res := runJotCTL(t, ts, admin, "--json", "seed")
		require.NoError(t, res.Err)

		var summary seedSummary
		require.NoError(t, json.Unmarshal([]byte(res.Stdout), &summary))
		assert.Equal(t, 3, summary.UsersCreated)
		assert.Greater(t, summary.NotesCreated, 0)
	})

	t.Run("is idempotent", func(t *testing.T) {
		ts := setupTestServer(t)
		admin := ts.createAdmin(t, "admin", "adminpassword")

		res := runJotCTL(t, ts, admin, "--json", "seed")
		require.NoError(t, res.Err)

		// Second seed should create no new users.
		res2 := runJotCTL(t, ts, admin, "--json", "seed")
		require.NoError(t, res2.Err)

		var summary seedSummary
		require.NoError(t, json.Unmarshal([]byte(res2.Stdout), &summary))
		assert.Equal(t, 0, summary.UsersCreated)
	})
}

func TestResetCmd(t *testing.T) {
	ts := setupTestServer(t)
	admin := ts.createAdmin(t, "admin", "adminpassword")

	// Seed first so there's something to reset.
	res := runJotCTL(t, ts, admin, "seed")
	require.NoError(t, res.Err)

	t.Run("deletes non-admin users", func(t *testing.T) {
		res := runJotCTL(t, ts, admin, "reset", "--yes")
		require.NoError(t, res.Err)
		assert.Contains(t, res.Stdout, "Done.")

		// Only admin should remain after reset.
		users, err := admin.AdminListUsers(t.Context())
		require.NoError(t, err)
		assert.Equal(t, 1, len(users))
		assert.Equal(t, "admin", users[0].Username)
	})

	t.Run("json output", func(t *testing.T) {
		// Re-seed so there's something to delete.
		res := runJotCTL(t, ts, admin, "seed")
		require.NoError(t, res.Err)

		res = runJotCTL(t, ts, admin, "--json", "reset", "--yes")
		require.NoError(t, res.Err)

		var summary resetSummary
		require.NoError(t, json.Unmarshal([]byte(res.Stdout), &summary))
		assert.Equal(t, 3, summary.UsersDeleted)
	})
}

func TestLoginCmd(t *testing.T) {
	ts := setupTestServer(t)
	// Register a user via the API so we have valid credentials.
	c := client.New(ts.httpServer.URL)
	_, err := c.Register(t.Context(), "logintest", "loginpassword")
	require.NoError(t, err)

	t.Run("writes session file", func(t *testing.T) {
		t.Setenv("JOTCTL_CONFIG_DIR", t.TempDir())

		var buf bytes.Buffer
		app := NewApp(&buf)
		root := app.newRootCmd()
		root.SetArgs([]string{
			"login",
			"--server", ts.httpServer.URL,
			"--username", "logintest",
			"--password", "loginpassword",
		})
		require.NoError(t, root.Execute())

		assert.Contains(t, buf.String(), "Logged in as logintest")

		// Session file should exist and be readable.
		sf, err := readSessionFile()
		require.NoError(t, err)
		assert.Equal(t, ts.httpServer.URL, sf.Server)
		assert.NotEmpty(t, sf.SessionToken)
	})

	t.Run("fails with wrong password", func(t *testing.T) {
		t.Setenv("JOTCTL_CONFIG_DIR", t.TempDir())

		var buf bytes.Buffer
		root := NewApp(&buf).newRootCmd()
		root.SetArgs([]string{
			"login",
			"--server", ts.httpServer.URL,
			"--username", "logintest",
			"--password", "wrongpassword",
		})
		require.Error(t, root.Execute())
	})
}

func TestLogoutCmd(t *testing.T) {
	ts := setupTestServer(t)
	admin := ts.createAdmin(t, "admin", "adminpassword")

	res := runJotCTL(t, ts, admin, "logout")
	require.NoError(t, res.Err)
	assert.Contains(t, res.Stdout, "Logged out.")

	// Session file should be gone — JOTCTL_CONFIG_DIR still points to the dir
	// that runJotCTL used, so readSessionFile looks in the right place.
	_, err := readSessionFile()
	assert.ErrorIs(t, err, os.ErrNotExist)
}
