package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
)

type PATsHandler struct {
	patStore *models.PATStore
}

func NewPATsHandler(patStore *models.PATStore) *PATsHandler {
	return &PATsHandler{patStore: patStore}
}

type createPATRequest struct {
	Name string `json:"name"`
}

type patResponse struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
	Token     string    `json:"token,omitempty"`
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
//	@Param		body	body		createPATRequest	true	"Token name"
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
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, nil, errors.New("invalid request body")
	}

	if err := validatePATName(req.Name); err != nil {
		return http.StatusBadRequest, nil, err
	}

	pat, rawToken, err := h.patStore.Create(r.Context(), user.ID, req.Name)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	return http.StatusCreated, patResponse{
		ID:        pat.ID,
		Name:      pat.Name,
		CreatedAt: pat.CreatedAt,
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

	return http.StatusNoContent, nil, nil
}
