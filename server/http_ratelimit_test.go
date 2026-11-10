package main

import (
	"bytes"
	"net/http"
	"strings"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// doGet issues a GET request and returns the status code and headers, closing
// the response body itself so callers never need to remember to.
func doGet(t *testing.T, client *http.Client, url string) (int, http.Header) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url, nil)
	require.NoError(t, err)
	resp, err := client.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	return resp.StatusCode, resp.Header
}

// TestRateLimiting is deliberately left serial while the rest of the suite runs
// in parallel. Isolation is not the problem — the limiter is per-server and
// keyed by user ID or client IP, so a per-test server already has its own
// buckets. The window is. httprate uses a sliding one-minute window, so these
// subtests are asserting on the count of requests *within* a window that is
// decaying underneath them; a subtest that got descheduled long enough would
// see its early requests age out and the request it expects to be rejected
// would succeed instead. The whole function is under a second, so serializing
// it costs nothing worth the flake risk.
func TestRateLimiting(t *testing.T) {
	t.Run("disabled by default in tests, unaffected by burst traffic", func(t *testing.T) {
		ts := setupTestServer(t)
		u := ts.createTestUser(t, "burstuser", "password123", false)

		for range 50 {
			status, _ := doGet(t, u.Client.HTTPClient(), ts.HTTPServer.URL+"/api/v1/users/me")
			assert.Equal(t, http.StatusOK, status)
		}
	})

	t.Run("baseline per-user limit returns 429 with Retry-After once exceeded", func(t *testing.T) {
		ts := setupTestServerWithConfig(t, func(cfg *config.Config) {
			cfg.RateLimitEnabled = true
			cfg.RateLimitPerMinute = 3
			cfg.RateLimitAuthPerMinute = 100
			cfg.RateLimitExpensivePerMinute = 100
		})
		u := ts.createTestUser(t, "baselineuser", "password123", false)

		for range 3 {
			status, _ := doGet(t, u.Client.HTTPClient(), ts.HTTPServer.URL+"/api/v1/users/me")
			assert.Equal(t, http.StatusOK, status)
		}

		status, header, body := rawRequest(t, u.Client.HTTPClient(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/users/me", nil, nil)
		requireEnvelope(t, http.StatusTooManyRequests, "rate_limited", status, header, body)
		assert.NotEmpty(t, header.Get("Retry-After"))
	})

	t.Run("baseline limit is keyed per user, not shared globally", func(t *testing.T) {
		ts := setupTestServerWithConfig(t, func(cfg *config.Config) {
			cfg.RateLimitEnabled = true
			cfg.RateLimitPerMinute = 1
			cfg.RateLimitAuthPerMinute = 100
			cfg.RateLimitExpensivePerMinute = 100
		})
		userA := ts.createTestUser(t, "usera", "password123", false)
		userB := ts.createTestUser(t, "userb", "password123", false)

		statusA, _ := doGet(t, userA.Client.HTTPClient(), ts.HTTPServer.URL+"/api/v1/users/me")
		assert.Equal(t, http.StatusOK, statusA)
		statusAAgain, _ := doGet(t, userA.Client.HTTPClient(), ts.HTTPServer.URL+"/api/v1/users/me")
		assert.Equal(t, http.StatusTooManyRequests, statusAAgain)

		// userB has its own bucket and is unaffected by userA exhausting theirs.
		statusB, _ := doGet(t, userB.Client.HTTPClient(), ts.HTTPServer.URL+"/api/v1/users/me")
		assert.Equal(t, http.StatusOK, statusB)
	})

	t.Run("auth endpoints are rate-limited per IP before authentication", func(t *testing.T) {
		ts := setupTestServerWithConfig(t, func(cfg *config.Config) {
			cfg.RateLimitEnabled = true
			cfg.RateLimitPerMinute = 100
			cfg.RateLimitAuthPerMinute = 2
			cfg.RateLimitExpensivePerMinute = 100
		})
		c := ts.newClient()

		for range 2 {
			_, err := c.Login(t.Context(), "nonexistent", "wrongpassword")
			require.Error(t, err)
		}

		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.HTTPServer.URL+"/api/v1/login",
			nil)
		require.NoError(t, err)
		resp, err := c.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Equal(t, http.StatusTooManyRequests, resp.StatusCode)
		assert.NotEmpty(t, resp.Header.Get("Retry-After"))
	})

	t.Run("logout shares the auth bucket with register and login", func(t *testing.T) {
		ts := setupTestServerWithConfig(t, func(cfg *config.Config) {
			cfg.RateLimitEnabled = true
			cfg.RateLimitPerMinute = 100
			cfg.RateLimitAuthPerMinute = 3
			cfg.RateLimitExpensivePerMinute = 100
		})
		// createTestUser's Register call already spends one of the three slots
		// in this IP's shared auth bucket.
		u := ts.createTestUser(t, "logoutuser", "password123", false)

		for range 2 {
			require.NoError(t, u.Client.Logout(t.Context()))
		}

		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.HTTPServer.URL+"/api/v1/logout", nil)
		require.NoError(t, err)
		resp, err := u.Client.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Equal(t, http.StatusTooManyRequests, resp.StatusCode)
		assert.NotEmpty(t, resp.Header.Get("Retry-After"))
	})

	t.Run("expensive bucket gates search but not plain note listing", func(t *testing.T) {
		ts := setupTestServerWithConfig(t, func(cfg *config.Config) {
			cfg.RateLimitEnabled = true
			cfg.RateLimitPerMinute = 100
			cfg.RateLimitAuthPerMinute = 100
			cfg.RateLimitExpensivePerMinute = 2
		})
		u := ts.createTestUser(t, "searchuser", "password123", false)

		for range 2 {
			status, _ := doGet(t, u.Client.HTTPClient(), ts.HTTPServer.URL+"/api/v1/notes?search=foo")
			assert.Equal(t, http.StatusOK, status)
		}
		status, _ := doGet(t, u.Client.HTTPClient(), ts.HTTPServer.URL+"/api/v1/notes?search=foo")
		assert.Equal(t, http.StatusTooManyRequests, status)

		// Plain listing draws from the baseline bucket, not the exhausted
		// expensive one.
		plainStatus, _ := doGet(t, u.Client.HTTPClient(), ts.HTTPServer.URL+"/api/v1/notes")
		assert.Equal(t, http.StatusOK, plainStatus)
	})

	t.Run("MCP list_notes search shares the expensive bucket with REST search", func(t *testing.T) {
		ts := setupTestServerWithConfig(t, func(cfg *config.Config) {
			cfg.RateLimitEnabled = true
			cfg.RateLimitPerMinute = 100
			cfg.RateLimitAuthPerMinute = 100
			cfg.RateLimitExpensivePerMinute = 2
		})
		u := ts.createTestUser(t, "mcpsearchuser", "password123", false)
		sess := setupMCPSession(t, ts, u)

		status, _ := doGet(t, u.Client.HTTPClient(), ts.HTTPServer.URL+"/api/v1/notes?search=foo")
		assert.Equal(t, http.StatusOK, status)
		callTool(t, sess, "list_notes", map[string]any{"search": "foo"}, nil)

		msg := callToolExpectError(t, sess, "list_notes", map[string]any{"search": "foo"})
		assert.Contains(t, msg, "too many searches")
		status, _ = doGet(t, u.Client.HTTPClient(), ts.HTTPServer.URL+"/api/v1/notes?search=foo")
		assert.Equal(t, http.StatusTooManyRequests, status, "MCP searches count against REST search")

		// Listing without search is not an expensive operation.
		callTool(t, sess, "list_notes", map[string]any{}, nil)
	})

	t.Run("public bucket covers a public note, its images and its share page, per IP", func(t *testing.T) {
		ts := setupTestServerWithConfig(t, func(cfg *config.Config) {
			cfg.RateLimitEnabled = true
			cfg.RateLimitPerMinute = 100
			cfg.RateLimitAuthPerMinute = 100
			cfg.RateLimitExpensivePerMinute = 100
			cfg.RateLimitPublicPerMinute = 4
		})
		u := ts.createTestUser(t, "publicrateuser", "password123", false)
		note, err := u.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "x"})
		require.NoError(t, err)
		img, err := u.Client.UploadNoteImage(t.Context(), note.ID, "a.png", bytes.NewReader(testPNG(t, 2, 2)))
		require.NoError(t, err)
		link, err := u.Client.SetPublicLink(t.Context(), note.ID, nil)
		require.NoError(t, err)

		base := ts.HTTPServer.URL + "/api/v1/public/notes/" + link.Token
		for _, path := range []string{"", "/images/" + img.ID, "/images/" + img.ID + "/thumbnail"} {
			status, _ := doGet(t, ts.httpClient, base+path)
			assert.Equal(t, http.StatusOK, status, path)
		}
		// The share page looks the link up for its preview card, so it counts too.
		status, _ := doGet(t, ts.httpClient, ts.HTTPServer.URL+"/share/"+link.Token)
		assert.Equal(t, http.StatusOK, status)

		// Dead links draw from the same bucket, so guessing tokens is throttled too.
		status, header, body := rawRequest(t, ts.httpClient, http.MethodGet, ts.HTTPServer.URL+"/api/v1/public/notes/"+strings.Repeat("A", 43), nil, nil)
		requireEnvelope(t, http.StatusTooManyRequests, "rate_limited", status, header, body)
		assert.NotEmpty(t, header.Get("Retry-After"))
		assert.Equal(t, "no-referrer", header.Get("Referrer-Policy"))
		shareStatus, _ := doGet(t, ts.httpClient, ts.HTTPServer.URL+"/share/"+link.Token)
		assert.Equal(t, http.StatusTooManyRequests, shareStatus, "the share page is throttled with the rest of the bucket")
		// The rest of the SPA is not rate-limited.
		spaStatus, _ := doGet(t, ts.httpClient, ts.HTTPServer.URL+"/notes/abc")
		assert.Equal(t, http.StatusOK, spaStatus)

		// The authenticated API has its own buckets.
		meStatus, _ := doGet(t, u.Client.HTTPClient(), ts.HTTPServer.URL+"/api/v1/users/me")
		assert.Equal(t, http.StatusOK, meStatus)
	})
}
