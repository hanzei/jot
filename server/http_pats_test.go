package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/hanzei/jot/server/internal/database/dialect"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type patResponse struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	CreatedAt time.Time  `json:"created_at"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	Token     string     `json:"token"`
}

func createPAT(t *testing.T, ts *TestServer, tu *TestUser, name string) *patResponse {
	t.Helper()
	return createPATWithBody(t, ts, tu, map[string]any{"name": name}, http.StatusCreated)
}

func createPATWithBody(t *testing.T, ts *TestServer, tu *TestUser, reqBody map[string]any, wantStatus int) *patResponse {
	t.Helper()
	body, err := json.Marshal(reqBody)
	require.NoError(t, err)

	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.HTTPServer.URL+"/api/v1/pats", bytes.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")

	resp, err := tu.Client.HTTPClient().Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	require.Equal(t, wantStatus, resp.StatusCode)

	if wantStatus != http.StatusCreated {
		return nil
	}

	var pat patResponse
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&pat))
	return &pat
}

func listPATs(t *testing.T, ts *TestServer, tu *TestUser) []patResponse {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/pats", nil)
	require.NoError(t, err)

	resp, err := tu.Client.HTTPClient().Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	require.Equal(t, http.StatusOK, resp.StatusCode)

	var pats []patResponse
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&pats))
	return pats
}

func TestPATs(t *testing.T) {
	t.Run("create returns token once", func(t *testing.T) {
		ts := setupTestServer(t)
		u := ts.createTestUser(t, "alice", "password123", false)

		pat := createPAT(t, ts, u, "my CI token")

		assert.NotEmpty(t, pat.ID)
		assert.Equal(t, "my CI token", pat.Name)
		assert.NotEmpty(t, pat.Token, "token must be present in create response")
		assert.False(t, pat.CreatedAt.IsZero())
	})

	t.Run("list does not include raw token", func(t *testing.T) {
		ts := setupTestServer(t)
		u := ts.createTestUser(t, "alice", "password123", false)

		createPAT(t, ts, u, "CI token")

		pats := listPATs(t, ts, u)
		require.Len(t, pats, 1)
		assert.Equal(t, "CI token", pats[0].Name)
		assert.Empty(t, pats[0].Token, "raw token must not be returned in list")
	})

	t.Run("list returns empty array when no tokens exist", func(t *testing.T) {
		ts := setupTestServer(t)
		u := ts.createTestUser(t, "alice", "password123", false)

		pats := listPATs(t, ts, u)
		assert.Empty(t, pats)
	})

	t.Run("list returns multiple tokens in creation order descending", func(t *testing.T) {
		ts := setupTestServer(t)
		u := ts.createTestUser(t, "alice", "password123", false)

		createPAT(t, ts, u, "first")
		createPAT(t, ts, u, "second")

		pats := listPATs(t, ts, u)
		require.Len(t, pats, 2)
		assert.Equal(t, "second", pats[0].Name)
		assert.Equal(t, "first", pats[1].Name)
	})

	t.Run("revoke removes token", func(t *testing.T) {
		ts := setupTestServer(t)
		u := ts.createTestUser(t, "alice", "password123", false)

		pat := createPAT(t, ts, u, "delete me")

		req, err := http.NewRequestWithContext(t.Context(), http.MethodDelete, ts.HTTPServer.URL+"/api/v1/pats/"+pat.ID, nil)
		require.NoError(t, err)
		resp, err := u.Client.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Equal(t, http.StatusNoContent, resp.StatusCode)

		pats := listPATs(t, ts, u)
		assert.Empty(t, pats)
	})

	t.Run("revoke nonexistent returns 404", func(t *testing.T) {
		ts := setupTestServer(t)
		u := ts.createTestUser(t, "alice", "password123", false)

		req, err := http.NewRequestWithContext(t.Context(), http.MethodDelete, ts.HTTPServer.URL+"/api/v1/pats/doesnotexist1234567", nil)
		require.NoError(t, err)
		resp, err := u.Client.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	})

	t.Run("cannot revoke another user's token", func(t *testing.T) {
		ts := setupTestServer(t)
		alice := ts.createTestUser(t, "alice", "password123", false)
		bob := ts.createTestUser(t, "bob", "password123", false)

		pat := createPAT(t, ts, alice, "alice's token")

		req, err := http.NewRequestWithContext(t.Context(), http.MethodDelete, ts.HTTPServer.URL+"/api/v1/pats/"+pat.ID, nil)
		require.NoError(t, err)
		resp, err := bob.Client.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Equal(t, http.StatusNotFound, resp.StatusCode)

		// Alice's token still exists
		pats := listPATs(t, ts, alice)
		assert.Len(t, pats, 1)
	})

	t.Run("Bearer token authenticates requests", func(t *testing.T) {
		ts := setupTestServer(t)
		u := ts.createTestUser(t, "alice", "password123", false)

		pat := createPAT(t, ts, u, "bearer test")

		// Use a fresh client (no cookies) and authenticate with Bearer token.
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/me", nil)
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+pat.Token)

		freshClient := &http.Client{}
		resp, err := freshClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()

		assert.Equal(t, http.StatusOK, resp.StatusCode)
	})

	t.Run("revoked Bearer token is rejected", func(t *testing.T) {
		ts := setupTestServer(t)
		u := ts.createTestUser(t, "alice", "password123", false)

		pat := createPAT(t, ts, u, "revoke me")
		rawToken := pat.Token

		// Revoke it.
		req, err := http.NewRequestWithContext(t.Context(), http.MethodDelete, ts.HTTPServer.URL+"/api/v1/pats/"+pat.ID, nil)
		require.NoError(t, err)
		resp, err := u.Client.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Equal(t, http.StatusNoContent, resp.StatusCode)

		// Attempt to use the revoked token.
		req2, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/me", nil)
		require.NoError(t, err)
		req2.Header.Set("Authorization", "Bearer "+rawToken)

		freshClient := &http.Client{}
		resp2, err := freshClient.Do(req2)
		require.NoError(t, err)
		defer resp2.Body.Close()
		assert.Equal(t, http.StatusUnauthorized, resp2.StatusCode)
	})

	t.Run("create with empty name returns 400", func(t *testing.T) {
		ts := setupTestServer(t)
		u := ts.createTestUser(t, "alice", "password123", false)

		body, err := json.Marshal(map[string]string{"name": ""})
		require.NoError(t, err)

		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.HTTPServer.URL+"/api/v1/pats", bytes.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")

		resp, err := u.Client.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})

	t.Run("create without auth returns 401", func(t *testing.T) {
		ts := setupTestServer(t)

		body, err := json.Marshal(map[string]string{"name": "test"})
		require.NoError(t, err)

		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.HTTPServer.URL+"/api/v1/pats", bytes.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")

		freshClient := &http.Client{}
		resp, err := freshClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	})

	t.Run("create via Bearer token returns 403", func(t *testing.T) {
		ts := setupTestServer(t)
		u := ts.createTestUser(t, "alice", "password123", false)

		// Create a PAT using cookie auth.
		firstPAT := createPAT(t, ts, u, "first token")

		// Attempt to create another PAT using the first PAT's token (Bearer auth).
		body, err := json.Marshal(map[string]string{"name": "second token"})
		require.NoError(t, err)

		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.HTTPServer.URL+"/api/v1/pats", bytes.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+firstPAT.Token)

		freshClient := &http.Client{}
		resp, err := freshClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	})

	t.Run("revoke via Bearer token returns 403", func(t *testing.T) {
		ts := setupTestServer(t)
		u := ts.createTestUser(t, "alice", "password123", false)

		// Create two PATs via cookie auth.
		firstPAT := createPAT(t, ts, u, "first token")
		secondPAT := createPAT(t, ts, u, "second token")

		// Attempt to revoke the second PAT using the first PAT's Bearer token.
		req, err := http.NewRequestWithContext(t.Context(), http.MethodDelete, ts.HTTPServer.URL+"/api/v1/pats/"+secondPAT.ID, nil)
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+firstPAT.Token)

		freshClient := &http.Client{}
		resp, err := freshClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Equal(t, http.StatusForbidden, resp.StatusCode)

		// Verify the second PAT still exists via cookie auth.
		pats := listPATs(t, ts, u)
		assert.Len(t, pats, 2)
	})

	t.Run("create returns 422 when limit reached", func(t *testing.T) {
		ts := setupTestServer(t)
		u := ts.createTestUser(t, "alice", "password123", false)

		// Create up to the limit.
		for i := range 50 {
			createPAT(t, ts, u, fmt.Sprintf("token-%d", i))
		}

		// The next creation should be rejected.
		body, err := json.Marshal(map[string]string{"name": "one too many"})
		require.NoError(t, err)
		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.HTTPServer.URL+"/api/v1/pats", bytes.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")

		resp, err := u.Client.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Equal(t, http.StatusUnprocessableEntity, resp.StatusCode)
	})

	t.Run("create with expires_at persists and returns it", func(t *testing.T) {
		ts := setupTestServer(t)
		u := ts.createTestUser(t, "alice", "password123", false)

		expires := time.Now().Add(2 * time.Hour).UTC().Truncate(time.Second)
		pat := createPATWithBody(t, ts, u, map[string]any{
			"name":       "short-lived",
			"expires_at": expires.Format(time.RFC3339),
		}, http.StatusCreated)

		require.NotNil(t, pat.ExpiresAt)
		assert.WithinDuration(t, expires, pat.ExpiresAt.UTC(), 2*time.Second)

		pats := listPATs(t, ts, u)
		require.Len(t, pats, 1)
		require.NotNil(t, pats[0].ExpiresAt)
		assert.WithinDuration(t, expires, pats[0].ExpiresAt.UTC(), 2*time.Second)
	})

	t.Run("create without expires_at omits it from responses", func(t *testing.T) {
		ts := setupTestServer(t)
		u := ts.createTestUser(t, "alice", "password123", false)

		pat := createPAT(t, ts, u, "no-expiry")
		assert.Nil(t, pat.ExpiresAt, "expires_at must be null when omitted on create")

		pats := listPATs(t, ts, u)
		require.Len(t, pats, 1)
		assert.Nil(t, pats[0].ExpiresAt)
	})

	t.Run("create with expires_at in the past returns 400", func(t *testing.T) {
		ts := setupTestServer(t)
		u := ts.createTestUser(t, "alice", "password123", false)

		createPATWithBody(t, ts, u, map[string]any{
			"name":       "expired-on-arrival",
			"expires_at": time.Now().Add(-time.Minute).UTC().Format(time.RFC3339),
		}, http.StatusBadRequest)
	})

	t.Run("create with expires_at too soon returns 400", func(t *testing.T) {
		ts := setupTestServer(t)
		u := ts.createTestUser(t, "alice", "password123", false)

		createPATWithBody(t, ts, u, map[string]any{
			"name":       "sub-minute",
			"expires_at": time.Now().Add(10 * time.Second).UTC().Format(time.RFC3339),
		}, http.StatusBadRequest)
	})

	t.Run("create with expires_at more than one year out returns 400", func(t *testing.T) {
		ts := setupTestServer(t)
		u := ts.createTestUser(t, "alice", "password123", false)

		createPATWithBody(t, ts, u, map[string]any{
			"name":       "too-long",
			"expires_at": time.Now().Add(400 * 24 * time.Hour).UTC().Format(time.RFC3339),
		}, http.StatusBadRequest)
	})

	t.Run("expired Bearer token is rejected", func(t *testing.T) {
		ts := setupTestServer(t)
		u := ts.createTestUser(t, "alice", "password123", false)

		// Create a token with a valid expires_at so the handler accepts it,
		// then directly backdate its expiry in the database to simulate the
		// token having expired since creation.
		pat := createPATWithBody(t, ts, u, map[string]any{
			"name":       "expiring",
			"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		}, http.StatusCreated)
		require.NotNil(t, pat.ExpiresAt)

		_, err := ts.Server.GetDB().ExecContext(t.Context(),
			"UPDATE personal_access_tokens SET expires_at = ? WHERE id = ?",
			time.Now().Add(-time.Hour), pat.ID)
		require.NoError(t, err)

		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/me", nil)
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+pat.Token)

		freshClient := &http.Client{}
		resp, err := freshClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)

		// The expired token is still listed (owner still sees it) until the
		// background cleanup task runs or it is explicitly revoked.
		pats := listPATs(t, ts, u)
		require.Len(t, pats, 1)
		require.NotNil(t, pats[0].ExpiresAt)
	})

	t.Run("background cleanup purges expired tokens", func(t *testing.T) {
		ts := setupTestServer(t)
		u := ts.createTestUser(t, "alice", "password123", false)

		keep := createPAT(t, ts, u, "no-expiry")
		future := createPATWithBody(t, ts, u, map[string]any{
			"name":       "future",
			"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		}, http.StatusCreated)
		past := createPATWithBody(t, ts, u, map[string]any{
			"name":       "expires-soon",
			"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		}, http.StatusCreated)

		// Backdate the "expires-soon" token so it is effectively expired.
		_, err := ts.Server.GetDB().ExecContext(t.Context(),
			"UPDATE personal_access_tokens SET expires_at = ? WHERE id = ?",
			time.Now().Add(-time.Minute), past.ID)
		require.NoError(t, err)

		// Directly invoke the model-level cleanup that the periodic task runs.
		d := &dialect.Dialect{Driver: "sqlite"}
		store, err := models.NewPATStore(ts.Server.GetDB(), d)
		require.NoError(t, err)
		n, err := store.DeleteExpired(t.Context())
		require.NoError(t, err)
		assert.Equal(t, int64(1), n, "exactly one token should be purged")

		pats := listPATs(t, ts, u)
		ids := make(map[string]bool, len(pats))
		for _, p := range pats {
			ids[p.ID] = true
		}
		assert.True(t, ids[keep.ID], "tokens without expiry must not be purged")
		assert.True(t, ids[future.ID], "tokens with a future expiry must not be purged")
		assert.False(t, ids[past.ID], "expired token must be purged")
	})
}
