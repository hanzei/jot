package main

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAuthMiddlewareUnauthenticated(t *testing.T) {
	ts := setupTestServer(t)
	resp := ts.request(t, nil, http.MethodGet, "/api/v1/me", nil)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestAuthMiddlewareAuthenticated(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "authmwuser", "password123", false)
	resp := ts.authRequest(t, user, http.MethodGet, "/api/v1/me", nil)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

func TestAuthMiddlewareInvalidCookie(t *testing.T) {
	ts := setupTestServer(t)
	client := newCookieClient(t)
	req, _ := http.NewRequest(http.MethodGet, ts.HTTPServer.URL+"/api/v1/me", nil)
	req.AddCookie(&http.Cookie{Name: "jot_session", Value: "not-a-real-token"})
	resp, err := client.Do(req)
	if err == nil {
		defer resp.Body.Close()
	}
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestAuthMiddlewareSessionClearedAfterLogout(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "logoutuser", "password123", false)

	// Verify authenticated.
	resp := ts.authRequest(t, user, http.MethodGet, "/api/v1/me", nil)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	// Log out.
	resp = ts.authRequest(t, user, http.MethodPost, "/api/v1/logout", nil)
	assert.Equal(t, http.StatusNoContent, resp.StatusCode)

	// Same client (same cookie jar) should now be rejected.
	resp = ts.authRequest(t, user, http.MethodGet, "/api/v1/me", nil)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestAdminMiddlewareNonAdminForbidden(t *testing.T) {
	ts := setupTestServer(t)
	// First registered user becomes admin automatically, so create it first.
	_ = ts.createTestUser(t, "adminuser", "password123", true)
	regularUser := ts.createTestUser(t, "regularuser", "password123", false)
	resp := ts.authRequest(t, regularUser, http.MethodGet, "/api/v1/admin/users", nil)
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestAdminMiddlewareAdminAllowed(t *testing.T) {
	ts := setupTestServer(t)
	adminUser := ts.createTestUser(t, "adminuser2", "password123", true)
	resp := ts.authRequest(t, adminUser, http.MethodGet, "/api/v1/admin/users", nil)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

func TestAdminMiddlewareUnauthenticated(t *testing.T) {
	ts := setupTestServer(t)
	resp := ts.request(t, nil, http.MethodGet, "/api/v1/admin/users", nil)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestSessionPersistsAcrossRequests(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "sessionuser", "password123", false)
	resp1 := ts.authRequest(t, user, http.MethodGet, "/api/v1/me", nil)
	resp2 := ts.authRequest(t, user, http.MethodGet, "/api/v1/me", nil)
	assert.Equal(t, http.StatusOK, resp1.StatusCode)
	assert.Equal(t, http.StatusOK, resp2.StatusCode)
}
