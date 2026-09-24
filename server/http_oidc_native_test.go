package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"

	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// nativePKCE is the app-held secret of a native hand-off and its S256
// challenge.
type nativePKCE struct {
	verifier  string
	challenge string
}

func newNativePKCE(t *testing.T, seed string) nativePKCE {
	t.Helper()
	verifier := "verifier-" + seed + "-" + strings.Repeat("x", 43)
	sum := sha256.Sum256([]byte(verifier))
	return nativePKCE{verifier: verifier, challenge: base64.RawURLEncoding.EncodeToString(sum[:])}
}

func nativeStartPath(intent, challenge string) string {
	return "/api/v1/auth/oidc/native/start?" + url.Values{"intent": {intent}, "code_challenge": {challenge}}.Encode()
}

// nativeCallbackParams asserts resp is the native callback's redirect to the
// app and returns its query.
func nativeCallbackParams(t *testing.T, resp *http.Response) url.Values {
	t.Helper()
	require.Equal(t, http.StatusFound, resp.StatusCode)
	loc, err := url.Parse(resp.Header.Get("Location"))
	require.NoError(t, err)
	require.Equal(t, "jot", loc.Scheme)
	require.Equal(t, "oidc-callback", loc.Host)
	return loc.Query()
}

// driveNativeFlow runs a native flow through the callback on a fresh,
// session-less browser client and returns the one-time code.
func (ts *TestServer) driveNativeFlow(t *testing.T, mock *mockOIDC, intent string, pkce nativePKCE, claims map[string]any) string {
	t.Helper()
	resp := ts.driveFlow(t, mock, ts.oidcClient(t), nativeStartPath(intent, pkce.challenge), claims)
	defer resp.Body.Close()
	params := nativeCallbackParams(t, resp)
	require.Empty(t, params.Get("error"))
	code := params.Get("code")
	require.NotEmpty(t, code)
	return code
}

// postNative POSTs {code, code_verifier} to path with client c.
func (ts *TestServer) postNative(t *testing.T, c *http.Client, path, code, verifier string) *http.Response {
	t.Helper()
	body, err := json.Marshal(map[string]string{"code": code, "code_verifier": verifier})
	require.NoError(t, err)
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.HTTPServer.URL+path, strings.NewReader(string(body)))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Do(req)
	require.NoError(t, err)
	return resp
}

func (ts *TestServer) postNativeStatus(t *testing.T, c *http.Client, path, code, verifier string) int {
	t.Helper()
	resp := ts.postNative(t, c, path, code, verifier)
	require.NoError(t, resp.Body.Close())
	return resp.StatusCode
}

const (
	nativeExchangePath = "/api/v1/auth/oidc/native/exchange"
	nativeLinkPath     = "/api/v1/auth/oidc/native/link"
)

func sessionCookie(resp *http.Response) *http.Cookie {
	for _, c := range resp.Cookies() {
		if c.Name == auth.SessionCookieName {
			return c
		}
	}
	return nil
}

// decodeFlowCookie reads the (signed, not encrypted) flow cookie's payload.
func decodeFlowCookie(t *testing.T, resp *http.Response) map[string]any {
	t.Helper()
	for _, c := range resp.Cookies() {
		if c.Name != "jot_oidc_flow" {
			continue
		}
		encoded, _, found := strings.Cut(c.Value, ".")
		require.True(t, found)
		payload, err := base64.RawURLEncoding.DecodeString(encoded)
		require.NoError(t, err)
		var fs map[string]any
		require.NoError(t, json.Unmarshal(payload, &fs))
		return fs
	}
	t.Fatal("no flow cookie set")
	return nil
}

func TestOIDCNativeStart(t *testing.T) {
	t.Parallel()
	ts, mock := setupOIDCTestServer(t, nil)
	pkce := newNativePKCE(t, "start")

	get := func(t *testing.T, path string) *http.Response {
		t.Helper()
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+path, nil)
		require.NoError(t, err)
		resp, err := ts.oidcClient(t).Do(req)
		require.NoError(t, err)
		return resp
	}

	t.Run("rejects invalid input", func(t *testing.T) {
		sum := sha256.Sum256([]byte(pkce.verifier))
		cases := map[string]string{
			"missing challenge":        "/api/v1/auth/oidc/native/start?intent=login",
			"padded challenge":         nativeStartPath("login", pkce.challenge+"="),
			"short challenge":          nativeStartPath("login", pkce.challenge[:42]),
			"hex digest challenge":     nativeStartPath("login", hex.EncodeToString(sum[:])),
			"standard base64 alphabet": nativeStartPath("login", "+"+pkce.challenge[1:]),
			"missing intent":           "/api/v1/auth/oidc/native/start?code_challenge=" + pkce.challenge,
			"unknown intent":           nativeStartPath("logout", pkce.challenge),
		}
		for _, name := range slices.Sorted(maps.Keys(cases)) {
			resp := get(t, cases[name])
			require.NoError(t, resp.Body.Close())
			assert.Equal(t, http.StatusBadRequest, resp.StatusCode, name)
			assert.Empty(t, resp.Header.Get("Location"), name)
		}
	})

	for _, intent := range []string{"login", "link"} {
		t.Run(intent+" marks the flow native without a session", func(t *testing.T) {
			// A fresh client with no session: native link must not require one.
			resp := get(t, nativeStartPath(intent, pkce.challenge))
			defer resp.Body.Close()
			require.Equal(t, http.StatusFound, resp.StatusCode)
			assert.True(t, strings.HasPrefix(resp.Header.Get("Location"), mock.issuer()+"/authorize"))
			assert.Nil(t, sessionCookie(resp), "native start must not set jot_session")

			fs := decodeFlowCookie(t, resp)
			assert.Equal(t, true, fs["native"])
			assert.Equal(t, intent, fs["intent"])
			assert.Equal(t, pkce.challenge, fs["code_challenge"])
			assert.Empty(t, fs["user_id"])
		})
	}

	t.Run("web login flow is not marked native", func(t *testing.T) {
		resp := get(t, "/api/v1/auth/oidc/login")
		defer resp.Body.Close()
		require.Equal(t, http.StatusFound, resp.StatusCode)
		fs := decodeFlowCookie(t, resp)
		assert.Nil(t, fs["native"])
		assert.Nil(t, fs["code_challenge"])
	})
}

func TestOIDCNativeStartLinkRequiresLocalLogin(t *testing.T) {
	t.Parallel()
	ts, _ := setupOIDCTestServer(t, func(cfg *config.Config) {
		cfg.LocalLoginEnabled = false
	})
	pkce := newNativePKCE(t, "sso-only")

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+nativeStartPath("link", pkce.challenge), nil)
	require.NoError(t, err)
	resp, err := ts.oidcClient(t).Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestOIDCNativeCallback(t *testing.T) {
	t.Parallel()
	ts, mock := setupOIDCTestServer(t, nil)
	pkce := newNativePKCE(t, "callback")

	t.Run("issues a code and performs no effect", func(t *testing.T) {
		c := ts.oidcClient(t)
		resp := ts.driveFlow(t, mock, c, nativeStartPath("login", pkce.challenge), map[string]any{
			"sub":                "sub-ghost",
			"preferred_username": "ghost",
		})
		defer resp.Body.Close()
		params := nativeCallbackParams(t, resp)
		assert.NotEmpty(t, params.Get("code"))
		assert.Nil(t, sessionCookie(resp), "native callback must not set jot_session")

		_, status := ts.me(t, c)
		assert.Equal(t, http.StatusUnauthorized, status, "the browser must hold no session")

		// No user was provisioned: a web login with a different identity
		// seeding the same username gets it without a de-duplication suffix.
		webClient := ts.oidcClient(t)
		webResp := ts.driveFlow(t, mock, webClient, "/api/v1/auth/oidc/login", map[string]any{
			"sub":                "sub-other",
			"preferred_username": "ghost",
		})
		require.NoError(t, webResp.Body.Close())
		me, status := ts.me(t, webClient)
		require.Equal(t, http.StatusOK, status)
		assert.Equal(t, "ghost", me.User.Username)
	})

	t.Run("link intent binds nothing", func(t *testing.T) {
		user := ts.createTestUser(t, "cbnobind", "password123", false)
		// Even if the browser happens to carry the user's session, a native
		// link callback must not bind.
		c := sessionClientFrom(t, ts, user)
		resp := ts.driveFlow(t, mock, c, nativeStartPath("link", pkce.challenge), map[string]any{
			"sub": "sub-cbnobind",
		})
		defer resp.Body.Close()
		assert.NotEmpty(t, nativeCallbackParams(t, resp).Get("code"))

		me, status := ts.me(t, c)
		require.Equal(t, http.StatusOK, status)
		assert.False(t, me.User.HasSSOLinked)
	})

	// startNative begins a native flow and returns the client (holding the
	// flow cookie), state, and nonce, for driving a custom callback.
	startNative := func(t *testing.T) (*http.Client, string, string) {
		t.Helper()
		c := ts.oidcClient(t)
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+nativeStartPath("login", pkce.challenge), nil)
		require.NoError(t, err)
		resp, err := c.Do(req)
		require.NoError(t, err)
		require.NoError(t, resp.Body.Close())
		loc, err := url.Parse(resp.Header.Get("Location"))
		require.NoError(t, err)
		return c, loc.Query().Get("state"), loc.Query().Get("nonce")
	}
	callback := func(t *testing.T, c *http.Client, query url.Values) url.Values {
		t.Helper()
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/auth/oidc/callback?"+query.Encode(), nil)
		require.NoError(t, err)
		resp, err := c.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Nil(t, sessionCookie(resp))
		params := nativeCallbackParams(t, resp)
		assert.Empty(t, params.Get("code"))
		return params
	}

	t.Run("IdP access_denied redirects with access_denied", func(t *testing.T) {
		c, state, _ := startNative(t)
		params := callback(t, c, url.Values{"state": {state}, "error": {"access_denied"}})
		assert.Equal(t, "access_denied", params.Get("error"))
	})

	t.Run("other IdP errors redirect with idp_error", func(t *testing.T) {
		c, state, _ := startNative(t)
		params := callback(t, c, url.Values{"state": {state}, "error": {"server_error"}})
		assert.Equal(t, "idp_error", params.Get("error"))
	})

	t.Run("state mismatch redirects with invalid_request", func(t *testing.T) {
		c, _, _ := startNative(t)
		params := callback(t, c, url.Values{"state": {"wrong"}, "code": {"x"}})
		assert.Equal(t, "invalid_request", params.Get("error"))
	})

	t.Run("nonce mismatch redirects with authentication_failed", func(t *testing.T) {
		c, state, _ := startNative(t)
		mock.registerCode("code-badnonce", "not-the-nonce", map[string]any{"sub": "sub-badnonce"})
		params := callback(t, c, url.Values{"state": {state}, "code": {"code-badnonce"}})
		assert.Equal(t, "authentication_failed", params.Get("error"))
	})
}

func TestOIDCNativeExchange(t *testing.T) {
	t.Parallel()
	ts, mock := setupOIDCTestServer(t, nil)
	pkce := newNativePKCE(t, "exchange")

	t.Run("response matches POST /login and yields a working session", func(t *testing.T) {
		code := ts.driveNativeFlow(t, mock, "login", pkce, map[string]any{
			"sub":                "sub-native",
			"preferred_username": "native",
		})

		app := ts.oidcClient(t)
		resp := ts.postNative(t, app, nativeExchangePath, code, pkce.verifier)
		defer resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode)
		cookie := sessionCookie(resp)
		require.NotNil(t, cookie, "exchange must set jot_session")
		assert.True(t, cookie.HttpOnly)

		var body map[string]json.RawMessage
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))

		// The same shape a local POST /login returns.
		ts.createTestUser(t, "localshape", "password123", false)
		loginBody := strings.NewReader(`{"username":"localshape","password":"password123"}`)
		loginReq, err := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.HTTPServer.URL+"/api/v1/login", loginBody)
		require.NoError(t, err)
		loginReq.Header.Set("Content-Type", "application/json")
		loginResp, err := ts.oidcClient(t).Do(loginReq)
		require.NoError(t, err)
		defer loginResp.Body.Close()
		require.Equal(t, http.StatusOK, loginResp.StatusCode)
		var localBody map[string]json.RawMessage
		require.NoError(t, json.NewDecoder(loginResp.Body).Decode(&localBody))
		assert.ElementsMatch(t, slices.Collect(maps.Keys(localBody)), slices.Collect(maps.Keys(body)))
		assert.Equal(t, loginResp.Header.Get("Content-Type"), resp.Header.Get("Content-Type"))
		localCookie := sessionCookie(loginResp)
		require.NotNil(t, localCookie)
		assert.Equal(t, localCookie.Path, cookie.Path)
		assert.Equal(t, localCookie.SameSite, cookie.SameSite)

		var user struct {
			Username string `json:"username"`
		}
		require.NoError(t, json.Unmarshal(body["user"], &user))
		assert.Equal(t, "native", user.Username)

		me, status := ts.me(t, app)
		require.Equal(t, http.StatusOK, status, "the exchanged session must authenticate")
		assert.Equal(t, "native", me.User.Username)

		t.Run("reuse fails", func(t *testing.T) {
			assert.Equal(t, http.StatusBadRequest, ts.postNativeStatus(t, ts.oidcClient(t), nativeExchangePath, code, pkce.verifier))
		})
	})

	t.Run("returning identity resolves to the same account", func(t *testing.T) {
		code := ts.driveNativeFlow(t, mock, "login", pkce, map[string]any{
			"sub":                "sub-native",
			"preferred_username": "renamed",
		})
		app := ts.oidcClient(t)
		require.Equal(t, http.StatusOK, ts.postNativeStatus(t, app, nativeExchangePath, code, pkce.verifier))
		me, status := ts.me(t, app)
		require.Equal(t, http.StatusOK, status)
		assert.Equal(t, "native", me.User.Username)
	})

	t.Run("failed checks leave the code usable", func(t *testing.T) {
		code := ts.driveNativeFlow(t, mock, "login", pkce, map[string]any{
			"sub":                "sub-retry",
			"preferred_username": "retry",
		})
		app := ts.oidcClient(t)
		sum := sha256.Sum256([]byte(pkce.verifier))
		badVerifiers := map[string]string{
			"wrong verifier":        newNativePKCE(t, "other").verifier,
			"challenge as verifier": pkce.challenge,
			"hex digest":            hex.EncodeToString(sum[:]),
		}
		for _, name := range slices.Sorted(maps.Keys(badVerifiers)) {
			assert.Equal(t, http.StatusBadRequest, ts.postNativeStatus(t, app, nativeExchangePath, code, badVerifiers[name]), name)
		}

		// A login code presented at the link endpoint (with a valid session)
		// is rejected without consuming it.
		linker := ts.createTestUser(t, "wrongendpoint", "password123", false)
		assert.Equal(t, http.StatusBadRequest, ts.postNativeStatus(t, sessionClientFrom(t, ts, linker), nativeLinkPath, code, pkce.verifier))

		_, status := ts.me(t, app)
		require.Equal(t, http.StatusUnauthorized, status, "no failed attempt may sign in")

		assert.Equal(t, http.StatusOK, ts.postNativeStatus(t, app, nativeExchangePath, code, pkce.verifier))
		me, status := ts.me(t, app)
		require.Equal(t, http.StatusOK, status)
		assert.Equal(t, "retry", me.User.Username)
	})

	t.Run("rejects malformed requests", func(t *testing.T) {
		app := ts.oidcClient(t)
		assert.Equal(t, http.StatusBadRequest, ts.postNativeStatus(t, app, nativeExchangePath, "", pkce.verifier))
		assert.Equal(t, http.StatusBadRequest, ts.postNativeStatus(t, app, nativeExchangePath, "code", ""))
		assert.Equal(t, http.StatusBadRequest, ts.postNativeStatus(t, app, nativeExchangePath, "code", "too-short"))
		assert.Equal(t, http.StatusBadRequest, ts.postNativeStatus(t, app, nativeExchangePath, "unknown-code", pkce.verifier))

		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.HTTPServer.URL+nativeExchangePath, strings.NewReader("{"))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		resp, err := app.Do(req)
		require.NoError(t, err)
		_, _ = io.Copy(io.Discard, resp.Body)
		require.NoError(t, resp.Body.Close())
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})

	// Expiry is covered by TestNativeCodeStoreRedeem in internal/oidc, which
	// controls the clock.
}

func TestOIDCNativeLink(t *testing.T) {
	t.Parallel()
	ts, mock := setupOIDCTestServer(t, nil)
	pkce := newNativePKCE(t, "link")

	t.Run("requires a session", func(t *testing.T) {
		code := ts.driveNativeFlow(t, mock, "link", pkce, map[string]any{"sub": "sub-nosession"})
		assert.Equal(t, http.StatusUnauthorized, ts.postNativeStatus(t, ts.oidcClient(t), nativeLinkPath, code, pkce.verifier))
	})

	t.Run("binds to the session's user after failed attempts", func(t *testing.T) {
		user := ts.createTestUser(t, "nativelinker", "password123", false)
		app := sessionClientFrom(t, ts, user)

		code := ts.driveNativeFlow(t, mock, "link", pkce, map[string]any{
			"sub":                "sub-nativelinker",
			"preferred_username": "ignored",
		})

		// Wrong verifier, and the link code at the login endpoint: both
		// rejected without consuming it.
		assert.Equal(t, http.StatusBadRequest, ts.postNativeStatus(t, app, nativeLinkPath, code, newNativePKCE(t, "other").verifier))
		assert.Equal(t, http.StatusBadRequest, ts.postNativeStatus(t, ts.oidcClient(t), nativeExchangePath, code, pkce.verifier))

		resp := ts.postNative(t, app, nativeLinkPath, code, pkce.verifier)
		require.NoError(t, resp.Body.Close())
		require.Equal(t, http.StatusNoContent, resp.StatusCode)
		assert.Nil(t, sessionCookie(resp), "linking must not issue a new session")

		me, status := ts.me(t, app)
		require.Equal(t, http.StatusOK, status)
		assert.True(t, me.User.HasSSOLinked)

		// An SSO login for that identity now lands on the linked account.
		loginCode := ts.driveNativeFlow(t, mock, "login", pkce, map[string]any{"sub": "sub-nativelinker"})
		ssoApp := ts.oidcClient(t)
		require.Equal(t, http.StatusOK, ts.postNativeStatus(t, ssoApp, nativeExchangePath, loginCode, pkce.verifier))
		ssoMe, status := ts.me(t, ssoApp)
		require.Equal(t, http.StatusOK, status)
		assert.Equal(t, user.User.ID, ssoMe.User.ID)

		t.Run("reuse fails", func(t *testing.T) {
			assert.Equal(t, http.StatusBadRequest, ts.postNativeStatus(t, app, nativeLinkPath, code, pkce.verifier))
		})
	})

	t.Run("identity bound to another user is rejected", func(t *testing.T) {
		other := ts.createTestUser(t, "nativeother", "password123", false)
		code := ts.driveNativeFlow(t, mock, "link", pkce, map[string]any{"sub": "sub-nativelinker"})
		assert.Equal(t, http.StatusConflict, ts.postNativeStatus(t, sessionClientFrom(t, ts, other), nativeLinkPath, code, pkce.verifier))
	})

	t.Run("PAT authentication is refused", func(t *testing.T) {
		user := ts.createTestUser(t, "nativepat", "password123", false)
		rawToken := ts.createPAT(t, sessionClientFrom(t, ts, user), "pat")
		code := ts.driveNativeFlow(t, mock, "link", pkce, map[string]any{"sub": "sub-nativepat"})

		body := fmt.Sprintf(`{"code":%q,"code_verifier":%q}`, code, pkce.verifier)
		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.HTTPServer.URL+nativeLinkPath, strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+rawToken)
		resp, err := ts.oidcClient(t).Do(req)
		require.NoError(t, err)
		require.NoError(t, resp.Body.Close())
		assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	})
}

func TestOIDCNativeLinkRequiresLocalLogin(t *testing.T) {
	t.Parallel()
	ts, mock := setupOIDCTestServer(t, func(cfg *config.Config) {
		cfg.LocalLoginEnabled = false
	})
	pkce := newNativePKCE(t, "sso-only-link")

	// Sign in natively (SSO-only deployments still allow SSO login), then try
	// to link: refused, since there is no local side to prove.
	code := ts.driveNativeFlow(t, mock, "login", pkce, map[string]any{"sub": "sub-ssoonly"})
	app := ts.oidcClient(t)
	require.Equal(t, http.StatusOK, ts.postNativeStatus(t, app, nativeExchangePath, code, pkce.verifier))
	assert.Equal(t, http.StatusForbidden, ts.postNativeStatus(t, app, nativeLinkPath, "any-code", pkce.verifier))
}
