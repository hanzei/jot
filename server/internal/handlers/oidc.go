package handlers

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json/v2"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/oidc"
	"golang.org/x/oauth2"
)

const (
	// oidcFlowCookieName holds the signed, short-lived state/nonce/verifier
	// handle for an in-flight OIDC flow. Its Path scopes it to the OIDC
	// endpoints so it is not sent on ordinary API requests.
	oidcFlowCookieName = "jot_oidc_flow"
	oidcFlowCookiePath = "/api/v1/auth/oidc"
	// oidcFlowTTL bounds how long a started flow may take to come back. The
	// spec recommends ~10 minutes.
	oidcFlowTTL = 10 * time.Minute

	oidcIntentLogin = "login"
	oidcIntentLink  = "link"

	// oidcAppRoot is where a successful login or link redirects the browser.
	oidcAppRoot = "/"
)

// OIDCHandler serves the SSO authorization-code + PKCE endpoints. It is only
// constructed and wired when OIDC is configured; when it is nil the routes are
// not registered at all.
type OIDCHandler struct {
	provider          *oidc.Provider
	userStore         *models.UserStore
	userSettingsStore *models.UserSettingsStore
	sessionService    *auth.SessionService
	usernameClaim     string
	localLoginEnabled bool
	cookieSecure      bool
	// signingKey authenticates the flow cookie. It is random per server start,
	// which is fine for a ~10-minute flow: a server restart mid-flow simply
	// invalidates in-flight logins, and single-instance self-hosted deployments
	// are the target.
	signingKey []byte
	// nativeCodes holds the one-time codes of the mobile native hand-off
	// (see oidc_native.go).
	nativeCodes *oidc.NativeCodeStore
}

// NewOIDCHandler builds an OIDCHandler. signingKey must be a non-empty secret
// (generated at server startup) used to sign the flow cookie.
func NewOIDCHandler(
	provider *oidc.Provider,
	userStore *models.UserStore,
	userSettingsStore *models.UserSettingsStore,
	sessionService *auth.SessionService,
	usernameClaim string,
	localLoginEnabled bool,
	cookieSecure bool,
	signingKey []byte,
) *OIDCHandler {
	return &OIDCHandler{
		provider:          provider,
		userStore:         userStore,
		userSettingsStore: userSettingsStore,
		sessionService:    sessionService,
		usernameClaim:     usernameClaim,
		localLoginEnabled: localLoginEnabled,
		cookieSecure:      cookieSecure,
		signingKey:        signingKey,
		nativeCodes:       oidc.NewNativeCodeStore(oidc.NativeCodeCapacity, oidc.NativeCodeTTL),
	}
}

// flowState is the transient per-flow data carried in the signed cookie between
// the login/link redirect and the callback.
type flowState struct {
	State    string `json:"state"`
	Nonce    string `json:"nonce"`
	Verifier string `json:"verifier"`
	Intent   string `json:"intent"`
	UserID   string `json:"user_id,omitempty"`
	IssuedAt int64  `json:"iat"`
	// Native marks a mobile native hand-off flow: the callback performs no
	// effect and instead issues a one-time code bound to CodeChallenge.
	Native        bool   `json:"native,omitzero"`
	CodeChallenge string `json:"code_challenge,omitempty"`
}

// Login begins a login-intent OIDC flow (unauthenticated).
//
//	@Summary	Begin SSO login
//	@Tags		auth
//	@Success	302	"redirect to the identity provider"
//	@Router		/auth/oidc/login [get]
func (h *OIDCHandler) Login(w http.ResponseWriter, r *http.Request) (int, any, error) {
	return h.startFlow(w, r, flowState{Intent: oidcIntentLogin})
}

// Link begins a link-intent OIDC flow for the authenticated user, binding the
// resulting identity to their existing account on the callback.
//
//	@Summary	Begin SSO account linking
//	@Tags		auth
//	@Security	CookieAuth
//	@Success	302	"redirect to the identity provider"
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	403	{string}	string	"linking unavailable"
//	@Router		/auth/oidc/link [get]
func (h *OIDCHandler) Link(w http.ResponseWriter, r *http.Request) (int, any, error) {
	// Linking proves control of the local account by password first; with local
	// login disabled there is no local side to prove, so linking is not offered.
	if !h.localLoginEnabled {
		return http.StatusForbidden, nil, errors.New("account linking is unavailable when local login is disabled")
	}
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}
	return h.startFlow(w, r, flowState{Intent: oidcIntentLink, UserID: user.ID})
}

// startFlow fills in fs's per-flow secrets (state, nonce, PKCE verifier) and
// issue time, sets the signed flow cookie, and redirects to the IdP. The caller
// supplies the intent and any intent-specific fields.
func (h *OIDCHandler) startFlow(w http.ResponseWriter, r *http.Request, fs flowState) (int, any, error) {
	state, err := randomToken()
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("generate state: %w", err)
	}
	nonce, err := randomToken()
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("generate nonce: %w", err)
	}
	verifier := oauth2.GenerateVerifier()

	fs.State = state
	fs.Nonce = nonce
	fs.Verifier = verifier
	fs.IssuedAt = time.Now().Unix() //nolint:gocritic // transient flow-cookie timestamp for TTL, never persisted to or compared against a DB timestamp column
	if err := h.setFlowCookie(w, fs); err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("set flow cookie: %w", err)
	}

	http.Redirect(w, r, h.provider.AuthCodeURL(state, nonce, verifier), http.StatusFound)
	return 0, nil, nil
}

// Callback completes an OIDC flow: it validates the signed flow cookie and the
// returned state, exchanges and verifies the code, checks the nonce, and then
// either provisions/logs in the user (login intent) or binds the identity to
// the authenticated user (link intent). A native (mobile) flow instead issues
// a one-time code and redirects to the app; see completeNative.
//
//	@Summary	Complete an SSO flow
//	@Tags		auth
//	@Param		code	query	string	true	"authorization code"
//	@Param		state	query	string	true	"state token"
//	@Success	302		"redirect to the app (web), or to jot://oidc-callback with a code or error (native)"
//	@Failure	400		{string}	string	"invalid flow"
//	@Failure	401		{string}	string	"authentication failed"
//	@Failure	409		{string}	string	"identity already linked"
//	@Router		/auth/oidc/callback [get]
func (h *OIDCHandler) Callback(w http.ResponseWriter, r *http.Request) (int, any, error) {
	fs, err := h.readFlowCookie(r)
	// The flow cookie is single-use; clear it whether or not it validated so a
	// stale handle cannot linger.
	h.clearFlowCookie(w)
	if err != nil {
		return http.StatusBadRequest, nil, fmt.Errorf("invalid or expired SSO flow: %w", err)
	}

	identity, cbErr := h.verifyCallback(r, fs)
	if fs.Native {
		return h.completeNative(w, r, fs, identity, cbErr)
	}
	if cbErr != nil {
		return cbErr.status, nil, cbErr.err
	}

	switch fs.Intent {
	case oidcIntentLink:
		return h.completeLink(w, r, fs.UserID, identity)
	case oidcIntentLogin:
		return h.completeLogin(w, r, identity)
	default:
		return http.StatusBadRequest, nil, fmt.Errorf("unknown SSO intent %q", fs.Intent)
	}
}

// callbackError is a failed callback check: the HTTP status and error a web
// flow returns, plus the error code a native flow puts in its app redirect.
type callbackError struct {
	status     int
	nativeCode string
	err        error
}

// verifyCallback checks the IdP's response against the flow state and verifies
// the ID token: IdP error, state, code presence, token signature/claims, and
// nonce. It is shared by web and native flows.
func (h *OIDCHandler) verifyCallback(r *http.Request, fs flowState) (*oidc.Identity, *callbackError) {
	q := r.URL.Query()
	if idpErr := q.Get("error"); idpErr != "" {
		nativeCode := oidcNativeErrIdP
		if idpErr == oidcNativeErrAccessDenied {
			nativeCode = oidcNativeErrAccessDenied
		}
		return nil, &callbackError{http.StatusUnauthorized, nativeCode, fmt.Errorf("identity provider returned an error: %s", idpErr)}
	}
	if q.Get("state") != fs.State {
		return nil, &callbackError{http.StatusBadRequest, oidcNativeErrInvalidRequest, errors.New("state mismatch")}
	}
	code := q.Get("code")
	if code == "" {
		return nil, &callbackError{http.StatusBadRequest, oidcNativeErrInvalidRequest, errors.New("missing authorization code")}
	}

	identity, err := h.provider.Verify(r.Context(), code, fs.Verifier)
	if err != nil {
		return nil, &callbackError{http.StatusUnauthorized, oidcNativeErrAuthFailed, fmt.Errorf("verify SSO callback: %w", err)}
	}
	if identity.Nonce != fs.Nonce {
		return nil, &callbackError{http.StatusUnauthorized, oidcNativeErrAuthFailed, errors.New("nonce mismatch")}
	}
	return identity, nil
}

func (h *OIDCHandler) completeLink(w http.ResponseWriter, r *http.Request, userID string, identity *oidc.Identity) (int, any, error) {
	if status, err := h.bindIdentity(r.Context(), userID, identity.Issuer, identity.Subject); err != nil {
		return status, nil, err
	}
	http.Redirect(w, r, oidcAppRoot, http.StatusFound)
	return 0, nil, nil
}

// bindIdentity binds (issuer, subject) to userID with the §5 guards: an
// identity already bound to another user is rejected (409), never rebound. It
// returns the HTTP status and error to report on failure.
func (h *OIDCHandler) bindIdentity(ctx context.Context, userID, issuer, subject string) (int, error) {
	err := h.userStore.LinkOIDCIdentity(ctx, userID, issuer, subject)
	switch {
	case errors.Is(err, models.ErrOIDCIdentityLinked):
		return http.StatusConflict, models.ErrOIDCIdentityLinked
	case errors.Is(err, models.ErrUserNotFound):
		return http.StatusUnauthorized, errors.New("unauthorized")
	case err != nil:
		return http.StatusInternalServerError, fmt.Errorf("link SSO identity: %w", err)
	}
	return 0, nil
}

func (h *OIDCHandler) completeLogin(w http.ResponseWriter, r *http.Request, identity *oidc.Identity) (int, any, error) {
	if _, status, err := h.signIn(w, r, identity.Issuer, identity.Subject, h.usernameSeed(identity)); err != nil {
		return status, nil, err
	}
	http.Redirect(w, r, oidcAppRoot, http.StatusFound)
	return 0, nil, nil
}

// signIn resolves or provisions the user for (issuer, subject), ensures their
// settings exist, and creates a session (setting the jot_session cookie). It
// returns the same {user, settings} body as POST /login, or the HTTP status and
// error to report on failure.
func (h *OIDCHandler) signIn(w http.ResponseWriter, r *http.Request, issuer, subject, usernameSeed string) (*AuthResponse, int, error) {
	user, err := h.resolveOrProvision(r.Context(), issuer, subject, usernameSeed)
	if err != nil {
		if errors.Is(err, models.ErrOIDCIdentityLinked) {
			return nil, http.StatusConflict, models.ErrOIDCIdentityLinked
		}
		return nil, http.StatusInternalServerError, fmt.Errorf("resolve SSO user: %w", err)
	}

	// Ensure settings exist so the app's first authenticated fetch behaves like
	// it does after a local register/login.
	settings, err := h.userSettingsStore.GetOrCreate(r.Context(), user.ID)
	if err != nil {
		return nil, http.StatusInternalServerError, fmt.Errorf("get or create user settings: %w", err)
	}

	if err := h.sessionService.CreateSession(w, r, user.ID); err != nil {
		return nil, http.StatusInternalServerError, fmt.Errorf("create session: %w", err)
	}
	return &AuthResponse{User: user, Settings: settings}, 0, nil
}

// resolveOrProvision returns the user bound to (issuer, subject), creating a
// new SSO user seeded from usernameSeed on first login. Auto-provisioning
// grants admin only for an SSO-only deployment's first user (see §6 of the
// OIDC spec).
func (h *OIDCHandler) resolveOrProvision(ctx context.Context, issuer, subject, usernameSeed string) (*models.User, error) {
	user, err := h.userStore.GetByOIDCIdentity(ctx, issuer, subject)
	if err == nil {
		return user, nil
	}
	if !errors.Is(err, models.ErrUserNotFound) {
		return nil, fmt.Errorf("look up OIDC identity: %w", err)
	}
	grantAdminIfFirst := !h.localLoginEnabled
	user, err = h.userStore.ProvisionSSOUser(ctx, issuer, subject, usernameSeed, grantAdminIfFirst)
	if errors.Is(err, models.ErrOIDCIdentityLinked) {
		// Lost a race with a concurrent first login of the *same* identity: the
		// row now exists and belongs to this same (issuer, subject), so resolve
		// it rather than surfacing a "linked to another account" conflict.
		user, err = h.userStore.GetByOIDCIdentity(ctx, issuer, subject)
		if err != nil {
			return nil, fmt.Errorf("resolve raced OIDC identity: %w", err)
		}
		return user, nil
	}
	if err != nil {
		return nil, fmt.Errorf("provision SSO user: %w", err)
	}
	return user, nil
}

// usernameSeed derives a human-readable username candidate from the verified
// claims: the configured username claim, then the email local-part, then the
// opaque subject as a last resort. The store sanitizes and de-duplicates it.
func (h *OIDCHandler) usernameSeed(identity *oidc.Identity) string {
	if v, ok := identity.Claims[h.usernameClaim].(string); ok && strings.TrimSpace(v) != "" {
		return v
	}
	if email, ok := identity.Claims["email"].(string); ok {
		if local, _, found := strings.Cut(email, "@"); found && local != "" {
			return local
		}
	}
	return identity.Subject
}

// Unlink clears the authenticated user's SSO identity.
//
//	@Summary	Unlink the SSO identity from the current account
//	@Tags		auth
//	@Security	CookieAuth
//	@Success	204	"no content"
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	422	{string}	string	"would strand the account"
//	@Failure	500	{string}	string	"internal server error"
//	@Router		/auth/oidc/unlink [post]
func (h *OIDCHandler) Unlink(_ http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}
	err := h.userStore.UnlinkOIDCIdentity(r.Context(), user.ID)
	switch {
	case errors.Is(err, models.ErrWouldStrandAccount):
		// A resource-state precondition, not malformed input, so 422 per the API
		// conventions.
		return http.StatusUnprocessableEntity, nil, models.ErrWouldStrandAccount
	case errors.Is(err, models.ErrUserNotFound):
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	case err != nil:
		return http.StatusInternalServerError, nil, fmt.Errorf("unlink SSO identity: %w", err)
	}
	return http.StatusNoContent, nil, nil
}

// randomToken returns 32 bytes of hex-encoded randomness for use as a state or
// nonce value.
func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("read random bytes: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// setFlowCookie serializes fs, signs it, and sets it as the flow cookie.
func (h *OIDCHandler) setFlowCookie(w http.ResponseWriter, fs flowState) error {
	payload, err := json.Marshal(fs)
	if err != nil {
		return fmt.Errorf("marshal flow state: %w", err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	value := encoded + "." + h.sign(encoded)

	//nolint:gosec // Secure is config-driven (h.cookieSecure), which gosec cannot verify statically; SameSite=Lax is required because the callback is a top-level cross-site navigation from the IdP.
	http.SetCookie(w, &http.Cookie{
		Name:     oidcFlowCookieName,
		Value:    value,
		Path:     oidcFlowCookiePath,
		HttpOnly: true,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(oidcFlowTTL.Seconds()),
	})
	return nil
}

// readFlowCookie verifies the flow cookie's signature and freshness and returns
// the decoded state.
func (h *OIDCHandler) readFlowCookie(r *http.Request) (flowState, error) {
	cookie, err := r.Cookie(oidcFlowCookieName)
	if err != nil {
		return flowState{}, errors.New("missing flow cookie")
	}
	encoded, sig, found := strings.Cut(cookie.Value, ".")
	if !found {
		return flowState{}, errors.New("malformed flow cookie")
	}
	if !hmac.Equal([]byte(sig), []byte(h.sign(encoded))) {
		return flowState{}, errors.New("flow cookie signature mismatch")
	}
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return flowState{}, fmt.Errorf("decode flow cookie: %w", err)
	}
	var fs flowState
	if err := json.Unmarshal(payload, &fs); err != nil {
		return flowState{}, fmt.Errorf("unmarshal flow cookie: %w", err)
	}
	if time.Since(time.Unix(fs.IssuedAt, 0)) > oidcFlowTTL {
		return flowState{}, errors.New("flow has expired")
	}
	return fs, nil
}

func (h *OIDCHandler) clearFlowCookie(w http.ResponseWriter) {
	//nolint:gosec // deletion cookie: Secure is config-driven (h.cookieSecure); empty value with MaxAge<0 expires it immediately.
	http.SetCookie(w, &http.Cookie{
		Name:     oidcFlowCookieName,
		Value:    "",
		Path:     oidcFlowCookiePath,
		HttpOnly: true,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

// sign returns the base64url-encoded HMAC-SHA256 of encoded under the handler's
// signing key.
func (h *OIDCHandler) sign(encoded string) string {
	mac := hmac.New(sha256.New, h.signingKey)
	mac.Write([]byte(encoded))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
