package handlers

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/logutil"
	"github.com/hanzei/jot/server/internal/models"
)

type PATsHandler struct {
	patStore *models.PATStore
}

func NewPATsHandler(patStore *models.PATStore) *PATsHandler {
	return &PATsHandler{patStore: patStore}
}

type createPATRequest struct {
	Name      string     `json:"name"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
}

type patResponse struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	CreatedAt time.Time  `json:"created_at"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	Token     string     `json:"token,omitempty"`
}

// ListPATs godoc
//
//	@Summary	List personal access tokens for the current user
//	@Tags		pats
//	@Security	CookieAuth
//	@Produce	json
//	@Success	200	{array}		patResponse
//	@Failure	401	{string}	string	"unauthorized"
//	@Router		/pats [get]
func (h *PATsHandler) ListPATs(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	pats, err := h.patStore.GetByUserID(r.Context(), user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	responses := make([]patResponse, 0, len(pats))
	for _, p := range pats {
		responses = append(responses, patResponse{
			ID:        p.ID,
			Name:      p.Name,
			CreatedAt: p.CreatedAt,
			ExpiresAt: p.ExpiresAt,
		})
	}

	return http.StatusOK, responses, nil
}

// CreatePAT godoc
//
//	@Summary	Create a new personal access token
//	@Tags		pats
//	@Security	CookieAuth
//	@Accept		json
//	@Produce	json
//	@Param		body	body		createPATRequest	true	"Token name and optional expires_at (RFC3339 timestamp)"
//	@Success	201	{object}	patResponse
//	@Failure	400	{string}	string	"bad request"
//	@Failure	401	{string}	string	"unauthorized"
//	@Router		/pats [post]
func (h *PATsHandler) CreatePAT(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	var req createPATRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, errors.New("invalid request body")
	}

	if err := validatePATName(req.Name); err != nil {
		return http.StatusBadRequest, nil, err
	}

	if req.ExpiresAt != nil {
		if err := validatePATExpiresAt(*req.ExpiresAt); err != nil {
			return http.StatusBadRequest, nil, err
		}
	}

	existing, err := h.patStore.GetByUserID(r.Context(), user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}
	if len(existing) >= maxPATsPerUser {
		return http.StatusUnprocessableEntity, nil, fmt.Errorf("maximum number of personal access tokens (%d) reached", maxPATsPerUser)
	}

	pat, rawToken, err := h.patStore.Create(r.Context(), user.ID, req.Name, req.ExpiresAt)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	logger := logutil.FromContext(r.Context()).WithField("pat_id", pat.ID)
	if pat.ExpiresAt != nil {
		logger = logger.WithField("expires_at", pat.ExpiresAt.UTC().Format(time.RFC3339))
	}
	logger.Info("Personal access token created")

	return http.StatusCreated, patResponse{
		ID:        pat.ID,
		Name:      pat.Name,
		CreatedAt: pat.CreatedAt,
		ExpiresAt: pat.ExpiresAt,
		Token:     rawToken,
	}, nil
}

// RevokePAT godoc
//
//	@Summary	Revoke a personal access token
//	@Tags		pats
//	@Security	CookieAuth
//	@Param		id	path	string	true	"PAT ID"
//	@Success	204	"no content"
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	404	{string}	string	"not found"
//	@Router		/pats/{id} [delete]
func (h *PATsHandler) RevokePAT(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	id := chi.URLParam(r, "id")

	deleted, err := h.patStore.Delete(r.Context(), id, user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}
	if !deleted {
		return http.StatusNotFound, nil, errors.New("personal access token not found")
	}

	logutil.FromContext(r.Context()).WithField("pat_id", id).Info("Personal access token revoked")

	return http.StatusNoContent, nil, nil
}
