package cmd

import (
	"bytes"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/config"
	"github.com/hanzei/jot/server/internal/server"
	"github.com/sirupsen/logrus"
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
		UploadDir:           tmpDir + "/uploads",
		UploadMaxBytes:      25 << 20,
		CORSAllowedOrigin:   "http://localhost:5173",
		CookieSecure:        false,
		RegistrationEnabled: true,
		PasswordMinLength:   4,
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
