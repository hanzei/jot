package main

import (
	"bytes"
	"net/http"
	"strings"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/apierr"
	"github.com/hanzei/jot/server/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// deleteMe sends DELETE /users/me with the given JSON body via the session
// client c and returns the response.
func (ts *TestServer) deleteMe(t *testing.T, c *http.Client, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodDelete, ts.HTTPServer.URL+"/api/v1/users/me", strings.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Do(req)
	require.NoError(t, err)
	return resp
}

func TestDeleteMeWithPassword(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	// The first account to register becomes the admin, and the last admin
	// cannot delete itself; take that seat so the user under test is plain.
	ts.createTestUser(t, "seatadmin", "password123", true)
	user := ts.createTestUser(t, "deleteme", "password123", false)

	t.Run("missing password returns 400", func(t *testing.T) {
		err := user.Client.DeleteMe(t.Context(), "", "")
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("username does not stand in for a password", func(t *testing.T) {
		err := user.Client.DeleteMe(t.Context(), "", "deleteme")
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("wrong password returns 403 incorrect_password", func(t *testing.T) {
		err := user.Client.DeleteMe(t.Context(), "wrongpassword", "")
		assert.Equal(t, http.StatusForbidden, client.StatusCode(err))
		assert.Equal(t, string(apierr.CodeIncorrectPassword), client.ErrorCode(err))

		_, err = user.Client.Me(t.Context())
		require.NoError(t, err, "a refused delete leaves the account in place")
	})

	t.Run("unauthenticated request returns 401", func(t *testing.T) {
		err := ts.newClient().DeleteMe(t.Context(), "password123", "")
		assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
	})

	t.Run("correct password deletes the account and clears the cookie", func(t *testing.T) {
		c := sessionClientFrom(t, ts, user)
		resp := ts.deleteMe(t, c, `{"current_password":"password123"}`)
		require.NoError(t, resp.Body.Close())
		require.Equal(t, http.StatusNoContent, resp.StatusCode)

		var cleared bool
		for _, ck := range resp.Cookies() {
			if ck.Value == "" && ck.MaxAge < 0 {
				cleared = true
			}
		}
		assert.True(t, cleared, "the response clears the session cookie")

		_, err := user.Client.Me(t.Context())
		assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err), "the session no longer works")

		_, err = ts.newClient().Login(t.Context(), "deleteme", "password123")
		assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err), "the account is gone")
	})
}

// TestDeleteMeRemovesCredentials checks that every session and personal
// access token goes with the account (they cascade from the users row).
func TestDeleteMeRemovesCredentials(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	// The first account to register becomes the admin, and the last admin
	// cannot delete itself; take that seat so the user under test is plain.
	ts.createTestUser(t, "seatadmin", "password123", true)
	user := ts.createTestUser(t, "credsuser", "password123", false)

	otherDevice := ts.newClient()
	_, err := otherDevice.Login(t.Context(), "credsuser", "password123")
	require.NoError(t, err)
	pat := createPAT(t, ts, user, "script")

	require.NoError(t, user.Client.DeleteMe(t.Context(), "password123", ""))

	_, err = otherDevice.Me(t.Context())
	assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err), "another session of the user no longer works")

	status, _, _ := rawRequest(t, ts.newClient().HTTPClient(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/users/me", nil,
		http.Header{"Authorization": {"Bearer " + pat.Token}})
	assert.Equal(t, http.StatusUnauthorized, status, "the user's personal access token no longer works")

	var sessions, pats int
	require.NoError(t, ts.queryRow(t, "SELECT COUNT(*) FROM sessions WHERE user_id = ?", user.User.ID).Scan(&sessions))
	require.NoError(t, ts.queryRow(t, "SELECT COUNT(*) FROM personal_access_tokens WHERE user_id = ?", user.User.ID).Scan(&pats))
	assert.Zero(t, sessions)
	assert.Zero(t, pats)
}

func TestDeleteMeRequiresSession(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	// The first account to register becomes the admin, and the last admin
	// cannot delete itself; take that seat so the user under test is plain.
	ts.createTestUser(t, "seatadmin", "password123", true)
	user := ts.createTestUser(t, "patdelete", "password123", false)
	pat := createPAT(t, ts, user, "script")

	status, header, body := rawRequest(t, ts.newClient().HTTPClient(), http.MethodDelete, ts.HTTPServer.URL+"/api/v1/users/me",
		strings.NewReader(`{"current_password":"password123"}`),
		http.Header{"Authorization": {"Bearer " + pat.Token}, "Content-Type": {"application/json"}})
	requireEnvelope(t, http.StatusForbidden, string(apierr.CodeSessionRequired), status, header, body)

	_, err := user.Client.Me(t.Context())
	require.NoError(t, err, "a personal access token cannot delete the account")
}

func TestDeleteMeNotesAndImages(t *testing.T) {
	t.Parallel()
	var uploadDir string
	ts := setupTestServerWithConfig(t, func(cfg *config.Config) { uploadDir = cfg.UploadDir })
	// The first account to register becomes the admin, and the last admin
	// cannot delete itself; take that seat so the user under test is plain.
	ts.createTestUser(t, "seatadmin", "password123", true)
	leaving := ts.createTestUser(t, "leaving", "password123", false)
	staying := ts.createTestUser(t, "staying", "password123", false)

	// A note the leaving user owns and shared out, with an image.
	owned, err := leaving.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "mine"})
	require.NoError(t, err)
	_, err = leaving.Client.UploadNoteImage(t.Context(), owned.ID, "cat.png", bytes.NewReader(testPNG(t, 4, 4)))
	require.NoError(t, err)
	require.NoError(t, leaving.Client.ShareNote(t.Context(), owned.ID, staying.User.ID))

	// A note shared with the leaving user, which stays with its owner.
	sharedIn, err := staying.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "theirs"})
	require.NoError(t, err)
	require.NoError(t, staying.Client.ShareNote(t.Context(), sharedIn.ID, leaving.User.ID))

	assert.Equal(t, blobCounts{blobs: 1, thumbs: 1}, countBlobs(t, uploadDir))

	require.NoError(t, leaving.Client.DeleteMe(t.Context(), "password123", ""))

	assert.Equal(t, blobCounts{blobs: 0, thumbs: 0}, countBlobs(t, uploadDir), "the user's images are reclaimed")

	_, err = staying.Client.GetNote(t.Context(), owned.ID)
	assert.Equal(t, http.StatusNotFound, client.StatusCode(err), "the user's own notes go, even ones shared out")

	kept, err := staying.Client.GetNote(t.Context(), sharedIn.ID)
	require.NoError(t, err, "a note shared with the user stays with its owner")
	assert.Equal(t, "theirs", kept.Content)
}

func TestDeleteMeLastAdmin(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	admin := ts.createTestUser(t, "onlyadmin", "password123", true)

	t.Run("the only admin is refused with 409 last_admin", func(t *testing.T) {
		err := admin.Client.DeleteMe(t.Context(), "password123", "")
		assert.Equal(t, http.StatusConflict, client.StatusCode(err))
		assert.Equal(t, string(apierr.CodeLastAdmin), client.ErrorCode(err))
		assert.Contains(t, err.Error(), "promote another user to admin first")

		_, err = admin.Client.Me(t.Context())
		require.NoError(t, err)
	})

	t.Run("an admin can leave once another admin exists", func(t *testing.T) {
		ts.createTestUser(t, "secondadmin", "password123", true)
		require.NoError(t, admin.Client.DeleteMe(t.Context(), "password123", ""))
	})
}

func TestAdminDeleteUserSelf(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	admin := ts.createTestUser(t, "selfadmin", "password123", true)
	ts.createTestUser(t, "otheradmin", "password123", true)

	// Even with another admin around, the admin endpoint does not delete the
	// caller: that goes through DELETE /users/me, which re-authenticates.
	err := admin.Client.AdminDeleteUser(t.Context(), admin.User.ID)
	assert.Equal(t, http.StatusForbidden, client.StatusCode(err))
	assert.Equal(t, string(apierr.CodeCannotDeleteSelf), client.ErrorCode(err))
}

func TestDeleteMeSSOUser(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name                string
		registrationEnabled bool
	}{
		{"registration enabled", true},
		{"registration disabled", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			ts, mock := setupOIDCTestServer(t, func(cfg *config.Config) {
				cfg.RegistrationEnabled = tc.registrationEnabled
			})
			claims := map[string]any{"sub": "sub-leaver", "preferred_username": "ssoleaver"}

			c := ts.oidcClient(t)
			resp := ts.driveFlow(t, mock, c, "/api/v1/auth/oidc/login", claims)
			require.NoError(t, resp.Body.Close())
			me, status := ts.me(t, c)
			require.Equal(t, http.StatusOK, status)
			require.False(t, me.User.HasPassword)
			firstID := me.User.ID

			// Give the account a note so the new one can be told apart.
			resp = ts.postJSONWith(t, c, "/api/v1/notes", `{"content":"before"}`)
			require.NoError(t, resp.Body.Close())
			require.Equal(t, http.StatusCreated, resp.StatusCode)

			resp = ts.deleteMe(t, c, `{}`)
			require.NoError(t, resp.Body.Close())
			assert.Equal(t, http.StatusBadRequest, resp.StatusCode, "username is required")

			resp = ts.deleteMe(t, c, `{"current_password":"anything"}`)
			require.NoError(t, resp.Body.Close())
			assert.Equal(t, http.StatusBadRequest, resp.StatusCode, "a password does not stand in for the username")

			status, header, body := rawRequest(t, c, http.MethodDelete, ts.HTTPServer.URL+"/api/v1/users/me",
				strings.NewReader(`{"username":"someoneelse"}`), http.Header{"Content-Type": {"application/json"}})
			requireEnvelope(t, http.StatusForbidden, string(apierr.CodeIncorrectUsername), status, header, body)

			// The comparison ignores case.
			resp = ts.deleteMe(t, c, `{"username":"SSOLeaver"}`)
			require.NoError(t, resp.Body.Close())
			require.Equal(t, http.StatusNoContent, resp.StatusCode)

			_, status = ts.me(t, c)
			require.Equal(t, http.StatusUnauthorized, status)

			// The next SSO login provisions a new, empty account, whether or
			// not self-registration is enabled: the IdP gates SSO access.
			c2 := ts.oidcClient(t)
			resp = ts.driveFlow(t, mock, c2, "/api/v1/auth/oidc/login", claims)
			require.NoError(t, resp.Body.Close())
			me, status = ts.me(t, c2)
			require.Equal(t, http.StatusOK, status)
			assert.NotEqual(t, firstID, me.User.ID, "a new account, not the deleted one")

			var notes int
			require.NoError(t, ts.queryRow(t, "SELECT COUNT(*) FROM notes WHERE user_id = ?", me.User.ID).Scan(&notes))
			assert.Zero(t, notes, "the new account starts empty")
		})
	}
}

// postJSONWith POSTs a JSON body via the session client c.
func (ts *TestServer) postJSONWith(t *testing.T, c *http.Client, path, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.HTTPServer.URL+path, strings.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Do(req)
	require.NoError(t, err)
	return resp
}
