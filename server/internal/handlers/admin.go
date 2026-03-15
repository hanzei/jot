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
	noteStore *models.NoteStore
}

func NewAdminHandler(userStore *models.UserStore, noteStore *models.NoteStore) *AdminHandler {
	return &AdminHandler{
		userStore: userStore,
		noteStore: noteStore,
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

// GetUsers godoc
//
//	@Summary	List all users (admin only)
//	@Tags		admin
//	@Security	CookieAuth
//	@Produce	json
//	@Success	200	{object}	UserListResponse
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	403	{string}	string	"forbidden"
//	@Router		/admin/users [get]
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

// CreateUser godoc
//
//	@Summary	Create a user (admin only)
//	@Tags		admin
//	@Security	CookieAuth
//	@Accept		json
//	@Produce	json
//	@Param		body	body		CreateUserRequest	true	"New user details"
//	@Success	201		{object}	models.User
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	403		{string}	string	"forbidden"
//	@Failure	409		{string}	string	"username already taken"
//	@Router		/admin/users [post]
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

// UpdateUserRole godoc
//
//	@Summary	Update a user's role (admin only)
//	@Tags		admin
//	@Security	CookieAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		string					true	"User ID"
//	@Param		body	body		UpdateUserRoleRequest	true	"New role"
//	@Success	200		{object}	models.User
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	403		{string}	string	"forbidden"
//	@Failure	404		{string}	string	"user not found"
//	@Failure	409		{string}	string	"cannot demote the last admin"
//	@Router		/admin/users/{id}/role [put]
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

// DeleteUser godoc
//
//	@Summary	Delete a user (admin only)
//	@Tags		admin
//	@Security	CookieAuth
//	@Param		id	path		string	true	"User ID"
//	@Success	204	"no content"
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	403	{string}	string	"forbidden"
//	@Failure	404	{string}	string	"user not found"
//	@Failure	409	{string}	string	"cannot demote the last admin"
//	@Router		/admin/users/{id} [delete]
func (h *AdminHandler) DeleteUser(w http.ResponseWriter, r *http.Request) (int, error) {
	targetID := chi.URLParam(r, "id")
	requestingUser, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	if err := h.noteStore.ClearUserAssignments(targetID); err != nil {
		return http.StatusInternalServerError, err
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