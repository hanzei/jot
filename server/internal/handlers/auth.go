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
	userStore    *models.UserStore
	tokenService *auth.TokenService
}

func NewAuthHandler(userStore *models.UserStore, tokenService *auth.TokenService) *AuthHandler {
	return &AuthHandler{
		userStore:    userStore,
		tokenService: tokenService,
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
	Token string       `json:"token"`
	User  *models.User `json:"user"`
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
			return http.StatusConflict, err
		}
		return http.StatusInternalServerError, err
	}

	token, err := h.tokenService.GenerateToken(user.ID, user.Username, user.Role)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	response := AuthResponse{
		Token: token,
		User:  user,
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
		return http.StatusUnauthorized, err
	}

	if !user.CheckPassword(req.Password) {
		return http.StatusUnauthorized, errors.New("invalid password")
	}

	token, err := h.tokenService.GenerateToken(user.ID, user.Username, user.Role)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	response := AuthResponse{
		Token: token,
		User:  user,
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
}

