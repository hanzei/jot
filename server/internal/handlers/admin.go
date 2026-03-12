package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/auth"
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
	Password string `json:"password"`
	Role     string `json:"role"`
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

	if err := validatePassword(req.Password); err != nil {
		return http.StatusBadRequest, err
	}

	if err := validateRole(req.Role); err != nil {
		return http.StatusBadRequest, err
	}

	user, err := h.userStore.CreateByAdmin(req.Username, req.Password, req.Role)
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

type UpdateUserRoleRequest struct {
	Role string `json:"role"`
}

func (h *AdminHandler) UpdateUserRole(w http.ResponseWriter, r *http.Request) (int, error) {
	userID := chi.URLParam(r, "id")
	var req UpdateUserRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, err
	}
	if err := validateRole(req.Role); err != nil {
		return http.StatusBadRequest, err
	}
	user, err := h.userStore.UpdateRole(userID, req.Role)
	if err != nil {
		if errors.Is(err, models.ErrUserNotFound) {
			return http.StatusNotFound, err
		}
		if errors.Is(err, models.ErrLastAdmin) {
			return http.StatusConflict, err
		}
		return http.StatusInternalServerError, err
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(user); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
}

func (h *AdminHandler) DeleteUser(w http.ResponseWriter, r *http.Request) (int, error) {
	targetID := chi.URLParam(r, "id")
	requestingUser, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	if err := h.userStore.Delete(targetID, requestingUser.ID); err != nil {
		if errors.Is(err, models.ErrUserNotFound) {
			return http.StatusNotFound, err
		}
		if errors.Is(err, models.ErrLastAdmin) {
			return http.StatusConflict, err
		}
		if errors.Is(err, models.ErrCannotDeleteSelf) {
			return http.StatusForbidden, err
		}
		return http.StatusInternalServerError, err
	}
	w.WriteHeader(http.StatusNoContent)
	return 0, nil
}

func validateRole(role string) error {
	if role != models.RoleUser && role != models.RoleAdmin {
		return errors.New("invalid role: must be 'user' or 'admin'")
	}
	return nil
}