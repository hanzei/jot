package handlers

import (
	"errors"
	"net/http"
	"net/url"

	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/logutil"
	"github.com/hanzei/jot/server/internal/oidc"
)

// Mobile native hand-off (spec docs/specs/oidc-sso.md §10). The app opens
// NativeStart in a system browser sheet; the shared Callback verifies the ID
// token but performs no effect, instead issuing a one-time code bound to the
// app's PKCE-style code_challenge and redirecting to oidcNativeRedirect. The
// app then redeems the code with its code_verifier at NativeExchange (login) or
// NativeLink (link), where every effect happens.

const (
	// oidcNativeRedirect is where a native flow's callback sends the browser.
	// It is a constant, never taken from the request, so the callback is not an
	// open redirect.
	oidcNativeRedirect = "jot://oidc-callback"

	// Error codes a native flow's callback reports as
	// jot://oidc-callback?error=<code>.
	oidcNativeErrAccessDenied   = "access_denied"           // the user denied consent at the IdP
	oidcNativeErrIdP            = "idp_error"               // any other IdP-reported error
	oidcNativeErrInvalidRequest = "invalid_request"         // state mismatch or missing authorization code
	oidcNativeErrAuthFailed     = "authentication_failed"   // ID token or nonce verification failed
	oidcNativeErrUnavailable    = "temporarily_unavailable" // the code store is at capacity
	oidcNativeErrServer         = "server_error"            // unexpected internal failure
)

var errInvalidNativeCode = errors.New("invalid or expired code")

// NativeExchangeRequest redeems a native hand-off code.
type NativeExchangeRequest struct {
	Code         string `json:"code"`
	CodeVerifier string `json:"code_verifier"`
}

// NativeStart begins a native (mobile) OIDC flow. It is unauthenticated even
// for the link intent: the browser sheet has no Jot session, and the bind is
// authorized later by the app's own session at NativeLink.
//
//	@Summary	Begin a mobile SSO hand-off
//	@Tags		auth
//	@Param		intent			query	string	true	"what the resulting code may be redeemed for"	Enums(login, link)
//	@Param		code_challenge	query	string	true	"BASE64URL(SHA256(code_verifier)), unpadded (S256)"
//	@Success	302				"redirect to the identity provider"
//	@Failure	400				{string}	string	"invalid intent or code_challenge"
//	@Failure	403				{string}	string	"linking unavailable"
//	@Router		/auth/oidc/native/start [get]
func (h *OIDCHandler) NativeStart(w http.ResponseWriter, r *http.Request) (int, any, error) {
	q := r.URL.Query()
	intent := q.Get("intent")
	if intent != oidcIntentLogin && intent != oidcIntentLink {
		return http.StatusBadRequest, nil, errors.New("intent must be login or link")
	}
	challenge := q.Get("code_challenge")
	if !oidc.ValidS256Challenge(challenge) {
		return http.StatusBadRequest, nil, errors.New("code_challenge must be an unpadded base64url SHA-256 digest (S256)")
	}
	// Mirrors Link: without local login there is no local side to prove, so
	// linking is not offered. Refusing here spares the user an IdP round trip
	// that NativeLink would reject anyway.
	if intent == oidcIntentLink && !h.localLoginEnabled {
		return http.StatusForbidden, nil, errors.New("account linking is unavailable when local login is disabled")
	}
	return h.startFlow(w, r, flowState{Intent: intent, Native: true, CodeChallenge: challenge})
}

// completeNative finishes the callback of a native flow. It performs no effect
// (no provisioning, no bind, no session): on success it stores a one-time code
// for the verified identity and redirects to the app with it; on failure it
// redirects to the app with an error code.
func (h *OIDCHandler) completeNative(w http.ResponseWriter, r *http.Request, fs flowState, identity *oidc.Identity, cbErr *callbackError) (int, any, error) {
	log := logutil.FromContext(r.Context())
	if cbErr != nil {
		log.WithError(cbErr.err).Warn("Native SSO callback failed")
		return h.nativeRedirect(w, r, "error", cbErr.nativeCode)
	}

	code, err := h.nativeCodes.Issue(oidc.NativeCodeRecord{
		Issuer:        identity.Issuer,
		Subject:       identity.Subject,
		UsernameSeed:  h.usernameSeed(identity),
		Intent:        fs.Intent,
		CodeChallenge: fs.CodeChallenge,
	})
	switch {
	case errors.Is(err, oidc.ErrNativeCodeStoreFull):
		log.WithError(err).Warn("Native SSO code store is full")
		return h.nativeRedirect(w, r, "error", oidcNativeErrUnavailable)
	case err != nil:
		log.WithError(err).Error("Failed to issue native SSO code")
		return h.nativeRedirect(w, r, "error", oidcNativeErrServer)
	}
	return h.nativeRedirect(w, r, "code", code)
}

func (h *OIDCHandler) nativeRedirect(w http.ResponseWriter, r *http.Request, key, value string) (int, any, error) {
	http.Redirect(w, r, oidcNativeRedirect+"?"+url.Values{key: {value}}.Encode(), http.StatusFound)
	return 0, nil, nil
}

// redeemNativeCode decodes a NativeExchangeRequest and atomically checks and
// consumes its code for intent. A failed check leaves the code redeemable.
func (h *OIDCHandler) redeemNativeCode(w http.ResponseWriter, r *http.Request, intent string) (oidc.NativeCodeRecord, int, error) {
	var req NativeExchangeRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return oidc.NativeCodeRecord{}, http.StatusBadRequest, err
	}
	if req.Code == "" || req.CodeVerifier == "" {
		return oidc.NativeCodeRecord{}, http.StatusBadRequest, errors.New("missing code or code_verifier")
	}
	if !oidc.ValidCodeVerifier(req.CodeVerifier) {
		return oidc.NativeCodeRecord{}, http.StatusBadRequest, errors.New("code_verifier must be 43-128 unreserved characters")
	}
	rec, err := h.nativeCodes.Redeem(req.Code, req.CodeVerifier, intent)
	if err != nil {
		// 400 rather than 401: at NativeLink a 401 would read as "your session
		// expired" to the app, and at NativeExchange there is no session yet.
		return oidc.NativeCodeRecord{}, http.StatusBadRequest, errInvalidNativeCode
	}
	return rec, 0, nil
}

// NativeExchange redeems a login-intent native hand-off code for a session. The
// response is identical to POST /login: the jot_session cookie plus the
// {user, settings} body.
//
//	@Summary	Complete a mobile SSO login
//	@Tags		auth
//	@Accept		json
//	@Produce	json
//	@Param		body	body		NativeExchangeRequest	true	"one-time code and its PKCE verifier"
//	@Success	200		{object}	AuthResponse
//	@Failure	400		{string}	string	"invalid or expired code"
//	@Failure	409		{string}	string	"identity already linked"
//	@Failure	500		{string}	string	"internal server error"
//	@Router		/auth/oidc/native/exchange [post]
func (h *OIDCHandler) NativeExchange(w http.ResponseWriter, r *http.Request) (int, any, error) {
	rec, status, err := h.redeemNativeCode(w, r, oidcIntentLogin)
	if err != nil {
		return status, nil, err
	}
	resp, status, err := h.signIn(w, r, rec.Issuer, rec.Subject, rec.UsernameSeed)
	if err != nil {
		return status, nil, err
	}
	return http.StatusOK, resp, nil
}

// NativeLink redeems a link-intent native hand-off code, binding the identity to
// the session's user.
//
//	@Summary	Complete mobile SSO account linking
//	@Tags		auth
//	@Security	CookieAuth
//	@Accept		json
//	@Param		body	body	NativeExchangeRequest	true	"one-time code and its PKCE verifier"
//	@Success	204		"no content"
//	@Failure	400		{string}	string	"invalid or expired code"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	403		{string}	string	"linking unavailable"
//	@Failure	409		{string}	string	"identity already linked"
//	@Failure	500		{string}	string	"internal server error"
//	@Router		/auth/oidc/native/link [post]
func (h *OIDCHandler) NativeLink(w http.ResponseWriter, r *http.Request) (int, any, error) {
	// Checked before redeeming so a refused request does not consume the code.
	if !h.localLoginEnabled {
		return http.StatusForbidden, nil, errors.New("account linking is unavailable when local login is disabled")
	}
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}
	rec, status, err := h.redeemNativeCode(w, r, oidcIntentLink)
	if err != nil {
		return status, nil, err
	}
	if status, err := h.bindIdentity(r.Context(), user.ID, rec.Issuer, rec.Subject); err != nil {
		return status, nil, err
	}
	return http.StatusNoContent, nil, nil
}
