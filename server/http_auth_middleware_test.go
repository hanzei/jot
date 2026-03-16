package main

import (
	"net/http"
	"testing"
	"time"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAuthMiddlewareUnauthenticated(t *testing.T) {
	ts := setupTestServer(t)
	c := ts.newClient()
	_, err := c.Me(t.Context())
	assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
}

func TestAuthMiddlewareAuthenticated(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "authmwuser", "password123", false)
	_, err := user.Client.Me(t.Context())
	require.NoError(t, err)
}

func TestAuthMiddlewareInvalidCookie(t *testing.T) {
	ts := setupTestServer(t)
	c := ts.newClient()
	req, _ := http.NewRequest(http.MethodGet, ts.HTTPServer.URL+"/api/v1/me", nil)
	req.AddCookie(&http.Cookie{Name: "jot_session", Value: "not-a-real-token"})
	resp, err := c.HTTPClient().Do(req)
	if err == nil {
		defer resp.Body.Close()
	}
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestAuthMiddlewareSessionClearedAfterLogout(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "logoutuser", "password123", false)

	_, err := user.Client.Me(t.Context())
	require.NoError(t, err)

	require.NoError(t, user.Client.Logout(t.Context()))

	_, err = user.Client.Me(t.Context())
	assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
}

func TestAdminMiddlewareNonAdminForbidden(t *testing.T) {
	ts := setupTestServer(t)
	_ = ts.createTestUser(t, "adminuser", "password123", true)
	regularUser := ts.createTestUser(t, "regularuser", "password123", false)
	_, err := regularUser.Client.AdminListUsers(t.Context())
	assert.Equal(t, http.StatusForbidden, client.StatusCode(err))
}

func TestAdminMiddlewareAdminAllowed(t *testing.T) {
	ts := setupTestServer(t)
	adminUser := ts.createTestUser(t, "adminuser2", "password123", true)
	_, err := adminUser.Client.AdminListUsers(t.Context())
	require.NoError(t, err)
}

func TestAdminMiddlewareUnauthenticated(t *testing.T) {
	ts := setupTestServer(t)
	c := ts.newClient()
	_, err := c.AdminListUsers(t.Context())
	assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
}

func TestSessionPersistsAcrossRequests(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "sessionuser", "password123", false)
	_, err := user.Client.Me(t.Context())
	require.NoError(t, err)
	_, err = user.Client.Me(t.Context())
	require.NoError(t, err)
}

func TestSessionRenewedWhenLessThanSevenDaysLeft(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "renewuser", "password123", false)

	token, err := getSessionTokenByUserID(ts, user.User.ID)
	require.NoError(t, err)

	nearExpiry := time.Now().Add(6 * 24 * time.Hour)
	_, err = ts.Server.GetDB().Exec("UPDATE sessions SET expires_at = ? WHERE token = ?", nearExpiry, token)
	require.NoError(t, err)

	// Make an API call so the middleware can renew the session
	req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/me", nil)
	resp, err := user.Client.HTTPClient().Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	renewedExpiry, err := getSessionExpiryByToken(ts, token)
	require.NoError(t, err)
	assert.True(t, renewedExpiry.After(time.Now().Add(29*24*time.Hour)))

	renewedCookie := findCookie(resp, "jot_session")
	if assert.NotNil(t, renewedCookie) {
		assert.Equal(t, int(models.SessionDuration.Seconds()), renewedCookie.MaxAge)
	}
}

func TestSessionNotRenewedWhenAtLeastSevenDaysLeft(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "noreneweuser", "password123", false)

	token, err := getSessionTokenByUserID(ts, user.User.ID)
	require.NoError(t, err)

	farExpiry := time.Now().Add(8 * 24 * time.Hour)
	_, err = ts.Server.GetDB().Exec("UPDATE sessions SET expires_at = ? WHERE token = ?", farExpiry, token)
	require.NoError(t, err)

	req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/me", nil)
	resp, err := user.Client.HTTPClient().Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	expiryAfterRequest, err := getSessionExpiryByToken(ts, token)
	require.NoError(t, err)
	assert.Equal(t, farExpiry.Unix(), expiryAfterRequest.Unix())
	assert.Nil(t, findCookie(resp, "jot_session"))
}

func TestSessionNotRenewedWhenSlightlyAboveSevenDaysLeft(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "seven-days-user", "password123", false)

	token, err := getSessionTokenByUserID(ts, user.User.ID)
	require.NoError(t, err)

	justAboveThreshold := time.Now().Add(models.SessionRenewWindow + time.Minute)
	_, err = ts.Server.GetDB().Exec("UPDATE sessions SET expires_at = ? WHERE token = ?", justAboveThreshold, token)
	require.NoError(t, err)

	req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/me", nil)
	resp, err := user.Client.HTTPClient().Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	expiryAfterRequest, err := getSessionExpiryByToken(ts, token)
	require.NoError(t, err)
	assert.Equal(t, justAboveThreshold.Unix(), expiryAfterRequest.Unix())
	assert.Nil(t, findCookie(resp, "jot_session"))
}

func getSessionTokenByUserID(ts *TestServer, userID string) (string, error) {
	var token string
	err := ts.Server.GetDB().QueryRow("SELECT token FROM sessions WHERE user_id = ?", userID).Scan(&token)
	return token, err
}

func getSessionExpiryByToken(ts *TestServer, token string) (time.Time, error) {
	var expiresAt time.Time
	err := ts.Server.GetDB().QueryRow("SELECT expires_at FROM sessions WHERE token = ?", token).Scan(&expiresAt)
	return expiresAt, err
}

func findCookie(resp *http.Response, name string) *http.Cookie {
	for _, cookie := range resp.Cookies() {
		if cookie.Name == name {
			return cookie
		}
	}
	return nil
}
