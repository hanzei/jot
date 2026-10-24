package handlers

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/apierr"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
)

// errUnauthorized is what requireUser returns when the request carries no
// user.
var errUnauthorized = errors.New("unauthorized")

// requireUser returns the user AuthMiddleware stored on the request, or
// errUnauthorized, to be returned with a 401. AuthMiddleware guarantees the
// user on every authenticated route, so the error branch is defensive.
func requireUser(r *http.Request) (*models.User, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return nil, errUnauthorized
	}
	return user, nil
}

// pathID returns the URL parameter name, checked to be a well-formed ID. The
// error names the ID by label ("missing note ID", "invalid note ID format")
// and is ready to return with a 400.
func pathID(r *http.Request, name, label string) (string, error) {
	id := chi.URLParam(r, name)
	if id == "" {
		return "", fmt.Errorf("missing %s ID", label)
	}
	if !models.IsValidID(id) {
		return "", fmt.Errorf("invalid %s ID format", label)
	}
	return id, nil
}

// storeStatus picks the response for an error from a store call: a sentinel
// with a fixed status (see apierr.SentinelStatus) is returned as-is with that
// status, and anything else is a 500 wrapped with op. A handler that needs a
// different status for some sentinel checks for it first.
func storeStatus(err error, op string) (int, error) {
	if status, ok := apierr.SentinelStatus(err); ok {
		return status, err
	}
	return http.StatusInternalServerError, fmt.Errorf("%s: %w", op, err)
}

// storeError is storeStatus shaped as a handler's return values.
func storeError(err error, op string) (int, any, error) {
	status, mapped := storeStatus(err, op)
	return status, nil, mapped
}
