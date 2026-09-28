// Package apierr defines the JSON error envelope every /api response uses and
// the stable, machine-readable codes carried in it.
//
// Every API error — from a handler, from middleware (auth, rate limiting,
// cross-origin protection, panic recovery), or from the router itself (unknown
// route, wrong method) — is written by [Write], so there is exactly one error
// format:
//
//	{"error":{"code":"not_found","message":"note not found"}}
//
// Clients switch on code; message is human-readable English meant for logs and
// as a last-resort fallback, and may change at any time. Codes are part of the
// API contract: add new ones freely, but never rename or repurpose one. Keep
// the list in sync with ApiErrorCode in shared/src/types.ts.
package apierr

import (
	"encoding/json/v2"
	"errors"
	"net/http"

	"github.com/hanzei/jot/server/internal/logutil"
	"github.com/hanzei/jot/server/internal/models"
)

// Code is a stable, machine-readable error code.
type Code string

// Generic codes, one per status class. [CodeFor] falls back to these when
// nothing more specific applies.
const (
	CodeValidationFailed Code = "validation_failed"  // 400 — malformed or invalid request input.
	CodeUnauthorized     Code = "unauthorized"       // 401 — missing, invalid, or expired credentials.
	CodeForbidden        Code = "forbidden"          // 403 — authenticated, but not allowed to do this.
	CodeNotFound         Code = "not_found"          // 404 — the resource or route does not exist (or is not visible to the caller).
	CodeMethodNotAllowed Code = "method_not_allowed" // 405 — the route exists but not for this method.
	CodeConflict         Code = "conflict"           // 409 — the request conflicts with current state (duplicate ID, concurrent modification, …).
	CodeRequestTooLarge  Code = "request_too_large"  // 413 — the request body exceeds the endpoint's limit.
	CodeLimitExceeded    Code = "limit_exceeded"     // 422 — a resource cap or length limit was exceeded.
	CodeRateLimited      Code = "rate_limited"       // 429 — too many requests; honor Retry-After.
	CodeBadRequest       Code = "bad_request"        // any other 4xx.
	CodeInternal         Code = "internal"           // any 5xx. The message is always masked.
)

// Specific codes, for the cases a client shows its own (translated) message
// for or otherwise needs to tell apart from the generic code of the same
// status.
const (
	//nolint:gosec // G101 false positive: an error code, not a credential.
	CodeInvalidCredentials   Code = "invalid_credentials"    // 401 from login — wrong username or password.
	CodeSessionRequired      Code = "session_required"       // 403 — the endpoint needs a browser session, and the request authenticated with a personal access token.
	CodeRegistrationDisabled Code = "registration_disabled"  // 403 — self-registration is turned off.
	CodeLocalLoginDisabled   Code = "local_login_disabled"   // 403 — password login (and anything needing a password) is turned off; use SSO.
	CodeIncorrectPassword    Code = "incorrect_password"     // 403 — the current password given to change a password is wrong.
	CodeUsernameTaken        Code = "username_taken"         // 409 — another account already has this username.
	CodeCannotShareWithSelf  Code = "cannot_share_with_self" // 400 — a note cannot be shared with its owner.
	CodeAlreadyShared        Code = "already_shared"         // 409 — the note is already shared with that user.
	CodeLabelNameTaken       Code = "label_name_taken"       // 400 from rename, 409 from a create with a client-supplied ID — the user already has a label with this name.
	CodeLastAdmin            Code = "last_admin"             // 409 — the change would leave the server without an admin.
	CodeCannotDeleteSelf     Code = "cannot_delete_self"     // 403 — admins cannot delete their own account.
	CodeSSOIdentityLinked    Code = "sso_identity_linked"    // 409 — the SSO identity belongs to another account.
	CodeWouldStrandAccount   Code = "would_strand_account"   // 422 — unlinking SSO would leave the account with no way to sign in.
)

// ErrorResponse is the body of every API error response.
type ErrorResponse struct {
	Error ErrorDetail `json:"error"`
}

// ErrorDetail carries an API error's code and message.
type ErrorDetail struct {
	// Code is stable and machine-readable; clients switch on it.
	Code Code `json:"code" example:"not_found"`
	// Message is human-readable English, for logs and as a fallback. Masked
	// to "internal server error" for 5xx responses.
	Message string `json:"message" example:"note not found"`
}

// InternalMessage replaces the message of every 5xx response so internal
// error detail never reaches a client.
const InternalMessage = "internal server error"

// codedError attaches an explicit code to an error.
type codedError struct {
	code Code
	err  error
}

func (e *codedError) Error() string { return e.err.Error() }
func (e *codedError) Unwrap() error { return e.err }

// WithCode attaches code to err, taking precedence over the sentinel mapping
// and the status fallback in [CodeFor]. errors.Is/As still see through it.
func WithCode(code Code, err error) error {
	return &codedError{code: code, err: err}
}

// New returns an error with the given code and message.
func New(code Code, msg string) error {
	return WithCode(code, errors.New(msg))
}

// sentinelCodes maps store sentinels to their specific code, so a handler that
// returns one of these (wrapped or not) gets the right code without having to
// attach it. Sentinels without an entry take the status fallback.
var sentinelCodes = []struct {
	err  error
	code Code
}{
	{models.ErrUsernameTaken, CodeUsernameTaken},
	{models.ErrNoteAlreadyShared, CodeAlreadyShared},
	{models.ErrLabelNameConflict, CodeLabelNameTaken},
	{models.ErrLastAdmin, CodeLastAdmin},
	{models.ErrCannotDeleteSelf, CodeCannotDeleteSelf},
	{models.ErrOIDCIdentityLinked, CodeSSOIdentityLinked},
	{models.ErrWouldStrandAccount, CodeWouldStrandAccount},
}

// CodeFor picks the code for an error response: always [CodeInternal] for a
// 5xx; otherwise a code attached with [WithCode], then a known sentinel's
// code, then the generic code for the status.
func CodeFor(status int, err error) Code {
	if status >= http.StatusInternalServerError {
		return CodeInternal
	}
	if err != nil {
		var ce *codedError
		if errors.As(err, &ce) {
			return ce.code
		}
		for _, s := range sentinelCodes {
			if errors.Is(err, s.err) {
				return s.code
			}
		}
	}
	return StatusCode(status)
}

// StatusCode returns the generic code for an HTTP status.
func StatusCode(status int) Code {
	switch {
	case status >= http.StatusInternalServerError:
		return CodeInternal
	case status == http.StatusBadRequest:
		return CodeValidationFailed
	case status == http.StatusUnauthorized:
		return CodeUnauthorized
	case status == http.StatusForbidden:
		return CodeForbidden
	case status == http.StatusNotFound:
		return CodeNotFound
	case status == http.StatusMethodNotAllowed:
		return CodeMethodNotAllowed
	case status == http.StatusConflict:
		return CodeConflict
	case status == http.StatusRequestEntityTooLarge:
		return CodeRequestTooLarge
	case status == http.StatusUnprocessableEntity:
		return CodeLimitExceeded
	case status == http.StatusTooManyRequests:
		return CodeRateLimited
	default:
		return CodeBadRequest
	}
}

// Write writes the error envelope with the given status, code, and message.
// A 5xx message is replaced with [InternalMessage].
func Write(w http.ResponseWriter, r *http.Request, status int, code Code, msg string) {
	if status >= http.StatusInternalServerError {
		msg = InternalMessage
	}
	h := w.Header()
	// Drop headers a handler may have set for a success body it never wrote
	// (an image's Content-Type, a download's Content-Disposition).
	h.Del("Content-Disposition")
	h.Del("Content-Length")
	h.Set("Content-Type", "application/json")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if err := json.MarshalWrite(w, ErrorResponse{Error: ErrorDetail{Code: code, Message: msg}}); err != nil {
		logutil.FromContext(r.Context()).WithError(err).Error("Failed to encode error response")
	}
}

// WriteErr writes err as the error envelope, choosing the code with
// [CodeFor]. The message is err's text (masked for a 5xx).
func WriteErr(w http.ResponseWriter, r *http.Request, status int, err error) {
	msg := http.StatusText(status)
	if err != nil {
		msg = err.Error()
	}
	Write(w, r, status, CodeFor(status, err), msg)
}
