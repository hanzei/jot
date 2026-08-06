package handlers

import (
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
)

type SessionsHandler struct {
	sessionStore *models.SessionStore
}

func NewSessionsHandler(sessionStore *models.SessionStore) *SessionsHandler {
	return &SessionsHandler{sessionStore: sessionStore}
}

type SessionResponse struct {
	ID        string    `json:"id"`
	Browser   string    `json:"browser"`
	OS        string    `json:"os"`
	IsCurrent bool      `json:"is_current"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
}

// sessionID derives the public session identifier from the stored token
// hash. It is a prefix of the hex SHA-256 of the raw token, so it reveals
// nothing usable for authentication.
func sessionID(tokenHash string) string {
	if len(tokenHash) < 22 {
		return tokenHash
	}
	return tokenHash[:22]
}

func toSessionResponse(s *models.Session, currentTokenHash string) SessionResponse {
	parsed := parseUserAgent(s.UserAgent)
	return SessionResponse{
		ID:        sessionID(s.TokenHash),
		Browser:   parsed.Browser,
		OS:        parsed.OS,
		IsCurrent: s.TokenHash == currentTokenHash,
		CreatedAt: s.CreatedAt,
		ExpiresAt: s.ExpiresAt,
	}
}

// ListSessions godoc
//
//	@Summary	List all active sessions for the current user
//	@Tags		sessions
//	@Security	CookieAuth
//	@Produce	json
//	@Success	200	{array}		SessionResponse
//	@Failure	401	{string}	string	"unauthorized"
//	@Router		/sessions [get]
func (h *SessionsHandler) ListSessions(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	currentTokenHash, _ := auth.GetSessionTokenHashFromContext(r.Context())

	sessions, err := h.sessionStore.GetByUserID(r.Context(), user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	responses := make([]SessionResponse, 0, len(sessions))
	for _, s := range sessions {
		responses = append(responses, toSessionResponse(s, currentTokenHash))
	}

	return http.StatusOK, responses, nil
}

// RevokeSession godoc
//
//	@Summary	Revoke a specific session
//	@Tags		sessions
//	@Security	CookieAuth
//	@Param		id	path	string	true	"Session ID (hashed)"
//	@Success	204	"no content"
//	@Failure	400	{string}	string	"cannot revoke current session"
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	404	{string}	string	"session not found"
//	@Router		/sessions/{id} [delete]
func (h *SessionsHandler) RevokeSession(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	targetID := chi.URLParam(r, "id")
	currentTokenHash, _ := auth.GetSessionTokenHashFromContext(r.Context())

	if sessionID(currentTokenHash) == targetID {
		return http.StatusBadRequest, nil, errors.New("cannot revoke current session")
	}

	sessions, err := h.sessionStore.GetByUserID(r.Context(), user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	for _, s := range sessions {
		if sessionID(s.TokenHash) != targetID {
			continue
		}
		deleted, err := h.sessionStore.DeleteByUserIDAndTokenHash(r.Context(), user.ID, s.TokenHash)
		if err != nil {
			return http.StatusInternalServerError, nil, err
		}
		if !deleted {
			return http.StatusNotFound, nil, errors.New("session not found")
		}
		return http.StatusNoContent, nil, nil
	}

	return http.StatusNotFound, nil, errors.New("session not found")
}
