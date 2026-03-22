package handlers

import (
	"crypto/sha256"
	"encoding/hex"
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

type PaginatedSessionsResponse struct {
	Items      []SessionResponse  `json:"items"`
	Pagination PaginationMetadata `json:"pagination"`
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
//	@Param		limit	query		int		false	"Page size (default 50, max 100)"
//	@Param		offset	query		int		false	"Page offset (default 0)"
//	@Success	200	{object}	PaginatedSessionsResponse
//	@Failure	400	{string}	string	"bad request"
//	@Failure	401	{string}	string	"unauthorized"
//	@Router		/sessions [get]
func (h *SessionsHandler) ListSessions(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	currentToken, _ := auth.GetSessionTokenFromContext(r.Context())

	page, err := parsePaginationParams(r)
	if err != nil {
		return http.StatusBadRequest, nil, err
	}

	sessions, hasMore, err := h.sessionStore.GetPageByUserID(r.Context(), user.ID, page.Limit, page.Offset)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	responses := make([]SessionResponse, 0, len(sessions))
	for _, s := range sessions {
		responses = append(responses, toSessionResponse(s, currentToken))
	}

	return http.StatusOK, PaginatedSessionsResponse{
		Items:      responses,
		Pagination: newPaginationMetadata(page, len(responses), hasMore),
	}, nil
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
	currentToken, _ := auth.GetSessionTokenFromContext(r.Context())

	if sessionID(currentToken) == targetID {
		return http.StatusBadRequest, nil, errors.New("cannot revoke current session")
	}

	sessions, err := h.sessionStore.GetByUserID(r.Context(), user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	for _, s := range sessions {
		if sessionID(s.Token) != targetID {
			continue
		}
		deleted, err := h.sessionStore.DeleteByUserIDAndToken(r.Context(), user.ID, s.Token)
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
