package handlers

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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
	ID        string          `json:"id"`
	Browser   string          `json:"browser"`
	OS        string          `json:"os"`
	IsCurrent bool            `json:"is_current"`
	CreatedAt time.Time       `json:"created_at"`
	ExpiresAt time.Time       `json:"expires_at"`
}

func sessionID(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])[:22]
}

func toSessionResponse(s *models.Session, currentToken string) SessionResponse {
	parsed := parseUserAgent(s.UserAgent)
	return SessionResponse{
		ID:        sessionID(s.Token),
		Browser:   parsed.Browser,
		OS:        parsed.OS,
		IsCurrent: s.Token == currentToken,
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
func (h *SessionsHandler) ListSessions(w http.ResponseWriter, r *http.Request) (int, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	currentToken, _ := auth.GetSessionTokenFromContext(r.Context())

	sessions, err := h.sessionStore.GetByUserID(user.ID)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	responses := make([]SessionResponse, 0, len(sessions))
	for _, s := range sessions {
		responses = append(responses, toSessionResponse(s, currentToken))
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(responses); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
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
func (h *SessionsHandler) RevokeSession(w http.ResponseWriter, r *http.Request) (int, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	sessionIDParam := chi.URLParam(r, "id")
	currentToken, _ := auth.GetSessionTokenFromContext(r.Context())

	sessions, err := h.sessionStore.GetByUserID(user.ID)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	for _, s := range sessions {
		if sessionID(s.Token) == sessionIDParam {
			if s.Token == currentToken {
				return http.StatusBadRequest, errors.New("cannot revoke current session")
			}
			if err := h.sessionStore.Delete(s.Token); err != nil {
				return http.StatusInternalServerError, err
			}
			w.WriteHeader(http.StatusNoContent)
			return 0, nil
		}
	}

	return http.StatusNotFound, errors.New("session not found")
}
