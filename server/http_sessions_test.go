package main

import (
	"net/http"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestListSessions(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "sessionlist", "password123", false)

	sessions, err := user.Client.ListSessions(t.Context())
	require.NoError(t, err)
	require.Len(t, sessions, 1)
	assert.True(t, sessions[0].IsCurrent)
	assert.NotEmpty(t, sessions[0].ID)
	assert.False(t, sessions[0].CreatedAt.IsZero())
	assert.False(t, sessions[0].ExpiresAt.IsZero())
}

func TestListSessionsUnauthenticated(t *testing.T) {
	ts := setupTestServer(t)
	c := ts.newClient()

	_, err := c.ListSessions(t.Context())
	assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
}

func TestListSessionsMultiple(t *testing.T) {
	ts := setupTestServer(t)

	_ = ts.createTestUser(t, "multisess", "password123", false)

	c2 := ts.newClient()
	_, err := c2.Login(t.Context(), "multisess", "password123")
	require.NoError(t, err)

	c3 := ts.newClient()
	_, err = c3.Login(t.Context(), "multisess", "password123")
	require.NoError(t, err)

	sessions, err := c3.ListSessions(t.Context())
	require.NoError(t, err)
	assert.Len(t, sessions, 3)

	currentCount := 0
	for _, s := range sessions {
		if s.IsCurrent {
			currentCount++
		}
	}
	assert.Equal(t, 1, currentCount)
}

func TestRevokeSession(t *testing.T) {
	ts := setupTestServer(t)

	_ = ts.createTestUser(t, "revoke", "password123", false)

	c2 := ts.newClient()
	_, err := c2.Login(t.Context(), "revoke", "password123")
	require.NoError(t, err)

	sessions, err := c2.ListSessions(t.Context())
	require.NoError(t, err)
	require.Len(t, sessions, 2)

	var otherSession client.SessionInfo
	for _, s := range sessions {
		if !s.IsCurrent {
			otherSession = s
			break
		}
	}
	require.NotEmpty(t, otherSession.ID)

	err = c2.RevokeSession(t.Context(), otherSession.ID)
	require.NoError(t, err)

	sessions, err = c2.ListSessions(t.Context())
	require.NoError(t, err)
	assert.Len(t, sessions, 1)
	assert.True(t, sessions[0].IsCurrent)
}

func TestRevokeCurrentSessionFails(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "revokeself", "password123", false)

	sessions, err := user.Client.ListSessions(t.Context())
	require.NoError(t, err)
	require.Len(t, sessions, 1)

	err = user.Client.RevokeSession(t.Context(), sessions[0].ID)
	assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
}

func TestRevokeSessionNotFound(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "revokenotfound", "password123", false)

	err := user.Client.RevokeSession(t.Context(), "nonexistentsessionid")
	assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
}

func TestRevokeSessionUnauthenticated(t *testing.T) {
	ts := setupTestServer(t)
	c := ts.newClient()

	err := c.RevokeSession(t.Context(), "someid")
	assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
}

func TestRevokedSessionCannotAuthenticate(t *testing.T) {
	ts := setupTestServer(t)

	user := ts.createTestUser(t, "revokecheck", "password123", false)

	c2 := ts.newClient()
	_, err := c2.Login(t.Context(), "revokecheck", "password123")
	require.NoError(t, err)

	sessions, err := c2.ListSessions(t.Context())
	require.NoError(t, err)

	var originalSessionID string
	for _, s := range sessions {
		if !s.IsCurrent {
			originalSessionID = s.ID
			break
		}
	}
	require.NotEmpty(t, originalSessionID)

	err = c2.RevokeSession(t.Context(), originalSessionID)
	require.NoError(t, err)

	_, err = user.Client.Me(t.Context())
	assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
}

func TestSessionUserAgentStored(t *testing.T) {
	ts := setupTestServer(t)

	c := ts.newClient()
	req, _ := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.HTTPServer.URL+"/api/v1/register", nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Content-Type", "application/json")

	_, err := c.Register(t.Context(), "uauser", "password123")
	require.NoError(t, err)

	sessions, err := c.ListSessions(t.Context())
	require.NoError(t, err)
	require.Len(t, sessions, 1)
	assert.NotEmpty(t, sessions[0].Browser)
	assert.NotEmpty(t, sessions[0].OS)
}

func TestSessionCrossUserIsolation(t *testing.T) {
	ts := setupTestServer(t)
	user1 := ts.createTestUser(t, "isolate1", "password123", false)
	user2 := ts.createTestUser(t, "isolate2", "password123", false)

	sessions1, err := user1.Client.ListSessions(t.Context())
	require.NoError(t, err)
	require.Len(t, sessions1, 1)

	sessions2, err := user2.Client.ListSessions(t.Context())
	require.NoError(t, err)
	require.Len(t, sessions2, 1)

	assert.NotEqual(t, sessions1[0].ID, sessions2[0].ID)

	err = user2.Client.RevokeSession(t.Context(), sessions1[0].ID)
	assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
}
