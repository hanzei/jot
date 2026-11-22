package main

import (
	"bufio"
	"context"
	"maps"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/config"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// streamEndTimeout bounds how long a revoked stream may stay open. It is well
// under the 30 s heartbeat and the 5 min periodic re-check, so a stream that
// only ends through either of those fails the test.
const streamEndTimeout = 5 * time.Second

// sseStream is an open GET /events response being read in the background.
type sseStream struct {
	lines chan string
	ended chan struct{}
}

// openSSEStream opens /events with httpClient and the given extra headers,
// waits for the connected comment, and reads the rest in the background.
func openSSEStream(t *testing.T, ts *TestServer, httpClient *http.Client, header http.Header) *sseStream {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ts.HTTPServer.URL+"/api/v1/events", nil)
	require.NoError(t, err)
	maps.Copy(req.Header, header)
	// No client timeout: it would cut the stream off mid-test.
	noTimeout := *httpClient
	noTimeout.Timeout = 0
	resp, err := noTimeout.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	require.Equal(t, http.StatusOK, resp.StatusCode)

	scanner := bufio.NewScanner(resp.Body)
	require.True(t, scanner.Scan(), "expected the connected comment")
	require.Equal(t, ": connected", scanner.Text())

	s := &sseStream{lines: make(chan string, 256), ended: make(chan struct{})}
	go func() {
		defer close(s.ended)
		for scanner.Scan() {
			select {
			case s.lines <- scanner.Text():
			default: // nobody is reading this stream's events
			}
		}
	}()
	return s
}

func (s *sseStream) requireEnds(t *testing.T) {
	t.Helper()
	select {
	case <-s.ended:
	case <-time.After(streamEndTimeout):
		t.Fatal("stream should have ended once its credential was revoked")
	}
}

// requireEvent waits for a data line containing want, proving the stream is
// still open and delivering.
func (s *sseStream) requireEvent(t *testing.T, want string) {
	t.Helper()
	timeout := time.After(streamEndTimeout)
	for {
		select {
		case line := <-s.lines:
			if strings.HasPrefix(line, "data:") && strings.Contains(line, want) {
				return
			}
		case <-s.ended:
			t.Fatal("stream ended but should have stayed open")
		case <-timeout:
			t.Fatalf("timed out waiting for an event containing %q", want)
		}
	}
}

// eventsStatus returns the status code GET /events answers with.
func eventsStatus(t *testing.T, ts *TestServer, httpClient *http.Client, header http.Header) int {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel() // ends the stream should the request be admitted
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ts.HTTPServer.URL+"/api/v1/events", nil)
	require.NoError(t, err)
	maps.Copy(req.Header, header)
	resp, err := httpClient.Do(req)
	require.NoError(t, err)
	_ = resp.Body.Close()
	return resp.StatusCode
}

// loginAs opens a further session for an existing user.
func loginAs(t *testing.T, ts *TestServer, username, password string) *client.Client {
	t.Helper()
	c := ts.newClient()
	_, err := c.Login(t.Context(), username, password)
	require.NoError(t, err)
	return c
}

func currentSessionID(t *testing.T, c *client.Client) string {
	t.Helper()
	sessions, err := c.ListSessions(t.Context())
	require.NoError(t, err)
	for _, s := range sessions {
		if s.IsCurrent {
			return s.ID
		}
	}
	t.Fatal("no current session")
	return ""
}

func createNote(t *testing.T, c *client.Client, content string) {
	t.Helper()
	_, err := c.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: content})
	require.NoError(t, err)
}

// A live-update stream must end promptly when the credential it was opened
// with stops being valid, and its reconnect must be refused, while the user's
// other streams carry on.
func TestSSEStreamEndsWhenCredentialRevoked(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	const password = "password123"
	// Each subtest uses its own users, so they run in parallel.

	t.Run("revoking the session", func(t *testing.T) {
		t.Parallel()
		owner := ts.createTestUser(t, "sserevokesess", password, false)
		victim := loginAs(t, ts, "sserevokesess", password)
		other := loginAs(t, ts, "sserevokesess", password)

		victimStream := openSSEStream(t, ts, victim.HTTPClient(), nil)
		otherStream := openSSEStream(t, ts, other.HTTPClient(), nil)

		require.NoError(t, owner.Client.RevokeSession(t.Context(), currentSessionID(t, victim)))

		victimStream.requireEnds(t)
		assert.Equal(t, http.StatusUnauthorized, eventsStatus(t, ts, victim.HTTPClient(), nil))

		createNote(t, owner.Client, "after revoke")
		otherStream.requireEvent(t, "after revoke")
	})

	t.Run("changing the password", func(t *testing.T) {
		t.Parallel()
		owner := ts.createTestUser(t, "ssechangepw", password, false)
		other := loginAs(t, ts, "ssechangepw", password)

		ownerStream := openSSEStream(t, ts, owner.Client.HTTPClient(), nil)
		otherStream := openSSEStream(t, ts, other.HTTPClient(), nil)

		require.NoError(t, owner.Client.ChangePassword(t.Context(), password, "newpassword123"))

		ownerStream.requireEnds(t)
		otherStream.requireEnds(t)
		assert.Equal(t, http.StatusUnauthorized, eventsStatus(t, ts, other.HTTPClient(), nil))

		// The fresh session issued to the caller can open a stream.
		fresh := openSSEStream(t, ts, owner.Client.HTTPClient(), nil)
		createNote(t, owner.Client, "after password change")
		fresh.requireEvent(t, "after password change")
	})

	t.Run("an admin setting the password", func(t *testing.T) {
		t.Parallel()
		admin := ts.createTestUser(t, "ssesetpwadmin", password, true)
		user := ts.createTestUser(t, "ssesetpwuser", password, false)

		stream := openSSEStream(t, ts, user.Client.HTTPClient(), nil)
		adminStream := openSSEStream(t, ts, admin.Client.HTTPClient(), nil)

		require.NoError(t, admin.Client.AdminSetUserPassword(t.Context(), user.User.ID, "newpassword123"))

		stream.requireEnds(t)
		assert.Equal(t, http.StatusUnauthorized, eventsStatus(t, ts, user.Client.HTTPClient(), nil))

		createNote(t, admin.Client, "admin still connected")
		adminStream.requireEvent(t, "admin still connected")
	})

	t.Run("logging out", func(t *testing.T) {
		t.Parallel()
		user := ts.createTestUser(t, "sselogout", password, false)
		other := loginAs(t, ts, "sselogout", password)

		// A second tab shares the cookie jar, so its stream uses the same
		// session the first tab logs out of.
		stream := openSSEStream(t, ts, user.Client.HTTPClient(), nil)
		otherStream := openSSEStream(t, ts, other.HTTPClient(), nil)

		// Logout clears the cookie from the jar, so keep it to prove the
		// session itself is refused, not just absent from the request.
		serverURL, err := url.Parse(ts.HTTPServer.URL)
		require.NoError(t, err)
		var sessionCookie string
		for _, c := range user.Client.HTTPClient().Jar.Cookies(serverURL) {
			if c.Name == "jot_session" {
				sessionCookie = c.Name + "=" + c.Value
			}
		}
		require.NotEmpty(t, sessionCookie)

		require.NoError(t, user.Client.Logout(t.Context()))

		stream.requireEnds(t)
		assert.Equal(t, http.StatusUnauthorized, eventsStatus(t, ts, ts.httpClient, http.Header{"Cookie": {sessionCookie}}))

		createNote(t, other, "after logout")
		otherStream.requireEvent(t, "after logout")
	})

	t.Run("revoking the personal access token", func(t *testing.T) {
		t.Parallel()
		user := ts.createTestUser(t, "sserevokepat", password, false)
		revoked := createPAT(t, ts, user, "revoked")
		kept := createPAT(t, ts, user, "kept")
		bearer := func(token string) http.Header {
			return http.Header{"Authorization": {"Bearer " + token}}
		}

		revokedStream := openSSEStream(t, ts, ts.httpClient, bearer(revoked.Token))
		keptStream := openSSEStream(t, ts, ts.httpClient, bearer(kept.Token))
		sessionStream := openSSEStream(t, ts, user.Client.HTTPClient(), nil)

		req, err := http.NewRequestWithContext(t.Context(), http.MethodDelete, ts.HTTPServer.URL+"/api/v1/pats/"+revoked.ID, nil)
		require.NoError(t, err)
		resp, err := user.Client.HTTPClient().Do(req)
		require.NoError(t, err)
		_ = resp.Body.Close()
		require.Equal(t, http.StatusNoContent, resp.StatusCode)

		revokedStream.requireEnds(t)
		assert.Equal(t, http.StatusUnauthorized, eventsStatus(t, ts, ts.httpClient, bearer(revoked.Token)))

		createNote(t, user.Client, "after pat revoke")
		keptStream.requireEvent(t, "after pat revoke")
		sessionStream.requireEvent(t, "after pat revoke")
	})

	t.Run("deleting the account", func(t *testing.T) {
		t.Parallel()
		user := ts.createTestUser(t, "ssedeleteme", password, false)
		other := loginAs(t, ts, "ssedeleteme", password)
		pat := createPAT(t, ts, user, "deleted with the account")
		bearer := http.Header{"Authorization": {"Bearer " + pat.Token}}

		otherStream := openSSEStream(t, ts, other.HTTPClient(), nil)
		patStream := openSSEStream(t, ts, ts.httpClient, bearer)

		require.NoError(t, user.Client.DeleteMe(t.Context(), password, ""))

		otherStream.requireEnds(t)
		patStream.requireEnds(t)
		assert.Equal(t, http.StatusUnauthorized, eventsStatus(t, ts, other.HTTPClient(), nil))
		assert.Equal(t, http.StatusUnauthorized, eventsStatus(t, ts, ts.httpClient, bearer))
	})

	t.Run("an admin deleting the account", func(t *testing.T) {
		t.Parallel()
		admin := ts.createTestUser(t, "ssedeleteadmin", password, true)
		user := ts.createTestUser(t, "ssedeleteuser", password, false)

		stream := openSSEStream(t, ts, user.Client.HTTPClient(), nil)

		require.NoError(t, admin.Client.AdminDeleteUser(t.Context(), user.User.ID))

		stream.requireEnds(t)
		assert.Equal(t, http.StatusUnauthorized, eventsStatus(t, ts, user.Client.HTTPClient(), nil))
	})
}

// Session expiry deletes nothing when it happens, so no revoke path signals
// the stream; the periodic re-check is what ends it.
func TestSSEStreamEndsWhenSessionExpires(t *testing.T) {
	t.Parallel()
	ts := setupTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.SSECredentialRecheckInterval = 100 * time.Millisecond
	})
	expiring := ts.createTestUser(t, "sseexpiring", "password123", false)
	steady := ts.createTestUser(t, "ssesteady", "password123", false)

	expiringStream := openSSEStream(t, ts, expiring.Client.HTTPClient(), nil)
	steadyStream := openSSEStream(t, ts, steady.Client.HTTPClient(), nil)

	ts.exec(t, "UPDATE sessions SET expires_at = ? WHERE user_id = ?",
		models.Timestamp(models.Now().Add(-time.Minute)), expiring.User.ID)

	expiringStream.requireEnds(t)
	assert.Equal(t, http.StatusUnauthorized, eventsStatus(t, ts, expiring.Client.HTTPClient(), nil))

	// A valid session passes every periodic re-check and keeps its stream.
	time.Sleep(500 * time.Millisecond) //nolint:forbidigo // spans several re-check intervals
	createNote(t, steady.Client, "still connected")
	steadyStream.requireEvent(t, "still connected")
}
