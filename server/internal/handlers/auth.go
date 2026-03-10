package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
)

type AuthHandler struct {
	userStore      *models.UserStore
	sessionService *auth.SessionService
}

func NewAuthHandler(userStore *models.UserStore, sessionService *auth.SessionService) *AuthHandler {
	return &AuthHandler{
		userStore:      userStore,
		sessionService: sessionService,
	}
}

type RegisterRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type AuthResponse struct {
	User *models.User `json:"user"`
}

func (h *AuthHandler) Register(w http.ResponseWriter, r *http.Request) (int, error) {
	var req RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, err
	}

	if err := validateUsername(req.Username); err != nil {
		return http.StatusBadRequest, err
	}

	if err := validatePassword(req.Password); err != nil {
		return http.StatusBadRequest, err
	}

	user, err := h.userStore.Create(req.Username, req.Password)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return http.StatusConflict, errors.New("username already taken")
		}
		return http.StatusInternalServerError, err
	}

	if err := h.sessionService.CreateSession(w, user.ID); err != nil {
		return http.StatusInternalServerError, err
	}

	response := AuthResponse{
		User: user,
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
}

func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) (int, error) {
	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, err
	}

	if req.Username == "" || req.Password == "" {
		return http.StatusBadRequest, errors.New("missing username or password")
	}

	user, err := h.userStore.GetByUsername(req.Username)
	if err != nil {
		return http.StatusUnauthorized, errors.New("invalid username or password")
	}

	if !user.CheckPassword(req.Password) {
		return http.StatusUnauthorized, errors.New("invalid username or password")
	}

	if err := h.sessionService.InvalidateUserSessions(user.ID); err != nil {
		return http.StatusInternalServerError, err
	}

	if err := h.sessionService.CreateSession(w, user.ID); err != nil {
		return http.StatusInternalServerError, err
	}

	response := AuthResponse{
		User: user,
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
}

func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) (int, error) {
	if err := h.sessionService.DeleteSession(w, r); err != nil {
		return http.StatusInternalServerError, err
	}

	w.WriteHeader(http.StatusNoContent)
	return 0, nil
}

type UpdateUserRequest struct {
	Username string `json:"username"`
}

func (h *AuthHandler) UpdateUser(w http.ResponseWriter, r *http.Request) (int, error) {
	currentUser, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	var req UpdateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, err
	}

	if err := validateUsername(req.Username); err != nil {
		return http.StatusBadRequest, err
	}

	user, err := h.userStore.UpdateUsername(currentUser.ID, req.Username)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return http.StatusConflict, errors.New("username already taken")
		}
		return http.StatusInternalServerError, err
	}

	response := AuthResponse{User: user}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
}

func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) (int, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(user); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
}
