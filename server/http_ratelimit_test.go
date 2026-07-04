package main

import (
	"net/http"
	"testing"

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

func TestRateLimiting(t *testing.T) {
	t.Run("disabled by default in tests, unaffected by burst traffic", func(t *testing.T) {
		ts := setupTestServer(t)
		u := ts.createTestUser(t, "burstuser", "password123", false)

		for range 50 {
			status, _ := doGet(t, u.Client.HTTPClient(), ts.HTTPServer.URL+"/api/v1/me")
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
			status, _ := doGet(t, u.Client.HTTPClient(), ts.HTTPServer.URL+"/api/v1/me")
			assert.Equal(t, http.StatusOK, status)
		}

		status, header := doGet(t, u.Client.HTTPClient(), ts.HTTPServer.URL+"/api/v1/me")
		assert.Equal(t, http.StatusTooManyRequests, status)
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

		statusA, _ := doGet(t, userA.Client.HTTPClient(), ts.HTTPServer.URL+"/api/v1/me")
		assert.Equal(t, http.StatusOK, statusA)
		statusAAgain, _ := doGet(t, userA.Client.HTTPClient(), ts.HTTPServer.URL+"/api/v1/me")
		assert.Equal(t, http.StatusTooManyRequests, statusAAgain)

		// userB has its own bucket and is unaffected by userA exhausting theirs.
		statusB, _ := doGet(t, userB.Client.HTTPClient(), ts.HTTPServer.URL+"/api/v1/me")
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
}
