package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/hanzei/jot/server/internal/models"
)

type AdminHandler struct {
	userStore *models.UserStore
}

func NewAdminHandler(userStore *models.UserStore) *AdminHandler {
	return &AdminHandler{
		userStore: userStore,
	}
}

type CreateUserRequest struct {
	Username string `json:"username"`
	Email    string `json:"email,omitempty"`
	Password string `json:"password"`
	IsAdmin  bool   `json:"is_admin"`
}

type UserListResponse struct {
	Users []*models.User `json:"users"`
}

func (h *AdminHandler) GetUsers(w http.ResponseWriter, r *http.Request) (int, error) {
	users, err := h.userStore.GetAll()
	if err != nil {
		return http.StatusInternalServerError, err
	}

	response := UserListResponse{
		Users: users,
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
}

func (h *AdminHandler) CreateUser(w http.ResponseWriter, r *http.Request) (int, error) {
	var req CreateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, err
	}

	if err := validateUsername(req.Username); err != nil {
		return http.StatusBadRequest, err
	}

	if req.Email != "" {
		if err := validateEmail(req.Email); err != nil {
			return http.StatusBadRequest, err
		}
	}

	if err := validatePassword(req.Password); err != nil {
		return http.StatusBadRequest, err
	}

	user, err := h.userStore.CreateByAdmin(req.Username, req.Email, req.Password, req.IsAdmin)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return http.StatusConflict, err
		}
		return http.StatusInternalServerError, err
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(user); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
}