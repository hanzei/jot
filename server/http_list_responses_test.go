package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestListResponses pins the wire format of the list endpoints: an object
// keyed by the resource name, whose array is [] rather than null when empty,
// so fields such as a cursor can be added later without breaking parsers.
func TestListResponses(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	alice := ts.createTestUser(t, "alice", "password123", false)

	note, err := alice.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "hello"})
	require.NoError(t, err)

	cases := []struct {
		path string
		key  string
	}{
		{"/api/v1/labels", "labels"},
		{"/api/v1/pats", "pats"},
		{"/api/v1/notes?archived=true", "notes"},
		{"/api/v1/notes/" + note.ID + "/shares", "shares"},
		{"/api/v1/users", "users"},
		{"/api/v1/users?search=nobody", "users"},
	}
	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			status, _, body := rawRequest(t, alice.Client.HTTPClient(), http.MethodGet, ts.HTTPServer.URL+tc.path, nil, nil)
			require.Equal(t, http.StatusOK, status, "body: %s", body)

			var obj map[string]json.RawMessage
			require.NoError(t, json.Unmarshal(body, &obj), "body is not a JSON object: %s", body)
			assert.JSONEq(t, `[]`, string(obj[tc.key]), "empty %q must be [], body: %s", tc.key, body)
		})
	}

	t.Run("/api/v1/sessions", func(t *testing.T) {
		// Never empty for a session-authenticated caller: it holds its own.
		status, _, body := rawRequest(t, alice.Client.HTTPClient(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/sessions", nil, nil)
		require.Equal(t, http.StatusOK, status, "body: %s", body)
		var resp struct {
			Sessions []json.RawMessage `json:"sessions"`
		}
		require.NoError(t, json.Unmarshal(body, &resp))
		assert.Len(t, resp.Sessions, 1)
	})
}

func TestUserSearchCap(t *testing.T) {
	t.Parallel()
	// Registering this many users would trip the per-IP auth rate limit.
	ts := setupTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.RateLimitEnabled = false
	})
	searcher := ts.createTestUser(t, "searcher", "password123", false)
	for i := range 51 {
		ts.createTestUser(t, fmt.Sprintf("member%02d", i), "password123", false)
	}

	search := func(t *testing.T, term string) *client.UserSearchPage {
		t.Helper()
		page, err := searcher.Client.SearchUsersPage(t.Context(), term)
		require.NoError(t, err)
		return page
	}

	t.Run("a search matching more than the cap is truncated", func(t *testing.T) {
		page := search(t, "member")
		assert.Len(t, page.Users, 50)
		assert.True(t, page.Truncated)
	})

	t.Run("a search within the cap is not truncated", func(t *testing.T) {
		page := search(t, "member0")
		assert.Len(t, page.Users, 10)
		assert.False(t, page.Truncated)
	})

	t.Run("the searcher is excluded and does not count against the cap", func(t *testing.T) {
		// "e" matches all 52 users including the searcher, who is excluded in
		// SQL: 51 others, so still truncated at 50 with no searcher among them.
		page := search(t, "e")
		assert.Len(t, page.Users, 50)
		assert.True(t, page.Truncated)
		for _, u := range page.Users {
			assert.NotEqual(t, searcher.User.ID, u.ID)
		}
	})

	t.Run("listing without a term is not capped", func(t *testing.T) {
		page := search(t, "")
		assert.Len(t, page.Users, 51)
		assert.False(t, page.Truncated)
	})
}
