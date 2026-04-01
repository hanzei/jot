package main

import (
	"net/http"
	"testing"

	"github.com/hanzei/jot/server/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSecurityHeaders(t *testing.T) {
	t.Run("standard headers are present on probe endpoint", func(t *testing.T) {
		ts := setupTestServer(t)
		c := ts.newClient()

		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/livez", nil)
		require.NoError(t, err)

		resp, err := c.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()

		assert.Equal(t, "nosniff", resp.Header.Get("X-Content-Type-Options"))
		assert.Equal(t, "DENY", resp.Header.Get("X-Frame-Options"))
		assert.Equal(t, "strict-origin-when-cross-origin", resp.Header.Get("Referrer-Policy"))
		assert.Equal(t, "camera=(), microphone=(), geolocation=()", resp.Header.Get("Permissions-Policy"))
		assert.Equal(t, "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'", resp.Header.Get("Content-Security-Policy"))
	})

	t.Run("standard headers are present on authenticated API endpoint", func(t *testing.T) {
		ts := setupTestServer(t)
		u := ts.createTestUser(t, "headeruser", "password123", false)

		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/me", nil)
		require.NoError(t, err)

		// u.Client.HTTPClient() carries the session cookie from Register.
		resp, err := u.Client.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()

		assert.Equal(t, "nosniff", resp.Header.Get("X-Content-Type-Options"))
		assert.Equal(t, "DENY", resp.Header.Get("X-Frame-Options"))
		assert.Equal(t, "strict-origin-when-cross-origin", resp.Header.Get("Referrer-Policy"))
		assert.Equal(t, "camera=(), microphone=(), geolocation=()", resp.Header.Get("Permissions-Policy"))
		assert.Equal(t, "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'", resp.Header.Get("Content-Security-Policy"))
	})

	t.Run("HSTS absent when CookieSecure is false", func(t *testing.T) {
		ts := setupTestServerWithConfig(t, func(cfg *config.Config) {
			cfg.CookieSecure = false
		})
		c := ts.newClient()

		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/livez", nil)
		require.NoError(t, err)

		resp, err := c.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()

		assert.Empty(t, resp.Header.Get("Strict-Transport-Security"))
	})

	t.Run("HSTS present when CookieSecure is true", func(t *testing.T) {
		ts := setupTestServerWithConfig(t, func(cfg *config.Config) {
			cfg.CookieSecure = true
		})
		c := ts.newClient()

		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/livez", nil)
		require.NoError(t, err)

		resp, err := c.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()

		assert.Equal(t, "max-age=31536000; includeSubDomains", resp.Header.Get("Strict-Transport-Security"))
	})
}
