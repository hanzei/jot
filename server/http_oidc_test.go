package main

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// mockOIDC is an in-test OpenID Connect provider: it serves a discovery
// document, a JWKS built from a freshly generated RSA key, and a token endpoint
// that returns a signed ID token for a previously registered authorization
// code. No real network or external IdP is involved.
type mockOIDC struct {
	server   *httptest.Server
	key      *rsa.PrivateKey
	clientID string

	mu    sync.Mutex
	codes map[string]map[string]any // authorization code -> ID-token claims
}

const mockOIDCKeyID = "test-key-1"

func newMockOIDC(t *testing.T, clientID string) *mockOIDC {
	t.Helper()

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)

	m := &mockOIDC{
		key:      key,
		clientID: clientID,
		codes:    map[string]map[string]any{},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]any{
			"issuer":                                m.issuer(),
			"authorization_endpoint":                m.issuer() + "/authorize",
			"token_endpoint":                        m.issuer() + "/token",
			"jwks_uri":                              m.issuer() + "/jwks",
			"response_types_supported":              []string{"code"},
			"subject_types_supported":               []string{"public"},
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, m.jwks())
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			http.Error(w, "bad form", http.StatusBadRequest)
			return
		}
		code := r.FormValue("code")
		m.mu.Lock()
		claims, ok := m.codes[code]
		m.mu.Unlock()
		if !ok {
			http.Error(w, "unknown code", http.StatusBadRequest)
			return
		}
		writeJSON(w, map[string]any{
			"access_token": "mock-access-token",
			"token_type":   "Bearer",
			"id_token":     m.signIDToken(t, claims),
		})
	})

	m.server = httptest.NewServer(mux)
	t.Cleanup(m.server.Close)
	return m
}

func (m *mockOIDC) issuer() string { return m.server.URL }

// jwks renders the public half of the signing key as a JWKS document.
func (m *mockOIDC) jwks() map[string]any {
	pub := m.key.PublicKey
	eBytes := big.NewInt(int64(pub.E)).Bytes()
	return map[string]any{
		"keys": []map[string]any{{
			"kty": "RSA",
			"alg": "RS256",
			"use": "sig",
			"kid": mockOIDCKeyID,
			"n":   base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
			"e":   base64.RawURLEncoding.EncodeToString(eBytes),
		}},
	}
}

// signIDToken builds and RS256-signs a JWT carrying claims.
func (m *mockOIDC) signIDToken(t *testing.T, claims map[string]any) string {
	t.Helper()
	header := map[string]any{"alg": "RS256", "typ": "JWT", "kid": mockOIDCKeyID}
	segment := func(v any) string {
		b, err := json.Marshal(v)
		require.NoError(t, err)
		return base64.RawURLEncoding.EncodeToString(b)
	}
	signingInput := segment(header) + "." + segment(claims)
	digest := sha256.Sum256([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(rand.Reader, m.key, crypto.SHA256, digest[:])
	require.NoError(t, err)
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// registerCode stores the ID-token claims to return when the token endpoint is
// called with the given code, filling in the standard iss/aud/exp/iat fields.
func (m *mockOIDC) registerCode(code, nonce string, claims map[string]any) {
	full := map[string]any{
		"iss":   m.issuer(),
		"aud":   m.clientID,
		"exp":   time.Now().Add(time.Hour).Unix(),
		"iat":   time.Now().Unix(),
		"nonce": nonce,
	}
	for k, v := range claims {
		full[k] = v
	}
	m.mu.Lock()
	m.codes[code] = full
	m.mu.Unlock()
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// setupOIDCTestServer builds a Jot server wired to a fresh mock OIDC provider.
// customize can further adjust the config (e.g. disable local login) before the
// server is constructed.
func setupOIDCTestServer(t *testing.T, customize func(*config.Config)) (*TestServer, *mockOIDC) {
	t.Helper()
	const clientID = "jot-test-client"
	mock := newMockOIDC(t, clientID)

	ts := setupTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.OIDCEnabled = true
		cfg.OIDCIssuer = mock.issuer()
		cfg.OIDCClientID = clientID
		cfg.OIDCClientSecret = "test-secret"
		cfg.OIDCRedirectURL = "http://localhost/api/v1/auth/oidc/callback"
		cfg.OIDCScopes = []string{"openid", "profile", "email"}
		cfg.OIDCUsernameClaim = "preferred_username"
		cfg.OIDCProviderName = "Test SSO"
		cfg.LocalLoginEnabled = true
		if customize != nil {
			customize(cfg)
		}
	})
	return ts, mock
}

// oidcClient returns an HTTP client on the test server's transport that keeps
// cookies (so the flow cookie and resulting session cookie carry across
// requests) and does not auto-follow redirects (so the 302s are inspectable).
func (ts *TestServer) oidcClient(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	c := *ts.httpClient
	c.Jar = jar
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &c
}

// driveFlow runs an OIDC flow end to end against the mock: it GETs startPath
// (login or link), reads state+nonce out of the redirect to the IdP, registers
// the ID-token claims for a synthetic code, and GETs the callback. It returns
// the callback's response.
func (ts *TestServer) driveFlow(t *testing.T, mock *mockOIDC, c *http.Client, startPath string, claims map[string]any) *http.Response {
	t.Helper()

	startReq, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+startPath, nil)
	require.NoError(t, err)
	startResp, err := c.Do(startReq)
	require.NoError(t, err)
	defer startResp.Body.Close()
	require.Equal(t, http.StatusFound, startResp.StatusCode, "start should redirect to the IdP")

	loc, err := url.Parse(startResp.Header.Get("Location"))
	require.NoError(t, err)
	state := loc.Query().Get("state")
	nonce := loc.Query().Get("nonce")
	require.NotEmpty(t, state)
	require.NotEmpty(t, nonce)

	code := "code-" + state[:8]
	mock.registerCode(code, nonce, claims)

	cbURL := fmt.Sprintf("%s/api/v1/auth/oidc/callback?code=%s&state=%s", ts.HTTPServer.URL, code, url.QueryEscape(state))
	cbReq, err := http.NewRequestWithContext(t.Context(), http.MethodGet, cbURL, nil)
	require.NoError(t, err)
	cbResp, err := c.Do(cbReq)
	require.NoError(t, err)
	return cbResp
}

// meResponse is the subset of GET /me the OIDC tests assert on.
type meResponse struct {
	User client.User `json:"user"`
}

func (ts *TestServer) me(t *testing.T, c *http.Client) (meResponse, int) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/me", nil)
	require.NoError(t, err)
	resp, err := c.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return meResponse{}, resp.StatusCode
	}
	var me meResponse
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&me))
	return me, resp.StatusCode
}

func TestOIDCConfigEndpoint(t *testing.T) {
	t.Parallel()

	t.Run("reports sso disabled by default", func(t *testing.T) {
		ts := setupTestServer(t)
		cfg, err := ts.newClient().Config(t.Context())
		require.NoError(t, err)
		assert.False(t, cfg.SSO.Enabled)
		assert.True(t, cfg.SSO.LocalLoginEnabled)
	})

	t.Run("reports sso details when configured", func(t *testing.T) {
		ts, _ := setupOIDCTestServer(t, nil)
		cfg, err := ts.newClient().Config(t.Context())
		require.NoError(t, err)
		assert.True(t, cfg.SSO.Enabled)
		assert.Equal(t, "Test SSO", cfg.SSO.ProviderName)
		assert.True(t, cfg.SSO.LocalLoginEnabled)
	})
}

func TestOIDCLoginProvisionsAndMatches(t *testing.T) {
	t.Parallel()
	ts, mock := setupOIDCTestServer(t, nil)

	t.Run("first login provisions a new plain user", func(t *testing.T) {
		c := ts.oidcClient(t)
		resp := ts.driveFlow(t, mock, c, "/api/v1/auth/oidc/login", map[string]any{
			"sub":                "sub-alice",
			"preferred_username": "alice",
			"email":              "alice@example.com",
		})
		defer resp.Body.Close()
		require.Equal(t, http.StatusFound, resp.StatusCode)
		assert.Equal(t, "/", resp.Header.Get("Location"))

		me, status := ts.me(t, c)
		require.Equal(t, http.StatusOK, status, "the callback should have issued a session")
		assert.Equal(t, "alice", me.User.Username)
		// Mixed mode (local login enabled): an SSO user is a plain user.
		assert.Equal(t, client.RoleUser, me.User.Role)
	})

	t.Run("returning login matches the same account", func(t *testing.T) {
		c := ts.oidcClient(t)
		resp := ts.driveFlow(t, mock, c, "/api/v1/auth/oidc/login", map[string]any{
			"sub":                "sub-alice",
			"preferred_username": "alice-renamed-at-idp", // ignored; sub is the key
			"email":              "alice@example.com",
		})
		defer resp.Body.Close()
		require.Equal(t, http.StatusFound, resp.StatusCode)

		me, status := ts.me(t, c)
		require.Equal(t, http.StatusOK, status)
		// Same account as the first login: the username was seeded once and is
		// not overwritten on subsequent logins.
		assert.Equal(t, "alice", me.User.Username)
	})
}

func TestOIDCUsernameDeduplication(t *testing.T) {
	t.Parallel()
	ts, mock := setupOIDCTestServer(t, nil)

	// A local user already holds "dupe".
	ts.createTestUser(t, "dupe", "password123", false)

	c := ts.oidcClient(t)
	resp := ts.driveFlow(t, mock, c, "/api/v1/auth/oidc/login", map[string]any{
		"sub":                "sub-dupe",
		"preferred_username": "dupe",
	})
	defer resp.Body.Close()
	require.Equal(t, http.StatusFound, resp.StatusCode)

	me, status := ts.me(t, c)
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, "dupe-2", me.User.Username, "colliding username is de-duplicated with a suffix")
}

func TestOIDCSsoOnlyFirstUserIsAdmin(t *testing.T) {
	t.Parallel()
	// SSO-only deployment (local login disabled): the first provisioned user
	// must become admin, or the deployment could never obtain one.
	ts, mock := setupOIDCTestServer(t, func(cfg *config.Config) {
		cfg.LocalLoginEnabled = false
	})

	c := ts.oidcClient(t)
	resp := ts.driveFlow(t, mock, c, "/api/v1/auth/oidc/login", map[string]any{
		"sub":                "sub-admin",
		"preferred_username": "founder",
	})
	defer resp.Body.Close()
	require.Equal(t, http.StatusFound, resp.StatusCode)

	me, status := ts.me(t, c)
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, client.RoleAdmin, me.User.Role)

	// A second SSO user is a plain user.
	c2 := ts.oidcClient(t)
	resp2 := ts.driveFlow(t, mock, c2, "/api/v1/auth/oidc/login", map[string]any{
		"sub":                "sub-second",
		"preferred_username": "second",
	})
	defer resp2.Body.Close()
	me2, status2 := ts.me(t, c2)
	require.Equal(t, http.StatusOK, status2)
	assert.Equal(t, client.RoleUser, me2.User.Role)
}

func TestOIDCLocalLoginDisabledRejectsPasswordAuth(t *testing.T) {
	t.Parallel()
	// SSO-only deployment: the webapp hides the password form, but the server
	// must also refuse password login and registration on the API, or the
	// boundary is cosmetic only.
	ts, mock := setupOIDCTestServer(t, func(cfg *config.Config) {
		cfg.LocalLoginEnabled = false
	})

	t.Run("login is forbidden", func(t *testing.T) {
		_, err := ts.newClient().Login(t.Context(), "someone", "password123")
		assert.Equal(t, http.StatusForbidden, client.StatusCode(err))
	})

	t.Run("registration is forbidden", func(t *testing.T) {
		_, err := ts.newClient().Register(t.Context(), "someone", "password123")
		assert.Equal(t, http.StatusForbidden, client.StatusCode(err))
	})

	t.Run("SSO login still works", func(t *testing.T) {
		c := ts.oidcClient(t)
		resp := ts.driveFlow(t, mock, c, "/api/v1/auth/oidc/login", map[string]any{
			"sub":                "sub-ssoonly",
			"preferred_username": "ssoonly",
		})
		defer resp.Body.Close()
		// Provisioned and logged in despite local login being disabled.
		assert.Equal(t, http.StatusFound, resp.StatusCode)
	})
}

func TestOIDCCallbackRejectsTamperedState(t *testing.T) {
	t.Parallel()
	ts, _ := setupOIDCTestServer(t, nil)
	c := ts.oidcClient(t)

	// Begin a flow to obtain a valid flow cookie, then call the callback with a
	// state that does not match the cookie.
	startReq, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/auth/oidc/login", nil)
	require.NoError(t, err)
	startResp, err := c.Do(startReq)
	require.NoError(t, err)
	require.NoError(t, startResp.Body.Close())

	cbReq, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/auth/oidc/callback?code=x&state=wrong-state", nil)
	require.NoError(t, err)
	cbResp, err := c.Do(cbReq)
	require.NoError(t, err)
	defer cbResp.Body.Close()
	assert.Equal(t, http.StatusBadRequest, cbResp.StatusCode)
}

func TestOIDCLinkAndUnlink(t *testing.T) {
	t.Parallel()
	ts, mock := setupOIDCTestServer(t, nil)

	t.Run("local user links SSO then logs in via SSO to the same account", func(t *testing.T) {
		// A logged-in local user runs the link flow on the same client (so its
		// session cookie authenticates the /link start).
		user := ts.createTestUser(t, "linker", "password123", false)
		linkClient := sessionClientFrom(t, ts, user)

		resp := ts.driveFlow(t, mock, linkClient, "/api/v1/auth/oidc/link", map[string]any{
			"sub":                "sub-linker",
			"preferred_username": "linker",
		})
		require.NoError(t, resp.Body.Close())
		require.Equal(t, http.StatusFound, resp.StatusCode)

		// A fresh SSO login for that identity resolves to the same account.
		ssoClient := ts.oidcClient(t)
		loginResp := ts.driveFlow(t, mock, ssoClient, "/api/v1/auth/oidc/login", map[string]any{
			"sub":                "sub-linker",
			"preferred_username": "ignored",
		})
		require.NoError(t, loginResp.Body.Close())
		me, status := ts.me(t, ssoClient)
		require.Equal(t, http.StatusOK, status)
		assert.Equal(t, "linker", me.User.Username)
		assert.Equal(t, user.User.ID, me.User.ID)
		assert.True(t, me.User.HasPassword, "a local user keeps its password after linking")
	})

	t.Run("linking an identity already bound to another user is rejected", func(t *testing.T) {
		// sub-linker is already bound above. A different local user cannot claim it.
		other := ts.createTestUser(t, "other", "password123", false)
		otherClient := sessionClientFrom(t, ts, other)

		resp := ts.driveFlow(t, mock, otherClient, "/api/v1/auth/oidc/link", map[string]any{
			"sub":                "sub-linker",
			"preferred_username": "other",
		})
		defer resp.Body.Close()
		assert.Equal(t, http.StatusConflict, resp.StatusCode)
	})

	t.Run("unlink is blocked for a password-less SSO user until a password is set", func(t *testing.T) {
		// Provision a fresh password-less SSO user.
		c := ts.oidcClient(t)
		provResp := ts.driveFlow(t, mock, c, "/api/v1/auth/oidc/login", map[string]any{
			"sub":                "sub-noPassword",
			"preferred_username": "nopass",
		})
		require.NoError(t, provResp.Body.Close())

		// Unlink is refused (422) because the account would be stranded.
		unlinkResp := ts.postForm(t, c, "/api/v1/auth/oidc/unlink")
		require.NoError(t, unlinkResp.Body.Close())
		assert.Equal(t, http.StatusUnprocessableEntity, unlinkResp.StatusCode)
	})
}

func TestOIDCSSOUserSetsPassword(t *testing.T) {
	t.Parallel()
	ts, mock := setupOIDCTestServer(t, nil)

	c := ts.oidcClient(t)
	provResp := ts.driveFlow(t, mock, c, "/api/v1/auth/oidc/login", map[string]any{
		"sub":                "sub-setpass",
		"preferred_username": "setpass",
	})
	require.NoError(t, provResp.Body.Close())

	me, status := ts.me(t, c)
	require.Equal(t, http.StatusOK, status)
	assert.False(t, me.User.HasPassword, "an SSO-provisioned user starts without a password")
	assert.True(t, me.User.HasSSOLinked)

	t.Run("a too-short password is rejected", func(t *testing.T) {
		resp := ts.putPassword(t, c, `{"new_password":"x"}`)
		require.NoError(t, resp.Body.Close())
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})

	t.Run("the first password is set without current_password", func(t *testing.T) {
		resp := ts.putPassword(t, c, `{"new_password":"newpassword123"}`)
		require.NoError(t, resp.Body.Close())
		require.Equal(t, http.StatusNoContent, resp.StatusCode)

		me, status := ts.me(t, c)
		require.Equal(t, http.StatusOK, status, "the request's session is reissued")
		assert.True(t, me.User.HasPassword)

		// The new password signs in.
		_, err := ts.newClient().Login(t.Context(), "setpass", "newpassword123")
		require.NoError(t, err)
	})

	t.Run("once set, current_password is required again", func(t *testing.T) {
		resp := ts.putPassword(t, c, `{"new_password":"anotherpassword123"}`)
		require.NoError(t, resp.Body.Close())
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)

		resp = ts.putPassword(t, c, `{"current_password":"wrong-password","new_password":"anotherpassword123"}`)
		require.NoError(t, resp.Body.Close())
		assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	})

	t.Run("unlink now succeeds", func(t *testing.T) {
		resp := ts.postForm(t, c, "/api/v1/auth/oidc/unlink")
		require.NoError(t, resp.Body.Close())
		assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	})
}

func TestOIDCSSOUserCannotSetPasswordWhenLocalLoginDisabled(t *testing.T) {
	t.Parallel()
	// SSO-only deployment: a password could not sign in, so setting a first
	// one is refused rather than creating an unusable credential.
	ts, mock := setupOIDCTestServer(t, func(cfg *config.Config) {
		cfg.LocalLoginEnabled = false
	})

	c := ts.oidcClient(t)
	provResp := ts.driveFlow(t, mock, c, "/api/v1/auth/oidc/login", map[string]any{
		"sub":                "sub-ssoonly-setpass",
		"preferred_username": "ssoonlysetpass",
	})
	require.NoError(t, provResp.Body.Close())

	resp := ts.putPassword(t, c, `{"new_password":"newpassword123"}`)
	require.NoError(t, resp.Body.Close())
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)

	me, status := ts.me(t, c)
	require.Equal(t, http.StatusOK, status)
	assert.False(t, me.User.HasPassword)
}

func TestOIDCUnlinkForbiddenWhenLocalLoginDisabled(t *testing.T) {
	t.Parallel()
	// SSO-only deployment: a password cannot be used to sign in, so unlinking
	// would orphan even an account that has one — its next SSO login would
	// provision a fresh, empty account.
	ts, mock := setupOIDCTestServer(t, func(cfg *config.Config) {
		cfg.LocalLoginEnabled = false
	})

	claims := map[string]any{
		"sub":                "sub-haspass",
		"preferred_username": "haspass",
	}
	c := ts.oidcClient(t)
	provResp := ts.driveFlow(t, mock, c, "/api/v1/auth/oidc/login", claims)
	require.NoError(t, provResp.Body.Close())
	me, status := ts.me(t, c)
	require.Equal(t, http.StatusOK, status)

	// Give the account a password, as one carried over from mixed mode would
	// have, so the store's strand guard alone would let the unlink through.
	_, err := ts.Server.GetDB().Exec("UPDATE users SET password_hash = ? WHERE id = ?", "legacy-hash", me.User.ID)
	require.NoError(t, err)

	unlinkResp := ts.postForm(t, c, "/api/v1/auth/oidc/unlink")
	require.NoError(t, unlinkResp.Body.Close())
	assert.Equal(t, http.StatusForbidden, unlinkResp.StatusCode)

	// The identity is still bound: a fresh SSO login reaches the same account.
	c2 := ts.oidcClient(t)
	loginResp := ts.driveFlow(t, mock, c2, "/api/v1/auth/oidc/login", claims)
	require.NoError(t, loginResp.Body.Close())
	me2, status2 := ts.me(t, c2)
	require.Equal(t, http.StatusOK, status2)
	assert.Equal(t, me.User.ID, me2.User.ID)
}

func TestOIDCProvisionedUserCanUsePAT(t *testing.T) {
	t.Parallel()
	ts, mock := setupOIDCTestServer(t, nil)

	// Provision a password-less SSO user and keep its session client.
	c := ts.oidcClient(t)
	resp := ts.driveFlow(t, mock, c, "/api/v1/auth/oidc/login", map[string]any{
		"sub":                "sub-pat",
		"preferred_username": "patuser",
	})
	require.NoError(t, resp.Body.Close())
	me, status := ts.me(t, c)
	require.Equal(t, http.StatusOK, status)

	// Create a PAT via the session, then use it as a Bearer token — proving a
	// password-less user is fully functional for machine-to-machine access.
	rawToken := ts.createPAT(t, c, "ci-token")
	require.NotEmpty(t, rawToken)

	// Use the PAT as a Bearer token on a cookie-less client.
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/me", nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+rawToken)
	patResp, err := ts.HTTPServer.Client().Do(req)
	require.NoError(t, err)
	defer patResp.Body.Close()
	require.Equal(t, http.StatusOK, patResp.StatusCode)

	var patMe meResponse
	require.NoError(t, json.NewDecoder(patResp.Body).Decode(&patMe))
	assert.Equal(t, me.User.ID, patMe.User.ID)
	assert.Equal(t, "patuser", patMe.User.Username)
}

// sessionClientFrom returns an HTTP client (cookie-keeping, no redirect follow)
// already carrying user's session cookie, so it can start an authenticated OIDC
// link flow.
func sessionClientFrom(t *testing.T, ts *TestServer, user *TestUser) *http.Client {
	t.Helper()
	c := ts.oidcClient(t)
	base, err := url.Parse(ts.HTTPServer.URL)
	require.NoError(t, err)
	// Copy the session cookie from the TestUser's SDK client jar onto this jar.
	c.Jar.SetCookies(base, user.Client.HTTPClient().Jar.Cookies(base))
	return c
}

// postForm issues an authenticated POST with no body using client c.
func (ts *TestServer) postForm(t *testing.T, c *http.Client, path string) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.HTTPServer.URL+path, nil)
	require.NoError(t, err)
	resp, err := c.Do(req)
	require.NoError(t, err)
	return resp
}

// putPassword sends PUT /users/me/password with the given JSON body via the
// session client c.
func (ts *TestServer) putPassword(t *testing.T, c *http.Client, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPut, ts.HTTPServer.URL+"/api/v1/users/me/password", strings.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Do(req)
	require.NoError(t, err)
	return resp
}

// createPAT creates a personal access token via the session client c and
// returns the raw token.
func (ts *TestServer) createPAT(t *testing.T, c *http.Client, name string) string {
	t.Helper()
	body := fmt.Sprintf(`{"name":%q}`, name)
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.HTTPServer.URL+"/api/v1/pats", strings.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusCreated, resp.StatusCode)
	var created struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&created))
	return created.Token
}
